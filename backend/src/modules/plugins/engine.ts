import vm from 'vm';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import cron from 'node-cron';
import { PrismaClient } from '@prisma/client';
import type { Application } from 'express';
import { PluginManifest, PluginManifestSchema, PluginStatus } from './schemas.js';
import { pluginAudit } from './audit.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface HookResult {
  cancel?: boolean;
  reason?: string;
}

type HookHandler = (data: unknown) => Promise<HookResult | void>;

interface RegisteredHook {
  pluginDbId: string;
  pluginId: string;
  priority: number;
  handler: HookHandler;
}

interface RegisteredCron {
  pluginDbId: string;
  stop: () => void;
}

// ── Sandbox Executor ─────────────────────────────────────────────────────────
//
// NOTE ON SECURITY MODEL:
// vm.Script does NOT provide strong isolation — Node.js docs explicitly state
// "The vm module is not a security mechanism." The security boundary here is
// the ADMISSION GATE: Ed25519 signature + SHA-256 checksum + security
// checklist + 4-eyes approval in production. The sandbox is defense-in-depth,
// not the primary control. A plugin approved in error by a human reviewer
// could escape this sandbox. Document this in PLUGIN_SECURITY_CHECKLIST.md.

const SANDBOX_TIMEOUT_MS = 5_000;

function buildFrozenContext(
  prismaProxy: object,
  logger: object,
  config: Record<string, unknown>,
  allowedHosts: string[],
  data?: unknown,
): vm.Context {
  // Minimal safe fetch wrapper — only allows declared hosts
  const safeFetch = async (url: string, options?: RequestInit): Promise<globalThis.Response> => {
    const parsed = new URL(url);
    const origin = parsed.origin;
    if (!allowedHosts.some((h) => origin === h || origin.endsWith('.' + h.replace(/^https?:\/\//, '')))) {
      throw new Error(`PLUGIN_SSRF: host ${origin} not in allowedHosts manifest declaration`);
    }
    return fetch(url, options);
  };

  const ctx: Record<string, unknown> = {
    prisma: prismaProxy,
    logger,
    config: Object.freeze({ ...config }),
    fetch: safeFetch,
    console: Object.freeze({
      log: (...args: unknown[]) => (logger as { info: (...a: unknown[]) => void }).info(...args),
      warn: (...args: unknown[]) => (logger as { warn: (...a: unknown[]) => void }).warn(...args),
      error: (...args: unknown[]) => (logger as { error: (...a: unknown[]) => void }).error(...args),
    }),
    // Provide safe subset of globals
    JSON,
    Math,
    Date,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    encodeURIComponent,
    decodeURIComponent,
    setTimeout: undefined,   // blocked — could be used for timing attacks
    setInterval: undefined,  // blocked
    clearTimeout: undefined,
    clearInterval: undefined,
    process: undefined,      // blocked
    require: undefined,      // blocked
    eval: undefined,         // blocked — align with documented blocklist
    Function: undefined,     // blocked — prevents Function() constructor use
    __filename: undefined,
    __dirname: undefined,
    module: undefined,
    exports: undefined,
    global: undefined,
    globalThis: undefined,
    // Data injected before freeze — avoids mutating a frozen object in runHandler
    __pluginData__: data,
  };

  return vm.createContext(Object.freeze(ctx));
}

export class SandboxExecutor {
  constructor(private pluginStoragePath: string) {}

  async runHandler(
    code: string,
    handlerExport: string,
    data: unknown,
    prismaProxy: object,
    logger: object,
    config: Record<string, unknown>,
    allowedHosts: string[],
  ): Promise<HookResult | void> {
    const ctx = buildFrozenContext(prismaProxy, logger, config, allowedHosts, data);
    // Wrap in an async IIFE so the code can use await
    const wrapped = `
      (async function __pluginRunner__() {
        ${code}
        if (typeof ${handlerExport} !== 'function') {
          throw new Error('Plugin handler "${handlerExport}" is not a function');
        }
        return await ${handlerExport}(__pluginData__);
      })()
    `;

    const script = new vm.Script(wrapped, { filename: `plugin:${handlerExport}` });
    try {
      const result = await script.runInContext(ctx, { timeout: SANDBOX_TIMEOUT_MS });
      return result;
    } catch (err) {
      if ((err as Error).message?.includes('Script execution timed out')) {
        throw new Error(`PLUGIN_TIMEOUT: handler ${handlerExport} exceeded ${SANDBOX_TIMEOUT_MS}ms`);
      }
      throw err;
    }
  }
}

// ── Hook Registry ─────────────────────────────────────────────────────────────

export class HookRegistry {
  // event → sorted list of handlers (by priority asc)
  private hooks = new Map<string, RegisteredHook[]>();

  register(event: string, hook: RegisteredHook): void {
    const list = this.hooks.get(event) ?? [];
    list.push(hook);
    list.sort((a, b) => a.priority - b.priority);
    this.hooks.set(event, list);
  }

  unregisterPlugin(pluginDbId: string): void {
    for (const [event, list] of this.hooks) {
      this.hooks.set(event, list.filter((h) => h.pluginDbId !== pluginDbId));
    }
  }

  hasHandlers(event: string): boolean {
    return (this.hooks.get(event)?.length ?? 0) > 0;
  }

  // Returns { cancel, reason } if any pre-hook cancels; null otherwise
  async emitPre(event: string, data: unknown): Promise<HookResult | null> {
    const list = this.hooks.get(event) ?? [];
    for (const hook of list) {
      try {
        const result = await hook.handler(data);
        if (result?.cancel) return result;
      } catch (err) {
        // Hook error → log + mark plugin ERROR, but don't cancel core operation
        console.error(`[plugin:${hook.pluginId}] hook ${event} error:`, err);
      }
    }
    return null;
  }

  // Post hooks: fire-and-forget (don't propagate errors to core)
  async emitPost(event: string, data: unknown): Promise<void> {
    const list = this.hooks.get(event) ?? [];
    await Promise.allSettled(
      list.map((h) =>
        h.handler(data).catch((err) =>
          console.error(`[plugin:${h.pluginId}] post-hook ${event} error:`, err),
        ),
      ),
    );
  }
}

// ── Cron Registry ─────────────────────────────────────────────────────────────

export class CronRegistry {
  private jobs = new Map<string, RegisteredCron[]>(); // pluginDbId → []

  register(pluginDbId: string, jobHandle: RegisteredCron): void {
    const list = this.jobs.get(pluginDbId) ?? [];
    list.push(jobHandle);
    this.jobs.set(pluginDbId, list);
  }

  stopPlugin(pluginDbId: string): void {
    const list = this.jobs.get(pluginDbId) ?? [];
    for (const job of list) job.stop();
    this.jobs.delete(pluginDbId);
  }
}

// ── Route Registry ────────────────────────────────────────────────────────────

export interface PluginRouteDef {
  pluginDbId: string;
  method: string;            // GET|POST|PATCH|PUT|DELETE
  path: string;              // '/status' (relative to /api/ext/:pluginId)
  handlerCode: string;
  requiresAuth: boolean;
  requiredRole: string | null;
  permissions: string[];
  allowedHosts: string[];
  config: Record<string, unknown>;
}

// Stores plugin route definitions. Routes are NOT mounted as Express routes
// (Express 5 cannot cleanly unmount); instead a single dispatcher at
// /api/ext/:pluginId/* matches against this registry — safe to add/remove live.
export class RouteRegistry {
  private routes = new Map<string, PluginRouteDef[]>(); // pluginId(kebab) → defs

  add(pluginId: string, def: PluginRouteDef): void {
    const list = this.routes.get(pluginId) ?? [];
    list.push(def);
    this.routes.set(pluginId, list);
  }

  removePlugin(pluginId: string): void {
    this.routes.delete(pluginId);
  }

  // Exact method+path match (no param patterns in v2.8.1 — keep it simple & safe)
  match(pluginId: string, method: string, reqPath: string): PluginRouteDef | null {
    const list = this.routes.get(pluginId);
    if (!list) return null;
    const norm = reqPath.startsWith('/') ? reqPath : `/${reqPath}`;
    return list.find(
      (r) => r.method.toUpperCase() === method.toUpperCase() && r.path === norm,
    ) ?? null;
  }
}

// ── Plugin Validator ──────────────────────────────────────────────────────────

// Dangerous SQL verbs. Each captures the target identifier so we can verify it
// is a plugin-owned (plg_*) object. Any such verb against a non-plg_ object is rejected.
const DANGEROUS_DDL_RULES: Array<{ re: RegExp; label: string }> = [
  { re: /\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?["']?(\w+)/gi, label: 'DROP TABLE' },
  { re: /\bDROP\s+(?:INDEX|VIEW|MATERIALIZED\s+VIEW|SEQUENCE|TRIGGER|FUNCTION|SCHEMA)\s+(?:IF\s+EXISTS\s+)?["']?(\w+)/gi, label: 'DROP' },
  { re: /\bTRUNCATE\s+(?:TABLE\s+)?["']?(\w+)/gi, label: 'TRUNCATE' },
  { re: /\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?["']?(\w+)/gi, label: 'ALTER TABLE' },
  { re: /\bDELETE\s+FROM\s+(?:ONLY\s+)?["']?(\w+)/gi, label: 'DELETE FROM' },
  { re: /\bUPDATE\s+(?:ONLY\s+)?["']?(\w+)/gi, label: 'UPDATE' },
  { re: /\bGRANT\b/gi, label: 'GRANT' },
  { re: /\bREVOKE\b/gi, label: 'REVOKE' },
];

export class PluginValidator {
  static validateManifest(raw: unknown): PluginManifest {
    return PluginManifestSchema.parse(raw);
  }

  static validateChecksum(filePath: string, expectedHash: string): boolean {
    const buf = fs.readFileSync(filePath);
    const actual = crypto.createHash('sha256').update(buf).digest('hex');
    return actual === expectedHash;
  }

  // Rejects symlinks and non-zip files. Extraction is unzip-only, so we accept
  // ONLY .zip (a .tar.gz would pass an ext check but fail at extraction → L-07).
  static validateUploadedFile(filePath: string, originalName: string): void {
    const ext = path.extname(originalName).toLowerCase();
    if (ext !== '.zip') {
      throw new Error('PLUGIN_INVALID_EXT: only .zip bundles are supported');
    }
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink()) {
      throw new Error('PLUGIN_SYMLINK: symbolic links are not allowed');
    }
    // Check magic bytes: zip = 50 4b 03 04
    const fd = fs.openSync(filePath, 'r');
    const magic = Buffer.alloc(4);
    fs.readSync(fd, magic, 0, 4, 0);
    fs.closeSync(fd);
    if (!magic.toString('hex').startsWith('504b')) {
      throw new Error('PLUGIN_MAGIC_BYTES: file is not a valid zip archive');
    }
  }

  // Validate plugin migration SQL: only allow safe DDL on plg_* objects.
  // Every dangerous verb (DROP/TRUNCATE/ALTER/DELETE/UPDATE/GRANT/REVOKE) must
  // target a plg_* object; GRANT/REVOKE are forbidden outright.
  static validateMigrationSql(sql: string, pluginId: string): void {
    const prefix = `plg_${pluginId.replace(/-/g, '_')}`;

    // Strip line/block comments and single-quoted string literals so commented-out
    // or quoted SQL cannot smuggle a dangerous verb past (or trip) the checks.
    const stripped = sql
      .replace(/--[^\n]*/g, ' ')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/'(?:[^']|'')*'/g, "''");

    for (const { re, label } of DANGEROUS_DDL_RULES) {
      re.lastIndex = 0;
      for (const match of stripped.matchAll(re)) {
        // GRANT/REVOKE have no captured target — never allowed from a plugin migration
        if (match[1] === undefined) {
          throw new Error(`PLUGIN_DDL_FORBIDDEN: ${label} is not permitted in plugin migrations`);
        }
        if (!match[1].toLowerCase().startsWith('plg_')) {
          throw new Error(`PLUGIN_DDL_FORBIDDEN: ${label} on non-plugin object "${match[1]}" (must start with plg_)`);
        }
      }
    }

    // Every CREATE TABLE must use the plugin prefix
    const creates = stripped.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["']?(\w+)["']?/gi);
    for (const match of creates) {
      if (!match[1].startsWith(prefix) && !match[1].startsWith('plg_')) {
        throw new Error(`PLUGIN_DDL_PREFIX: table "${match[1]}" must start with "${prefix}"`);
      }
    }
  }
}

// ── Migration Runner ───────────────────────────────────────────────────────────

export class MigrationRunner {
  constructor(
    private pluginDatabaseUrl: string | undefined,
    private pluginStoragePath: string,
  ) {}

  // Resolve the DB connection for plugin migrations. NEVER falls back to the core
  // DATABASE_URL (superuser): plugin DDL must run under the restricted cmdb_plugin role.
  private resolveUrl(): string {
    if (!this.pluginDatabaseUrl) {
      throw new Error(
        'PLUGIN_DATABASE_URL is not configured — refusing to run plugin migrations with core DB credentials. ' +
        'Set PLUGIN_DATABASE_URL to the restricted cmdb_plugin role (see scripts/create-plugin-db-role.sql).',
      );
    }
    return this.pluginDatabaseUrl;
  }

  async runUp(pluginId: string, sql: string): Promise<void> {
    PluginValidator.validateMigrationSql(sql, pluginId);
    // Run the plugin DDL under the restricted cmdb_plugin role (PLUGIN_DATABASE_URL),
    // via psql. resolveUrl() hard-fails if PLUGIN_DATABASE_URL is unset — it never
    // falls back to the core DATABASE_URL (superuser), in dev or prod.
    const url = this.resolveUrl();
    await this.executeSql(url, sql);
  }

  async runDown(pluginId: string): Promise<void> {
    const downPath = path.join(this.pluginStoragePath, 'installed', pluginId, 'down.sql');
    if (!fs.existsSync(downPath)) {
      // Auto-generate DROP for plg_* tables owned by this plugin
      await this.dropPluginTables(pluginId);
      return;
    }
    const sql = fs.readFileSync(downPath, 'utf-8');
    PluginValidator.validateMigrationSql(sql, pluginId);
    const url = this.resolveUrl();
    await this.executeSql(url, sql);
  }

  private async dropPluginTables(pluginId: string): Promise<void> {
    const prefix = `plg_${pluginId.replace(/-/g, '_')}`;
    // Query information_schema to find all tables with this prefix
    const url = this.resolveUrl();
    await this.executeSql(
      url,
      `DO $$
       DECLARE r RECORD;
       BEGIN
         FOR r IN SELECT tablename FROM pg_tables
                  WHERE schemaname = 'public' AND tablename LIKE '${prefix}%'
         LOOP
           EXECUTE 'DROP TABLE IF EXISTS ' || quote_ident(r.tablename) || ' CASCADE';
         END LOOP;
       END$$;`,
    );
  }

  private async executeSql(url: string, sql: string): Promise<void> {
    // Use child_process.execFile with psql — execFile (not exec) prevents shell injection
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);
    // Parse connection URL for psql args
    const u = new URL(url);
    const env = {
      ...process.env,
      PGPASSWORD: decodeURIComponent(u.password),
    };
    await execFileAsync('psql', [
      '-h', u.hostname,
      '-p', u.port || '5432',
      '-U', decodeURIComponent(u.username),
      '-d', u.pathname.slice(1),
      '-c', sql,
    ], { env, timeout: 30_000 });
  }
}

// ── Lifecycle Manager ─────────────────────────────────────────────────────────

export class PluginLifecycleManager {
  private readonly validTransitions: Record<PluginStatus, PluginStatus[]> = {
    UPLOADED:     ['VALIDATED', 'ERROR'],
    VALIDATED:    ['INSTALLED', 'ERROR'],
    INSTALLED:    ['ACTIVE', 'UNINSTALLING', 'ERROR'],
    ACTIVE:       ['INACTIVE', 'ERROR'],
    INACTIVE:     ['ACTIVE', 'UNINSTALLING'],
    ERROR:        ['UNINSTALLING', 'VALIDATED'],
    UNINSTALLING: [],
  };

  canTransition(from: PluginStatus, to: PluginStatus): boolean {
    return this.validTransitions[from]?.includes(to) ?? false;
  }

  async updateStatus(
    prisma: PrismaClient,
    pluginDbId: string,
    status: PluginStatus,
    lastError?: string,
  ): Promise<void> {
    // Enforce the state machine (L-04). A transition to ERROR is always permitted
    // (a failure must be recordable from any state) and a no-op (from === to) is
    // allowed; any other illegal transition is rejected to keep the lifecycle sound.
    const current = await prisma.pluginRegistry.findUnique({
      where: { id: pluginDbId },
      select: { status: true },
    });
    if (
      current &&
      status !== 'ERROR' &&
      current.status !== status &&
      !this.canTransition(current.status as PluginStatus, status)
    ) {
      throw new Error(
        `Invalid plugin status transition: ${current.status} → ${status}`,
      );
    }

    await prisma.pluginRegistry.update({
      where: { id: pluginDbId },
      data: {
        status,
        lastError: lastError ?? null,
        updatedAt: new Date(),
      },
    });
  }
}

// ── Singleton instances (shared across module) ────────────────────────────────

export const hookRegistry = new HookRegistry();
export const cronRegistry = new CronRegistry();
export const routeRegistry = new RouteRegistry();
export const lifecycleManager = new PluginLifecycleManager();

export function createSandboxExecutor(storagePath: string): SandboxExecutor {
  return new SandboxExecutor(storagePath);
}

export function createMigrationRunner(storagePath: string): MigrationRunner {
  return new MigrationRunner(process.env.PLUGIN_DATABASE_URL, storagePath);
}

// ── Scoped Prisma proxy (H-02) ─────────────────────────────────────────────────
//
// Plugin DB access goes through a dedicated PrismaClient bound to PLUGIN_DATABASE_URL
// (the restricted cmdb_plugin role). The DB role enforces table-level isolation
// (no privileges on core tables; can only touch plg_* objects it owns); the
// permission check here enforces capability (db:read / db:write). We never hand the
// core PrismaClient to plugin code.

let _pluginPrisma: PrismaClient | null = null;

function getPluginPrisma(): PrismaClient {
  if (!process.env.PLUGIN_DATABASE_URL) {
    throw new Error(
      'PLUGIN_DATABASE_URL is not configured — plugin DB access is disabled. ' +
      'Set it to the restricted cmdb_plugin role (scripts/create-plugin-db-role.sql).',
    );
  }
  if (!_pluginPrisma) {
    _pluginPrisma = new PrismaClient({ datasourceUrl: process.env.PLUGIN_DATABASE_URL });
  }
  return _pluginPrisma;
}

export function buildPrismaProxy(permissions: string[]): object {
  const canRead = permissions.includes('db:read') || permissions.includes('db:write') || permissions.includes('db:schema');
  const canWrite = permissions.includes('db:write') || permissions.includes('db:schema');
  const lazy = () => getPluginPrisma() as unknown as Record<string, (...a: unknown[]) => unknown>;
  const needRead = () => { if (!canRead) throw new Error('PLUGIN_PERM: db:read permission required'); };
  const needWrite = () => { if (!canWrite) throw new Error('PLUGIN_PERM: db:write permission required'); };
  return Object.freeze({
    $queryRaw:        (...a: unknown[]) => { needRead();  return lazy().$queryRaw(...a); },
    $queryRawUnsafe:  (...a: unknown[]) => { needRead();  return lazy().$queryRawUnsafe(...a); },
    $executeRaw:      (...a: unknown[]) => { needWrite(); return lazy().$executeRaw(...a); },
    $executeRawUnsafe:(...a: unknown[]) => { needWrite(); return lazy().$executeRawUnsafe(...a); },
  });
}

// Logger handed to plugin handlers. Prefixes the plugin id; callers must not log PII.
function pluginLogger(pluginId: string) {
  return {
    info:  (...args: unknown[]) => console.info(`[plugin:${pluginId}]`, ...args),
    warn:  (...args: unknown[]) => console.warn(`[plugin:${pluginId}]`, ...args),
    error: (...args: unknown[]) => console.error(`[plugin:${pluginId}]`, ...args),
  };
}

// ── Plugin Runtime (H-01) ──────────────────────────────────────────────────────
//
// Registers/unregisters a plugin's hooks, cron jobs and routes into the live
// registries. Used both on boot (reactivation) and on the activate/deactivate
// endpoints. Holds the Express app + sandbox so the API layer stays decoupled.

interface RuntimeHook { event: string; priority: number; handlerCode: string; isActive: boolean; }
interface RuntimeCron { id: string; name: string; schedule: string; handlerCode: string; isActive: boolean; }
interface RuntimeRoute { method: string; path: string; handlerCode: string; isActive: boolean; requiresAuth: boolean; requiredRole: string | null; }
export interface RuntimePlugin {
  id: string;
  pluginId: string;
  version: string;
  permissions: string[];
  manifest: unknown;
  config: unknown;
  hooks: RuntimeHook[];
  cronJobs: RuntimeCron[];
  routes: RuntimeRoute[];
}

export class PluginRuntime {
  private prisma!: PrismaClient;
  private sandbox!: SandboxExecutor;
  private initialized = false;

  init(_app: Application, prisma: PrismaClient): void {
    this.prisma = prisma;
    this.sandbox = createSandboxExecutor(process.env.PLUGIN_STORAGE_PATH ?? '/var/lib/cmdb/plugins');
    this.initialized = true;
  }

  isReady(): boolean { return this.initialized; }

  runRoute(def: PluginRouteDef, reqLike: unknown): Promise<HookResult | void> {
    return this.sandbox.runHandler(
      def.handlerCode, 'handler', reqLike,
      buildPrismaProxy(def.permissions), pluginLogger(`route`), def.config, def.allowedHosts,
    );
  }

  // Register all active hooks/cron/routes for a plugin into the live registries.
  registerPlugin(plugin: RuntimePlugin): void {
    const manifest = (plugin.manifest ?? {}) as { allowedHosts?: string[] };
    const permissions = plugin.permissions ?? [];
    const allowedHosts = manifest.allowedHosts ?? [];
    const config = (plugin.config ?? {}) as Record<string, unknown>;

    for (const hook of plugin.hooks.filter((h) => h.isActive)) {
      hookRegistry.register(hook.event, {
        pluginDbId: plugin.id,
        pluginId: plugin.pluginId,
        priority: hook.priority,
        handler: (data) => this.sandbox.runHandler(
          hook.handlerCode, 'handler', data,
          buildPrismaProxy(permissions), pluginLogger(plugin.pluginId), config, allowedHosts,
        ),
      });
    }

    for (const job of plugin.cronJobs.filter((j) => j.isActive)) {
      if (!cron.validate(job.schedule)) {
        console.error(`[plugin:${plugin.pluginId}] invalid cron schedule "${job.schedule}" for ${job.name}`);
        continue;
      }
      const task = cron.schedule(job.schedule, async () => {
        try {
          await this.sandbox.runHandler(
            job.handlerCode, 'handler', {},
            buildPrismaProxy(permissions), pluginLogger(plugin.pluginId), config, allowedHosts,
          );
          await this.prisma.pluginCronJob.update({ where: { id: job.id }, data: { lastRunAt: new Date() } }).catch(() => {});
        } catch (err) {
          console.error(`[plugin:${plugin.pluginId}] cron ${job.name} error:`, err);
        }
      });
      cronRegistry.register(plugin.id, { pluginDbId: plugin.id, stop: () => task.stop() });
    }

    for (const route of plugin.routes.filter((r) => r.isActive)) {
      routeRegistry.add(plugin.pluginId, {
        pluginDbId: plugin.id,
        method: route.method,
        path: route.path.startsWith('/') ? route.path : `/${route.path}`,
        handlerCode: route.handlerCode,
        requiresAuth: route.requiresAuth,
        requiredRole: route.requiredRole,
        permissions, allowedHosts, config,
      });
    }
  }

  unregisterPlugin(pluginDbId: string, pluginIdKebab: string): void {
    hookRegistry.unregisterPlugin(pluginDbId);
    cronRegistry.stopPlugin(pluginDbId);
    routeRegistry.removePlugin(pluginIdKebab);
  }
}

export const pluginRuntime = new PluginRuntime();

// ── emitHook public API (used by core index.ts) ───────────────────────────────

export async function emitHook(
  event: string,
  data: unknown,
  type: 'pre' | 'post' = 'post',
): Promise<HookResult | null> {
  // Early return if no plugins are listening — zero cost for idle deployments
  if (!hookRegistry.hasHandlers(event)) return null;

  if (type === 'pre') {
    return hookRegistry.emitPre(event, data);
  }
  await hookRegistry.emitPost(event, data);
  return null;
}

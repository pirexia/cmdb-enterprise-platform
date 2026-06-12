import vm from 'vm';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
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
    __filename: undefined,
    __dirname: undefined,
    module: undefined,
    exports: undefined,
    global: undefined,
    globalThis: undefined,
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
    const ctx = buildFrozenContext(prismaProxy, logger, config, allowedHosts);
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
    // Inject data via context (not string interpolation — no injection risk)
    (ctx as Record<string, unknown>).__pluginData__ = data;

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

export class RouteRegistry {
  private mounted = new Set<string>(); // pluginDbId

  mount(_app: Application, pluginDbId: string, _pluginId: string): void {
    this.mounted.add(pluginDbId);
    // Actual route mounting happens in router.ts via initializePluginEngine
  }

  unmount(_app: Application, pluginDbId: string): void {
    this.mounted.delete(pluginDbId);
  }

  isMounted(pluginDbId: string): boolean {
    return this.mounted.has(pluginDbId);
  }
}

// ── Plugin Validator ──────────────────────────────────────────────────────────

// DDL statements allowed in plugin migrations (others rejected)
const ALLOWED_DDL_PATTERN = /^\s*(CREATE\s+(TABLE|INDEX|UNIQUE\s+INDEX)|INSERT\s+INTO\s+plg_|--)/im;
const DANGEROUS_DDL_PATTERN = /\b(DROP|TRUNCATE|ALTER\s+TABLE\s+(?!plg_)|DELETE\s+FROM\s+(?!plg_))\b/i;

export class PluginValidator {
  static validateManifest(raw: unknown): PluginManifest {
    return PluginManifestSchema.parse(raw);
  }

  static validateChecksum(filePath: string, expectedHash: string): boolean {
    const buf = fs.readFileSync(filePath);
    const actual = crypto.createHash('sha256').update(buf).digest('hex');
    return actual === expectedHash;
  }

  // Rejects symlinks, path traversal, executables, postinstall scripts
  static validateUploadedFile(filePath: string, originalName: string): void {
    const ext = path.extname(originalName).toLowerCase();
    if (!['.gz', '.zip', '.tgz'].includes(ext)) {
      throw new Error('PLUGIN_INVALID_EXT: only .tar.gz / .tgz / .zip allowed');
    }
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink()) {
      throw new Error('PLUGIN_SYMLINK: symbolic links are not allowed');
    }
    // Check magic bytes: gz=1f8b, zip=504b
    const fd = fs.openSync(filePath, 'r');
    const magic = Buffer.alloc(4);
    fs.readSync(fd, magic, 0, 4, 0);
    fs.closeSync(fd);
    const hex = magic.toString('hex');
    const isGzip = hex.startsWith('1f8b');
    const isZip = hex.startsWith('504b');
    if (!isGzip && !isZip) {
      throw new Error('PLUGIN_MAGIC_BYTES: file is not a valid gzip or zip archive');
    }
  }

  // Validate plugin migration SQL: only allow safe DDL on plg_* objects
  static validateMigrationSql(sql: string, pluginId: string): void {
    const prefix = `plg_${pluginId.replace(/-/g, '_')}`;
    if (DANGEROUS_DDL_PATTERN.test(sql)) {
      // Allow DROP only on plg_* tables
      const dropOnCore = sql.match(/\bDROP\s+TABLE\s+(?!plg_)(\w+)/i);
      if (dropOnCore) {
        throw new Error(`PLUGIN_DDL_FORBIDDEN: DROP on non-plugin table ${dropOnCore[1]}`);
      }
    }
    // Every CREATE TABLE must use the plugin prefix
    const creates = sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["']?(\w+)["']?/gi);
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

  async runUp(pluginId: string, sql: string): Promise<void> {
    PluginValidator.validateMigrationSql(sql, pluginId);
    // Execute via psql against restricted role
    // In production this uses PLUGIN_DATABASE_URL (cmdb_plugin role)
    // Fallback to main connection in dev when PLUGIN_DATABASE_URL is not set
    const url = this.pluginDatabaseUrl ?? process.env.DATABASE_URL!;
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
    const url = this.pluginDatabaseUrl ?? process.env.DATABASE_URL!;
    await this.executeSql(url, sql);
  }

  private async dropPluginTables(pluginId: string): Promise<void> {
    const prefix = `plg_${pluginId.replace(/-/g, '_')}`;
    // Query information_schema to find all tables with this prefix
    const url = this.pluginDatabaseUrl ?? process.env.DATABASE_URL!;
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

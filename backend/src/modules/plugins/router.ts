import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient, Prisma } from '@prisma/client';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { z } from 'zod';
import jwt from 'jsonwebtoken';
import multer from 'multer';

import { PluginManifestSchema, PluginActivateSchema } from './schemas.js';
import { pluginAudit } from './audit.js';
import {
  pluginRateLimiter,
  requirePluginExists,
} from './middleware.js';
import {
  lifecycleManager,
  PluginValidator,
  createMigrationRunner,
  pluginRuntime,
  routeRegistry,
  RuntimePlugin,
} from './engine.js';
import { createBackupRecord } from './queries.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const execFileAsync = promisify(execFile);

const PLUGIN_STORAGE_PATH = process.env.PLUGIN_STORAGE_PATH ?? '/var/lib/cmdb/plugins';
const PLUGIN_MAX_SIZE_MB  = parseInt(process.env.PLUGIN_MAX_SIZE_MB ?? '50', 10);
const JWT_SECRET          = process.env.JWT_SECRET ?? '';

// camelCase event → kebab filename: postCreateCI → post-create-ci
function kebab(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

// path → filename slug: /status → status, /items/list → items_list
function slugifyPath(p: string): string {
  return p.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase();
}

// Read a handler file from inside installDir, guarding against path traversal.
function safeReadHandler(installDir: string, relPath: string): string {
  const full = path.resolve(installDir, relPath);
  const base = path.resolve(installDir);
  if (full !== base && !full.startsWith(base + path.sep)) {
    throw new Error(`PLUGIN_PATH_TRAVERSAL: ${relPath} escapes the plugin directory`);
  }
  if (!fs.existsSync(full)) {
    throw new Error(`PLUGIN_HANDLER_MISSING: declared handler file "${relPath}" not found in bundle`);
  }
  return fs.readFileSync(full, 'utf-8');
}

// Parse a plugin's manifest + bundle into PluginHook/PluginCronJob/PluginRoute rows.
// Throws (→ install fails) if a declared hook/cron/route has no handler file.
//
// Takes a Prisma.TransactionClient (issue #172) — both call sites now run it
// inside the same `prisma.$transaction(async (tx) => {})` as the subsequent
// status update + audit insert, so the delete/recreate below no longer needs
// its own nested transaction (a `tx` client does not expose `$transaction`;
// sequential statements here are still atomic as part of the enclosing one).
async function parseBundleArtifacts(
  prisma: Prisma.TransactionClient,
  pluginDbId: string,
  installDir: string,
  manifest: {
    hooks?: string[];
    cronJobs?: Array<{ name: string; schedule: string }>;
    routes?: Array<{ method: string; path: string; requiresAuth?: boolean; requiredRole?: string }>;
  },
): Promise<{ hooks: number; cron: number; routes: number }> {
  const hookRows = (manifest.hooks ?? []).map((event) => ({
    pluginId: pluginDbId,
    event,
    priority: 50,
    handlerCode: safeReadHandler(installDir, path.join('hooks', `${kebab(event)}.js`)),
    isActive: true,
  }));

  const cronRows = (manifest.cronJobs ?? []).map((job) => {
    if (!/^[a-z0-9_-]+$/i.test(job.name)) {
      throw new Error(`PLUGIN_CRON_NAME: cron name "${job.name}" must be alphanumeric/-/_`);
    }
    return {
      pluginId: pluginDbId,
      name: job.name,
      schedule: job.schedule,
      handlerCode: safeReadHandler(installDir, path.join('cron', `${job.name}.js`)),
      isActive: true,
    };
  });

  const routeRows = (manifest.routes ?? []).map((r) => ({
    pluginId: pluginDbId,
    method: r.method.toUpperCase(),
    path: r.path.startsWith('/') ? r.path : `/${r.path}`,
    handlerCode: safeReadHandler(installDir, path.join('routes', `${r.method.toLowerCase()}_${slugifyPath(r.path)}.js`)),
    isActive: true,
    requiresAuth: r.requiresAuth ?? true,
    requiredRole: r.requiredRole ?? null,
  }));

  await prisma.pluginHook.deleteMany({ where: { pluginId: pluginDbId } });
  await prisma.pluginCronJob.deleteMany({ where: { pluginId: pluginDbId } });
  await prisma.pluginRoute.deleteMany({ where: { pluginId: pluginDbId } });
  for (const data of hookRows) await prisma.pluginHook.create({ data });
  for (const data of cronRows) await prisma.pluginCronJob.create({ data });
  for (const data of routeRows) await prisma.pluginRoute.create({ data });

  return { hooks: hookRows.length, cron: cronRows.length, routes: routeRows.length };
}

// Minimal MIME map for plugin UI static assets.
const UI_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.gif':  'image/gif',
  '.woff2':'font/woff2',
};

// Verify a session JWT from Authorization header or token cookie. Returns payload or null.
function verifyJwt(req: Request): { id?: string; email?: string; role?: string } | null {
  let token: string | undefined;
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) token = auth.slice(7);
  if (!token && (req as Request & { cookies?: Record<string, string> }).cookies) {
    token = (req as Request & { cookies: Record<string, string> }).cookies.token;
  }
  if (!token) return null;
  try {
    return jwt.verify(token, JWT_SECRET) as { id?: string; email?: string; role?: string };
  } catch {
    return null;
  }
}

// ── requireAdmin (local copy — keeps module self-contained) ───────────────────

function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const role = (req as any).user?.role;
  if (role !== 'ADMIN') {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  next();
}

// ── UUID param guard ──────────────────────────────────────────────────────────

function requireUuidParam(paramName: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const val = req.params[paramName] as string;
    const result = z.string().uuid().safeParse(val);
    if (!result.success) {
      res.status(400).json({ error: `Invalid ${paramName}: must be a UUID` });
      return;
    }
    next();
  };
}

// ── Multer upload (ZIP only, UUID filename in staging/) ───────────────────────

const pluginStorage = multer.diskStorage({
  // A function destination (vs. a plain string) makes multer create the dir lazily on
  // first upload via this callback, instead of multer's own DiskStorage constructor
  // calling fs.mkdirSync() synchronously at module-import time — which fails hard (and
  // breaks unrelated test suites that merely import this router) in any environment
  // where /var/lib/cmdb/plugins isn't pre-created (that only happens via the Docker
  // image build + volume mount, not via jest running the module directly).
  destination: (_req, _file, cb) => {
    const dir = path.join(PLUGIN_STORAGE_PATH, 'staging');
    fs.mkdir(dir, { recursive: true }, (err) => cb(err, dir));
  },
  filename: (_req, _file, cb) => cb(null, `${crypto.randomUUID()}.zip`),
});

const pluginUpload = multer({
  storage: pluginStorage,
  limits: { fileSize: PLUGIN_MAX_SIZE_MB * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext === '.zip') {
      cb(null, true);
    } else {
      cb(new Error('PLUGIN_INVALID_EXT: only .zip bundles are supported'));
    }
  },
}).single('plugin');

// ── Extract manifest.json from a ZIP file ─────────────────────────────────────
// Uses execFile('unzip', ['-p', ...]) — never exec(), no shell injection.

async function extractManifestFromZip(zipPath: string): Promise<unknown> {
  const { stdout } = await execFileAsync('unzip', ['-p', zipPath, 'manifest.json'], {
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  });
  return JSON.parse(stdout);
}

// ── Extract an arbitrary file from a ZIP to a destination ────────────────────

async function extractZipTo(zipPath: string, destDir: string): Promise<void> {
  await fs.promises.mkdir(destDir, { recursive: true });
  await execFileAsync('unzip', ['-o', zipPath, '-d', destDir], {
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
  });
}

// ── Try to extract a specific file from ZIP, returns null if absent ───────────

async function tryExtractFileFromZip(zipPath: string, filename: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('unzip', ['-p', zipPath, filename], {
      timeout: 15_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return null;
  }
}

// ── Resolve the staging ZIP for a plugin (L-08) ───────────────────────────────
// Prefers the recorded staging_zip filename (O(1)); falls back to an O(n) manifest
// scan for legacy rows uploaded before staging_zip was tracked. path.basename on
// the stored value defends against any tampering that could escape the dir.

async function resolveStagingZip(
  plugin: { pluginId: string; stagingZip?: string | null },
): Promise<string | null> {
  const stagingDir = path.join(PLUGIN_STORAGE_PATH, 'staging');
  if (plugin.stagingZip) {
    const direct = path.join(stagingDir, path.basename(plugin.stagingZip));
    if (fs.existsSync(direct)) return direct;
  }
  if (!fs.existsSync(stagingDir)) return null;
  const files = fs.readdirSync(stagingDir).filter((f) => f.endsWith('.zip'));
  for (const f of files) {
    try {
      const raw = await extractManifestFromZip(path.join(stagingDir, f));
      const m = PluginManifestSchema.safeParse(raw);
      if (m.success && m.data.id === plugin.pluginId) return path.join(stagingDir, f);
    } catch {
      // not the right zip, skip
    }
  }
  return null;
}

// ── 4-eyes approval token replay protection (L-09) ────────────────────────────
// Approval tokens are short-lived (5 min) and single-use. Consumed token ids are
// held in-memory until they would have expired anyway, so a token cannot be
// replayed within its TTL even against a different activation of the same plugin.

const consumedApprovalJtis = new Map<string, number>();

function purgeExpiredApprovalJtis(): void {
  const now = Date.now();
  for (const [jti, exp] of consumedApprovalJtis) {
    if (exp <= now) consumedApprovalJtis.delete(jti);
  }
}

// Returns false if the jti was already consumed (replay); otherwise marks it
// consumed until expMs and returns true.
function consumeApprovalJti(jti: string, expMs: number): boolean {
  purgeExpiredApprovalJtis();
  if (consumedApprovalJtis.has(jti)) return false;
  consumedApprovalJtis.set(jti, expMs);
  return true;
}

// ── Marketplace: Zod schema for upstream JSON ────────────────────────────────

const MarketplacePluginSchema = z.object({
  id:                  z.string().min(1).max(128),
  name:                z.string().min(1).max(128),
  version:             z.string().min(1).max(32),
  description:         z.string().max(512).optional().default(''),
  author:              z.string().max(128).optional().default(''),
  downloadUrl:         z.string().url().max(2048),
  iconUrl:             z.string().url().max(2048).optional(),
  minPlatformVersion:  z.string().max(32).optional(),
  permissions:         z.array(z.string().max(64)).optional().default([]),
  category:            z.string().max(64).optional().default(''),
});

const MarketplaceResponseSchema = z.object({
  plugins: z.array(MarketplacePluginSchema).max(200),
});

type MarketplacePlugin = z.infer<typeof MarketplacePluginSchema>;

const MarketplaceInstallBodySchema = z.object({
  pluginId: z.string().min(1).max(128),
});

// ── Marketplace: SSRF allowlist ───────────────────────────────────────────────
// Allows only HTTPS, non-private, non-loopback hosts (A10).

function assertSafeUrl(rawUrl: string, context: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`${context}: invalid URL`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`${context}: only HTTPS URLs are allowed`);
  }
  const h = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const blocked = [
    /^localhost$/,
    /^127\.\d+\.\d+\.\d+$/,
    /^10\.\d+\.\d+\.\d+$/,
    /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/,
    /^192\.168\.\d+\.\d+$/,
    /^169\.254\.\d+\.\d+$/,
    /^::1$/,
    /^fc[\da-f]{2}:/i,
    /^fd[\da-f]{2}:/i,
  ];
  if (blocked.some((re) => re.test(h))) {
    throw new Error(`${context}: private/loopback addresses are not allowed`);
  }
  return parsed;
}

// ── Marketplace: 5-minute server-side cache ───────────────────────────────────

interface MarketplaceCache { plugins: MarketplacePlugin[]; expiresAt: number }
let _marketplaceCache: MarketplaceCache | null = null;
const MARKETPLACE_TTL_MS = 5 * 60 * 1_000;

async function fetchMarketplacePlugins(): Promise<MarketplacePlugin[]> {
  if (_marketplaceCache && Date.now() < _marketplaceCache.expiresAt) {
    return _marketplaceCache.plugins;
  }
  const marketplaceUrl = process.env.PLUGIN_MARKETPLACE_URL ?? '';
  assertSafeUrl(marketplaceUrl, 'PLUGIN_MARKETPLACE_URL');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  // Use .finally() to clear timer — avoids a `let upstream: Response` that
  // TypeScript would resolve to Express.Response due to the import shadow.
  const upstream = await fetch(`${marketplaceUrl}/api/plugins`, {
    signal: controller.signal,
    headers: { Accept: 'application/json' },
  }).finally(() => clearTimeout(timer));
  if (!upstream.ok) throw new Error(`Marketplace returned HTTP ${upstream.status}`);
  const raw = await upstream.json();
  const parsed = MarketplaceResponseSchema.safeParse(raw);
  if (!parsed.success) throw new Error('Marketplace response failed validation');
  _marketplaceCache = { plugins: parsed.data.plugins, expiresAt: Date.now() + MARKETPLACE_TTL_MS };
  return parsed.data.plugins;
}

// ── Router factory ────────────────────────────────────────────────────────────

export function createPluginRouter(prisma: PrismaClient): Router {
  const router = Router();

  // Apply rate limiter and requireAdmin to all plugin management routes
  router.use(pluginRateLimiter);
  router.use(requireAdmin);

  // ── GET /api/plugins ───────────────────────────────────────────────────────
  // List all registered plugins.

  router.get('/', async (_req: Request, res: Response) => {
    try {
      const plugins = await prisma.pluginRegistry.findMany({
        orderBy: { installedAt: 'desc' },
        select: {
          id: true,
          pluginId: true,
          name: true,
          version: true,
          status: true,
          author: true,
          license: true,
          lastError: true,
          approvedBy: true,
          approvedAt: true,
          installedAt: true,
          updatedAt: true,
          permissions: true,
          manifest: true,
        },
      });
      res.json({ plugins });
    } catch (err) {
      console.error('[plugins-api] list error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── GET /api/plugins/marketplace ──────────────────────────────────────────
  // Proxy to configured marketplace. SSRF-safe (allowlist + Zod). 5-min cache.
  // downloadUrl is stripped from the response — only the server uses it (A10).

  router.get('/marketplace', async (_req: Request, res: Response) => {
    if (process.env.PLUGIN_ENABLE_MARKETPLACE !== 'true' || !process.env.PLUGIN_MARKETPLACE_URL) {
      res.json({ plugins: [], available: false });
      return;
    }
    try {
      const plugins = await fetchMarketplacePlugins();
      // Strip downloadUrl before returning to the browser (SSRF A10)
      const safe = plugins.map(({ downloadUrl: _dl, ...rest }) => rest);
      res.json({ plugins: safe, available: true });
    } catch (err) {
      console.error('[plugins-api] marketplace fetch error:', err);
      res.json({ plugins: [], available: false });
    }
  });

  // ── POST /api/plugins/marketplace/install ─────────────────────────────────
  // One-click install from marketplace. Downloads ZIP server-side (no caller URL),
  // validates magic bytes + manifest, registers, validates, and installs in one step.

  router.post('/marketplace/install', async (req: Request, res: Response) => {
    if (process.env.PLUGIN_ENABLE_MARKETPLACE !== 'true' || !process.env.PLUGIN_MARKETPLACE_URL) {
      res.status(503).json({ error: 'Marketplace is not enabled' });
      return;
    }

    const parsed = MarketplaceInstallBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'pluginId is required', details: parsed.error.flatten() });
      return;
    }
    const { pluginId } = parsed.data;
    const userEmail: string = (req as any).user!.email;

    let marketplacePlugins: MarketplacePlugin[];
    try {
      marketplacePlugins = await fetchMarketplacePlugins();
    } catch (err) {
      console.error('[plugins-api] marketplace/install fetch error:', err);
      res.status(502).json({ error: 'Could not reach marketplace' });
      return;
    }

    const mp = marketplacePlugins.find((p) => p.id === pluginId);
    if (!mp) {
      res.status(404).json({ error: `Plugin '${pluginId}' not found in marketplace` });
      return;
    }

    // SSRF-check the downloadUrl from marketplace (A10)
    let downloadUrl: URL;
    try {
      downloadUrl = assertSafeUrl(mp.downloadUrl, 'downloadUrl');
    } catch (ssrfErr) {
      console.error('[plugins-api] marketplace/install SSRF block:', ssrfErr);
      res.status(502).json({ error: 'Marketplace provided an unsafe download URL' });
      return;
    }

    // Download ZIP to staging with UUID filename
    const stagingDir = path.join(PLUGIN_STORAGE_PATH, 'staging');
    await fs.promises.mkdir(stagingDir, { recursive: true });
    const zipFilename = `${crypto.randomUUID()}.zip`;
    const zipPath = path.join(stagingDir, zipFilename);

    try {
      const dlController = new AbortController();
      const dlTimer = setTimeout(() => dlController.abort(), 60_000);
      const dlResponse = await fetch(downloadUrl.toString(), {
        signal: dlController.signal,
        headers: { Accept: 'application/zip, application/octet-stream' },
      }).finally(() => clearTimeout(dlTimer));
      if (!dlResponse.ok) {
        res.status(502).json({ error: `Download failed: HTTP ${dlResponse.status}` });
        return;
      }
      const maxBytes = PLUGIN_MAX_SIZE_MB * 1024 * 1024;
      const arrayBuf = await dlResponse.arrayBuffer();
      if (arrayBuf.byteLength > maxBytes) {
        res.status(413).json({ error: `Plugin exceeds maximum size of ${PLUGIN_MAX_SIZE_MB} MB` });
        return;
      }
      await fs.promises.writeFile(zipPath, Buffer.from(arrayBuf));

      // Magic bytes (ZIP: 50 4B 03 04)
      PluginValidator.validateUploadedFile(zipPath, 'marketplace.zip');

      // Checksum
      const zipBuffer = await fs.promises.readFile(zipPath);
      const checksum = crypto.createHash('sha256').update(zipBuffer).digest('hex');

      // Extract and validate manifest
      let rawManifest: unknown;
      try {
        rawManifest = await extractManifestFromZip(zipPath);
      } catch {
        res.status(422).json({ error: 'Could not extract manifest.json from downloaded zip' });
        return;
      }
      let manifest: z.infer<typeof PluginManifestSchema>;
      try {
        manifest = PluginManifestSchema.parse(rawManifest);
      } catch (zodErr: any) {
        res.status(422).json({ error: 'Invalid manifest.json', details: zodErr.flatten?.() });
        return;
      }

      // Duplicate check
      const existing = await prisma.pluginRegistry.findUnique({ where: { pluginId: manifest.id } });
      if (existing) {
        res.status(409).json({ error: `Plugin '${manifest.id}' is already registered (status: ${existing.status})` });
        return;
      }

      // Register as UPLOADED. Issue #172 (ISO 27001 A.8.15): the create and its
      // audit record must be atomic, so both run inside one $transaction.
      const plugin = await prisma.$transaction(async (tx) => {
        const created = await tx.pluginRegistry.create({
          data: {
            pluginId:    manifest.id,
            name:        manifest.name,
            version:     manifest.version,
            author:      manifest.author,
            license:     manifest.license,
            status:      'UPLOADED',
            manifest:    manifest as any,
            permissions: manifest.permissions,
            checksum,
          },
        });

        await pluginAudit(tx, 'PLUGIN_MARKETPLACE_INSTALL_STARTED', created.id, userEmail, {
          marketplacePluginId: pluginId,
          version: manifest.version,
          checksum,
        });

        return created;
      });

      // Inline validate (manifest already parsed, checksum already computed).
      // Status write + audit atomic (#172).
      await prisma.$transaction(async (tx) => {
        await lifecycleManager.updateStatus(tx, plugin.id, 'VALIDATED');
        await pluginAudit(tx, 'PLUGIN_VALIDATED', plugin.id, userEmail);
      });

      // Inline install: extract to installed/, run migrations, parse artifacts.
      // L-03: extract FIRST, then migrate; roll back the extracted dir if the
      // migration fails so we never leave a migration applied without files.
      // These steps touch the filesystem/an external migration runner, not the
      // DB, so they stay outside the transaction below.
      const installDir = path.join(PLUGIN_STORAGE_PATH, 'installed', plugin.id);
      await extractZipTo(zipPath, installDir);
      const migrationSql = await tryExtractFileFromZip(zipPath, 'migration.sql');
      if (migrationSql) {
        const migRunner = createMigrationRunner(PLUGIN_STORAGE_PATH);
        try {
          await migRunner.runUp(plugin.pluginId, migrationSql);
        } catch (migErr) {
          await fs.promises.rm(installDir, { recursive: true, force: true }).catch(() => {});
          throw migErr;
        }
      }

      // Artifact parsing (DB writes) + status flip + audit atomic (#172).
      await prisma.$transaction(async (tx) => {
        const c = await parseBundleArtifacts(tx, plugin.id, installDir, manifest as Parameters<typeof parseBundleArtifacts>[3]);
        await lifecycleManager.updateStatus(tx, plugin.id, 'INSTALLED');
        await pluginAudit(tx, 'PLUGIN_INSTALLED', plugin.id, userEmail, {
          installDir,
          hasMigration: migrationSql !== null,
          source: 'marketplace',
          ...c,
        });
      });

      // Clean up staging zip
      fs.unlink(zipPath, () => {});

      res.status(201).json({
        id:       plugin.id,
        pluginId: plugin.pluginId,
        name:     plugin.name,
        version:  plugin.version,
        status:   'INSTALLED',
      });
    } catch (err) {
      console.error('[plugins-api] marketplace/install error:', err);
      fs.unlink(zipPath, () => {});
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── POST /api/plugins/upload ───────────────────────────────────────────────
  // Upload a plugin ZIP. Validates magic bytes, extracts manifest, stores record.

  router.post('/upload', (req: Request, res: Response) => {
    pluginUpload(req, res, async (multerErr) => {
      if (multerErr) {
        res.status(422).json({ error: multerErr.message });
        return;
      }
      if (!req.file) {
        res.status(400).json({ error: 'No plugin file uploaded' });
        return;
      }

      const zipPath = req.file.path;

      try {
        // Post-multer magic bytes check (ZIP: 50 4B 03 04)
        PluginValidator.validateUploadedFile(zipPath, req.file.originalname);

        // Compute SHA-256 of the uploaded ZIP
        const zipBuffer = await fs.promises.readFile(zipPath);
        const checksum = crypto.createHash('sha256').update(zipBuffer).digest('hex');

        // Extract and validate manifest
        let rawManifest: unknown;
        try {
          rawManifest = await extractManifestFromZip(zipPath);
        } catch (parseErr) {
          res.status(422).json({ error: 'Could not extract manifest.json from zip' });
          // Clean up staging file
          fs.unlink(zipPath, () => {});
          return;
        }

        let manifest;
        try {
          manifest = PluginManifestSchema.parse(rawManifest);
        } catch (zodErr: any) {
          res.status(422).json({ error: 'Invalid manifest.json', details: zodErr.flatten?.() });
          fs.unlink(zipPath, () => {});
          return;
        }

        // Check for duplicate pluginId
        const existing = await prisma.pluginRegistry.findUnique({
          where: { pluginId: manifest.id },
        });
        if (existing) {
          res.status(409).json({ error: `Plugin '${manifest.id}' is already registered (status: ${existing.status})` });
          fs.unlink(zipPath, () => {});
          return;
        }

        // Rename staging file to a UUID-named zip for traceability
        const stagingName = path.basename(zipPath);
        const finalStagingPath = path.join(PLUGIN_STORAGE_PATH, 'staging', stagingName);
        // File is already at zipPath inside staging — just record it

        // Issue #172: create + audit atomic.
        const plugin = await prisma.$transaction(async (tx) => {
          const created = await tx.pluginRegistry.create({
            data: {
              pluginId:    manifest.id,
              name:        manifest.name,
              version:     manifest.version,
              author:      manifest.author,
              license:     manifest.license,
              status:      'UPLOADED',
              manifest:    manifest as any,
              permissions: manifest.permissions,
              checksum,
              stagingZip:  stagingName, // L-08: record the staging zip for O(1) lookup
            },
          });

          await pluginAudit(tx, 'PLUGIN_UPLOADED', created.id, (req as any).user!.email, {
            pluginId: manifest.id,
            version:  manifest.version,
            checksum,
            stagingFile: path.basename(finalStagingPath),
          });

          return created;
        });

        res.status(201).json({
          id:        plugin.id,
          pluginId:  plugin.pluginId,
          name:      plugin.name,
          version:   plugin.version,
          status:    plugin.status,
          checksum,
        });
      } catch (err) {
        console.error('[plugins-api] upload error:', err);
        fs.unlink(zipPath, () => {});
        res.status(500).json({ error: 'Internal server error' });
      }
    });
  });

  // ── POST /api/plugins/:id/validate ────────────────────────────────────────
  // Verify checksum + Ed25519 signature (if present), update status.

  router.post(
    '/:id/validate',
    requireUuidParam('id'),
    requirePluginExists(prisma),
    async (req: Request, res: Response) => {
      const plugin = (req as any).plugin as any;
      const userEmail: string = (req as any).user!.email;

      try {
        const manifest = plugin.manifest as any;

        // Locate the staging ZIP via the recorded filename (L-08), legacy scan fallback.
        const zipPath = await resolveStagingZip(plugin);

        // Verify checksum if we found the zip
        if (zipPath) {
          const valid = PluginValidator.validateChecksum(zipPath, plugin.checksum);
          if (!valid) {
            // Issue #172: status flip to ERROR + audit atomic.
            await prisma.$transaction(async (tx) => {
              await lifecycleManager.updateStatus(tx, plugin.id, 'ERROR', 'Checksum mismatch');
              await pluginAudit(tx, 'PLUGIN_VALIDATION_FAILED', plugin.id, userEmail, {
                reason: 'Checksum mismatch',
              });
            });
            res.status(422).json({ error: 'Checksum mismatch — plugin file may be corrupted' });
            return;
          }

          // Verify Ed25519 signature if manifest declares one
          if (manifest.signature) {
            const publicKeyB64 = process.env.PLUGIN_SIGNING_PUBLIC_KEY;
            if (!publicKeyB64) {
              await prisma.$transaction(async (tx) => {
                await lifecycleManager.updateStatus(tx, plugin.id, 'ERROR', 'No signing public key configured');
                await pluginAudit(tx, 'PLUGIN_VALIDATION_FAILED', plugin.id, userEmail, {
                  reason: 'PLUGIN_SIGNING_PUBLIC_KEY not set but manifest has signature',
                });
              });
              res.status(422).json({ error: 'Signature verification failed: PLUGIN_SIGNING_PUBLIC_KEY not configured' });
              return;
            }
            try {
              const ok = crypto.verify(
                null, // Ed25519 does not use a separate hash algorithm
                Buffer.from(plugin.checksum, 'hex'),
                {
                  key: Buffer.from(publicKeyB64, 'base64'),
                  format: 'der',
                  type: 'spki',
                },
                Buffer.from(manifest.signature, 'base64'),
              );
              if (!ok) throw new Error('Signature invalid');
            } catch (sigErr) {
              await prisma.$transaction(async (tx) => {
                await lifecycleManager.updateStatus(tx, plugin.id, 'ERROR', 'Signature verification failed');
                await pluginAudit(tx, 'PLUGIN_VALIDATION_FAILED', plugin.id, userEmail, {
                  reason: 'Ed25519 signature invalid',
                });
              });
              res.status(422).json({ error: 'Ed25519 signature verification failed' });
              return;
            }
          }
        }

        // Re-validate manifest through Zod schema
        try {
          PluginValidator.validateManifest(manifest);
        } catch (manifestErr: any) {
          await prisma.$transaction(async (tx) => {
            await lifecycleManager.updateStatus(tx, plugin.id, 'ERROR', String(manifestErr.message));
            await pluginAudit(tx, 'PLUGIN_VALIDATION_FAILED', plugin.id, userEmail, {
              reason: manifestErr.message,
            });
          });
          res.status(422).json({ error: 'Manifest validation failed', details: manifestErr.flatten?.() });
          return;
        }

        await prisma.$transaction(async (tx) => {
          await lifecycleManager.updateStatus(tx, plugin.id, 'VALIDATED');
          await pluginAudit(tx, 'PLUGIN_VALIDATED', plugin.id, userEmail);
        });

        res.json({ id: plugin.id, status: 'VALIDATED' });
      } catch (err) {
        console.error('[plugins-api] validate error:', err);
        // Best-effort recovery on an unexpected error: status flip + audit
        // atomic (#172), whole attempt still swallowed as before.
        await prisma.$transaction(async (tx) => {
          await lifecycleManager.updateStatus(tx, plugin.id, 'ERROR', (err as Error).message);
          await pluginAudit(tx, 'PLUGIN_VALIDATION_FAILED', plugin.id, userEmail, {
            reason: (err as Error).message,
          });
        }).catch(() => {});
        res.status(500).json({ error: 'Internal server error' });
      }
    },
  );

  // ── POST /api/plugins/:id/install ─────────────────────────────────────────
  // Extract zip to installed/, run up-migration if present, set INSTALLED.

  router.post(
    '/:id/install',
    requireUuidParam('id'),
    requirePluginExists(prisma),
    async (req: Request, res: Response) => {
      const plugin = (req as any).plugin as any;
      const userEmail: string = (req as any).user!.email;

      if (plugin.status !== 'VALIDATED') {
        res.status(409).json({ error: `Cannot install plugin in status '${plugin.status}' — must be VALIDATED` });
        return;
      }

      try {
        // Locate the staging ZIP via the recorded filename (L-08), legacy scan fallback.
        const zipPath = await resolveStagingZip(plugin);
        if (!zipPath) {
          res.status(422).json({ error: 'Staging zip not found — re-upload the plugin' });
          return;
        }

        const installDir = path.join(PLUGIN_STORAGE_PATH, 'installed', plugin.id);

        // L-03: extract FIRST, then migrate. An extract failure must not leave a
        // migration applied; a migration failure rolls back the extracted dir.
        await extractZipTo(zipPath, installDir);

        const migrationSql = await tryExtractFileFromZip(zipPath, 'migration.sql');
        if (migrationSql) {
          const migRunner = createMigrationRunner(PLUGIN_STORAGE_PATH);
          try {
            await migRunner.runUp(plugin.pluginId, migrationSql);
          } catch (migErr) {
            await fs.promises.rm(installDir, { recursive: true, force: true }).catch(() => {});
            throw migErr;
          }
        }

        // Parse the bundle's hooks/cron/routes into DB rows (fails if a declared
        // hook/cron/route has no handler file in the bundle).
        // Issue #172: artifact parsing (DB writes) + status flip + audit atomic.
        const manifest = plugin.manifest as Parameters<typeof parseBundleArtifacts>[3];
        await prisma.$transaction(async (tx) => {
          const c = await parseBundleArtifacts(tx, plugin.id, installDir, manifest);
          await lifecycleManager.updateStatus(tx, plugin.id, 'INSTALLED');
          await pluginAudit(tx, 'PLUGIN_INSTALLED', plugin.id, userEmail, {
            installDir,
            hasMigration: migrationSql !== null,
            ...c,
          });
        });

        // L-08: the staging zip is consumed once installed — GC it and clear the
        // ref. Best-effort cleanup, deliberately outside the transaction above
        // (a GC failure must not roll back a successful install).
        await fs.promises.unlink(zipPath).catch(() => {});
        await prisma.pluginRegistry.update({
          where: { id: plugin.id },
          data: { stagingZip: null },
        }).catch(() => {});

        res.json({ id: plugin.id, status: 'INSTALLED' });
      } catch (err) {
        console.error('[plugins-api] install error:', err);
        await lifecycleManager.updateStatus(prisma, plugin.id, 'ERROR', (err as Error).message).catch(() => {});
        res.status(500).json({ error: 'Internal server error' });
      }
    },
  );

  // ── POST /api/plugins/:id/approve ─────────────────────────────────────────
  // 4-eyes (L-09): a second ADMIN mints a short-lived, single-use approval token
  // bound to {pluginId, action}. The requester then passes it to /activate.
  // Unlike the previous design (a reused 8h session JWT), this token is scoped to
  // one plugin + action, expires in 5 min, and is rejected on replay.

  router.post(
    '/:id/approve',
    requireUuidParam('id'),
    requirePluginExists(prisma),
    async (req: Request, res: Response) => {
      const plugin = (req as any).plugin as any;
      const approverEmail: string = (req as any).user!.email;
      const approverId: string    = (req as any).user!.id;

      // The approver is guaranteed ADMIN by router.use(requireAdmin) above.
      const approvalToken = jwt.sign(
        {
          purpose:  'plugin-approval',
          pluginId: plugin.id, // bound to this specific plugin (db uuid)
          action:   'activate',
          approverId,
          approverEmail,
          jti:      crypto.randomUUID(),
        },
        JWT_SECRET,
        { algorithm: 'HS256', expiresIn: '5m' },
      );

      // Issue #172 — intentional exclusion, NOT wrapped in a transaction: the
      // approval token is a signed JWT held only in-memory (consumedApprovalJtis
      // map) and never written to the DB, so there is no preceding mutation to
      // roll back against. This audit insert is the only DB write in this
      // handler; wrapping a single write in $transaction adds no atomicity.
      await pluginAudit(prisma, 'PLUGIN_APPROVAL_ISSUED', plugin.id, approverEmail, {
        action: 'activate',
      });

      res.json({ approvalToken, expiresInSeconds: 300 });
    },
  );

  // ── POST /api/plugins/:id/activate ────────────────────────────────────────
  // Activate an INSTALLED or INACTIVE plugin. In production requires 4-eyes approval.

  router.post(
    '/:id/activate',
    requireUuidParam('id'),
    requirePluginExists(prisma),
    async (req: Request, res: Response) => {
      const plugin = (req as any).plugin as any;
      const userEmail: string = (req as any).user!.email;
      const userId: string    = (req as any).user!.id;

      if (!['INSTALLED', 'INACTIVE'].includes(plugin.status)) {
        res.status(409).json({ error: `Cannot activate plugin in status '${plugin.status}'` });
        return;
      }

      // 4-eyes approval gate in production (L-09: scoped, single-use token)
      if (process.env.NODE_ENV === 'production' && process.env.PLUGIN_REQUIRE_APPROVAL_PROD === 'true') {
        const parsed = PluginActivateSchema.safeParse(req.body);
        if (!parsed.success || !parsed.data.approvalToken) {
          res.status(403).json({ error: '4-eyes approval required: a second ADMIN must issue an approvalToken via POST /api/plugins/:id/approve' });
          return;
        }

        let approvalPayload: any;
        try {
          approvalPayload = jwt.verify(parsed.data.approvalToken, JWT_SECRET, { algorithms: ['HS256'] });
        } catch {
          res.status(403).json({ error: 'approvalToken is invalid or expired' });
          return;
        }

        // Must be a purpose-built approval token scoped to THIS plugin + action
        if (
          approvalPayload.purpose !== 'plugin-approval' ||
          approvalPayload.pluginId !== plugin.id ||
          approvalPayload.action !== 'activate' ||
          typeof approvalPayload.jti !== 'string'
        ) {
          res.status(403).json({ error: 'approvalToken scope does not match this activation' });
          return;
        }

        // The approver must be a different user from the requester
        if (approvalPayload.approverId === userId || approvalPayload.approverEmail === userEmail) {
          res.status(403).json({ error: '4-eyes violation: approver must be a different ADMIN than the requester' });
          return;
        }

        // Single-use: reject replay within the token's TTL
        const expMs = typeof approvalPayload.exp === 'number'
          ? approvalPayload.exp * 1000
          : Date.now() + 300_000;
        if (!consumeApprovalJti(approvalPayload.jti, expMs)) {
          res.status(403).json({ error: 'approvalToken has already been used' });
          return;
        }
      }

      try {
        // Issue #172: status flip to ACTIVE + audit atomic. Runtime
        // registration is in-memory (not DB), but is kept inside the callback
        // in the original order — if it throws, the status update now rolls
        // back too, closing a pre-existing gap where a failed runtime
        // registration could leave the DB status ACTIVE with nothing running.
        await prisma.$transaction(async (tx) => {
          await tx.pluginRegistry.update({
            where: { id: plugin.id },
            data: {
              status:     'ACTIVE',
              approvedBy: userEmail,
              approvedAt: new Date(),
              lastError:  null,
              updatedAt:  new Date(),
            },
          });

          // Register the plugin's hooks/cron/routes into the live runtime
          const full = await tx.pluginRegistry.findUnique({
            where: { id: plugin.id },
            include: { hooks: true, cronJobs: true, routes: true },
          });
          if (full) pluginRuntime.registerPlugin(full as unknown as RuntimePlugin);

          await pluginAudit(tx, 'PLUGIN_ACTIVATED', plugin.id, userEmail);
        });

        res.json({ id: plugin.id, status: 'ACTIVE' });
      } catch (err) {
        console.error('[plugins-api] activate error:', err);
        res.status(500).json({ error: 'Internal server error' });
      }
    },
  );

  // ── POST /api/plugins/:id/deactivate ──────────────────────────────────────
  // Deactivate an ACTIVE plugin.

  router.post(
    '/:id/deactivate',
    requireUuidParam('id'),
    requirePluginExists(prisma),
    async (req: Request, res: Response) => {
      const plugin = (req as any).plugin as any;
      const userEmail: string = (req as any).user!.email;

      if (plugin.status !== 'ACTIVE') {
        res.status(409).json({ error: `Cannot deactivate plugin in status '${plugin.status}' — must be ACTIVE` });
        return;
      }

      try {
        // Tear down live hooks/cron/routes before flipping status
        pluginRuntime.unregisterPlugin(plugin.id, plugin.pluginId);
        // Issue #172: status flip to INACTIVE + audit atomic.
        await prisma.$transaction(async (tx) => {
          await lifecycleManager.updateStatus(tx, plugin.id, 'INACTIVE');
          await pluginAudit(tx, 'PLUGIN_DEACTIVATED', plugin.id, userEmail);
        });

        res.json({ id: plugin.id, status: 'INACTIVE' });
      } catch (err) {
        console.error('[plugins-api] deactivate error:', err);
        res.status(500).json({ error: 'Internal server error' });
      }
    },
  );

  // ── POST /api/plugins/:id/uninstall ───────────────────────────────────────
  // Backup plugin data, run down-migration, delete files and registry record.

  router.post(
    '/:id/uninstall',
    requireUuidParam('id'),
    requirePluginExists(prisma),
    async (req: Request, res: Response) => {
      const plugin = (req as any).plugin as any;
      const userEmail: string = (req as any).user!.email;

      if (!['INSTALLED', 'INACTIVE', 'ERROR'].includes(plugin.status)) {
        res.status(409).json({ error: `Cannot uninstall plugin in status '${plugin.status}'` });
        return;
      }

      try {
        // Defensively tear down any live runtime registration
        pluginRuntime.unregisterPlugin(plugin.id, plugin.pluginId);

        // Backup plugin tables data to JSON
        const backupsDir = path.join(PLUGIN_STORAGE_PATH, 'backups');
        await fs.promises.mkdir(backupsDir, { recursive: true });

        const tablePrefix = `plg_${plugin.pluginId.replace(/-/g, '_')}`;
        const backupFilename = `${plugin.id}_${Date.now()}.json`;
        const backupPath = path.join(backupsDir, backupFilename);

        // Query pg_tables to find all plugin-owned tables
        const pluginTables: Array<{ tablename: string }> = await prisma.$queryRaw`
          SELECT tablename FROM pg_tables
          WHERE schemaname = 'public' AND tablename LIKE ${tablePrefix + '%'}
        `;

        const backupData: Record<string, unknown[]> = {};
        for (const { tablename } of pluginTables) {
          // Safe: tablename comes from pg_tables (system catalog), not user input.
          // Still validate it starts with the plugin prefix before using.
          if (!tablename.startsWith('plg_')) continue;
          const rows: unknown[] = await prisma.$queryRawUnsafe(`SELECT * FROM "${tablename}"`);
          backupData[tablename] = rows;
        }

        const backupJson = JSON.stringify(backupData, null, 2);
        await fs.promises.writeFile(backupPath, backupJson, 'utf-8');
        const backupStat = await fs.promises.stat(backupPath);

        await createBackupRecord(prisma, plugin.id, backupPath, backupStat.size, 'UNINSTALL');

        // Run down-migration (drops plg_* tables)
        const migRunner = createMigrationRunner(PLUGIN_STORAGE_PATH);
        await migRunner.runDown(plugin.pluginId);

        // Delete installed directory
        const installDir = path.join(PLUGIN_STORAGE_PATH, 'installed', plugin.id);
        if (fs.existsSync(installDir)) {
          await fs.promises.rm(installDir, { recursive: true, force: true });
        }

        // Delete staging zip if one is still around (L-08: O(1) via recorded name,
        // legacy scan fallback). Installed plugins already GC theirs, so this is a
        // no-op unless the plugin was uninstalled straight from VALIDATED/ERROR.
        const stagingZip = await resolveStagingZip(plugin);
        if (stagingZip) {
          await fs.promises.unlink(stagingZip).catch(() => {});
        }

        // Issue #172: audit + delete atomic — either both commit or neither
        // does, so a failed audit insert can no longer leave the registry row
        // deleted with no record of it. Audit still written before the delete
        // (order preserved from the original code, "so the plugin id is still
        // meaningful") — within the same transaction this is purely stylistic,
        // since nothing is visible outside until commit.
        await prisma.$transaction(async (tx) => {
          await pluginAudit(tx, 'PLUGIN_UNINSTALLED', plugin.id, userEmail, {
            pluginId: plugin.pluginId,
            backupPath,
          });

          // Delete the PluginRegistry record (cascades to hooks, cron, routes, backups)
          await tx.pluginRegistry.delete({ where: { id: plugin.id } });
        });

        res.json({ id: plugin.id, uninstalled: true });
      } catch (err) {
        console.error('[plugins-api] uninstall error:', err);
        res.status(500).json({ error: 'Internal server error' });
      }
    },
  );

  // ── GET /api/plugins/:id/config ───────────────────────────────────────────
  // Return current plugin config.

  router.get(
    '/:id/config',
    requireUuidParam('id'),
    requirePluginExists(prisma),
    async (req: Request, res: Response) => {
      const plugin = (req as any).plugin as any;
      res.json({ config: plugin.config ?? {} });
    },
  );

  // ── PATCH /api/plugins/:id/config ─────────────────────────────────────────
  // Merge new config keys into existing config.

  router.patch(
    '/:id/config',
    requireUuidParam('id'),
    requirePluginExists(prisma),
    async (req: Request, res: Response) => {
      const plugin = (req as any).plugin as any;
      const userEmail: string = (req as any).user!.email;

      const bodySchema = z.record(z.unknown());
      const parsed = bodySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid config body: must be a JSON object' });
        return;
      }

      try {
        const mergedConfig = { ...(plugin.config as Record<string, unknown>), ...parsed.data };

        // Issue #172: config update + audit atomic.
        await prisma.$transaction(async (tx) => {
          await tx.pluginRegistry.update({
            where: { id: plugin.id },
            data: { config: mergedConfig as any, updatedAt: new Date() },
          });

          await pluginAudit(tx, 'PLUGIN_CONFIG_UPDATED', plugin.id, userEmail, {
            updatedKeys: Object.keys(parsed.data),
          });
        });

        res.json({ config: mergedConfig });
      } catch (err) {
        console.error('[plugins-api] config update error:', err);
        res.status(500).json({ error: 'Internal server error' });
      }
    },
  );

  // ── GET /api/plugins/:id/logs ─────────────────────────────────────────────
  // Fetch audit log entries for this plugin.

  router.get(
    '/:id/logs',
    requireUuidParam('id'),
    requirePluginExists(prisma),
    async (req: Request, res: Response) => {
      const plugin = (req as any).plugin as any;

      // Parse query params
      const limitRaw = parseInt(String(req.query.limit ?? '50'), 10);
      const limit = Math.min(isNaN(limitRaw) || limitRaw < 1 ? 50 : limitRaw, 200);

      const sinceRaw = req.query.since ? String(req.query.since) : null;
      let since: Date | null = null;
      if (sinceRaw) {
        const d = new Date(sinceRaw);
        if (isNaN(d.getTime())) {
          res.status(400).json({ error: "'since' must be a valid ISO date string" });
          return;
        }
        since = d;
      }

      try {
        let logs: unknown[];
        if (since) {
          logs = await prisma.$queryRaw`
            SELECT id, action, entity, entity_id, user_email, details, created_at
            FROM audit_logs
            WHERE entity = 'PLUGIN' AND entity_id = ${plugin.id}
              AND created_at > ${since}
            ORDER BY created_at DESC
            LIMIT ${limit}
          `;
        } else {
          logs = await prisma.$queryRaw`
            SELECT id, action, entity, entity_id, user_email, details, created_at
            FROM audit_logs
            WHERE entity = 'PLUGIN' AND entity_id = ${plugin.id}
            ORDER BY created_at DESC
            LIMIT ${limit}
          `;
        }

        res.json({ logs });
      } catch (err) {
        console.error('[plugins-api] logs error:', err);
        res.status(500).json({ error: 'Internal server error' });
      }
    },
  );

  // ── POST /api/plugins/:id/rollback ────────────────────────────────────────
  // Version rollback — not yet implemented (complex multi-step operation).

  router.post(
    '/:id/rollback',
    requireUuidParam('id'),
    (_req: Request, res: Response) => {
      res.status(501).json({ error: 'Rollback not yet implemented' });
    },
  );

  return router;
}

// ── Public router: plugin UI static assets (H-04) ─────────────────────────────
// Mounted at /api/plugins (BEFORE the admin router). Serves installed/<id>/ui/*
// to any authenticated user (NOT just ADMIN). Unmatched paths fall through.

export function createPluginPublicRouter(prisma: PrismaClient): Router {
  const router = Router();

  router.use('/:id/ui', requireUuidParam('id'), async (req: Request, res: Response) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.status(405).end(); return; }

    // Require a valid session (any role) — plugin UI is not public to anonymous users
    const user = verifyJwt(req);
    if (!user) { res.status(401).json({ error: 'Authentication required' }); return; }

    const id = String(req.params.id);
    const plugin = await prisma.pluginRegistry.findUnique({ where: { id } });
    if (!plugin) { res.status(404).json({ error: 'Plugin not found' }); return; }

    // Validate the requested slot against the manifest's declared uiSlots
    const slot = typeof req.query.slot === 'string' ? req.query.slot : null;
    const uiSlots = ((plugin.manifest as { uiSlots?: string[] })?.uiSlots) ?? [];
    if (slot && !uiSlots.includes(slot)) {
      res.status(400).json({ error: `Plugin does not expose slot "${slot}"` });
      return;
    }

    const uiDir = path.join(PLUGIN_STORAGE_PATH, 'installed', id, 'ui');
    // req.path is the remainder after the mount (e.g. '/', '/widget.html', '/a/b.js')
    const rel = req.path === '/' || req.path === '' ? 'index.html' : req.path.replace(/^\/+/, '');
    const full = path.resolve(uiDir, rel);
    const base = path.resolve(uiDir);
    if (full !== base && !full.startsWith(base + path.sep)) {
      res.status(400).json({ error: 'Invalid asset path' });
      return;
    }
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
      res.status(404).json({ error: 'Asset not found' });
      return;
    }

    // Strict CSP for the sandboxed iframe content. Allow inline scripts/styles
    // (plugin UIs are simple HTML), but lock down origins and framing.
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self'",
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Type', UI_MIME[path.extname(full).toLowerCase()] ?? 'application/octet-stream');
    fs.createReadStream(full).pipe(res);
  });

  return router;
}

// ── Ext router: dynamic plugin routes dispatcher (H-01) ───────────────────────
// Mounted at /api/ext. Matches /:pluginId/<route-path> against the live
// RouteRegistry and runs the handler in the sandbox. No Express routes are
// mounted/unmounted dynamically — the dispatcher matches the registry.

export function createPluginExtRouter(_prisma: PrismaClient): Router {
  const router = Router();
  router.use(pluginRateLimiter);

  router.use('/:pluginId', async (req: Request, res: Response) => {
    const pluginId = String(req.params.pluginId);
    const subPath = req.path === '' ? '/' : req.path;

    const def = routeRegistry.match(pluginId, req.method, subPath);
    if (!def) { res.status(404).json({ error: 'No such plugin route' }); return; }

    let user: { email?: string; role?: string } | null = null;
    if (def.requiresAuth) {
      user = verifyJwt(req);
      if (!user) { res.status(401).json({ error: 'Authentication required' }); return; }
      if (def.requiredRole && user.role !== def.requiredRole) {
        res.status(403).json({ error: 'Forbidden' }); return;
      }
    }

    const reqLike = {
      method: req.method,
      path: subPath,
      query: req.query,
      body: req.body,
      user: user ? { email: user.email, role: user.role } : null,
    };

    try {
      const result = await pluginRuntime.runRoute(def, reqLike) as { status?: number; body?: unknown } | undefined;
      const status = typeof result?.status === 'number' ? result.status : 200;
      const body = result && typeof result === 'object' && 'body' in result ? result.body : (result ?? {});
      res.status(status).json(body);
    } catch (err) {
      console.error('[plugins-ext] handler error:', err);
      res.status(500).json({ error: 'Plugin route handler failed' });
    }
  });

  return router;
}

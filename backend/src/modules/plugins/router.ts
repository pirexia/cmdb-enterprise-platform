import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
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
async function parseBundleArtifacts(
  prisma: PrismaClient,
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

  await prisma.$transaction([
    prisma.pluginHook.deleteMany({ where: { pluginId: pluginDbId } }),
    prisma.pluginCronJob.deleteMany({ where: { pluginId: pluginDbId } }),
    prisma.pluginRoute.deleteMany({ where: { pluginId: pluginDbId } }),
    ...hookRows.map((data) => prisma.pluginHook.create({ data })),
    ...cronRows.map((data) => prisma.pluginCronJob.create({ data })),
    ...routeRows.map((data) => prisma.pluginRoute.create({ data })),
  ]);

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
  destination: path.join(PLUGIN_STORAGE_PATH, 'staging'),
  filename: (_req, _file, cb) => cb(null, `${crypto.randomUUID()}.zip`),
});

const pluginUpload = multer({
  storage: pluginStorage,
  limits: { fileSize: PLUGIN_MAX_SIZE_MB * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.gz', '.zip', '.tgz'].includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('PLUGIN_INVALID_EXT: only .tar.gz / .tgz / .zip allowed'));
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
  // Proxy to configured marketplace URL. Never accepts URL from caller (SSRF A10).

  router.get('/marketplace', async (_req: Request, res: Response) => {
    const enabled = process.env.PLUGIN_ENABLE_MARKETPLACE === 'true';
    const marketplaceUrl = process.env.PLUGIN_MARKETPLACE_URL;

    if (!enabled || !marketplaceUrl) {
      res.json({ plugins: [], available: false });
      return;
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      const upstream = await fetch(`${marketplaceUrl}/api/plugins`, {
        signal: controller.signal,
        headers: { 'Accept': 'application/json' },
      });
      clearTimeout(timer);

      if (!upstream.ok) {
        res.json({ plugins: [], available: false });
        return;
      }
      const data = await upstream.json() as { plugins?: unknown[] };
      res.json({ plugins: data.plugins ?? [], available: true });
    } catch (err) {
      console.error('[plugins-api] marketplace fetch error:', err);
      res.json({ plugins: [], available: false });
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

        const plugin = await prisma.pluginRegistry.create({
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

        await pluginAudit(prisma, 'PLUGIN_UPLOADED', plugin.id, (req as any).user!.email, {
          pluginId: manifest.id,
          version:  manifest.version,
          checksum,
          stagingFile: path.basename(finalStagingPath),
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

        // Find the staging ZIP (named <uuid>.zip in staging/)
        const stagingDir = path.join(PLUGIN_STORAGE_PATH, 'staging');
        // The zip could be named by pluginDbId UUID or earlier upload UUID.
        // We search staging for a zip whose embedded manifest.id matches.
        let zipPath: string | null = null;
        if (fs.existsSync(stagingDir)) {
          const files = fs.readdirSync(stagingDir).filter((f) => f.endsWith('.zip'));
          for (const f of files) {
            try {
              const raw = await extractManifestFromZip(path.join(stagingDir, f));
              const m = PluginManifestSchema.safeParse(raw);
              if (m.success && m.data.id === plugin.pluginId) {
                zipPath = path.join(stagingDir, f);
                break;
              }
            } catch {
              // not the right zip, skip
            }
          }
        }

        // Verify checksum if we found the zip
        if (zipPath) {
          const valid = PluginValidator.validateChecksum(zipPath, plugin.checksum);
          if (!valid) {
            await lifecycleManager.updateStatus(prisma, plugin.id, 'ERROR', 'Checksum mismatch');
            await pluginAudit(prisma, 'PLUGIN_VALIDATION_FAILED', plugin.id, userEmail, {
              reason: 'Checksum mismatch',
            });
            res.status(422).json({ error: 'Checksum mismatch — plugin file may be corrupted' });
            return;
          }

          // Verify Ed25519 signature if manifest declares one
          if (manifest.signature) {
            const publicKeyB64 = process.env.PLUGIN_SIGNING_PUBLIC_KEY;
            if (!publicKeyB64) {
              await lifecycleManager.updateStatus(prisma, plugin.id, 'ERROR', 'No signing public key configured');
              await pluginAudit(prisma, 'PLUGIN_VALIDATION_FAILED', plugin.id, userEmail, {
                reason: 'PLUGIN_SIGNING_PUBLIC_KEY not set but manifest has signature',
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
              await lifecycleManager.updateStatus(prisma, plugin.id, 'ERROR', 'Signature verification failed');
              await pluginAudit(prisma, 'PLUGIN_VALIDATION_FAILED', plugin.id, userEmail, {
                reason: 'Ed25519 signature invalid',
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
          await lifecycleManager.updateStatus(prisma, plugin.id, 'ERROR', String(manifestErr.message));
          await pluginAudit(prisma, 'PLUGIN_VALIDATION_FAILED', plugin.id, userEmail, {
            reason: manifestErr.message,
          });
          res.status(422).json({ error: 'Manifest validation failed', details: manifestErr.flatten?.() });
          return;
        }

        await lifecycleManager.updateStatus(prisma, plugin.id, 'VALIDATED');
        await pluginAudit(prisma, 'PLUGIN_VALIDATED', plugin.id, userEmail);

        res.json({ id: plugin.id, status: 'VALIDATED' });
      } catch (err) {
        console.error('[plugins-api] validate error:', err);
        await lifecycleManager.updateStatus(prisma, plugin.id, 'ERROR', (err as Error).message).catch(() => {});
        await pluginAudit(prisma, 'PLUGIN_VALIDATION_FAILED', plugin.id, userEmail, {
          reason: (err as Error).message,
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
        // Find the staging zip
        const stagingDir = path.join(PLUGIN_STORAGE_PATH, 'staging');
        let zipPath: string | null = null;
        if (fs.existsSync(stagingDir)) {
          const files = fs.readdirSync(stagingDir).filter((f) => f.endsWith('.zip'));
          for (const f of files) {
            try {
              const raw = await extractManifestFromZip(path.join(stagingDir, f));
              const m = PluginManifestSchema.safeParse(raw);
              if (m.success && m.data.id === plugin.pluginId) {
                zipPath = path.join(stagingDir, f);
                break;
              }
            } catch {
              // skip
            }
          }
        }

        if (!zipPath) {
          res.status(422).json({ error: 'Staging zip not found — re-upload the plugin' });
          return;
        }

        const installDir = path.join(PLUGIN_STORAGE_PATH, 'installed', plugin.id);

        // Run up-migration if migration.sql exists in the zip
        const migrationSql = await tryExtractFileFromZip(zipPath, 'migration.sql');
        if (migrationSql) {
          const migRunner = createMigrationRunner(PLUGIN_STORAGE_PATH);
          await migRunner.runUp(plugin.pluginId, migrationSql);
        }

        // Extract zip contents to installed/<db-uuid>/
        await extractZipTo(zipPath, installDir);

        // Parse the bundle's hooks/cron/routes into DB rows (fails if a declared
        // hook/cron/route has no handler file in the bundle).
        const manifest = plugin.manifest as Parameters<typeof parseBundleArtifacts>[3];
        const counts = await parseBundleArtifacts(prisma, plugin.id, installDir, manifest);

        await lifecycleManager.updateStatus(prisma, plugin.id, 'INSTALLED');
        await pluginAudit(prisma, 'PLUGIN_INSTALLED', plugin.id, userEmail, {
          installDir,
          hasMigration: migrationSql !== null,
          ...counts,
        });

        res.json({ id: plugin.id, status: 'INSTALLED' });
      } catch (err) {
        console.error('[plugins-api] install error:', err);
        await lifecycleManager.updateStatus(prisma, plugin.id, 'ERROR', (err as Error).message).catch(() => {});
        res.status(500).json({ error: 'Internal server error' });
      }
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

      // 4-eyes approval gate in production
      if (process.env.NODE_ENV === 'production' && process.env.PLUGIN_REQUIRE_APPROVAL_PROD === 'true') {
        const parsed = PluginActivateSchema.safeParse(req.body);
        if (!parsed.success || !parsed.data.approvalToken) {
          res.status(403).json({ error: '4-eyes approval required: provide approvalToken signed by a different ADMIN' });
          return;
        }

        let approvalPayload: any;
        try {
          approvalPayload = jwt.verify(parsed.data.approvalToken, JWT_SECRET);
        } catch {
          res.status(403).json({ error: 'approvalToken is invalid or expired' });
          return;
        }

        // The approving admin must be a different user from the requester
        if (approvalPayload.role !== 'ADMIN') {
          res.status(403).json({ error: 'approvalToken must be issued by an ADMIN user' });
          return;
        }
        if (approvalPayload.id === userId || approvalPayload.email === userEmail) {
          res.status(403).json({ error: '4-eyes violation: approver must be a different ADMIN than the requester' });
          return;
        }
      }

      try {
        await prisma.pluginRegistry.update({
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
        const full = await prisma.pluginRegistry.findUnique({
          where: { id: plugin.id },
          include: { hooks: true, cronJobs: true, routes: true },
        });
        if (full) pluginRuntime.registerPlugin(full as unknown as RuntimePlugin);

        await pluginAudit(prisma, 'PLUGIN_ACTIVATED', plugin.id, userEmail);

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
        await lifecycleManager.updateStatus(prisma, plugin.id, 'INACTIVE');
        await pluginAudit(prisma, 'PLUGIN_DEACTIVATED', plugin.id, userEmail);

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

        // Delete staging zip
        const stagingDir = path.join(PLUGIN_STORAGE_PATH, 'staging');
        if (fs.existsSync(stagingDir)) {
          const files = fs.readdirSync(stagingDir).filter((f) => f.endsWith('.zip'));
          for (const f of files) {
            try {
              const raw = await extractManifestFromZip(path.join(stagingDir, f));
              const m = PluginManifestSchema.safeParse(raw);
              if (m.success && m.data.id === plugin.pluginId) {
                await fs.promises.unlink(path.join(stagingDir, f));
                break;
              }
            } catch {
              // skip
            }
          }
        }

        // Audit before deleting the record (so the plugin id is still meaningful)
        await pluginAudit(prisma, 'PLUGIN_UNINSTALLED', plugin.id, userEmail, {
          pluginId: plugin.pluginId,
          backupPath,
        });

        // Delete the PluginRegistry record (cascades to hooks, cron, routes, backups)
        await prisma.pluginRegistry.delete({ where: { id: plugin.id } });

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

        await prisma.pluginRegistry.update({
          where: { id: plugin.id },
          data: { config: mergedConfig as any, updatedAt: new Date() },
        });

        await pluginAudit(prisma, 'PLUGIN_CONFIG_UPDATED', plugin.id, userEmail, {
          updatedKeys: Object.keys(parsed.data),
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

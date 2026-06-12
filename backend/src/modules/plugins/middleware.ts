import multer from 'multer';
import path from 'path';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import type { Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { PluginValidator } from './engine.js';

const PLUGIN_STORAGE_PATH = process.env.PLUGIN_STORAGE_PATH ?? '/var/lib/cmdb/plugins';
const PLUGIN_MAX_SIZE_MB = parseInt(process.env.PLUGIN_MAX_SIZE_MB ?? '50', 10);

// ── Upload middleware ─────────────────────────────────────────────────────────

const pluginStorage = multer.diskStorage({
  destination: path.join(PLUGIN_STORAGE_PATH, 'staging'),
  filename: (_req, _file, cb) => cb(null, `${crypto.randomUUID()}.upload`),
});

export const pluginUploadMulter = multer({
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

// ── Rate limiter (per plugin endpoint + IP) ──────────────────────────────────

export const pluginRateLimiter = rateLimit({
  windowMs: 60_000,
  limit: 100,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => {
    const pluginId = (req.params as { id?: string }).id ?? 'global';
    return `${req.ip}-${pluginId}`;
  },
  message: { error: 'Too many plugin requests, slow down.' },
});

// ── requirePluginExists ──────────────────────────────────────────────────────

export function requirePluginExists(prisma: PrismaClient) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const { id } = req.params as { id: string };
    const plugin = await prisma.pluginRegistry.findUnique({ where: { id } });
    if (!plugin) {
      res.status(404).json({ error: 'Plugin not found' });
      return;
    }
    (req as Request & { plugin: typeof plugin }).plugin = plugin;
    next();
  };
}

// ── validateUploadedFile (post-multer magic-bytes check) ────────────────────

export function validateUploadedFile(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!req.file) {
    res.status(400).json({ error: 'No plugin file uploaded' });
    return;
  }
  try {
    PluginValidator.validateUploadedFile(req.file.path, req.file.originalname);
    next();
  } catch (err) {
    res.status(422).json({ error: (err as Error).message });
  }
}

import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import type { Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';

// ── Rate limiter (per plugin endpoint + IP) ──────────────────────────────────

export const pluginRateLimiter = rateLimit({
  windowMs: 60_000,
  limit: 100,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => {
    const pluginId = (req.params as { id?: string }).id ?? 'global';
    // ipKeyGenerator normalises IPv6 to a /64 subnet so v6 clients can't bypass the
    // limit by rotating within their prefix (express-rate-limit ERR_ERL_KEY_GEN_IPV6).
    return `${ipKeyGenerator(req.ip ?? '')}-${pluginId}`;
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

import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import multer, { MulterError } from 'multer';
import { ThemeUpdateSchema } from './schemas.js';
import { settingsAudit } from './audit.js';
import { requireAdmin }     from '../../shared/middleware/requireAdmin.js';
import { createAuthenticateToken } from '../../shared/middleware/authenticate.js';

const logoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 }, // 2 MB
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/png', 'image/jpeg', 'image/webp'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Tipo de imagen no permitido. Use PNG, JPEG o WebP.'));
    }
  },
});

export function createSettingsRouter(prisma: PrismaClient): Router {
  const router = Router();
  const authenticateToken = createAuthenticateToken(prisma);

  // GET /api/settings/theme — public (needed for login page before auth)
  router.get('/theme', async (_req: Request, res: Response) => {
    try {
      const rows = await (prisma as any).appSettings.findMany({
        where: { key: { in: ['sidebar_bg', 'accent_color', 'company_name', 'logo_data'] } },
      }) as { key: string; value: string }[];
      const s = Object.fromEntries(rows.map((r: { key: string; value: string }) => [r.key, r.value]));
      res.json({
        sidebarBg:   s['sidebar_bg']   ?? '#0f172a',
        accentColor: s['accent_color'] ?? '#3b82f6',
        companyName: s['company_name'] ?? 'CMDB Platform',
        hasLogo:     !!(s['logo_data'] && s['logo_data'].length > 0),
      });
    } catch (error) {
      console.error('[GET /api/settings/theme] Error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/settings/logo — public, returns binary image
  router.get('/logo', async (_req: Request, res: Response) => {
    try {
      const rows = await (prisma as any).appSettings.findMany({
        where: { key: { in: ['logo_data', 'logo_mime'] } },
      }) as { key: string; value: string }[];
      const s = Object.fromEntries(rows.map((r: { key: string; value: string }) => [r.key, r.value]));
      if (!s['logo_data'] || s['logo_data'].length === 0) {
        res.status(404).json({ error: 'No logo configured' });
        return;
      }
      const buf = Buffer.from(s['logo_data'], 'base64');
      res.setHeader('Content-Type', s['logo_mime'] || 'image/png');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.send(buf);
    } catch (error) {
      console.error('[GET /api/settings/logo] Error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // PUT /api/settings/theme — ADMIN only
  router.put('/theme', authenticateToken, requireAdmin, async (req: Request, res: Response) => {
    const parsed = ThemeUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() });
      return;
    }
    const { sidebarBg, accentColor, companyName } = parsed.data;
    const updates: { key: string; value: string }[] = [];
    if (sidebarBg)                 updates.push({ key: 'sidebar_bg',   value: sidebarBg });
    if (accentColor)               updates.push({ key: 'accent_color', value: accentColor });
    if (companyName !== undefined)  updates.push({ key: 'company_name', value: companyName });
    if (updates.length === 0) {
      res.status(400).json({ error: 'No fields to update' });
      return;
    }
    try {
      await prisma.$transaction(async (tx) => {
        await Promise.all(
          updates.map((u) =>
            (tx as any).appSettings.upsert({
              where:  { key: u.key },
              update: { value: u.value },
              create: { key: u.key, value: u.value },
            })
          )
        );
        await settingsAudit(tx, 'UPDATE_THEME', 'theme', req.user!.email);
      });
      res.json({ ok: true });
    } catch (error) {
      console.error('[PUT /api/settings/theme] Error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/settings/logo — ADMIN only, multipart/form-data field "logo"
  router.post('/logo', authenticateToken, requireAdmin, logoUpload.single('logo'), async (req: Request, res: Response) => {
    if (!req.file) {
      res.status(400).json({ error: 'No se adjuntó ningún archivo' });
      return;
    }
    const buf = req.file.buffer;
    if (buf.length < 12) {
      res.status(400).json({ error: 'El archivo no es una imagen válida (PNG, JPEG o WebP)' });
      return;
    }
    const isPng  = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
    const isJpeg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    const isWebP = buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
                   buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50;
    if (!isPng && !isJpeg && !isWebP) {
      res.status(400).json({ error: 'El archivo no es una imagen válida (PNG, JPEG o WebP)' });
      return;
    }
    try {
      const b64 = buf.toString('base64');
      await prisma.$transaction(async (tx) => {
        await (tx as any).appSettings.upsert({
          where:  { key: 'logo_data' },
          update: { value: b64 },
          create: { key: 'logo_data', value: b64 },
        });
        await (tx as any).appSettings.upsert({
          where:  { key: 'logo_mime' },
          update: { value: req.file!.mimetype },
          create: { key: 'logo_mime', value: req.file!.mimetype },
        });
        await settingsAudit(tx, 'UPDATE_LOGO', 'logo', req.user!.email);
      });
      res.json({ ok: true });
    } catch (error) {
      console.error('[POST /api/settings/logo] Error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // DELETE /api/settings/logo — ADMIN only
  router.delete('/logo', authenticateToken, requireAdmin, async (req: Request, res: Response) => {
    try {
      await prisma.$transaction(async (tx) => {
        await (tx as any).appSettings.upsert({ where: { key: 'logo_data' }, update: { value: '' }, create: { key: 'logo_data', value: '' } });
        await (tx as any).appSettings.upsert({ where: { key: 'logo_mime' }, update: { value: '' }, create: { key: 'logo_mime', value: '' } });
        await settingsAudit(tx, 'DELETE_LOGO', 'logo', req.user!.email);
      });
      res.json({ ok: true });
    } catch (error) {
      console.error('[DELETE /api/settings/logo] Error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Multer error handler — fileFilter rejections and size-limit errors return 400.
  router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof MulterError || (err instanceof Error && err.message.includes('imagen'))) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }
    console.error('[settings] upload error:', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return router;
}

import { z } from 'zod';

export const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export const ThemeUpdateSchema = z.object({
  sidebarBg:   z.string().regex(HEX_COLOR_RE).optional(),
  accentColor: z.string().regex(HEX_COLOR_RE).optional(),
  companyName: z.string().min(1).max(100).trim().optional(),
});

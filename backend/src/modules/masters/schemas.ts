import { z } from 'zod';

export const LicenseMasterSchema = z.object({
  code:         z.string().min(1),
  name:         z.string().min(1),
  categoryCode: z.string().min(1),
  description:  z.string().optional(),
});

export function isoDateOrNull(v: unknown): Date | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'string') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const d = new Date(`${v}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

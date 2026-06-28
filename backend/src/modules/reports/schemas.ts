import { z } from 'zod';

export const ReportQuerySchema = z.object({
  from:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  page:   z.coerce.number().int().min(1).default(1),
  limit:  z.coerce.number().int().min(1).max(500).default(50),
  sort:   z.string().max(64).optional(),
  dir:    z.enum(['asc', 'desc']).default('asc'),
  search: z.string().max(200).optional(),
}).passthrough(); // allow report-specific filter keys

export const ExportQuerySchema = z.object({
  format: z.enum(['csv', 'xlsx']).default('csv'),
  from:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  search: z.string().max(200).optional(),
}).passthrough();

export const EXPORT_ROW_LIMIT = 50_000;

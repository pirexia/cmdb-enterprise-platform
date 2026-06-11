import { z } from 'zod';

export const OsCreateSchema = z.object({
  code           : z.string().min(1).max(50).toUpperCase().optional(),
  name           : z.string().min(1).max(255),
  version        : z.string().max(100).optional(),
  manufacturerId : z.string().uuid().optional().nullable(),
  isSystem       : z.boolean().optional(),
});

export const OsUpdateSchema = OsCreateSchema.partial();

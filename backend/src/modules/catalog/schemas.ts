import { z } from 'zod';

export const OsCreateSchema = z.object({
  code           : z.string().min(1).max(50).toUpperCase().optional(),
  name           : z.string().min(1).max(255),
  version        : z.string().max(100).optional(),
  manufacturerId : z.string().uuid().optional().nullable(),
  isSystem       : z.boolean().optional(),
});

export const OsUpdateSchema = OsCreateSchema.partial();

export const BswCreateSchema = z.object({
  code           : z.string().min(1).max(50).toUpperCase().optional(),
  name           : z.string().min(1).max(255),
  version        : z.string().max(100).optional(),
  manufacturerId : z.string().uuid().optional().nullable(),
  isSystem       : z.boolean().optional(),
});

export const BswUpdateSchema = BswCreateSchema.partial();

export const CIBswAssociateSchema = z.object({
  baseSoftwareId : z.string().uuid(),
});

// D3: Base Software can only be associated to physical/virtual server CIs.
export const BASE_SOFTWARE_ALLOWED_CI_TYPES = ['PHYSICAL_SERVER', 'VIRTUAL_SERVER', 'CLOUD_INSTANCE'] as const;

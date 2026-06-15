import { z } from 'zod';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = z.string().regex(UUID_RE, 'Invalid UUID');

export const PlanCreateSchema = z.object({
  name       : z.string().min(1).max(255),
  systemCiId : uuid,
});

export const PlanUpdateSchema = z.object({
  name   : z.string().min(1).max(255).optional(),
  status : z.enum(['DRAFT', 'ACTIVE', 'COMPLETED', 'CANCELLED']).optional(),
});

export const PlanCiUpdateSchema = z.object({
  scheduledDate : z.string().datetime({ offset: true }).nullable().optional(),
  notes         : z.string().max(2000).nullable().optional(),
});

export const PlanDocumentAddSchema = z.object({
  documentId : uuid,
});

export const PlanContractAddSchema = z.object({
  contractId : uuid,
});

export const PlanLicenseAddSchema = z.object({
  licenseId : uuid,
});

export type PlanCreate        = z.infer<typeof PlanCreateSchema>;
export type PlanUpdate        = z.infer<typeof PlanUpdateSchema>;
export type PlanCiUpdate      = z.infer<typeof PlanCiUpdateSchema>;

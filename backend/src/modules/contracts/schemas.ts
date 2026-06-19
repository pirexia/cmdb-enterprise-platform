import { z } from 'zod';

export const ContractCreateSchema = z.object({
  contractNumber:    z.string().min(1).max(100),
  startDate:         z.string().min(1),
  endDate:           z.string().optional(),
  vendorId:          z.string().uuid(),
  parentContractId:  z.string().uuid().optional(),
  ciIds:             z.array(z.string().uuid()).optional(),
});

export const ContractUpdateSchema = z.object({
  contractNumber:    z.string().min(1).max(100),
  startDate:         z.string().min(1),
  endDate:           z.string().nullable().optional(),
  vendorId:          z.string().uuid(),
  parentContractId:  z.string().uuid().nullable().optional(),
});

export const CONTRACT_INCLUDE = {
  vendor:         { select: { id: true, name: true } },
  cis:            { select: { id: true, name: true, apiSlug: true, environment: true, criticality: true } },
  parentContract: { select: { id: true, contractNumber: true } },
  addendums:      { select: { id: true, contractNumber: true } },
} as const;

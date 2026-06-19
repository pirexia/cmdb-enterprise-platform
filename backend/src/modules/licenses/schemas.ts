import { z } from 'zod';

export const LicenseSchema = z.object({
  name:             z.string().min(1),
  licenseNumber:    z.string().min(1),
  vendorId:         z.string().uuid().optional().nullable(),
  startDate:        z.string(),
  endDate:          z.string().optional().nullable(),
  licenseTypeId:    z.string().uuid().optional().nullable(),
  licenseMetricId:  z.string().uuid().optional().nullable(),
  metricValue:      z.number().int().positive().optional().nullable(),
  metricUnit:       z.string().optional().nullable(),
  cost:             z.number().positive().optional().nullable(),
  currency:         z.string().default('EUR'),
  status:           z.string().optional(),
  notes:            z.string().optional().nullable(),
  parentLicenseId:  z.string().uuid().optional().nullable(),
});

export const LicenseUserSchema = z.object({
  name:  z.string().min(1),
  dni:   z.string().optional().nullable(),
  email: z.string().email().optional().or(z.literal('')).nullable(),
});

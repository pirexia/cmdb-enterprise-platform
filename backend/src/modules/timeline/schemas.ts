import { z } from 'zod';

const VALID_TYPES = ['ci', 'contract', 'license', 'decommission', 'os', 'software', 'model'] as const;
const VALID_DATE_TYPES = ['eol', 'eos', 'lastCheck', 'end', 'start', 'completed', 'custom'] as const;

// Parses a comma-separated query param into an array of valid enum values.
function csvEnum<T extends string>(valid: readonly T[]) {
  return z
    .string()
    .optional()
    .transform(v =>
      v
        ? (v.split(',').map(s => s.trim()).filter(s => valid.includes(s as T)) as T[])
        : ([...valid] as T[]),
    );
}

export const TimelineItemsQuerySchema = z.object({
  types: csvEnum(VALID_TYPES),
  ciTypeId: z.string().uuid().optional(),
  status: z
    .string()
    .optional()
    .transform(v => (v ? v.split(',').map(s => s.trim()).filter(Boolean) : [])),
  dateTypes: csvEnum(VALID_DATE_TYPES),
  search: z
    .string()
    .max(200)
    .optional()
    .transform(v => (v?.trim() || undefined)),
  limit: z
    .string()
    .optional()
    .transform(v => {
      const n = parseInt(v ?? '500', 10);
      return isNaN(n) || n < 1 ? 500 : Math.min(n, 1000);
    }),
  offset: z
    .string()
    .optional()
    .transform(v => {
      const n = parseInt(v ?? '0', 10);
      return isNaN(n) || n < 0 ? 0 : n;
    }),
});

export type TimelineItemsQuery = z.infer<typeof TimelineItemsQuerySchema>;

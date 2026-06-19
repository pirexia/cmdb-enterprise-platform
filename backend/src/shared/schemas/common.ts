import { z } from 'zod';

export const UuidParamSchema = z.object({
  id: z.string().uuid(),
});

export const PaginationSchema = z.object({
  page:     z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});

export type PaginationParams = z.infer<typeof PaginationSchema>;

export function parsePagination(query: Record<string, unknown>): PaginationParams {
  const result = PaginationSchema.safeParse(query);
  return result.success ? result.data : { page: 1, pageSize: 25 };
}

export function paginationMeta(total: number, page: number, pageSize: number) {
  return { total, page, pageSize, totalPages: Math.ceil(total / pageSize) };
}

import type { Prisma } from '@prisma/client';

/**
 * Normalise a query-string filter value into a string[] (or undefined).
 *
 * Express/`qs` parses `?status=A` as the string `'A'` but `?status=A&status=B`
 * as `['A','B']`. A multi-select with a single selection therefore arrives as a
 * bare string, and `{ in: 'A' }` throws in Prisma (P2 root cause). This coerces
 * both shapes to an array so `{ in: asArray(v) }` is always valid.
 */
export function asArray(value: unknown): string[] | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const arr = Array.isArray(value) ? value : [value];
  const cleaned = arr.map((v) => String(v)).filter((v) => v.length > 0);
  return cleaned.length ? cleaned : undefined;
}

/** Escape LIKE/ILIKE wildcards before interpolation in a `contains` clause. */
export function escapeLike(value: string): string {
  return value.replace(/[%_\\]/g, (c) => `\\${c}`);
}

/**
 * Build a safe Prisma `orderBy` from a caller-supplied `sort` key.
 *
 * `orderBy: { [filters.sort]: dir }` throws a 500 when `sort` is a relation
 * column (e.g. `ciType`, `location`) since those are not scalar fields (P2).
 * Each report passes an allowlist mapping the public sort key to either a scalar
 * field name or a builder that returns a nested relation orderBy. Unknown keys
 * fall back to `fallback`.
 */
export function resolveOrderBy<T>(
  sort: string | undefined,
  dir: 'asc' | 'desc',
  allow: Record<string, string | ((d: 'asc' | 'desc') => T)>,
  fallback: T,
): T {
  if (!sort) return fallback;
  const entry = allow[sort];
  if (entry === undefined) return fallback;
  if (typeof entry === 'function') return entry(dir);
  return { [entry]: dir } as unknown as T;
}

/** Convenience: normalise the global `dir` value to a Prisma sort order. */
export function sortDir(dir: unknown): Prisma.SortOrder {
  return dir === 'desc' ? 'desc' : 'asc';
}

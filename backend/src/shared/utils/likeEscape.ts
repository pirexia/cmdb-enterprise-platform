/** Escapes %, _ and \ for use in a LIKE/ILIKE pattern (A03 — SQL Injection). */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, '\\$&');
}

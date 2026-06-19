/** Returns the visibility column name for a given role (allowlisted — safe with Prisma.raw). */
export function docVisibilitySqlCol(role: string): string {
  if (role === 'ADMIN')   return 'read_admin';
  if (role === 'AUDITOR') return 'read_auditor';
  return 'read_viewer';
}

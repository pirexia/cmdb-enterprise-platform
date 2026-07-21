import { Prisma } from '@prisma/client';

// Issue #172 (ISO 27001 A.8.15): takes a Prisma.TransactionClient (the base
// PrismaClient is also assignable to it) so callers run the business mutation
// and this audit insert inside a single `prisma.$transaction(async (tx) => {
// ... })`. That makes the write and its audit record atomic — either both
// commit or both roll back. Always pass the `tx` client from inside the
// transaction alongside the mutation, never the base client afterwards.
export async function pluginAudit(
  prisma: Prisma.TransactionClient,
  action: string,
  pluginId: string,
  userEmail: string,
  details?: object,
): Promise<void> {
  const det = details ? JSON.stringify(details) : null;
  await prisma.$executeRaw`
    INSERT INTO audit_logs (id, action, entity, entity_id, user_email, details, created_at)
    VALUES (gen_random_uuid(), ${action}, 'PLUGIN', ${pluginId}, ${userEmail},
            ${det}::jsonb, now())
  `;
}

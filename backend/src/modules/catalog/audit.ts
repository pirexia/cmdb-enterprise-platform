import { Prisma } from '@prisma/client';

// Emit a Catalog audit log record (insert-only — ISO 27001 A.8.15).
//
// Takes a Prisma.TransactionClient (the base PrismaClient is also assignable
// to it), so the caller runs the business mutation and this audit insert
// inside a single `prisma.$transaction(async (tx) => { ... })`. That makes the
// write and its audit record atomic: either both commit or both roll back,
// closing the "unlogged write" gap of issue #172 (a mutation that persists
// while its audit insert fails). Always pass the `tx` client from inside the
// transaction, alongside the mutation — never the base client afterwards.
export async function catalogAudit(
  prisma    : Prisma.TransactionClient,
  action    : string,
  entity    : string,
  entityId  : string,
  userEmail : string,
): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO "audit_logs"(id, action, entity, entity_id, user_email, created_at)
    VALUES (gen_random_uuid(), ${action}, ${entity}, ${entityId}::uuid, ${userEmail}, now())
  `;
}

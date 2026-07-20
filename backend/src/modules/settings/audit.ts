import { Prisma } from '@prisma/client';

// entity_id for AppSettings is a plain string key ('theme', 'logo'), not a UUID.
// audit_logs.entity_id is VarChar(36) — accepts both UUIDs and short strings.
//
// Takes a Prisma.TransactionClient (the base PrismaClient is also assignable
// to it) so the caller runs the settings mutation and this audit insert
// inside a single `prisma.$transaction(async (tx) => { ... })` — atomic write
// + audit, closing the "unlogged write" gap of issue #172. Always pass the
// `tx` client from inside the transaction, never the base client afterwards.
export async function settingsAudit(
  prisma:    Prisma.TransactionClient,
  action:    string,
  entityKey: string,
  userEmail: string,
): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO "audit_logs"(id, action, entity, entity_id, user_email, created_at)
    VALUES (gen_random_uuid(), ${action}, 'AppSettings', ${entityKey}, ${userEmail}, now())
  `;
}

import type { Prisma } from '@prisma/client';

type AlertAuditAction =
  | 'UPDATE_ALERT_CONFIG'
  | 'UPDATE_ALERT_RULE'
  | 'ALERT_TEST_SEND'
  | 'ALERT_RUN_NOW'
  | 'ALERT_CRON_RUN';

// Takes a Prisma.TransactionClient (the base PrismaClient is also assignable
// to it), so callers run the business mutation and this audit insert inside a
// single `prisma.$transaction(async (tx) => { ... })`. That makes the write
// and its audit record atomic — closing the "unlogged write" gap of issue
// #172 (a mutation that persists while its audit insert fails). Always pass
// the `tx` client from inside the transaction, alongside the mutation.
export async function insertAlertAudit(
  prisma:    Prisma.TransactionClient,
  action:    AlertAuditAction,
  userEmail: string,
  entityId:  string,
): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO "audit_logs" (id, action, entity, entity_id, user_email, created_at)
    VALUES (gen_random_uuid(), ${action}, 'AlertConfig', ${entityId}, ${userEmail}, now())
  `;
}

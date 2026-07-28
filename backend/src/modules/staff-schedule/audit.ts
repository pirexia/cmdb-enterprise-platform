import { Prisma } from '@prisma/client';

export type StaffScheduleEntity =
  | 'DEPARTMENT'
  | 'STAFF_SCHEDULE'
  | 'SCHEDULE_ENTRY'
  | 'DEPARTMENT_MANAGER'
  // v3.5.12 (R7/D7) — the entity a PRINT_STAFF_SCHEDULE record refers to
  // depends on the print scope: a department id for DEPARTMENT_WEEK/MONTH, a
  // user id for WORKER. Neither DEPARTMENT nor STAFF_SCHEDULE fits both, so
  // this is a dedicated tag rather than overloading an existing one.
  | 'PRINT_TARGET';

// v3.5.12 (R7/D7) — action emitted by POST /audit/print. `action` itself
// stays a free string (matching every other action in this module — see the
// literals in router.ts), this constant just documents the one this file
// adds so it isn't only discoverable by grepping router.ts.
export const PRINT_STAFF_SCHEDULE_ACTION = 'PRINT_STAFF_SCHEDULE';

// Emit a Staff Schedule audit log record (insert-only — ISO 27001 A.8.15).
//
// Takes a Prisma.TransactionClient (the base PrismaClient is also assignable
// to it), so the caller runs the business mutation and this audit insert
// inside a single `prisma.$transaction(async (tx) => { ... })`. That makes the
// write and its audit record atomic: either both commit or both roll back,
// closing the "unlogged write" gap of issue #172 (a mutation that persists
// while its audit insert fails). Always pass the `tx` client from inside the
// transaction, alongside the mutation — never the base client afterwards.
//
// No PII in the record itself: only userEmail (the audited-field convention
// used across the repo), entity, and entityId (UUID) are stored.
export async function auditStaffSchedule(
  db: Prisma.TransactionClient,
  params: {
    action: string;
    entity: StaffScheduleEntity;
    entityId: string;
    userEmail: string;
  },
): Promise<void> {
  const { action, entity, entityId, userEmail } = params;
  await db.$executeRaw`
    INSERT INTO "audit_logs"(id, action, entity, entity_id, user_email, created_at)
    VALUES (gen_random_uuid(), ${action}, ${entity}, ${entityId}::uuid, ${userEmail}, now())
  `;
}

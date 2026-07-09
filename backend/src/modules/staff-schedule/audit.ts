import { PrismaClient } from '@prisma/client';

export type StaffScheduleEntity =
  | 'DEPARTMENT'
  | 'STAFF_SCHEDULE'
  | 'SCHEDULE_ENTRY'
  | 'DEPARTMENT_MANAGER';

// Emit a Staff Schedule audit log record (insert-only — ISO 27001 A.8.15).
// No PII in the log message itself: only userEmail (already an audited field
// pattern elsewhere in the repo), entity, and entityId (UUID) are recorded.
export async function auditStaffSchedule(
  prisma: PrismaClient,
  params: {
    action: string;
    entity: StaffScheduleEntity;
    entityId: string;
    userEmail: string;
  },
): Promise<void> {
  const { action, entity, entityId, userEmail } = params;
  await prisma.$executeRaw`
    INSERT INTO "audit_logs"(id, action, entity, entity_id, user_email, created_at)
    VALUES (gen_random_uuid(), ${action}, ${entity}, ${entityId}::uuid, ${userEmail}, now())
  `;
}

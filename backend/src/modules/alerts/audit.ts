import type { PrismaClient } from '@prisma/client';

type AlertAuditAction =
  | 'UPDATE_ALERT_CONFIG'
  | 'UPDATE_ALERT_RULE'
  | 'ALERT_TEST_SEND'
  | 'ALERT_RUN_NOW'
  | 'ALERT_CRON_RUN';

export async function insertAlertAudit(
  prisma:    PrismaClient,
  action:    AlertAuditAction,
  userEmail: string,
  entityId:  string,
): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO "audit_logs" (id, action, entity, entity_id, user_email, created_at)
    VALUES (gen_random_uuid(), ${action}, 'AlertConfig', ${entityId}, ${userEmail}, now())
  `;
}

import { PrismaClient } from '@prisma/client';

// entity_id for AppSettings is a plain string key ('theme', 'logo'), not a UUID.
// audit_logs.entity_id is VarChar(36) — accepts both UUIDs and short strings.
export async function settingsAudit(
  prisma:    PrismaClient,
  action:    string,
  entityKey: string,
  userEmail: string,
): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO "audit_logs"(id, action, entity, entity_id, user_email, created_at)
    VALUES (gen_random_uuid(), ${action}, 'AppSettings', ${entityKey}, ${userEmail}, now())
  `;
}

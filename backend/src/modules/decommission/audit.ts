import { PrismaClient } from '@prisma/client';

export async function decommissionAudit(
  prisma    : PrismaClient,
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

import { PrismaClient } from '@prisma/client';

export async function pluginAudit(
  prisma: PrismaClient,
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

import { PrismaClient } from '@prisma/client';

/**
 * Insert-only audit log record (ISO 27001 A.8.15 — immutable log).
 * Pass details as a JSON-serialisable object for structured audit trails.
 */
export async function auditLog(
  prisma:    PrismaClient,
  action:    string,
  entity:    string,
  entityId:  string,
  userEmail: string,
  details?:  object,
): Promise<void> {
  if (details !== undefined) {
    const detailsJson = JSON.stringify(details);
    await prisma.$executeRaw`
      INSERT INTO "audit_logs"(id, action, entity, entity_id, user_email, details, created_at)
      VALUES (gen_random_uuid(), ${action}, ${entity}, ${entityId}::uuid, ${userEmail}, ${detailsJson}::jsonb, now())
    `;
  } else {
    await prisma.$executeRaw`
      INSERT INTO "audit_logs"(id, action, entity, entity_id, user_email, created_at)
      VALUES (gen_random_uuid(), ${action}, ${entity}, ${entityId}::uuid, ${userEmail}, now())
    `;
  }
}

/**
 * Builds a structured JSON payload for AuditLog.details.
 * description — human-readable summary (no PII).
 * changes    — list of {field, old, new} for UPDATE events (use IDs not emails).
 */
export function buildAuditDetails(
  description: string,
  changes?: Array<{ field: string; old: unknown; new: unknown }>,
): object {
  return { description, ...(changes?.length ? { changes } : {}) };
}

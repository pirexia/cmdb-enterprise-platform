import { PrismaClient } from '@prisma/client';

const MAX_DEPTH = 8;

// ── Types ──────────────────────────────────────────────────────────────────────

export interface PlanRow {
  id: string; name: string; system_ci_id: string; status: string;
  created_by: string; created_at: Date; updated_at: Date; completed_at: Date | null;
  system_ci_name?: string;
}

export interface PlanCiRow {
  id: string; plan_id: string; ci_id: string; ci_name: string;
  ci_type_name: string | null; parent_ci_id: string | null;
  depth: number; is_shared: boolean;
  scheduled_date: Date | null; notes: string | null; sort_order: number;
}

export interface DocRow {
  id: string; plan_id: string; document_id: string; source: string;
  doc_name: string; doc_type: string | null;
}

export interface ContractRow {
  id: string; plan_id: string; contract_id: string; source: string;
  contract_name: string; contract_ref: string | null;
}

export interface LicenseRow {
  id: string; plan_id: string; license_id: string; source: string;
  license_name: string;
}

export interface SystemCiRow { id: string; name: string; }

// ── List & CRUD ────────────────────────────────────────────────────────────────

export async function listPlans(prisma: PrismaClient): Promise<PlanRow[]> {
  return prisma.$queryRaw<PlanRow[]>`
    SELECT p.*, ci.name AS system_ci_name
    FROM   "decommission_plan" p
    JOIN   "configuration_items" ci ON ci.id = p.system_ci_id
    ORDER  BY p.created_at DESC
  `;
}

// Search CIs of type SISTEMA for the plan-creation combobox. Empty search
// returns the first `limit` systems (focus-load). LIKE wildcards in the user
// term are escaped so they are matched literally (A03 — injection-safe).
export async function searchSystemCis(
  prisma: PrismaClient,
  search: string,
  limit : number,
): Promise<SystemCiRow[]> {
  const escaped = search.replace(/[\\%_]/g, (c) => `\\${c}`);
  const pattern = `%${escaped}%`;
  return prisma.$queryRaw<SystemCiRow[]>`
    SELECT ci.id, ci.name
    FROM   "configuration_items" ci
    JOIN   "ci_types" t ON t.id = ci.ci_type_id
    WHERE  t.code = 'SISTEMA'
      AND  ci.name ILIKE ${pattern} ESCAPE '\\'
    ORDER  BY ci.name ASC
    LIMIT  ${limit}
  `;
}

export async function getPlan(prisma: PrismaClient, id: string): Promise<PlanRow | null> {
  const rows = await prisma.$queryRaw<PlanRow[]>`
    SELECT p.*, ci.name AS system_ci_name
    FROM   "decommission_plan" p
    JOIN   "configuration_items" ci ON ci.id = p.system_ci_id
    WHERE  p.id = ${id}::uuid
    LIMIT  1
  `;
  return rows[0] ?? null;
}

export async function createPlan(
  prisma    : PrismaClient,
  name      : string,
  systemCiId: string,
  createdBy : string,
): Promise<PlanRow> {
  const rows = await prisma.$queryRaw<PlanRow[]>`
    INSERT INTO "decommission_plan"("name", "system_ci_id", "status", "created_by")
    VALUES (${name}, ${systemCiId}::uuid, 'DRAFT', ${createdBy})
    RETURNING *
  `;
  return rows[0];
}

export async function updatePlan(
  prisma  : PrismaClient,
  id      : string,
  name?   : string,
  status? : string,
): Promise<PlanRow> {
  const completedAt = status === 'COMPLETED' ? 'now()' : null;
  const rows = await prisma.$queryRaw<PlanRow[]>`
    UPDATE "decommission_plan"
    SET
      "name"         = COALESCE(${name ?? null}, "name"),
      "status"       = COALESCE(${status ?? null}, "status"),
      "completed_at" = CASE WHEN ${status ?? null} = 'COMPLETED' THEN now() ELSE "completed_at" END,
      "updated_at"   = now()
    WHERE id = ${id}::uuid
    RETURNING *
  `;
  return rows[0];
}

export async function deletePlan(prisma: PrismaClient, id: string): Promise<void> {
  await prisma.$executeRaw`DELETE FROM "decommission_plan" WHERE id = ${id}::uuid`;
}

// ── Generate inventory via recursive CTE ──────────────────────────────────────

interface TraversalRow {
  ci_id      : string;
  ci_name    : string;
  type_name  : string | null;
  depth      : number;
  parent_id  : string | null;
}

interface DecommDateRow {
  ci_id      : string;
  date_value : Date;
}

interface SystemaCIRow {
  id        : string;
  type_code : string | null;
}

interface SharedCheckRow {
  ci_id     : string;
}

export async function generateInventory(
  prisma    : PrismaClient,
  planId    : string,
  systemCiId: string,
  systemDate: Date,
): Promise<void> {
  // 1. Traverse relations recursively up to MAX_DEPTH hops
  const traversal = await prisma.$queryRaw<TraversalRow[]>`
    WITH RECURSIVE traversal AS (
      -- Base: direct neighbours of the system CI
      SELECT
        CASE WHEN r.source_ci_id = ${systemCiId}::uuid
             THEN r.target_ci_id ELSE r.source_ci_id END  AS ci_id,
        1::int                                              AS depth,
        ${systemCiId}::uuid                                AS parent_id,
        ARRAY[${systemCiId}::uuid]                         AS visited
      FROM "ci_relations" r
      WHERE r.source_ci_id = ${systemCiId}::uuid
         OR r.target_ci_id = ${systemCiId}::uuid

      UNION ALL

      SELECT
        CASE WHEN r.source_ci_id = prev.ci_id
             THEN r.target_ci_id ELSE r.source_ci_id END,
        prev.depth + 1,
        prev.ci_id,
        prev.visited || prev.ci_id
      FROM "ci_relations" r
      JOIN traversal prev ON (r.source_ci_id = prev.ci_id OR r.target_ci_id = prev.ci_id)
      WHERE prev.depth < ${MAX_DEPTH}
        AND NOT (CASE WHEN r.source_ci_id = prev.ci_id
                      THEN r.target_ci_id ELSE r.source_ci_id END = ANY(prev.visited))
    )
    SELECT DISTINCT ON (t.ci_id)
      t.ci_id,
      ci.name        AS ci_name,
      cit.name       AS type_name,
      t.depth,
      t.parent_id
    FROM traversal t
    JOIN "configuration_items" ci ON ci.id = t.ci_id
    LEFT JOIN "ci_types" cit      ON cit.id = ci.ci_type_id
    ORDER BY t.ci_id, t.depth ASC
  `;

  if (traversal.length === 0) return;

  const ciIds = traversal.map(r => r.ci_id);

  // 2. Find which CIs are shared (related to another Sistema CI)
  const sharedRows = await prisma.$queryRaw<SharedCheckRow[]>`
    SELECT DISTINCT
      CASE WHEN r.source_ci_id = ANY(${ciIds}::uuid[])
           THEN r.source_ci_id ELSE r.target_ci_id END AS ci_id
    FROM "ci_relations" r
    JOIN "configuration_items" other
      ON other.id = CASE WHEN r.source_ci_id = ANY(${ciIds}::uuid[])
                         THEN r.target_ci_id ELSE r.source_ci_id END
    JOIN "ci_types" t ON t.id = other.ci_type_id
    WHERE t.code = 'SISTEMA'
      AND other.id != ${systemCiId}::uuid
      AND (r.source_ci_id = ANY(${ciIds}::uuid[]) OR r.target_ci_id = ANY(${ciIds}::uuid[]))
  `;
  const sharedSet = new Set(sharedRows.map(r => r.ci_id));

  // 3. Insert the system CI itself at depth 0
  await prisma.$executeRaw`
    INSERT INTO "decommission_plan_ci"
      ("plan_id","ci_id","parent_ci_id","depth","is_shared","scheduled_date","sort_order")
    VALUES
      (${planId}::uuid, ${systemCiId}::uuid, NULL, 0, false, ${systemDate}, 0)
    ON CONFLICT ("plan_id","ci_id") DO NOTHING
  `;

  // 4. Insert discovered CIs
  let sortOrder = 1;
  for (const row of traversal) {
    const isShared = sharedSet.has(row.ci_id);
    await prisma.$executeRaw`
      INSERT INTO "decommission_plan_ci"
        ("plan_id","ci_id","parent_ci_id","depth","is_shared","scheduled_date","sort_order")
      VALUES
        (${planId}::uuid, ${row.ci_id}::uuid,
         ${row.parent_id ?? null}${row.parent_id ? '::uuid' : ''}::uuid,
         ${row.depth}, ${isShared}, ${systemDate}, ${sortOrder})
      ON CONFLICT ("plan_id","ci_id") DO NOTHING
    `;
    sortOrder++;
  }

  // 5. Auto-inherit documents from all CIs in the plan
  await prisma.$executeRaw`
    INSERT INTO "decommission_plan_document"("plan_id","document_id","source")
    SELECT DISTINCT ${planId}::uuid, dci.document_id, 'AUTO'
    FROM "document_ci" dci
    JOIN "decommission_plan_ci" dpc ON dpc.ci_id = dci.ci_id AND dpc.plan_id = ${planId}::uuid
    ON CONFLICT ("plan_id","document_id") DO NOTHING
  `;

  // 6. Auto-inherit contracts
  await prisma.$executeRaw`
    INSERT INTO "decommission_plan_contract"("plan_id","contract_id","source")
    SELECT DISTINCT ${planId}::uuid, cc.contract_id, 'AUTO'
    FROM "_CIToContract" cc
    JOIN "decommission_plan_ci" dpc ON dpc.ci_id = cc."A" AND dpc.plan_id = ${planId}::uuid
    ON CONFLICT ("plan_id","contract_id") DO NOTHING
  `;

  // 7. Auto-inherit licenses
  await prisma.$executeRaw`
    INSERT INTO "decommission_plan_license"("plan_id","license_id","source")
    SELECT DISTINCT ${planId}::uuid, lc.license_id, 'AUTO'
    FROM "_LicenseToCI" lc
    JOIN "decommission_plan_ci" dpc ON dpc.ci_id = lc."B" AND dpc.plan_id = ${planId}::uuid
    ON CONFLICT ("plan_id","license_id") DO NOTHING
  `;
}

// ── Plan CIs ──────────────────────────────────────────────────────────────────

export async function listPlanCis(prisma: PrismaClient, planId: string): Promise<PlanCiRow[]> {
  return prisma.$queryRaw<PlanCiRow[]>`
    SELECT
      dpc.id, dpc.plan_id, dpc.ci_id, ci.name AS ci_name,
      cit.name AS ci_type_name, dpc.parent_ci_id,
      dpc.depth, dpc.is_shared, dpc.scheduled_date, dpc.notes, dpc.sort_order
    FROM "decommission_plan_ci" dpc
    JOIN "configuration_items" ci ON ci.id = dpc.ci_id
    LEFT JOIN "ci_types" cit ON cit.id = ci.ci_type_id
    WHERE dpc.plan_id = ${planId}::uuid
    ORDER BY dpc.sort_order ASC, dpc.depth ASC
  `;
}

export async function updatePlanCi(
  prisma      : PrismaClient,
  planId      : string,
  ciId        : string,
  scheduledDate?: string | null,
  notes?      : string | null,
): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "decommission_plan_ci"
    SET
      "scheduled_date" = COALESCE(${scheduledDate ? new Date(scheduledDate) : null}, "scheduled_date"),
      "notes"          = COALESCE(${notes ?? null}, "notes")
    WHERE "plan_id" = ${planId}::uuid AND "ci_id" = ${ciId}::uuid
  `;
}

// ── Documents ─────────────────────────────────────────────────────────────────

export async function listPlanDocuments(prisma: PrismaClient, planId: string): Promise<DocRow[]> {
  return prisma.$queryRaw<DocRow[]>`
    SELECT dpd.id, dpd.plan_id, dpd.document_id, dpd.source,
           d.name AS doc_name, d.type AS doc_type
    FROM "decommission_plan_document" dpd
    JOIN "documents" d ON d.id = dpd.document_id
    WHERE dpd.plan_id = ${planId}::uuid
    ORDER BY dpd.source DESC, d.name
  `;
}

export async function addPlanDocument(prisma: PrismaClient, planId: string, documentId: string): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO "decommission_plan_document"("plan_id","document_id","source")
    VALUES (${planId}::uuid, ${documentId}::uuid, 'MANUAL')
    ON CONFLICT ("plan_id","document_id") DO NOTHING
  `;
}

export async function removePlanDocument(prisma: PrismaClient, planId: string, documentId: string): Promise<void> {
  await prisma.$executeRaw`
    DELETE FROM "decommission_plan_document"
    WHERE "plan_id" = ${planId}::uuid AND "document_id" = ${documentId}::uuid
  `;
}

// ── Contracts ─────────────────────────────────────────────────────────────────

export async function listPlanContracts(prisma: PrismaClient, planId: string): Promise<ContractRow[]> {
  return prisma.$queryRaw<ContractRow[]>`
    SELECT dpc.id, dpc.plan_id, dpc.contract_id, dpc.source,
           c.name AS contract_name, c.contract_ref
    FROM "decommission_plan_contract" dpc
    JOIN "contracts" c ON c.id = dpc.contract_id
    WHERE dpc.plan_id = ${planId}::uuid
    ORDER BY dpc.source DESC, c.name
  `;
}

export async function addPlanContract(prisma: PrismaClient, planId: string, contractId: string): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO "decommission_plan_contract"("plan_id","contract_id","source")
    VALUES (${planId}::uuid, ${contractId}::uuid, 'MANUAL')
    ON CONFLICT ("plan_id","contract_id") DO NOTHING
  `;
}

export async function removePlanContract(prisma: PrismaClient, planId: string, contractId: string): Promise<void> {
  await prisma.$executeRaw`
    DELETE FROM "decommission_plan_contract"
    WHERE "plan_id" = ${planId}::uuid AND "contract_id" = ${contractId}::uuid
  `;
}

// ── Licenses ──────────────────────────────────────────────────────────────────

export async function listPlanLicenses(prisma: PrismaClient, planId: string): Promise<LicenseRow[]> {
  return prisma.$queryRaw<LicenseRow[]>`
    SELECT dpl.id, dpl.plan_id, dpl.license_id, dpl.source,
           l.name AS license_name
    FROM "decommission_plan_license" dpl
    JOIN "licenses" l ON l.id = dpl.license_id
    WHERE dpl.plan_id = ${planId}::uuid
    ORDER BY dpl.source DESC, l.name
  `;
}

export async function addPlanLicense(prisma: PrismaClient, planId: string, licenseId: string): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO "decommission_plan_license"("plan_id","license_id","source")
    VALUES (${planId}::uuid, ${licenseId}::uuid, 'MANUAL')
    ON CONFLICT ("plan_id","license_id") DO NOTHING
  `;
}

export async function removePlanLicense(prisma: PrismaClient, planId: string, licenseId: string): Promise<void> {
  await prisma.$executeRaw`
    DELETE FROM "decommission_plan_license"
    WHERE "plan_id" = ${planId}::uuid AND "license_id" = ${licenseId}::uuid
  `;
}

// ── Gantt data ─────────────────────────────────────────────────────────────────

export interface GanttTask {
  ci_id: string; ci_name: string; depth: number;
  scheduled_date: Date | null; is_shared: boolean;
  parent_ci_id: string | null;
}

export async function getGanttData(prisma: PrismaClient, planId: string): Promise<GanttTask[]> {
  return prisma.$queryRaw<GanttTask[]>`
    SELECT dpc.ci_id, ci.name AS ci_name, dpc.depth,
           dpc.scheduled_date, dpc.is_shared, dpc.parent_ci_id
    FROM "decommission_plan_ci" dpc
    JOIN "configuration_items" ci ON ci.id = dpc.ci_id
    WHERE dpc.plan_id = ${planId}::uuid
    ORDER BY dpc.sort_order ASC
  `;
}

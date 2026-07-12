// vCenter sync orchestration: discovers VMs via an IHypervisorConnector, maps them
// with VCenterMapper.toCI(), and reconciles against CI rows.
//
// D2: status is NEVER derived from powerState. New CIs are created with status:
// 'ACTIVO' (baked into VCenterMapper.toCI()'s createFields.status); on UPDATE this
// service never touches `status` at all; the only place `status` is ever written
// post-creation is the "retire" step below, and only to 'RETIRADO'.
// D5: on UPDATE, only vCpus/ram/adminIp/hostName/clusterName/powerState (and,
// best-effort, operatingSystemId) are touched — never criticality/environment/
// businessOwnerId/technicalLeadId/hypervisorId/etc. hypervisorId is set ONLY on
// CREATE (classification, once assigned, is never re-touched by sync).
// H1 exception to D5: when no CI matches this connector's canonical apiSlug, an
// unambiguous (exactly one) name-match against an UNCLASSIFIED (hypervisorId IS NULL)
// CI is "adopted" — apiSlug and hypervisorId are set once, so every future sync then
// matches it directly by apiSlug and this adoption branch never runs again for it.
// D4: no sync_logs table — sync-run history goes to audit_logs with
// action='SYNC_VCENTER', entity='SYSTEM', entity_id=<fixed nil UUID>.

import { PrismaClient } from '@prisma/client';
import { toCI } from './connectors/vcenter/VCenterMapper.js';
import { VCenterClient } from './connectors/vcenter/VCenterClient.js';
import { VCenterConnector } from './connectors/vcenter/VCenterConnector.js';
import type { VCenterConfig } from './vcenterConfig.js';
import type { IHypervisorConnector, SyncDefaults, SyncResult } from './connectors/types.js';

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

// This connector only ever syncs VMware vCenter — 'VMWARE' is fixed, not configurable.
// A future OLVM/Solaris connector would resolve its OWN hypervisor code the same way,
// via its own hypervisorId equality check, never this constant.
const VMWARE_HYPERVISOR_CODE = 'VMWARE';

export class SyncLockedError extends Error {}

// Module-level lock: only one vCenter sync (manual or scheduled) may run at a time,
// process-wide. Simple boolean is sufficient — this backend runs as a single process
// per container and there is no cross-instance coordination requirement here.
let syncInProgress = false;

export function isSyncLocked(): boolean {
  return syncInProgress;
}

export interface RunVCenterSyncDeps {
  prisma: PrismaClient;
  connector: IHypervisorConnector; // production code injects a real VCenterConnector; tests inject a fake
  defaults: SyncDefaults;
  queueForIndexing: (entityType: string, entityId: string) => void | Promise<void>;
  userEmail: string; // for audit_logs.user_email
}

/** Builds a real VCenterConnector wired to a VCenterClient from loaded config. */
export function buildVCenterConnector(cfg: VCenterConfig): VCenterConnector {
  const client = new VCenterClient({
    url: cfg.url,
    username: cfg.username,
    password: cfg.password,
    rejectUnauthorized: cfg.sslVerify,
    caCertPath: cfg.caCertPath,
  });
  return new VCenterConnector(client, {
    ciTypeCode: cfg.ciTypeCode,
    environment: cfg.defaultEnvironment,
    criticality: cfg.defaultCriticality,
  });
}

export async function runVCenterSync(deps: RunVCenterSyncDeps): Promise<SyncResult> {
  if (syncInProgress) throw new SyncLockedError('vCenter sync already in progress');
  syncInProgress = true;
  const startedAt = Date.now();
  let created = 0;
  let updated = 0;
  let retired = 0;
  let errors = 0;
  const errorDetails: Array<{ moref?: string; message: string }> = [];
  const seenSlugs = new Set<string>();

  try {
    const vmwareHypervisor = await deps.prisma.hypervisor.findUnique({
      where: { code: VMWARE_HYPERVISOR_CODE },
    });
    if (!vmwareHypervisor) {
      throw new Error(
        `Hypervisor "${VMWARE_HYPERVISOR_CODE}" not found — was the hypervisor_master migration applied?`,
      );
    }

    await deps.connector.connect();
    const vms = await deps.connector.discover();

    for (const vm of vms) {
      try {
        const mapped = toCI(vm, deps.defaults);
        seenSlugs.add(mapped.createFields.apiSlug);

        // OS resolution: best-effort upsert-by-code, never overwrite an existing OS's fields
        let operatingSystemId: string | null = null;
        if (mapped.osHint) {
          const existingOs = await deps.prisma.operatingSystem.findUnique({
            where: { code: mapped.osHint.code },
          });
          operatingSystemId = existingOs
            ? existingOs.id
            : (
                await deps.prisma.operatingSystem.create({
                  data: { code: mapped.osHint.code, name: mapped.osHint.name, isSystem: false },
                })
              ).id;
        }

        let existingCi = await deps.prisma.cI.findUnique({
          where: { apiSlug: mapped.createFields.apiSlug },
          select: { id: true },
        });

        // H1: no CI owns this connector's canonical apiSlug yet. Before creating a brand
        // new CI, check whether an existing, UNCLASSIFIED CI (entered manually before this
        // connector existed — this CMDB has 208 such pre-existing VIRTUAL_SERVER CIs)
        // represents the same real VM, by exact case-insensitive name match. Adopt ONLY on
        // an unambiguous match (exactly one candidate) — 0 or 2+ candidates fall through to
        // create-new, never guess which record to merge into.
        // hypervisorId: null is the safety fence (same property Task G4 tests for the
        // retire path): a CI already classified by ANY hypervisor — this one or a future
        // OLVM/Solaris connector's — must never be silently reclassified here.
        let adopted = false;
        if (!existingCi) {
          const candidates = await deps.prisma.cI.findMany({
            where: {
              ciTypeDef: { code: mapped.createFields.ciTypeCode },
              hypervisorId: null,
              status: { not: 'RETIRADO' },
              name: { equals: mapped.createFields.name, mode: 'insensitive' },
            },
            select: { id: true },
          });
          if (candidates.length === 1) {
            existingCi = candidates[0];
            adopted = true;
          }
        }

        if (existingCi) {
          await deps.prisma.cI.update({
            where: { id: existingCi.id },
            data: {
              vCpus: mapped.physicalFields.vCpus,
              ram: mapped.physicalFields.ram,
              adminIp: mapped.physicalFields.adminIp,
              hostName: mapped.physicalFields.hostName,
              // clusterName is currently always null from the connector (esxiHost/cluster
              // gap — see docs/INTEGRATIONS.md §"Open risks"); only write it when the
              // connector actually resolves a value, so a null here never wipes out
              // whatever an operator may have set manually.
              ...(mapped.physicalFields.clusterName ? { clusterName: mapped.physicalFields.clusterName } : {}),
              powerState: mapped.physicalFields.powerState,
              ...(operatingSystemId ? { operatingSystemId } : {}),
              // H1 adoption: the ONE-TIME exception to "hypervisorId is create-only" (D5) —
              // this is the moment a pre-existing, never-classified CI is first recognized
              // as vCenter-owned. apiSlug is fixed to the canonical `vm-{moref}` slug too,
              // so every future sync matches this CI directly and this branch never
              // re-executes for it again.
              ...(adopted
                ? { apiSlug: mapped.createFields.apiSlug, hypervisorId: vmwareHypervisor.id }
                : {}),
            },
          });
          await insertAuditRow(deps.prisma, 'CI_UPDATE', existingCi.id, deps.userEmail, {
            source: 'vcenter',
            moref: vm.moref,
            ...(adopted ? { adopted: true, matchedBy: 'name' } : {}),
          });
          void deps.queueForIndexing('ci', existingCi.id);
          updated++;
        } else {
          const ciType = await deps.prisma.cIType.findUnique({
            where: { code: mapped.createFields.ciTypeCode },
          });
          if (!ciType) throw new Error(`CIType not found for code "${mapped.createFields.ciTypeCode}"`);

          const createdCi = await deps.prisma.cI.create({
            data: {
              name: mapped.createFields.name,
              apiSlug: mapped.createFields.apiSlug,
              status: mapped.createFields.status,
              criticality: mapped.createFields.criticality as never,
              environment: mapped.createFields.environment as never,
              ciTypeId: ciType.id,
              vCpus: mapped.physicalFields.vCpus,
              ram: mapped.physicalFields.ram,
              adminIp: mapped.physicalFields.adminIp,
              hostName: mapped.physicalFields.hostName,
              clusterName: mapped.physicalFields.clusterName,
              powerState:   mapped.physicalFields.powerState,
              hypervisorId: vmwareHypervisor.id,
              operatingSystemId,
            },
          });
          await insertAuditRow(deps.prisma, 'CI_CREATE', createdCi.id, deps.userEmail, {
            source: 'vcenter',
            moref: vm.moref,
          });
          void deps.queueForIndexing('ci', createdCi.id);
          created++;
        }
      } catch (e) {
        errors++;
        console.error(`[vcenterService] Failed to sync VM moref=${vm.moref}:`, e);
        errorDetails.push({ moref: vm.moref, message: 'Failed to sync this VM — see server logs for details' });
      }
    }

    // Retire CIs this connector created that vanished from vCenter's VM list.
    // Fenced to ciType=defaults.ciTypeCode AND hypervisorId === vmwareHypervisor.id (exact-id
    // equality, NOT a null-check) AND not already RETIRADO — this can NEVER touch a
    // manually-entered CI (hypervisorId === null) NOR a CI owned by a different hypervisor
    // (e.g. a future OLVM/Solaris connector's VMs, which would have their own non-null
    // hypervisorId pointing at a different row) (safety guarantee, open risk #3 from the plan).
    const candidates = await deps.prisma.cI.findMany({
      where: { ciTypeDef: { code: deps.defaults.ciTypeCode }, status: { not: 'RETIRADO' } },
      select: { id: true, apiSlug: true, hypervisorId: true },
    });
    for (const c of candidates) {
      // Exact-id equality, NOT a null-check — a future OLVM/Solaris connector's CIs will
      // also have a non-null hypervisorId (pointing at THEIR OWN hypervisor row), so only
      // an id match against the hypervisor THIS connector owns is a safe fence. A CI with
      // hypervisorId === null (never classified/manually entered) OR pointing at any OTHER
      // hypervisor is never touched by this loop.
      if (c.hypervisorId !== vmwareHypervisor.id) continue;
      if (seenSlugs.has(c.apiSlug)) continue; // still present in vCenter
      await deps.prisma.cI.update({ where: { id: c.id }, data: { status: 'RETIRADO' } });
      await insertAuditRow(deps.prisma, 'CI_RETIRE', c.id, deps.userEmail, {
        source: 'vcenter',
        reason: 'vanished from vCenter VM list',
      });
      void deps.queueForIndexing('ci', c.id);
      retired++;
    }

    const status: SyncResult['status'] =
      errors > 0 ? (created + updated + retired > 0 ? 'PARTIAL' : 'ERROR') : 'SUCCESS';
    const result: SyncResult = {
      status,
      created,
      updated,
      retired,
      errors,
      durationMs: Date.now() - startedAt,
      errorDetails: errorDetails.length ? errorDetails : undefined,
    };

    await insertAuditRow(deps.prisma, 'SYNC_VCENTER', null, deps.userEmail, result as unknown as Record<string, unknown>);
    return result;
  } catch (e) {
    // The whole sync run failed catastrophically (connect/discover/retire-query threw).
    // D4 requires sync-run history to live in audit_logs — write a best-effort audit row
    // reflecting partial progress before re-throwing the original error unchanged, so the
    // router-level catch blocks (SyncLockedError -> 409, else -> 500) keep working exactly
    // as before.
    console.error('[vcenterService] vCenter sync run failed:', e);
    const failedResult: SyncResult = {
      status: 'ERROR',
      created,
      updated,
      retired,
      errors,
      durationMs: Date.now() - startedAt,
      errorDetails: [
        ...errorDetails,
        { message: 'Sync run failed before completion — see server logs for details' },
      ],
    };
    try {
      await insertAuditRow(
        deps.prisma,
        'SYNC_VCENTER',
        null,
        deps.userEmail,
        failedResult as unknown as Record<string, unknown>,
      );
    } catch (auditError) {
      console.error('[vcenterService] Failed to insert SYNC_VCENTER audit row for failed run:', auditError);
    }
    throw e;
  } finally {
    try {
      await deps.connector.close();
    } catch {
      // best-effort cleanup — never throw from here
    }
    syncInProgress = false;
  }
}

async function insertAuditRow(
  prisma: PrismaClient,
  action: string,
  entityId: string | null,
  userEmail: string,
  details: Record<string, unknown>,
): Promise<void> {
  const id = entityId ?? NIL_UUID;
  const entity = entityId ? 'CI' : 'SYSTEM';
  await prisma.$executeRaw`
    INSERT INTO "audit_logs"(id, action, entity, entity_id, user_email, details, created_at)
    VALUES(gen_random_uuid(), ${action}, ${entity}, ${id}::uuid, ${userEmail}, ${JSON.stringify(details)}::jsonb, now())
  `;
}

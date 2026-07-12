// vCenter sync orchestration: discovers VMs via an IHypervisorConnector, maps them
// with VCenterMapper.toCI(), and reconciles against CI rows.
//
// D2: status is NEVER derived from powerState. New CIs are created with status:
// 'ACTIVO' (baked into VCenterMapper.toCI()'s createFields.status); on UPDATE this
// service never touches `status` at all; the only place `status` is ever written
// post-creation is the "retire" step below, and only to 'RETIRADO'.
// D5: on UPDATE, only vCpus/ram/adminIp/hostName/clusterName/vcenterSync (and,
// best-effort, operatingSystemId) are touched — never criticality/environment/
// businessOwnerId/technicalLeadId/etc.
// D4: no sync_logs table — sync-run history goes to audit_logs with
// action='SYNC_VCENTER', entity='SYSTEM', entity_id=<fixed nil UUID>.

import { PrismaClient, Prisma } from '@prisma/client';
import { toCI } from './connectors/vcenter/VCenterMapper.js';
import { VCenterClient } from './connectors/vcenter/VCenterClient.js';
import { VCenterConnector } from './connectors/vcenter/VCenterConnector.js';
import type { VCenterConfig } from './vcenterConfig.js';
import type { IHypervisorConnector, SyncDefaults, SyncResult } from './connectors/types.js';

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

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

        const existingCi = await deps.prisma.cI.findUnique({
          where: { apiSlug: mapped.createFields.apiSlug },
          select: { id: true },
        });

        if (existingCi) {
          await deps.prisma.cI.update({
            where: { id: existingCi.id },
            data: {
              vCpus: mapped.physicalFields.vCpus,
              ram: mapped.physicalFields.ram,
              adminIp: mapped.physicalFields.adminIp,
              hostName: mapped.physicalFields.hostName,
              clusterName: mapped.physicalFields.clusterName,
              vcenterSync: mapped.physicalFields.vcenterSync as unknown as Prisma.InputJsonValue,
              ...(operatingSystemId ? { operatingSystemId } : {}),
            },
          });
          await insertAuditRow(deps.prisma, 'CI_UPDATE', existingCi.id, deps.userEmail, {
            source: 'vcenter',
            moref: vm.moref,
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
              vcenterSync: mapped.physicalFields.vcenterSync as unknown as Prisma.InputJsonValue,
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
    // Fenced to ciType=defaults.ciTypeCode AND vcenterSync IS NOT NULL AND not already
    // RETIRADO — this can NEVER touch a manually-entered CI (safety guarantee, open
    // risk #3 from the plan).
    const candidates = await deps.prisma.cI.findMany({
      where: { ciTypeDef: { code: deps.defaults.ciTypeCode }, status: { not: 'RETIRADO' } },
      select: { id: true, apiSlug: true, vcenterSync: true },
    });
    for (const c of candidates) {
      if (c.vcenterSync == null) continue; // not one of ours — never touch
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

import { PrismaClient } from '@prisma/client';
import { TimelineItem, TimelineMilestone, TimelineFiltersData, TimelineLegacyDates } from './types.js';
import { TimelineItemsQuery } from './schemas.js';
import { escapeLike } from '../../shared/utils/likeEscape.js';

const CI_CAP      = 250;
const ENTITY_CAP  = 100;

function toIso(d: Date | string | null | undefined): string | undefined {
  if (!d) return undefined;
  const dt = d instanceof Date ? d : new Date(d);
  return dt.toISOString().slice(0, 10);
}

// ─── CIs ─────────────────────────────────────────────────────────────────────

async function queryCIs(
  prisma: PrismaClient,
  q: TimelineItemsQuery,
): Promise<TimelineItem[]> {
  const where: Record<string, unknown> = {};

  if (q.ciTypeId) where.ciTypeId = q.ciTypeId;
  if (q.status.length) where.status = { in: q.status };
  if (q.search) {
    const pat = `%${escapeLike(q.search)}%`;
    where.name = { contains: q.search, mode: 'insensitive' };
    void pat; // escapeLike used for raw queries; here Prisma handles it
  }

  const cis = await prisma.cI.findMany({
    where,
    select: {
      id: true,
      name: true,
      status: true,
      eolDate: true,
      eosDate: true,
      lastCheckDate: true,
      ciTypeDef: { select: { name: true } },
      lifecycleDates: {
        select: {
          dateValue: true,
          dateType: { select: { name: true } },
        },
      },
    },
    take: CI_CAP,
    orderBy: { createdAt: 'desc' },
  });

  return cis.map(ci => {
    const milestones: TimelineMilestone[] = [];

    if (ci.eolDate && q.dateTypes.includes('eol')) {
      milestones.push({ type: 'eol', date: toIso(ci.eolDate)!, label: 'EOL' });
    }
    if (ci.eosDate && q.dateTypes.includes('eos')) {
      milestones.push({ type: 'eos', date: toIso(ci.eosDate)!, label: 'EOS' });
    }
    if (ci.lastCheckDate && q.dateTypes.includes('lastCheck')) {
      milestones.push({ type: 'lastCheck', date: toIso(ci.lastCheckDate)!, label: 'Last Check' });
    }
    if (q.dateTypes.includes('custom')) {
      for (const d of ci.lifecycleDates) {
        milestones.push({ type: 'custom', date: toIso(d.dateValue)!, label: d.dateType.name });
      }
    }

    return {
      id: ci.id,
      kind: 'ci' as const,
      name: ci.name,
      subType: ci.ciTypeDef?.name,
      status: ci.status,
      milestones,
    };
  });
}

// ─── Contracts ───────────────────────────────────────────────────────────────

async function queryContracts(
  prisma: PrismaClient,
  q: TimelineItemsQuery,
): Promise<TimelineItem[]> {
  const where: Record<string, unknown> = {};
  if (q.search) {
    where.contractNumber = { contains: q.search, mode: 'insensitive' };
  }

  const contracts = await prisma.contract.findMany({
    where,
    select: {
      id: true,
      contractNumber: true,
      startDate: true,
      endDate: true,
    },
    take: ENTITY_CAP,
    orderBy: { startDate: 'desc' },
  });

  return contracts.map(c => {
    const milestones: TimelineMilestone[] = [];
    if (c.endDate && q.dateTypes.includes('end')) {
      milestones.push({ type: 'end', date: toIso(c.endDate)!, label: 'Vencimiento' });
    }
    return {
      id: c.id,
      kind: 'contract' as const,
      name: c.contractNumber,
      startDate: q.dateTypes.includes('start') ? toIso(c.startDate) : undefined,
      endDate: toIso(c.endDate),
      milestones,
    };
  });
}

// ─── Licenses ────────────────────────────────────────────────────────────────

async function queryLicenses(
  prisma: PrismaClient,
  q: TimelineItemsQuery,
): Promise<TimelineItem[]> {
  const where: Record<string, unknown> = { parentLicenseId: null };
  if (q.status.length) where.status = { in: q.status };
  if (q.search) where.name = { contains: q.search, mode: 'insensitive' };

  const licenses = await prisma.license.findMany({
    where,
    select: {
      id: true,
      name: true,
      status: true,
      startDate: true,
      endDate: true,
    },
    take: ENTITY_CAP,
    orderBy: { startDate: 'desc' },
  });

  return licenses.map(l => {
    const milestones: TimelineMilestone[] = [];
    if (l.endDate && q.dateTypes.includes('end')) {
      milestones.push({ type: 'end', date: toIso(l.endDate)!, label: 'Vencimiento' });
    }
    return {
      id: l.id,
      kind: 'license' as const,
      name: l.name,
      status: l.status ?? undefined,
      startDate: q.dateTypes.includes('start') ? toIso(l.startDate) : undefined,
      endDate: toIso(l.endDate),
      milestones,
    };
  });
}

// ─── DecommissionPlans ───────────────────────────────────────────────────────
// Uses $queryRaw because DecommissionPlan is not in the host-generated Prisma client
// (same mismatch as 'license'/'licenseUser' — client regenerated only inside Docker).

interface DecommissionRow {
  id: string;
  name: string;
  status: string;
  created_at: Date;
  completed_at: Date | null;
}

async function queryDecommission(
  prisma: PrismaClient,
  q: TimelineItemsQuery,
): Promise<TimelineItem[]> {
  const statusFilter = q.status.length
    ? q.status
    : ['DRAFT', 'IN_PROGRESS', 'COMPLETED'];

  let rows: DecommissionRow[];

  if (q.search) {
    const pattern = `%${escapeLike(q.search)}%`;
    rows = await prisma.$queryRaw<DecommissionRow[]>`
      SELECT id::text, name, status, created_at, completed_at
      FROM   "decommission_plan"
      WHERE  status = ANY(${statusFilter}::text[])
        AND  name ILIKE ${pattern} ESCAPE '\\'
      ORDER BY created_at DESC
      LIMIT  ${ENTITY_CAP}
    `;
  } else {
    rows = await prisma.$queryRaw<DecommissionRow[]>`
      SELECT id::text, name, status, created_at, completed_at
      FROM   "decommission_plan"
      WHERE  status = ANY(${statusFilter}::text[])
      ORDER BY created_at DESC
      LIMIT  ${ENTITY_CAP}
    `;
  }

  return rows.map(p => {
    const milestones: TimelineMilestone[] = [];
    if (p.completed_at && q.dateTypes.includes('completed')) {
      milestones.push({ type: 'completed', date: toIso(p.completed_at)!, label: 'Completado' });
    }
    return {
      id: p.id,
      kind: 'decommission' as const,
      name: p.name,
      status: p.status,
      startDate: q.dateTypes.includes('start') ? toIso(p.created_at) : undefined,
      milestones,
    };
  });
}

// ─── Operating Systems ───────────────────────────────────────────────────────

async function queryOS(
  prisma: PrismaClient,
  q: TimelineItemsQuery,
): Promise<TimelineItem[]> {
  const where: Record<string, unknown> = {};
  if (q.search) where.name = { contains: q.search, mode: 'insensitive' };

  const oss = await prisma.operatingSystem.findMany({
    where,
    select: {
      id: true,
      name: true,
      version: true,
      lifecycleDates: {
        select: {
          dateValue: true,
          dateType: { select: { name: true } },
        },
      },
    },
    take: ENTITY_CAP,
    orderBy: { name: 'asc' },
  });

  return oss
    .filter(os => !q.dateTypes.includes('custom') ? os.lifecycleDates.length === 0 || true : true)
    .map(os => ({
      id: os.id,
      kind: 'os' as const,
      name: os.version ? `${os.name} ${os.version}` : os.name,
      subType: 'os',
      milestones: q.dateTypes.includes('custom')
        ? os.lifecycleDates.map(d => ({
            type: 'custom' as const,
            date: toIso(d.dateValue)!,
            label: d.dateType.name,
          }))
        : [],
    }));
}

// ─── Base Software ───────────────────────────────────────────────────────────

async function querySoftware(
  prisma: PrismaClient,
  q: TimelineItemsQuery,
): Promise<TimelineItem[]> {
  const where: Record<string, unknown> = {};
  if (q.search) where.name = { contains: q.search, mode: 'insensitive' };

  const softwares = await prisma.baseSoftware.findMany({
    where,
    select: {
      id: true,
      name: true,
      version: true,
      lifecycleDates: {
        select: {
          dateValue: true,
          dateType: { select: { name: true } },
        },
      },
    },
    take: ENTITY_CAP,
    orderBy: { name: 'asc' },
  });

  return softwares.map(sw => ({
    id: sw.id,
    kind: 'software' as const,
    name: sw.version ? `${sw.name} ${sw.version}` : sw.name,
    subType: 'software',
    milestones: q.dateTypes.includes('custom')
      ? sw.lifecycleDates.map(d => ({
          type: 'custom' as const,
          date: toIso(d.dateValue)!,
          label: d.dateType.name,
        }))
      : [],
  }));
}

// ─── Device Models ───────────────────────────────────────────────────────────

async function queryModels(
  prisma: PrismaClient,
  q: TimelineItemsQuery,
): Promise<TimelineItem[]> {
  const where: Record<string, unknown> = {};
  if (q.search) where.name = { contains: q.search, mode: 'insensitive' };

  const models = await prisma.deviceModel.findMany({
    where,
    select: {
      id: true,
      name: true,
      eolDate: true,
      eosDate: true,
      lifecycleDates: {
        select: {
          dateValue: true,
          dateType: { select: { name: true } },
        },
      },
    },
    take: ENTITY_CAP,
    orderBy: { name: 'asc' },
  });

  return models.map(m => {
    const milestones: TimelineMilestone[] = [];
    if (m.eolDate && q.dateTypes.includes('eol')) {
      milestones.push({ type: 'eol', date: toIso(m.eolDate)!, label: 'EOL' });
    }
    if (m.eosDate && q.dateTypes.includes('eos')) {
      milestones.push({ type: 'eos', date: toIso(m.eosDate)!, label: 'EOS' });
    }
    if (q.dateTypes.includes('custom')) {
      for (const d of m.lifecycleDates) {
        milestones.push({ type: 'custom', date: toIso(d.dateValue)!, label: d.dateType.name });
      }
    }
    return {
      id: m.id,
      kind: 'model' as const,
      name: m.name,
      subType: 'model',
      milestones,
    };
  });
}

// ─── Public: getTimelineItems ─────────────────────────────────────────────────

export async function getTimelineItems(
  prisma: PrismaClient,
  q: TimelineItemsQuery,
): Promise<{ total: number; data: TimelineItem[] }> {
  const activeTypes = new Set(q.types);

  const results = await Promise.all([
    activeTypes.has('ci')           ? queryCIs(prisma, q)           : Promise.resolve([]),
    activeTypes.has('contract')     ? queryContracts(prisma, q)     : Promise.resolve([]),
    activeTypes.has('license')      ? queryLicenses(prisma, q)      : Promise.resolve([]),
    activeTypes.has('decommission') ? queryDecommission(prisma, q)  : Promise.resolve([]),
    activeTypes.has('os')           ? queryOS(prisma, q)            : Promise.resolve([]),
    activeTypes.has('software')     ? querySoftware(prisma, q)      : Promise.resolve([]),
    activeTypes.has('model')        ? queryModels(prisma, q)        : Promise.resolve([]),
  ]);

  const all = results.flat();
  const total = all.length;
  const data = all.slice(q.offset, q.offset + q.limit);

  return { total, data };
}

// ─── Public: getTimelineFilters ───────────────────────────────────────────────

export async function getTimelineFilters(prisma: PrismaClient): Promise<TimelineFiltersData> {
  const [ciTypes, dateTypes] = await Promise.all([
    prisma.cIType.findMany({
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
    prisma.dateType.findMany({
      select: { id: true, name: true, category: true },
      orderBy: [{ category: 'asc' }, { name: 'asc' }],
    }),
  ]);

  const masterSubtypes = [
    { id: 'os',       name: 'Sistema Operativo',  kind: 'os'       as const },
    { id: 'software', name: 'Software Base',       kind: 'software' as const },
    { id: 'model',    name: 'Modelo de Hardware',  kind: 'model'    as const },
  ];

  const statuses = [
    { value: 'ACTIVO',      label: 'Activo',      kinds: ['ci', 'license'] as ('ci'|'license')[] },
    { value: 'INACTIVO',    label: 'Inactivo',    kinds: ['ci', 'license'] as ('ci'|'license')[] },
    { value: 'RETIRADO',    label: 'Retirado',    kinds: ['ci']            as 'ci'[]              },
    { value: 'DRAFT',       label: 'Borrador',    kinds: ['decommission']  as 'decommission'[]    },
    { value: 'IN_PROGRESS', label: 'En progreso', kinds: ['decommission']  as 'decommission'[]    },
    { value: 'COMPLETED',   label: 'Completado',  kinds: ['decommission']  as 'decommission'[]    },
  ];

  return { ciTypes, masterSubtypes, dateTypes, statuses };
}

// ─── Public: getLegacyDates ───────────────────────────────────────────────────

export async function getLegacyDates(
  prisma: PrismaClient,
  ciId: string,
): Promise<TimelineLegacyDates> {
  const ci = await prisma.cI.findUnique({
    where: { id: ciId },
    select: {
      id: true,
      operatingSystemId: true,
      ciModelId: true,
      operatingSystem: {
        select: {
          name: true,
          version: true,
          lifecycleDates: {
            select: {
              dateValue: true,
              dateType: { select: { name: true } },
            },
          },
        },
      },
      ciModel: {
        select: {
          name: true,
          eolDate: true,
          eosDate: true,
          lifecycleDates: {
            select: {
              dateValue: true,
              dateType: { select: { name: true } },
            },
          },
        },
      },
      baseSoftwares: {
        select: {
          baseSoftware: {
            select: {
              name: true,
              version: true,
              lifecycleDates: {
                select: {
                  dateValue: true,
                  dateType: { select: { name: true } },
                },
              },
            },
          },
        },
      },
    },
  });

  if (!ci) return { ciId, milestones: [] };

  const milestones: TimelineMilestone[] = [];

  // OS dates
  if (ci.operatingSystem) {
    const osName = ci.operatingSystem.version
      ? `${ci.operatingSystem.name} ${ci.operatingSystem.version}`
      : ci.operatingSystem.name;
    for (const d of ci.operatingSystem.lifecycleDates) {
      milestones.push({
        type: 'custom',
        date: toIso(d.dateValue)!,
        label: `${d.dateType.name} (${osName})`,
        inherited: true,
        inheritedFrom: 'os',
      });
    }
  }

  // DeviceModel dates
  if (ci.ciModel) {
    const modelName = ci.ciModel.name;
    if (ci.ciModel.eolDate) {
      milestones.push({
        type: 'eol',
        date: toIso(ci.ciModel.eolDate)!,
        label: `EOL (${modelName})`,
        inherited: true,
        inheritedFrom: 'model',
      });
    }
    if (ci.ciModel.eosDate) {
      milestones.push({
        type: 'eos',
        date: toIso(ci.ciModel.eosDate)!,
        label: `EOS (${modelName})`,
        inherited: true,
        inheritedFrom: 'model',
      });
    }
    for (const d of ci.ciModel.lifecycleDates) {
      milestones.push({
        type: 'custom',
        date: toIso(d.dateValue)!,
        label: `${d.dateType.name} (${modelName})`,
        inherited: true,
        inheritedFrom: 'model',
      });
    }
  }

  // BaseSoftware dates (M:M — all associated)
  for (const bsw of ci.baseSoftwares) {
    const sw = bsw.baseSoftware;
    const swName = sw.version ? `${sw.name} ${sw.version}` : sw.name;
    for (const d of sw.lifecycleDates) {
      milestones.push({
        type: 'custom',
        date: toIso(d.dateValue)!,
        label: `${d.dateType.name} (${swName})`,
        inherited: true,
        inheritedFrom: 'software',
      });
    }
  }

  // Sort by date ascending
  milestones.sort((a, b) => a.date.localeCompare(b.date));

  return { ciId, milestones };
}

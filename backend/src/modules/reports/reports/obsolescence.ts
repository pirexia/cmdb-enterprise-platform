import { registerReport } from '../registry.js';
import type { ReportFilters, ReportResult } from '../types.js';
import type { PrismaClient } from '@prisma/client';
import { asArray, escapeLike } from '../filterUtils.js';

function daysUntil(date: Date): number {
  return Math.ceil((date.getTime() - Date.now()) / 86_400_000);
}

function semaphore(days: number | null): 'red' | 'amber' | 'green' {
  if (days === null || days < 0)  return 'red';
  if (days <= 90)                 return 'amber';
  return 'green';
}

registerReport({
  id: 'obsolescence',
  nameKey: 'reports.def.obsolescence.name',
  descriptionKey: 'reports.def.obsolescence.desc',
  category: 'lifecycle',
  minRole: 'VIEWER',
  icon: 'AlertTriangle',
  tags: ['eol', 'eos', 'lifecycle'],
  exportFormats: ['csv', 'xlsx'],
  source: 'core',
  columns: [
    { key: 'name',        labelKey: 'reports.col.name',     type: 'string', sortable: true, filter: 'text' },
    { key: 'ciType',      labelKey: 'reports.col.ciType',   type: 'string', sortable: true },
    { key: 'eolDate',     labelKey: 'reports.col.eolDate',  type: 'date',   sortable: true },
    { key: 'eosDate',     labelKey: 'reports.col.eosDate',  type: 'date',   sortable: true },
    { key: 'daysToEol',   labelKey: 'reports.col.daysToEol', type: 'number', sortable: true },
    { key: 'daysToEos',   labelKey: 'reports.col.daysToEos', type: 'number', sortable: true },
    { key: 'eolStatus',   labelKey: 'reports.col.eolStatus', type: 'badge' },
    { key: 'eosStatus',   labelKey: 'reports.col.eosStatus', type: 'badge' },
    { key: 'criticality', labelKey: 'reports.col.criticality', type: 'badge', sortable: true, filter: 'multi-select' },
  ],
  filters: [
    { key: 'horizon', type: 'select', labelKey: 'reports.filter.horizon',
      options: [
        { value: 'expired',  labelKey: 'reports.horizon.expired' },
        { value: '30',       labelKey: 'reports.horizon.30d' },
        { value: '90',       labelKey: 'reports.horizon.90d' },
        { value: '180',      labelKey: 'reports.horizon.180d' },
        { value: '365',      labelKey: 'reports.horizon.365d' },
      ],
    },
    { key: 'criticality', type: 'multi-select', labelKey: 'reports.filter.criticality',
      options: [
        { value: 'LOW',              labelKey: 'ci.criticality.LOW' },
        { value: 'MEDIUM',           labelKey: 'ci.criticality.MEDIUM' },
        { value: 'HIGH',             labelKey: 'ci.criticality.HIGH' },
        { value: 'MISSION_CRITICAL', labelKey: 'ci.criticality.MISSION_CRITICAL' },
      ],
    },
    { key: 'search', type: 'search', labelKey: 'reports.filter.search' },
  ],
  async query(prisma: PrismaClient, filters: ReportFilters): Promise<ReportResult> {
    const horizon = (filters['horizon'] as string | undefined);
    const criticalityFilter = asArray(filters['criticality']);
    const search  = filters.search?.trim();
    const now     = new Date();

    let dateFilter: object = { OR: [{ eolDate: { not: null } }, { eosDate: { not: null } }] };
    if (horizon === 'expired') {
      dateFilter = { OR: [{ eolDate: { lt: now } }, { eosDate: { lt: now } }] };
    } else if (horizon) {
      const cutoff = new Date(now.getTime() + Number(horizon) * 86_400_000);
      dateFilter = {
        OR: [
          { eolDate: { gte: now, lte: cutoff } },
          { eosDate: { gte: now, lte: cutoff } },
        ],
      };
    }

    const where = {
      ...dateFilter,
      ...(criticalityFilter ? { criticality: { in: criticalityFilter as ('LOW'|'MEDIUM'|'HIGH'|'MISSION_CRITICAL')[] } } : {}),
      ...(search ? {
        name: { contains: escapeLike(search), mode: 'insensitive' as const },
      } : {}),
    };

    const [total, cis] = await Promise.all([
      prisma.cI.count({ where }),
      prisma.cI.findMany({
        where,
        select: {
          id: true, name: true, criticality: true,
          eolDate: true, eosDate: true,
          ciTypeDef: { select: { name: true } },
        },
        orderBy: { eolDate: 'asc' },
        skip: (filters.page - 1) * filters.limit,
        take: filters.limit,
      }),
    ]);

    const data = cis.map((ci) => {
      const dEol = ci.eolDate ? daysUntil(ci.eolDate) : null;
      const dEos = ci.eosDate ? daysUntil(ci.eosDate) : null;
      return {
        id: ci.id,
        name: ci.name,
        ciType: ci.ciTypeDef?.name ?? '',
        eolDate: ci.eolDate?.toISOString().slice(0, 10) ?? '',
        eosDate: ci.eosDate?.toISOString().slice(0, 10) ?? '',
        daysToEol: dEol ?? '',
        daysToEos: dEos ?? '',
        eolStatus: ci.eolDate ? semaphore(dEol) : '',
        eosStatus: ci.eosDate ? semaphore(dEos) : '',
        criticality: ci.criticality,
      };
    });

    const expired  = data.filter((r) => r.eolStatus === 'red' || r.eosStatus === 'red').length;
    const warning  = data.filter((r) => r.eolStatus === 'amber' || r.eosStatus === 'amber').length;

    return {
      data,
      total,
      kpis: [
        { labelKey: 'reports.kpi.total',   value: total,   tone: 'neutral' },
        { labelKey: 'reports.kpi.expired', value: expired, tone: 'red' },
        { labelKey: 'reports.kpi.warning', value: warning, tone: 'amber' },
      ],
    };
  },
});

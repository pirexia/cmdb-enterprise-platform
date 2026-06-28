import { registerReport } from '../registry.js';
import type { ReportFilters, ReportResult } from '../types.js';
import type { PrismaClient } from '@prisma/client';

type PlanRow = {
  id: string;
  name: string;
  system_ci_id: string;
  status: string;
  created_by: string;
  created_at: Date;
  completed_at: Date | null;
  ci_count: bigint;
  contract_count: bigint;
  license_count: bigint;
};

type CiNameRow = { id: string; name: string };
type CountRow  = { count: bigint };

registerReport({
  id: 'decommission',
  nameKey: 'reports.def.decommission.name',
  descriptionKey: 'reports.def.decommission.desc',
  category: 'lifecycle',
  minRole: 'ADMIN',
  icon: 'Trash2',
  tags: ['decommission', 'lifecycle', 'planning'],
  exportFormats: ['csv', 'xlsx'],
  source: 'core',
  columns: [
    { key: 'name',          labelKey: 'reports.col.name',          type: 'string', sortable: true },
    { key: 'systemCI',      labelKey: 'reports.col.systemCI',      type: 'string', sortable: true },
    { key: 'status',        labelKey: 'reports.col.status',        type: 'badge',  sortable: true },
    { key: 'createdBy',     labelKey: 'reports.col.createdBy',     type: 'string' },
    { key: 'createdAt',     labelKey: 'reports.col.createdAt',     type: 'date',   sortable: true },
    { key: 'completedAt',   labelKey: 'reports.col.completedAt',   type: 'date',   sortable: true },
    { key: 'ciCount',       labelKey: 'reports.col.ciCount',       type: 'number' },
    { key: 'contractCount', labelKey: 'reports.col.contractCount', type: 'number' },
    { key: 'licenseCount',  labelKey: 'reports.col.licenseCount',  type: 'number' },
  ],
  filters: [
    { key: 'status', type: 'select', labelKey: 'reports.filter.status',
      options: [
        { value: 'DRAFT',       labelKey: 'decomm.status.DRAFT' },
        { value: 'IN_PROGRESS', labelKey: 'decomm.status.IN_PROGRESS' },
        { value: 'COMPLETED',   labelKey: 'decomm.status.COMPLETED' },
        { value: 'CANCELLED',   labelKey: 'decomm.status.CANCELLED' },
      ],
    },
    { key: 'from',   type: 'date-range', labelKey: 'reports.filter.from' },
    { key: 'to',     type: 'date-range', labelKey: 'reports.filter.to' },
    { key: 'search', type: 'search',     labelKey: 'reports.filter.search' },
  ],
  async query(prisma: PrismaClient, filters: ReportFilters): Promise<ReportResult> {
    const statusFilter = filters['status'] as string | undefined;
    const search = filters.search?.trim();
    const offset = (filters.page - 1) * filters.limit;

    const conditions: string[] = [];
    if (statusFilter)    conditions.push(`p.status = '${statusFilter.replace(/'/g, "''")}'`);
    if (filters.from)    conditions.push(`p.created_at >= '${filters.from}'::date`);
    if (filters.to)      conditions.push(`p.created_at <= '${filters.to}'::date`);
    if (search) {
      const s = search.replace(/'/g, "''").replace(/[%_\\]/g, (c) => `\\${c}`);
      conditions.push(`p.name ILIKE '%${s}%' ESCAPE '\\'`);
    }
    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const [countRows, plans] = await Promise.all([
      prisma.$queryRawUnsafe<CountRow[]>(
        `SELECT COUNT(*)::bigint AS count FROM decommission_plan p ${whereClause}`,
      ),
      prisma.$queryRawUnsafe<PlanRow[]>(`
        SELECT
          p.id, p.name, p.system_ci_id, p.status, p.created_by, p.created_at, p.completed_at,
          (SELECT COUNT(*) FROM decommission_plan_ci   WHERE plan_id = p.id)::bigint AS ci_count,
          (SELECT COUNT(*) FROM decommission_plan_contract WHERE plan_id = p.id)::bigint AS contract_count,
          (SELECT COUNT(*) FROM decommission_plan_license  WHERE plan_id = p.id)::bigint AS license_count
        FROM decommission_plan p
        ${whereClause}
        ORDER BY p.created_at DESC
        LIMIT ${filters.limit} OFFSET ${offset}
      `),
    ]);

    const total = Number(countRows[0]?.count ?? 0);

    // Batch-resolve system CI names
    const ciIds = [...new Set(plans.map((p) => p.system_ci_id))];
    const systemCIs = ciIds.length
      ? await prisma.$queryRawUnsafe<CiNameRow[]>(
          `SELECT id, name FROM configuration_items WHERE id = ANY($1::uuid[])`,
          ciIds,
        )
      : [];
    const ciNameMap = Object.fromEntries(systemCIs.map((c) => [c.id, c.name]));

    const data = plans.map((p) => ({
      id: p.id,
      name: p.name,
      systemCI: ciNameMap[p.system_ci_id] ?? p.system_ci_id,
      status: p.status,
      createdBy: p.created_by,
      createdAt: p.created_at instanceof Date ? p.created_at.toISOString().slice(0, 10) : String(p.created_at).slice(0, 10),
      completedAt: p.completed_at instanceof Date ? p.completed_at.toISOString().slice(0, 10) : (p.completed_at ? String(p.completed_at).slice(0, 10) : ''),
      ciCount: Number(p.ci_count),
      contractCount: Number(p.contract_count),
      licenseCount: Number(p.license_count),
    }));

    const completed  = data.filter((d) => d.status === 'COMPLETED').length;
    const inProgress = data.filter((d) => d.status === 'IN_PROGRESS').length;

    return {
      data,
      total,
      kpis: [
        { labelKey: 'reports.kpi.total',      value: total,      tone: 'neutral' },
        { labelKey: 'reports.kpi.inProgress', value: inProgress, tone: 'amber' },
        { labelKey: 'reports.kpi.completed',  value: completed,  tone: 'green' },
      ],
    };
  },
});

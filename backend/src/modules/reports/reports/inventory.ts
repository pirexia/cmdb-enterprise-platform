import { registerReport } from '../registry.js';
import type { ReportFilters, ReportResult } from '../types.js';
import type { PrismaClient } from '@prisma/client';

registerReport({
  id: 'inventory',
  nameKey: 'reports.def.inventory.name',
  descriptionKey: 'reports.def.inventory.desc',
  category: 'inventory',
  minRole: 'VIEWER',
  icon: 'Server',
  tags: ['inventory', 'assets'],
  exportFormats: ['csv', 'xlsx'],
  source: 'core',
  columns: [
    { key: 'name',        labelKey: 'reports.col.name',        type: 'string',  sortable: true },
    { key: 'ciType',      labelKey: 'reports.col.ciType',      type: 'string',  sortable: true },
    { key: 'status',      labelKey: 'reports.col.status',      type: 'badge',   sortable: true },
    { key: 'criticality', labelKey: 'reports.col.criticality', type: 'badge',   sortable: true },
    { key: 'location',    labelKey: 'reports.col.location',    type: 'string',  sortable: true },
    { key: 'branch',      labelKey: 'reports.col.branch',      type: 'string',  sortable: true },
    { key: 'costCenter',  labelKey: 'reports.col.costCenter',  type: 'string',  sortable: true },
    { key: 'createdAt',   labelKey: 'reports.col.createdAt',   type: 'date',    sortable: true },
  ],
  filters: [
    { key: 'status',      type: 'multi-select', labelKey: 'reports.filter.status',
      options: [
        { value: 'ACTIVO',   labelKey: 'ci.status.ACTIVO' },
        { value: 'INACTIVO', labelKey: 'ci.status.INACTIVO' },
        { value: 'RETIRADO', labelKey: 'ci.status.RETIRADO' },
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
    const statusFilter = (filters['status'] as string[] | undefined);
    const criticalityFilter = (filters['criticality'] as string[] | undefined);
    const search = filters.search?.trim();

    const where = {
      ...(statusFilter?.length ? { status: { in: statusFilter as ('ACTIVO' | 'INACTIVO' | 'RETIRADO')[] } } : {}),
      ...(criticalityFilter?.length ? { criticality: { in: criticalityFilter as ('LOW' | 'MEDIUM' | 'HIGH' | 'MISSION_CRITICAL')[] } } : {}),
      ...(search ? {
        OR: [
          { name: { contains: search.replace(/[%_\\]/g, (c) => `\\${c}`), mode: 'insensitive' as const } },
          { description: { contains: search.replace(/[%_\\]/g, (c) => `\\${c}`), mode: 'insensitive' as const } },
        ],
      } : {}),
    };

    const [total, cis, kpiRaw] = await Promise.all([
      prisma.cI.count({ where }),
      prisma.cI.findMany({
        where,
        select: {
          id: true, name: true, status: true, criticality: true, createdAt: true,
          ciTypeDef: { select: { name: true } },
          location: { select: { name: true } },
          branch: { select: { name: true } },
          costCenter: { select: { name: true } },
        },
        orderBy: { [filters.sort ?? 'name']: filters.dir ?? 'asc' },
        skip: (filters.page - 1) * filters.limit,
        take: filters.limit,
      }),
      prisma.cI.groupBy({ by: ['status'], _count: { id: true } }),
    ]);

    const countByStatus = Object.fromEntries(kpiRaw.map((r) => [r.status, r._count.id]));

    const data = cis.map((ci) => ({
      id: ci.id,
      name: ci.name,
      ciType: ci.ciTypeDef?.name ?? '',
      status: ci.status,
      criticality: ci.criticality,
      location: ci.location?.name ?? '',
      branch: ci.branch?.name ?? '',
      costCenter: ci.costCenter?.name ?? '',
      createdAt: ci.createdAt.toISOString().slice(0, 10),
    }));

    return {
      data,
      total,
      kpis: [
        { labelKey: 'reports.kpi.total',    value: total,                           tone: 'neutral' },
        { labelKey: 'reports.kpi.active',   value: countByStatus['ACTIVO'] ?? 0,   tone: 'green' },
        { labelKey: 'reports.kpi.inactive', value: countByStatus['INACTIVO'] ?? 0, tone: 'amber' },
        { labelKey: 'reports.kpi.retired',  value: countByStatus['RETIRADO'] ?? 0, tone: 'red' },
      ],
    };
  },
});

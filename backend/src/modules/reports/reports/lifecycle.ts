import { registerReport } from '../registry.js';
import type { ReportFilters, ReportResult } from '../types.js';
import type { PrismaClient } from '@prisma/client';
import { asArray, escapeLike } from '../filterUtils.js';

registerReport({
  id: 'lifecycle',
  nameKey: 'reports.def.lifecycle.name',
  descriptionKey: 'reports.def.lifecycle.desc',
  category: 'lifecycle',
  minRole: 'VIEWER',
  icon: 'GitBranch',
  tags: ['lifecycle', 'dates', 'timeline'],
  exportFormats: ['csv', 'xlsx'],
  source: 'core',
  columns: [
    { key: 'name',        labelKey: 'reports.col.name',        type: 'string', sortable: true, filter: 'text' },
    { key: 'ciType',      labelKey: 'reports.col.ciType',      type: 'string', sortable: true },
    { key: 'status',      labelKey: 'reports.col.status',      type: 'badge',  sortable: true, filter: 'multi-select' },
    { key: 'criticality', labelKey: 'reports.col.criticality', type: 'badge',  sortable: true },
    { key: 'dateType',    labelKey: 'reports.col.dateType',    type: 'string', sortable: true },
    { key: 'dateValue',   labelKey: 'reports.col.dateValue',   type: 'date',   sortable: true },
    { key: 'notes',       labelKey: 'reports.col.notes',       type: 'string' },
  ],
  filters: [
    { key: 'from',   type: 'date-range', labelKey: 'reports.filter.from' },
    { key: 'to',     type: 'date-range', labelKey: 'reports.filter.to' },
    { key: 'status', type: 'multi-select', labelKey: 'reports.filter.status',
      options: [
        { value: 'ACTIVO',   labelKey: 'ci.status.ACTIVO' },
        { value: 'INACTIVO', labelKey: 'ci.status.INACTIVO' },
        { value: 'RETIRADO', labelKey: 'ci.status.RETIRADO' },
      ],
    },
    { key: 'search', type: 'search', labelKey: 'reports.filter.search' },
  ],
  async query(prisma: PrismaClient, filters: ReportFilters): Promise<ReportResult> {
    const statusFilter = asArray(filters['status']);
    const search = filters.search?.trim();

    const dateRange = {
      ...(filters.from ? { gte: new Date(filters.from) } : {}),
      ...(filters.to   ? { lte: new Date(filters.to) }   : {}),
    };

    const where = {
      ...(statusFilter ? { ci: { status: { in: statusFilter as ('ACTIVO'|'INACTIVO'|'RETIRADO')[] } } } : {}),
      ...(Object.keys(dateRange).length ? { dateValue: dateRange } : {}),
      ...(search ? {
        ci: { name: { contains: escapeLike(search), mode: 'insensitive' as const } },
      } : {}),
    };

    const [total, dates] = await Promise.all([
      prisma.cIDate.count({ where }),
      prisma.cIDate.findMany({
        where,
        select: {
          id: true, dateValue: true, notes: true,
          ci: {
            select: {
              id: true, name: true, status: true, criticality: true,
              ciTypeDef: { select: { name: true } },
            },
          },
          dateType: { select: { name: true } },
        },
        orderBy: { dateValue: filters.dir ?? 'asc' },
        skip: (filters.page - 1) * filters.limit,
        take: filters.limit,
      }),
    ]);

    const data = dates.map((d) => ({
      id: d.id,
      ciId: d.ci.id,
      name: d.ci.name,
      ciType: d.ci.ciTypeDef?.name ?? '',
      status: d.ci.status,
      criticality: d.ci.criticality,
      dateType: d.dateType.name,
      dateValue: d.dateValue.toISOString().slice(0, 10),
      notes: d.notes ?? '',
    }));

    return { data, total };
  },
});

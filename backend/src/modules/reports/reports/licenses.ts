import { registerReport } from '../registry.js';
import type { ReportFilters, ReportResult } from '../types.js';
import type { PrismaClient } from '@prisma/client';
import { asArray, escapeLike } from '../filterUtils.js';

function daysUntil(date: Date): number {
  return Math.ceil((date.getTime() - Date.now()) / 86_400_000);
}

registerReport({
  id: 'licenses',
  nameKey: 'reports.def.licenses.name',
  descriptionKey: 'reports.def.licenses.desc',
  category: 'financial',
  minRole: 'ADMIN',
  icon: 'Key',
  tags: ['licenses', 'financial', 'compliance'],
  exportFormats: ['csv', 'xlsx'],
  source: 'core',
  columns: [
    { key: 'name',           labelKey: 'reports.col.name',           type: 'string', sortable: true, filter: 'text' },
    { key: 'licenseNumber',  labelKey: 'reports.col.licenseNumber',  type: 'string', sortable: true, filter: 'text' },
    { key: 'vendor',         labelKey: 'reports.col.vendor',         type: 'string', sortable: true },
    { key: 'licenseType',    labelKey: 'reports.col.licenseType',    type: 'string', sortable: true },
    { key: 'metricValue',    labelKey: 'reports.col.metricValue',    type: 'number', sortable: true },
    { key: 'assignedUsers',  labelKey: 'reports.col.assignedUsers',  type: 'number', sortable: true },
    { key: 'cost',           labelKey: 'reports.col.cost',           type: 'number', sortable: true },
    { key: 'currency',       labelKey: 'reports.col.currency',       type: 'string' },
    { key: 'endDate',        labelKey: 'reports.col.endDate',        type: 'date',   sortable: true },
    { key: 'daysRemaining',  labelKey: 'reports.col.daysRemaining',  type: 'number', sortable: true },
    { key: 'status',         labelKey: 'reports.col.status',         type: 'badge',  sortable: true, filter: 'multi-select' },
  ],
  filters: [
    { key: 'status', type: 'multi-select', labelKey: 'reports.filter.status',
      options: [
        { value: 'ACTIVO',    labelKey: 'ci.status.ACTIVO' },
        { value: 'INACTIVO',  labelKey: 'ci.status.INACTIVO' },
        { value: 'RETIRADO',  labelKey: 'ci.status.RETIRADO' },
      ],
    },
    { key: 'horizon', type: 'select', labelKey: 'reports.filter.horizon',
      options: [
        { value: 'expired',  labelKey: 'reports.horizon.expired' },
        { value: '90',       labelKey: 'reports.horizon.90d' },
        { value: '365',      labelKey: 'reports.horizon.365d' },
      ],
    },
    { key: 'search', type: 'search', labelKey: 'reports.filter.search' },
  ],
  async query(prisma: PrismaClient, filters: ReportFilters): Promise<ReportResult> {
    const statusFilter = asArray(filters['status']);
    const horizon      = filters['horizon'] as string | undefined;
    const search       = filters.search?.trim();
    const now          = new Date();

    let dateFilter: object = {};
    if (horizon === 'expired') {
      dateFilter = { endDate: { lt: now } };
    } else if (horizon) {
      const cutoff = new Date(now.getTime() + Number(horizon) * 86_400_000);
      dateFilter = { endDate: { gte: now, lte: cutoff } };
    }

    const where = {
      ...(statusFilter ? { status: { in: statusFilter } } : {}),
      ...dateFilter,
      ...(search ? {
        OR: [
          { name:          { contains: escapeLike(search), mode: 'insensitive' as const } },
          { licenseNumber: { contains: escapeLike(search), mode: 'insensitive' as const } },
        ],
      } : {}),
    };

    const [total, licenses] = await Promise.all([
      prisma.license.count({ where }),
      prisma.license.findMany({
        where,
        select: {
          id: true, name: true, licenseNumber: true, status: true,
          metricValue: true, cost: true, currency: true, endDate: true,
          vendor:      { select: { name: true } },
          licenseType: { select: { name: true } },
          _count:      { select: { licenseUsers: true } },
        },
        orderBy: { endDate: 'asc' },
        skip: (filters.page - 1) * filters.limit,
        take: filters.limit,
      }),
    ]);

    let totalCost = 0;
    const data = licenses.map((l) => {
      const days = l.endDate ? daysUntil(l.endDate) : null;
      if (l.cost) totalCost += Number(l.cost);
      return {
        id: l.id,
        name: l.name,
        licenseNumber: l.licenseNumber,
        vendor: l.vendor?.name ?? '',
        licenseType: l.licenseType?.name ?? '',
        metricValue: l.metricValue ?? '',
        assignedUsers: l._count.licenseUsers,
        cost: l.cost ? Number(l.cost) : '',
        currency: l.currency ?? 'EUR',
        endDate: l.endDate?.toISOString().slice(0, 10) ?? '',
        daysRemaining: days ?? '',
        status: l.status ?? 'ACTIVO',
      };
    });

    return {
      data,
      total,
      kpis: [
        { labelKey: 'reports.kpi.total',     value: Number(total),                       tone: 'neutral' },
        { labelKey: 'reports.kpi.totalCost', value: `${totalCost.toFixed(2)} EUR`,       tone: 'neutral' },
      ],
    };
  },
});

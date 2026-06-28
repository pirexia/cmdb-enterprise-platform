import { registerReport } from '../registry.js';
import type { ReportFilters, ReportResult } from '../types.js';
import type { PrismaClient } from '@prisma/client';

function daysUntil(date: Date): number {
  return Math.ceil((date.getTime() - Date.now()) / 86_400_000);
}

registerReport({
  id: 'contracts',
  nameKey: 'reports.def.contracts.name',
  descriptionKey: 'reports.def.contracts.desc',
  category: 'financial',
  minRole: 'ADMIN',
  icon: 'FileText',
  tags: ['contracts', 'vendors', 'financial'],
  exportFormats: ['csv', 'xlsx'],
  source: 'core',
  columns: [
    { key: 'contractNumber', labelKey: 'reports.col.contractNumber', type: 'string', sortable: true, filter: 'text' },
    { key: 'vendor',         labelKey: 'reports.col.vendor',         type: 'string', sortable: true, filter: 'text' },
    { key: 'startDate',      labelKey: 'reports.col.startDate',      type: 'date',   sortable: true },
    { key: 'endDate',        labelKey: 'reports.col.endDate',        type: 'date',   sortable: true },
    { key: 'daysRemaining',  labelKey: 'reports.col.daysRemaining',  type: 'number', sortable: true },
    { key: 'status',         labelKey: 'reports.col.status',         type: 'badge' },
    { key: 'isAddendum',     labelKey: 'reports.col.isAddendum',     type: 'badge' },
    { key: 'ciCount',        labelKey: 'reports.col.ciCount',        type: 'number' },
  ],
  filters: [
    { key: 'horizon', type: 'select', labelKey: 'reports.filter.horizon',
      options: [
        { value: 'expired', labelKey: 'reports.horizon.expired' },
        { value: '30',      labelKey: 'reports.horizon.30d' },
        { value: '90',      labelKey: 'reports.horizon.90d' },
        { value: '180',     labelKey: 'reports.horizon.180d' },
        { value: '365',     labelKey: 'reports.horizon.365d' },
      ],
    },
    { key: 'search', type: 'search', labelKey: 'reports.filter.search' },
  ],
  async query(prisma: PrismaClient, filters: ReportFilters): Promise<ReportResult> {
    const horizon = filters['horizon'] as string | undefined;
    const search  = filters.search?.trim();
    const now     = new Date();

    let dateFilter: object = {};
    if (horizon === 'expired') {
      dateFilter = { endDate: { lt: now } };
    } else if (horizon) {
      const cutoff = new Date(now.getTime() + Number(horizon) * 86_400_000);
      dateFilter = { endDate: { gte: now, lte: cutoff } };
    }

    const where = {
      ...dateFilter,
      ...(search ? {
        OR: [
          { contractNumber: { contains: search.replace(/[%_\\]/g, (c) => `\\${c}`), mode: 'insensitive' as const } },
          { vendor: { name: { contains: search.replace(/[%_\\]/g, (c) => `\\${c}`), mode: 'insensitive' as const } } },
        ],
      } : {}),
    };

    const [total, contracts] = await Promise.all([
      prisma.contract.count({ where }),
      prisma.contract.findMany({
        where,
        select: {
          id: true, contractNumber: true, startDate: true, endDate: true,
          parentContractId: true,
          vendor: { select: { name: true } },
          _count: { select: { cis: true } },
        },
        orderBy: { endDate: 'asc' },
        skip: (filters.page - 1) * filters.limit,
        take: filters.limit,
      }),
    ]);

    let expired = 0, expiringSoon = 0;

    const data = contracts.map((c) => {
      const days = c.endDate ? daysUntil(c.endDate) : null;
      const status = !c.endDate ? 'open' : days! < 0 ? 'expired' : days! <= 90 ? 'expiring' : 'active';
      if (status === 'expired')  expired++;
      if (status === 'expiring') expiringSoon++;
      return {
        id: c.id,
        contractNumber: c.contractNumber,
        vendor: c.vendor.name,
        startDate: c.startDate.toISOString().slice(0, 10),
        endDate: c.endDate?.toISOString().slice(0, 10) ?? '',
        daysRemaining: days ?? '',
        status,
        isAddendum: c.parentContractId ? 'yes' : 'no',
        ciCount: c._count.cis,
      };
    });

    return {
      data,
      total,
      kpis: [
        { labelKey: 'reports.kpi.total',        value: Number(total),  tone: 'neutral' },
        { labelKey: 'reports.kpi.expired',       value: expired,        tone: expired > 0 ? 'red' : 'green' },
        { labelKey: 'reports.kpi.expiringSoon',  value: expiringSoon,   tone: expiringSoon > 0 ? 'amber' : 'green' },
      ],
    };
  },
});

import { registerReport } from '../registry.js';
import type { ReportFilters, ReportResult } from '../types.js';
import type { PrismaClient } from '@prisma/client';

registerReport({
  id: 'audit-trail',
  nameKey: 'reports.def.auditTrail.name',
  descriptionKey: 'reports.def.auditTrail.desc',
  category: 'audit',
  minRole: 'AUDITOR',
  icon: 'ScrollText',
  tags: ['audit', 'compliance', 'iso27001'],
  exportFormats: ['csv', 'xlsx'],
  source: 'core',
  columns: [
    { key: 'createdAt',  labelKey: 'reports.col.createdAt',  type: 'date',   sortable: true, width: 18 },
    { key: 'action',     labelKey: 'reports.col.action',     type: 'string', sortable: true, filter: 'text' },
    { key: 'entity',     labelKey: 'reports.col.entity',     type: 'string', sortable: true, filter: 'text' },
    { key: 'entityId',   labelKey: 'reports.col.entityId',   type: 'string' },
    { key: 'userEmail',  labelKey: 'reports.col.userEmail',  type: 'string', sortable: true, filter: 'text' },
    { key: 'details',    labelKey: 'reports.col.details',    type: 'string', width: 40 },
  ],
  filters: [
    { key: 'from',     type: 'date-range', labelKey: 'reports.filter.from' },
    { key: 'to',       type: 'date-range', labelKey: 'reports.filter.to' },
    { key: 'entity',   type: 'search',     labelKey: 'reports.filter.entity' },
    { key: 'action',   type: 'search',     labelKey: 'reports.filter.action' },
    { key: 'search',   type: 'search',     labelKey: 'reports.filter.userEmail' },
  ],
  async query(prisma: PrismaClient, filters: ReportFilters): Promise<ReportResult> {
    const entity  = (filters['entity'] as string | undefined)?.trim();
    const action  = (filters['action'] as string | undefined)?.trim();
    const search  = filters.search?.trim(); // userEmail

    function escape(s: string) { return s.replace(/[%_\\]/g, (c) => `\\${c}`); }

    const where = {
      ...(filters.from ? { createdAt: { gte: new Date(filters.from) } } : {}),
      ...(filters.to   ? { createdAt: { ...(filters.from ? { gte: new Date(filters.from) } : {}), lte: new Date(filters.to) } } : {}),
      ...(entity ? { entity: { contains: escape(entity), mode: 'insensitive' as const } } : {}),
      ...(action ? { action: { contains: escape(action), mode: 'insensitive' as const } } : {}),
      ...(search ? { userEmail: { contains: escape(search), mode: 'insensitive' as const } } : {}),
    };

    const [total, logs] = await Promise.all([
      prisma.auditLog.count({ where }),
      prisma.auditLog.findMany({
        where,
        select: { id: true, action: true, entity: true, entityId: true, userEmail: true, details: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        skip: (filters.page - 1) * filters.limit,
        take: filters.limit,
      }),
    ]);

    const data = logs.map((l) => ({
      id: l.id,
      createdAt: l.createdAt.toISOString().replace('T', ' ').slice(0, 19),
      action: l.action,
      entity: l.entity,
      entityId: l.entityId,
      userEmail: l.userEmail,
      details: l.details ?? '',
    }));

    return { data, total };
  },
});

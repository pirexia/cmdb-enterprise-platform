import { registerReport } from '../registry.js';
import type { ReportFilters, ReportResult } from '../types.js';
import type { PrismaClient } from '@prisma/client';

registerReport({
  id: 'impact-map',
  nameKey: 'reports.def.impactMap.name',
  descriptionKey: 'reports.def.impactMap.desc',
  category: 'inventory',
  minRole: 'VIEWER',
  icon: 'Network',
  tags: ['relations', 'impact', 'dependencies'],
  exportFormats: ['csv', 'xlsx'],
  source: 'core',
  columns: [
    { key: 'sourceId',       labelKey: 'reports.col.sourceId',       type: 'string' },
    { key: 'sourceName',     labelKey: 'reports.col.sourceName',     type: 'string', sortable: true },
    { key: 'sourceType',     labelKey: 'reports.col.sourceType',     type: 'string' },
    { key: 'relationType',   labelKey: 'reports.col.relationType',   type: 'badge',  sortable: true },
    { key: 'targetId',       labelKey: 'reports.col.targetId',       type: 'string' },
    { key: 'targetName',     labelKey: 'reports.col.targetName',     type: 'string', sortable: true },
    { key: 'targetType',     labelKey: 'reports.col.targetType',     type: 'string' },
    { key: 'targetStatus',   labelKey: 'reports.col.targetStatus',   type: 'badge' },
    { key: 'targetCriticality', labelKey: 'reports.col.criticality', type: 'badge' },
  ],
  filters: [
    { key: 'relationType', type: 'select', labelKey: 'reports.filter.relationType',
      options: [
        { value: 'DEPENDS_ON',      labelKey: 'rel.DEPENDS_ON' },
        { value: 'HOSTS',           labelKey: 'rel.HOSTS' },
        { value: 'CONNECTED_TO',    labelKey: 'rel.CONNECTED_TO' },
        { value: 'PROVIDES_SERVICE', labelKey: 'rel.PROVIDES_SERVICE' },
        { value: 'BACKED_UP_BY',    labelKey: 'rel.BACKED_UP_BY' },
        { value: 'CONTAINS',        labelKey: 'rel.CONTAINS' },
        { value: 'COMPOSED_OF',     labelKey: 'rel.COMPOSED_OF' },
        { value: 'ATTACHED_TO',     labelKey: 'rel.ATTACHED_TO' },
      ],
    },
    { key: 'search', type: 'search', labelKey: 'reports.filter.search' },
  ],
  async query(prisma: PrismaClient, filters: ReportFilters): Promise<ReportResult> {
    const relType = filters['relationType'] as string | undefined;
    const search  = filters.search?.trim();

    const where = {
      ...(relType ? { relationType: relType as ('DEPENDS_ON'|'HOSTS'|'CONNECTED_TO'|'PROVIDES_SERVICE'|'BACKED_UP_BY'|'CONTAINS'|'COMPOSED_OF'|'ATTACHED_TO') } : {}),
      ...(search ? {
        OR: [
          { sourceCI: { name: { contains: search.replace(/[%_\\]/g, (c) => `\\${c}`), mode: 'insensitive' as const } } },
          { targetCI: { name: { contains: search.replace(/[%_\\]/g, (c) => `\\${c}`), mode: 'insensitive' as const } } },
        ],
      } : {}),
    };

    const [total, relations] = await Promise.all([
      prisma.cIRelation.count({ where }),
      prisma.cIRelation.findMany({
        where,
        select: {
          id: true, relationType: true,
          sourceCI: { select: { id: true, name: true, ciTypeDef: { select: { name: true } } } },
          targetCI: { select: { id: true, name: true, status: true, criticality: true, ciTypeDef: { select: { name: true } } } },
        },
        orderBy: { sourceCI: { name: 'asc' } },
        skip: (filters.page - 1) * filters.limit,
        take: filters.limit,
      }),
    ]);

    const data = relations.map((r) => ({
      id: r.id,
      sourceId:          r.sourceCI.id,
      sourceName:        r.sourceCI.name,
      sourceType:        r.sourceCI.ciTypeDef?.name ?? '',
      relationType:      r.relationType,
      targetId:          r.targetCI.id,
      targetName:        r.targetCI.name,
      targetType:        r.targetCI.ciTypeDef?.name ?? '',
      targetStatus:      r.targetCI.status,
      targetCriticality: r.targetCI.criticality,
    }));

    return { data, total };
  },
});

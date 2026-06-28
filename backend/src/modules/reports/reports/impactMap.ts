import { registerReport } from '../registry.js';
import type { ReportFilters, ReportResult } from '../types.js';
import type { PrismaClient } from '@prisma/client';
import { asArray, escapeLike } from '../filterUtils.js';

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
    { key: 'sourceName',     labelKey: 'reports.col.sourceName',     type: 'string', sortable: true, filter: 'text' },
    { key: 'sourceType',     labelKey: 'reports.col.sourceType',     type: 'string' },
    { key: 'relationType',   labelKey: 'reports.col.relationType',   type: 'badge',  sortable: true, filter: 'multi-select' },
    { key: 'targetId',       labelKey: 'reports.col.targetId',       type: 'string' },
    { key: 'targetName',     labelKey: 'reports.col.targetName',     type: 'string', sortable: true, filter: 'text' },
    { key: 'targetType',     labelKey: 'reports.col.targetType',     type: 'string' },
    { key: 'targetStatus',   labelKey: 'reports.col.targetStatus',   type: 'badge' },
    { key: 'targetCriticality', labelKey: 'reports.col.criticality', type: 'badge' },
  ],
  filters: [
    { key: 'relationType', type: 'multi-select', labelKey: 'reports.filter.relationType',
      options: [
        { value: 'HOSTS',            labelKey: 'rel.HOSTS' },
        { value: 'DEPENDS_ON',       labelKey: 'rel.DEPENDS_ON' },
        { value: 'CONNECTED_TO',     labelKey: 'rel.CONNECTED_TO' },
        { value: 'CONNECTS_TO',      labelKey: 'rel.CONNECTS_TO' },
        { value: 'PROVIDES_SERVICE', labelKey: 'rel.PROVIDES_SERVICE' },
        { value: 'BACKED_UP_BY',     labelKey: 'rel.BACKED_UP_BY' },
        { value: 'REPLICATES_TO',    labelKey: 'rel.REPLICATES_TO' },
        { value: 'CONTAINS',         labelKey: 'rel.CONTAINS' },
        { value: 'COMPOSED_OF',      labelKey: 'rel.COMPOSED_OF' },
        { value: 'ATTACHED_TO',      labelKey: 'rel.ATTACHED_TO' },
        { value: 'UPLINKS_TO',       labelKey: 'rel.UPLINKS_TO' },
        { value: 'POWERS',           labelKey: 'rel.POWERS' },
        { value: 'PROTECTS',         labelKey: 'rel.PROTECTS' },
        { value: 'RUNS_ON',          labelKey: 'rel.RUNS_ON' },
        { value: 'QUERIES',          labelKey: 'rel.QUERIES' },
        { value: 'LICENSES',         labelKey: 'rel.LICENSES' },
        { value: 'MANAGES',          labelKey: 'rel.MANAGES' },
      ],
    },
    { key: 'search', type: 'search', labelKey: 'reports.filter.search' },
  ],
  async query(prisma: PrismaClient, filters: ReportFilters): Promise<ReportResult> {
    const relTypes = asArray(filters['relationType']);
    const search  = filters.search?.trim();

    const where = {
      ...(relTypes ? { relationType: { in: relTypes as ('HOSTS'|'DEPENDS_ON'|'CONNECTED_TO'|'CONNECTS_TO'|'PROVIDES_SERVICE'|'BACKED_UP_BY'|'REPLICATES_TO'|'CONTAINS'|'COMPOSED_OF'|'ATTACHED_TO'|'UPLINKS_TO'|'POWERS'|'PROTECTS'|'RUNS_ON'|'QUERIES'|'LICENSES'|'MANAGES')[] } } : {}),
      ...(search ? {
        OR: [
          { sourceCI: { name: { contains: escapeLike(search), mode: 'insensitive' as const } } },
          { targetCI: { name: { contains: escapeLike(search), mode: 'insensitive' as const } } },
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

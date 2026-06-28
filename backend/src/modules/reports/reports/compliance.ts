import { registerReport } from '../registry.js';
import type { ReportFilters, ReportResult } from '../types.js';
import type { PrismaClient } from '@prisma/client';
import { asArray, escapeLike } from '../filterUtils.js';

registerReport({
  id: 'compliance',
  nameKey: 'reports.def.compliance.name',
  descriptionKey: 'reports.def.compliance.desc',
  category: 'compliance',
  minRole: 'AUDITOR',
  icon: 'ClipboardCheck',
  tags: ['compliance', 'gdpr', 'iso27001'],
  exportFormats: ['csv', 'xlsx'],
  source: 'core',
  columns: [
    { key: 'name',        labelKey: 'reports.col.name',        type: 'string', sortable: true, filter: 'text' },
    { key: 'criticality', labelKey: 'reports.col.criticality', type: 'badge',  sortable: true, filter: 'multi-select' },
    { key: 'status',      labelKey: 'reports.col.status',      type: 'badge',  sortable: true },
    { key: 'environment', labelKey: 'reports.col.environment', type: 'badge',  sortable: true, filter: 'multi-select' },
    { key: 'hasVulns',    labelKey: 'reports.col.hasVulns',    type: 'badge' },
    { key: 'eolDate',     labelKey: 'reports.col.eolDate',     type: 'date',   sortable: true },
    { key: 'eosDate',     labelKey: 'reports.col.eosDate',     type: 'date',   sortable: true },
  ],
  filters: [
    { key: 'criticality', type: 'multi-select', labelKey: 'reports.filter.criticality',
      options: [
        { value: 'HIGH',             labelKey: 'ci.criticality.HIGH' },
        { value: 'MISSION_CRITICAL', labelKey: 'ci.criticality.MISSION_CRITICAL' },
      ],
    },
    { key: 'environment', type: 'multi-select', labelKey: 'reports.filter.environment',
      options: [
        { value: 'PRODUCTION',   labelKey: 'env.PRODUCTION' },
        { value: 'STAGING',      labelKey: 'env.STAGING' },
        { value: 'DEVELOPMENT',  labelKey: 'env.DEVELOPMENT' },
        { value: 'TESTING',      labelKey: 'env.TESTING' },
      ],
    },
    { key: 'search', type: 'search', labelKey: 'reports.filter.search' },
  ],
  async query(prisma: PrismaClient, filters: ReportFilters): Promise<ReportResult> {
    const criticalityFilter = asArray(filters['criticality']) as ('LOW'|'MEDIUM'|'HIGH'|'MISSION_CRITICAL')[] | undefined;
    const environmentFilter = asArray(filters['environment']) as ('DEVELOPMENT'|'TESTING'|'STAGING'|'PRODUCTION')[] | undefined;
    const search = filters.search?.trim();

    const where = {
      ...(criticalityFilter ? { criticality: { in: criticalityFilter } } : {}),
      ...(environmentFilter ? { environment: { in: environmentFilter } } : {}),
      ...(search ? {
        name: { contains: escapeLike(search), mode: 'insensitive' as const },
      } : {}),
    };

    const [total, cis] = await Promise.all([
      prisma.cI.count({ where }),
      prisma.cI.findMany({
        where,
        select: {
          id: true, name: true, criticality: true, status: true,
          environment: true, eolDate: true, eosDate: true,
          vulnerabilities: true,
        },
        orderBy: { criticality: 'desc' },
        skip: (filters.page - 1) * filters.limit,
        take: filters.limit,
      }),
    ]);

    const data = cis.map((ci) => ({
      id: ci.id,
      name: ci.name,
      criticality: ci.criticality,
      status: ci.status,
      environment: ci.environment ?? '',
      hasVulns: Array.isArray(ci.vulnerabilities) && (ci.vulnerabilities as unknown[]).length > 0 ? 'yes' : 'no',
      eolDate: ci.eolDate?.toISOString().slice(0, 10) ?? '',
      eosDate: ci.eosDate?.toISOString().slice(0, 10) ?? '',
    }));

    const withVulns = data.filter((r) => r.hasVulns === 'yes').length;
    const missionCritical = data.filter((r) => r.criticality === 'MISSION_CRITICAL').length;

    return {
      data,
      total,
      kpis: [
        { labelKey: 'reports.kpi.total',           value: Number(total),    tone: 'neutral' },
        { labelKey: 'reports.kpi.missionCritical', value: missionCritical, tone: missionCritical > 0 ? 'amber' : 'green' },
        { labelKey: 'reports.kpi.withVulns',       value: withVulns,       tone: withVulns > 0 ? 'red' : 'green' },
      ],
    };
  },
});

import { registerReport } from '../registry.js';
import type { ReportFilters, ReportResult } from '../types.js';
import type { PrismaClient } from '@prisma/client';
import { asArray, escapeLike } from '../filterUtils.js';

registerReport({
  id: 'security',
  nameKey: 'reports.def.security.name',
  descriptionKey: 'reports.def.security.desc',
  category: 'security',
  minRole: 'VIEWER',
  icon: 'ShieldAlert',
  tags: ['security', 'vulnerabilities', 'crowdstrike'],
  exportFormats: ['csv', 'xlsx'],
  source: 'core',
  columns: [
    { key: 'name',           labelKey: 'reports.col.name',           type: 'string',  sortable: true, filter: 'text' },
    { key: 'ciType',         labelKey: 'reports.col.ciType',         type: 'string',  sortable: true },
    { key: 'criticality',    labelKey: 'reports.col.criticality',    type: 'badge',   sortable: true, filter: 'multi-select' },
    { key: 'totalVulns',     labelKey: 'reports.col.totalVulns',     type: 'number',  sortable: true },
    { key: 'critical',       labelKey: 'reports.col.critical',       type: 'number' },
    { key: 'high',           labelKey: 'reports.col.high',           type: 'number' },
    { key: 'medium',         labelKey: 'reports.col.medium',         type: 'number' },
    { key: 'low',            labelKey: 'reports.col.low',            type: 'number' },
    { key: 'agentCoverage',  labelKey: 'reports.col.agentCoverage',  type: 'badge' },
  ],
  filters: [
    { key: 'criticality', type: 'multi-select', labelKey: 'reports.filter.criticality',
      options: [
        { value: 'LOW',              labelKey: 'ci.criticality.LOW' },
        { value: 'MEDIUM',           labelKey: 'ci.criticality.MEDIUM' },
        { value: 'HIGH',             labelKey: 'ci.criticality.HIGH' },
        { value: 'MISSION_CRITICAL', labelKey: 'ci.criticality.MISSION_CRITICAL' },
      ],
    },
    { key: 'hasVulns', type: 'toggle', labelKey: 'reports.filter.hasVulns' },
    { key: 'noCoverage', type: 'toggle', labelKey: 'reports.filter.noCoverage' },
    { key: 'search', type: 'search', labelKey: 'reports.filter.search' },
  ],
  async query(prisma: PrismaClient, filters: ReportFilters): Promise<ReportResult> {
    const hasVulns   = filters['hasVulns'] === 'true';
    const noCoverage = filters['noCoverage'] === 'true';
    const criticalityFilter = asArray(filters['criticality']);
    const search     = filters.search?.trim();

    const where: Record<string, unknown> = {};
    if (hasVulns)   where['vulnerabilities'] = { not: null };
    if (noCoverage) where['agentStatus'] = null;
    if (criticalityFilter) where['criticality'] = { in: criticalityFilter };
    if (search) {
      where['name'] = {
        contains: escapeLike(search),
        mode: 'insensitive',
      };
    }

    const [total, cis] = await Promise.all([
      prisma.cI.count({ where }),
      prisma.cI.findMany({
        where,
        select: {
          id: true, name: true, criticality: true,
          vulnerabilities: true, agentStatus: true,
          ciTypeDef: { select: { name: true } },
        },
        orderBy: { name: 'asc' },
        skip: (filters.page - 1) * filters.limit,
        take: filters.limit,
      }),
    ]);

    let totalVulnsAll = 0;
    let coveredCount = 0;

    const data = cis.map((ci) => {
      const vulns = (ci.vulnerabilities ?? []) as { severity?: string }[];
      const count = (sev: string) => vulns.filter((v) => v.severity === sev).length;
      const total_ = vulns.length;
      totalVulnsAll += total_;

      const agentJson = ci.agentStatus as { crowdstrike?: { status?: string } } | null;
      const covered = agentJson?.crowdstrike?.status === 'online';
      if (covered) coveredCount++;

      return {
        id: ci.id,
        name: ci.name,
        ciType: ci.ciTypeDef?.name ?? '',
        criticality: ci.criticality,
        totalVulns: total_,
        critical: count('critical'),
        high:     count('high'),
        medium:   count('medium'),
        low:      count('low'),
        agentCoverage: covered ? 'covered' : 'uncovered',
      };
    });

    const coveragePct = total > 0 ? Math.round((coveredCount / Number(total)) * 100) : 0;

    return {
      data,
      total,
      kpis: [
        { labelKey: 'reports.kpi.totalVulns',   value: totalVulnsAll, tone: totalVulnsAll > 0 ? 'red' : 'green' },
        { labelKey: 'reports.kpi.coverage',     value: `${coveragePct}%`, tone: coveragePct >= 80 ? 'green' : 'amber' },
        { labelKey: 'reports.kpi.uncovered',    value: Number(total) - coveredCount, tone: 'red' },
      ],
    };
  },
});

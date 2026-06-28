import { registerReport } from '../registry.js';
import type { ReportColumn, ReportFilters, ReportResult } from '../types.js';
import type { Prisma, PrismaClient } from '@prisma/client';
import { asArray, escapeLike, resolveOrderBy, sortDir } from '../filterUtils.js';

// ─── Column registry ────────────────────────────────────────────────────────
// Each column declares: its metadata, the Prisma `select` fragment it needs,
// a value extractor, and (when sortable) an orderBy builder. The query merges
// only the fragments for the requested columns → no over-fetching.

type AnyCI = Record<string, any>;
type OrderByFn = (d: 'asc' | 'desc') => Prisma.CIOrderByWithRelationInput;

interface ColSpec {
  col: ReportColumn;
  select: Prisma.CISelect;
  extract: (ci: AnyCI) => unknown;
  orderBy?: OrderByFn;
}

function dateStr(v: unknown): string {
  return v instanceof Date ? v.toISOString().slice(0, 10) : (v ? String(v).slice(0, 10) : '');
}

// Builders ---------------------------------------------------------------------
function scalar(key: string, type: ReportColumn['type'], group: string, opts: { sortable?: boolean; filter?: ReportColumn['filter']; defaultVisible?: boolean } = {}): ColSpec {
  return {
    col: { key, labelKey: `reports.col.${key}`, type, group, configurable: true, sortable: opts.sortable ?? true, ...(opts.filter ? { filter: opts.filter } : {}), ...(opts.defaultVisible ? { defaultVisible: true } : {}) },
    select: { [key]: true } as Prisma.CISelect,
    extract: (ci) => ci[key] ?? '',
    orderBy: (opts.sortable ?? true) ? (d) => ({ [key]: d } as Prisma.CIOrderByWithRelationInput) : undefined,
  };
}

function ciDate(key: string, field: string, group: string, opts: { defaultVisible?: boolean } = {}): ColSpec {
  return {
    col: { key, labelKey: `reports.col.${key}`, type: 'date', group, configurable: true, sortable: true, ...(opts.defaultVisible ? { defaultVisible: true } : {}) },
    select: { [field]: true } as Prisma.CISelect,
    extract: (ci) => dateStr(ci[field]),
    orderBy: (d) => ({ [field]: d } as Prisma.CIOrderByWithRelationInput),
  };
}

function boolBadge(key: string, group: string): ColSpec {
  return {
    col: { key, labelKey: `reports.col.${key}`, type: 'badge', group, configurable: true, sortable: true },
    select: { [key]: true } as Prisma.CISelect,
    extract: (ci) => (ci[key] ? 'yes' : 'no'),
    orderBy: (d) => ({ [key]: d } as Prisma.CIOrderByWithRelationInput),
  };
}

function rel(key: string, relField: string, subField: string, group: string, opts: { defaultVisible?: boolean } = {}): ColSpec {
  return {
    col: { key, labelKey: `reports.col.${key}`, type: 'string', group, configurable: true, sortable: true, ...(opts.defaultVisible ? { defaultVisible: true } : {}) },
    select: { [relField]: { select: { [subField]: true } } } as Prisma.CISelect,
    extract: (ci) => ci[relField]?.[subField] ?? '',
    orderBy: (d) => ({ [relField]: { [subField]: d } } as Prisma.CIOrderByWithRelationInput),
  };
}

function hw(key: string, field: string, type: ReportColumn['type'], group: string): ColSpec {
  return {
    col: { key, labelKey: `reports.col.${key}`, type, group, configurable: true, sortable: true },
    select: { hardware: { select: { [field]: true } } } as Prisma.CISelect,
    extract: (ci) => ci.hardware?.[field] ?? '',
    orderBy: (d) => ({ hardware: { [field]: d } } as Prisma.CIOrderByWithRelationInput),
  };
}

function sw(key: string, field: string, group: string): ColSpec {
  return {
    col: { key, labelKey: `reports.col.${key}`, type: 'string', group, configurable: true, sortable: true },
    select: { software: { select: { [field]: true } } } as Prisma.CISelect,
    extract: (ci) => ci.software?.[field] ?? '',
    orderBy: (d) => ({ software: { [field]: d } } as Prisma.CIOrderByWithRelationInput),
  };
}

// Lifecycle dates from ci_dates + dateType.code (1:N → not sortable via Prisma).
const LIFE_SELECT: Prisma.CISelect = { lifecycleDates: { select: { dateValue: true, dateType: { select: { code: true } } } } };
function lifeDate(key: string, code: string): ColSpec {
  return {
    col: { key, labelKey: `reports.col.${key}`, type: 'date', group: 'lifecycle', configurable: true, sortable: false },
    select: LIFE_SELECT,
    extract: (ci) => {
      const d = (ci.lifecycleDates ?? []).find((x: AnyCI) => x.dateType?.code === code);
      return d ? dateStr(d.dateValue) : '';
    },
  };
}

// ─── The full column set (ordered) ────────────────────────────────────────────
const SPECS: Record<string, ColSpec> = {
  // general
  name:               { col: { key: 'name', labelKey: 'reports.col.name', type: 'string', group: 'general', configurable: true, sortable: true, filter: 'text', defaultVisible: true }, select: { name: true }, extract: (ci) => ci.name, orderBy: (d) => ({ name: d }) },
  ciType:             rel('ciType', 'ciTypeDef', 'name', 'general', { defaultVisible: true }),
  status:             { col: { key: 'status', labelKey: 'reports.col.status', type: 'badge', group: 'general', configurable: true, sortable: true, filter: 'multi-select', defaultVisible: true }, select: { status: true }, extract: (ci) => ci.status, orderBy: (d) => ({ status: d }) },
  criticality:        { col: { key: 'criticality', labelKey: 'reports.col.criticality', type: 'badge', group: 'general', configurable: true, sortable: true, filter: 'multi-select', defaultVisible: true }, select: { criticality: true }, extract: (ci) => ci.criticality, orderBy: (d) => ({ criticality: d }) },
  environment:        scalar('environment', 'badge', 'general'),
  apiSlug:            scalar('apiSlug', 'string', 'general'),
  inventoryNumber:    scalar('inventoryNumber', 'string', 'general'),
  verificationSource: scalar('verificationSource', 'string', 'general'),
  lastCheckDate:      ciDate('lastCheckDate', 'lastCheckDate', 'general'),
  createdAt:          ciDate('createdAt', 'createdAt', 'general', { defaultVisible: true }),
  updatedAt:          ciDate('updatedAt', 'updatedAt', 'general'),
  // location
  location:           rel('location', 'location', 'name', 'location', { defaultVisible: true }),
  branch:             rel('branch', 'branch', 'name', 'location', { defaultVisible: true }),
  costCenter:         rel('costCenter', 'costCenter', 'name', 'location', { defaultVisible: true }),
  floor:              scalar('floor', 'string', 'location'),
  room:               scalar('room', 'string', 'location'),
  rack:               scalar('rack', 'string', 'location'),
  rackUnit:           scalar('rackUnit', 'string', 'location'),
  assignedUser:       scalar('assignedUser', 'string', 'location'),
  userDni:            scalar('userDni', 'string', 'location'),
  // network
  adminIp:            scalar('adminIp', 'string', 'network'),
  mgmtIp:             scalar('mgmtIp', 'string', 'network'),
  consoleIp:          scalar('consoleIp', 'string', 'network'),
  dns:                scalar('dns', 'string', 'network'),
  vlan:               scalar('vlan', 'string', 'network'),
  hostName:           scalar('hostName', 'string', 'network'),
  // hardware
  cpuModel:           scalar('cpuModel', 'string', 'hardware'),
  vCpus:              scalar('vCpus', 'number', 'hardware'),
  ram:                scalar('ram', 'string', 'hardware'),
  disk:               scalar('disk', 'string', 'hardware'),
  firmwareVersion:    scalar('firmwareVersion', 'string', 'hardware'),
  clusterName:        scalar('clusterName', 'string', 'hardware'),
  ciModel:            rel('ciModel', 'ciModel', 'name', 'hardware'),
  manufacturer:       { col: { key: 'manufacturer', labelKey: 'reports.col.manufacturer', type: 'string', group: 'hardware', configurable: true, sortable: true }, select: { ciModel: { select: { manufacturer: { select: { name: true } } } } }, extract: (ci) => ci.ciModel?.manufacturer?.name ?? '', orderBy: (d) => ({ ciModel: { manufacturer: { name: d } } }) },
  operatingSystem:    rel('operatingSystem', 'operatingSystem', 'name', 'hardware'),
  hwSerialNumber:     hw('hwSerialNumber', 'serialNumber', 'string', 'hardware'),
  hwModel:            hw('hwModel', 'model', 'string', 'hardware'),
  hwManufacturer:     hw('hwManufacturer', 'manufacturer', 'string', 'hardware'),
  sizeU:              hw('sizeU', 'sizeU', 'number', 'hardware'),
  powerW:             hw('powerW', 'powerW', 'number', 'hardware'),
  uPosition:          hw('uPosition', 'uPosition', 'number', 'hardware'),
  orientation:        hw('orientation', 'orientation', 'string', 'hardware'),
  // software
  swVersion:          sw('swVersion', 'version', 'software'),
  swLicenseType:      sw('swLicenseType', 'licenseType', 'software'),
  // governance
  businessOwner:      rel('businessOwner', 'businessOwner', 'email', 'governance'),
  technicalLead:      rel('technicalLead', 'technicalLead', 'email', 'governance'),
  parentCI:           rel('parentCI', 'parentCI', 'name', 'governance'),
  businessImpact:     scalar('businessImpact', 'badge', 'governance'),
  dataClassification: scalar('dataClassification', 'badge', 'governance'),
  recoveryPriority:   scalar('recoveryPriority', 'number', 'governance'),
  rto:                scalar('rto', 'number', 'governance'),
  rpo:                scalar('rpo', 'number', 'governance'),
  spofRisk:           boolBadge('spofRisk', 'governance'),
  containsPii:        boolBadge('containsPii', 'governance'),
  // lifecycle
  eolDate:            ciDate('eolDate', 'eolDate', 'lifecycle'),
  eosDate:            ciDate('eosDate', 'eosDate', 'lifecycle'),
  purchaseDate:       lifeDate('purchaseDate', 'purchase-date'),
  warrantyEndDate:    lifeDate('warrantyEndDate', 'hw-end-of-warranty'),
  deploymentDate:     lifeDate('deploymentDate', 'deployment-date'),
  decommissionDate:   lifeDate('decommissionDate', 'decommission-date'),
  reviewDate:         lifeDate('reviewDate', 'review-date'),
};

const ALL_COLUMNS: ReportColumn[] = Object.values(SPECS).map((s) => s.col);
const DEFAULT_COLUMNS: ReportColumn[] = ALL_COLUMNS.filter((c) => c.defaultVisible);
const DEFAULT_KEYS = DEFAULT_COLUMNS.map((c) => c.key);

function mergeSelect(target: AnyCI, src: AnyCI): AnyCI {
  for (const k of Object.keys(src)) {
    if (src[k] === true) target[k] = true;
    else if (src[k] && typeof src[k] === 'object') {
      if (!target[k] || typeof target[k] !== 'object') target[k] = {};
      mergeSelect(target[k], src[k]);
    }
  }
  return target;
}

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
  columns: DEFAULT_COLUMNS,
  allColumns: ALL_COLUMNS,
  filters: [
    { key: 'ciType',      type: 'multi-select', labelKey: 'reports.filter.ciType' },
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
  async loadFilterOptions(prisma: PrismaClient) {
    const types = await prisma.cIType.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } });
    return { ciType: types.map((t) => ({ value: t.id, label: t.name })) };
  },
  async query(prisma: PrismaClient, filters: ReportFilters): Promise<ReportResult> {
    // resolve requested columns (validate against registry; fall back to defaults)
    const raw = filters['visibleColumns'];
    const requested = (Array.isArray(raw) ? raw : typeof raw === 'string' && raw ? raw.split(',') : [])
      .filter((k: string) => SPECS[k]);
    const cols = requested.length ? requested : DEFAULT_KEYS;

    // build dynamic select (always include id)
    const select: AnyCI = { id: true };
    for (const k of cols) mergeSelect(select, SPECS[k].select as AnyCI);

    const statusFilter      = asArray(filters['status']);
    const criticalityFilter = asArray(filters['criticality']);
    const ciTypeFilter      = asArray(filters['ciType']);
    const search = filters.search?.trim();

    const where = {
      ...(statusFilter ? { status: { in: statusFilter as ('ACTIVO' | 'INACTIVO' | 'RETIRADO')[] } } : {}),
      ...(criticalityFilter ? { criticality: { in: criticalityFilter as ('LOW' | 'MEDIUM' | 'HIGH' | 'MISSION_CRITICAL')[] } } : {}),
      ...(ciTypeFilter ? { ciTypeId: { in: ciTypeFilter } } : {}),
      ...(search ? {
        OR: [
          { name: { contains: escapeLike(search), mode: 'insensitive' as const } },
          { description: { contains: escapeLike(search), mode: 'insensitive' as const } },
        ],
      } : {}),
    };

    // orderBy: only sortable columns with a builder are honoured
    const orderAllow: Record<string, (d: 'asc' | 'desc') => Prisma.CIOrderByWithRelationInput> = {};
    for (const [k, spec] of Object.entries(SPECS)) if (spec.orderBy) orderAllow[k] = spec.orderBy;
    const orderBy = resolveOrderBy<Prisma.CIOrderByWithRelationInput>(filters.sort, sortDir(filters.dir), orderAllow, { name: 'asc' });

    const [total, cis, kpiRaw] = await Promise.all([
      prisma.cI.count({ where }),
      prisma.cI.findMany({
        where,
        select: select as Prisma.CISelect,
        orderBy,
        skip: (filters.page - 1) * filters.limit,
        take: filters.limit,
      }),
      prisma.cI.groupBy({ by: ['status'], _count: { id: true } }),
    ]);

    const countByStatus = Object.fromEntries(kpiRaw.map((r) => [r.status, r._count.id]));

    const data = (cis as AnyCI[]).map((ci) => {
      const row: Record<string, unknown> = { id: ci.id };
      for (const k of cols) row[k] = SPECS[k].extract(ci);
      return row;
    });

    return {
      data,
      total,
      kpis: [
        { labelKey: 'reports.kpi.total',    value: total,                          tone: 'neutral' },
        { labelKey: 'reports.kpi.active',   value: countByStatus['ACTIVO'] ?? 0,   tone: 'green' },
        { labelKey: 'reports.kpi.inactive', value: countByStatus['INACTIVO'] ?? 0, tone: 'amber' },
        { labelKey: 'reports.kpi.retired',  value: countByStatus['RETIRADO'] ?? 0, tone: 'red' },
      ],
    };
  },
});

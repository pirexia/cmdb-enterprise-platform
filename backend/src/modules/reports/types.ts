import type { PrismaClient } from '@prisma/client';

export type UserRole = 'ADMIN' | 'AUDITOR' | 'VIEWER' | 'MANAGER' | 'SOC';
export type ReportCategory = 'inventory' | 'security' | 'financial' | 'compliance' | 'lifecycle' | 'audit';
export type ExportFormat = 'csv' | 'xlsx';
export type ColumnType = 'string' | 'number' | 'date' | 'badge' | 'boolean';
export type FilterType = 'date-range' | 'select' | 'multi-select' | 'search' | 'toggle';

export interface ReportColumn {
  key: string;
  labelKey: string;
  type?: ColumnType;
  sortable?: boolean;
  width?: number;
  // P5 — inline header filtering. When set, ReportTable renders a header control.
  // 'multi-select' reuses the report filter whose key === column.key (finite options).
  // 'text' wires the header input to the global `search` filter.
  filter?: 'multi-select' | 'text';
  // v3.4.2 — configurable column picker
  configurable?: boolean;   // can be shown/hidden by the user
  defaultVisible?: boolean; // shown by default (when no saved config)
  group?: string;           // picker grouping: general|location|network|hardware|software|governance|lifecycle
}

export interface FilterOption {
  value: string;
  labelKey?: string; // i18n key (static options)
  label?: string;    // literal label (dynamic options resolved from DB)
}

export interface ReportFilterDefinition {
  key: string;
  type: FilterType;
  labelKey: string;
  options?: FilterOption[];
}

export interface ReportFilters {
  from?: string;
  to?: string;
  page: number;
  limit: number;
  sort?: string;
  dir?: 'asc' | 'desc';
  search?: string;
  visibleColumns?: string | string[]; // v3.4.2 — column picker selection; csv string at the API boundary

  [k: string]: unknown;
}

export interface ReportKpi {
  labelKey: string;
  value: number | string;
  tone?: 'green' | 'amber' | 'red' | 'neutral';
}

export interface ReportResult {
  data: Record<string, unknown>[];
  total: number;
  kpis?: ReportKpi[];
}

export type ReportQueryFn = (prisma: PrismaClient, filters: ReportFilters) => Promise<ReportResult>;

// P3 — resolve dynamic filter options at request time (e.g. CI types from DB).
// Returns a map of filterKey → options, merged into the static filter defs by /filters.
export type LoadFilterOptionsFn = (prisma: PrismaClient) => Promise<Record<string, FilterOption[]>>;

export interface ReportDefinition {
  id: string;
  nameKey: string;
  descriptionKey: string;
  category: ReportCategory;
  minRole: UserRole;
  icon: string;
  tags: string[];
  columns: ReportColumn[];                // default-visible columns
  allColumns?: ReportColumn[];            // v3.4.2 — full set available for the picker
  filters: ReportFilterDefinition[];
  exportFormats: ExportFormat[];
  source: 'core' | 'plugin';
  pluginId?: string;
  query?: ReportQueryFn;
  // plugin reports: their registered route path handles /data proxy
  routePath?: string;
  // P3 — optional dynamic filter options resolver
  loadFilterOptions?: LoadFilterOptionsFn;
}

// Sent to the frontend — no query/routePath
export interface ReportMeta {
  id: string;
  nameKey: string;
  descriptionKey: string;
  category: ReportCategory;
  minRole: UserRole;
  icon: string;
  tags: string[];
  exportFormats: ExportFormat[];
  columns: ReportColumn[];
  allColumns?: ReportColumn[]; // v3.4.2 — full set for the column picker
  filters: ReportFilterDefinition[];
  source: 'core' | 'plugin';
  available: boolean; // role check result
}

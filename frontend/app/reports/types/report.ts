export type ReportCategory = 'inventory' | 'security' | 'financial' | 'compliance' | 'lifecycle' | 'audit';
export type ExportFormat = 'csv' | 'xlsx';
export type UserRole = 'ADMIN' | 'AUDITOR' | 'VIEWER';
export type ColumnType = 'string' | 'number' | 'date' | 'badge' | 'boolean';
export type FilterType = 'date-range' | 'select' | 'multi-select' | 'search' | 'toggle';

export interface ReportColumn {
  key: string;
  labelKey: string;
  type?: ColumnType;
  sortable?: boolean;
  filter?: 'multi-select' | 'text';
  configurable?: boolean;
  defaultVisible?: boolean;
  group?: string;
}

export interface FilterOption {
  value: string;
  labelKey?: string;
  label?: string;
}

export interface ReportFilterDefinition {
  key: string;
  type: FilterType;
  labelKey: string;
  options?: FilterOption[];
}

export interface ReportKpi {
  labelKey: string;
  value: number | string;
  tone?: 'green' | 'amber' | 'red' | 'neutral';
}

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
  allColumns?: ReportColumn[];
  filters: ReportFilterDefinition[];
  source: 'core' | 'plugin';
  available: boolean;
}

export interface ReportDataResponse {
  data: Record<string, unknown>[];
  total: number;
  page: number;
  limit: number;
  kpis?: ReportKpi[];
}

export interface ReportFilters {
  from?: string;
  to?: string;
  page: number;
  limit: number;
  sort?: string;
  dir?: 'asc' | 'desc';
  search?: string;
  [k: string]: unknown;
}

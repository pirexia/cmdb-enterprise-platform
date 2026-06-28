import type { PrismaClient } from '@prisma/client';

export type UserRole = 'ADMIN' | 'AUDITOR' | 'VIEWER';
export type ReportCategory = 'inventory' | 'security' | 'financial' | 'compliance' | 'lifecycle' | 'audit';
export type ExportFormat = 'csv' | 'xlsx';
export type ColumnType = 'string' | 'number' | 'date' | 'badge';
export type FilterType = 'date-range' | 'select' | 'multi-select' | 'search' | 'toggle';

export interface ReportColumn {
  key: string;
  labelKey: string;
  type?: ColumnType;
  sortable?: boolean;
  width?: number;
}

export interface FilterOption {
  value: string;
  labelKey: string;
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

export interface ReportDefinition {
  id: string;
  nameKey: string;
  descriptionKey: string;
  category: ReportCategory;
  minRole: UserRole;
  icon: string;
  tags: string[];
  columns: ReportColumn[];
  filters: ReportFilterDefinition[];
  exportFormats: ExportFormat[];
  source: 'core' | 'plugin';
  pluginId?: string;
  query?: ReportQueryFn;
  // plugin reports: their registered route path handles /data proxy
  routePath?: string;
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
  filters: ReportFilterDefinition[];
  source: 'core' | 'plugin';
  available: boolean; // role check result
}

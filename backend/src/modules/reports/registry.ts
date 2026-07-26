import type { ReportDefinition, ReportMeta, UserRole } from './types.js';

// v3.5.10 — MANAGER comparte rango con AUDITOR (D3): fuera del módulo de
// horarios es un perfil de lectura equivalente. El rango es lineal, así que por
// sí solo le daría también los informes de auditoría — que D3 excluye
// expresamente. De ahí la denylist: es la excepción que el rango no puede
// expresar. requireAudit (GET /api/audit-logs) sigue admitiendo solo
// ADMIN y AUDITOR.
const ROLE_RANK: Record<UserRole, number> = { VIEWER: 1, MANAGER: 2, AUDITOR: 2, ADMIN: 3 };

/** Informes vetados a MANAGER pese a cumplir el rango. */
const MANAGER_DENIED_REPORTS = new Set(['audit-trail']);

const registry = new Map<string, ReportDefinition>();

export function registerReport(def: ReportDefinition): void {
  if (!def.id || !def.query && !def.routePath) {
    throw new Error(`[reports] Invalid report definition: id="${def.id}" must have query or routePath`);
  }
  if (registry.has(def.id)) {
    console.warn(`[reports] Overwriting report "${def.id}"`);
  }
  registry.set(def.id, def);
}

export function unregisterPluginReports(pluginId: string): void {
  for (const [id, def] of registry) {
    if (def.source === 'plugin' && def.pluginId === pluginId) {
      registry.delete(id);
    }
  }
}

export function getReport(id: string): ReportDefinition | undefined {
  return registry.get(id);
}

export function getAvailableReports(userRole: UserRole): ReportMeta[] {
  const userRank = ROLE_RANK[userRole];
  return Array.from(registry.values()).map((def) => ({
    id: def.id,
    nameKey: def.nameKey,
    descriptionKey: def.descriptionKey,
    category: def.category,
    minRole: def.minRole,
    icon: def.icon,
    tags: def.tags,
    exportFormats: def.exportFormats,
    columns: def.columns,
    ...(def.allColumns ? { allColumns: def.allColumns } : {}),
    filters: def.filters,
    source: def.source,
    available: hasRoleAccess(userRole, def.minRole, def.id),
  }));
}

export function hasRoleAccess(userRole: UserRole, minRole: UserRole, reportId?: string): boolean {
  if (userRole === 'MANAGER' && reportId && MANAGER_DENIED_REPORTS.has(reportId)) return false;
  return ROLE_RANK[userRole] >= ROLE_RANK[minRole];
}

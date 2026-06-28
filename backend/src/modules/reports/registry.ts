import type { ReportDefinition, ReportMeta, UserRole } from './types.js';

const ROLE_RANK: Record<UserRole, number> = { VIEWER: 1, AUDITOR: 2, ADMIN: 3 };

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
    available: userRank >= ROLE_RANK[def.minRole],
  }));
}

export function hasRoleAccess(userRole: UserRole, minRole: UserRole): boolean {
  return ROLE_RANK[userRole] >= ROLE_RANK[minRole];
}

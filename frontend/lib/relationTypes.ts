// ─── CI Relation types — catalogue, categories, colors and restriction matrix ─
// v2.7.0 T8. Mirror of backend/src/relationTypes.ts — keep both in sync.

export const RELATION_TYPES = [
  // Legacy
  "HOSTS", "DEPENDS_ON", "CONNECTED_TO", "PROVIDES_SERVICE", "BACKED_UP_BY",
  // Structural
  "CONTAINS", "COMPOSED_OF", "ATTACHED_TO",
  // Network
  "CONNECTS_TO", "UPLINKS_TO",
  // Power
  "POWERS", "PROTECTS",
  // Logical
  "REPLICATES_TO", "RUNS_ON", "QUERIES", "LICENSES", "MANAGES",
  // v3.4.4 — Containment
  "INSTALLED_IN",
] as const;

export type RelationTypeValue = typeof RELATION_TYPES[number];
export type RelationCategory  = "structural" | "network" | "power" | "logical";

export const RELATION_CATEGORIES: Record<RelationTypeValue, RelationCategory> = {
  HOSTS: "structural", CONTAINS: "structural", COMPOSED_OF: "structural", ATTACHED_TO: "structural",
  CONNECTED_TO: "network", CONNECTS_TO: "network", UPLINKS_TO: "network",
  POWERS: "power", PROTECTS: "power",
  DEPENDS_ON: "logical", PROVIDES_SERVICE: "logical", BACKED_UP_BY: "logical",
  REPLICATES_TO: "logical", RUNS_ON: "logical", QUERIES: "logical", LICENSES: "logical", MANAGES: "logical",
  INSTALLED_IN: "structural",
};

export const CATEGORY_COLORS: Record<RelationCategory, { stroke: string; bg: string }> = {
  structural: { stroke: "#6366f1", bg: "#eef2ff" }, // indigo
  network:    { stroke: "#0d9488", bg: "#f0fdfa" }, // teal
  power:      { stroke: "#f59e0b", bg: "#fffbeb" }, // amber
  logical:    { stroke: "#f97316", bg: "#fff7ed" }, // orange
};

// CI-type restriction matrix (empty = any). Same semantics as backend.
export const RELATION_TYPE_MATRIX: Record<RelationTypeValue, { source: string[]; target: string[] }> = {
  HOSTS:            { source: ["PHYSICAL_SERVER", "VIRTUAL_SERVER", "CLOUD_INSTANCE"], target: [] },
  DEPENDS_ON:       { source: [], target: [] },
  CONNECTED_TO:     { source: [], target: [] },
  PROVIDES_SERVICE: { source: [], target: [] },
  BACKED_UP_BY:     { source: [], target: [] },
  CONTAINS:         { source: ["RACK"], target: [] },
  COMPOSED_OF:      { source: [], target: [] },
  ATTACHED_TO:      { source: [], target: ["RACK", "PHYSICAL_SERVER", "UPS"] },
  CONNECTS_TO:      { source: [], target: ["NETWORK", "NETWORK_EQUIPMENT", "WIFI_AP"] },
  UPLINKS_TO:       { source: ["NETWORK", "NETWORK_EQUIPMENT", "WIFI_AP"], target: ["NETWORK", "NETWORK_EQUIPMENT"] },
  POWERS:           { source: ["UPS"], target: [] },
  PROTECTS:         { source: ["UPS"], target: [] },
  REPLICATES_TO:    { source: ["DATABASE", "STORAGE", "BACKUP", "VIRTUAL_SERVER", "CLOUD_STORAGE", "CLOUD_INSTANCE"], target: ["DATABASE", "STORAGE", "BACKUP", "VIRTUAL_SERVER", "CLOUD_STORAGE", "CLOUD_INSTANCE"] },
  RUNS_ON:          { source: ["SOFTWARE", "DATABASE", "APPLICATION", "BASE_SOFTWARE", "LICENSE"], target: ["PHYSICAL_SERVER", "VIRTUAL_SERVER", "CLOUD_INSTANCE"] },
  QUERIES:          { source: ["SOFTWARE", "APPLICATION"], target: ["DATABASE", "STORAGE", "CLOUD_STORAGE"] },
  LICENSES:         { source: ["LICENSE"], target: [] },
  MANAGES:          { source: [], target: [] },
  // v3.4.4 — Containment
  INSTALLED_IN:     { source: ["PHYSICAL_SERVER", "STORAGE", "NETWORK"], target: ["BLADE_SYSTEM___BLADE_ENCLOSURE", "CONVERGED_INFRASTRUCTURE"] },
};

export const INSTALLED_IN_TARGET_TYPES = RELATION_TYPE_MATRIX.INSTALLED_IN.target;

/** True when the relation type admits the given endpoint type codes (null = legacy CI, always passes). */
export function relationAllowed(
  relationType: RelationTypeValue,
  sourceTypeCode: string | null,
  targetTypeCode: string | null,
): boolean {
  const m = RELATION_TYPE_MATRIX[relationType];
  if (m.source.length > 0 && sourceTypeCode && !m.source.includes(sourceTypeCode)) return false;
  if (m.target.length > 0 && targetTypeCode && !m.target.includes(targetTypeCode)) return false;
  return true;
}

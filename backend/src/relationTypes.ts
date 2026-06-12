// ─── CI Relation types — catalogue, categories and CI-type restriction matrix ──
// v2.7.0 T8. Mirrored in frontend/lib/relationTypes.ts — keep both in sync.

export const VALID_RELATION_TYPES = [
  // Legacy (kept for compat)
  'HOSTS', 'DEPENDS_ON', 'CONNECTED_TO', 'PROVIDES_SERVICE', 'BACKED_UP_BY',
  // Structural
  'CONTAINS', 'COMPOSED_OF', 'ATTACHED_TO',
  // Network
  'CONNECTS_TO', 'UPLINKS_TO',
  // Power
  'POWERS', 'PROTECTS',
  // Logical
  'REPLICATES_TO', 'RUNS_ON', 'QUERIES', 'LICENSES', 'MANAGES',
] as const;

export type RelationTypeValue = typeof VALID_RELATION_TYPES[number];

export const RELATION_CATEGORIES: Record<RelationTypeValue, 'structural' | 'network' | 'power' | 'logical'> = {
  HOSTS: 'structural', CONTAINS: 'structural', COMPOSED_OF: 'structural', ATTACHED_TO: 'structural',
  CONNECTED_TO: 'network', CONNECTS_TO: 'network', UPLINKS_TO: 'network',
  POWERS: 'power', PROTECTS: 'power',
  DEPENDS_ON: 'logical', PROVIDES_SERVICE: 'logical', BACKED_UP_BY: 'logical',
  REPLICATES_TO: 'logical', RUNS_ON: 'logical', QUERIES: 'logical', LICENSES: 'logical', MANAGES: 'logical',
};

// CI-type restriction matrix: which CIType codes may sit at each endpoint.
// Empty array = any type allowed. A CI without ciType always passes (legacy data).
// Custom (non-system) CIType codes pass only on unrestricted endpoints.
export const RELATION_TYPE_MATRIX: Record<RelationTypeValue, { source: string[]; target: string[] }> = {
  // Legacy — unrestricted (existing data must keep validating)
  HOSTS:            { source: ['PHYSICAL_SERVER', 'VIRTUAL_SERVER', 'CLOUD_INSTANCE'], target: [] },
  DEPENDS_ON:       { source: [], target: [] },
  CONNECTED_TO:     { source: [], target: [] },
  PROVIDES_SERVICE: { source: [], target: [] },
  BACKED_UP_BY:     { source: [], target: [] },
  // Structural
  CONTAINS:         { source: ['RACK'], target: [] },
  COMPOSED_OF:      { source: [], target: [] },
  ATTACHED_TO:      { source: [], target: ['RACK', 'PHYSICAL_SERVER', 'UPS'] },
  // Network
  CONNECTS_TO:      { source: [], target: ['NETWORK', 'NETWORK_EQUIPMENT', 'WIFI_AP'] },
  UPLINKS_TO:       { source: ['NETWORK', 'NETWORK_EQUIPMENT', 'WIFI_AP'], target: ['NETWORK', 'NETWORK_EQUIPMENT'] },
  // Power
  POWERS:           { source: ['UPS'], target: [] },
  PROTECTS:         { source: ['UPS'], target: [] },
  // Logical
  REPLICATES_TO:    { source: ['DATABASE', 'STORAGE', 'BACKUP', 'VIRTUAL_SERVER', 'CLOUD_STORAGE', 'CLOUD_INSTANCE'], target: ['DATABASE', 'STORAGE', 'BACKUP', 'VIRTUAL_SERVER', 'CLOUD_STORAGE', 'CLOUD_INSTANCE'] },
  RUNS_ON:          { source: ['SOFTWARE', 'DATABASE', 'APPLICATION', 'BASE_SOFTWARE', 'LICENSE'], target: ['PHYSICAL_SERVER', 'VIRTUAL_SERVER', 'CLOUD_INSTANCE'] },
  QUERIES:          { source: ['SOFTWARE', 'APPLICATION'], target: ['DATABASE', 'STORAGE', 'CLOUD_STORAGE'] },
  LICENSES:         { source: ['LICENSE'], target: [] },
  MANAGES:          { source: [], target: [] },
};

/**
 * Validates a relation against the CI-type matrix.
 * Returns an error message, or null when the relation is allowed.
 * CIs without a resolved type code (null) always pass — legacy data safety.
 */
export function validateRelationCiTypes(
  relationType: string,
  sourceTypeCode: string | null,
  targetTypeCode: string | null,
): string | null {
  const matrix = RELATION_TYPE_MATRIX[relationType as RelationTypeValue];
  if (!matrix) return null; // unknown type rejected earlier by VALID_RELATION_TYPES check
  if (matrix.source.length > 0 && sourceTypeCode && !matrix.source.includes(sourceTypeCode)) {
    return `relationType ${relationType} requiere un CI origen de tipo: ${matrix.source.join(', ')}`;
  }
  if (matrix.target.length > 0 && targetTypeCode && !matrix.target.includes(targetTypeCode)) {
    return `relationType ${relationType} requiere un CI destino de tipo: ${matrix.target.join(', ')}`;
  }
  return null;
}

// backend/src/services/entitySerializer.ts
//
// Entity serializer for the RAG v2 pipeline (wave E1b).
//
// Produces a single <ENTITY_DATA> block per CI / contract root / license root /
// vulnerability, ready to be chunked and embedded by the existing chunker.
//
// Security & compliance highlights (see docs/RAG_ENTITIES_INDEXING_PLAN.md §8):
//  - All raw SQL uses `prisma.$queryRaw` with TAGGED TEMPLATE literals only.
//  - PII is scrubbed (email, Spain DNI/NIE, phone) on every free-text user
//    field, with redaction counts (no values) returned for logging.
//  - Prompt-injection tokens (IGNORA, OLVIDA, SISTEMA:, etc.) and bare
//    HTML-style role tags are stripped with `[REDACTED]` placeholders.
//  - Hard allowlist on CI block — fields like `assignedUser`, `userDni`,
//    `inventoryNumber`, and anything matching /email|phone|telefon|movil/i
//    are NEVER serialized. No spread/...rest is used.
//  - Vulnerabilities expose only CVE id + severity band + status + import
//    date + the affected CI's name/criticality/environment. No description,
//    no source, no exploit info, no exact CVSS float (band only).
//  - The vuln namespace UUID is IMMUTABLE — changing it invalidates every
//    existing vulnerability chunk (documented in SYSADMIN §19).

import { PrismaClient } from '@prisma/client';
import { createHash } from 'crypto';
import type { DocumentSection } from './docParser';

const prisma = new PrismaClient();

// ─── Public types ────────────────────────────────────────────────────────────

export interface EntityParseResult {
  sections: DocumentSection[];
  title: string;
  metadata: Record<string, unknown>;
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** Namespace UUID for RAG vulnerability chunks. IMMUTABLE — never change. */
const RAG_VULN_NAMESPACE = '6c8b1a3e-9d4f-4a2b-8c7d-1e2f3a4b5c6d';

/** Defensive cap on parent-chain walks. */
const MAX_PARENT_DEPTH = 10;

// ─── Helpers: deterministic UUID v5 for vulnerabilities ──────────────────────

export function vulnUuid(ciId: string, cve: string): string {
  // UUID v5 (SHA-1) — Node 22 does not expose a native UUID v5 helper.
  const ns = Buffer.from(RAG_VULN_NAMESPACE.replace(/-/g, ''), 'hex');
  const data = Buffer.concat([ns, Buffer.from(`${ciId}:${cve}`)]);
  const hash = createHash('sha1').update(data).digest();
  hash[6] = (hash[6] & 0x0f) | 0x50; // version 5
  hash[8] = (hash[8] & 0x3f) | 0x80; // variant RFC 4122
  const hex = hash.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

// ─── Helpers: walk to root of contract / license addendum chain ──────────────

export async function getContractRoot(id: string): Promise<string> {
  let current = id;
  for (let depth = 0; depth < MAX_PARENT_DEPTH; depth++) {
    const rows = await prisma.$queryRaw<{ parent_id: string | null }[]>`
      SELECT parent_contract_id::text AS parent_id
      FROM "contracts"
      WHERE id = ${current}::uuid
      LIMIT 1
    `;
    if (rows.length === 0 || !rows[0].parent_id) return current;
    current = rows[0].parent_id;
  }
  console.warn(`[RAG entitySerializer] getContractRoot: depth cap reached for id ${id}`);
  return current;
}

export async function getLicenseRoot(id: string): Promise<string> {
  let current = id;
  for (let depth = 0; depth < MAX_PARENT_DEPTH; depth++) {
    const rows = await prisma.$queryRaw<{ parent_id: string | null }[]>`
      SELECT parent_license_id::text AS parent_id
      FROM "licenses"
      WHERE id = ${current}::uuid
      LIMIT 1
    `;
    if (rows.length === 0 || !rows[0].parent_id) return current;
    current = rows[0].parent_id;
  }
  console.warn(`[RAG entitySerializer] getLicenseRoot: depth cap reached for id ${id}`);
  return current;
}

// ─── Helpers: prompt-injection token stripping (ENT-01) ──────────────────────

const INJECTION_TOKENS: RegExp[] = [
  /\bIGNORA?\b/gi,
  /\bOLVIDA?\b/gi,
  /\bSISTEMA:/gi,
  /\bINSTRUCCIONES?:/gi,
  /\bSEGURIDAD:/gi,
  /\bSYSTEM:/gi,
  /\bIGNORE\b/gi,
  /\bFORGET\b/gi,
];

const ROLE_TAG_RE = /<\/?(system|instruction|prompt|assistant|user)\b[^>]*>/gi;

export function stripInjectionTokens(text: string): string {
  let out = text;
  for (const re of INJECTION_TOKENS) {
    out = out.replace(re, '[REDACTED]');
  }
  out = out.replace(ROLE_TAG_RE, '[REDACTED]');
  return out;
}

// ─── Helpers: PII scrubber (ENT-03 / v2.N3) ──────────────────────────────────

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const SPAIN_DNI_RE = /\b\d{8}[A-HJ-NP-TV-Z]\b/g;
const SPAIN_NIE_RE = /\b[XYZ]\d{7}[A-HJ-NP-TV-Z]\b/g;
const PHONE_RE = /\b(?:\+34\s?)?[6789]\d{2}[\s.-]?\d{3}[\s.-]?\d{3}\b/g;

export function scrubPII(text: string): { clean: string; redactions: number } {
  let count = 0;
  const apply = (s: string, re: RegExp): string =>
    s.replace(re, () => {
      count++;
      return '[PII-REDACTED]';
    });
  let clean = text;
  clean = apply(clean, EMAIL_RE);
  clean = apply(clean, SPAIN_DNI_RE);
  clean = apply(clean, SPAIN_NIE_RE);
  clean = apply(clean, PHONE_RE);
  return { clean, redactions: count };
}

/** Convenience: scrub PII then strip injection tokens, return clean text only. */
function sanitizeFreeText(text: string | null | undefined): { clean: string; redactions: number } {
  if (!text) return { clean: '', redactions: 0 };
  const { clean, redactions } = scrubPII(text);
  return { clean: stripInjectionTokens(clean), redactions };
}

// ─── Helpers: CVSS band from severity ────────────────────────────────────────

function severityBand(severity: string | null | undefined): string {
  switch (String(severity ?? '').toUpperCase()) {
    case 'CRITICAL': return '9.0–10.0';
    case 'HIGH':     return '7.0–8.9';
    case 'MEDIUM':   return '4.0–6.9';
    case 'LOW':      return '0.1–3.9';
    default:         return 'N/A';
  }
}

// ─── Helpers: vuln shape inside CI.vulnerabilities JSON column ───────────────

interface RawVuln {
  cve?: string;
  key?: string;
  severity?: string;
  status?: string;
  importedAt?: string;
}

function asVulnArray(v: unknown): RawVuln[] {
  return Array.isArray(v) ? (v as RawVuln[]) : [];
}

// ─── CI serializer ───────────────────────────────────────────────────────────

interface CIRow {
  id: string;
  name: string;
  api_slug: string;
  status: string;
  criticality: string;
  environment: string;
  spof_risk: boolean;
  contains_pii: boolean;
  description: string | null; // not in schema, kept null — see note in file header
  parent_name: string | null;
  ci_type_name: string | null;
  ci_type_category: string | null;
  location_name: string | null;
  parent_location_name: string | null;
  branch_name: string | null;
  branch_code: string | null;
  cost_center_code: string | null;
  hw_manufacturer: string | null;
  hw_model: string | null;
  hw_serial: string | null;
  sw_version: string | null;
  sw_license_type: string | null;
  vulnerabilities: unknown;
}

export async function serializeCI(id: string): Promise<EntityParseResult> {
  try {
    const rows = await prisma.$queryRaw<CIRow[]>`
      SELECT
        ci.id::text                    AS id,
        ci.name                        AS name,
        ci.api_slug                    AS api_slug,
        ci.status::text                AS status,
        ci.criticality::text           AS criticality,
        ci.environment::text           AS environment,
        ci.spof_risk                   AS spof_risk,
        ci.contains_pii                AS contains_pii,
        NULL::text                     AS description,
        parent.name                    AS parent_name,
        cit.name                       AS ci_type_name,
        cit.category_code              AS ci_type_category,
        loc.name                       AS location_name,
        ploc.name                      AS parent_location_name,
        br.name                        AS branch_name,
        br.branch_code                 AS branch_code,
        cc.code                        AS cost_center_code,
        hw.manufacturer                AS hw_manufacturer,
        hw.model                       AS hw_model,
        hw.serial_number               AS hw_serial,
        sw.version                     AS sw_version,
        sw.license_type                AS sw_license_type,
        ci.vulnerabilities             AS vulnerabilities
      FROM "configuration_items" ci
      LEFT JOIN "configuration_items" parent ON parent.id = ci.parent_ci_id
      LEFT JOIN "ci_types" cit               ON cit.id = ci.ci_type_id
      LEFT JOIN "locations" loc              ON loc.id = ci.location_id
      LEFT JOIN "locations" ploc             ON ploc.id = loc.parent_location_id
      LEFT JOIN "branches" br                ON br.id = ci.branch_id
      LEFT JOIN "cost_centers" cc            ON cc.id = ci.cost_center_id
      LEFT JOIN "hardware_cis" hw            ON hw.ci_id = ci.id
      LEFT JOIN "software_cis" sw            ON sw.ci_id = ci.id
      WHERE ci.id = ${id}::uuid
      LIMIT 1
    `;

    if (rows.length === 0) {
      throw new Error(`CI not found: ${id}`);
    }
    const ci = rows[0];

    // Relations grouped by type
    const relRows = await prisma.$queryRaw<{ relation_type: string; target_name: string }[]>`
      SELECT r.relation_type::text AS relation_type, t.name AS target_name
      FROM "ci_relations" r
      JOIN "configuration_items" t ON t.id = r.target_ci_id
      WHERE r.source_ci_id = ${id}::uuid
      ORDER BY r.relation_type, t.name
    `;

    // Contracts associated (M:M).  _ContractToCI: A → CI, B → Contract.
    const contractRows = await prisma.$queryRaw<{ contract_number: string }[]>`
      SELECT c.contract_number AS contract_number
      FROM "contracts" c
      JOIN "_ContractToCI" j ON j."B" = c.id
      WHERE j."A" = ${id}::uuid
      ORDER BY c.contract_number
    `;

    // Document count
    const docCountRows = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count FROM "document_cis" WHERE ci_id = ${id}::uuid
    `;
    const docCount = Number(docCountRows[0]?.count ?? 0);

    // ── Build text body using strict allowlist (no spread / no ...rest) ───
    const vulns = asVulnArray(ci.vulnerabilities);
    const desc = sanitizeFreeText(ci.description);

    if (desc.redactions > 0) {
      console.info(`[RAG entitySerializer] CI ${id}: scrubbed ${desc.redactions} PII match(es) from description`);
    }

    const lines: string[] = [];
    lines.push(`<ENTITY_DATA type="ci" id="${ci.api_slug}">`);
    lines.push('');
    lines.push(`CI: ${ci.name}`);
    lines.push(`ApiSlug: ${ci.api_slug}`);
    lines.push(`Estado: ${ci.status}`);
    lines.push(`Criticidad: ${ci.criticality}`);
    lines.push(`Entorno: ${ci.environment}`);
    lines.push(`SPOF: ${ci.spof_risk ? 'true' : 'false'}`);
    lines.push(`Contiene PII: ${ci.contains_pii ? 'true' : 'false'}`);
    if (ci.ci_type_name) {
      lines.push(`Tipo: ${ci.ci_type_name}${ci.ci_type_category ? ` (categoría ${ci.ci_type_category})` : ''}`);
    }
    if (ci.location_name) {
      const loc = ci.parent_location_name
        ? `${ci.parent_location_name} > ${ci.location_name}`
        : ci.location_name;
      lines.push(`Ubicación: ${loc}`);
    }
    if (ci.branch_name) {
      lines.push(`Sede: ${ci.branch_name}${ci.branch_code ? ` (${ci.branch_code})` : ''}`);
    }
    if (ci.cost_center_code) {
      lines.push(`Centro de coste: ${ci.cost_center_code}`);
    }
    if (ci.parent_name) {
      lines.push(`Padre: ${ci.parent_name}`);
    }
    if (desc.clean) {
      lines.push(`Descripción: ${desc.clean}`);
    }

    if (ci.hw_manufacturer || ci.hw_model || ci.hw_serial) {
      lines.push('');
      lines.push('Atributos hardware:');
      if (ci.hw_manufacturer) lines.push(`  Fabricante: ${ci.hw_manufacturer}`);
      if (ci.hw_model)        lines.push(`  Modelo: ${ci.hw_model}`);
      if (ci.hw_serial)       lines.push(`  Número de serie: ${ci.hw_serial}`);
    }
    if (ci.sw_version || ci.sw_license_type) {
      lines.push('');
      lines.push('Atributos software:');
      if (ci.sw_version)      lines.push(`  Versión: ${ci.sw_version}`);
      if (ci.sw_license_type) lines.push(`  Tipo de licencia: ${ci.sw_license_type}`);
    }

    if (relRows.length > 0) {
      lines.push('');
      lines.push('Relaciones (5 tipos posibles: HOSTS, DEPENDS_ON, CONNECTED_TO, PROVIDES_SERVICE, BACKED_UP_BY):');
      for (const r of relRows) {
        lines.push(`  - ${r.relation_type} → ${r.target_name}`);
      }
    }

    lines.push('');
    if (contractRows.length > 0) {
      const numbers = contractRows.map((c) => c.contract_number).join(', ');
      lines.push(`Contratos asociados (${contractRows.length}): ${numbers}`);
    } else {
      lines.push('Contratos asociados (0): -');
    }
    lines.push(`Documentos asociados: ${docCount}`);

    if (vulns.length > 0) {
      lines.push('');
      lines.push(`Vulnerabilidades activas: ${vulns.length}`);
      for (const v of vulns) {
        const sev = String(v.severity ?? 'UNKNOWN').toUpperCase();
        const st = String(v.status ?? 'UNKNOWN');
        lines.push(`  - ${v.cve ?? 'CVE-UNKNOWN'} (${sev}, status=${st})`);
      }
    }
    lines.push('');
    lines.push('</ENTITY_DATA>');

    const body = stripInjectionTokens(lines.join('\n'));

    return {
      title: ci.name,
      metadata: {
        entityType: 'ci',
        entityId: ci.id,
        apiSlug: ci.api_slug,
      },
      sections: [{ sectionPath: `CI: ${ci.name}`, text: body }],
    };
  } catch (err) {
    console.error('[RAG entitySerializer] serializeCI failed', { id, message: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}

// ─── Contract serializer ─────────────────────────────────────────────────────

interface ContractRootRow {
  id: string;
  contract_number: string;
  start_date: Date;
  end_date: Date | null;
  vendor_name: string | null;
}

interface ContractAddendumRow {
  id: string;
  contract_number: string;
  start_date: Date;
  end_date: Date | null;
}

function fmtDate(d: Date | null): string {
  if (!d) return '—';
  return d.toISOString().slice(0, 10);
}

export async function serializeContract(rootId: string): Promise<EntityParseResult> {
  try {
    const rootRows = await prisma.$queryRaw<ContractRootRow[]>`
      SELECT
        c.id::text             AS id,
        c.contract_number      AS contract_number,
        c.start_date           AS start_date,
        c.end_date             AS end_date,
        v.name                 AS vendor_name
      FROM "contracts" c
      LEFT JOIN "vendors" v ON v.id = c.vendor_id
      WHERE c.id = ${rootId}::uuid
      LIMIT 1
    `;
    if (rootRows.length === 0) {
      throw new Error(`Contract root not found: ${rootId}`);
    }
    const root = rootRows[0];

    const addendums = await prisma.$queryRaw<ContractAddendumRow[]>`
      SELECT
        id::text          AS id,
        contract_number   AS contract_number,
        start_date        AS start_date,
        end_date          AS end_date
      FROM "contracts"
      WHERE parent_contract_id = ${rootId}::uuid
      ORDER BY start_date ASC, created_at ASC
    `;

    // _ContractToCI: A → CI, B → Contract.
    const ciRows = await prisma.$queryRaw<{ api_slug: string }[]>`
      SELECT ci.api_slug AS api_slug
      FROM "configuration_items" ci
      JOIN "_ContractToCI" j ON j."A" = ci.id
      WHERE j."B" = ${rootId}::uuid
      ORDER BY ci.api_slug
    `;

    const docCountRows = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count FROM "document_contracts" WHERE contract_id = ${rootId}::uuid
    `;
    const docCount = Number(docCountRows[0]?.count ?? 0);

    const lines: string[] = [];
    lines.push(`<ENTITY_DATA type="contract" id="${root.contract_number}">`);
    lines.push('');
    lines.push(`Contrato: ${root.contract_number}`);
    if (root.vendor_name) lines.push(`Vendor: ${root.vendor_name}`);
    lines.push(`Fecha inicio: ${fmtDate(root.start_date)}`);
    lines.push(`Fecha fin: ${fmtDate(root.end_date)}`);

    if (addendums.length > 0) {
      lines.push('');
      lines.push(`Anexos (${addendums.length}):`);
      addendums.forEach((a, i) => {
        lines.push(`  --- Anexo ${i + 1}: ${a.contract_number} (inicio ${fmtDate(a.start_date)}) ---`);
        lines.push(`  Fecha inicio: ${fmtDate(a.start_date)}`);
        lines.push(`  Fecha fin: ${fmtDate(a.end_date)}`);
      });
    }

    lines.push('');
    if (ciRows.length > 0) {
      lines.push(`CIs cubiertos (${ciRows.length}): ${ciRows.map((c) => c.api_slug).join(', ')}`);
    } else {
      lines.push('CIs cubiertos (0): -');
    }
    lines.push(`Documentos asociados: ${docCount}`);
    lines.push('');
    lines.push('</ENTITY_DATA>');

    const body = stripInjectionTokens(lines.join('\n'));

    return {
      title: root.contract_number,
      metadata: {
        entityType: 'contract',
        entityId: root.id,
        contractNumber: root.contract_number,
      },
      sections: [{ sectionPath: `Contrato: ${root.contract_number}`, text: body }],
    };
  } catch (err) {
    console.error('[RAG entitySerializer] serializeContract failed', { rootId, message: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}

// ─── License serializer ──────────────────────────────────────────────────────

interface LicenseRootRow {
  id: string;
  name: string;
  license_number: string;
  start_date: Date;
  end_date: Date | null;
  status: string | null;
  notes: string | null;
  metric_value: number | null;
  metric_unit: string | null;
  currency: string | null;
  vendor_name: string | null;
  license_type_name: string | null;
  license_metric_name: string | null;
}

interface LicenseAddendumRow {
  id: string;
  license_number: string;
  name: string;
  start_date: Date;
  end_date: Date | null;
}

export async function serializeLicense(rootId: string): Promise<EntityParseResult> {
  try {
    const rootRows = await prisma.$queryRaw<LicenseRootRow[]>`
      SELECT
        l.id::text          AS id,
        l.name              AS name,
        l.license_number    AS license_number,
        l.start_date        AS start_date,
        l.end_date          AS end_date,
        l.status            AS status,
        l.notes             AS notes,
        l.metric_value      AS metric_value,
        l.metric_unit       AS metric_unit,
        l.currency          AS currency,
        v.name              AS vendor_name,
        lt.name             AS license_type_name,
        lm.name             AS license_metric_name
      FROM "licenses" l
      LEFT JOIN "vendors" v          ON v.id = l.vendor_id
      LEFT JOIN "license_types" lt   ON lt.id = l.license_type_id
      LEFT JOIN "license_metrics" lm ON lm.id = l.license_metric_id
      WHERE l.id = ${rootId}::uuid
      LIMIT 1
    `;
    if (rootRows.length === 0) {
      throw new Error(`License root not found: ${rootId}`);
    }
    const root = rootRows[0];

    const addendums = await prisma.$queryRaw<LicenseAddendumRow[]>`
      SELECT
        id::text         AS id,
        license_number   AS license_number,
        name             AS name,
        start_date       AS start_date,
        end_date         AS end_date
      FROM "licenses"
      WHERE parent_license_id = ${rootId}::uuid
      ORDER BY start_date ASC, created_at ASC
    `;

    // Aggregate count of license users — NEVER enumerate (decision v2.N4).
    const userCountRows = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count FROM "license_users" WHERE license_id = ${rootId}::uuid
    `;
    const userCount = Number(userCountRows[0]?.count ?? 0);

    const ciRows = await prisma.$queryRaw<{ api_slug: string }[]>`
      SELECT ci.api_slug AS api_slug
      FROM "configuration_items" ci
      JOIN "_LicenseToCI" j ON j."B" = ci.id
      WHERE j."A" = ${rootId}::uuid
      ORDER BY ci.api_slug
    `;

    const docCountRows = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count FROM "document_licenses" WHERE license_id = ${rootId}::uuid
    `;
    const docCount = Number(docCountRows[0]?.count ?? 0);

    const notes = sanitizeFreeText(root.notes);
    if (notes.redactions > 0) {
      console.info(`[RAG entitySerializer] License ${rootId}: scrubbed ${notes.redactions} PII match(es) from notes`);
    }

    const lines: string[] = [];
    lines.push(`<ENTITY_DATA type="license" id="${root.license_number}">`);
    lines.push('');
    lines.push(`Licencia: ${root.name}`);
    lines.push(`Número: ${root.license_number}`);
    if (root.vendor_name) lines.push(`Vendor: ${root.vendor_name}`);
    lines.push(`Fecha inicio: ${fmtDate(root.start_date)}`);
    lines.push(`Fecha fin: ${fmtDate(root.end_date)}`);
    if (root.license_type_name) lines.push(`Tipo: ${root.license_type_name}`);
    if (root.license_metric_name || root.metric_value != null) {
      const unit = root.metric_unit || root.license_metric_name || '';
      const val = root.metric_value != null ? String(root.metric_value) : '';
      lines.push(`Métrica: ${[val, unit].filter(Boolean).join(' ')}`.trimEnd());
    }
    if (root.currency) lines.push(`Moneda: ${root.currency}`);
    if (root.status)   lines.push(`Estado: ${root.status}`);
    if (notes.clean)   lines.push(`Notas: ${notes.clean}`);

    lines.push('');
    lines.push(`Usuarios asignados: ${userCount} (total agregado, sin desglose por sede — no disponible)`);

    if (addendums.length > 0) {
      lines.push('');
      lines.push(`Anexos (${addendums.length}):`);
      addendums.forEach((a, i) => {
        lines.push(`  --- Anexo ${i + 1}: ${a.license_number} (${fmtDate(a.start_date)}) ---`);
        if (a.name) lines.push(`  ${a.name}`);
        lines.push(`  Fecha fin: ${fmtDate(a.end_date)}`);
      });
    }

    lines.push('');
    if (ciRows.length > 0) {
      lines.push(`CIs cubiertos (${ciRows.length}): ${ciRows.map((c) => c.api_slug).join(', ')}`);
    } else {
      lines.push('CIs cubiertos (0): -');
    }
    lines.push(`Documentos asociados: ${docCount}`);
    lines.push('');
    lines.push('</ENTITY_DATA>');

    const body = stripInjectionTokens(lines.join('\n'));

    return {
      title: root.name,
      metadata: {
        entityType: 'license',
        entityId: root.id,
        licenseNumber: root.license_number,
      },
      sections: [{ sectionPath: `Licencia: ${root.name}`, text: body }],
    };
  } catch (err) {
    console.error('[RAG entitySerializer] serializeLicense failed', { rootId, message: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}

// ─── Vulnerability serializer ────────────────────────────────────────────────

interface VulnCIRow {
  api_slug: string;
  name: string;
  criticality: string;
  environment: string;
  vulnerabilities: unknown;
}

// `key` is the vulnerability identity per spec D1 (`${oid}@${port}`, or the
// bare CVE for entries migrated under D1b that never got an `oid`/`port`).
// Callers must resolve `entry.key ?? entry.cve` before calling this function
// — see v3.6.0 B6 (identity is no longer `cve`; `cve` is kept only as an
// optional display value, "" for the 96% of real Greenbone findings that
// carry no CVE at all).
export async function serializeVulnerability(ciId: string, key: string): Promise<EntityParseResult> {
  try {
    const rows = await prisma.$queryRaw<VulnCIRow[]>`
      SELECT
        api_slug, name, criticality::text AS criticality,
        environment::text AS environment, vulnerabilities
      FROM "configuration_items"
      WHERE id = ${ciId}::uuid
      LIMIT 1
    `;
    if (rows.length === 0) {
      throw new Error(`CI not found for vulnerability: ${ciId}`);
    }
    const ci = rows[0];
    const vulns = asVulnArray(ci.vulnerabilities);
    const v = vulns.find((x) => (x.key ?? x.cve) === key);
    if (!v) {
      throw new Error(`Vulnerability ${key} not present in CI ${ciId}`);
    }

    // Display label: the first CVE if this entry has one, otherwise fall
    // back to the identity key (oid@port) so the RAG document title/body is
    // never an empty string (spec D1b — `cve` is "" for the majority).
    const cve = v.cve && v.cve.length > 0 ? v.cve : key;
    const severity = String(v.severity ?? 'UNKNOWN').toUpperCase();
    const band = severityBand(severity);
    const status = String(v.status ?? 'UNKNOWN');
    const imported = v.importedAt ? String(v.importedAt).slice(0, 10) : '—';
    const uuid = vulnUuid(ciId, key);

    const lines: string[] = [];
    lines.push(`<ENTITY_DATA type="vulnerability" id="${uuid}">`);
    lines.push('');
    lines.push(`Vulnerabilidad: ${cve}`);
    lines.push(`CI afectado: ${ci.api_slug} (criticidad ${ci.criticality}, ${ci.environment})`);
    lines.push(`Severidad: ${severity}`);
    lines.push(`CVSS: ${band} (band, no float exacto)`);
    lines.push(`Estado: ${status}`);
    lines.push(`Fecha de importación: ${imported}`);
    lines.push('');
    lines.push('</ENTITY_DATA>');

    const body = stripInjectionTokens(lines.join('\n'));

    return {
      title: cve,
      metadata: {
        entityType: 'vulnerability',
        entityId: uuid,
        ciId,
        key,
        cve,
      },
      sections: [{ sectionPath: `Vulnerabilidad: ${cve}`, text: body }],
    };
  } catch (err) {
    console.error('[RAG entitySerializer] serializeVulnerability failed', { ciId, key, message: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}

// ─── DecommissionPlan serializer ─────────────────────────────────────────────

interface DecommPlanRow {
  id: string;
  name: string;
  status: string;
  created_at: Date;
  completed_at: Date | null;
  system_ci_name: string | null;
}

export async function serializeDecommissionPlan(planId: string): Promise<EntityParseResult> {
  try {
    const planRows = await prisma.$queryRaw<DecommPlanRow[]>`
      SELECT
        p.id::text            AS id,
        p.name                AS name,
        p.status              AS status,
        p.created_at          AS created_at,
        p.completed_at        AS completed_at,
        ci.name               AS system_ci_name
      FROM "decommission_plan" p
      LEFT JOIN "configuration_items" ci ON ci.id = p.system_ci_id
      WHERE p.id = ${planId}::uuid
      LIMIT 1
    `;
    if (planRows.length === 0) {
      throw new Error(`DecommissionPlan not found: ${planId}`);
    }
    const plan = planRows[0];

    // Count associated CIs
    const ciCountRows = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count FROM "decommission_plan_ci" WHERE plan_id = ${planId}::uuid
    `;
    const ciCount = Number(ciCountRows[0]?.count ?? 0);

    // Sample CI names (up to 5 for context/searchability)
    const ciSampleRows = await prisma.$queryRaw<{ ci_name: string }[]>`
      SELECT ci.name AS ci_name
      FROM "decommission_plan_ci" dpc
      JOIN "configuration_items" ci ON ci.id = dpc.ci_id
      WHERE dpc.plan_id = ${planId}::uuid
      ORDER BY ci.name
      LIMIT 5
    `;

    const contractCountRows = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count FROM "decommission_plan_contract" WHERE plan_id = ${planId}::uuid
    `;
    const contractCount = Number(contractCountRows[0]?.count ?? 0);

    const licenseCountRows = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count FROM "decommission_plan_license" WHERE plan_id = ${planId}::uuid
    `;
    const licenseCount = Number(licenseCountRows[0]?.count ?? 0);

    const docCountRows = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count FROM "decommission_plan_document" WHERE plan_id = ${planId}::uuid
    `;
    const docCount = Number(docCountRows[0]?.count ?? 0);

    const planName = sanitizeFreeText(plan.name);

    const lines: string[] = [];
    lines.push(`<ENTITY_DATA type="decommission" id="${plan.id}">`);
    lines.push('');
    lines.push(`Plan de decomisión: ${planName.clean || plan.name}`);
    lines.push(`Estado: ${plan.status}`);
    if (plan.system_ci_name) lines.push(`Sistema: ${plan.system_ci_name}`);
    lines.push(`Fecha creación: ${fmtDate(plan.created_at)}`);
    if (plan.completed_at) lines.push(`Fecha finalización: ${fmtDate(plan.completed_at)}`);
    lines.push('');
    lines.push(`CIs incluidos: ${ciCount}`);
    if (ciSampleRows.length > 0) {
      for (const r of ciSampleRows) {
        lines.push(`  - ${r.ci_name}`);
      }
      if (ciCount > ciSampleRows.length) {
        lines.push(`  ... y ${ciCount - ciSampleRows.length} más`);
      }
    }
    lines.push(`Contratos asociados: ${contractCount}`);
    lines.push(`Licencias asociadas: ${licenseCount}`);
    lines.push(`Documentos asociados: ${docCount}`);
    lines.push('');
    lines.push('</ENTITY_DATA>');

    const body = stripInjectionTokens(lines.join('\n'));

    return {
      title: plan.name,
      metadata: {
        entityType: 'decommission',
        entityId: plan.id,
      },
      sections: [{ sectionPath: `Plan de decomisión: ${plan.name}`, text: body }],
    };
  } catch (err) {
    console.error('[RAG entitySerializer] serializeDecommissionPlan failed', { planId, message: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}

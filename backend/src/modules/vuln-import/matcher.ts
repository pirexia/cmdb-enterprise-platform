import { PrismaClient } from '@prisma/client';

/**
 * CI-matching cascade for Greenbone (and future scanner) hosts.
 *
 * Spec: docs/internal/specs/2026-07-29-v3.6.0-greenbone-real-format-staging.md
 * §3 D3 — "Emparejamiento de CI: cascada determinista, sin adivinar".
 *
 * For a scanned host (identified by IP and/or hostname), tries five match
 * levels against `configuration_items`, in order, and STOPS at the first
 * level that returns any rows:
 *
 *   1. Exact IP  — admin_ip / mgmt_ip / console_ip           → EXACT_IP
 *   2. Exact CI name (case-insensitive)                      → EXACT_NAME
 *   3. Exact host_name, or host_name with domain suffix
 *      stripped (`SRV-X.azkar.com` → `SRV-X`)                → EXACT_HOSTNAME
 *   4. Exact dns column (case-insensitive)                   → EXACT_DNS
 *   5. Fuzzy partial name match (`LIKE '%name%'`, escaped)    → FUZZY
 *
 * Hard rules (do not deviate — see D3):
 *   - If a level returns 2+ DISTINCT CIs, the result is AMBIGUOUS with the
 *     full candidate list. Never fall through to a lower-confidence level,
 *     never pick one (no "first by LENGTH(name)" — that is the exact
 *     anti-pattern this module replaces, see modules/integrations/router.ts
 *     lines ~55-60 in the legacy Greenbone importer).
 *   - If no level returns anything, the result is UNMATCHED.
 *   - FUZZY is never auto-acceptable in the UI layer — that's enforced by
 *     the caller/reviewer flow, not here; this module only reports the
 *     confidence label.
 *
 * Implemented as a single SQL statement (UNION ALL across the five levels,
 * tagged with a `level` column) via Prisma's tagged-template `$queryRaw` —
 * never `$queryRawUnsafe`, never string concatenation. `admin_ip`, `mgmt_ip`,
 * `console_ip`, `host_name`, `dns` and `name` all live directly on
 * `configuration_items` (see backend/prisma/schema.prisma `model CI`) — no
 * join to `hardware_cis` is needed for this cascade.
 */

export type MatchConfidence =
  | 'EXACT_IP'
  | 'EXACT_NAME'
  | 'EXACT_HOSTNAME'
  | 'EXACT_DNS'
  | 'FUZZY';

export interface CICandidate {
  id: string;
  name: string;
}

export type MatchResult =
  | { confidence: MatchConfidence; ci: CICandidate }
  | { confidence: 'AMBIGUOUS'; candidates: CICandidate[] }
  | { confidence: 'UNMATCHED' };

export interface HostIdentity {
  /** Raw IP string as reported by the scanner, e.g. "10.100.12.61". */
  ip?: string | null;
  /** Raw hostname as reported by the scanner, may include a domain suffix. */
  hostname?: string | null;
}

const LEVEL_CONFIDENCE: Record<number, MatchConfidence> = {
  1: 'EXACT_IP',
  2: 'EXACT_NAME',
  3: 'EXACT_HOSTNAME',
  4: 'EXACT_DNS',
  5: 'FUZZY',
};

// Standard dotted-quad IPv4 validator — each octet 0-255, no host part
// beyond 4 groups. Deliberately IPv4-only per the task brief (the fixture
// only has IPv4); a non-matching string (including IPv6) is simply treated
// as "no IP" rather than thrown on, so the cascade degrades to the
// hostname-based levels instead of crashing.
const IPV4_RE =
  /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

export function isValidIPv4(value: string): boolean {
  return IPV4_RE.test(value.trim());
}

/**
 * Escapes SQL LIKE wildcards (`%`, `_`, `\`) so a scanner-supplied hostname
 * can never be used as a wildcard-injection vector in the FUZZY level.
 * Same pattern/order as modules/integrations/router.ts (backslash first).
 */
export function escapeLike(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

type CandidateRow = { level: number; id: string; name: string };

/**
 * Runs the 5-level CI-matching cascade for one scanned host.
 *
 * Both `ip` and `hostname` are optional, but at least one must be usable
 * (a valid IPv4 for `ip`, or any non-empty string for `hostname`) or the
 * result is immediately UNMATCHED without a DB round-trip.
 */
export async function matchHost(
  prisma: PrismaClient,
  identity: HostIdentity,
): Promise<MatchResult> {
  const ipInput = identity.ip?.trim() ?? '';
  const ip = ipInput && isValidIPv4(ipInput) ? ipInput : null;

  const hostnameInput = identity.hostname?.trim() ?? '';
  const hostname = hostnameInput || null;
  const strippedHostname = hostname ? hostname.split('.')[0] : null;
  const likePattern = hostname ? '%' + escapeLike(hostname) + '%' : null;

  if (!ip && !hostname) {
    return { confidence: 'UNMATCHED' };
  }

  const rows = await prisma.$queryRaw<CandidateRow[]>`
    SELECT level, id, name FROM (
      SELECT 1 AS level, id, name FROM "configuration_items"
        WHERE admin_ip = ${ip} OR mgmt_ip = ${ip} OR console_ip = ${ip}
      UNION ALL
      SELECT 2 AS level, id, name FROM "configuration_items"
        WHERE LOWER(name) = LOWER(${hostname})
      UNION ALL
      SELECT 3 AS level, id, name FROM "configuration_items"
        WHERE LOWER(host_name) = LOWER(${hostname})
           OR LOWER(split_part(host_name, '.', 1)) = LOWER(${strippedHostname})
      UNION ALL
      SELECT 4 AS level, id, name FROM "configuration_items"
        WHERE LOWER(dns) = LOWER(${hostname})
      UNION ALL
      SELECT 5 AS level, id, name FROM "configuration_items"
        WHERE LOWER(name) LIKE LOWER(${likePattern}) ESCAPE '\\'
    ) AS candidates
    ORDER BY level ASC
  `;

  if (rows.length === 0) {
    return { confidence: 'UNMATCHED' };
  }

  const minLevel = rows.reduce((min, r) => Math.min(min, Number(r.level)), Infinity);
  const atMinLevel = rows.filter((r) => Number(r.level) === minLevel);

  // Dedup by CI id — the same CI could theoretically satisfy a level's
  // predicate via more than one clause; distinctness is what determines
  // AMBIGUOUS, not row count.
  const distinct = new Map<string, CICandidate>();
  for (const r of atMinLevel) {
    if (!distinct.has(r.id)) distinct.set(r.id, { id: r.id, name: r.name });
  }
  const candidates = [...distinct.values()];

  if (candidates.length > 1) {
    return { confidence: 'AMBIGUOUS', candidates };
  }

  return { confidence: LEVEL_CONFIDENCE[minLevel], ci: candidates[0] };
}

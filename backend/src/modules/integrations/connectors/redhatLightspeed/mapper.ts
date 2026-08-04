import { scoreToSeverity, type ParsedVulnEntry } from '../../../vuln-import/parser.js';
import type { LightspeedSystem, LightspeedCve } from './vulnClient.js';
import type { HostIdentity } from './inventoryClient.js';

// Pure mapping: Red Hat Lightspeed system + its CVEs + inventory identity
// → the SAME ParsedVulnEntry shape Greenbone/CrowdStrike produce, so the
// rest of the pipeline (matcher/classifier/service/router/review UI) treats
// all three sources identically. No I/O here.
//
// Identity (spec §identity): unlike Greenbone (oid@port) and CrowdStrike
// (vulnerability_id), Red Hat's own data model is CVE-centric — the key IS
// the CVE id (`synopsis`).

/** Returns the numeric CVSS score, or `null` if this one CVE has neither
 *  cvss3_score nor cvss2_score. Malformed on a single record — never the
 *  whole pull's problem: one bad record from a live third-party API must
 *  not abort every other CVE on every other system (finding from the final
 *  branch review, Minor #13). Skipped records are logged, never silently
 *  dropped without a trace. */
function toScore(cve: LightspeedCve): number | null {
  const raw = cve.cvss3_score ?? cve.cvss2_score;
  const n = raw !== undefined ? Number(raw) : NaN;
  if (Number.isNaN(n)) {
    console.warn(`[redhatLightspeed mapper] Skipping CVE ${cve.synopsis}: no valid cvss3_score/cvss2_score`);
    return null;
  }
  return n;
}

export function mapSystemToEntries(
  system: LightspeedSystem,
  cves: LightspeedCve[],
  identity: HostIdentity,
): ParsedVulnEntry[] {
  const hostAddress = identity.ip || identity.hostname || system.display_name;

  const entries: ParsedVulnEntry[] = [];
  for (const cve of cves) {
    const severityScore = toScore(cve);
    if (severityScore === null) continue;
    entries.push({
      key: cve.synopsis,
      cves: [cve.synopsis],
      severityScore,
      severity: scoreToSeverity(severityScore),
      name: cve.synopsis,
      summary: cve.description ?? '',
      description: cve.description ?? cve.synopsis,
      solution: '',
      epssScore: undefined,
      hostAddress,
      raw: cve as unknown as Record<string, unknown>,
      redhatImpact: cve.impact,
      knownExploit: cve.known_exploit,
      publicDate: cve.public_date,
    });
  }
  return entries;
}

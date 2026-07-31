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

function toScore(cve: LightspeedCve): number {
  const raw = cve.cvss3_score ?? cve.cvss2_score;
  const n = raw !== undefined ? Number(raw) : NaN;
  if (Number.isNaN(n)) {
    throw new Error(`Red Hat Lightspeed mapper: CVE ${cve.synopsis} has no valid cvss3_score/cvss2_score`);
  }
  return n;
}

export function mapSystemToEntries(
  system: LightspeedSystem,
  cves: LightspeedCve[],
  identity: HostIdentity,
): ParsedVulnEntry[] {
  const hostAddress = identity.ip || identity.hostname || system.display_name;

  return cves.map((cve) => {
    const severityScore = toScore(cve);
    return {
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
    };
  });
}

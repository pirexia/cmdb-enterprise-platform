import { Prisma, PrismaClient } from '@prisma/client';
import type { Vulnerability } from '../../types.js';
import { loadRedHatLightspeedConfig, isConfigured } from './config.js';
import { fetchAccessToken } from './tokenClient.js';
import { listSystems, listSystemCves } from './vulnClient.js';
import { getHostIdentity } from './inventoryClient.js';
import { mapSystemToEntries } from './mapper.js';
import { matchHost, type MatchResult } from '../../../vuln-import/matcher.js';
import { classifyVulnerability } from '../../../vuln-import/classifier.js';
import { vulnImportAudit } from '../../../vuln-import/audit.js';
import { createBatchWithEntries, getCiVulnerabilities, type NewEntryInput } from '../../../vuln-import/queries.js';
import type { UploadSummary } from '../../../vuln-import/service.js';

// Live-pull orchestration for Red Hat Lightspeed — mirrors uploadReport()'s
// per-entry matching/classification loop (vuln-import/service.ts), but
// `parsed.entries` comes from iterating every RHEL system the service
// account can see, one host at a time, instead of a single request body.

export class RedHatLightspeedNotConfiguredError extends Error {
  constructor() { super('Red Hat Lightspeed connector is not configured (missing client credentials).'); this.name = 'RedHatLightspeedNotConfiguredError'; }
}
export class RedHatLightspeedSyncInProgressError extends Error {
  constructor() { super('Red Hat Lightspeed import already in progress.'); this.name = 'RedHatLightspeedSyncInProgressError'; }
}

// In-process lock — same pattern as vcenterService.ts's syncInProgress.
let importInProgress = false;

export interface RedHatLightspeedImportResult {
  batchId: string;
  summary: UploadSummary;
}

export async function runRedHatLightspeedImport(
  prisma: PrismaClient,
  userEmail: string,
): Promise<RedHatLightspeedImportResult> {
  if (importInProgress) throw new RedHatLightspeedSyncInProgressError();
  importInProgress = true;

  try {
    const cfg = loadRedHatLightspeedConfig();
    if (!isConfigured(cfg)) throw new RedHatLightspeedNotConfiguredError();

    const token = await fetchAccessToken(cfg);
    const systems = await listSystems(cfg.baseUrl, token);

    const newEntries: NewEntryInput[] = [];
    const summary: UploadSummary = {
      totalEntries: 0, matched: 0, ambiguous: 0, unmatched: 0,
      nueva: 0, existentePendiente: 0, reaparecida: 0, preselectedInclude: 0,
    };
    const storedVulnsByCi = new Map<string, Vulnerability[]>();

    for (const system of systems) {
      const [cves, identity] = await Promise.all([
        listSystemCves(cfg.baseUrl, token, system.inventory_id),
        getHostIdentity(cfg.baseUrl, token, system.inventory_id),
      ]);
      if (cves.length === 0) continue;

      const parsedEntries = mapSystemToEntries(system, cves, identity);
      const match: MatchResult = await matchHost(prisma, { ip: identity.ip, hostname: identity.hostname });

      let ciId: string | null = null;
      let matchConfidence: string;
      let matchCandidates: unknown | null = null;
      if (match.confidence === 'AMBIGUOUS') {
        matchConfidence = 'AMBIGUOUS'; matchCandidates = match.candidates; summary.ambiguous += parsedEntries.length;
      } else if (match.confidence === 'UNMATCHED') {
        matchConfidence = 'UNMATCHED'; summary.unmatched += parsedEntries.length;
      } else {
        ciId = match.ci.id; matchConfidence = match.confidence; summary.matched += parsedEntries.length;
      }

      let storedVulns: Vulnerability[] | null = null;
      if (ciId) {
        if (!storedVulnsByCi.has(ciId)) storedVulnsByCi.set(ciId, await getCiVulnerabilities(prisma, ciId));
        storedVulns = storedVulnsByCi.get(ciId)!;
      }

      for (const entry of parsedEntries) {
        const classification = classifyVulnerability(
          { key: entry.key, severity: entry.severity, knownExploit: entry.knownExploit },
          storedVulns,
        );
        switch (classification.classification) {
          case 'NUEVA': summary.nueva++; break;
          case 'EXISTENTE_PENDIENTE': summary.existentePendiente++; break;
          case 'REAPARECIDA': summary.reaparecida++; break;
        }
        if (classification.decision === 'INCLUDE') summary.preselectedInclude++;

        newEntries.push({
          hostAddress: entry.hostAddress, ciId, matchConfidence, matchCandidates,
          vulnKey: entry.key, oid: null, port: null, cves: entry.cves,
          severityScore: entry.severityScore, severity: entry.severity, name: entry.name,
          summary: entry.summary || null, solution: entry.solution || null,
          family: null, thread: null, qod: null, epssScore: null,
          // OS facts + hostname carried alongside the raw CVE payload — this
          // is what acceptBatch's correctOperatingSystem() and the review
          // screen's "Crear CI" prefill both read (raw.os_name/os_major/
          // os_minor/hostname). Never derive these from a scanner-specific
          // shape; they come from the same inventory identity used for CI
          // matching above, so they always describe the same host.
          raw: {
            ...(entry.raw as Record<string, unknown>),
            os_name: identity.osName ?? undefined,
            os_major: identity.osMajor ?? undefined,
            os_minor: identity.osMinor ?? undefined,
            hostname: identity.hostname ?? undefined,
          },
          existingStatus: classification.existingStatus,
          classification: classification.classification, decision: classification.decision,
          products: [], exprtRating: null, cisaKev: false, cisaDueDate: null,
          exploitStatus: null, daysOpen: null, externalStatus: null, cvssVersion: null,
          redhatImpact: entry.redhatImpact ?? null,
          knownExploit: entry.knownExploit ?? null,
          publicDate: entry.publicDate ? new Date(entry.publicDate) : null,
        });
      }
    }
    summary.totalEntries = newEntries.length;

    const filename = `redhat-lightspeed-import-${Date.now()}.json`;
    const batch = await prisma.$transaction(async (tx) => {
      const created = await createBatchWithEntries(tx as unknown as Prisma.TransactionClient, {
        source: 'redhat-lightspeed', filename, uploadedBy: userEmail, entries: newEntries,
      });
      await vulnImportAudit(tx as unknown as Prisma.TransactionClient, 'VULN_IMPORT_UPLOAD', 'VulnImportBatch', created.id, userEmail, {
        filename, systemCount: systems.length, ...summary,
      });
      return created;
    });

    return { batchId: batch.id, summary };
  } finally {
    importInProgress = false;
  }
}

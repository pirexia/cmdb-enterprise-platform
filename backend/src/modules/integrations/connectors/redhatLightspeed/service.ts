import { PrismaClient } from '@prisma/client';
import type { Vulnerability } from '../../types.js';
import { loadRedHatLightspeedConfig, isConfigured, type RedHatLightspeedConfig } from './config.js';
import { fetchAccessToken } from './tokenClient.js';
import { listSystems, listSystemCves, type LightspeedSystem } from './vulnClient.js';
import { getHostIdentity } from './inventoryClient.js';
import { mapSystemToEntries } from './mapper.js';
import { matchHost, type MatchResult } from '../../../vuln-import/matcher.js';
import { classifyVulnerability } from '../../../vuln-import/classifier.js';
import { createBatchShell, writeBatchEntries, finalizeBatch, getCiVulnerabilities, type NewEntryInput } from '../../../vuln-import/queries.js';

// Live-pull orchestration for Red Hat Lightspeed — mirrors uploadReport()'s
// per-entry matching/classification loop (vuln-import/service.ts), but
// `parsed.entries` comes from iterating every RHEL system the service
// account can see, one host at a time, instead of a single request body.
//
// Runs the pull in the background (Task 4): a real org's pull (105 systems,
// up to 13,868 total entries) takes long enough — minutes, sequentially,
// each system refreshing its own token — that holding an HTTP request open
// for the whole thing hit the nginx proxy timeout in live verification.
// `runRedHatLightspeedImport` now only does the fast, synchronous part
// (config validation + creating the RUNNING batch shell) and returns
// `{batchId}` immediately; the pull/map/match/write/finalize sequence keeps
// running in this same Node process afterwards, with progress visible on
// the batch row (`progress_phase`/`progress_current`/`progress_total`) for
// the review UI to poll.

export class RedHatLightspeedNotConfiguredError extends Error {
  constructor() { super('Red Hat Lightspeed connector is not configured (missing client credentials).'); this.name = 'RedHatLightspeedNotConfiguredError'; }
}
export class RedHatLightspeedSyncInProgressError extends Error {
  constructor() { super('Red Hat Lightspeed import already in progress.'); this.name = 'RedHatLightspeedSyncInProgressError'; }
}

// In-process lock — same pattern as vcenterService.ts's syncInProgress. Held
// for the entire duration of the background work, not just the synchronous
// part of runRedHatLightspeedImport — released in the .finally() attached to
// the fire-and-forget call below, whichever way the background work ends.
let importInProgress = false;

export interface RedHatLightspeedImportResult {
  batchId: string;
}

export async function runRedHatLightspeedImport(
  prisma: PrismaClient,
  userEmail: string,
): Promise<RedHatLightspeedImportResult> {
  if (importInProgress) throw new RedHatLightspeedSyncInProgressError();
  importInProgress = true;

  const cfg = loadRedHatLightspeedConfig();
  if (!isConfigured(cfg)) {
    // Synchronous failure — release the lock immediately (there is no
    // background work to hold it for) and let the router turn this into a
    // 503 without ever creating a batch row.
    importInProgress = false;
    throw new RedHatLightspeedNotConfiguredError();
  }

  const filename = `redhat-lightspeed-import-${Date.now()}.json`;
  const batch = await prisma.$transaction(async (tx) =>
    createBatchShell(tx, { source: 'redhat-lightspeed', filename, uploadedBy: userEmail }),
  );

  // Fire-and-forget: the caller (router) gets {batchId} as soon as the batch
  // shell above is created, without waiting for any of this. The lock is
  // released here, in the .finally(), once the background work settles
  // either way — never inside runImportBackground itself, so there's a
  // single release point regardless of which of its many awaits throws.
  void runImportBackground(prisma, batch.id, cfg).finally(() => {
    importInProgress = false;
  });

  return { batchId: batch.id };
}

/** Everything after batch creation: pull every system's CVEs, match to a CI,
 *  classify, and write the resulting entries — run in the background after
 *  runRedHatLightspeedImport has already returned {batchId} to its caller.
 *  Any failure anywhere in this function — listSystems, the per-system loop
 *  (token refresh, CVE fetch, host identity, matching, classification), or
 *  writeBatchEntries — leaves the batch FAILED with errorMessage rather than
 *  stuck in RUNNING forever; the batch row already exists (created by the
 *  caller before this function was ever invoked), so finalizeBatch always has
 *  something to update even for a failure that happens before a single entry
 *  is built. */
async function runImportBackground(
  prisma: PrismaClient,
  batchId: string,
  cfg: RedHatLightspeedConfig,
): Promise<void> {
  try {
    let token = await fetchAccessToken(cfg);
    const systems: LightspeedSystem[] = await listSystems(cfg.baseUrl, token);

    await prisma.vulnImportBatch.update({
      where: { id: batchId },
      data: { progressPhase: 'fetching_cves', progressCurrent: 0, progressTotal: systems.length },
    });

    const newEntries: NewEntryInput[] = [];
    const storedVulnsByCi = new Map<string, Vulnerability[]>();

    // Live verification found the bearer token expiring mid-run: a real org
    // (105 systems, one with 4600 open CVEs) takes long enough, sequentially,
    // to outlive a single OAuth2 client_credentials token's lifetime. Refresh
    // it before each system rather than tracking expiry — a service account
    // token exchange is cheap, and this removes the whole class of bug.
    let processed = 0;
    for (const system of systems) {
      token = await fetchAccessToken(cfg);
      const [cves, identity] = await Promise.all([
        listSystemCves(cfg.baseUrl, token, system.inventory_id),
        getHostIdentity(cfg.baseUrl, token, system.inventory_id),
      ]);

      if (cves.length > 0) {
        const parsedEntries = mapSystemToEntries(system, cves, identity);
        const match: MatchResult = await matchHost(prisma, { ip: identity.ip, hostname: identity.hostname });

        let ciId: string | null = null;
        let matchConfidence: string;
        let matchCandidates: unknown | null = null;
        if (match.confidence === 'AMBIGUOUS') {
          matchConfidence = 'AMBIGUOUS'; matchCandidates = match.candidates;
        } else if (match.confidence === 'UNMATCHED') {
          matchConfidence = 'UNMATCHED';
        } else {
          ciId = match.ci.id; matchConfidence = match.confidence;
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

      processed += 1;
      await prisma.vulnImportBatch.update({
        where: { id: batchId },
        data: { progressCurrent: processed },
      });
    }

    await prisma.vulnImportBatch.update({
      where: { id: batchId },
      data: { progressPhase: 'writing', progressCurrent: 0, progressTotal: newEntries.length },
    });

    // writeBatchEntries runs outside any transaction (see its own doc
    // comment for why — chunked createMany, deliberately not one nested
    // write); a failure partway through is still caught by the outer
    // try/catch of this function and recorded via finalizeBatch(...,
    // 'FAILED', ...) below instead of leaving the batch stuck in RUNNING.
    await writeBatchEntries(prisma, batchId, newEntries, (written, total) => {
      // Best-effort — this is progress visibility, not a business fact, so a
      // failed update here must never abort or fail the import itself. Swallow
      // rather than `void`-ing the bare promise, which would otherwise surface
      // as an unhandled rejection.
      prisma.vulnImportBatch.update({
        where: { id: batchId },
        data: { progressCurrent: written, progressTotal: total },
      }).catch(() => {});
    });

    await prisma.$transaction(async (tx) => {
      await finalizeBatch(tx, batchId, 'PENDING');
    });
  } catch (err) {
    await prisma.$transaction(async (tx) => {
      await finalizeBatch(tx, batchId, 'FAILED', err instanceof Error ? err.message : String(err));
    });
  }
}

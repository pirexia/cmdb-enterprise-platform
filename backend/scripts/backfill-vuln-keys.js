#!/usr/bin/env node
/**
 * Backfill `key` on stored CI vulnerabilities (v3.6.0, spec D1b).
 *
 * Entries stored before the Greenbone real-format work (source `greenbone`
 * test data and `crowdstrike`) only have `cve`, not `key`. This script walks
 * every `configuration_items.vulnerabilities` JSONB array and, for each
 * entry missing `key`, sets `key = cve` (leaving it unset if `cve` is also
 * missing/empty — never invent an identity).
 *
 * Idempotent: entries that already have `key` are left untouched, so running
 * this twice is a no-op the second time.
 *
 * Usage:
 *   node backend/scripts/backfill-vuln-keys.js            # apply
 *   node backend/scripts/backfill-vuln-keys.js --dry-run   # report only
 *
 * Run from inside the backend container (has @prisma/client in scope):
 *   podman cp backend/scripts/backfill-vuln-keys.js cmdb-backend-prod:/app/backfill-vuln-keys.js \
 *     && podman exec -w /app cmdb-backend-prod node backfill-vuln-keys.js --dry-run
 */

const { PrismaClient } = require('@prisma/client');

/**
 * Pure transform: given an array of vulnerability entries, return a new
 * array with `key` backfilled from `cve` wherever `key` is missing/empty
 * and `cve` is present. Entries that already have a non-empty `key`, or
 * that have neither `key` nor `cve`, are returned unchanged (same object
 * reference) so the function is trivially idempotent.
 *
 * Returns { entries, changedCount } — changedCount is 0 when nothing needed
 * backfilling, which is how callers detect a no-op run.
 */
function backfillKeys(vulnerabilities) {
  if (!Array.isArray(vulnerabilities)) {
    return { entries: vulnerabilities, changedCount: 0 };
  }

  let changedCount = 0;
  const entries = vulnerabilities.map((entry) => {
    if (!entry || typeof entry !== 'object') return entry;
    const hasKey = typeof entry.key === 'string' && entry.key.length > 0;
    if (hasKey) return entry;

    const cve = typeof entry.cve === 'string' ? entry.cve : '';
    if (!cve) return entry; // nothing to backfill from — leave untouched

    changedCount += 1;
    return { ...entry, key: cve };
  });

  return { entries, changedCount };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const prisma = new PrismaClient();

  try {
    const cis = await prisma.cI.findMany({
      where: { vulnerabilities: { not: null } },
      select: { id: true, vulnerabilities: true },
    });

    let touchedCis = 0;
    let touchedEntries = 0;

    for (const ci of cis) {
      const { entries, changedCount } = backfillKeys(ci.vulnerabilities);
      if (changedCount === 0) continue;

      touchedCis += 1;
      touchedEntries += changedCount;

      if (!dryRun) {
        await prisma.cI.update({
          where: { id: ci.id },
          data: { vulnerabilities: entries },
        });
      }
    }

    const verb = dryRun ? 'would touch' : 'touched';
    console.log(
      `backfill-vuln-keys: scanned ${cis.length} CI(s) with vulnerabilities; ` +
        `${verb} ${touchedCis} CI(s), ${touchedEntries} entrie(s).`
    );
    if (dryRun) {
      console.log('(dry run — no writes performed)');
    }
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('backfill-vuln-keys: failed:', err);
    process.exitCode = 1;
  });
}

module.exports = { backfillKeys };

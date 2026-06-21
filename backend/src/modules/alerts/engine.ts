import { createHash } from 'crypto';
import type { PrismaClient } from '@prisma/client';
import type { AlertItem, AlertCategory, ScanResult } from './schemas.js';

function daysLeftFn(date: Date, now: Date): number {
  return Math.ceil((date.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
}

function toSeverity(days: number): AlertItem['severity'] {
  if (days <= 0) return 'expired';
  if (days <= 7) return 'critical';
  return 'warning';
}

type RuleMap = Record<string, { enabled: boolean; warnDays: number }>;

export async function scanAlerts(
  prisma: PrismaClient,
  rules: Array<{ category: string; enabled: boolean; warnDays: number }>,
): Promise<ScanResult> {
  const now     = new Date();
  const ruleMap = Object.fromEntries(rules.map((r) => [r.category, r])) as RuleMap;
  const items: AlertItem[] = [];

  // ── EOL + EOS (CI direct date, falling back to device model date) ─────────
  if (ruleMap['eol']?.enabled || ruleMap['eos']?.enabled) {
    const warnDays = Math.max(ruleMap['eol']?.warnDays ?? 0, ruleMap['eos']?.warnDays ?? 0);
    const warnDate = new Date(now.getTime() + warnDays * 86_400_000);

    type CIRow = {
      id: string; name: string;
      eol_date: Date | null; eos_date: Date | null;
      model_eol: Date | null; model_eos: Date | null;
    };
    const rows = await prisma.$queryRaw<CIRow[]>`
      SELECT
        ci.id,
        ci.name,
        ci.eol_date,
        ci.eos_date,
        dm.eol_date  AS model_eol,
        dm.eos_date  AS model_eos
      FROM "configuration_items" ci
      LEFT JOIN "device_models" dm  ON dm.id              = ci.ci_model_id
      WHERE (
           (ci.eol_date  IS NOT NULL AND ci.eol_date  <= ${warnDate})
        OR (ci.eos_date  IS NOT NULL AND ci.eos_date  <= ${warnDate})
        OR (ci.eol_date  IS NULL AND dm.eol_date IS NOT NULL AND dm.eol_date <= ${warnDate})
        OR (ci.eos_date  IS NULL AND dm.eos_date IS NOT NULL AND dm.eos_date <= ${warnDate})
      )
    `;

    for (const row of rows) {
      const eolDate  = row.eol_date  ?? row.model_eol;
      const eosDate  = row.eos_date  ?? row.model_eos;
      const eolSrc   = row.eol_date  ? 'direct' : 'from_model';
      const eosSrc   = row.eos_date  ? 'direct' : 'from_model';

      const eolRule = ruleMap['eol'];
      if (eolRule?.enabled && eolDate) {
        const dl = daysLeftFn(eolDate, now);
        if (dl <= eolRule.warnDays) {
          items.push({
            entityId: row.id, entityName: row.name, category: 'eol',
            dateValue: eolDate, daysLeft: dl, severity: toSeverity(dl), detail: eolSrc,
          });
        }
      }

      const eosRule = ruleMap['eos'];
      if (eosRule?.enabled && eosDate) {
        const dl = daysLeftFn(eosDate, now);
        if (dl <= eosRule.warnDays) {
          items.push({
            entityId: row.id, entityName: row.name, category: 'eos',
            dateValue: eosDate, daysLeft: dl, severity: toSeverity(dl), detail: eosSrc,
          });
        }
      }
    }
  }

  // ── Warranty-end (ci_dates join) ──────────────────────────────────────────
  const warrantyRule = ruleMap['warranty'];
  if (warrantyRule?.enabled) {
    const warnDate = new Date(now.getTime() + warrantyRule.warnDays * 86_400_000);
    type WRow = { id: string; name: string; date_value: Date };
    const rows = await prisma.$queryRaw<WRow[]>`
      SELECT ci.id, ci.name, cd.date_value
      FROM   "ci_dates" cd
      JOIN   "date_types" dt             ON dt.id  = cd.date_type_id
      JOIN   "configuration_items" ci    ON ci.id  = cd.ci_id
      WHERE  dt.code = 'warranty-end'
        AND  cd.date_value <= ${warnDate}
    `;
    for (const row of rows) {
      const dl = daysLeftFn(row.date_value, now);
      items.push({
        entityId: row.id, entityName: row.name, category: 'warranty',
        dateValue: row.date_value, daysLeft: dl, severity: toSeverity(dl), detail: '',
      });
    }
  }

  // ── Maintenance-end (ci_dates join) ───────────────────────────────────────
  const maintenanceRule = ruleMap['maintenance'];
  if (maintenanceRule?.enabled) {
    const warnDate = new Date(now.getTime() + maintenanceRule.warnDays * 86_400_000);
    type MRow = { id: string; name: string; date_value: Date };
    const rows = await prisma.$queryRaw<MRow[]>`
      SELECT ci.id, ci.name, cd.date_value
      FROM   "ci_dates" cd
      JOIN   "date_types" dt             ON dt.id  = cd.date_type_id
      JOIN   "configuration_items" ci    ON ci.id  = cd.ci_id
      WHERE  dt.code = 'maintenance-end'
        AND  cd.date_value <= ${warnDate}
    `;
    for (const row of rows) {
      const dl = daysLeftFn(row.date_value, now);
      items.push({
        entityId: row.id, entityName: row.name, category: 'maintenance',
        dateValue: row.date_value, daysLeft: dl, severity: toSeverity(dl), detail: '',
      });
    }
  }

  // ── Contract expiry ───────────────────────────────────────────────────────
  const contractRule = ruleMap['contract'];
  if (contractRule?.enabled) {
    const warnDate = new Date(now.getTime() + contractRule.warnDays * 86_400_000);
    type CRow = { id: string; contract_number: string; vendor_name: string; end_date: Date };
    const rows = await prisma.$queryRaw<CRow[]>`
      SELECT c.id, c.contract_number, v.name AS vendor_name, c.end_date
      FROM   "contracts" c
      JOIN   "vendors"   v ON v.id = c.vendor_id
      WHERE  c.end_date IS NOT NULL
        AND  c.end_date <= ${warnDate}
    `;
    for (const row of rows) {
      const dl = daysLeftFn(row.end_date, now);
      items.push({
        entityId: row.id, entityName: row.contract_number, category: 'contract',
        dateValue: row.end_date, daysLeft: dl, severity: toSeverity(dl),
        detail: row.vendor_name,
      });
    }
  }

  // ── Open vulnerabilities (CRITICAL / HIGH, open status) ──────────────────
  const vulnRule = ruleMap['vulnerability'];
  if (vulnRule?.enabled) {
    type VRow = { id: string; name: string; vulnerabilities: unknown };
    const rows = await prisma.$queryRaw<VRow[]>`
      SELECT id, name, vulnerabilities
      FROM   "configuration_items"
      WHERE  vulnerabilities IS NOT NULL
        AND  jsonb_array_length(vulnerabilities) > 0
    `;
    for (const row of rows) {
      const vulns = (row.vulnerabilities ?? []) as { severity: string; status: string }[];
      const open  = ['NUEVO', 'ASIGNADO', 'EN_CURSO'];
      const crit  = vulns.filter((v) => v.severity === 'CRITICAL' && open.includes(v.status)).length;
      const high  = vulns.filter((v) => v.severity === 'HIGH'     && open.includes(v.status)).length;
      if (crit > 0 || high > 0) {
        items.push({
          entityId: row.id, entityName: row.name, category: 'vulnerability',
          dateValue: null, daysLeft: null, severity: 'open',
          detail: `critical:${crit},high:${high}`,
        });
      }
    }
  }

  // ── License expiry ────────────────────────────────────────────────────────
  const licenseRule = ruleMap['license'];
  if (licenseRule?.enabled) {
    const warnDate = new Date(now.getTime() + licenseRule.warnDays * 86_400_000);
    type LRow = { id: string; name: string; end_date: Date };
    const rows = await prisma.$queryRaw<LRow[]>`
      SELECT id, name, end_date
      FROM   "licenses"
      WHERE  end_date IS NOT NULL
        AND  end_date <= ${warnDate}
    `;
    for (const row of rows) {
      const dl = daysLeftFn(row.end_date, now);
      items.push({
        entityId: row.id, entityName: row.name, category: 'license',
        dateValue: row.end_date, daysLeft: dl, severity: toSeverity(dl), detail: '',
      });
    }
  }

  // ── Breakdown + fingerprint ───────────────────────────────────────────────
  const breakdown: Record<string, number> = {};
  for (const item of items) {
    breakdown[item.category] = (breakdown[item.category] ?? 0) + 1;
  }

  const fingerprint = createHash('sha256')
    .update(JSON.stringify(items.map((i) => `${i.entityId}:${i.category}`).sort()))
    .digest('hex');

  return { items, breakdown, fingerprint, scannedAt: now };
}

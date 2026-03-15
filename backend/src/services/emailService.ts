/**
 * emailService.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Alert engine for CMDB Enterprise Platform (Misión 14).
 *
 * Responsibilities:
 *   1. Scan the database for items that need attention:
 *        · CIs with EoS/EoL date < now + WARN_DAYS (default 30)
 *        · CIs with contract expiry < now + WARN_DAYS
 *        · CIs with at least one CRITICAL vulnerability in status NUEVO/ASIGNADO
 *   2. Build a professional HTML report (inline CSS).
 *   3. Send the report via nodemailer SMTP.
 *   4. If nothing is found → send a brief "all-clear" confirmation.
 *
 * Environment variables (read from process.env):
 *   SMTP_HOST           SMTP server hostname           (default: smtp.gmail.com)
 *   SMTP_PORT           SMTP server port               (default: 587)
 *   SMTP_SECURE         "true" for port 465 SSL        (default: false)
 *   SMTP_USER           SMTP login username
 *   SMTP_PASS           SMTP login password / app-key
 *   ALERT_RECIPIENT     Destination email address
 *   ALERT_WARN_DAYS     Days ahead to warn             (default: 30)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import nodemailer from 'nodemailer';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// ─── Config ───────────────────────────────────────────────────────────────────

const SMTP_HOST      = process.env.SMTP_HOST      ?? 'smtp.gmail.com';
const SMTP_PORT      = parseInt(process.env.SMTP_PORT ?? '587', 10);
const SMTP_SECURE    = process.env.SMTP_SECURE    === 'true';
const SMTP_USER      = process.env.SMTP_USER      ?? '';
const SMTP_PASS      = process.env.SMTP_PASS      ?? '';
const ALERT_RECIPIENT = process.env.ALERT_RECIPIENT ?? '';
const WARN_DAYS      = parseInt(process.env.ALERT_WARN_DAYS ?? '30', 10);

// ─── Types ────────────────────────────────────────────────────────────────────

interface EolAlert {
  id:        string;
  name:      string;
  apiSlug:   string;
  eolDate:   Date | null;
  eosDate:   Date | null;
  ciType:    string | null;
  severity:  'expired' | 'critical' | 'warning';
}

interface ContractAlert {
  id:             string;
  contractNumber: string;
  vendorName:     string;
  endDate:        Date;
  daysLeft:       number;
  severity:       'expired' | 'critical' | 'warning';
}

interface VulnAlert {
  id:           string;
  name:         string;
  criticalCount: number;
  highCount:    number;
}

export interface AlertScanResult {
  eolAlerts:      EolAlert[];
  contractAlerts: ContractAlert[];
  vulnAlerts:     VulnAlert[];
  scannedAt:      Date;
}

// ─── Scanner ──────────────────────────────────────────────────────────────────

export async function runAlertScan(): Promise<AlertScanResult> {
  const now      = new Date();
  const warnDate = new Date(now.getTime() + WARN_DAYS * 24 * 60 * 60 * 1000);

  // ── EoL / EoS alerts ──────────────────────────────────────────────────────
  type CIRow = {
    id: string; name: string; api_slug: string;
    eol_date: Date | null; eos_date: Date | null; ci_type: string | null;
  };
  const rawCIs = await prisma.$queryRaw<CIRow[]>`
    SELECT id, name, api_slug, eol_date, eos_date, ci_type
    FROM "configuration_items"
    WHERE (eol_date IS NOT NULL AND eol_date <= ${warnDate})
       OR (eos_date IS NOT NULL AND eos_date <= ${warnDate})
    ORDER BY COALESCE(eos_date, eol_date) ASC
  `;

  const eolAlerts: EolAlert[] = rawCIs.map((ci) => {
    const relevantDate = ci.eos_date ?? ci.eol_date!;
    const daysLeft     = Math.ceil((relevantDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    const severity: EolAlert['severity'] =
      daysLeft <= 0  ? 'expired'  :
      daysLeft <= 7  ? 'critical' : 'warning';
    return {
      id:       ci.id,
      name:     ci.name,
      apiSlug:  ci.api_slug,
      eolDate:  ci.eol_date,
      eosDate:  ci.eos_date,
      ciType:   ci.ci_type,
      severity,
    };
  });

  // ── Contract expiry alerts ─────────────────────────────────────────────────
  type ContractRow = {
    id: string; contract_number: string; end_date: Date; vendor_name: string;
  };
  const rawContracts = await prisma.$queryRaw<ContractRow[]>`
    SELECT c.id, c.contract_number, c.end_date, v.name AS vendor_name
    FROM "contracts" c
    JOIN "vendors" v ON c.vendor_id = v.id
    WHERE c.end_date IS NOT NULL AND c.end_date <= ${warnDate}
    ORDER BY c.end_date ASC
  `;

  const contractAlerts: ContractAlert[] = rawContracts.map((c) => {
    const daysLeft = Math.ceil((c.end_date.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    const severity: ContractAlert['severity'] =
      daysLeft <= 0 ? 'expired'  :
      daysLeft <= 7 ? 'critical' : 'warning';
    return {
      id:             c.id,
      contractNumber: c.contract_number,
      vendorName:     c.vendor_name,
      endDate:        c.end_date,
      daysLeft,
      severity,
    };
  });

  // ── Critical vulnerability alerts ─────────────────────────────────────────
  type VulnRow = { id: string; name: string; vulnerabilities: unknown };
  const rawVulnCIs = await prisma.$queryRaw<VulnRow[]>`
    SELECT id, name, vulnerabilities
    FROM "configuration_items"
    WHERE vulnerabilities IS NOT NULL
      AND jsonb_array_length(vulnerabilities) > 0
    ORDER BY name ASC
  `;

  const vulnAlerts: VulnAlert[] = [];
  for (const ci of rawVulnCIs) {
    const vulns = (ci.vulnerabilities ?? []) as {
      severity: string; status: string;
    }[];
    const critCount = vulns.filter(
      (v) => v.severity === 'CRITICAL' && ['NUEVO', 'ASIGNADO', 'EN_CURSO'].includes(v.status)
    ).length;
    const highCount = vulns.filter(
      (v) => v.severity === 'HIGH' && ['NUEVO', 'ASIGNADO', 'EN_CURSO'].includes(v.status)
    ).length;
    if (critCount > 0 || highCount > 0) {
      vulnAlerts.push({ id: ci.id, name: ci.name, criticalCount: critCount, highCount });
    }
  }

  return { eolAlerts, contractAlerts, vulnAlerts, scannedAt: now };
}

// ─── HTML template ────────────────────────────────────────────────────────────

function formatDate(d: Date | null): string {
  if (!d) return '—';
  return d.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function severityBadge(sev: string): string {
  const styles: Record<string, string> = {
    expired:  'background:#dc2626;color:#fff;',
    critical: 'background:#ea580c;color:#fff;',
    warning:  'background:#d97706;color:#fff;',
  };
  const labels: Record<string, string> = {
    expired: '⛔ VENCIDO', critical: '🔴 CRÍTICO', warning: '🟠 PRÓXIMO',
  };
  const st = styles[sev] ?? styles['warning'];
  const lb = labels[sev] ?? sev.toUpperCase();
  return `<span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700;${st}">${lb}</span>`;
}

export function buildAlertHtml(result: AlertScanResult): string {
  const { eolAlerts, contractAlerts, vulnAlerts, scannedAt } = result;
  const totalAlerts = eolAlerts.length + contractAlerts.length + vulnAlerts.length;

  const dateStr = scannedAt.toLocaleString('es-ES', {
    day: '2-digit', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });

  // ── All-clear ──
  if (totalAlerts === 0) {
    return `
<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"></head>
<body style="font-family:Arial,sans-serif;background:#f1f5f9;padding:32px;">
  <div style="max-width:600px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 6px rgba(0,0,0,.1);">
    <div style="background:#16a34a;padding:24px 32px;">
      <h1 style="color:#fff;margin:0;font-size:20px;">✅ CMDB Enterprise — Informe de Alertas</h1>
      <p style="color:#bbf7d0;margin:4px 0 0;font-size:13px;">${dateStr}</p>
    </div>
    <div style="padding:32px;text-align:center;">
      <div style="font-size:64px;margin-bottom:16px;">🎉</div>
      <h2 style="color:#16a34a;font-size:22px;">¡Todo en orden!</h2>
      <p style="color:#475569;">No se han detectado alertas activas en los próximos <strong>${WARN_DAYS} días</strong>.</p>
      <p style="color:#94a3b8;font-size:12px;margin-top:24px;">Este mensaje confirma que el Motor de Alertas CMDB está operativo.</p>
    </div>
  </div>
</body></html>`;
  }

  // ── Build sections ──
  const eolSection = eolAlerts.length === 0 ? '' : `
    <h2 style="color:#1e293b;font-size:16px;border-left:4px solid #f59e0b;padding-left:12px;margin-top:32px;">
      🗓️ Fin de Soporte / Fin de Vida (${eolAlerts.length})
    </h2>
    <table style="width:100%;border-collapse:collapse;font-size:13px;">
      <thead>
        <tr style="background:#f8fafc;">
          <th style="text-align:left;padding:8px 12px;border-bottom:2px solid #e2e8f0;color:#64748b;">CI / Activo</th>
          <th style="text-align:left;padding:8px 12px;border-bottom:2px solid #e2e8f0;color:#64748b;">EoL</th>
          <th style="text-align:left;padding:8px 12px;border-bottom:2px solid #e2e8f0;color:#64748b;">EoS</th>
          <th style="text-align:left;padding:8px 12px;border-bottom:2px solid #e2e8f0;color:#64748b;">Estado</th>
        </tr>
      </thead>
      <tbody>
        ${eolAlerts.map((a, i) => `
        <tr style="${i % 2 === 0 ? 'background:#ffffff;' : 'background:#f8fafc;'}">
          <td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;font-weight:600;color:#1e293b;">${a.name}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;color:#475569;">${formatDate(a.eolDate)}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;color:#475569;">${formatDate(a.eosDate)}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;">${severityBadge(a.severity)}</td>
        </tr>`).join('')}
      </tbody>
    </table>`;

  const contractSection = contractAlerts.length === 0 ? '' : `
    <h2 style="color:#1e293b;font-size:16px;border-left:4px solid #3b82f6;padding-left:12px;margin-top:32px;">
      📄 Contratos Próximos a Vencer (${contractAlerts.length})
    </h2>
    <table style="width:100%;border-collapse:collapse;font-size:13px;">
      <thead>
        <tr style="background:#f8fafc;">
          <th style="text-align:left;padding:8px 12px;border-bottom:2px solid #e2e8f0;color:#64748b;">Nº Contrato</th>
          <th style="text-align:left;padding:8px 12px;border-bottom:2px solid #e2e8f0;color:#64748b;">Proveedor</th>
          <th style="text-align:left;padding:8px 12px;border-bottom:2px solid #e2e8f0;color:#64748b;">Vencimiento</th>
          <th style="text-align:left;padding:8px 12px;border-bottom:2px solid #e2e8f0;color:#64748b;">Días</th>
          <th style="text-align:left;padding:8px 12px;border-bottom:2px solid #e2e8f0;color:#64748b;">Estado</th>
        </tr>
      </thead>
      <tbody>
        ${contractAlerts.map((c, i) => `
        <tr style="${i % 2 === 0 ? 'background:#ffffff;' : 'background:#f8fafc;'}">
          <td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;font-weight:600;color:#1e293b;">${c.contractNumber}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;color:#475569;">${c.vendorName}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;color:#475569;">${formatDate(c.endDate)}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;color:${c.daysLeft <= 0 ? '#dc2626' : c.daysLeft <= 7 ? '#ea580c' : '#d97706'};font-weight:700;">
            ${c.daysLeft <= 0 ? 'VENCIDO' : c.daysLeft + 'd'}
          </td>
          <td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;">${severityBadge(c.severity)}</td>
        </tr>`).join('')}
      </tbody>
    </table>`;

  const vulnSection = vulnAlerts.length === 0 ? '' : `
    <h2 style="color:#1e293b;font-size:16px;border-left:4px solid #dc2626;padding-left:12px;margin-top:32px;">
      🛡️ Vulnerabilidades Críticas / Altas Pendientes (${vulnAlerts.length} activos)
    </h2>
    <table style="width:100%;border-collapse:collapse;font-size:13px;">
      <thead>
        <tr style="background:#f8fafc;">
          <th style="text-align:left;padding:8px 12px;border-bottom:2px solid #e2e8f0;color:#64748b;">CI / Activo</th>
          <th style="text-align:center;padding:8px 12px;border-bottom:2px solid #e2e8f0;color:#64748b;">🔴 Críticas</th>
          <th style="text-align:center;padding:8px 12px;border-bottom:2px solid #e2e8f0;color:#64748b;">🟠 Altas</th>
        </tr>
      </thead>
      <tbody>
        ${vulnAlerts.map((v, i) => `
        <tr style="${i % 2 === 0 ? 'background:#ffffff;' : 'background:#f8fafc;'}">
          <td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;font-weight:600;color:#1e293b;">${v.name}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;text-align:center;">
            ${v.criticalCount > 0 ? `<span style="background:#dc2626;color:#fff;padding:2px 10px;border-radius:12px;font-weight:700;">${v.criticalCount}</span>` : '<span style="color:#94a3b8;">—</span>'}
          </td>
          <td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;text-align:center;">
            ${v.highCount > 0 ? `<span style="background:#ea580c;color:#fff;padding:2px 10px;border-radius:12px;font-weight:700;">${v.highCount}</span>` : '<span style="color:#94a3b8;">—</span>'}
          </td>
        </tr>`).join('')}
      </tbody>
    </table>`;

  return `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family:Arial,sans-serif;background:#f1f5f9;padding:32px;margin:0;">
  <div style="max-width:700px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,.12);">

    <!-- Header -->
    <div style="background:linear-gradient(135deg,#1e3a5f 0%,#2563eb 100%);padding:28px 32px;">
      <table style="width:100%;border-collapse:collapse;">
        <tr>
          <td>
            <h1 style="color:#fff;margin:0;font-size:20px;font-weight:700;">🛡️ CMDB Enterprise Platform</h1>
            <p style="color:#93c5fd;margin:4px 0 0;font-size:13px;">Informe de Alertas Proactivas</p>
          </td>
          <td style="text-align:right;">
            <div style="background:rgba(255,255,255,.15);border-radius:8px;padding:10px 16px;display:inline-block;">
              <p style="color:#e0f2fe;margin:0;font-size:11px;text-transform:uppercase;letter-spacing:1px;">Generado</p>
              <p style="color:#fff;margin:2px 0 0;font-size:13px;font-weight:600;">${dateStr}</p>
            </div>
          </td>
        </tr>
      </table>
    </div>

    <!-- Summary bar -->
    <div style="background:#fef3c7;border-bottom:3px solid #f59e0b;padding:16px 32px;">
      <p style="margin:0;color:#92400e;font-size:14px;font-weight:600;">
        ⚠️ Se han detectado <strong>${totalAlerts}</strong> alerta(s) que requieren atención:
        ${eolAlerts.length > 0 ? `<span style="margin-left:12px;">🗓️ ${eolAlerts.length} EoL/EoS</span>` : ''}
        ${contractAlerts.length > 0 ? `<span style="margin-left:12px;">📄 ${contractAlerts.length} Contratos</span>` : ''}
        ${vulnAlerts.length > 0 ? `<span style="margin-left:12px;">🛡️ ${vulnAlerts.length} Vulnerabilidades</span>` : ''}
      </p>
    </div>

    <!-- Body -->
    <div style="padding:24px 32px 32px;">
      ${eolSection}
      ${contractSection}
      ${vulnSection}
    </div>

    <!-- Footer -->
    <div style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:16px 32px;text-align:center;">
      <p style="color:#94a3b8;font-size:11px;margin:0;">
        Este informe ha sido generado automáticamente por el Motor de Alertas CMDB.
        Periodo de vigilancia: próximos <strong>${WARN_DAYS} días</strong>.
      </p>
      <p style="color:#cbd5e1;font-size:10px;margin:4px 0 0;">CMDB Enterprise Platform · DevSecOps · ISO 27001</p>
    </div>
  </div>
</body>
</html>`;
}

// ─── Mailer ───────────────────────────────────────────────────────────────────

function createTransport() {
  if (!SMTP_USER || !SMTP_PASS) {
    console.warn('[EmailService] SMTP_USER or SMTP_PASS not set — using ethereal test account (emails not actually delivered)');
  }
  return nodemailer.createTransport({
    host:   SMTP_HOST,
    port:   SMTP_PORT,
    secure: SMTP_SECURE,
    auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
    tls: { rejectUnauthorized: process.env.NODE_ENV === 'production' },
  });
}

export async function sendAlertReport(html: string, subject?: string): Promise<{ messageId: string; accepted: string[] }> {
  if (!ALERT_RECIPIENT) {
    throw new Error('[EmailService] ALERT_RECIPIENT is not set in environment variables');
  }

  const transporter = createTransport();
  const info = await transporter.sendMail({
    from:    `"CMDB Alertas" <${SMTP_USER || 'cmdb-alerts@noreply.local'}>`,
    to:      ALERT_RECIPIENT,
    subject: subject ?? `⚠️ CMDB Alert Report — ${new Date().toLocaleDateString('es-ES')}`,
    html,
  });

  console.log(`[EmailService] Alert sent → messageId: ${info.messageId}, accepted: ${info.accepted.join(', ')}`);
  return { messageId: info.messageId, accepted: info.accepted as string[] };
}

/**
 * Full pipeline: scan DB → build HTML → send email.
 * Returns the scan result (useful for the test endpoint).
 */
export async function runAndSendAlerts(): Promise<AlertScanResult & { sent: boolean; messageId?: string }> {
  console.log('[AlertEngine] Starting alert scan…');
  const result = await runAlertScan();
  const total  = result.eolAlerts.length + result.contractAlerts.length + result.vulnAlerts.length;

  console.log(`[AlertEngine] Scan complete: ${result.eolAlerts.length} EoL, ${result.contractAlerts.length} contracts, ${result.vulnAlerts.length} vuln CIs`);

  const html = buildAlertHtml(result);

  try {
    const subject = total === 0
      ? `✅ CMDB — Sin alertas (${new Date().toLocaleDateString('es-ES')})`
      : `⚠️ CMDB — ${total} alerta(s) detectada(s) (${new Date().toLocaleDateString('es-ES')})`;
    const { messageId } = await sendAlertReport(html, subject);
    return { ...result, sent: true, messageId };
  } catch (e) {
    console.error('[AlertEngine] Failed to send alert email:', e);
    return { ...result, sent: false };
  }
}

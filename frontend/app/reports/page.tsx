"use client";

import { useEffect, useState, useCallback } from "react";
import {
  FileWarning, FileText, ShieldAlert, Download, Printer,
  RefreshCw, AlertTriangle, CalendarX2, Clock, CheckCircle2,
  BarChart3, ServerCrash, Shield,
} from "lucide-react";
import { apiFetch } from "@/lib/apiFetch";
import { exportToCSV } from "@/lib/csvExport";
import { openPrintWindow, buildReportHTML } from "@/lib/printReport";

// ─── Types ────────────────────────────────────────────────────────────────────

type Criticality  = "LOW" | "MEDIUM" | "HIGH" | "MISSION_CRITICAL";
type Environment  = "DEVELOPMENT" | "TESTING" | "STAGING" | "PRODUCTION";
type VulnSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

interface Vulnerability {
  cve: string; severity: VulnSeverity; description: string;
  status: string; cvss_score?: number | null;
}
interface AgentStatus {
  agentId: string; agentVersion: string; status: string;
  preventionPolicy: string; lastSeen: string; detections: unknown[];
}
interface CI {
  id: string; name: string; apiSlug: string;
  criticality: Criticality; environment: Environment;
  eolDate: string | null; eosDate: string | null;
  hardware: { serialNumber: string; model: string; manufacturer: string } | null;
  software: { version: string; licenseType: string } | null;
  vulnerabilities: Vulnerability[] | null;
  agentStatus: AgentStatus | null;
}
interface ContractRef { id: string; contractNumber: string }
interface Contract {
  id: string; contractNumber: string; startDate: string; endDate: string | null;
  vendor: { id: string; name: string };
  cis: { id: string; name: string }[];
  parentContract: ContractRef | null;
  addendums: ContractRef[];
}

// ─── Date / semaphore helpers ─────────────────────────────────────────────────

function daysUntil(iso: string): number {
  return Math.floor((new Date(iso).getTime() - Date.now()) / 86_400_000);
}
function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("es-ES", { day: "2-digit", month: "short", year: "numeric" });
}
function eolSemaphore(eolDate: string | null, eosDate: string | null) {
  const dates = [eolDate, eosDate].filter(Boolean).map((d) => daysUntil(d!));
  if (dates.length === 0) return { rowClass: "", dotClass: "dot-slate", label: "Sin fecha" };
  const nearest = Math.min(...dates);
  if (nearest < 0)   return { rowClass: "row-red",    dotClass: "dot-red",    label: `Vencido (${Math.abs(nearest)}d)` };
  if (nearest < 90)  return { rowClass: "row-red",    dotClass: "dot-red",    label: `${nearest}d — CRÍTICO` };
  if (nearest < 180) return { rowClass: "row-orange", dotClass: "dot-orange", label: `${nearest}d — Atención` };
  return               { rowClass: "row-green",  dotClass: "dot-green",  label: `${nearest}d — OK` };
}
function contractSemaphore(endDate: string | null) {
  if (!endDate) return { rowClass: "", dotClass: "dot-slate", label: "Sin vencimiento" };
  const d = daysUntil(endDate);
  if (d < 0)  return { rowClass: "row-red",    dotClass: "dot-red",    label: "Vencido" };
  if (d < 60) return { rowClass: "row-orange", dotClass: "dot-orange", label: `Vence en ${d}d` };
  return        { rowClass: "row-green",  dotClass: "dot-green",  label: "Activo" };
}

// ─── Vulnerability risk score ─────────────────────────────────────────────────

function riskScore(vulns: Vulnerability[] | null): number {
  if (!vulns) return 0;
  const open = vulns.filter((v) => v.status !== "RESUELTO");
  return open.reduce((acc, v) => {
    const w = { CRITICAL: 10, HIGH: 5, MEDIUM: 2, LOW: 1 }[v.severity] ?? 0;
    return acc + w;
  }, 0);
}
function vulnCount(vulns: Vulnerability[] | null, sev: VulnSeverity): number {
  if (!vulns) return 0;
  return vulns.filter((v) => v.severity === sev && v.status !== "RESUELTO").length;
}

// ─── Report 1: EoL/EoS Obsolescence ──────────────────────────────────────────

function generateEolReport(cis: CI[]): void {
  const relevant = cis
    .filter((ci) => ci.eolDate || ci.eosDate)
    .sort((a, b) => {
      const minA = Math.min(
        ...[a.eolDate, a.eosDate].filter(Boolean).map((d) => new Date(d!).getTime()),
        Infinity
      );
      const minB = Math.min(
        ...[b.eolDate, b.eosDate].filter(Boolean).map((d) => new Date(d!).getTime()),
        Infinity
      );
      return minA - minB;
    });

  const all = cis.length;
  const withDates = relevant.length;
  const expired = relevant.filter((ci) => {
    const dates = [ci.eolDate, ci.eosDate].filter(Boolean);
    return dates.some((d) => daysUntil(d!) < 0);
  }).length;
  const critical = relevant.filter((ci) => {
    const dates = [ci.eolDate, ci.eosDate].filter(Boolean);
    const nearest = Math.min(...dates.map((d) => daysUntil(d!)));
    return nearest >= 0 && nearest < 90;
  }).length;

  const rows = relevant
    .map((ci) => {
      const sem = eolSemaphore(ci.eolDate, ci.eosDate);
      const type = ci.hardware ? "Hardware" : ci.software ? "Software" : "Otro";
      const critBadge: Record<Criticality, string> = {
        MISSION_CRITICAL: "badge-red", HIGH: "badge-orange", MEDIUM: "badge-yellow", LOW: "badge-slate",
      };
      return `<tr class="${sem.rowClass}">
        <td>${ci.name}<br><span style="font-size:7.5pt;color:#94a3b8">${ci.apiSlug}</span></td>
        <td><span class="badge badge-slate">${type}</span></td>
        <td><span class="badge ${critBadge[ci.criticality]}">${ci.criticality.replace("_", " ")}</span></td>
        <td>${ci.environment.charAt(0) + ci.environment.slice(1).toLowerCase()}</td>
        <td>${fmtDate(ci.eolDate)}</td>
        <td>${fmtDate(ci.eosDate)}</td>
        <td><span class="dot ${sem.dotClass}"></span>${sem.label}</td>
      </tr>`;
    })
    .join("\n");

  const body = `
<section>
  <div class="metrics-grid" style="margin-bottom:20px">
    <div class="metric-card"><div class="metric-value">${all}</div><div class="metric-label">Total CIs</div></div>
    <div class="metric-card" style="border-top:3px solid #6366f1"><div class="metric-value">${withDates}</div><div class="metric-label">Con fechas EoL/EoS</div></div>
    <div class="metric-card" style="border-top:3px solid #ef4444"><div class="metric-value">${expired}</div><div class="metric-label">Vencidos</div></div>
    <div class="metric-card" style="border-top:3px solid #f97316"><div class="metric-value">${critical}</div><div class="metric-label">Críticos (&lt;90 días)</div></div>
  </div>
</section>

<section>
  <div class="section-title">Inventario de Activos con Fechas de Obsolescencia</div>
  <div class="section-note">
    <span class="dot dot-red"></span> Vencido o &lt; 90 días &nbsp;
    <span class="dot dot-orange"></span> &lt; 180 días &nbsp;
    <span class="dot dot-green"></span> OK (&gt; 180 días)
  </div>
  <table>
    <thead><tr>
      <th>CI / Slug</th><th>Tipo</th><th>Criticidad</th><th>Entorno</th>
      <th>Fecha EoL</th><th>Fecha EoS</th><th>Estado</th>
    </tr></thead>
    <tbody>
      ${rows || '<tr><td colspan="7" class="empty-cell">No hay CIs con fechas EoL/EoS registradas.</td></tr>'}
    </tbody>
  </table>
</section>`;

  openPrintWindow(buildReportHTML(
    "Reporte de Obsolescencia",
    "End of Life / End of Support — Ciclo de Vida",
    body
  ));
}

// ─── Report 1 CSV ─────────────────────────────────────────────────────────────

function exportEolCsv(cis: CI[]): void {
  const relevant = cis.filter((ci) => ci.eolDate || ci.eosDate);
  exportToCSV(
    `obsolescencia-eol-${new Date().toISOString().slice(0, 10)}.csv`,
    ["Nombre", "Slug", "Tipo", "Criticidad", "Entorno", "Fecha EoL", "Fecha EoS", "Estado"],
    relevant.map((ci) => {
      const sem = eolSemaphore(ci.eolDate, ci.eosDate);
      const type = ci.hardware ? "Hardware" : ci.software ? "Software" : "Otro";
      return [ci.name, ci.apiSlug, type, ci.criticality, ci.environment, fmtDate(ci.eolDate), fmtDate(ci.eosDate), sem.label];
    })
  );
}

// ─── Report 2: Contracts ──────────────────────────────────────────────────────

function generateContractsReport(contracts: Contract[]): void {
  const total     = contracts.length;
  const addendums = contracts.filter((c) => c.parentContract !== null).length;
  const expired   = contracts.filter((c) => c.endDate && daysUntil(c.endDate) < 0).length;
  const alert60   = contracts.filter((c) => c.endDate && daysUntil(c.endDate) >= 0 && daysUntil(c.endDate) < 60).length;

  const alertBox = alert60 > 0
    ? `<div class="alert-box">⚠️ <strong>${alert60} contrato${alert60 > 1 ? "s" : ""}</strong> vence${alert60 === 1 ? "" : "n"} en los próximos 60 días. Revisa y renueva antes del vencimiento.</div>`
    : "";

  const rows = contracts
    .sort((a, b) => {
      const da = a.endDate ? new Date(a.endDate).getTime() : Infinity;
      const db = b.endDate ? new Date(b.endDate).getTime() : Infinity;
      return da - db;
    })
    .map((c) => {
      const sem = contractSemaphore(c.endDate);
      const isAddendum = !!c.parentContract;
      const type = isAddendum ? "Adenda" : "Principal";
      const typeBadge = isAddendum ? "badge-violet" : "badge-indigo";
      const daysLeft = c.endDate ? daysUntil(c.endDate) : null;
      const daysCell = daysLeft === null ? "—" : daysLeft < 0 ? `Vencido hace ${Math.abs(daysLeft)}d` : `${daysLeft} días`;
      return `<tr class="${sem.rowClass}">
        <td>${c.contractNumber}${isAddendum ? `<br><span style="font-size:7.5pt;color:#a78bfa">Adenda de ${c.parentContract!.contractNumber}</span>` : ""}
          ${c.addendums.length > 0 ? `<br><span style="font-size:7.5pt;color:#94a3b8">${c.addendums.length} adenda${c.addendums.length > 1 ? "s" : ""}</span>` : ""}</td>
        <td>${c.vendor.name}</td>
        <td><span class="badge ${typeBadge}">${type}</span></td>
        <td>${fmtDate(c.startDate)}</td>
        <td>${fmtDate(c.endDate)}</td>
        <td>${daysCell}</td>
        <td><span class="dot ${sem.dotClass}"></span>${sem.label}</td>
        <td>${c.cis.length}</td>
      </tr>`;
    })
    .join("\n");

  const body = `
<section>
  <div class="metrics-grid" style="margin-bottom:20px">
    <div class="metric-card" style="border-top:3px solid #6366f1"><div class="metric-value">${total}</div><div class="metric-label">Total Contratos</div></div>
    <div class="metric-card" style="border-top:3px solid #8b5cf6"><div class="metric-value">${addendums}</div><div class="metric-label">Adendas</div></div>
    <div class="metric-card" style="border-top:3px solid #ef4444"><div class="metric-value">${expired}</div><div class="metric-label">Vencidos</div></div>
    <div class="metric-card" style="border-top:3px solid #f97316"><div class="metric-value">${alert60}</div><div class="metric-label">Vencen en &lt;60 días</div></div>
  </div>
</section>

<section>
  <div class="section-title">Listado Detallado de Contratos y Adendas</div>
  ${alertBox}
  <table>
    <thead><tr>
      <th>Nº Contrato</th><th>Proveedor</th><th>Tipo</th>
      <th>Fecha Inicio</th><th>Fecha Fin</th><th>Días Rest.</th><th>Estado</th><th>CIs</th>
    </tr></thead>
    <tbody>
      ${rows || '<tr><td colspan="8" class="empty-cell">No hay contratos registrados.</td></tr>'}
    </tbody>
  </table>
</section>`;

  openPrintWindow(buildReportHTML(
    "Reporte de Contratos",
    "Gestión de Contratos y Adendas",
    body
  ));
}

// ─── Report 2 CSV ─────────────────────────────────────────────────────────────

function exportContractsCsv(contracts: Contract[]): void {
  exportToCSV(
    `contratos-${new Date().toISOString().slice(0, 10)}.csv`,
    ["Nº Contrato", "Proveedor", "Tipo", "Fecha Inicio", "Fecha Fin", "Días Restantes", "Estado", "CIs Cubiertos"],
    contracts.map((c) => {
      const sem = contractSemaphore(c.endDate);
      const daysLeft = c.endDate ? daysUntil(c.endDate) : null;
      return [
        c.contractNumber, c.vendor.name,
        c.parentContract ? "Adenda" : "Principal",
        fmtDate(c.startDate), fmtDate(c.endDate),
        daysLeft !== null ? daysLeft : "—",
        sem.label, c.cis.length,
      ];
    })
  );
}

// ─── Report 3: Security Executive ────────────────────────────────────────────

function generateSecurityReport(cis: CI[]): void {
  const total   = cis.length;
  const hw      = cis.filter((c) => c.hardware).length;
  const sw      = cis.filter((c) => c.software).length;
  const scanned = cis.filter((c) => c.vulnerabilities !== null).length;
  const withVulns = cis.filter((c) => c.vulnerabilities && c.vulnerabilities.filter((v) => v.status !== "RESUELTO").length > 0).length;
  const clean   = scanned - withVulns;

  // By criticality
  const byCrit: Record<Criticality, number> = {
    MISSION_CRITICAL: cis.filter((c) => c.criticality === "MISSION_CRITICAL").length,
    HIGH:  cis.filter((c) => c.criticality === "HIGH").length,
    MEDIUM: cis.filter((c) => c.criticality === "MEDIUM").length,
    LOW:   cis.filter((c) => c.criticality === "LOW").length,
  };

  // Top 5 by risk score
  const top5 = [...cis]
    .filter((ci) => riskScore(ci.vulnerabilities) > 0)
    .sort((a, b) => riskScore(b.vulnerabilities) - riskScore(a.vulnerabilities))
    .slice(0, 5);

  // CrowdStrike coverage
  const withAgent = cis.filter((c) => c.agentStatus !== null).length;
  const agentActive = cis.filter((c) => c.agentStatus?.status === "normal" && c.agentStatus?.preventionPolicy === "active").length;
  const coveragePct = total > 0 ? Math.round((withAgent / total) * 100) : 0;

  // Bar chart helper
  const bar = (label: string, value: number, color: string) => {
    const pct = total > 0 ? Math.round((value / total) * 100) : 0;
    return `<div class="chart-row">
      <div class="chart-label">${label}</div>
      <div class="chart-track"><div class="chart-fill" style="width:${pct}%;background:${color}"></div></div>
      <div class="chart-count">${value} <span class="chart-pct">(${pct}%)</span></div>
    </div>`;
  };

  const top5Rows = top5.map((ci) => {
    const score = riskScore(ci.vulnerabilities);
    const crit  = vulnCount(ci.vulnerabilities, "CRITICAL");
    const high  = vulnCount(ci.vulnerabilities, "HIGH");
    const med   = vulnCount(ci.vulnerabilities, "MEDIUM");
    const critBadge: Record<Criticality, string> = {
      MISSION_CRITICAL: "badge-red", HIGH: "badge-orange", MEDIUM: "badge-yellow", LOW: "badge-slate",
    };
    return `<tr>
      <td>${ci.name}<br><span style="font-size:7.5pt;color:#94a3b8">${ci.apiSlug}</span></td>
      <td><span class="badge ${critBadge[ci.criticality]}">${ci.criticality.replace("_", " ")}</span></td>
      <td>${ci.environment.charAt(0) + ci.environment.slice(1).toLowerCase()}</td>
      <td><span class="badge badge-red">${crit}</span></td>
      <td><span class="badge badge-orange">${high}</span></td>
      <td><span class="badge badge-yellow">${med}</span></td>
      <td><strong>${score}</strong></td>
    </tr>`;
  }).join("\n");

  const unprotected = cis.filter((c) => !c.agentStatus).map((ci) =>
    `<tr><td>${ci.name}</td><td>${ci.criticality.replace("_", " ")}</td><td>${ci.environment}</td></tr>`
  ).join("\n");

  const body = `
<section>
  <div class="section-title">Resumen Ejecutivo de Infraestructura</div>
  <div class="metrics-grid" style="margin-bottom:0">
    <div class="metric-card" style="border-top:3px solid #6366f1"><div class="metric-value">${total}</div><div class="metric-label">Total CIs</div></div>
    <div class="metric-card" style="border-top:3px solid #10b981"><div class="metric-value">${clean}</div><div class="metric-label">Limpios (escaneados)</div></div>
    <div class="metric-card" style="border-top:3px solid #ef4444"><div class="metric-value">${withVulns}</div><div class="metric-label">Con Vulnerabilidades</div></div>
    <div class="metric-card" style="border-top:3px solid #8b5cf6"><div class="metric-value">${agentActive}</div><div class="metric-label">Agentes CrowdStrike Activos</div></div>
  </div>
</section>

<section>
  <div class="section-title">Distribución por Criticidad</div>
  <div class="chart-container">
    ${bar("Mission Critical", byCrit.MISSION_CRITICAL, "#dc2626")}
    ${bar("High", byCrit.HIGH, "#ea580c")}
    ${bar("Medium", byCrit.MEDIUM, "#ca8a04")}
    ${bar("Low", byCrit.LOW, "#94a3b8")}
  </div>
</section>

<section>
  <div class="section-title">Top 5 Servidores con Mayor Riesgo (Greenbone)</div>
  <div class="section-note">Puntuación de riesgo ponderada: CRITICAL×10 / HIGH×5 / MEDIUM×2 / LOW×1</div>
  <table>
    <thead><tr>
      <th>CI / Slug</th><th>Criticidad</th><th>Entorno</th>
      <th>CRITICAL</th><th>HIGH</th><th>MEDIUM</th><th>Score</th>
    </tr></thead>
    <tbody>
      ${top5Rows || '<tr><td colspan="7" class="empty-cell">No hay vulnerabilidades detectadas.</td></tr>'}
    </tbody>
  </table>
</section>

<section>
  <div class="section-title">Cobertura de Agente CrowdStrike Falcon</div>
  <div class="chart-container" style="margin-bottom:14px">
    ${bar("Con Agente", withAgent, "#4f46e5")}
    ${bar("Agente Activo", agentActive, "#10b981")}
    ${bar("Sin Agente", total - withAgent, "#e2e8f0")}
  </div>
  <div class="section-note">Cobertura total: <strong>${coveragePct}%</strong> (${withAgent} de ${total} CIs tienen agente instalado)</div>
  ${total - withAgent > 0 ? `
  <table style="margin-top:12px">
    <thead><tr><th>CI sin Agente</th><th>Criticidad</th><th>Entorno</th></tr></thead>
    <tbody>${unprotected}</tbody>
  </table>` : ""}
</section>`;

  openPrintWindow(buildReportHTML(
    "Informe Ejecutivo de Seguridad",
    "Salud de Infraestructura — Greenbone + CrowdStrike",
    body
  ));
}

// ─── Summary stats helpers ────────────────────────────────────────────────────

function ciStats(cis: CI[]) {
  const withDates = cis.filter((c) => c.eolDate || c.eosDate).length;
  const urgent = cis.filter((c) => {
    const dates = [c.eolDate, c.eosDate].filter(Boolean);
    if (!dates.length) return false;
    return Math.min(...dates.map((d) => daysUntil(d!))) < 90;
  }).length;
  const totalVulns = cis.reduce((acc, ci) => acc + (ci.vulnerabilities?.filter((v) => v.status !== "RESUELTO").length ?? 0), 0);
  const critVulns  = cis.reduce((acc, ci) => acc + vulnCount(ci.vulnerabilities, "CRITICAL"), 0);
  return { total: cis.length, withDates, urgent, totalVulns, critVulns };
}
function contractStats(contracts: Contract[]) {
  const expiring60 = contracts.filter((c) => c.endDate && daysUntil(c.endDate) >= 0 && daysUntil(c.endDate) < 60).length;
  const expired    = contracts.filter((c) => c.endDate && daysUntil(c.endDate) < 0).length;
  return { total: contracts.length, expiring60, expired };
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ReportsPage() {
  const [cis, setCis]             = useState<CI[]>([]);
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState<string | null>(null);
  const [generating, setGenerating] = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [cisRes, contrRes] = await Promise.all([
        apiFetch("/api/cis"),
        apiFetch("/api/contracts"),
      ]);
      if (!cisRes.ok)   throw new Error(`CIs: ${cisRes.status}`);
      if (!contrRes.ok) throw new Error(`Contratos: ${contrRes.status}`);
      const cisJson   = await cisRes.json();
      const contrJson = await contrRes.json();
      setCis(cisJson.data ?? []);
      setContracts(contrJson.data ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error desconocido");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const runReport = (id: string, fn: () => void) => {
    setGenerating(id);
    setTimeout(() => { fn(); setGenerating(null); }, 100);
  };

  const cs = ciStats(cis);
  const ct = contractStats(contracts);

  // ── Report card definitions ────────────────────────────────────────────────

  const reports = [
    {
      id: "eol",
      icon: <FileWarning className="h-7 w-7 text-orange-500" />,
      color: "ring-orange-200 bg-orange-50",
      iconBg: "bg-orange-100",
      title: "Obsolescencia EoL / EoS",
      subtitle: "End of Life — End of Support",
      description: "Lista todos los CIs con fechas de fin de vida o fin de soporte registradas.",
      includes: [
        "Semáforo visual: 🔴 Vencido/<90d · 🟠 <180d · 🟢 OK",
        "Fechas exactas de EoL y EoS por activo",
        "Ordenado por urgencia (más próximo primero)",
        "Resumen ejecutivo con totales",
      ],
      stats: [
        { label: "Total CIs", value: cs.total, color: "text-slate-700" },
        { label: "Con fechas EoL/EoS", value: cs.withDates, color: "text-indigo-600" },
        { label: "Críticos (<90d)", value: cs.urgent, color: cs.urgent > 0 ? "text-red-600" : "text-emerald-600" },
      ],
      onPDF: () => runReport("eol", () => generateEolReport(cis)),
      onCSV: () => exportEolCsv(cis),
    },
    {
      id: "contracts",
      icon: <FileText className="h-7 w-7 text-indigo-500" />,
      color: "ring-indigo-200 bg-indigo-50",
      iconBg: "bg-indigo-100",
      title: "Contratos y Adendas",
      subtitle: "Gestión de Contratos",
      description: "Consolida todos los contratos con sus adendas, estados y alertas de vencimiento.",
      includes: [
        "Proveedor, nº contrato, tipo (Principal/Adenda)",
        "Fechas de inicio y fin con días restantes",
        "Alertas de contratos próximos a vencer (60 días)",
        "Conteo de CIs cubiertos por contrato",
      ],
      stats: [
        { label: "Total contratos", value: ct.total, color: "text-slate-700" },
        { label: "Vencidos", value: ct.expired, color: ct.expired > 0 ? "text-red-600" : "text-emerald-600" },
        { label: "Vencen en <60d", value: ct.expiring60, color: ct.expiring60 > 0 ? "text-orange-600" : "text-emerald-600" },
      ],
      onPDF: () => runReport("contracts", () => generateContractsReport(contracts)),
      onCSV: () => exportContractsCsv(contracts),
    },
    {
      id: "security",
      icon: <ShieldAlert className="h-7 w-7 text-red-500" />,
      color: "ring-red-200 bg-red-50",
      iconBg: "bg-red-100",
      title: "Informe Ejecutivo de Seguridad",
      subtitle: "Greenbone · CrowdStrike Falcon",
      description: "Informe de salud de infraestructura con métricas de vulnerabilidades y cobertura de agentes.",
      includes: [
        "Resumen: CIs por criticidad (gráfico de barras)",
        "Top 5 servidores con mayor riesgo (score ponderado)",
        "Cobertura de agentes CrowdStrike Falcon",
        "CIs sin protección de agente",
      ],
      stats: [
        { label: "Total CIs", value: cs.total, color: "text-slate-700" },
        { label: "Vulns CRITICAL", value: cs.critVulns, color: cs.critVulns > 0 ? "text-red-600" : "text-emerald-600" },
        { label: "Vulns abiertas", value: cs.totalVulns, color: cs.totalVulns > 0 ? "text-orange-600" : "text-emerald-600" },
      ],
      onPDF: () => runReport("security", () => generateSecurityReport(cis)),
      onCSV: null,
    },
  ];

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header */}
      <header className="border-b border-slate-200 bg-white px-8 py-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <BarChart3 className="h-6 w-6 text-indigo-500" />
            <div>
              <h1 className="text-xl font-bold text-slate-900">Centro de Reportes</h1>
              <p className="text-sm text-slate-500 mt-0.5">
                Genera informes ejecutivos y exporta datos en PDF o CSV
              </p>
            </div>
          </div>
          <button
            onClick={fetchAll}
            disabled={loading}
            className="flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50 transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            Actualizar datos
          </button>
        </div>
      </header>

      <div className="px-8 py-8 max-w-7xl mx-auto space-y-8">

        {/* Error */}
        {error && (
          <div className="flex items-center gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            <AlertTriangle className="h-4 w-4 flex-shrink-0" />
            No se pudo cargar los datos: {error}
          </div>
        )}

        {/* Info Banner */}
        <div className="rounded-2xl border border-indigo-100 bg-indigo-50 px-6 py-4 flex items-start gap-3">
          <Printer className="mt-0.5 h-5 w-5 flex-shrink-0 text-indigo-500" />
          <div>
            <p className="text-sm font-semibold text-indigo-800">¿Cómo funciona?</p>
            <p className="text-sm text-indigo-600 mt-0.5">
              Al hacer clic en <strong>Generar PDF</strong>, se abre una ventana con el informe formateado
              y el diálogo de impresión. Guarda como PDF desde tu navegador.
              Los botones <strong>CSV</strong> exportan los datos crudos para Excel.
            </p>
          </div>
        </div>

        {/* Report Cards */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          {reports.map((rpt) => (
            <div
              key={rpt.id}
              className="flex flex-col rounded-2xl bg-white shadow-sm ring-1 ring-slate-200 overflow-hidden"
            >
              {/* Card Header */}
              <div className={`flex items-start gap-4 px-6 py-5 ring-1 ${rpt.color}`}>
                <div className={`flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-xl ${rpt.iconBg}`}>
                  {rpt.icon}
                </div>
                <div className="min-w-0">
                  <h2 className="font-bold text-slate-900">{rpt.title}</h2>
                  <p className="text-xs text-slate-500 mt-0.5 font-medium">{rpt.subtitle}</p>
                </div>
              </div>

              {/* Card Body */}
              <div className="flex flex-1 flex-col gap-4 p-6">
                <p className="text-sm text-slate-600">{rpt.description}</p>

                {/* Includes list */}
                <ul className="space-y-1.5">
                  {rpt.includes.map((item, i) => (
                    <li key={i} className="flex items-start gap-2 text-xs text-slate-600">
                      <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-emerald-500" />
                      {item}
                    </li>
                  ))}
                </ul>

                {/* Live stats */}
                {!loading && (
                  <div className="grid grid-cols-3 gap-2 rounded-xl bg-slate-50 p-3">
                    {rpt.stats.map((s) => (
                      <div key={s.label} className="text-center">
                        <p className={`text-lg font-bold ${s.color}`}>{s.value}</p>
                        <p className="text-[10px] text-slate-400 leading-tight">{s.label}</p>
                      </div>
                    ))}
                  </div>
                )}
                {loading && (
                  <div className="h-16 animate-pulse rounded-xl bg-slate-100" />
                )}

                {/* Actions */}
                <div className="mt-auto flex flex-col gap-2 pt-2">
                  <button
                    onClick={rpt.onPDF}
                    disabled={loading || generating === rpt.id}
                    className="flex items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700 transition-colors shadow-sm disabled:opacity-50 disabled:cursor-wait"
                  >
                    {generating === rpt.id
                      ? <><RefreshCw className="h-4 w-4 animate-spin" />Generando…</>
                      : <><Printer className="h-4 w-4" />Generar PDF</>
                    }
                  </button>
                  {rpt.onCSV && (
                    <button
                      onClick={rpt.onCSV}
                      disabled={loading}
                      className="flex items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 transition-colors disabled:opacity-50"
                    >
                      <Download className="h-4 w-4" />
                      Exportar CSV
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Quick tips */}
        <section className="rounded-2xl bg-white shadow-sm ring-1 ring-slate-200 p-6">
          <h2 className="mb-4 text-sm font-semibold text-slate-700 flex items-center gap-2">
            <Clock className="h-4 w-4 text-slate-400" />
            Exportaciones rápidas desde las vistas de inventario
          </h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {[
              { href: "/inventory",       icon: <ServerCrash className="h-4 w-4 text-emerald-600" />, label: "Inventario de CIs",        desc: "Botón CSV en tabla de activos" },
              { href: "/vulnerabilities", icon: <Shield className="h-4 w-4 text-red-600" />,          label: "Vulnerabilidades",         desc: "Exporta con filtros aplicados" },
              { href: "/contracts",       icon: <FileText className="h-4 w-4 text-indigo-600" />,     label: "Contratos y Adendas",      desc: "Descarga el listado completo" },
            ].map(({ href, icon, label, desc }) => (
              <a
                key={href}
                href={href}
                className="flex items-center gap-3 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 hover:bg-indigo-50 hover:border-indigo-200 transition-colors"
              >
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-white shadow-sm">
                  {icon}
                </div>
                <div>
                  <p className="text-sm font-medium text-slate-700">{label}</p>
                  <p className="text-xs text-slate-400">{desc}</p>
                </div>
              </a>
            ))}
          </div>
        </section>

      </div>
    </div>
  );
}

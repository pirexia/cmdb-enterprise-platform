"use client";

import { useEffect, useMemo, useState } from "react";
import { Shield, RefreshCw, AlertTriangle, Search, Filter, Download } from "lucide-react";
import { apiFetch } from "@/lib/apiFetch";
import { exportToCSV } from "@/lib/csvExport";

// ─── Types ────────────────────────────────────────────────────────────────────

type VulnSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
type VulnStatus   = "NUEVO" | "ASIGNADO" | "EN_CURSO" | "PARADO" | "RESUELTO";

interface Vulnerability {
  cve:         string;
  severity:    VulnSeverity;
  description: string;
  source?:     string;
  cvss_score?: number | null;
  status:      VulnStatus;
  importedAt?: string;
  updatedAt?:  string;
}

interface CI {
  id:              string;
  name:            string;
  apiSlug:         string;
  vulnerabilities: Vulnerability[] | null;
}

interface VulnRow extends Vulnerability {
  ciId:   string;
  ciName: string;
  ciSlug: string;
}

// ─── Style maps ───────────────────────────────────────────────────────────────

const SEVERITY_STYLES: Record<VulnSeverity, string> = {
  CRITICAL: "bg-red-100 text-red-700 ring-red-200",
  HIGH:     "bg-orange-100 text-orange-700 ring-orange-200",
  MEDIUM:   "bg-yellow-100 text-yellow-700 ring-yellow-200",
  LOW:      "bg-slate-100 text-slate-600 ring-slate-200",
};

const STATUS_STYLES: Record<VulnStatus, { pill: string; label: string }> = {
  NUEVO:    { pill: "bg-blue-100 text-blue-700",    label: "Nuevo" },
  ASIGNADO: { pill: "bg-purple-100 text-purple-700", label: "Asignado" },
  EN_CURSO: { pill: "bg-yellow-100 text-yellow-700", label: "En Curso" },
  PARADO:   { pill: "bg-orange-100 text-orange-700", label: "Parado" },
  RESUELTO: { pill: "bg-emerald-100 text-emerald-700", label: "Resuelto" },
};

const ALL_STATUSES: VulnStatus[] = ["NUEVO", "ASIGNADO", "EN_CURSO", "PARADO", "RESUELTO"];

// ─── Summary count bar ────────────────────────────────────────────────────────

function SeverityDot({ severity }: { severity: VulnSeverity }) {
  const colors = { CRITICAL: "bg-red-500", HIGH: "bg-orange-400", MEDIUM: "bg-yellow-400", LOW: "bg-slate-300" };
  return <span className={`inline-block h-2.5 w-2.5 rounded-full flex-shrink-0 ${colors[severity]}`} />;
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function VulnerabilitiesPage() {
  const [allRows, setAllRows] = useState<VulnRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);
  const [search, setSearch]   = useState("");
  const [filterSev, setFilterSev] = useState<VulnSeverity | "ALL">("ALL");
  const [filterStatus, setFilterStatus] = useState<VulnStatus | "ALL">("ALL");
  const [updating, setUpdating] = useState<Set<string>>(new Set());

  const fetchAll = async () => {
    setLoading(true); setError(null);
    try {
      const res = await apiFetch("/api/cis");
      if (!res.ok) throw new Error(`Status ${res.status}`);
      const json: { data: CI[] } = await res.json();

      const rows: VulnRow[] = [];
      for (const ci of json.data) {
        for (const v of ci.vulnerabilities ?? []) {
          rows.push({ ...v, ciId: ci.id, ciName: ci.name, ciSlug: ci.apiSlug });
        }
      }
      setAllRows(rows);
    } catch (err) { setError(err instanceof Error ? err.message : "Unknown error"); }
    finally { setLoading(false); }
  };

  useEffect(() => { fetchAll(); }, []);

  const handleStatusChange = async (ciId: string, cve: string, status: VulnStatus) => {
    const key = `${ciId}:${cve}`;
    setUpdating((prev) => new Set(prev).add(key));

    try {
      const res = await apiFetch("/api/vulnerabilities", {
        method: "PATCH",
        body:   JSON.stringify({ ciId, cve, status }),
      });

      if (!res.ok) {
        const ct = res.headers.get("content-type") ?? "";
        const msg = ct.includes("application/json")
          ? (await res.json()).error
          : `Error ${res.status}`;
        throw new Error(msg);
      }

      // Optimistic update — no need to refetch
      setAllRows((prev) =>
        prev.map((r) =>
          r.ciId === ciId && r.cve === cve ? { ...r, status } : r
        )
      );
    } catch (err) {
      console.error("Failed to update status:", err);
    } finally {
      setUpdating((prev) => { const n = new Set(prev); n.delete(key); return n; });
    }
  };

  // ── Filtered rows ──────────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    return allRows.filter((r) => {
      if (filterSev !== "ALL" && r.severity !== filterSev) return false;
      if (filterStatus !== "ALL" && r.status !== filterStatus) return false;
      if (search && !r.ciName.toLowerCase().includes(search.toLowerCase()) &&
          !r.cve.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });
  }, [allRows, filterSev, filterStatus, search]);

  const handleExportCSV = () => {
    exportToCSV(
      `vulnerabilidades-${new Date().toISOString().slice(0, 10)}.csv`,
      ["CI", "Slug", "CVE", "Severidad", "CVSS Score", "Descripción", "Fuente", "Estado", "Importado"],
      filtered.map((row) => [
        row.ciName, row.ciSlug, row.cve, row.severity,
        row.cvss_score ?? "",
        row.description,
        row.source ?? "manual",
        STATUS_STYLES[row.status]?.label ?? row.status,
        row.importedAt ? new Date(row.importedAt).toLocaleDateString("es-ES") : "",
      ])
    );
  };

  // ── Summary stats ──────────────────────────────────────────────────────────
  const counts = useMemo(() => ({
    critical: allRows.filter((r) => r.severity === "CRITICAL").length,
    high:     allRows.filter((r) => r.severity === "HIGH").length,
    medium:   allRows.filter((r) => r.severity === "MEDIUM").length,
    low:      allRows.filter((r) => r.severity === "LOW").length,
    resuelto: allRows.filter((r) => r.status === "RESUELTO").length,
    open:     allRows.filter((r) => r.status !== "RESUELTO").length,
  }), [allRows]);

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header */}
      <header className="border-b border-slate-200 bg-white px-8 py-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Shield className="h-5 w-5 text-indigo-500" />
            <div>
              <h1 className="text-xl font-bold text-slate-900">Gestión de Vulnerabilidades</h1>
              <p className="text-sm text-slate-500 mt-0.5">
                {loading ? "Cargando…" : `${allRows.length} hallazgos en total · ${counts.open} abiertos`}
              </p>
            </div>
          </div>
          <button onClick={fetchAll} className="flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50 transition-colors">
            <RefreshCw className="h-3.5 w-3.5" />Actualizar
          </button>
        </div>
      </header>

      <div className="px-8 py-8 max-w-7xl mx-auto space-y-6">
        {/* Summary cards */}
        {!loading && !error && (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-6">
            {[
              { label: "CRITICAL", value: counts.critical, color: "bg-red-50 text-red-700 ring-red-200" },
              { label: "HIGH",     value: counts.high,     color: "bg-orange-50 text-orange-700 ring-orange-200" },
              { label: "MEDIUM",   value: counts.medium,   color: "bg-yellow-50 text-yellow-700 ring-yellow-200" },
              { label: "LOW",      value: counts.low,      color: "bg-slate-50 text-slate-600 ring-slate-200" },
              { label: "Abiertos", value: counts.open,     color: "bg-indigo-50 text-indigo-700 ring-indigo-200" },
              { label: "Resueltos",value: counts.resuelto, color: "bg-emerald-50 text-emerald-700 ring-emerald-200" },
            ].map(({ label, value, color }) => (
              <div key={label} className={`rounded-xl px-4 py-3 ring-1 ring-inset ${color}`}>
                <p className="text-2xl font-bold">{value}</p>
                <p className="text-xs font-medium mt-0.5 text-slate-500">{label}</p>
              </div>
            ))}
          </div>
        )}

        {/* Table card */}
        <div className="rounded-2xl bg-white shadow-sm ring-1 ring-slate-200 overflow-hidden">
          {/* Filters toolbar */}
          <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 px-6 py-4">
            {/* CSV Export */}
            <button
              onClick={handleExportCSV}
              disabled={loading || filtered.length === 0}
              className="flex items-center gap-1.5 rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-100 transition-colors disabled:opacity-50 ml-auto order-last sm:order-none sm:ml-0"
            >
              <Download className="h-3.5 w-3.5" />📥 Exportar CSV ({filtered.length})
            </button>
            {/* Search */}
            <div className="relative flex-1 min-w-48">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                placeholder="Buscar por CI o CVE…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full rounded-lg border border-slate-300 bg-slate-50 py-2 pl-9 pr-3 text-sm focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
              />
            </div>

            {/* Severity filter */}
            <div className="flex items-center gap-1.5">
              <Filter className="h-3.5 w-3.5 text-slate-400" />
              <select
                value={filterSev}
                onChange={(e) => setFilterSev(e.target.value as VulnSeverity | "ALL")}
                className="rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
              >
                <option value="ALL">Todas las severidades</option>
                <option value="CRITICAL">CRITICAL</option>
                <option value="HIGH">HIGH</option>
                <option value="MEDIUM">MEDIUM</option>
                <option value="LOW">LOW</option>
              </select>
            </div>

            {/* Status filter */}
            <select
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value as VulnStatus | "ALL")}
              className="rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
            >
              <option value="ALL">Todos los estados</option>
              {ALL_STATUSES.map((s) => (
                <option key={s} value={s}>{STATUS_STYLES[s].label}</option>
              ))}
            </select>
          </div>

          {loading && (
            <div className="flex items-center justify-center py-20 text-slate-400">
              <RefreshCw className="mr-2 h-5 w-5 animate-spin" />
              <span className="text-sm">Cargando vulnerabilidades…</span>
            </div>
          )}

          {error && !loading && (
            <div className="flex flex-col items-center justify-center gap-2 py-16 text-red-500">
              <AlertTriangle className="h-8 w-8" />
              <p className="text-sm font-medium">Error al cargar los datos</p>
              <p className="text-xs text-slate-400">{error}</p>
              <button onClick={fetchAll} className="mt-2 rounded-lg bg-red-50 px-4 py-1.5 text-xs font-medium text-red-600 hover:bg-red-100">Reintentar</button>
            </div>
          )}

          {!loading && !error && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-100 bg-slate-50 text-left">
                    <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wider text-slate-500">CI Afectado</th>
                    <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wider text-slate-500">CVE</th>
                    <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wider text-slate-500">Severidad</th>
                    <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wider text-slate-500 max-w-xs">Descripción</th>
                    <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wider text-slate-500">Fuente</th>
                    <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wider text-slate-500">Estado</th>
                    <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wider text-slate-500">Importado</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filtered.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="py-16 text-center text-slate-400 text-sm">
                        {allRows.length === 0
                          ? "No hay vulnerabilidades. Importa un reporte desde los Conectores de Seguridad."
                          : "No hay hallazgos que coincidan con los filtros."}
                      </td>
                    </tr>
                  ) : (
                    filtered.map((row, i) => {
                      const key = `${row.ciId}:${row.cve}`;
                      const isUpdating = updating.has(key);
                      const statusStyle = STATUS_STYLES[row.status] ?? STATUS_STYLES["NUEVO"];

                      return (
                        <tr key={`${row.ciId}-${row.cve}-${i}`} className="hover:bg-indigo-50/30 transition-colors">
                          {/* CI */}
                          <td className="px-6 py-3">
                            <p className="font-medium text-slate-800">{row.ciName}</p>
                            <p className="text-xs text-slate-400 font-mono">{row.ciSlug}</p>
                          </td>

                          {/* CVE */}
                          <td className="px-6 py-3">
                            <code className="text-xs font-mono text-indigo-700 bg-indigo-50 rounded px-1.5 py-0.5">
                              {row.cve}
                            </code>
                            {row.cvss_score != null && (
                              <p className="text-[11px] text-slate-400 mt-0.5">CVSS {row.cvss_score}</p>
                            )}
                          </td>

                          {/* Severity */}
                          <td className="px-6 py-3">
                            <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset ${SEVERITY_STYLES[row.severity]}`}>
                              <SeverityDot severity={row.severity} />
                              {row.severity}
                            </span>
                          </td>

                          {/* Description */}
                          <td className="px-6 py-3 max-w-xs">
                            <p className="text-xs text-slate-600 line-clamp-2">{row.description}</p>
                          </td>

                          {/* Source */}
                          <td className="px-6 py-3">
                            <span className="text-xs text-slate-500 capitalize">{row.source ?? "manual"}</span>
                          </td>

                          {/* Status dropdown */}
                          <td className="px-6 py-3">
                            <div className="flex items-center gap-2">
                              <span className={`inline-block rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${statusStyle.pill}`}>
                                {statusStyle.label}
                              </span>
                              <select
                                value={row.status}
                                disabled={isUpdating}
                                onChange={(e) => handleStatusChange(row.ciId, row.cve, e.target.value as VulnStatus)}
                                className="rounded border border-slate-300 bg-white px-1.5 py-1 text-[11px] text-slate-600 focus:border-indigo-400 focus:outline-none disabled:opacity-50 disabled:cursor-wait"
                              >
                                {ALL_STATUSES.map((s) => (
                                  <option key={s} value={s}>{STATUS_STYLES[s].label}</option>
                                ))}
                              </select>
                            </div>
                          </td>

                          {/* Imported date */}
                          <td className="px-6 py-3 text-xs text-slate-400">
                            {row.importedAt
                              ? new Date(row.importedAt).toLocaleDateString("es-ES", { day: "2-digit", month: "short", year: "numeric" })
                              : "—"}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          )}

          {!loading && !error && (
            <div className="border-t border-slate-100 px-6 py-3 text-xs text-slate-400">
              Mostrando {filtered.length} de {allRows.length} vulnerabilidades
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

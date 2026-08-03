"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import { Shield, RefreshCw, AlertTriangle, Search, Download, FilterX, X, CheckCircle, Upload } from "lucide-react";
import { apiFetch, fetchAllCIs } from "@/lib/apiFetch";
import { exportToCSV } from "@/lib/csvExport";
import { useLanguage } from "@/contexts/LanguageContext";
import type { VulnSeverity, VulnStatus } from "@/lib/types/vulnImport";

// ─── Types ────────────────────────────────────────────────────────────────────
//
// VulnSeverity/VulnStatus are imported from frontend/lib/types/vulnImport.ts
// (single source of truth, mirrors backend/src/modules/integrations/types.ts)
// rather than hand-maintained locally — do not redeclare them here.

interface Vulnerability {
  cve:         string;
  severity:    VulnSeverity;
  description: string;
  source?:     string;
  cvss_score?: number | null;
  status:      VulnStatus;
  importedAt?: string;
  updatedAt?:  string;
  // Greenbone real-format fields (v3.6.0) — optional so legacy manually-
  // entered vulnerabilities (no `key`/`oid`/etc.) remain valid.
  key?:        string;
  oid?:        string;
  port?:       string;
  cves?:       string[];
  lastSeenAt?: string;
  resolvedAt?: string;
  reopenedAt?: string;
  qod?:        number;
  family?:     string;
  solution?:   string;
  epssScore?:  number;
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
  INFO:     "bg-slate-50 text-slate-400 ring-slate-100",
};

const STATUS_PILL: Record<VulnStatus, string> = {
  NUEVO:     "bg-blue-100 text-blue-700",
  ASIGNADO:  "bg-purple-100 text-purple-700",
  EN_CURSO:  "bg-yellow-100 text-yellow-700",
  PARADO:    "bg-orange-100 text-orange-700",
  RESUELTO:  "bg-emerald-100 text-emerald-700",
  // Distinct amber treatment (spec D6): a RESUELTO vulnerability that
  // reappeared in a later scan — must read as visually different from a
  // fresh NUEVO so an operator immediately notices "this came back".
  REABIERTA: "bg-amber-100 text-amber-800",
};

// Used for the filter dropdown and the status pill lookup — includes every
// status a row can hold, including the system-computed REABIERTA.
const ALL_STATUSES: VulnStatus[] = ["NUEVO", "ASIGNADO", "EN_CURSO", "PARADO", "RESUELTO", "REABIERTA"];

// Used for the per-row manual status-change <select>. REABIERTA is excluded
// on purpose: it is only ever set by the batch-accept workflow when a
// resolved vulnerability reappears (backend/src/index.ts PATCH
// /api/vulnerabilities `validStatuses` also rejects it as a manual target) —
// offering it here would let an operator pick a value the API 400s on.
const EDITABLE_STATUSES: VulnStatus[] = ALL_STATUSES.filter((s) => s !== "REABIERTA");

// ─── Summary count bar ────────────────────────────────────────────────────────

function SeverityDot({ severity }: { severity: VulnSeverity }) {
  const colors: Record<VulnSeverity, string> = {
    CRITICAL: "bg-red-500", HIGH: "bg-orange-400", MEDIUM: "bg-yellow-400", LOW: "bg-slate-300", INFO: "bg-slate-200",
  };
  return <span className={`inline-block h-2.5 w-2.5 rounded-full flex-shrink-0 ${colors[severity]}`} />;
}

// ─── Toast notification ───────────────────────────────────────────────────────

interface Toast {
  id:      number;
  type:    "error" | "success";
  message: string;
}

let _toastId = 0;

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function VulnerabilitiesPage() {
  const { t } = useLanguage();

  const [allRows, setAllRows] = useState<VulnRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);
  const [filters, setFilters] = useState({ search: "", cve: "", severity: "ALL", status: "ALL", source: "" });
  const [updating, setUpdating] = useState<Set<string>>(new Set());
  const [toasts, setToasts]   = useState<Toast[]>([]);

  const addToast = useCallback((type: Toast["type"], message: string) => {
    const id = ++_toastId;
    setToasts((prev) => [...prev, { id, type, message }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 5000);
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const activeFilterCount = Object.values(filters).filter((v) => v && v !== "ALL").length;
  const setFilter = (key: keyof typeof filters, val: string) =>
    setFilters((prev) => ({ ...prev, [key]: val }));
  const clearFilters = () =>
    setFilters({ search: "", cve: "", severity: "ALL", status: "ALL", source: "" });

  const fetchAll = async () => {
    setLoading(true); setError(null);
    try {
      const cisList = await fetchAllCIs<CI>();

      const rows: VulnRow[] = [];
      for (const ci of cisList) {
        for (const v of ci.vulnerabilities ?? []) {
          rows.push({ ...v, ciId: ci.id, ciName: ci.name, ciSlug: ci.apiSlug });
        }
      }
      setAllRows(rows);
    } catch (err) { setError(err instanceof Error ? err.message : t("common.unknown_error")); }
    finally { setLoading(false); }
  };

  useEffect(() => { fetchAll(); }, []);

  // RAG chat deep-link: ?cve=<cve-id> pre-fills the CVE filter once rows are loaded.
  const searchParams = useSearchParams();
  const router       = useRouter();
  useEffect(() => {
    const cve = searchParams.get("cve");
    if (!cve || allRows.length === 0) return;
    setFilters((prev) => ({ ...prev, cve }));
    router.replace("/vulnerabilities", { scroll: false });
  }, [searchParams, allRows, router]);

  // A row's real identity is `key ?? cve` (spec D1/D1b, v3.6.0): ~96% of real
  // Greenbone findings carry no CVE, so keying by `cve` alone would silently
  // collapse many distinct rows sharing `cve === ""` into one. Mirrors the
  // backend's own resolution in PATCH /api/vulnerabilities (index.ts:
  // `const targetKey = key ?? cve`).
  const vulnIdentity = (v: { key?: string; cve: string }) => v.key ?? v.cve;

  const handleStatusChange = async (row: VulnRow, newStatus: VulnStatus) => {
    const identity   = vulnIdentity(row);
    const updateKey  = `${row.ciId}:${identity}`;

    // Capture previous status for rollback
    const previousStatus = allRows.find(
      (r) => r.ciId === row.ciId && vulnIdentity(r) === identity
    )?.status;

    // Apply optimistic update immediately
    setAllRows((prev) =>
      prev.map((r) =>
        r.ciId === row.ciId && vulnIdentity(r) === identity ? { ...r, status: newStatus } : r
      )
    );
    setUpdating((prev) => new Set(prev).add(updateKey));

    try {
      const res = await apiFetch("/api/vulnerabilities", {
        method: "PATCH",
        // Send both fields — backend prefers `key`, falls back to `cve` for
        // legacy rows that never got a `key` (index.ts: `key ?? cve`).
        body:   JSON.stringify({ ciId: row.ciId, key: row.key, cve: row.cve, status: newStatus }),
      });

      if (!res.ok) {
        const ct = res.headers.get("content-type") ?? "";
        const msg = ct.includes("application/json")
          ? (await res.json()).error
          : `Error ${res.status}`;
        throw new Error(msg);
      }

      addToast("success", `${t("vulnerabilities.status_updated")} "${t(`vulnerabilities.status.${newStatus}`)}"`);
    } catch (err) {
      console.error("Failed to update status:", err);

      // Revert the optimistic update to the previous state
      if (previousStatus !== undefined) {
        setAllRows((prev) =>
          prev.map((r) =>
            r.ciId === row.ciId && vulnIdentity(r) === identity ? { ...r, status: previousStatus } : r
          )
        );
      }

      const errMsg = err instanceof Error ? err.message : t("common.unknown_error");
      addToast("error", `${t("vulnerabilities.update_failed")} ${errMsg}`);
    } finally {
      setUpdating((prev) => { const n = new Set(prev); n.delete(updateKey); return n; });
    }
  };

  // ── Filtered rows ──────────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    return allRows.filter((r) => {
      if (filters.severity !== "ALL" && r.severity !== filters.severity) return false;
      if (filters.status !== "ALL" && r.status !== filters.status) return false;
      if (filters.search && !r.ciName.toLowerCase().includes(filters.search.toLowerCase())) return false;
      if (filters.cve && !r.cve.toLowerCase().includes(filters.cve.toLowerCase())) return false;
      if (filters.source && (r.source ?? "manual") !== filters.source) return false;
      return true;
    });
  }, [allRows, filters]);

  const handleExportCSV = () => {
    exportToCSV(
      `vulnerabilidades-${new Date().toISOString().slice(0, 10)}.csv`,
      [
        t("vulnerabilities.col_ci_affected"),
        "Slug",
        t("vulnerabilities.columns.cve"),
        t("vulnerabilities.columns.severity"),
        t("vulnerabilities.columns.score"),
        t("vulnerabilities.columns.description"),
        t("vulnerabilities.columns.source"),
        t("vulnerabilities.columns.status"),
        t("vulnerabilities.columns.port"),
        t("vulnerabilities.columns.family"),
        t("vulnerabilities.col_imported"),
      ],
      filtered.map((row) => [
        row.ciName, row.ciSlug, row.cve || "—", row.severity,
        row.cvss_score ?? "",
        row.description,
        row.source ?? "manual",
        t(`vulnerabilities.status.${row.status}`),
        row.port ?? "",
        row.family ?? "",
        row.importedAt ? new Date(row.importedAt).toLocaleDateString("es-ES") : "",
      ])
    );
  };

  // ── Summary stats ──────────────────────────────────────────────────────────
  // counts.open already treats "anything not RESUELTO" as open, so REABIERTA
  // (which is never RESUELTO) is counted correctly here without a code
  // change — verified by reading this filter, not assumed.
  const counts = useMemo(() => ({
    critical: allRows.filter((r) => r.severity === "CRITICAL").length,
    high:     allRows.filter((r) => r.severity === "HIGH").length,
    medium:   allRows.filter((r) => r.severity === "MEDIUM").length,
    low:      allRows.filter((r) => r.severity === "LOW").length,
    info:     allRows.filter((r) => r.severity === "INFO").length,
    resuelto: allRows.filter((r) => r.status === "RESUELTO").length,
    open:     allRows.filter((r) => r.status !== "RESUELTO").length,
  }), [allRows]);

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Toast notifications */}
      {toasts.length > 0 && (
        <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-2 w-80" role="region" aria-label={t("vulnerabilities.notifications_region")}>
          {toasts.map((toast) => (
            <div
              key={toast.id}
              className={`flex items-start gap-3 rounded-xl px-4 py-3 shadow-lg ring-1 transition-all ${
                toast.type === "error"
                  ? "bg-red-50 ring-red-200 text-red-800"
                  : "bg-emerald-50 ring-emerald-200 text-emerald-800"
              }`}
              role="alert"
            >
              {toast.type === "error"
                ? <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5 text-red-500" />
                : <CheckCircle  className="h-4 w-4 flex-shrink-0 mt-0.5 text-emerald-500" />
              }
              <p className="text-xs font-medium flex-1">{toast.message}</p>
              <button
                onClick={() => dismissToast(toast.id)}
                className="flex-shrink-0 rounded p-0.5 hover:bg-black/10 transition-colors"
                aria-label={t("vulnerabilities.close_notification")}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Header */}
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white px-8 py-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Shield className="h-5 w-5 text-[var(--accent)]" />
            <div>
              <h1 className="text-xl font-bold text-slate-900">{t("vulnerabilities.title")}</h1>
              <p className="text-sm text-slate-500 mt-0.5">
                {loading
                  ? t("vulnerabilities.loading_records")
                  : t("vulnerabilities.header_subtitle", { total: allRows.length, open: counts.open })}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Link
              href="/vulnerabilities/imports"
              className="flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50 transition-colors"
            >
              <Upload className="h-3.5 w-3.5" />{t("vulnImport.title")}
            </Link>
            <button onClick={fetchAll} className="flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50 transition-colors">
              <RefreshCw className="h-3.5 w-3.5" />{t("actions.refresh")}
            </button>
          </div>
        </div>
      </header>

      <div className="px-8 py-8 w-full space-y-6">
        {/* Summary cards */}
        {!loading && !error && (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
            {[
              { label: "CRITICAL", value: counts.critical, color: "bg-red-50 text-red-700 ring-red-200" },
              { label: "HIGH",     value: counts.high,     color: "bg-orange-50 text-orange-700 ring-orange-200" },
              { label: "MEDIUM",   value: counts.medium,   color: "bg-yellow-50 text-yellow-700 ring-yellow-200" },
              { label: "LOW",      value: counts.low,      color: "bg-slate-50 text-slate-600 ring-slate-200" },
              { label: "INFO",     value: counts.info,     color: "bg-slate-50 text-slate-400 ring-slate-100" },
              { label: t("vulnerabilities.open_label"),     value: counts.open,     color: "bg-[var(--accent)]/5 text-[var(--accent)] ring-[var(--accent)]/20" },
              { label: t("vulnerabilities.resolved_label"), value: counts.resuelto, color: "bg-emerald-50 text-emerald-700 ring-emerald-200" },
            ].map(({ label, value, color }) => (
              <div key={label} className={`px-4 py-3 ring-1 ring-inset ${color}`}>
                <p className="text-2xl font-bold">{value}</p>
                <p className="text-xs font-medium mt-0.5 text-slate-500">{label}</p>
              </div>
            ))}
          </div>
        )}

        {/* Table card */}
        <div className="bg-white shadow-sm ring-1 ring-slate-200 overflow-hidden">
          {/* Toolbar */}
          <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 px-6 py-4">
            {/* Active filter badge + clear button */}
            {activeFilterCount > 0 && (
              <>
                <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--accent)]/10 px-2.5 py-1 text-xs font-semibold text-[var(--accent)]">
                  <Search className="h-3 w-3" />
                  {activeFilterCount > 1
                    ? t("vulnerabilities.active_filter_plural", { count: activeFilterCount })
                    : t("vulnerabilities.active_filter", { count: activeFilterCount })}
                </span>
                <button
                  onClick={clearFilters}
                  className="flex items-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-medium text-red-600 hover:bg-red-100 transition-colors"
                >
                  <FilterX className="h-3.5 w-3.5" />{t("vulnerabilities.clear_filters")}
                </button>
              </>
            )}

            {/* CSV Export */}
            <button
              onClick={handleExportCSV}
              disabled={loading || filtered.length === 0}
              className="flex items-center gap-1.5 rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-100 transition-colors disabled:opacity-50 ml-auto order-last sm:order-none sm:ml-0"
            >
              <Download className="h-3.5 w-3.5" />{t("vulnerabilities.export_csv_count", { count: filtered.length })}
            </button>
          </div>

          {loading && (
            <div className="flex items-center justify-center py-20 text-slate-400">
              <RefreshCw className="mr-2 h-5 w-5 animate-spin" />
              <span className="text-sm">{t("vulnerabilities.loading_records")}</span>
            </div>
          )}

          {error && !loading && (
            <div className="flex flex-col items-center justify-center gap-2 py-16 text-red-500">
              <AlertTriangle className="h-8 w-8" />
              <p className="text-sm font-medium">{t("vulnerabilities.load_error")}</p>
              <p className="text-xs text-slate-400">{error}</p>
              <button onClick={fetchAll} className="mt-2 rounded-lg bg-red-50 px-4 py-1.5 text-xs font-medium text-red-600 hover:bg-red-100">{t("vulnerabilities.retry")}</button>
            </div>
          )}

          {!loading && !error && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  {/* Sort header row */}
                  <tr className="border-b border-slate-100 bg-slate-50 text-left">
                    <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wider text-slate-500">{t("vulnerabilities.col_ci_affected")}</th>
                    <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wider text-slate-500">{t("vulnerabilities.columns.cve")}</th>
                    <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wider text-slate-500">{t("vulnerabilities.columns.severity")}</th>
                    <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wider text-slate-500 max-w-xs">{t("vulnerabilities.columns.description")}</th>
                    <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wider text-slate-500">{t("vulnerabilities.columns.source")}</th>
                    <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wider text-slate-500">{t("vulnerabilities.columns.status")}</th>
                    <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wider text-slate-500">{t("vulnerabilities.col_imported")}</th>
                  </tr>
                  {/* Inline filter row */}
                  <tr className="border-b-2 border-[var(--accent)]/20 bg-[var(--accent)]/5">
                    {/* CI search */}
                    <td className="px-3 py-2">
                      <div className="relative">
                        <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                        <input
                          type="text"
                          placeholder={t("vulnerabilities.search_ci_placeholder")}
                          value={filters.search}
                          onChange={(e) => setFilter("search", e.target.value)}
                          className="w-full rounded-none border border-slate-200 bg-white py-1.5 pl-7 pr-2 text-xs text-slate-700 placeholder:text-slate-300 focus:border-[var(--accent)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]/20"
                        />
                      </div>
                    </td>
                    {/* CVE search */}
                    <td className="px-3 py-2">
                      <div className="relative">
                        <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                        <input
                          type="text"
                          placeholder={t("vulnerabilities.cve_placeholder")}
                          value={filters.cve}
                          onChange={(e) => setFilter("cve", e.target.value)}
                          className="w-full rounded-none border border-slate-200 bg-white py-1.5 pl-7 pr-2 text-xs text-slate-700 placeholder:text-slate-300 focus:border-[var(--accent)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]/20"
                        />
                      </div>
                    </td>
                    {/* Severity */}
                    <td className="px-3 py-2">
                      <select
                        value={filters.severity}
                        onChange={(e) => setFilter("severity", e.target.value)}
                        className={`w-full rounded-none border py-1.5 px-2 text-xs focus:border-[var(--accent)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]/20 ${
                          filters.severity !== "ALL"
                            ? "border-[var(--accent)] bg-[var(--accent)]/5 text-[var(--accent)] font-medium"
                            : "border-slate-200 bg-white text-slate-600"
                        }`}
                      >
                        <option value="ALL">{t("vulnerabilities.all_severities")}</option>
                        <option value="CRITICAL">CRITICAL</option>
                        <option value="HIGH">HIGH</option>
                        <option value="MEDIUM">MEDIUM</option>
                        <option value="LOW">LOW</option>
                        <option value="INFO">INFO</option>
                      </select>
                    </td>
                    {/* Description — no filter */}
                    <td className="px-3 py-2" />
                    {/* Source */}
                    <td className="px-3 py-2">
                      <select
                        value={filters.source}
                        onChange={(e) => setFilter("source", e.target.value)}
                        className={`w-full rounded-none border py-1.5 px-2 text-xs focus:border-[var(--accent)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]/20 ${
                          filters.source
                            ? "border-[var(--accent)] bg-[var(--accent)]/5 text-[var(--accent)] font-medium"
                            : "border-slate-200 bg-white text-slate-600"
                        }`}
                      >
                        <option value="">{t("vulnerabilities.all_sources")}</option>
                        <option value="manual">Manual</option>
                        <option value="greenbone">Greenbone</option>
                        <option value="crowdstrike">CrowdStrike</option>
                        <option value="redhat-lightspeed">Red Hat Lightspeed</option>
                      </select>
                    </td>
                    {/* Status */}
                    <td className="px-3 py-2">
                      <select
                        value={filters.status}
                        onChange={(e) => setFilter("status", e.target.value)}
                        className={`w-full rounded-none border py-1.5 px-2 text-xs focus:border-[var(--accent)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]/20 ${
                          filters.status !== "ALL"
                            ? "border-[var(--accent)] bg-[var(--accent)]/5 text-[var(--accent)] font-medium"
                            : "border-slate-200 bg-white text-slate-600"
                        }`}
                      >
                        <option value="ALL">{t("vulnerabilities.all_statuses")}</option>
                        {ALL_STATUSES.map((s) => (
                          <option key={s} value={s}>{t(`vulnerabilities.status.${s}`)}</option>
                        ))}
                      </select>
                    </td>
                    {/* Date — no filter */}
                    <td className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filtered.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="py-16 text-center text-slate-400 text-sm">
                        {allRows.length === 0
                          ? t("vulnerabilities.no_vulns")
                          : t("vulnerabilities.no_vulns_filtered")}
                      </td>
                    </tr>
                  ) : (
                    filtered.map((row, i) => {
                      const identity = vulnIdentity(row);
                      const key = `${row.ciId}:${identity}`;
                      const isUpdating = updating.has(key);
                      const pillClass = STATUS_PILL[row.status] ?? STATUS_PILL["NUEVO"];
                      const portFamily = [row.port && `${t("vulnerabilities.columns.port")} ${row.port}`, row.family]
                        .filter(Boolean)
                        .join(" · ");

                      return (
                        <tr key={`${row.ciId}-${identity}-${i}`} className="hover:bg-[var(--accent)]/5 transition-colors">
                          {/* CI */}
                          <td className="px-6 py-3">
                            <p className="font-medium text-slate-800">{row.ciName}</p>
                            <p className="text-xs text-slate-400 font-mono">{row.ciSlug}</p>
                          </td>

                          {/* CVE */}
                          <td className="px-6 py-3">
                            <code className="text-xs font-mono text-[var(--accent)] bg-[var(--accent)]/5 px-1.5 py-0.5">
                              {row.cve || "—"}
                            </code>
                            {row.cvss_score != null && (
                              <p className="text-[11px] text-slate-400 mt-0.5">CVSS {row.cvss_score}</p>
                            )}
                            {portFamily && (
                              <p className="text-[11px] text-slate-400 mt-0.5">{portFamily}</p>
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
                              <span className={`inline-block rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${pillClass}`}>
                                {t(`vulnerabilities.status.${row.status}`)}
                              </span>
                              <div className="relative flex items-center">
                                <select
                                  value={row.status}
                                  disabled={isUpdating}
                                  onChange={(e) => handleStatusChange(row, e.target.value as VulnStatus)}
                                  className="rounded-none border border-slate-300 bg-white px-1.5 py-1 text-[11px] text-slate-600 focus:border-[var(--accent)] focus:outline-none disabled:opacity-50 disabled:cursor-wait"
                                >
                                  {/* REABIERTA excluded — system-computed only, see EDITABLE_STATUSES comment above.
                                      If the row is currently REABIERTA (not in this list), the <select> still shows
                                      it correctly via `value={row.status}` even though it's not a selectable option. */}
                                  {EDITABLE_STATUSES.map((s) => (
                                    <option key={s} value={s}>{t(`vulnerabilities.status.${s}`)}</option>
                                  ))}
                                </select>
                                {isUpdating && (
                                  <RefreshCw
                                    className="absolute -right-5 h-3.5 w-3.5 animate-spin text-[var(--accent)]"
                                    aria-label={t("common.saving")}
                                  />
                                )}
                              </div>
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
              {t("vulnerabilities.footer_showing", { filtered: filtered.length, total: allRows.length })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

"use client";
import { useState, useEffect, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { useLanguage } from "@/contexts/LanguageContext";
import { ArrowLeft, Download, RefreshCw, AlertTriangle } from "lucide-react";
import { apiFetch } from "@/lib/apiFetch";
import { useReportData } from "../hooks/useReportData";
import ReportTable from "../components/ReportTable";
import ReportFilterPanel from "../components/ReportFilterPanel";
import ColumnPicker from "../components/ColumnPicker";
import type { ReportMeta, ReportFilters, ExportFormat, ReportFilterDefinition, ReportColumn } from "../types/report";

const DEFAULT_FILTERS: ReportFilters = { page: 1, limit: 50 };

function currentUserId(): string {
  try { const u = JSON.parse(localStorage.getItem("cmdb_user") ?? "{}"); return u.id ?? u.email ?? "anon"; } catch { return "anon"; }
}

export default function ReportViewerPage() {
  const { t }    = useLanguage();
  const router   = useRouter();
  const params   = useParams();
  const reportId = String(params["id"] ?? "");

  const [meta, setMeta]         = useState<ReportMeta | null>(null);
  const [metaErr, setMetaErr]   = useState<string | null>(null);
  const [filters, setFilters]   = useState<ReportFilters>(DEFAULT_FILTERS);
  const [exporting, setExporting] = useState(false);
  // Enriched filter defs (dynamic options resolved server-side, e.g. CI types)
  const [filterDefs, setFilterDefs] = useState<ReportFilterDefinition[] | null>(null);
  // v3.4.2 — column picker: ordered visible column keys (only for reports with allColumns)
  const [visibleKeys, setVisibleKeys] = useState<string[]>([]);

  const { data, loading, error, fetch } = useReportData(reportId);

  const lsKey = `report_columns_${reportId}_${typeof window !== "undefined" ? currentUserId() : "anon"}`;

  // Load report meta from the listing
  useEffect(() => {
    apiFetch("/api/reports")
      .then((r) => r.json())
      .then((d: { reports: ReportMeta[] }) => {
        const found = d.reports?.find((r) => r.id === reportId);
        if (found) setMeta(found);
        else setMetaErr("Report not found");
      })
      .catch((e) => setMetaErr(String(e)));
  }, [reportId]);

  // Load enriched filter definitions (with dynamic options). Falls back to meta.filters.
  useEffect(() => {
    if (!meta) return;
    apiFetch(`/api/reports/${reportId}/filters`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { filters?: ReportFilterDefinition[] } | null) => {
        setFilterDefs(d?.filters ?? meta.filters);
      })
      .catch(() => setFilterDefs(meta.filters));
  }, [meta, reportId]);

  // Initialise visible columns from localStorage (or report defaults) once meta loads
  useEffect(() => {
    if (!meta) return;
    const all = meta.allColumns;
    const defaults = meta.columns.map((c) => c.key);
    if (!all || all.length === 0) { setVisibleKeys(defaults); return; }
    let initial = defaults;
    try {
      const saved = JSON.parse(localStorage.getItem(lsKey) ?? "null");
      if (Array.isArray(saved) && saved.length) {
        const valid = saved.filter((k: string) => all.some((c) => c.key === k));
        if (valid.length) initial = valid;
      }
    } catch { /* ignore */ }
    setVisibleKeys(initial);
  }, [meta, lsKey]);

  // Fetch data whenever filters or visible columns change (after meta loaded)
  useEffect(() => {
    if (!meta || visibleKeys.length === 0) return;
    fetch({ ...filters, visibleColumns: visibleKeys.join(",") });
  }, [meta, filters, visibleKeys, fetch]);

  const handleFiltersChange = useCallback((partial: Partial<ReportFilters>) => {
    setFilters((prev) => ({ ...prev, ...partial }));
  }, []);

  const handleColumnsChange = useCallback((keys: string[]) => {
    setVisibleKeys(keys);
    try { localStorage.setItem(lsKey, JSON.stringify(keys)); } catch { /* ignore */ }
    setFilters((prev) => ({ ...prev, page: 1 }));
  }, [lsKey]);

  // The columns actually rendered (visible subset/order) — falls back to defaults
  const effectiveColumns: ReportColumn[] = (meta?.allColumns && visibleKeys.length)
    ? (visibleKeys.map((k) => meta.allColumns!.find((c) => c.key === k)).filter(Boolean) as ReportColumn[])
    : (meta?.columns ?? []);

  async function handleExport(format: ExportFormat) {
    setExporting(true);
    try {
      const params = new URLSearchParams();
      params.set("format", format);
      Object.entries(filters).forEach(([k, v]) => {
        if (v !== undefined && v !== null && v !== "") {
          if (Array.isArray(v)) v.forEach((i) => params.append(k, String(i)));
          else params.set(k, String(v));
        }
      });
      if (visibleKeys.length) params.set("visibleColumns", visibleKeys.join(","));
      const res = await apiFetch(`/api/reports/${reportId}/export?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob  = await res.blob();
      const url   = URL.createObjectURL(blob);
      const a     = document.createElement("a");
      a.href      = url;
      a.download  = `${reportId}-${new Date().toISOString().slice(0, 10)}.${format}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error("Export error:", e);
    } finally {
      setExporting(false);
    }
  }

  if (metaErr) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <div className="text-center space-y-3">
          <AlertTriangle className="w-8 h-8 text-rose-400 mx-auto" />
          <p className="text-slate-600">{metaErr}</p>
          <button onClick={() => router.back()} className="text-sm text-[var(--accent)] underline">{t("reports.view.back")}</button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header */}
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white px-8 py-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <button
              onClick={() => router.push("/reports")}
              className="rounded-none border border-slate-300 bg-white p-2 text-slate-500 hover:bg-slate-50"
              aria-label={t("reports.view.back")}
            >
              <ArrowLeft className="w-4 h-4" />
            </button>
            <div>
              <h1 className="text-xl font-bold text-slate-900">
                {meta ? t(meta.nameKey) : "…"}
              </h1>
              <p className="text-sm text-slate-500 mt-0.5">
                {meta ? t(meta.descriptionKey) : ""}
              </p>
            </div>
          </div>

          {/* Column picker + export buttons */}
          {meta && (
            <div className="flex items-center gap-2">
              {loading && <RefreshCw className="w-4 h-4 text-slate-400 animate-spin" />}
              {meta.allColumns && meta.allColumns.length > 0 && visibleKeys.length > 0 && (
                <ColumnPicker
                  allColumns={meta.allColumns}
                  visible={visibleKeys}
                  defaultKeys={meta.columns.map((c) => c.key)}
                  onChange={handleColumnsChange}
                />
              )}
              {meta.exportFormats.includes("csv") && (
                <button
                  onClick={() => handleExport("csv")}
                  disabled={exporting || loading}
                  className="rounded-none border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50 flex items-center gap-1.5 disabled:opacity-50"
                >
                  <Download className="w-3.5 h-3.5" /> CSV
                </button>
              )}
              {meta.exportFormats.includes("xlsx") && (
                <button
                  onClick={() => handleExport("xlsx")}
                  disabled={exporting || loading}
                  className="rounded-none bg-[var(--accent)] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[var(--accent)]/90 shadow-sm flex items-center gap-1.5 disabled:opacity-50"
                >
                  <Download className="w-3.5 h-3.5" /> Excel
                </button>
              )}
            </div>
          )}
        </div>
      </header>

      {error && (
        <div className="mx-8 mt-4 bg-rose-50 text-rose-700 px-4 py-3 text-sm ring-1 ring-rose-200 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" /> {error}
        </div>
      )}

      <div className="px-8 py-8 flex gap-6 w-full">
        {/* Sidebar filters */}
        {meta && (filterDefs ?? meta.filters).length > 0 && (
          <aside className="w-64 flex-shrink-0">
            <ReportFilterPanel
              filterDefs={filterDefs ?? meta.filters}
              filters={filters}
              onChange={handleFiltersChange}
            />
          </aside>
        )}

        {/* Main table */}
        <div className="flex-1 min-w-0">
          {meta && data ? (
            <ReportTable
              columns={effectiveColumns}
              rows={data.data}
              total={data.total}
              kpis={data.kpis}
              filters={filters}
              filterDefs={filterDefs ?? meta.filters}
              onFiltersChange={handleFiltersChange}
              loading={loading}
            />
          ) : (
            !error && (
              <div className="py-20 text-center text-slate-400">
                <RefreshCw className="w-6 h-6 animate-spin mx-auto mb-3" />
                {t("reports.view.loading")}
              </div>
            )
          )}
        </div>
      </div>
    </div>
  );
}

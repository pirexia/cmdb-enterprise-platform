"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ClipboardList, Download, FilterX, RefreshCw, AlertTriangle, Search, Shield, Server, ShieldAlert } from "lucide-react";
import ExcelJS from "exceljs";
import { apiFetch } from "@/lib/apiFetch";
import { useLanguage } from "@/contexts/LanguageContext";

// ─── Types ────────────────────────────────────────────────────────────────────

interface AuditLog {
  id:          string;
  action:      string;
  entity:      string;
  entity_id:   string;
  user_email:  string;
  created_at:  string;
  entity_name: string | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("es-ES", {
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

function ActionBadge({ action }: { action: string }) {
  const { t } = useLanguage();
  if (action.startsWith("CREATE_CI")) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-semibold text-emerald-700">
        <Server className="h-3 w-3" />{t("audit.ci_created")}
      </span>
    );
  }
  if (action.startsWith("UPDATE_VULN_STATUS")) {
    const newStatus = action.split(":")[1] ?? "";
    const colors: Record<string, string> = {
      RESUELTO: "bg-emerald-100 text-emerald-700",
      EN_CURSO: "bg-yellow-100 text-yellow-700",
      ASIGNADO: "bg-purple-100 text-purple-700",
      PARADO:   "bg-orange-100 text-orange-700",
      NUEVO:    "bg-blue-100 text-blue-700",
    };
    return (
      <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ${colors[newStatus] ?? "bg-slate-100 text-slate-600"}`}>
        <ShieldAlert className="h-3 w-3" />Vuln → {newStatus}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-semibold text-slate-600">
      {action}
    </span>
  );
}

function EntityBadge({ entity }: { entity: string }) {
  const styles: Record<string, string> = {
    CI:            "bg-[var(--accent)]/5 text-[var(--accent)]",
    VULNERABILITY: "bg-red-50 text-red-700",
  };
  return (
    <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-semibold ${styles[entity] ?? "bg-slate-100 text-slate-600"}`}>
      {entity}
    </span>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function AuditPage() {
  const [logs, setLogs]       = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);
  const [filters, setFilters] = useState({
    search: "",
    entity: "",
    action: "",
    dateFrom: "",
    dateTo: "",
  });

  const { t } = useLanguage();

  const activeFilterCount = Object.values(filters).filter(Boolean).length;
  const setFilter = (key: keyof typeof filters, val: string) =>
    setFilters((prev) => ({ ...prev, [key]: val }));
  const clearFilters = () =>
    setFilters({ search: "", entity: "", action: "", dateFrom: "", dateTo: "" });

  const fetchLogs = useCallback(async (currentFilters: typeof filters) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (currentFilters.dateFrom) params.set("from", currentFilters.dateFrom);
      if (currentFilters.dateTo)
        params.set("to", new Date(currentFilters.dateTo + "T23:59:59").toISOString());
      const url = `/api/audit-logs${params.toString() ? "?" + params.toString() : ""}`;
      const res = await apiFetch(url);
      if (!res.ok) throw new Error(`Status ${res.status}`);
      const json: { total: number; data: AuditLog[] } = await res.json();
      setLogs(json.data ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("common.unknown_error"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  // Fetch on mount and whenever the date range changes
  useEffect(() => {
    fetchLogs(filters);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.dateFrom, filters.dateTo]);

  const filtered = useMemo(() => {
    return logs.filter((l) => {
      const q = filters.search.toLowerCase();
      const matchesSearch =
        !q ||
        l.action.toLowerCase().includes(q) ||
        l.entity.toLowerCase().includes(q) ||
        l.entity_id.toLowerCase().includes(q) ||
        l.user_email.toLowerCase().includes(q) ||
        (l.entity_name ?? "").toLowerCase().includes(q);
      const matchesEntity = !filters.entity || l.entity === filters.entity;
      const matchesAction = !filters.action || l.action.startsWith(filters.action);
      return matchesSearch && matchesEntity && matchesAction;
    });
  }, [logs, filters.search, filters.entity, filters.action]);

  const exportExcel = async () => {
    const rows = filtered.map((l) => ({
      [t("audit.columns.date")]:    formatDateTime(l.created_at),
      [t("common.email")]:          l.user_email,
      [t("audit.columns.action")]:  l.action,
      [t("audit.columns.entity")]:  l.entity,
      [t("common.name")]:           l.entity_name ?? "",
      "ID Afectado":                l.entity_id,
    }));
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Auditoría");
    if (rows.length > 0) {
      ws.columns = Object.keys(rows[0]).map((key) => ({ header: key, key }));
      rows.forEach((r) => ws.addRow(r));
    }
    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `auditoria_${new Date().toISOString().slice(0, 10)}.xlsx`;
    a.click(); URL.revokeObjectURL(url);
  };

  const filterBadgeLabel =
    activeFilterCount > 1
      ? t("audit.active_filters_plural", { count: activeFilterCount })
      : t("audit.active_filters", { count: activeFilterCount });

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header */}
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white px-8 py-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Shield className="h-5 w-5 text-[var(--accent)]" />
            <div>
              <h1 className="text-xl font-bold text-slate-900">{t("audit.title")}</h1>
              <p className="text-sm text-slate-500 mt-0.5">
                {loading
                  ? t("common.loading")
                  : `${logs.length} ${t("audit.event_registry")}`}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={exportExcel}
              disabled={filtered.length === 0}
              className="flex items-center gap-2 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-700 hover:bg-emerald-100 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Download className="h-3.5 w-3.5" />{t("audit.excel_label")}
            </button>
            <button
              onClick={() => fetchLogs(filters)}
              className="flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50 transition-colors"
            >
              <RefreshCw className="h-3.5 w-3.5" />{t("actions.refresh")}
            </button>
          </div>
        </div>
      </header>

      <div className="px-8 py-8 w-full">
        <div className="bg-white shadow-sm ring-1 ring-slate-200 overflow-hidden">
          {/* Toolbar */}
          <div className="flex items-center gap-3 border-b border-slate-200 px-6 py-4">
            <ClipboardList className="h-4 w-4 text-slate-400 flex-shrink-0" />
            <h2 className="text-sm font-semibold text-slate-700 flex-1">{t("audit.event_registry")}</h2>
            {activeFilterCount > 0 && (
              <>
                <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--accent)]/10 px-2.5 py-1 text-xs font-semibold text-[var(--accent)]">
                  <FilterX className="h-3 w-3" />{filterBadgeLabel}
                </span>
                <button
                  onClick={clearFilters}
                  className="flex items-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-medium text-red-600 hover:bg-red-100 transition-colors"
                >
                  <FilterX className="h-3.5 w-3.5" />{t("audit.clear_filters")}
                </button>
              </>
            )}
          </div>

          {/* Loading */}
          {loading && (
            <div className="flex items-center justify-center py-20 text-slate-400">
              <RefreshCw className="mr-2 h-5 w-5 animate-spin" />
              <span className="text-sm">{t("audit.loading_records")}</span>
            </div>
          )}

          {/* Error */}
          {error && !loading && (
            <div className="flex flex-col items-center justify-center gap-2 py-16 text-red-500">
              <AlertTriangle className="h-8 w-8" />
              <p className="text-sm font-medium">{t("audit.load_error")}</p>
              <p className="text-xs text-slate-400">{error}</p>
              <button
                onClick={() => fetchLogs(filters)}
                className="mt-2 rounded-lg bg-red-50 px-4 py-1.5 text-xs font-medium text-red-600 hover:bg-red-100"
              >
                {t("audit.retry")}
              </button>
            </div>
          )}

          {/* Table */}
          {!loading && !error && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-100 bg-slate-50 text-left">
                    <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wider text-slate-500">{t("audit.columns.date")}</th>
                    <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wider text-slate-500">{t("common.email")}</th>
                    <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wider text-slate-500">{t("audit.columns.action")}</th>
                    <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wider text-slate-500">{t("audit.columns.entity")}</th>
                    <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wider text-slate-500">{t("common.name")}</th>
                    <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wider text-slate-500">ID Afectado</th>
                  </tr>
                  {/* Filter row — 6 cells matching 6 columns */}
                  <tr className="border-b-2 border-[var(--accent)]/20 bg-[var(--accent)]/5">
                    {/* Cell 1 — Fecha/Hora: date range inputs */}
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-1.5">
                        <input
                          type="date"
                          value={filters.dateFrom}
                          onChange={(e) => setFilter("dateFrom", e.target.value)}
                          className="rounded-none border border-slate-200 bg-white py-1.5 px-2 text-xs focus:border-[var(--accent)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]/20 w-36"
                        />
                        <span className="text-slate-400 text-xs">→</span>
                        <input
                          type="date"
                          value={filters.dateTo}
                          onChange={(e) => setFilter("dateTo", e.target.value)}
                          className="rounded-none border border-slate-200 bg-white py-1.5 px-2 text-xs focus:border-[var(--accent)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]/20 w-36"
                        />
                      </div>
                    </td>
                    {/* Cell 2 — Usuario: search input */}
                    <td className="px-3 py-2">
                      <div className="relative">
                        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                        <input
                          type="text"
                          placeholder={t("audit.search_placeholder")}
                          value={filters.search}
                          onChange={(e) => setFilter("search", e.target.value)}
                          className="w-full rounded-none border border-slate-200 bg-white py-1.5 pl-8 pr-2 text-xs focus:border-[var(--accent)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]/20"
                        />
                      </div>
                    </td>
                    {/* Cell 3 — Acción: action select */}
                    <td className="px-3 py-2">
                      <select
                        value={filters.action}
                        onChange={(e) => setFilter("action", e.target.value)}
                        className={`w-full rounded-none border py-1.5 px-2 text-xs focus:outline-none focus:ring-1 focus:ring-[var(--accent)]/20 ${filters.action ? "border-[var(--accent)] bg-[var(--accent)]/5 text-[var(--accent)] font-medium" : "border-slate-200 bg-white text-slate-600"}`}
                      >
                        <option value="">{t("audit.all_actions")}</option>
                        <option value="CREATE_CI">CREATE_CI</option>
                        <option value="UPDATE_VULN_STATUS">UPDATE_VULN_STATUS</option>
                        <option value="DELETE">DELETE</option>
                        <option value="UPDATE">UPDATE</option>
                      </select>
                    </td>
                    {/* Cell 4 — Entidad: entity select */}
                    <td className="px-3 py-2">
                      <select
                        value={filters.entity}
                        onChange={(e) => setFilter("entity", e.target.value)}
                        className={`w-full rounded-none border py-1.5 px-2 text-xs focus:outline-none focus:ring-1 focus:ring-[var(--accent)]/20 ${filters.entity ? "border-[var(--accent)] bg-[var(--accent)]/5 text-[var(--accent)] font-medium" : "border-slate-200 bg-white text-slate-600"}`}
                      >
                        <option value="">{t("audit.all_entities")}</option>
                        <option value="CI">CI</option>
                        <option value="VULNERABILITY">VULNERABILITY</option>
                      </select>
                    </td>
                    {/* Cell 5 — Nombre/Detalle: empty */}
                    <td className="px-3 py-2" />
                    {/* Cell 6 — ID Afectado: empty */}
                    <td className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filtered.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="py-16 text-center text-slate-400 text-sm">
                        {logs.length === 0
                          ? t("audit.no_events")
                          : t("audit.no_filtered")}
                      </td>
                    </tr>
                  ) : (
                    filtered.map((log) => (
                      <tr key={log.id} className="hover:bg-[var(--accent)]/5 transition-colors">
                        {/* Date */}
                        <td className="px-6 py-3 text-xs text-slate-500 whitespace-nowrap font-mono">
                          {formatDateTime(log.created_at)}
                        </td>
                        {/* User */}
                        <td className="px-6 py-3">
                          <span className="text-sm font-medium text-slate-700">{log.user_email}</span>
                        </td>
                        {/* Action */}
                        <td className="px-6 py-3">
                          <ActionBadge action={log.action} />
                        </td>
                        {/* Entity */}
                        <td className="px-6 py-3">
                          <EntityBadge entity={log.entity} />
                        </td>
                        {/* Entity Name */}
                        <td className="px-6 py-3">
                          {log.entity_name ? (
                            <span className="text-sm font-medium text-slate-700">{log.entity_name}</span>
                          ) : (
                            <span className="text-xs text-slate-400 italic">—</span>
                          )}
                        </td>
                        {/* Entity ID */}
                        <td className="px-6 py-3">
                          <code className="text-xs font-mono text-slate-500 bg-slate-100 rounded px-1.5 py-0.5 break-all">
                            {log.entity_id}
                          </code>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          )}

          {/* Footer */}
          {!loading && !error && (
            <div className="border-t border-slate-100 px-6 py-3 text-xs text-slate-400">
              {t("audit.footer_showing", { filtered: filtered.length, total: logs.length })}
              {activeFilterCount > 0
                ? ` · ${activeFilterCount > 1
                    ? t("audit.active_filters_plural", { count: activeFilterCount })
                    : t("audit.active_filters", { count: activeFilterCount })}`
                : ""}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

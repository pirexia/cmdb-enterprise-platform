"use client";
import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { useLanguage } from "@/contexts/LanguageContext";
import { ChevronUp, ChevronDown, ChevronsUpDown, Filter as FilterIcon, X } from "lucide-react";
import type { ReportColumn, ReportFilters, ReportKpi, ReportFilterDefinition } from "../types/report";

const BADGE_COLORS: Record<string, string> = {
  // CI status (Spanish enum values)
  ACTIVO:          "bg-emerald-50 text-emerald-700",
  INACTIVO:        "bg-slate-100 text-slate-500",
  RETIRADO:        "bg-rose-50 text-rose-600",
  // criticality
  MISSION_CRITICAL:"bg-rose-100 text-rose-800",
  HIGH:            "bg-orange-50 text-orange-700",
  MEDIUM:          "bg-yellow-50 text-yellow-700",
  LOW:             "bg-slate-50 text-slate-600",
  // environment
  PRODUCTION:      "bg-emerald-50 text-emerald-700",
  STAGING:         "bg-amber-50 text-amber-700",
  DEVELOPMENT:     "bg-blue-50 text-blue-700",
  TESTING:         "bg-violet-50 text-violet-700",
  // yes/no + coverage
  yes:             "bg-rose-50 text-rose-700",
  no:              "bg-emerald-50 text-emerald-700",
  covered:         "bg-emerald-50 text-emerald-700",
  uncovered:       "bg-rose-50 text-rose-700",
  // contract/license lifecycle status
  active:          "bg-emerald-50 text-emerald-700",
  expiring:        "bg-amber-50 text-amber-700",
  expired:         "bg-rose-50 text-rose-600",
  open:            "bg-slate-100 text-slate-500",
  // decommission status
  COMPLETED:       "bg-emerald-50 text-emerald-700",
  IN_PROGRESS:     "bg-amber-50 text-amber-700",
  DRAFT:           "bg-slate-100 text-slate-500",
  CANCELLED:       "bg-rose-50 text-rose-600",
  // eol/eos semaphore
  red:             "bg-rose-50 text-rose-700",
  amber:           "bg-amber-50 text-amber-700",
  green:           "bg-emerald-50 text-emerald-700",
  // relation types
  DEPENDS_ON:      "bg-blue-50 text-blue-700",
  HOSTS:           "bg-teal-50 text-teal-700",
  CONNECTED_TO:    "bg-indigo-50 text-indigo-700",
  CONNECTS_TO:     "bg-indigo-50 text-indigo-700",
  PROVIDES_SERVICE:"bg-violet-50 text-violet-700",
  BACKED_UP_BY:    "bg-cyan-50 text-cyan-700",
  REPLICATES_TO:   "bg-cyan-50 text-cyan-700",
  CONTAINS:        "bg-orange-50 text-orange-700",
  COMPOSED_OF:     "bg-amber-50 text-amber-700",
  ATTACHED_TO:     "bg-slate-100 text-slate-600",
  UPLINKS_TO:      "bg-sky-50 text-sky-700",
  POWERS:          "bg-yellow-50 text-yellow-700",
  PROTECTS:        "bg-emerald-50 text-emerald-700",
  RUNS_ON:         "bg-blue-50 text-blue-700",
  QUERIES:         "bg-purple-50 text-purple-700",
  LICENSES:        "bg-pink-50 text-pink-700",
  MANAGES:         "bg-slate-100 text-slate-600",
};

const KPI_TONES: Record<string, string> = {
  green:   "bg-emerald-50 text-emerald-700",
  amber:   "bg-amber-50  text-amber-700",
  red:     "bg-rose-50   text-rose-700",
  neutral: "bg-slate-100 text-slate-700",
};

interface Props {
  columns: ReportColumn[];
  rows: Record<string, unknown>[];
  total: number;
  kpis?: ReportKpi[];
  filters: ReportFilters;
  filterDefs?: ReportFilterDefinition[];
  onFiltersChange: (f: Partial<ReportFilters>) => void;
  loading: boolean;
}

/** Render a KPI value: format numbers, but pass through pre-formatted strings (e.g. "75%", "12.00 EUR") to avoid NaN. */
function renderKpiValue(value: number | string): string {
  if (typeof value === "number") return value.toLocaleString();
  const n = Number(value);
  return Number.isFinite(n) && value.trim() !== "" ? n.toLocaleString() : String(value);
}

export default function ReportTable({ columns, rows, total, kpis, filters, filterDefs = [], onFiltersChange, loading }: Props) {
  const { t } = useLanguage();
  const pageCount = Math.ceil(total / filters.limit);
  const [openFilter, setOpenFilter] = useState<string | null>(null);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!openFilter) return;
    function onClickAway(e: MouseEvent) {
      if (popRef.current && !popRef.current.contains(e.target as Node)) setOpenFilter(null);
    }
    // The popover is rendered in a portal with fixed positioning; if the page
    // (or table) scrolls it would detach from its header, so close it — unless
    // the scroll happens inside the dropdown's own option list.
    function onScroll(e: Event) {
      if (popRef.current && popRef.current.contains(e.target as Node)) return;
      setOpenFilter(null);
    }
    function onResize() { setOpenFilter(null); }
    document.addEventListener("mousedown", onClickAway);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("mousedown", onClickAway);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [openFilter]);

  function toggleSort(key: string) {
    if (filters.sort === key) {
      onFiltersChange({ dir: filters.dir === "asc" ? "desc" : "asc", page: 1 });
    } else {
      onFiltersChange({ sort: key, dir: "asc", page: 1 });
    }
  }

  const optLabel = (o: { value: string; labelKey?: string; label?: string }) =>
    o.label ?? (o.labelKey ? t(o.labelKey) : o.value);

  const defFor = (key: string) => filterDefs.find((f) => f.key === key);

  function columnHasActiveFilter(col: ReportColumn): boolean {
    if (col.filter === "text") return !!filters.search;
    const v = filters[col.key];
    return Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null && v !== "";
  }

  function renderCell(col: ReportColumn, row: Record<string, unknown>) {
    const val = row[col.key];
    if (val === undefined || val === null || val === "") return <span className="text-slate-300">—</span>;
    if (col.type === "badge") {
      const str = String(val);
      return (
        <span className={`inline-block px-1.5 py-0.5 text-[10px] font-bold uppercase ${BADGE_COLORS[str] ?? "bg-slate-100 text-slate-600"}`}>
          {str}
        </span>
      );
    }
    if (col.type === "number") return <span className="tabular-nums">{Number(val).toLocaleString()}</span>;
    return <span>{String(val)}</span>;
  }

  function renderHeaderFilter(col: ReportColumn) {
    if (!col.filter) return null;
    const active = columnHasActiveFilter(col);
    const isOpen = openFilter === col.key;
    return (
      <span className="inline-flex">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            if (isOpen) { setOpenFilter(null); return; }
            setAnchorRect((e.currentTarget as HTMLElement).getBoundingClientRect());
            setOpenFilter(col.key);
          }}
          className={`p-0.5 ${active ? "text-[var(--accent)]" : "text-slate-300 hover:text-slate-500"}`}
          aria-label={t("reports.view.filters")}
        >
          <FilterIcon className="w-3 h-3" />
        </button>
        {isOpen && anchorRect && typeof document !== "undefined" && createPortal(
          <div
            ref={popRef}
            onClick={(e) => e.stopPropagation()}
            style={{
              position: "fixed",
              top: anchorRect.bottom + 4,
              // keep the popover within the viewport horizontally
              left: Math.max(8, Math.min(anchorRect.left, window.innerWidth - 224)),
            }}
            className="z-50 w-52 bg-white ring-1 ring-slate-200 shadow-lg p-2 normal-case"
          >
            {col.filter === "text" ? (
              <input
                autoFocus
                type="text"
                value={String(filters.search ?? "")}
                onChange={(e) => onFiltersChange({ search: e.target.value || undefined, page: 1 })}
                placeholder={t("reports.view.search_placeholder")}
                className="w-full border border-slate-200 px-2 py-1 text-xs text-slate-700 focus:outline-none focus:border-[var(--accent)]"
              />
            ) : (
              <div className="max-h-64 overflow-y-auto space-y-0.5">
                {(defFor(col.key)?.options ?? []).map((o) => {
                  const selected = Array.isArray(filters[col.key]) ? (filters[col.key] as string[]) : [];
                  const isOn = selected.includes(o.value);
                  return (
                    <label key={o.value} className="flex items-center gap-2 px-1.5 py-1 text-xs text-slate-700 hover:bg-slate-50 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={isOn}
                        onChange={() => {
                          const next = isOn ? selected.filter((v) => v !== o.value) : [...selected, o.value];
                          onFiltersChange({ [col.key]: next.length ? next : undefined, page: 1 });
                        }}
                      />
                      {optLabel(o)}
                    </label>
                  );
                })}
                {active && (
                  <button
                    onClick={() => onFiltersChange({ [col.key]: undefined, page: 1 })}
                    className="mt-1 flex items-center gap-1 text-[11px] text-slate-500 hover:text-slate-700 px-1.5"
                  >
                    <X className="w-3 h-3" /> {t("reports.view.clear")}
                  </button>
                )}
              </div>
            )}
          </div>,
          document.body,
        )}
      </span>
    );
  }

  return (
    <div className="space-y-4">
      {/* KPIs */}
      {kpis && kpis.length > 0 && (
        <div className="flex flex-wrap gap-3">
          {kpis.map((kpi) => (
            <div key={kpi.labelKey} className={`px-4 py-2.5 flex flex-col ${KPI_TONES[kpi.tone ?? "neutral"] ?? KPI_TONES.neutral}`}>
              <span className="text-xl font-bold tabular-nums">{renderKpiValue(kpi.value)}</span>
              <span className="text-[11px] font-medium">{t(kpi.labelKey)}</span>
            </div>
          ))}
        </div>
      )}

      {/* Table */}
      <div className="overflow-x-auto ring-1 ring-slate-200 bg-white">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 border-b border-slate-200">
            <tr>
              {columns.map((col) => (
                <th
                  key={col.key}
                  className="px-3 py-2.5 text-left text-[11px] font-semibold text-slate-600 uppercase tracking-wide whitespace-nowrap"
                >
                  <span className="flex items-center gap-1">
                    <span
                      className={col.sortable ? "cursor-pointer select-none hover:text-slate-900 flex items-center gap-1" : "flex items-center gap-1"}
                      onClick={col.sortable ? () => toggleSort(col.key) : undefined}
                    >
                      {t(col.labelKey)}
                      {col.sortable && (
                        filters.sort === col.key
                          ? (filters.dir === "asc" ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />)
                          : <ChevronsUpDown className="w-3 h-3 opacity-30" />
                      )}
                    </span>
                    {renderHeaderFilter(col)}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className={`divide-y divide-slate-100 ${loading ? "opacity-50" : ""}`}>
            {rows.length === 0 && (
              <tr>
                <td colSpan={columns.length} className="px-3 py-8 text-center text-slate-400 text-sm">
                  {t("reports.view.no_data")}
                </td>
              </tr>
            )}
            {rows.map((row, i) => (
              <tr key={String(row["id"] ?? i)} className="hover:bg-slate-50 transition-colors">
                {columns.map((col) => (
                  <td key={col.key} className="px-3 py-2 text-slate-700 whitespace-nowrap">
                    {renderCell(col, row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between text-xs text-slate-500">
        <span>
          {t("reports.view.total")}: <strong className="text-slate-800 tabular-nums">{total.toLocaleString()}</strong>
        </span>
        <div className="flex items-center gap-1">
          <button
            disabled={filters.page <= 1}
            onClick={() => onFiltersChange({ page: filters.page - 1 })}
            className="px-2 py-1 border border-slate-200 bg-white hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            ‹
          </button>
          <span className="px-3">
            {t("reports.view.page")} <strong>{filters.page}</strong> / {pageCount || 1}
          </span>
          <button
            disabled={filters.page >= pageCount}
            onClick={() => onFiltersChange({ page: filters.page + 1 })}
            className="px-2 py-1 border border-slate-200 bg-white hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            ›
          </button>
        </div>
      </div>
    </div>
  );
}

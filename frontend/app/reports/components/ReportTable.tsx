"use client";
import { useLanguage } from "@/contexts/LanguageContext";
import { ChevronUp, ChevronDown, ChevronsUpDown } from "lucide-react";
import type { ReportColumn, ReportFilters, ReportKpi } from "../types/report";

const BADGE_COLORS: Record<string, string> = {
  ACTIVE:          "bg-emerald-50 text-emerald-700",
  INACTIVE:        "bg-slate-100 text-slate-500",
  RETIRED:         "bg-rose-50 text-rose-600",
  MAINTENANCE:     "bg-amber-50 text-amber-700",
  PLANNED:         "bg-blue-50 text-blue-700",
  MISSION_CRITICAL:"bg-rose-100 text-rose-800",
  HIGH:            "bg-orange-50 text-orange-700",
  MEDIUM:          "bg-yellow-50 text-yellow-700",
  LOW:             "bg-slate-50 text-slate-600",
  PRODUCTION:      "bg-emerald-50 text-emerald-700",
  STAGING:         "bg-amber-50 text-amber-700",
  DEVELOPMENT:     "bg-blue-50 text-blue-700",
  TESTING:         "bg-violet-50 text-violet-700",
  yes:             "bg-rose-50 text-rose-700",
  no:              "bg-emerald-50 text-emerald-700",
  COMPLETED:       "bg-emerald-50 text-emerald-700",
  IN_PROGRESS:     "bg-amber-50 text-amber-700",
  DRAFT:           "bg-slate-100 text-slate-500",
  CANCELLED:       "bg-rose-50 text-rose-600",
  DEPENDS_ON:      "bg-blue-50 text-blue-700",
  HOSTS:           "bg-teal-50 text-teal-700",
  CONNECTED_TO:    "bg-indigo-50 text-indigo-700",
  PROVIDES_SERVICE:"bg-violet-50 text-violet-700",
  BACKED_UP_BY:    "bg-cyan-50 text-cyan-700",
  CONTAINS:        "bg-orange-50 text-orange-700",
  COMPOSED_OF:     "bg-amber-50 text-amber-700",
  ATTACHED_TO:     "bg-slate-100 text-slate-600",
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
  onFiltersChange: (f: Partial<ReportFilters>) => void;
  loading: boolean;
}

export default function ReportTable({ columns, rows, total, kpis, filters, onFiltersChange, loading }: Props) {
  const { t } = useLanguage();
  const pageCount = Math.ceil(total / filters.limit);

  function toggleSort(key: string) {
    if (filters.sort === key) {
      onFiltersChange({ dir: filters.dir === "asc" ? "desc" : "asc", page: 1 });
    } else {
      onFiltersChange({ sort: key, dir: "asc", page: 1 });
    }
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

  return (
    <div className="space-y-4">
      {/* KPIs */}
      {kpis && kpis.length > 0 && (
        <div className="flex flex-wrap gap-3">
          {kpis.map((kpi) => (
            <div key={kpi.labelKey} className={`px-4 py-2.5 flex flex-col ${KPI_TONES[kpi.tone ?? "neutral"] ?? KPI_TONES.neutral}`}>
              <span className="text-xl font-bold tabular-nums">{Number(kpi.value).toLocaleString()}</span>
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
                  className={`px-3 py-2.5 text-left text-[11px] font-semibold text-slate-600 uppercase tracking-wide whitespace-nowrap ${col.sortable ? "cursor-pointer select-none hover:bg-slate-100" : ""}`}
                  onClick={col.sortable ? () => toggleSort(col.key) : undefined}
                >
                  <span className="flex items-center gap-1">
                    {t(col.labelKey)}
                    {col.sortable && (
                      filters.sort === col.key
                        ? (filters.dir === "asc" ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />)
                        : <ChevronsUpDown className="w-3 h-3 opacity-30" />
                    )}
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

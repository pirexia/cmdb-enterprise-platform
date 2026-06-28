"use client";
import { useState } from "react";
import { useLanguage } from "@/contexts/LanguageContext";
import { SlidersHorizontal, X } from "lucide-react";
import type { ReportFilterDefinition, ReportFilters } from "../types/report";

interface Props {
  filterDefs: ReportFilterDefinition[];
  filters: ReportFilters;
  onChange: (f: Partial<ReportFilters>) => void;
}

export default function ReportFilterPanel({ filterDefs, filters, onChange }: Props) {
  const { t } = useLanguage();
  const [open, setOpen] = useState(true);

  function handleChange(key: string, value: unknown) {
    onChange({ [key]: value, page: 1 });
  }

  function clearAll() {
    const reset: Partial<ReportFilters> = { page: 1 };
    filterDefs.forEach((f) => { reset[f.key] = undefined; });
    onChange(reset);
  }

  const hasActive = filterDefs.some((f) => {
    const v = filters[f.key];
    return v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0);
  });

  return (
    <div className="bg-white ring-1 ring-slate-200 shadow-sm">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-4 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-50 transition-colors"
      >
        <span className="flex items-center gap-2">
          <SlidersHorizontal className="w-4 h-4" />
          {t("reports.view.filters")}
          {hasActive && <span className="w-2 h-2 bg-[var(--accent)] rounded-full" />}
        </span>
        <span className="text-slate-400 text-xs">{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div className="px-4 pb-4 pt-2 space-y-4 border-t border-slate-100">
          {filterDefs.map((f) => {
            const current = filters[f.key];

            if (f.type === "search") {
              return (
                <div key={f.key}>
                  <label className="block text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-1">{t(f.labelKey)}</label>
                  <input
                    type="text"
                    value={String(current ?? "")}
                    onChange={(e) => handleChange(f.key, e.target.value || undefined)}
                    placeholder={t("reports.view.search_placeholder")}
                    className="w-full border border-slate-200 px-2.5 py-1.5 text-sm text-slate-700 focus:outline-none focus:border-[var(--accent)]"
                  />
                </div>
              );
            }

            if (f.type === "select") {
              return (
                <div key={f.key}>
                  <label className="block text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-1">{t(f.labelKey)}</label>
                  <select
                    value={String(current ?? "")}
                    onChange={(e) => handleChange(f.key, e.target.value || undefined)}
                    className="w-full border border-slate-200 px-2.5 py-1.5 text-sm text-slate-700 focus:outline-none focus:border-[var(--accent)] bg-white"
                  >
                    <option value="">{t("reports.filter.all")}</option>
                    {f.options?.map((o) => (
                      <option key={o.value} value={o.value}>{t(o.labelKey)}</option>
                    ))}
                  </select>
                </div>
              );
            }

            if (f.type === "multi-select") {
              const selected = Array.isArray(current) ? (current as string[]) : [];
              return (
                <div key={f.key}>
                  <label className="block text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-1.5">{t(f.labelKey)}</label>
                  <div className="flex flex-wrap gap-1.5">
                    {f.options?.map((o) => {
                      const active = selected.includes(o.value);
                      return (
                        <button
                          key={o.value}
                          onClick={() => {
                            const next = active
                              ? selected.filter((v) => v !== o.value)
                              : [...selected, o.value];
                            handleChange(f.key, next.length ? next : undefined);
                          }}
                          className={[
                            "text-[11px] px-2 py-1 border font-medium transition-colors",
                            active
                              ? "border-[var(--accent)] bg-[var(--accent)] text-white"
                              : "border-slate-200 text-slate-600 hover:border-slate-300",
                          ].join(" ")}
                        >
                          {t(o.labelKey)}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            }

            if (f.type === "date-range") {
              return (
                <div key={f.key}>
                  <label className="block text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-1">{t(f.labelKey)}</label>
                  <input
                    type="date"
                    value={String(current ?? "")}
                    onChange={(e) => handleChange(f.key, e.target.value || undefined)}
                    className="w-full border border-slate-200 px-2.5 py-1.5 text-sm text-slate-700 focus:outline-none focus:border-[var(--accent)]"
                  />
                </div>
              );
            }

            return null;
          })}

          {hasActive && (
            <button
              onClick={clearAll}
              className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-700"
            >
              <X className="w-3.5 h-3.5" /> {t("reports.view.clear")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

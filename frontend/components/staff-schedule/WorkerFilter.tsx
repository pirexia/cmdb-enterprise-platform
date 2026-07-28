"use client";

import { useEffect, useRef, useState } from "react";
import { RefreshCw, X } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { displayLabel } from "@/lib/displayLabel";
import { useWorkerSearch } from "@/app/staff-schedule/hooks/useStaffSchedule";

interface Props {
  /** Label of the currently selected worker, or null if none is selected. */
  selectedLabel: string | null;
  onSelect: (userId: string, label: string) => void;
  onClear: () => void;
}

// v3.5.12 (R5/F4) — searchable worker combobox. Same debounced-search UX as
// the SISTEMA CI combobox in /decommission (v2.8.6): a text input that opens
// a dropdown of matches on focus/typing, no separate "search" button.
export default function WorkerFilter({ selectedLabel, onSelect, onClear }: Props) {
  const { t } = useLanguage();
  const [query, setQuery] = useState(selectedLabel ?? "");
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const { results, loading } = useWorkerSearch(open ? query : "");

  // Keep the input text in sync when the parent clears/changes the selection
  // from elsewhere (e.g. switching back to department mode and back).
  useEffect(() => {
    setQuery(selectedLabel ?? "");
  }, [selectedLabel]);

  useEffect(() => {
    if (!open) return;
    const onClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  const showMinCharsHint = open && query.trim().length > 0 && query.trim().length < 2;

  return (
    <div ref={containerRef} className="relative flex items-center gap-2">
      <label className="text-xs font-medium text-slate-600">{t("staffSchedule.filter.worker")}</label>
      <div className="relative">
        <input
          type="text"
          value={query}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          placeholder={t("staffSchedule.filter.searchWorker")}
          className="rounded-none border border-slate-300 bg-white px-2.5 py-2 pr-7 text-sm min-w-[14rem] focus:outline-none focus:border-[var(--accent)]"
        />
        {selectedLabel && (
          <button
            type="button"
            onClick={() => {
              onClear();
              setQuery("");
              setOpen(false);
            }}
            title={t("staffSchedule.filter.clearWorker")}
            className="absolute right-1.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}

        {open && (
          <div className="absolute z-40 mt-1 w-full rounded-none border border-slate-200 bg-white shadow-sm divide-y divide-slate-100 max-h-56 overflow-y-auto">
            {showMinCharsHint ? (
              <div className="px-3 py-2 text-xs text-slate-500">{t("staffSchedule.filter.minChars")}</div>
            ) : loading ? (
              <div className="flex items-center gap-2 px-3 py-2 text-xs text-slate-500">
                <RefreshCw className="h-3 w-3 animate-spin" /> {t("common.loading")}
              </div>
            ) : query.trim().length < 2 ? (
              <div className="px-3 py-2 text-xs text-slate-500">{t("staffSchedule.filter.minChars")}</div>
            ) : results.length === 0 ? (
              <div className="px-3 py-2 text-xs text-slate-500">{t("staffSchedule.filter.noWorkers")}</div>
            ) : (
              results.map((u) => (
                <button
                  key={u.id}
                  type="button"
                  onClick={() => {
                    const label = displayLabel(u);
                    onSelect(u.id, label);
                    setQuery(label);
                    setOpen(false);
                  }}
                  className="w-full text-left px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 transition-colors"
                >
                  {displayLabel(u)}
                </button>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}

"use client";

import { useState, useEffect, useRef } from "react";
import { useLanguage } from "@/contexts/LanguageContext";
import { apiFetch } from "@/lib/apiFetch";
import { TimelineKind, TimelineFiltersState, TimelineFiltersData, DEFAULT_FILTERS } from "../types/timeline";
import { Search, X, ChevronDown } from "lucide-react";

interface Props {
  filters: TimelineFiltersState;
  filtersData: TimelineFiltersData | null;
  onChange: (patch: Partial<TimelineFiltersState>) => void;
  onClear: () => void;
}

const ALL_TYPES: { value: TimelineKind; labelKey: string }[] = [
  { value: "ci",           labelKey: "timeline.filters.type_ci"           },
  { value: "contract",     labelKey: "timeline.filters.type_contract"     },
  { value: "license",      labelKey: "timeline.filters.type_license"      },
  { value: "decommission", labelKey: "timeline.filters.type_decommission" },
  { value: "os",           labelKey: "timeline.filters.type_os"           },
  { value: "software",     labelKey: "timeline.filters.type_software"     },
  { value: "model",        labelKey: "timeline.filters.type_model"        },
];

const DATE_TYPES: { value: string; labelKey: string }[] = [
  { value: "eol",       labelKey: "timeline.filters.date_eol"       },
  { value: "eos",       labelKey: "timeline.filters.date_eos"       },
  { value: "end",       labelKey: "timeline.filters.date_end"       },
  { value: "start",     labelKey: "timeline.filters.date_start"     },
  { value: "completed", labelKey: "timeline.filters.date_completed" },
  { value: "custom",    labelKey: "timeline.filters.date_custom"    },
];

function Checkbox({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <label className="flex items-center gap-1.5 cursor-pointer text-xs text-slate-700 whitespace-nowrap">
      <input
        type="checkbox"
        checked={checked}
        onChange={e => onChange(e.target.checked)}
        className="accent-[var(--accent)] h-3.5 w-3.5"
      />
      {label}
    </label>
  );
}

export default function TimelineFilters({ filters, filtersData, onChange, onClear }: Props) {
  const { t } = useLanguage();
  const [searchInput, setSearchInput] = useState(filters.search);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounce search
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      onChange({ search: searchInput });
    }, 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [searchInput]);

  function toggleType(kind: TimelineKind, checked: boolean) {
    const next = checked
      ? [...filters.types, kind]
      : filters.types.filter(t => t !== kind);
    onChange({ types: next });
  }

  function toggleStatus(val: string, checked: boolean) {
    const next = checked
      ? [...filters.status, val]
      : filters.status.filter(s => s !== val);
    onChange({ status: next });
  }

  function toggleDateType(val: string, checked: boolean) {
    const next = checked
      ? [...filters.dateTypes, val]
      : filters.dateTypes.filter(d => d !== val);
    onChange({ dateTypes: next });
  }

  const showCiSubtype  = filters.types.includes("ci");

  // Statuses relevant for selected types
  const relevantStatuses = (filtersData?.statuses ?? []).filter(s =>
    (s.kinds as string[]).some(k => filters.types.includes(k as TimelineKind)),
  );

  return (
    <div className="bg-white border border-slate-200 shadow-sm px-4 py-3 space-y-3">
      {/* Row 1: Type checkboxes + search */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="text-xs font-semibold text-slate-500 shrink-0">{t("timeline.filters.type")}:</span>
        {ALL_TYPES.map(({ value, labelKey }) => (
          <Checkbox
            key={value}
            label={t(labelKey)}
            checked={filters.types.includes(value)}
            onChange={v => toggleType(value, v)}
          />
        ))}

        {/* Search */}
        <div className="flex items-center gap-1 ml-auto">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-slate-400" />
            <input
              type="text"
              value={searchInput}
              onChange={e => setSearchInput(e.target.value)}
              placeholder={t("timeline.filters.search")}
              className="pl-6 pr-2 py-1.5 text-xs border border-slate-300 rounded-none w-44 focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
            />
            {searchInput && (
              <button
                onClick={() => { setSearchInput(""); onChange({ search: "" }); }}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Row 2: Subtype (CI type) + Status + DateType */}
      <div className="flex flex-wrap items-start gap-x-6 gap-y-2">
        {/* CI subtype */}
        {showCiSubtype && filtersData && (
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-slate-500 shrink-0">{t("timeline.filters.subtype")}:</span>
            <select
              value={filters.ciTypeId ?? ""}
              onChange={e => onChange({ ciTypeId: e.target.value || undefined })}
              className="text-xs border border-slate-300 py-1 px-2 rounded-none focus:outline-none focus:ring-1 focus:ring-[var(--accent)] bg-white"
            >
              <option value="">— Todos —</option>
              {filtersData.ciTypes.map(ct => (
                <option key={ct.id} value={ct.id}>{ct.name}</option>
              ))}
            </select>
          </div>
        )}

        {/* Status */}
        {relevantStatuses.length > 0 && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="text-xs font-semibold text-slate-500 shrink-0">{t("timeline.filters.status")}:</span>
            {relevantStatuses.map(s => (
              <Checkbox
                key={s.value}
                label={s.label}
                checked={filters.status.includes(s.value)}
                onChange={v => toggleStatus(s.value, v)}
              />
            ))}
          </div>
        )}

        {/* Date types */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-xs font-semibold text-slate-500 shrink-0">{t("timeline.filters.dateType")}:</span>
          {DATE_TYPES.map(({ value, labelKey }) => (
            <Checkbox
              key={value}
              label={t(labelKey)}
              checked={filters.dateTypes.includes(value)}
              onChange={v => toggleDateType(value, v)}
            />
          ))}
        </div>

        {/* Clear */}
        <button
          onClick={onClear}
          className="ml-auto text-xs text-slate-500 hover:text-slate-700 flex items-center gap-1 border border-slate-200 px-2 py-1 rounded-none hover:bg-slate-50"
        >
          <X className="h-3 w-3" />
          {t("timeline.filters.clear")}
        </button>
      </div>
    </div>
  );
}

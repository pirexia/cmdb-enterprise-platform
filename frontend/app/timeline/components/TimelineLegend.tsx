"use client";

import { useLanguage } from "@/contexts/LanguageContext";

const ITEMS = [
  { band: "green",    color: "#16a34a", labelKey: "timeline.legend.green"    },
  { band: "yellow",   color: "#ca8a04", labelKey: "timeline.legend.yellow"   },
  { band: "red",      color: "#dc2626", labelKey: "timeline.legend.red"      },
  { band: "expired",  color: "#475569", labelKey: "timeline.legend.expired"  },
  { band: "inactive", color: "#94a3b8", labelKey: "timeline.legend.inactive" },
  { band: "none",     color: "#3b82f6", labelKey: "timeline.legend.none"     },
] as const;

export default function TimelineLegend() {
  const { t } = useLanguage();
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2 px-4 bg-slate-50 border-t border-slate-200 text-xs text-slate-600">
      <span className="font-semibold text-slate-500 mr-1">Leyenda:</span>
      {ITEMS.map(item => (
        <span key={item.band} className="flex items-center gap-1">
          <span className="inline-block w-3 h-3" style={{ background: item.color }} />
          {t(item.labelKey)}
        </span>
      ))}
      <span className="flex items-center gap-1">
        <svg width="12" height="12">
          <polygon points="6,0 12,6 6,12 0,6" fill="none" stroke="#64748b" strokeWidth="1.5" strokeDasharray="3 2" />
        </svg>
        {t("timeline.legend.inherited")}
      </span>
    </div>
  );
}

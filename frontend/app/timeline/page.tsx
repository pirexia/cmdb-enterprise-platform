"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { useLanguage } from "@/contexts/LanguageContext";
import { RefreshCw, AlertTriangle, X } from "lucide-react";
import { ZoomLevel, TimelineMilestone } from "./types/timeline";
import { useTimeline, useTimelineFiltersData, useLegacyDates } from "./hooks/useTimeline";
import { useTimelineFilters } from "./hooks/useTimelineFilters";
import TimelineGantt, { type TimelineGanttHandle } from "./components/TimelineGantt";
import TimelineFilters from "./components/TimelineFilters";
import TimelineToolbar from "./components/TimelineToolbar";
import TimelineLegend from "./components/TimelineLegend";

export default function TimelinePage() {
  const { t } = useLanguage();
  const [zoom, setZoom]               = useState<ZoomLevel>("month");
  const [selectedCiId, setSelectedCiId] = useState<string | null>(null);
  const ganttRef = useRef<TimelineGanttHandle>(null);

  const { filters, updateFilters, clearFilters, initialized } = useTimelineFilters();
  const filtersData = useTimelineFiltersData();
  const { items, loading, error, refetch }                    = useTimeline(filters, initialized);
  const { legacy }                                            = useLegacyDates(selectedCiId);

  const legacyMap: Record<string, TimelineMilestone[]> =
    selectedCiId && legacy ? { [selectedCiId]: legacy.milestones } : {};

  const handleCenterToday = useCallback(() => { ganttRef.current?.centerToday(); }, []);

  // Mobile guard
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 1024);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  if (isMobile) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-8">
        <div className="text-center space-y-2">
          <p className="text-slate-600 font-medium">{t("timeline.mobile_warning")}</p>
          <p className="text-sm text-slate-400">{t("timeline.mobile_hint")}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50">
      {/* ── Header ────────────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white px-8 py-5">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-slate-900">{t("timeline.title")}</h1>
            <p className="text-sm text-slate-500 mt-0.5">
              {loading
                ? t("common.loading")
                : `${items.length} ${t("timeline.items_count")}`}
            </p>
          </div>
          <button
            onClick={refetch}
            disabled={loading}
            className="rounded-none border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50 flex items-center gap-1.5"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            {t("actions.refresh") || "Actualizar"}
          </button>
        </div>
      </header>

      {/* ── Content ───────────────────────────────────────────────────────── */}
      <div className="px-8 py-6 space-y-4 w-full">

        {/* Filters */}
        <TimelineFilters
          filters={filters}
          filtersData={filtersData}
          onChange={updateFilters}
          onClear={clearFilters}
        />

        {/* Toolbar */}
        <div className="bg-white border border-slate-200 shadow-sm px-4 py-2.5 flex items-center gap-4 flex-wrap">
          <TimelineToolbar zoom={zoom} onZoomChange={setZoom} onCenterToday={handleCenterToday} />
          <span className="text-xs text-slate-400 ml-auto hidden sm:block">
            {t("timeline.hint_ctrl_scroll")}
          </span>
        </div>

        {/* Error */}
        {error && (
          <div className="flex items-center gap-2 bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            {error}
            <button onClick={refetch} className="ml-auto underline text-xs">Reintentar</button>
          </div>
        )}

        {/* Loading */}
        {loading && (
          <div className="bg-white border border-slate-200 shadow-sm p-8 flex items-center gap-3 text-slate-500 text-sm">
            <RefreshCw className="h-4 w-4 animate-spin" />
            {t("common.loading")}
          </div>
        )}

        {/* Gantt */}
        {!loading && !error && (
          <div className="bg-white shadow-sm ring-1 ring-slate-200 overflow-hidden">
            <TimelineGantt
              ref={ganttRef}
              items={items}
              zoom={zoom}
              onZoomChange={setZoom}
              legacyMap={legacyMap}
              onClickItem={(id) => setSelectedCiId(prev => prev === id ? null : id)}
            />
            <TimelineLegend />
          </div>
        )}

        {/* Selected CI inherited dates bar */}
        {selectedCiId && (
          <div className="bg-blue-50 border border-blue-200 px-4 py-3 text-xs text-blue-800 flex items-start gap-2">
            <span className="font-semibold shrink-0">{t("timeline.legend.inherited")}:</span>
            <span>
              {legacy?.milestones.length
                ? legacy.milestones.map(m => `${m.label} (${m.date})`).join(" · ")
                : t("timeline.no_inherited_dates")}
            </span>
            <button
              onClick={() => setSelectedCiId(null)}
              className="ml-auto text-blue-500 hover:text-blue-700 shrink-0"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

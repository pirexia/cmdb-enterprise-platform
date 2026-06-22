"use client";

import { ZoomLevel } from "../types/timeline";
import { useLanguage } from "@/contexts/LanguageContext";
import { CalendarClock, ZoomIn, ZoomOut, Target } from "lucide-react";

const ZOOM_LEVELS: ZoomLevel[] = ["day", "week", "month", "quarter", "year"];

interface Props {
  zoom: ZoomLevel;
  onZoomChange: (z: ZoomLevel) => void;
  onCenterToday: () => void;
}

export default function TimelineToolbar({ zoom, onZoomChange, onCenterToday }: Props) {
  const { t } = useLanguage();

  const zoomIn = () => {
    const idx = ZOOM_LEVELS.indexOf(zoom);
    if (idx > 0) onZoomChange(ZOOM_LEVELS[idx - 1]);
  };
  const zoomOut = () => {
    const idx = ZOOM_LEVELS.indexOf(zoom);
    if (idx < ZOOM_LEVELS.length - 1) onZoomChange(ZOOM_LEVELS[idx + 1]);
  };

  const btnBase = "rounded-none border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50 transition-colors";
  const btnActive = "rounded-none border border-[var(--accent)] bg-[var(--accent)] px-3 py-2 text-xs font-medium text-white";

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {/* Zoom level buttons */}
      <div className="flex border border-slate-300 rounded-none overflow-hidden">
        {ZOOM_LEVELS.map((z) => (
          <button
            key={z}
            onClick={() => onZoomChange(z)}
            className={zoom === z ? btnActive : btnBase}
          >
            {t(`timeline.zoom.${z}`)}
          </button>
        ))}
      </div>

      {/* Zoom in/out */}
      <button onClick={zoomIn}  className={btnBase} title={t("timeline.zoom.in")}>
        <ZoomIn className="h-3.5 w-3.5" />
      </button>
      <button onClick={zoomOut} className={btnBase} title={t("timeline.zoom.out")}>
        <ZoomOut className="h-3.5 w-3.5" />
      </button>

      {/* Center today */}
      <button onClick={onCenterToday} className={btnBase}>
        <Target className="h-3.5 w-3.5 mr-1 inline" />
        {t("timeline.today")}
      </button>

      {/* Hint */}
      <span className="text-xs text-slate-400 hidden sm:inline">
        Ctrl + scroll para zoom
      </span>
    </div>
  );
}

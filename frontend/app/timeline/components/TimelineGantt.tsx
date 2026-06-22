"use client";

import React, {
  useRef, useCallback, useEffect, useMemo,
  forwardRef, useImperativeHandle,
} from "react";
import { useLanguage } from "@/contexts/LanguageContext";
import { TimelineItem, TimelineMilestone, ZoomLevel } from "../types/timeline";
import { getBandFromItem, getTokens, getColorBand } from "@/lib/timelineColor";

// ─── Layout constants ─────────────────────────────────────────────────────────
const LABEL_W     = 230;
const ROW_H       = 38;
const HEADER_H    = 56;
const DIAMOND_R   = 7;

const PX_PER_DAY: Record<ZoomLevel, number> = {
  day: 40, week: 10, month: 3, quarter: 1.2, year: 0.35,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
function diffDays(a: Date, b: Date) { return (b.getTime() - a.getTime()) / 86_400_000; }
function addDays(d: Date, n: number) { return new Date(d.getTime() + n * 86_400_000); }

function buildTicks(start: Date, end: Date, zoom: ZoomLevel, pxDay: number) {
  const ticks: { x: number; label: string }[] = [];
  const loc = "es-ES";
  let c = new Date(start);

  if (zoom === "day") {
    while (c <= end) {
      ticks.push({ x: LABEL_W + diffDays(start, c) * pxDay, label: c.toLocaleDateString(loc, { day: "2-digit", month: "short" }) });
      c = addDays(c, 1);
    }
  } else if (zoom === "week") {
    const dow = c.getUTCDay();
    c = addDays(c, dow === 0 ? 1 : dow === 1 ? 0 : 8 - dow);
    while (c <= end) {
      ticks.push({ x: LABEL_W + diffDays(start, c) * pxDay, label: c.toLocaleDateString(loc, { day: "2-digit", month: "short" }) });
      c = addDays(c, 7);
    }
  } else if (zoom === "month") {
    c = new Date(Date.UTC(c.getUTCFullYear(), c.getUTCMonth(), 1));
    while (c <= end) {
      ticks.push({ x: LABEL_W + diffDays(start, c) * pxDay, label: c.toLocaleDateString(loc, { month: "short", year: "numeric" }) });
      c = new Date(Date.UTC(c.getUTCFullYear(), c.getUTCMonth() + 1, 1));
    }
  } else if (zoom === "quarter") {
    c = new Date(Date.UTC(c.getUTCFullYear(), Math.floor(c.getUTCMonth() / 3) * 3, 1));
    while (c <= end) {
      const q = Math.floor(c.getUTCMonth() / 3) + 1;
      ticks.push({ x: LABEL_W + diffDays(start, c) * pxDay, label: `Q${q} ${c.getUTCFullYear()}` });
      c = new Date(Date.UTC(c.getUTCFullYear(), c.getUTCMonth() + 3, 1));
    }
  } else {
    c = new Date(Date.UTC(c.getUTCFullYear(), 0, 1));
    while (c <= end) {
      ticks.push({ x: LABEL_W + diffDays(start, c) * pxDay, label: String(c.getUTCFullYear()) });
      c = new Date(Date.UTC(c.getUTCFullYear() + 1, 0, 1));
    }
  }
  return ticks;
}

// ─── Diamond ─────────────────────────────────────────────────────────────────
function Diamond({ cx, cy, r, fill, stroke, dashed }: {
  cx: number; cy: number; r: number; fill: string; stroke: string; dashed?: boolean;
}) {
  return (
    <polygon
      points={`${cx},${cy - r} ${cx + r},${cy} ${cx},${cy + r} ${cx - r},${cy}`}
      fill={dashed ? "none" : fill}
      stroke={stroke}
      strokeWidth={dashed ? 1.5 : 1}
      strokeDasharray={dashed ? "3 2" : undefined}
      opacity={dashed ? 0.75 : 1}
    />
  );
}

// ─── Row ─────────────────────────────────────────────────────────────────────
function GanttRow({ item, y, startDate, pxDay, svgWidth, legacyMilestones, onClickItem, locale }: {
  item: TimelineItem; y: number; startDate: Date; pxDay: number; svgWidth: number;
  legacyMilestones?: TimelineMilestone[]; onClickItem?: (id: string) => void; locale: string;
}) {
  const band   = getBandFromItem(item);
  const tokens = getTokens(band);
  const midY   = y + ROW_H / 2;
  const allMs  = [...item.milestones, ...(legacyMilestones ?? [])];

  const xOf = (d: string) => LABEL_W + diffDays(startDate, new Date(d + "T00:00:00Z")) * pxDay;

  return (
    <g>
      <rect x={0} y={y} width={svgWidth} height={ROW_H} fill="white" stroke="#e2e8f0" strokeWidth={0.5} />

      {/* Label */}
      <clipPath id={`lbl-${item.id}`}><rect x={0} y={y} width={LABEL_W - 10} height={ROW_H} /></clipPath>
      <text x={8} y={midY + 4} fill="#1e293b" fontSize={11}
        clipPath={`url(#lbl-${item.id})`}
        onClick={() => onClickItem?.(item.id)}
        style={{ cursor: "pointer", fontFamily: "inherit" } as React.CSSProperties}
      >
        {item.name}
      </text>
      <line x1={LABEL_W} y1={y} x2={LABEL_W} y2={y + ROW_H} stroke="#e2e8f0" strokeWidth={1} />

      {/* Kind badge */}
      <rect x={LABEL_W - 28} y={midY - 7} width={24} height={14} rx={2} fill="#f1f5f9" />
      <text x={LABEL_W - 16} y={midY + 4} textAnchor="middle" fill="#64748b" fontSize={8}>
        {item.kind.toUpperCase().slice(0, 2)}
      </text>

      {/* Bar (interval items) */}
      {item.startDate && item.endDate && (() => {
        const x1 = xOf(item.startDate), x2 = xOf(item.endDate);
        const w = Math.max(x2 - x1, 4);
        return (
          <g>
            <rect x={x1} y={midY - 8} width={w} height={16} fill={tokens.fill} rx={3} opacity={0.85} />
            <Diamond cx={x2} cy={midY} r={DIAMOND_R} fill={tokens.fill} stroke={tokens.stroke} />
            <title>{`${item.name}\n${item.startDate} → ${item.endDate}`}</title>
          </g>
        );
      })()}

      {/* Milestones */}
      {allMs.map((m, i) => {
        const cx = xOf(m.date);
        const mT = getTokens(getColorBand(m.date, item.status));
        return (
          <g key={i}>
            <Diamond cx={cx} cy={midY} r={DIAMOND_R} fill={mT.fill} stroke={mT.stroke} dashed={m.inherited} />
            <title>{`${m.label}\n${new Date(m.date + "T00:00:00Z").toLocaleDateString(locale)}${m.inherited ? "\n↑ Heredado" : ""}`}</title>
          </g>
        );
      })}
    </g>
  );
}

// ─── Imperative handle type ───────────────────────────────────────────────────
export interface TimelineGanttHandle {
  centerToday: () => void;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
interface Props {
  items: TimelineItem[];
  zoom: ZoomLevel;
  onZoomChange: (z: ZoomLevel) => void;
  legacyMap?: Record<string, TimelineMilestone[]>;
  onClickItem?: (id: string) => void;
}

const TimelineGantt = forwardRef<TimelineGanttHandle, Props>(
  function TimelineGantt({ items, zoom, onZoomChange, legacyMap, onClickItem }, ref) {
    const { locale } = useLanguage();
    const containerRef = useRef<HTMLDivElement>(null);
    const pxDay = PX_PER_DAY[zoom];

    const { startDate, endDate, todayX } = useMemo(() => {
      const dates: Date[] = [];
      for (const item of items) {
        if (item.startDate) dates.push(new Date(item.startDate + "T00:00:00Z"));
        if (item.endDate)   dates.push(new Date(item.endDate   + "T00:00:00Z"));
        for (const m of item.milestones) dates.push(new Date(m.date + "T00:00:00Z"));
      }
      const today = new Date();
      dates.push(today);
      const minTs = Math.min(...dates.map(d => d.getTime()));
      const maxTs = Math.max(...dates.map(d => d.getTime()));
      const sd = new Date(minTs - 90 * 86_400_000);
      const ed = new Date(maxTs + 180 * 86_400_000);
      return {
        startDate: sd,
        endDate: ed,
        todayX: LABEL_W + diffDays(sd, today) * pxDay,
      };
    }, [items, pxDay]);

    const svgWidth  = LABEL_W + Math.ceil(diffDays(startDate, endDate)) * pxDay;
    const svgHeight = HEADER_H + items.length * ROW_H;
    const ticks = useMemo(() => buildTicks(startDate, endDate, zoom, pxDay), [startDate, endDate, zoom, pxDay]);

    const centerToday = useCallback(() => {
      if (!containerRef.current) return;
      containerRef.current.scrollLeft = todayX - containerRef.current.clientWidth / 2;
    }, [todayX]);

    useImperativeHandle(ref, () => ({ centerToday }), [centerToday]);
    useEffect(() => { centerToday(); }, [centerToday]);

    const handleWheel = useCallback((e: React.WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const levels: ZoomLevel[] = ["year", "quarter", "month", "week", "day"];
      const idx = levels.indexOf(zoom);
      if (e.deltaY < 0 && idx < levels.length - 1) onZoomChange(levels[idx + 1]);
      if (e.deltaY > 0 && idx > 0)                  onZoomChange(levels[idx - 1]);
    }, [zoom, onZoomChange]);

    if (items.length === 0) {
      return (
        <div className="flex items-center justify-center py-20 text-slate-500 text-sm">
          No hay items para mostrar en el rango seleccionado.
        </div>
      );
    }

    return (
      <div ref={containerRef} className="overflow-auto" style={{ maxHeight: "65vh" }} onWheel={handleWheel}>
        <svg width={svgWidth} height={svgHeight} style={{ display: "block", fontFamily: "inherit", fontSize: 11 }}>
          {/* Header bg */}
          <rect x={0} y={0} width={svgWidth} height={HEADER_H} fill="#f8fafc" />

          {/* Ticks */}
          {ticks.map((tick, i) => (
            <g key={i}>
              <line x1={tick.x} y1={HEADER_H} x2={tick.x} y2={svgHeight} stroke="#e2e8f0" strokeWidth={1} />
              <line x1={tick.x} y1={HEADER_H - 8} x2={tick.x} y2={HEADER_H} stroke="#cbd5e1" strokeWidth={1} />
              <text x={tick.x + 3} y={HEADER_H - 12} fill="#64748b" fontSize={10}>{tick.label}</text>
            </g>
          ))}

          {/* Today line */}
          <line x1={todayX} y1={0} x2={todayX} y2={svgHeight} stroke="#ef4444" strokeWidth={2} />
          <rect x={todayX - 16} y={2} width={32} height={15} rx={3} fill="#ef4444" />
          <text x={todayX} y={13} textAnchor="middle" fill="white" fontSize={9} fontWeight="bold">HOY</text>

          {/* Header separator + label column */}
          <line x1={0} y1={HEADER_H} x2={svgWidth} y2={HEADER_H} stroke="#cbd5e1" strokeWidth={1.5} />
          <rect x={0} y={0} width={LABEL_W} height={HEADER_H} fill="#f1f5f9" />
          <text x={8} y={HEADER_H - 10} fill="#475569" fontSize={11} fontWeight="600">Elemento</text>
          <line x1={LABEL_W} y1={0} x2={LABEL_W} y2={svgHeight} stroke="#cbd5e1" strokeWidth={1.5} />

          {/* Rows */}
          {items.map((item, i) => (
            <GanttRow
              key={item.id}
              item={item}
              y={HEADER_H + i * ROW_H}
              startDate={startDate}
              pxDay={pxDay}
              svgWidth={svgWidth}
              legacyMilestones={legacyMap?.[item.id]}
              onClickItem={onClickItem}
              locale={locale}
            />
          ))}
        </svg>
      </div>
    );
  },
);

export default TimelineGantt;

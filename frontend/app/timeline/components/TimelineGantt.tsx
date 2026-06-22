"use client";

import React, {
  useRef, useCallback, useEffect, useMemo,
  forwardRef, useImperativeHandle,
} from "react";
import { useLanguage } from "@/contexts/LanguageContext";
import { TimelineItem, TimelineLegacyChild, ZoomLevel, InheritedFrom } from "../types/timeline";
import { getBandFromItem, getTokens, getColorBand } from "@/lib/timelineColor";

// ─── Layout constants ─────────────────────────────────────────────────────────
const LABEL_W     = 260;
const ROW_H       = 38;
const CHILD_H     = 30;
const HEADER_H    = 56;
const DIAMOND_R   = 7;
const CHILD_R     = 6;
const CHILD_INDENT = 26;

const PX_PER_DAY: Record<ZoomLevel, number> = {
  day: 40, week: 10, month: 3, quarter: 1.2, year: 0.35,
};

const SOURCE_BADGE: Record<InheritedFrom, string> = {
  os: "SO", software: "SW", model: "MD", contract: "CO", license: "LI",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
function diffDays(a: Date, b: Date) { return (b.getTime() - a.getTime()) / 86_400_000; }
function addDays(d: Date, n: number) { return new Date(d.getTime() + n * 86_400_000); }
function parseDate(d: string) { return new Date(d + "T00:00:00Z"); }

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
      opacity={dashed ? 0.85 : 1}
    />
  );
}

// ─── Display row model ─────────────────────────────────────────────────────────
type DisplayRow =
  | { kind: "item"; item: TimelineItem }
  | { kind: "child"; parentId: string; child: TimelineLegacyChild }
  | { kind: "loading"; parentId: string }
  | { kind: "empty"; parentId: string };

function rowHeight(r: DisplayRow) { return r.kind === "item" ? ROW_H : CHILD_H; }

// ─── Item row ─────────────────────────────────────────────────────────────────
function ItemRow({ item, y, h, startDate, pxDay, svgWidth, locale, expandable, expanded, onToggle }: {
  item: TimelineItem; y: number; h: number; startDate: Date; pxDay: number; svgWidth: number;
  locale: string; expandable: boolean; expanded: boolean; onToggle: () => void;
}) {
  const band   = getBandFromItem(item);
  const tokens = getTokens(band);
  const midY   = y + h / 2;
  const labelX = expandable ? 26 : 10;
  const xOf = (d: string) => LABEL_W + diffDays(startDate, parseDate(d)) * pxDay;

  return (
    <g>
      <rect x={0} y={y} width={svgWidth} height={h} fill="white" stroke="#e2e8f0" strokeWidth={0.5} />

      {/* Chevron (CI only) */}
      {expandable && (
        <g onClick={onToggle} style={{ cursor: "pointer" }}>
          <rect x={2} y={y} width={22} height={h} fill="transparent" />
          <polygon
            points={expanded
              ? `${9},${midY - 3} ${17},${midY - 3} ${13},${midY + 4}`   // down
              : `${10},${midY - 4} ${17},${midY} ${10},${midY + 4}`}      // right
            fill="#64748b"
          />
        </g>
      )}

      {/* Label */}
      <clipPath id={`lbl-${item.id}`}><rect x={labelX} y={y} width={LABEL_W - labelX - 32} height={h} /></clipPath>
      <text x={labelX} y={midY + 4} fill="#1e293b" fontSize={11} fontWeight={expandable ? 600 : 400}
        clipPath={`url(#lbl-${item.id})`}
        onClick={expandable ? onToggle : undefined}
        style={{ cursor: expandable ? "pointer" : "default", fontFamily: "inherit" } as React.CSSProperties}
      >
        {item.name}
      </text>

      {/* Kind badge */}
      <rect x={LABEL_W - 28} y={midY - 7} width={24} height={14} rx={2} fill="#f1f5f9" />
      <text x={LABEL_W - 16} y={midY + 4} textAnchor="middle" fill="#64748b" fontSize={8}>
        {item.kind.toUpperCase().slice(0, 2)}
      </text>
      <line x1={LABEL_W} y1={y} x2={LABEL_W} y2={y + h} stroke="#e2e8f0" strokeWidth={1} />

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
      {item.milestones.map((m, i) => {
        const cx = xOf(m.date);
        const mT = getTokens(getColorBand(m.date, item.status));
        return (
          <g key={i}>
            <Diamond cx={cx} cy={midY} r={DIAMOND_R} fill={mT.fill} stroke={mT.stroke} />
            <title>{`${m.label}\n${parseDate(m.date).toLocaleDateString(locale)}`}</title>
          </g>
        );
      })}
    </g>
  );
}

// ─── Child row (indented inherited/related dates) ───────────────────────────────
function ChildRow({ child, y, h, startDate, pxDay, svgWidth, locale }: {
  child: TimelineLegacyChild; y: number; h: number; startDate: Date; pxDay: number; svgWidth: number; locale: string;
}) {
  const midY  = y + h / 2;
  const xOf = (d: string) => LABEL_W + diffDays(startDate, parseDate(d)) * pxDay;
  const band = getColorBand(child.endDate, child.status);
  const tok  = getTokens(band);
  const labelId = `${child.source}-${child.sourceName}-${y}`;

  return (
    <g>
      <rect x={0} y={y} width={svgWidth} height={h} fill="#fafbfc" stroke="#eef2f6" strokeWidth={0.5} />

      {/* Tree connector */}
      <text x={CHILD_INDENT - 12} y={midY + 4} fill="#94a3b8" fontSize={11}>↳</text>

      {/* Source badge */}
      <rect x={CHILD_INDENT} y={midY - 6} width={20} height={12} rx={2} fill="#e2e8f0" />
      <text x={CHILD_INDENT + 10} y={midY + 3} textAnchor="middle" fill="#475569" fontSize={7.5} fontWeight={600}>
        {SOURCE_BADGE[child.source]}
      </text>

      {/* Label */}
      <clipPath id={`clbl-${labelId}`}><rect x={CHILD_INDENT + 24} y={y} width={LABEL_W - CHILD_INDENT - 28} height={h} /></clipPath>
      <text x={CHILD_INDENT + 24} y={midY + 4} fill="#475569" fontSize={10}
        clipPath={`url(#clbl-${labelId})`} style={{ fontFamily: "inherit" }}>
        {child.sourceName}
      </text>
      <line x1={LABEL_W} y1={y} x2={LABEL_W} y2={y + h} stroke="#e2e8f0" strokeWidth={1} />

      {/* Bar (interval children: contracts, licenses) — dashed to mark inheritance */}
      {child.startDate && child.endDate && (() => {
        const x1 = xOf(child.startDate), x2 = xOf(child.endDate);
        const w = Math.max(x2 - x1, 4);
        return (
          <g>
            <rect x={x1} y={midY - 6} width={w} height={12} fill={tok.fill} fillOpacity={0.45}
              stroke={tok.stroke} strokeWidth={1} strokeDasharray="3 2" rx={2} />
            <title>{`${child.sourceName}\n${child.startDate} → ${child.endDate}`}</title>
          </g>
        );
      })()}

      {/* Milestones (dashed diamonds — inherited) */}
      {child.milestones.map((m, i) => {
        const cx = xOf(m.date);
        const mT = getTokens(getColorBand(m.date, child.status));
        return (
          <g key={i}>
            <Diamond cx={cx} cy={midY} r={CHILD_R} fill={mT.fill} stroke={mT.stroke} dashed />
            <title>{`${m.label} — ${child.sourceName}\n${parseDate(m.date).toLocaleDateString(locale)}`}</title>
          </g>
        );
      })}
    </g>
  );
}

// ─── Imperative handle ─────────────────────────────────────────────────────────
export interface TimelineGanttHandle { centerToday: () => void; }

// ─── Main ─────────────────────────────────────────────────────────────────────
interface Props {
  items: TimelineItem[];
  zoom: ZoomLevel;
  onZoomChange: (z: ZoomLevel) => void;
  expandedIds: Set<string>;
  onToggleExpand: (ciId: string) => void;
  legacyMap: Record<string, TimelineLegacyChild[]>;
  loadingIds: Set<string>;
}

const TimelineGantt = forwardRef<TimelineGanttHandle, Props>(
  function TimelineGantt({ items, zoom, onZoomChange, expandedIds, onToggleExpand, legacyMap, loadingIds }, ref) {
    const { t, locale } = useLanguage();
    const containerRef = useRef<HTMLDivElement>(null);
    const pxDay = PX_PER_DAY[zoom];

    // Build flattened display rows (items + expanded children)
    const displayRows = useMemo<DisplayRow[]>(() => {
      const rows: DisplayRow[] = [];
      for (const item of items) {
        rows.push({ kind: "item", item });
        if (item.kind === "ci" && expandedIds.has(item.id)) {
          const children = legacyMap[item.id];
          if (children === undefined) {
            if (loadingIds.has(item.id)) rows.push({ kind: "loading", parentId: item.id });
          } else if (children.length === 0) {
            rows.push({ kind: "empty", parentId: item.id });
          } else {
            for (const child of children) rows.push({ kind: "child", parentId: item.id, child });
          }
        }
      }
      return rows;
    }, [items, expandedIds, legacyMap, loadingIds]);

    // Date range from everything currently visible
    const { startDate, endDate, todayX } = useMemo(() => {
      const dates: Date[] = [];
      const push = (d?: string) => { if (d) dates.push(parseDate(d)); };
      for (const r of displayRows) {
        if (r.kind === "item") {
          push(r.item.startDate); push(r.item.endDate);
          for (const m of r.item.milestones) push(m.date);
        } else if (r.kind === "child") {
          push(r.child.startDate); push(r.child.endDate);
          for (const m of r.child.milestones) push(m.date);
        }
      }
      const today = new Date();
      dates.push(today);
      const minTs = Math.min(...dates.map(d => d.getTime()));
      const maxTs = Math.max(...dates.map(d => d.getTime()));
      const sd = new Date(minTs - 90 * 86_400_000);
      const ed = new Date(maxTs + 180 * 86_400_000);
      return { startDate: sd, endDate: ed, todayX: LABEL_W + diffDays(sd, today) * pxDay };
    }, [displayRows, pxDay]);

    const svgWidth  = LABEL_W + Math.ceil(diffDays(startDate, endDate)) * pxDay;
    const svgHeight = HEADER_H + displayRows.reduce((acc, r) => acc + rowHeight(r), 0);
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
          {t("timeline.no_data")}
        </div>
      );
    }

    // Render rows with running y
    let y = HEADER_H;
    const rowEls: React.ReactNode[] = [];
    for (let i = 0; i < displayRows.length; i++) {
      const r = displayRows[i];
      const h = rowHeight(r);
      if (r.kind === "item") {
        const expandable = r.item.kind === "ci";
        rowEls.push(
          <ItemRow
            key={`i-${r.item.id}`}
            item={r.item} y={y} h={h} startDate={startDate} pxDay={pxDay} svgWidth={svgWidth}
            locale={locale} expandable={expandable} expanded={expandedIds.has(r.item.id)}
            onToggle={() => onToggleExpand(r.item.id)}
          />,
        );
      } else if (r.kind === "child") {
        rowEls.push(
          <ChildRow
            key={`c-${r.parentId}-${i}`}
            child={r.child} y={y} h={h} startDate={startDate} pxDay={pxDay} svgWidth={svgWidth} locale={locale}
          />,
        );
      } else {
        const midY = y + h / 2;
        rowEls.push(
          <g key={`x-${r.parentId}-${i}`}>
            <rect x={0} y={y} width={svgWidth} height={h} fill="#fafbfc" stroke="#eef2f6" strokeWidth={0.5} />
            <text x={CHILD_INDENT} y={midY + 4} fill="#94a3b8" fontSize={10} fontStyle="italic">
              {r.kind === "loading" ? t("common.loading") : t("timeline.no_inherited_dates")}
            </text>
          </g>,
        );
      }
      y += h;
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
          <text x={todayX} y={13} textAnchor="middle" fill="white" fontSize={9} fontWeight="bold">{t("timeline.today")}</text>

          {/* Header separator + label column */}
          <line x1={0} y1={HEADER_H} x2={svgWidth} y2={HEADER_H} stroke="#cbd5e1" strokeWidth={1.5} />
          <rect x={0} y={0} width={LABEL_W} height={HEADER_H} fill="#f1f5f9" />
          <text x={8} y={HEADER_H - 10} fill="#475569" fontSize={11} fontWeight="600">{t("timeline.filters.type")}</text>
          <line x1={LABEL_W} y1={0} x2={LABEL_W} y2={svgHeight} stroke="#cbd5e1" strokeWidth={1.5} />

          {/* Rows */}
          {rowEls}
        </svg>
      </div>
    );
  },
);

export default TimelineGantt;

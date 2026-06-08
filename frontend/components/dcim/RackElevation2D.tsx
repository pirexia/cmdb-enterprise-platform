"use client";

import { useEffect, useState, useCallback } from "react";
import { RefreshCw, AlertTriangle, Zap } from "lucide-react";
import { apiFetch } from "@/lib/apiFetch";

// ─── Types ────────────────────────────────────────────────────────────────────

interface RackOccupant {
  ciId:        string;
  name:        string;
  status:      string;
  criticality: string;
  ciType:      string | null;
  uPosition:   number | null;
  sizeU:       number | null;
  powerW:      number | null;
  orientation: string | null;
}

interface RackElevationData {
  totalU:    number | null;
  maxPowerW: number | null;
  occupants: RackOccupant[];
}

interface Props {
  rackCiId:   string;
  rackName:   string;
  onClickCI?: (ciId: string) => void;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const U_HEIGHT = 22;   // px per 1U slot
const RACK_W   = 200;  // px rack body width
const LABEL_W  = 28;   // px U-number column
const PAD      = 8;

const CRIT_COLOR: Record<string, { fill: string; stroke: string; text: string }> = {
  MISSION_CRITICAL : { fill: "#fee2e2", stroke: "#ef4444", text: "#991b1b" },
  HIGH             : { fill: "#ffedd5", stroke: "#f97316", text: "#9a3412" },
  MEDIUM           : { fill: "#fef9c3", stroke: "#eab308", text: "#713f12" },
  LOW              : { fill: "#dcfce7", stroke: "#22c55e", text: "#166534" },
};
const DEFAULT_COLOR = { fill: "#f1f5f9", stroke: "#94a3b8", text: "#475569" };

// ─── Component ────────────────────────────────────────────────────────────────

export default function RackElevation2D({ rackCiId, rackName, onClickCI }: Props) {
  const [data, setData]         = useState<RackElevationData | null>(null);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState<string | null>(null);
  const [side, setSide]         = useState<"FRONT" | "REAR">("FRONT");
  const [hovered, setHovered]   = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await apiFetch(`/api/dcim/racks/${rackCiId}/elevation`);
      if (!r.ok) { setError("Error loading rack"); return; }
      setData(await r.json());
    } catch { setError("Error loading rack"); }
    finally { setLoading(false); }
  }, [rackCiId]);

  useEffect(() => { load(); }, [load]);

  if (loading) return (
    <div className="flex h-32 items-center justify-center text-slate-400">
      <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> Cargando rack...
    </div>
  );
  if (error || !data) return (
    <div className="flex h-32 items-center justify-center gap-2 text-red-400">
      <AlertTriangle className="h-4 w-4" /> {error ?? "Error"}
    </div>
  );

  const totalU   = data.totalU ?? 42;
  const svgH     = totalU * U_HEIGHT + PAD * 2;
  const svgW     = LABEL_W + RACK_W + PAD;

  // Filter occupants by selected side (null orientation shows on both sides)
  const visible = data.occupants.filter((o) =>
    o.orientation === null || o.orientation === side
  );

  // Build a set of occupied U slots → occupant reference
  const slotMap: Record<number, RackOccupant> = {};
  visible.forEach((occ) => {
    if (occ.uPosition == null) return;
    const sz = occ.sizeU ?? 1;
    for (let u = occ.uPosition; u < occ.uPosition + sz; u++) {
      slotMap[u] = occ;
    }
  });

  // Power usage
  const sumPower = visible.reduce((acc, o) => acc + (o.powerW ?? 0), 0);
  const powerPct = data.maxPowerW ? Math.round((sumPower / data.maxPowerW) * 100) : null;

  // Render occupied CI block (one rect per unique occupant, spans sizeU slots)
  const renderedCiIds = new Set<string>();

  return (
    <div className="flex flex-col gap-3 flex-1 min-h-0">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="truncate font-semibold text-slate-800">{rackName}</h3>
        <div className="flex rounded-none border border-slate-200 text-xs">
          <button
            onClick={() => setSide("FRONT")}
            className={`px-3 py-1 ${side === "FRONT" ? "bg-[var(--accent)] text-white" : "text-slate-500 hover:bg-slate-50"}`}
          >
            FRONT
          </button>
          <button
            onClick={() => setSide("REAR")}
            className={`px-3 py-1 ${side === "REAR" ? "bg-[var(--accent)] text-white" : "text-slate-500 hover:bg-slate-50"}`}
          >
            REAR
          </button>
        </div>
      </div>

      {/* Power bar */}
      {data.maxPowerW && (
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <Zap className="h-3 w-3 text-amber-500" />
          <div className="flex-1 h-2 rounded-full bg-slate-200">
            <div
              className={`h-2 rounded-full transition-all ${
                (powerPct ?? 0) >= 100 ? "bg-red-500" :
                (powerPct ?? 0) >= 80  ? "bg-amber-500" : "bg-green-500"
              }`}
              style={{ width: `${Math.min(powerPct ?? 0, 100)}%` }}
            />
          </div>
          <span>{sumPower}W / {data.maxPowerW}W {powerPct !== null ? `(${powerPct}%)` : ""}</span>
        </div>
      )}

      {/* SVG elevation — viewBox + height:100% so it fills the available drawer space */}
      <div className="flex-1 overflow-hidden rounded-none border border-slate-200 bg-slate-50 p-2">
        <svg
          viewBox={`0 0 ${svgW} ${svgH}`}
          preserveAspectRatio="xMidYMid meet"
          width="100%"
          height="100%"
          className="block"
          style={{ minHeight: 120 }}
        >
          {/* Rack outline */}
          <rect
            x={LABEL_W} y={PAD}
            width={RACK_W} height={totalU * U_HEIGHT}
            fill="#f8fafc" stroke="#cbd5e1" strokeWidth={1.5}
          />

          {/* U slots (top = U totalU, bottom = U1) */}
          {Array.from({ length: totalU }, (_, i) => {
            const u  = totalU - i;          // slot number (top = high U)
            const y  = PAD + i * U_HEIGHT;
            const occ = slotMap[u];

            return (
              <g key={u}>
                {/* U number label */}
                <text
                  x={LABEL_W - 4} y={y + U_HEIGHT / 2 + 4}
                  textAnchor="end" fontSize={9} fill="#94a3b8"
                >
                  {u}
                </text>

                {/* Slot divider */}
                <line
                  x1={LABEL_W} y1={y + U_HEIGHT}
                  x2={LABEL_W + RACK_W} y2={y + U_HEIGHT}
                  stroke="#e2e8f0" strokeWidth={0.5}
                />

                {/* Occupied CI block — only render the top occurrence */}
                {occ && !renderedCiIds.has(occ.ciId) && (() => {
                  renderedCiIds.add(occ.ciId);
                  const sz   = occ.sizeU ?? 1;
                  const topU = occ.uPosition! + sz - 1;
                  const yTop = PAD + (totalU - topU) * U_HEIGHT;
                  const h    = sz * U_HEIGHT;
                  const col  = CRIT_COLOR[occ.criticality] ?? DEFAULT_COLOR;
                  const isHov = hovered === occ.ciId;

                  return (
                    <g
                      onClick={() => onClickCI?.(occ.ciId)}
                      onMouseEnter={() => setHovered(occ.ciId)}
                      onMouseLeave={() => setHovered(null)}
                      style={{ cursor: onClickCI ? "pointer" : "default" }}
                    >
                      <rect
                        x={LABEL_W + 2} y={yTop + 1}
                        width={RACK_W - 4} height={h - 2}
                        fill={col.fill}
                        stroke={isHov ? col.stroke : col.stroke + "99"}
                        strokeWidth={isHov ? 2 : 1}
                        rx={2}
                      />
                      {/* CI name (clip to rect) */}
                      <clipPath id={`clip-${occ.ciId}`}>
                        <rect x={LABEL_W + 4} y={yTop + 1} width={RACK_W - 10} height={h - 2} />
                      </clipPath>
                      <text
                        x={LABEL_W + 8} y={yTop + Math.max(h / 2 + 4, 14)}
                        fontSize={10} fill={col.text} fontWeight={600}
                        clipPath={`url(#clip-${occ.ciId})`}
                      >
                        {occ.name}
                      </text>
                      {sz > 1 && (
                        <text
                          x={LABEL_W + 8} y={yTop + h / 2 + 16}
                          fontSize={9} fill={col.text} opacity={0.7}
                          clipPath={`url(#clip-${occ.ciId})`}
                        >
                          {sz}U{occ.powerW ? ` · ${occ.powerW}W` : ""}
                        </text>
                      )}
                    </g>
                  );
                })()}
              </g>
            );
          })}
        </svg>
      </div>

      {/* Hover detail — shown as fixed tooltip anchored to cursor, not below rack */}
      {hovered && (() => {
        const occ = visible.find((o) => o.ciId === hovered);
        if (!occ) return null;
        return (
          <div
            className="pointer-events-none absolute z-50 rounded-none border border-slate-200 bg-white p-2 text-xs shadow-lg"
            style={{ bottom: "calc(100% + 4px)", left: 0, right: 0 }}
          >
            <p className="font-semibold text-slate-800 truncate">{occ.name}</p>
            <p className="text-slate-500">{occ.ciType ?? "Hardware"} · U{occ.uPosition}{occ.sizeU && occ.sizeU > 1 ? `–U${(occ.uPosition ?? 0) + (occ.sizeU ?? 1) - 1}` : ""}</p>
            {occ.powerW && <p className="text-amber-600"><Zap className="inline h-3 w-3" /> {occ.powerW}W</p>}
            {onClickCI && <p className="mt-1 text-[var(--accent)]">↵ Clic para detalle</p>}
          </div>
        );
      })()}

      {/* Stats */}
      <div className="flex gap-4 text-xs text-slate-500">
        <span>{totalU}U total</span>
        <span>{visible.length} equipos</span>
        <span>{totalU - Object.keys(slotMap).length}U libre</span>
      </div>
    </div>
  );
}

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import ReactFlow, {
  Background, Controls, BackgroundVariant,
  useNodesState, Node, NodeProps,
  ReactFlowProvider, useReactFlow,
} from "reactflow";
import "reactflow/dist/style.css";
import { Server, Plus } from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface FpData {
  id:        string;
  label:     string;
  kind:      string;
  active:    boolean;
  gridX:     number;
  gridY:     number;
  rackCiId:  string | null;
  rackName?: string | null;
  aisleId:   string | null;
}

export interface AisleOption { id: string; name: string }

export interface HeatmapPoint {
  rackCiId:  string;
  gridX:     number;
  gridY:     number;
  sumPowerW: number;
  maxPowerW: number;
  usagePct:  number;
}

function heatColor(pct: number): string {
  if (pct >= 100) return "rgba(185,28,28,0.65)";
  if (pct >= 90)  return "rgba(239,68,68,0.55)";
  if (pct >= 80)  return "rgba(249,115,22,0.45)";
  if (pct >= 60)  return "rgba(234,179,8,0.35)";
  return                  "rgba(34,197,94,0.25)";
}

interface Props {
  footprints:          FpData[];
  aisles:              AisleOption[];
  heatmapData?:        HeatmapPoint[];
  roomWidthMm?:        number | null;
  roomDepthMm?:        number | null;
  selectedRackCiId?:   string | null;
  selectedEditFpId?:   string | null;
  editMode:            boolean;
  onClickRack:         (fp: FpData) => void;
  onSelectFp:          (fp: FpData | null) => void;
  onCreateFootprint:   (gridX: number, gridY: number) => Promise<void>;
  onDeleteFootprint:   (fpId: string) => Promise<void>;
  onUpdateFootprint:   (fpId: string, updates: Partial<FpData>) => Promise<void>;
}

// ─── Layout constants ─────────────────────────────────────────────────────────

const CELL_WIDTH_MM = 800;
const CELL_DEPTH_MM = 1200;
const CELL_W = 64;
const CELL_H = 96;
const GAP    = 4;
const DEFAULT_GRID_COLS = 8;
const DEFAULT_GRID_ROWS = 6;

// ─── Colors ───────────────────────────────────────────────────────────────────

export const KIND_STYLE: Record<string, { bg: string; border: string; text: string }> = {
  RACK_SLOT:      { bg: "#dcfce7", border: "#22c55e", text: "#15803d" },
  INFRASTRUCTURE: { bg: "#e2e8f0", border: "#94a3b8", text: "#475569" },
  EMPTY:          { bg: "#f8fafc", border: "#e2e8f0", text: "#94a3b8" },
  BLOCKED:        { bg: "#fecaca", border: "#dc2626", text: "#7f1d1d" },
  AISLE:          { bg: "#f1f5f9", border: "#64748b", text: "#334155" },
  AISLE_COLD:     { bg: "#dbeafe", border: "#3b82f6", text: "#1e40af" },
  AISLE_HOT:      { bg: "#fed7aa", border: "#ea580c", text: "#9a3412" },
};

export const KIND_ORDER = [
  "RACK_SLOT",
  "INFRASTRUCTURE",
  "AISLE_COLD",
  "AISLE_HOT",
  "AISLE",
  "BLOCKED",
  "EMPTY",
];

// ─── Footprint node — visual only, no interactive buttons ────────────────────
// All edit interactions (delete, rename, change kind) are handled in the parent
// via onNodeClick → edit panel rendered outside ReactFlow DOM.
// This is the same pattern used for AddCellNode: logic lives outside ReactFlow.

function FootprintNode({ data }: NodeProps) {
  const {
    fp, editMode, selectedRackCiId, selectedEditFpId, heatmapPct,
  } = data as {
    fp: FpData;
    editMode: boolean;
    selectedRackCiId: string | null;
    selectedEditFpId: string | null;
    heatmapPct: number | null;
  };

  const isRack       = fp.kind === "RACK_SLOT" && fp.rackCiId;
  const style        = KIND_STYLE[fp.kind] ?? KIND_STYLE.EMPTY;
  const isRackActive = !editMode && selectedRackCiId && fp.rackCiId === selectedRackCiId;
  const isEditSel    = editMode && selectedEditFpId === fp.id;

  let borderColor = style.border;
  let boxShadow: string | undefined;
  if (isRackActive) { borderColor = "var(--accent, #6366f1)"; boxShadow = "0 0 0 2px var(--accent, #6366f1)"; }
  if (isEditSel)    { borderColor = "#f59e0b"; boxShadow = "0 0 0 2px #f59e0b"; }

  return (
    <div
      className="nopan nodrag"
      style={{
        width         : CELL_W,
        height        : CELL_H,
        background    : heatmapPct !== null ? heatColor(heatmapPct) : style.bg,
        border        : `2px solid ${borderColor}`,
        boxShadow,
        position      : "relative",
        display       : "flex",
        flexDirection : "column",
        alignItems    : "center",
        justifyContent: "center",
        cursor        : "pointer",
        userSelect    : "none",
        borderRadius  : 2,
        transition    : "border-color 0.1s, box-shadow 0.1s",
        outline       : isEditSel ? "2px dashed #f59e0b" : undefined,
        outlineOffset : isEditSel ? "2px" : undefined,
      }}
    >
      {isRack ? (
        <>
          <Server size={20} color={style.text} />
          <span style={{ fontSize: 9, color: style.text, marginTop: 2, textAlign: "center", lineHeight: 1.2, maxWidth: CELL_W - 8, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {fp.rackName ?? fp.label}
          </span>
          <span style={{ fontSize: 7, color: style.text, opacity: 0.55, marginTop: 1 }}>{fp.label}</span>
        </>
      ) : (
        <span style={{ fontSize: 10, color: style.text, fontWeight: 600, textAlign: "center", padding: "0 4px" }}>{fp.label}</span>
      )}

      {heatmapPct !== null && (
        <span style={{ position: "absolute", bottom: 2, right: 3, fontSize: 8, fontWeight: 700, color: heatmapPct >= 80 ? "#7f1d1d" : "#14532d" }}>
          {heatmapPct}%
        </span>
      )}

      {/* Edit mode indicator dot */}
      {editMode && (
        <span style={{ position: "absolute", top: 3, left: 3, width: 5, height: 5, borderRadius: "50%", background: isEditSel ? "#f59e0b" : "#cbd5e1" }} />
      )}
    </div>
  );
}

// ─── Add footprint node (decorative, pointer-events:none) ─────────────────────

function AddCellNode() {
  return (
    <div
      style={{
        width: CELL_W, height: CELL_H,
        border: "2px dashed #cbd5e1", borderRadius: 2,
        display: "flex", alignItems: "center", justifyContent: "center",
        background: "rgba(255,255,255,0.4)",
        pointerEvents: "none",
      }}
    >
      <Plus size={20} color="#64748b" strokeWidth={2.5} />
    </div>
  );
}

const NODE_TYPES = { footprint: FootprintNode, addCell: AddCellNode };

// ─── Inner component ──────────────────────────────────────────────────────────

function PlanInner({
  footprints, aisles, selectedRackCiId, selectedEditFpId, editMode, heatmapData,
  roomWidthMm, roomDepthMm,
  onClickRack, onSelectFp, onCreateFootprint, onDeleteFootprint, onUpdateFootprint,
}: Props) {
  const { project } = useReactFlow();

  const heatMap = useMemo(() => {
    const m: Record<string, number> = {};
    (heatmapData ?? []).forEach((h) => { m[`${h.gridX},${h.gridY}`] = h.usagePct; });
    return m;
  }, [heatmapData]);

  const [nodes, setNodes, onNodesChange] = useNodesState([]);

  const gridCols = useMemo(() => {
    const fromRoom = roomWidthMm ? Math.ceil(roomWidthMm / CELL_WIDTH_MM) : 0;
    const fromFps  = footprints.length ? Math.max(...footprints.map((f) => f.gridX)) + 1 : 0;
    return Math.max(fromRoom, fromFps, DEFAULT_GRID_COLS);
  }, [roomWidthMm, footprints]);

  const gridRows = useMemo(() => {
    const fromRoom = roomDepthMm ? Math.ceil(roomDepthMm / CELL_DEPTH_MM) : 0;
    const fromFps  = footprints.length ? Math.max(...footprints.map((f) => f.gridY)) + 1 : 0;
    return Math.max(fromRoom, fromFps, DEFAULT_GRID_ROWS);
  }, [roomDepthMm, footprints]);

  const occupiedSet = useMemo(
    () => new Set(footprints.map((f) => `${f.gridX},${f.gridY}`)),
    [footprints]
  );

  const buildNodes = useCallback(() => {
    const fpNodes: Node[] = footprints.map((fp) => ({
      id        : fp.id,
      type      : "footprint",
      position  : { x: fp.gridX * (CELL_W + GAP), y: fp.gridY * (CELL_H + GAP) },
      draggable : false,
      selectable: false,
      data      : {
        fp, editMode, selectedRackCiId, selectedEditFpId,
        heatmapPct: heatmapData ? (heatMap[`${fp.gridX},${fp.gridY}`] ?? null) : null,
      },
    }));

    const addNodes: Node[] = [];
    if (editMode) {
      for (let y = 0; y < gridRows; y++) {
        for (let x = 0; x < gridCols; x++) {
          if (!occupiedSet.has(`${x},${y}`)) {
            addNodes.push({
              id        : `add-${x}-${y}`,
              type      : "addCell",
              position  : { x: x * (CELL_W + GAP), y: y * (CELL_H + GAP) },
              draggable : false,
              selectable: false,
              data      : {},
            });
          }
        }
      }
    }

    setNodes([...fpNodes, ...addNodes]);
  }, [footprints, editMode, selectedRackCiId, selectedEditFpId, gridCols, gridRows, occupiedSet, heatmapData, heatMap, setNodes]);

  useEffect(() => { buildNodes(); }, [buildNodes]);

  // onNodeClick is ReactFlow's official node-click callback — fires reliably unlike
  // onClick handlers on elements inside the node (which get swallowed by RF's pane handler).
  const handleNodeClick = useCallback((_event: React.MouseEvent, node: Node) => {
    // AddCellNode has pointer-events:none on its inner div, but ReactFlow's NodeWrapper
    // still captures the click and fires onNodeClick instead of onPaneClick.
    // Parse grid coords from the node id ("add-{x}-{y}") and delegate to create.
    if (node.type === "addCell") {
      if (!editMode) return;
      const parts = node.id.split("-"); // ["add", x, y]
      const gx = parseInt(parts[1], 10);
      const gy = parseInt(parts[2], 10);
      if (!isNaN(gx) && !isNaN(gy)) onCreateFootprint(gx, gy);
      return;
    }

    if (node.type !== "footprint") return;
    const fp: FpData = node.data.fp;
    if (editMode) {
      // In edit mode: select footprint for editing (panel rendered outside ReactFlow)
      onSelectFp(selectedEditFpId === fp.id ? null : fp);
    } else {
      // In view mode: open rack drawer
      if (fp.kind === "RACK_SLOT" && fp.rackCiId) onClickRack(fp);
    }
  }, [editMode, selectedEditFpId, onSelectFp, onClickRack, onCreateFootprint]);

  // onPaneClick: click on empty background → create footprint (edit mode only)
  const handlePaneClick = useCallback((event: React.MouseEvent) => {
    if (!editMode) return;
    const flowEl = (event.target as HTMLElement).closest('.react-flow') as HTMLElement | null;
    if (!flowEl) return;
    const rect = flowEl.getBoundingClientRect();
    const { x, y } = project({ x: event.clientX - rect.left, y: event.clientY - rect.top });
    const gx = Math.floor(x / (CELL_W + GAP));
    const gy = Math.floor(y / (CELL_H + GAP));
    if (gx < 0 || gy < 0 || gx >= gridCols || gy >= gridRows) return;
    if (occupiedSet.has(`${gx},${gy}`)) return;
    onCreateFootprint(gx, gy);
  }, [editMode, project, gridCols, gridRows, occupiedSet, onCreateFootprint]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={[]}
      onNodesChange={onNodesChange}
      nodeTypes={NODE_TYPES}
      onNodeClick={handleNodeClick}
      onPaneClick={handlePaneClick}
      fitView
      fitViewOptions={{ padding: 0.2 }}
      minZoom={0.3}
      maxZoom={3}
      panOnDrag
      zoomOnScroll
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={false}
      selectNodesOnDrag={false}
      style={{ background: "#f8fafc", cursor: editMode ? "crosshair" : "default" }}
    >
      <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="#e2e8f0" />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}

// ─── Public component ─────────────────────────────────────────────────────────

export default function RoomPlan2D(props: Props) {
  return (
    <ReactFlowProvider>
      <PlanInner {...props} />
    </ReactFlowProvider>
  );
}

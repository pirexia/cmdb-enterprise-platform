"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import ReactFlow, {
  Background, Controls, BackgroundVariant,
  useNodesState, Node, NodeProps,
  ReactFlowProvider, useReactFlow,
} from "reactflow";
import "reactflow/dist/style.css";
import { Server, Trash2, Pencil, Check, X, Plus } from "lucide-react";

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
  selectedRackCiId?:   string | null;
  editMode:            boolean;
  onClickRack:         (fp: FpData) => void;
  onCreateFootprint:   (gridX: number, gridY: number) => Promise<void>;
  onDeleteFootprint:   (fpId: string) => Promise<void>;
  onUpdateFootprint:   (fpId: string, updates: Partial<FpData>) => Promise<void>;
}

// ─── Layout constants ─────────────────────────────────────────────────────────

const CELL = 72;    // px per grid cell
const GAP  = 4;

// ─── Colors ───────────────────────────────────────────────────────────────────

const KIND_STYLE: Record<string, { bg: string; border: string; text: string }> = {
  RACK_SLOT:      { bg: "#dcfce7", border: "#22c55e", text: "#15803d" },
  INFRASTRUCTURE: { bg: "#e2e8f0", border: "#94a3b8", text: "#475569" },
  EMPTY:          { bg: "#f8fafc", border: "#e2e8f0", text: "#94a3b8" },
};

// ─── Footprint custom node ────────────────────────────────────────────────────

function FootprintNode({ data, selected }: NodeProps) {
  const {
    fp, editMode, selectedRackCiId,
    onClickRack, onDelete, onChangeKind,
    heatmapPct,
  } = data as {
    fp: FpData;
    editMode: boolean;
    selectedRackCiId: string | null;
    onClickRack: (fp: FpData) => void;
    onDelete: (id: string) => void;
    onChangeKind: (id: string, kind: string) => void;
    heatmapPct: number | null;
  };

  const isRack    = fp.kind === "RACK_SLOT" && fp.rackCiId;
  const style     = KIND_STYLE[fp.kind] ?? KIND_STYLE.EMPTY;
  const isSelected = selectedRackCiId && fp.rackCiId === selectedRackCiId;

  const [showKindPicker, setShowKindPicker] = useState(false);

  return (
    <div
      style={{
        width      : CELL,
        height     : CELL,
        background : heatmapPct !== null
          ? heatColor(heatmapPct)
          : style.bg,
        border     : `2px solid ${isSelected ? "var(--accent, #6366f1)" : style.border}`,
        boxShadow  : isSelected ? "0 0 0 2px var(--accent, #6366f1)" : undefined,
        position   : "relative",
        display    : "flex",
        flexDirection: "column",
        alignItems : "center",
        justifyContent: "center",
        cursor     : isRack ? "pointer" : editMode ? "pointer" : "default",
        userSelect : "none",
        borderRadius: 2,
        transition : "border-color 0.15s",
      }}
      onClick={() => {
        if (isRack && !editMode) onClickRack(fp);
        if (editMode) setShowKindPicker((v) => !v);
      }}
    >
      {/* Main icon / label */}
      {isRack ? (
        <>
          <Server size={20} color={style.text} />
          <span style={{ fontSize: 9, color: style.text, marginTop: 2, textAlign: "center", lineHeight: 1.2, maxWidth: CELL - 8, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {fp.rackName ?? fp.label}
          </span>
        </>
      ) : (
        <span style={{ fontSize: 10, color: style.text, fontWeight: 600 }}>{fp.label}</span>
      )}

      {/* Heatmap usage badge */}
      {heatmapPct !== null && (
        <span style={{ position: "absolute", bottom: 2, right: 3, fontSize: 8, fontWeight: 700, color: heatmapPct >= 80 ? "#7f1d1d" : "#14532d" }}>
          {heatmapPct}%
        </span>
      )}

      {/* Edit mode overlay */}
      {editMode && (
        <div style={{ position: "absolute", top: 2, right: 2, display: "flex", gap: 2 }}>
          <button
            onClick={(e) => { e.stopPropagation(); onDelete(fp.id); }}
            style={{ background: "#fee2e2", border: "none", borderRadius: 2, padding: "1px 3px", cursor: "pointer" }}
          >
            <Trash2 size={10} color="#ef4444" />
          </button>
        </div>
      )}

      {/* Kind picker popup */}
      {editMode && showKindPicker && (
        <div
          style={{ position: "absolute", top: CELL + 4, left: 0, zIndex: 100, background: "white", border: "1px solid #e2e8f0", borderRadius: 4, padding: 6, boxShadow: "0 4px 12px rgba(0,0,0,0.1)", minWidth: 130 }}
          onClick={(e) => e.stopPropagation()}
        >
          {["RACK_SLOT", "INFRASTRUCTURE", "EMPTY"].map((k) => (
            <button key={k} onClick={() => { onChangeKind(fp.id, k); setShowKindPicker(false); }}
              style={{ display: "block", width: "100%", textAlign: "left", padding: "4px 8px", fontSize: 11,
                background: fp.kind === k ? "#f0f9ff" : "transparent", border: "none", cursor: "pointer",
                color: fp.kind === k ? "#0ea5e9" : "#374151", borderRadius: 2 }}>
              {k}
            </button>
          ))}
          <hr style={{ margin: "4px 0", borderColor: "#f1f5f9" }} />
          <button onClick={() => setShowKindPicker(false)} style={{ display: "block", width: "100%", textAlign: "left", padding: "4px 8px", fontSize: 11, background: "transparent", border: "none", cursor: "pointer", color: "#94a3b8" }}>
            Cerrar
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Add footprint node (edit mode empty cells) ───────────────────────────────

function AddCellNode({ data }: NodeProps) {
  const { onAdd } = data as { onAdd: () => void };
  return (
    <div
      style={{ width: CELL, height: CELL, border: "2px dashed #cbd5e1", borderRadius: 2, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", background: "transparent" }}
      onClick={onAdd}
    >
      <Plus size={16} color="#94a3b8" />
    </div>
  );
}

const NODE_TYPES = { footprint: FootprintNode, addCell: AddCellNode };

// ─── Inner component (needs ReactFlowProvider) ────────────────────────────────

function PlanInner({
  footprints, aisles, selectedRackCiId, editMode, heatmapData,
  onClickRack, onCreateFootprint, onDeleteFootprint, onUpdateFootprint,
}: Props) {
  // Build a lookup: gridX,gridY → usagePct (only for rack footprints)
  const heatMap = useMemo(() => {
    const m: Record<string, number> = {};
    (heatmapData ?? []).forEach((h) => { m[`${h.gridX},${h.gridY}`] = h.usagePct; });
    return m;
  }, [heatmapData]);

  const [nodes, setNodes, onNodesChange] = useNodesState([]);

  // Track grid size for add-cell overlay
  const maxX = footprints.length ? Math.max(...footprints.map((f) => f.gridX)) : 3;
  const maxY = footprints.length ? Math.max(...footprints.map((f) => f.gridY)) : 3;

  const occupiedSet = useMemo(
    () => new Set(footprints.map((f) => `${f.gridX},${f.gridY}`)),
    [footprints]
  );

  const buildNodes = useCallback(() => {
    const fpNodes: Node[] = footprints.map((fp) => ({
      id       : fp.id,
      type     : "footprint",
      position : { x: fp.gridX * (CELL + GAP), y: fp.gridY * (CELL + GAP) },
      draggable: false,
      selectable: false,
      data     : {
        fp, editMode, selectedRackCiId,
        heatmapPct: heatmapData ? (heatMap[`${fp.gridX},${fp.gridY}`] ?? null) : null,
        onClickRack,
        onDelete : (id: string) => onDeleteFootprint(id),
        onChangeKind: (id: string, kind: string) => onUpdateFootprint(id, { kind }),
      },
    }));

    // Add-cell nodes in edit mode for cells adjacent to existing footprints
    const addNodes: Node[] = [];
    if (editMode) {
      for (let y = 0; y <= maxY + 1; y++) {
        for (let x = 0; x <= maxX + 1; x++) {
          if (!occupiedSet.has(`${x},${y}`)) {
            // only show add nodes near existing footprints (within 1 cell) or always in small grids
            const nearFp = footprints.some((f) => Math.abs(f.gridX - x) <= 1 && Math.abs(f.gridY - y) <= 1);
            if (nearFp || footprints.length === 0) {
              addNodes.push({
                id       : `add-${x}-${y}`,
                type     : "addCell",
                position : { x: x * (CELL + GAP), y: y * (CELL + GAP) },
                draggable: false,
                selectable: false,
                data     : { onAdd: () => onCreateFootprint(x, y) },
              });
            }
          }
        }
      }
    }

    setNodes([...fpNodes, ...addNodes]);
  }, [footprints, editMode, selectedRackCiId, maxX, maxY, occupiedSet, onClickRack, onDeleteFootprint, onUpdateFootprint, onCreateFootprint, setNodes]);

  useEffect(() => { buildNodes(); }, [buildNodes]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={[]}
      onNodesChange={onNodesChange}
      nodeTypes={NODE_TYPES}
      fitView
      fitViewOptions={{ padding: 0.2 }}
      minZoom={0.3}
      maxZoom={3}
      panOnDrag
      zoomOnScroll
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={false}
      style={{ background: "#f8fafc" }}
    >
      <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="#e2e8f0" />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}

// ─── Public component (wraps with provider) ───────────────────────────────────

export default function RoomPlan2D(props: Props) {
  return (
    <ReactFlowProvider>
      <PlanInner {...props} />
    </ReactFlowProvider>
  );
}

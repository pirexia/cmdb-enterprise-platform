"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  Server, ArrowLeft, Pencil, Check, X, RefreshCw,
  AlertTriangle, LayoutGrid, Zap, Edit3, Flame,
} from "lucide-react";
import { apiFetch } from "@/lib/apiFetch";
import { useAuth } from "@/contexts/AuthContext";
import { useLanguage } from "@/contexts/LanguageContext";
import dynamic from "next/dynamic";
import type { FpData, AisleOption, HeatmapPoint } from "@/components/dcim/RoomPlan2D";

const RoomPlan2D = dynamic(() => import("@/components/dcim/RoomPlan2D"), { ssr: false });
const RackElevation2D = dynamic(() => import("@/components/dcim/RackElevation2D"), { ssr: false });
import CIDetailModal from "@/components/CIDetailModal";

// ─── Types ────────────────────────────────────────────────────────────────────

interface RoomPlan {
  id: string;
  name: string;
  kind: string;
  widthMm: number | null;
  depthMm: number | null;
  notes: string | null;
  floor: {
    id: string;
    name: string;
    levelNumber: number;
    building: { id: string; name: string };
  };
  aisles: AisleOption[];
  footprints: (FpData & { rackCi?: { id: string; name: string; status: string } | null })[];
}

function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`rounded-none border border-slate-300 bg-slate-50 px-3 py-1.5 text-sm focus:border-[var(--accent)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]/30 ${props.className ?? ""}`} />;
}
function Sel(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`rounded-none border border-slate-300 bg-slate-50 px-3 py-1.5 text-sm focus:border-[var(--accent)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]/30 ${props.className ?? ""}`} />;
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function RoomPage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const { t } = useLanguage();

  const [room, setRoom]         = useState<RoomPlan | null>(null);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState<string | null>(null);

  // Room info edit
  const [editingRoom, setEditingRoom] = useState(false);
  const [saving, setSaving]           = useState(false);
  const [editName, setEditName]       = useState("");
  const [editKind, setEditKind]       = useState("CPD");
  const [editWidth, setEditWidth]     = useState("");
  const [editDepth, setEditDepth]     = useState("");

  // Floor plan edit mode
  const [planEditMode, setPlanEditMode] = useState(false);

  // Heatmap
  const [showHeatmap, setShowHeatmap]     = useState(false);
  const [heatmapData, setHeatmapData]     = useState<HeatmapPoint[] | null>(null);
  const [heatmapLoading, setHeatmapLoading] = useState(false);

  // Footprint creation form
  const [addForm, setAddForm] = useState<{ gridX: number; gridY: number } | null>(null);
  const [addLabel, setAddLabel]   = useState("A1");
  const [addKind, setAddKind]     = useState("RACK_SLOT");
  const [addAisleId, setAddAisleId] = useState("");

  // Rack drawer
  const [selectedRack, setSelectedRack] = useState<FpData | null>(null);

  // CI detail modal
  const [detailCI, setDetailCI] = useState<any | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await apiFetch(`/api/dcim/rooms/${id}/plan`);
      if (!r.ok) { setError(t("dcim.error")); return; }
      const data: RoomPlan = await r.json();
      setRoom(data);
      setEditName(data.name); setEditKind(data.kind);
      setEditWidth(data.widthMm?.toString() ?? "");
      setEditDepth(data.depthMm?.toString() ?? "");
    } catch { setError(t("dcim.error")); }
    finally { setLoading(false); }
  }, [id, t]);

  useEffect(() => { load(); }, [load]);

  // ── Room info save ─────────────────────────────────────────────────────────
  const saveRoom = async () => {
    setSaving(true);
    try {
      await apiFetch(`/api/dcim/rooms/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: editName, kind: editKind, widthMm: editWidth ? parseInt(editWidth) : null, depthMm: editDepth ? parseInt(editDepth) : null }),
      });
      setEditingRoom(false); await load();
    } catch { setError(t("dcim.error")); } finally { setSaving(false); }
  };

  // ── Footprint CRUD ─────────────────────────────────────────────────────────
  const handleCreateFootprint = useCallback(async (gridX: number, gridY: number) => {
    setAddForm({ gridX, gridY });
    setAddLabel(`${String.fromCharCode(65 + gridY)}${gridX + 1}`);
  }, []);

  const submitCreateFootprint = async () => {
    if (!addForm) return;
    await apiFetch("/api/dcim/footprints", {
      method: "POST",
      body: JSON.stringify({
        roomId  : id,
        gridX   : addForm.gridX,
        gridY   : addForm.gridY,
        label   : addLabel,
        kind    : addKind,
        aisleId : addAisleId || null,
        active  : true,
      }),
    });
    setAddForm(null); setAddLabel("A1"); setAddKind("RACK_SLOT"); setAddAisleId("");
    await load();
  };

  const handleDeleteFootprint = useCallback(async (fpId: string) => {
    if (!confirm(t("dcim.confirm_delete"))) return;
    await apiFetch(`/api/dcim/footprints/${fpId}`, { method: "DELETE" });
    await load();
  }, [id, t, load]);

  const handleUpdateFootprint = useCallback(async (fpId: string, updates: Partial<FpData>) => {
    await apiFetch(`/api/dcim/footprints/${fpId}`, {
      method: "PATCH",
      body: JSON.stringify(updates),
    });
    await load();
  }, [load]);

  // ── Heatmap ────────────────────────────────────────────────────────────────
  const toggleHeatmap = useCallback(async () => {
    if (showHeatmap) { setShowHeatmap(false); setHeatmapData(null); return; }
    setHeatmapLoading(true);
    try {
      const r = await apiFetch(`/api/dcim/rooms/${id}/heatmap`);
      if (r.ok) setHeatmapData(await r.json());
    } catch { /* ignore */ } finally { setHeatmapLoading(false); }
    setShowHeatmap(true);
  }, [id, showHeatmap]);

  // ── CI detail ──────────────────────────────────────────────────────────────
  const openCIDetail = useCallback(async (ciId: string) => {
    try {
      const r = await apiFetch(`/api/cis/${ciId}`);
      if (!r.ok) return;
      setDetailCI(await r.json());
    } catch { /* ignore */ }
  }, []);

  // ── Derived data ───────────────────────────────────────────────────────────
  const footprintData: FpData[] = (room?.footprints ?? []).map((fp) => ({
    ...fp,
    rackName: fp.rackCi?.name ?? null,
  }));

  const racksAssigned = footprintData.filter((f) => f.kind === "RACK_SLOT" && f.rackCiId).length;

  if (loading) return (
    <div className="flex h-64 items-center justify-center text-slate-400">
      <RefreshCw className="mr-2 h-5 w-5 animate-spin" /> {t("dcim.loading")}
    </div>
  );
  if (error || !room) return (
    <div className="flex h-64 flex-col items-center justify-center gap-2 text-red-500">
      <AlertTriangle className="h-8 w-8" />
      <p>{error ?? t("dcim.error")}</p>
      <button onClick={load} className="mt-2 rounded-none border border-red-300 px-4 py-2 text-sm hover:bg-red-50">Reintentar</button>
    </div>
  );

  return (
    <div className="flex h-full flex-col overflow-hidden">

      {/* ── Header ── */}
      <div className="flex items-start justify-between border-b border-slate-200 bg-white px-6 py-4">
        <div className="flex items-center gap-3">
          <Link href="/dcim" className="text-slate-400 hover:text-slate-600"><ArrowLeft className="h-5 w-5" /></Link>
          <div>
            {editingRoom ? (
              <div className="flex flex-wrap items-end gap-2">
                <Input value={editName} onChange={(e) => setEditName(e.target.value)} className="w-48 font-bold" />
                <Sel value={editKind} onChange={(e) => setEditKind(e.target.value)} className="w-36">
                  <option value="CPD">{t("dcim.room.kind_cpd")}</option>
                  <option value="TECHNICAL_ROOM">{t("dcim.room.kind_technical")}</option>
                </Sel>
                <Input type="number" value={editWidth} onChange={(e) => setEditWidth(e.target.value)} placeholder="Ancho mm" className="w-24" />
                <Input type="number" value={editDepth} onChange={(e) => setEditDepth(e.target.value)} placeholder="Fondo mm" className="w-24" />
              </div>
            ) : (
              <>
                <h1 className="text-xl font-bold text-slate-800">{room.name}</h1>
                <p className="text-sm text-slate-500">
                  {room.floor.building.name} · {room.floor.name} ·{" "}
                  <span className={`font-medium ${room.kind === "CPD" ? "text-indigo-600" : "text-slate-600"}`}>
                    {room.kind === "CPD" ? t("dcim.room.kind_cpd") : t("dcim.room.kind_technical")}
                  </span>
                  {room.widthMm && <span className="ml-2 text-slate-400">{room.widthMm}×{room.depthMm}mm</span>}
                </p>
              </>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Stats */}
          <div className="hidden items-center gap-4 text-xs text-slate-500 md:flex">
            <span className="flex items-center gap-1"><LayoutGrid className="h-3.5 w-3.5" /> {footprintData.length} fp</span>
            <span className="flex items-center gap-1"><Server className="h-3.5 w-3.5 text-green-500" /> {racksAssigned} racks</span>
            <span className="flex items-center gap-1"><Zap className="h-3.5 w-3.5 text-amber-500" /> {room.aisles.length} pasillos</span>
          </div>

          {user?.role === "ADMIN" && (
            <>
              {editingRoom ? (
                <>
                  <button onClick={saveRoom} disabled={saving} className="flex items-center gap-1 rounded-none bg-green-600 px-3 py-1.5 text-sm text-white hover:bg-green-700 disabled:opacity-50">
                    <Check className="h-3.5 w-3.5" /> {t("dcim.room.save")}
                  </button>
                  <button onClick={() => setEditingRoom(false)} className="flex items-center gap-1 rounded-none border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50">
                    <X className="h-3.5 w-3.5" /> {t("dcim.room.cancel")}
                  </button>
                </>
              ) : (
                <>
                  <button onClick={() => setEditingRoom(true)} className="flex items-center gap-1 rounded-none border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50">
                    <Pencil className="h-3.5 w-3.5" /> {t("dcim.room.edit_toggle")}
                  </button>
                  <button
                    onClick={toggleHeatmap}
                    disabled={heatmapLoading}
                    className={`flex items-center gap-1 rounded-none px-3 py-1.5 text-sm border ${showHeatmap ? "bg-amber-500 text-white border-amber-500" : "bg-white text-slate-600 border-slate-300 hover:bg-slate-50"}`}
                  >
                    <Flame className="h-3.5 w-3.5" /> {showHeatmap ? "Heatmap ON" : "Heatmap"}
                  </button>
                  <button
                    onClick={() => { setPlanEditMode((v) => !v); setSelectedRack(null); }}
                    className={`flex items-center gap-1 rounded-none px-3 py-1.5 text-sm border ${planEditMode ? "bg-[var(--accent)] text-white border-[var(--accent)]" : "bg-white text-slate-600 border-slate-300 hover:bg-slate-50"}`}
                  >
                    <Edit3 className="h-3.5 w-3.5" /> {planEditMode ? "Salir de edición" : "Editar plano"}
                  </button>
                </>
              )}
            </>
          )}
        </div>
      </div>

      {/* ── Edit mode banner ── */}
      {planEditMode && (() => {
        const cols = room.widthMm ? Math.ceil(room.widthMm / 800) : 8;
        const rows = room.depthMm ? Math.ceil(room.depthMm / 1200) : 6;
        return (
          <div className="flex items-center gap-2 bg-amber-50 border-b border-amber-200 px-6 py-2 text-xs text-amber-700">
            <Edit3 className="h-3.5 w-3.5 shrink-0" />
            <span>
              Modo edición — Grid <strong>{cols}×{rows}</strong> · celda <strong>800mm ancho × 1200mm fondo</strong> (rack estándar; los pasillos frío/caliente ocupan una fila entera = 1200mm).
              Clic en <strong>+</strong> para añadir huella; clic en una huella existente para cambiar tipo o eliminar.
              {!room.widthMm && <span className="ml-1 text-amber-600">⚠ Define ancho/fondo de la sala para un grid ajustado.</span>}
              <span className="ml-2 text-amber-600">Pan con botón medio/derecho del ratón.</span>
            </span>
          </div>
        );
      })()}

      {/* ── Footprint creation form (inline modal) ── */}
      {addForm && (
        <div className="flex items-center gap-3 border-b border-blue-200 bg-blue-50 px-6 py-2">
          <span className="text-xs font-medium text-blue-700">Nueva huella ({addForm.gridX},{addForm.gridY})</span>
          <Input value={addLabel} onChange={(e) => setAddLabel(e.target.value)} className="w-20 text-xs" placeholder="Label" />
          <Sel value={addKind} onChange={(e) => setAddKind(e.target.value)} className="w-36 text-xs">
            <option value="RACK_SLOT">Rack slot</option>
            <option value="INFRASTRUCTURE">Infraestructura</option>
            <option value="EMPTY">Vacío</option>
          </Sel>
          {room.aisles.length > 0 && (
            <Sel value={addAisleId} onChange={(e) => setAddAisleId(e.target.value)} className="w-36 text-xs">
              <option value="">Sin pasillo</option>
              {room.aisles.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </Sel>
          )}
          <button onClick={submitCreateFootprint} className="flex items-center gap-1 rounded-none bg-green-600 px-2 py-1 text-xs text-white hover:bg-green-700">
            <Check className="h-3 w-3" /> Añadir
          </button>
          <button onClick={() => setAddForm(null)} className="flex items-center gap-1 rounded-none border border-slate-300 px-2 py-1 text-xs hover:bg-white">
            <X className="h-3 w-3" /> Cancelar
          </button>
        </div>
      )}

      {/* ── Main: floor plan + drawer ── */}
      <div className="flex flex-1 overflow-hidden">

        {/* ReactFlow floor plan */}
        <div className="relative flex-1 overflow-hidden">
          {footprintData.length === 0 && !planEditMode ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-slate-400">
              <LayoutGrid className="h-16 w-16 opacity-20" />
              <p className="text-sm">{t("dcim.room.no_footprints")}</p>
              <p className="text-xs text-slate-300">{t("dcim.room.plan_placeholder")}</p>
              {user?.role === "ADMIN" && (
                <button onClick={() => setPlanEditMode(true)} className="mt-2 rounded-none border border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50">
                  Activar modo edición
                </button>
              )}
            </div>
          ) : (
            <>
            <RoomPlan2D
              footprints={footprintData}
              aisles={room.aisles}
              roomWidthMm={room.widthMm}
              roomDepthMm={room.depthMm}
              selectedRackCiId={selectedRack?.rackCiId ?? null}
              editMode={planEditMode}
              heatmapData={showHeatmap ? (heatmapData ?? undefined) : undefined}
              onClickRack={(fp) => { setSelectedRack(fp); }}
              onCreateFootprint={handleCreateFootprint}
              onDeleteFootprint={handleDeleteFootprint}
              onUpdateFootprint={handleUpdateFootprint}
            />
            {/* Heatmap legend */}
            {showHeatmap && (
              <div className="absolute bottom-4 left-4 flex items-center gap-2 rounded-none border border-slate-200 bg-white/90 px-3 py-2 text-xs shadow-md backdrop-blur-sm">
                <Flame className="h-3.5 w-3.5 text-amber-500" />
                <span className="text-slate-500 mr-1">Potencia:</span>
                {([ ["<60%","rgba(34,197,94,0.45)"], ["60-80%","rgba(234,179,8,0.55)"], ["80-90%","rgba(249,115,22,0.65)"], [">90%","rgba(239,68,68,0.75)"] ] as [string,string][]).map(([label, color]) => (
                  <span key={label} className="flex items-center gap-1">
                    <span style={{ background: color, display: "inline-block", width: 12, height: 12, borderRadius: 2 }} />
                    {label}
                  </span>
                ))}
              </div>
            )}
            </>
          )}
        </div>

        {/* Rack elevation drawer */}
        {selectedRack && (
          <div className="w-80 shrink-0 overflow-auto border-l border-slate-200 bg-white p-4 shadow-lg">
            <div className="mb-3 flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">Elevación de rack</span>
              <button onClick={() => setSelectedRack(null)} className="text-slate-400 hover:text-slate-600">
                <X className="h-4 w-4" />
              </button>
            </div>
            {selectedRack.rackCiId && (
              <RackElevation2D
                rackCiId={selectedRack.rackCiId}
                rackName={selectedRack.rackName ?? selectedRack.label}
                onClickCI={openCIDetail}
              />
            )}
          </div>
        )}
      </div>

      {/* CI detail modal */}
      {detailCI && (
        <CIDetailModal
          ci={detailCI}
          onClose={() => setDetailCI(null)}
          onEdit={() => setDetailCI(null)}
          onDelete={() => setDetailCI(null)}
          onUpdated={() => { load(); setDetailCI(null); }}
        />
      )}
    </div>
  );
}

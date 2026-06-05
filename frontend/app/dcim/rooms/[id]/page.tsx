"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  Server, ArrowLeft, Pencil, Check, X, RefreshCw,
  AlertTriangle, LayoutGrid, Zap,
} from "lucide-react";
import { apiFetch } from "@/lib/apiFetch";
import { useAuth } from "@/contexts/AuthContext";
import { useLanguage } from "@/contexts/LanguageContext";
import RackElevation2D from "@/components/dcim/RackElevation2D";
import CIDetailModal from "@/components/CIDetailModal";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Footprint {
  id: string;
  label: string;
  kind: string;
  active: boolean;
  gridX: number;
  gridY: number;
  rackCiId: string | null;
  aisle: { id: string; name: string } | null;
  rackCi?: {
    id: string;
    name: string;
    status: string;
    hardware: { rackTotalU: number | null; rackPowerMaxW: number | null } | null;
  } | null;
}

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
  aisles: { id: string; name: string; kind: string | null; orderIdx: number }[];
  footprints: Footprint[];
}

function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`rounded-none border border-slate-300 bg-slate-50 px-3 py-1.5 text-sm text-slate-800 focus:border-[var(--accent)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]/30 ${props.className ?? ""}`} />;
}
function Sel(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`rounded-none border border-slate-300 bg-slate-50 px-3 py-1.5 text-sm text-slate-800 focus:border-[var(--accent)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]/30 ${props.className ?? ""}`} />;
}

// ─── Footprint grid cell ──────────────────────────────────────────────────────

function FootprintCell({ fp, selected, onClick }: {
  fp: Footprint;
  selected: boolean;
  onClick?: () => void;
}) {
  const isRack = fp.kind === "RACK_SLOT" && fp.rackCiId;
  const kindColor: Record<string, string> = {
    RACK_SLOT:      isRack ? "bg-green-100 border-green-400 text-green-700 hover:bg-green-200" : "bg-white border-dashed border-green-300 text-green-400",
    INFRASTRUCTURE: "bg-slate-200 border-slate-400 text-slate-600",
    EMPTY:          "bg-white border-slate-200 text-slate-300",
  };
  const cls = kindColor[fp.kind] ?? "bg-white border-slate-200";
  const selectedCls = selected ? "ring-2 ring-[var(--accent)] ring-offset-1" : "";

  return (
    <button
      onClick={isRack ? onClick : undefined}
      title={fp.rackCi ? fp.rackCi.name : fp.label}
      className={`flex h-12 w-12 items-center justify-center border text-xs font-medium transition-colors ${cls} ${selectedCls} ${isRack ? "cursor-pointer" : "cursor-default"} ${!fp.active ? "opacity-40" : ""}`}
    >
      {isRack ? <Server className="h-4 w-4" /> : fp.label}
    </button>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function RoomPage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const { t } = useLanguage();

  const [room, setRoom]       = useState<RoomPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving]   = useState(false);

  // Edit state
  const [editName, setEditName]   = useState("");
  const [editKind, setEditKind]   = useState("CPD");
  const [editWidth, setEditWidth] = useState("");
  const [editDepth, setEditDepth] = useState("");

  // Rack drawer
  const [selectedRack, setSelectedRack] = useState<{ ciId: string; name: string } | null>(null);

  // CI detail modal (opened from RackElevation2D slot click)
  const [detailCI, setDetailCI] = useState<any | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await apiFetch(`/api/dcim/rooms/${id}/plan`);
      if (!r.ok) { setError(t("dcim.error")); return; }
      const data: RoomPlan = await r.json();
      setRoom(data);
      setEditName(data.name);
      setEditKind(data.kind);
      setEditWidth(data.widthMm?.toString() ?? "");
      setEditDepth(data.depthMm?.toString() ?? "");
    } catch { setError(t("dcim.error")); }
    finally { setLoading(false); }
  }, [id, t]);

  useEffect(() => { load(); }, [load]);

  const startEdit  = () => setEditing(true);
  const cancelEdit = () => {
    setEditing(false);
    if (room) { setEditName(room.name); setEditKind(room.kind); setEditWidth(room.widthMm?.toString() ?? ""); setEditDepth(room.depthMm?.toString() ?? ""); }
  };

  const saveEdit = async () => {
    setSaving(true);
    try {
      await apiFetch(`/api/dcim/rooms/${id}`, {
        method : "PATCH",
        body   : JSON.stringify({ name: editName, kind: editKind, widthMm: editWidth ? parseInt(editWidth) : null, depthMm: editDepth ? parseInt(editDepth) : null }),
      });
      setEditing(false);
      await load();
    } catch { setError(t("dcim.error")); }
    finally { setSaving(false); }
  };

  // Fetch full CI to open detail modal
  const openCIDetail = useCallback(async (ciId: string) => {
    try {
      const r = await apiFetch(`/api/cis/${ciId}`);
      if (!r.ok) return;
      const ci = await r.json();
      setDetailCI(ci);
    } catch { /* ignore */ }
  }, []);

  // Grid
  const maxX = room ? Math.max(0, ...room.footprints.map((f) => f.gridX)) : 0;
  const maxY = room ? Math.max(0, ...room.footprints.map((f) => f.gridY)) : 0;
  const fpMap: Record<string, Footprint> = {};
  if (room) room.footprints.forEach((f) => { fpMap[`${f.gridX},${f.gridY}`] = f; });

  const racksAssigned = room?.footprints.filter((f) => f.kind === "RACK_SLOT" && f.rackCiId).length ?? 0;

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
    <div className="flex h-full gap-0">

      {/* ── Main content ── */}
      <div className={`flex-1 space-y-6 overflow-auto p-6 transition-all ${selectedRack ? "pr-3" : ""}`}>

        {/* Header */}
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <Link href="/dcim" className="text-slate-400 hover:text-slate-600"><ArrowLeft className="h-5 w-5" /></Link>
            <div>
              {editing ? (
                <div className="flex flex-wrap items-end gap-2">
                  <Input value={editName} onChange={(e) => setEditName(e.target.value)} className="w-56 text-lg font-bold" />
                  <Sel value={editKind} onChange={(e) => setEditKind(e.target.value)} className="w-36">
                    <option value="CPD">{t("dcim.room.kind_cpd")}</option>
                    <option value="TECHNICAL_ROOM">{t("dcim.room.kind_technical")}</option>
                  </Sel>
                  <Input type="number" value={editWidth} onChange={(e) => setEditWidth(e.target.value)} placeholder="Ancho mm" className="w-28" />
                  <Input type="number" value={editDepth} onChange={(e) => setEditDepth(e.target.value)} placeholder="Fondo mm" className="w-28" />
                </div>
              ) : (
                <>
                  <h1 className="text-2xl font-bold text-slate-800">{room.name}</h1>
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
          {user?.role === "ADMIN" && (
            <div className="flex gap-2">
              {editing ? (
                <>
                  <button onClick={saveEdit} disabled={saving} className="flex items-center gap-1 rounded-none bg-green-600 px-3 py-2 text-sm text-white hover:bg-green-700 disabled:opacity-50">
                    <Check className="h-4 w-4" /> {t("dcim.room.save")}
                  </button>
                  <button onClick={cancelEdit} className="flex items-center gap-1 rounded-none border border-slate-300 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50">
                    <X className="h-4 w-4" /> {t("dcim.room.cancel")}
                  </button>
                </>
              ) : (
                <button onClick={startEdit} className="flex items-center gap-1 rounded-none border border-slate-300 bg-white px-3 py-2 text-sm text-slate-600 hover:bg-slate-50">
                  <Pencil className="h-4 w-4" /> {t("dcim.room.edit_toggle")}
                </button>
              )}
            </div>
          )}
        </div>

        {/* Stats */}
        <div className="flex flex-wrap gap-4">
          {[
            { icon: LayoutGrid, label: `${room.footprints.length} ${t("dcim.room.footprints")}`, color: "text-slate-400" },
            { icon: Server,     label: `${racksAssigned} racks asignados`,                        color: "text-green-500" },
            { icon: Zap,        label: `${room.aisles.length} pasillos`,                          color: "text-amber-500" },
          ].map(({ icon: Icon, label, color }) => (
            <div key={label} className="flex items-center gap-2 rounded-none border border-slate-200 bg-white px-4 py-2 shadow-sm">
              <Icon className={`h-4 w-4 ${color}`} />
              <span className="text-sm text-slate-700">{label}</span>
            </div>
          ))}
        </div>

        {/* 2D footprint grid */}
        <div className="rounded-none border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-200 px-4 py-3 flex items-center justify-between">
            <h2 className="font-semibold text-slate-700">{t("dcim.room.footprints")}</h2>
            {selectedRack && (
              <button onClick={() => setSelectedRack(null)} className="text-xs text-slate-400 hover:text-slate-600 flex items-center gap-1">
                <X className="h-3 w-3" /> Cerrar rack
              </button>
            )}
          </div>

          {room.footprints.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-16 text-slate-400">
              <LayoutGrid className="h-12 w-12 opacity-30" />
              <p className="text-sm">{t("dcim.room.no_footprints")}</p>
              <p className="text-xs text-slate-300">{t("dcim.room.plan_placeholder")}</p>
            </div>
          ) : (
            <div className="overflow-auto p-4">
              <div className="inline-block">
                {Array.from({ length: maxY + 1 }, (_, y) => (
                  <div key={y} className="flex gap-1 mb-1">
                    {Array.from({ length: maxX + 1 }, (_, x) => {
                      const fp = fpMap[`${x},${y}`];
                      return fp ? (
                        <FootprintCell
                          key={x} fp={fp}
                          selected={selectedRack?.ciId === fp.rackCiId}
                          onClick={() => {
                            if (fp.rackCiId && fp.rackCi) {
                              setSelectedRack({ ciId: fp.rackCiId, name: fp.rackCi.name });
                            }
                          }}
                        />
                      ) : (
                        <div key={x} className="h-12 w-12 border border-dashed border-slate-100" />
                      );
                    })}
                  </div>
                ))}
              </div>
              <div className="mt-4 flex flex-wrap gap-4 text-xs text-slate-500">
                <span className="flex items-center gap-1"><span className="inline-block h-3 w-3 border border-green-400 bg-green-100" /> Rack asignado</span>
                <span className="flex items-center gap-1"><span className="inline-block h-3 w-3 border border-dashed border-green-300 bg-white" /> Rack slot libre</span>
                <span className="flex items-center gap-1"><span className="inline-block h-3 w-3 border border-slate-400 bg-slate-200" /> Infra</span>
                <span className="flex items-center gap-1"><span className="inline-block h-3 w-3 border border-slate-200 bg-white" /> Vacío</span>
              </div>
            </div>
          )}
        </div>

        {/* Aisles */}
        {room.aisles.length > 0 && (
          <div className="rounded-none border border-slate-200 bg-white shadow-sm">
            <div className="border-b border-slate-200 px-4 py-3">
              <h2 className="font-semibold text-slate-700">Pasillos</h2>
            </div>
            <div className="divide-y divide-slate-100">
              {room.aisles.map((aisle) => (
                <div key={aisle.id} className="flex items-center gap-3 px-4 py-2.5">
                  <span className="flex-1 text-sm text-slate-700">{aisle.name}</span>
                  {aisle.kind && (
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                      aisle.kind === "HOT"  ? "bg-red-100 text-red-700"  :
                      aisle.kind === "COLD" ? "bg-blue-100 text-blue-700" :
                                              "bg-slate-100 text-slate-600"
                    }`}>
                      {aisle.kind}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ── Rack elevation drawer ── */}
      {selectedRack && (
        <div className="w-80 shrink-0 overflow-auto border-l border-slate-200 bg-white p-4 shadow-lg">
          <div className="mb-3 flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">Elevación de rack</span>
            <button onClick={() => setSelectedRack(null)} className="text-slate-400 hover:text-slate-600">
              <X className="h-4 w-4" />
            </button>
          </div>
          <RackElevation2D
            rackCiId={selectedRack.ciId}
            rackName={selectedRack.name}
            onClickCI={openCIDetail}
          />
        </div>
      )}

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

"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import {
  Building2, ChevronDown, ChevronRight, Plus, Pencil, Trash2,
  Check, X, RefreshCw, AlertTriangle, ArrowLeft,
} from "lucide-react";
import { apiFetch } from "@/lib/apiFetch";
import { useAuth } from "@/contexts/AuthContext";
import { useLanguage } from "@/contexts/LanguageContext";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Branch    { id: string; name: string }
interface Building  { id: string; name: string; code: string | null; branchId: string; branch: { id: string; name: string } }
interface Floor     { id: string; name: string; levelNumber: number; buildingId: string }
interface Room      { id: string; name: string; kind: string; widthMm: number | null; depthMm: number | null; floorId: string }

function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`rounded-none border border-slate-300 bg-slate-50 px-3 py-1.5 text-sm text-slate-800 placeholder:text-slate-400 focus:border-[var(--accent)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]/30 ${props.className ?? ""}`} />;
}
function Sel(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`rounded-none border border-slate-300 bg-slate-50 px-3 py-1.5 text-sm text-slate-800 focus:border-[var(--accent)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]/30 ${props.className ?? ""}`} />;
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function DcimAdminPage() {
  const { user } = useAuth();
  const { t } = useLanguage();

  const [branches, setBranches]     = useState<Branch[]>([]);
  const [buildings, setBuildings]   = useState<Building[]>([]);
  const [floors, setFloors]         = useState<Floor[]>([]);
  const [rooms, setRooms]           = useState<Room[]>([]);

  const [selBranch, setSelBranch]   = useState("");
  const [selBuilding, setSelBuilding] = useState("");
  const [selFloor, setSelFloor]     = useState("");

  const [expandedB, setExpandedB]   = useState<string | null>(null);
  const [expandedF, setExpandedF]   = useState<string | null>(null);

  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState<string | null>(null);

  // ── inline edit state ──
  type EditKind = "building" | "floor" | "room" | null;
  const [editKind, setEditKind]   = useState<EditKind>(null);
  const [editId, setEditId]       = useState<string | null>(null);
  const [addKind, setAddKind]     = useState<EditKind>(null);
  const [form, setForm]           = useState<Record<string, string>>({});

  // ─── Loaders ──────────────────────────────────────────────────────────────

  const loadBranches = useCallback(async () => {
    try {
      const r = await apiFetch("/api/masters/branches");
      const d = await r.json();
      setBranches(Array.isArray(d) ? d : []);
    } catch { /* ignore */ }
  }, []);

  const loadBuildings = useCallback(async () => {
    try {
      const r = await apiFetch("/api/dcim/buildings");
      const d = await r.json();
      setBuildings(Array.isArray(d) ? d : []);
    } catch { setError(t("dcim.error")); }
  }, [t]);

  const loadFloors = useCallback(async (buildingId: string) => {
    try {
      const r = await apiFetch(`/api/dcim/floors?buildingId=${buildingId}`);
      const d = await r.json();
      setFloors((prev) => [...prev.filter((f) => f.buildingId !== buildingId), ...d]);
    } catch { /* ignore */ }
  }, []);

  const loadRooms = useCallback(async (floorId: string) => {
    try {
      const r = await apiFetch(`/api/dcim/rooms?floorId=${floorId}`);
      const d = await r.json();
      setRooms((prev) => [...prev.filter((ro) => ro.floorId !== floorId), ...d]);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { loadBranches(); loadBuildings(); }, [loadBranches, loadBuildings]);

  // ─── Helpers ──────────────────────────────────────────────────────────────

  const cancelEdit = () => { setEditKind(null); setEditId(null); setAddKind(null); setForm({}); };

  const startEdit = (kind: EditKind, id: string, initial: Record<string, string>) => {
    setAddKind(null); setEditKind(kind); setEditId(id); setForm(initial);
  };

  const startAdd = (kind: EditKind, initial: Record<string, string>) => {
    setEditKind(null); setEditId(null); setAddKind(kind); setForm(initial);
  };

  const f = (k: string) => form[k] ?? "";

  // ─── CRUD ─────────────────────────────────────────────────────────────────

  const saveBuilding = async () => {
    if (!f("name").trim() || !f("branchId")) return;
    setLoading(true);
    try {
      if (editKind === "building" && editId) {
        await apiFetch(`/api/dcim/buildings/${editId}`, { method: "PATCH", body: JSON.stringify({ name: f("name"), code: f("code") || null }) });
      } else {
        await apiFetch("/api/dcim/buildings", { method: "POST", body: JSON.stringify({ branchId: f("branchId"), name: f("name"), code: f("code") || null }) });
      }
      cancelEdit(); await loadBuildings();
    } catch { setError(t("dcim.error")); } finally { setLoading(false); }
  };

  const deleteBuilding = async (id: string) => {
    if (!confirm(t("dcim.confirm_delete"))) return;
    await apiFetch(`/api/dcim/buildings/${id}`, { method: "DELETE" });
    await loadBuildings();
  };

  const saveFloor = async () => {
    if (!f("name").trim() || !f("buildingId")) return;
    setLoading(true);
    try {
      const body = { buildingId: f("buildingId"), name: f("name"), levelNumber: parseInt(f("levelNumber") || "0") };
      if (editKind === "floor" && editId) {
        await apiFetch(`/api/dcim/floors/${editId}`, { method: "PATCH", body: JSON.stringify({ name: f("name"), levelNumber: parseInt(f("levelNumber") || "0") }) });
      } else {
        await apiFetch("/api/dcim/floors", { method: "POST", body: JSON.stringify(body) });
      }
      cancelEdit(); await loadFloors(f("buildingId"));
    } catch { setError(t("dcim.error")); } finally { setLoading(false); }
  };

  const deleteFloor = async (id: string, buildingId: string) => {
    if (!confirm(t("dcim.confirm_delete"))) return;
    await apiFetch(`/api/dcim/floors/${id}`, { method: "DELETE" });
    await loadFloors(buildingId);
  };

  const saveRoom = async () => {
    if (!f("name").trim() || !f("floorId")) return;
    setLoading(true);
    try {
      const widthMm = f("widthM") ? Math.round(parseFloat(f("widthM")) * 1000) : null;
      const depthMm = f("depthM") ? Math.round(parseFloat(f("depthM")) * 1000) : null;
      const body = { floorId: f("floorId"), name: f("name"), kind: f("kind") || "CPD", widthMm, depthMm };
      if (editKind === "room" && editId) {
        await apiFetch(`/api/dcim/rooms/${editId}`, { method: "PATCH", body: JSON.stringify({ name: f("name"), kind: f("kind"), widthMm, depthMm }) });
      } else {
        await apiFetch("/api/dcim/rooms", { method: "POST", body: JSON.stringify(body) });
      }
      cancelEdit(); await loadRooms(f("floorId"));
    } catch { setError(t("dcim.error")); } finally { setLoading(false); }
  };

  const deleteRoom = async (id: string, floorId: string) => {
    if (!confirm(t("dcim.confirm_delete"))) return;
    await apiFetch(`/api/dcim/rooms/${id}`, { method: "DELETE" });
    await loadRooms(floorId);
  };

  if (user?.role !== "ADMIN") {
    return <div className="p-6 text-red-500">Forbidden</div>;
  }

  const filteredBuildings = selBranch ? buildings.filter((b) => b.branchId === selBranch) : buildings;

  return (
    <div className="space-y-6 p-6">

      {/* Header */}
      <div className="flex items-center gap-3">
        <Link href="/dcim" className="text-slate-400 hover:text-slate-600"><ArrowLeft className="h-5 w-5" /></Link>
        <div>
          <h1 className="text-2xl font-bold text-slate-800">{t("dcim.admin.title")}</h1>
          <p className="text-sm text-slate-500">{t("dcim.admin.subtitle")}</p>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-none border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
          <AlertTriangle className="h-4 w-4" /> {error}
          <button onClick={() => setError(null)} className="ml-auto"><X className="h-4 w-4" /></button>
        </div>
      )}

      {/* Branch filter */}
      <div className="flex items-center gap-3">
        <label className="text-sm font-medium text-slate-600">{t("dcim.building.branch")}</label>
        <Sel value={selBranch} onChange={(e) => setSelBranch(e.target.value)} className="w-64">
          <option value="">{t("dcim.admin.select_branch")} (todos)</option>
          {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </Sel>
      </div>

      {/* Buildings */}
      <div className="rounded-none border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <h2 className="font-semibold text-slate-700 flex items-center gap-2">
            <Building2 className="h-4 w-4" /> {t("dcim.building.title")}
          </h2>
          <button onClick={() => startAdd("building", { branchId: selBranch })}
            className="flex items-center gap-1 rounded-none bg-[var(--accent)] px-3 py-1.5 text-xs text-white hover:opacity-90">
            <Plus className="h-3 w-3" /> {t("dcim.building.new")}
          </button>
        </div>

        {/* Add building form */}
        {addKind === "building" && (
          <div className="flex flex-wrap items-end gap-2 border-b border-slate-200 bg-slate-50 px-4 py-3">
            <div className="flex flex-col gap-1">
              <label className="text-xs text-slate-500">{t("dcim.building.branch")}</label>
              <Sel value={f("branchId")} onChange={(e) => setForm((p) => ({ ...p, branchId: e.target.value }))} className="w-48">
                <option value="">{t("dcim.admin.select_branch")}</option>
                {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </Sel>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-slate-500">{t("dcim.building.name")} *</label>
              <Input value={f("name")} onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))} className="w-48" placeholder="Edificio A" />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-slate-500">{t("dcim.building.code")}</label>
              <Input value={f("code")} onChange={(e) => setForm((p) => ({ ...p, code: e.target.value }))} className="w-24" placeholder="A1" />
            </div>
            <button onClick={saveBuilding} disabled={loading} className="flex items-center gap-1 rounded-none bg-green-600 px-3 py-1.5 text-xs text-white hover:bg-green-700 disabled:opacity-50">
              <Check className="h-3 w-3" /> {t("dcim.actions.save")}
            </button>
            <button onClick={cancelEdit} className="flex items-center gap-1 rounded-none border border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-100">
              <X className="h-3 w-3" /> {t("dcim.actions.cancel")}
            </button>
          </div>
        )}

        {filteredBuildings.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-slate-400">{t("dcim.admin.no_buildings")}</p>
        ) : (
          <div className="divide-y divide-slate-100">
            {filteredBuildings.map((building) => {
              const bFloors = floors.filter((f) => f.buildingId === building.id);
              const isExpanded = expandedB === building.id;

              return (
                <div key={building.id}>
                  {/* Building row */}
                  {editKind === "building" && editId === building.id ? (
                    <div className="flex flex-wrap items-end gap-2 bg-amber-50 px-4 py-2">
                      <Input value={f("name")} onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))} className="w-48" />
                      <Input value={f("code")} onChange={(e) => setForm((p) => ({ ...p, code: e.target.value }))} className="w-24" placeholder="Código" />
                      <button onClick={saveBuilding} disabled={loading} className="rounded-none bg-green-600 px-2 py-1 text-xs text-white"><Check className="h-3 w-3" /></button>
                      <button onClick={cancelEdit} className="rounded-none border border-slate-300 px-2 py-1 text-xs"><X className="h-3 w-3" /></button>
                    </div>
                  ) : (
                    <div className="flex items-center px-4 py-2.5 hover:bg-slate-50">
                      <button onClick={() => {
                        setExpandedB(isExpanded ? null : building.id);
                        if (!isExpanded) loadFloors(building.id);
                      }} className="flex flex-1 items-center gap-2 text-left">
                        {isExpanded ? <ChevronDown className="h-4 w-4 text-slate-400" /> : <ChevronRight className="h-4 w-4 text-slate-400" />}
                        <Building2 className="h-4 w-4 text-blue-500" />
                        <span className="font-medium text-slate-800">{building.name}</span>
                        {building.code && <span className="text-xs text-slate-400">({building.code})</span>}
                        <span className="ml-2 text-xs text-slate-400">{building.branch.name}</span>
                      </button>
                      <div className="flex gap-1">
                        <button onClick={() => startEdit("building", building.id, { name: building.name, code: building.code ?? "", branchId: building.branchId })}
                          className="rounded-none p-1 text-slate-400 hover:text-blue-600"><Pencil className="h-3.5 w-3.5" /></button>
                        <button onClick={() => deleteBuilding(building.id)} className="rounded-none p-1 text-slate-400 hover:text-red-600"><Trash2 className="h-3.5 w-3.5" /></button>
                      </div>
                    </div>
                  )}

                  {/* Floors */}
                  {isExpanded && (
                    <div className="border-t border-slate-100 bg-slate-50/50 pl-8">
                      <div className="flex items-center justify-between px-4 py-2">
                        <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">{t("dcim.floor.title")}</span>
                        <button onClick={() => startAdd("floor", { buildingId: building.id })}
                          className="flex items-center gap-1 rounded-none border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:bg-slate-100">
                          <Plus className="h-3 w-3" /> {t("dcim.floor.new")}
                        </button>
                      </div>

                      {addKind === "floor" && f("buildingId") === building.id && (
                        <div className="flex flex-wrap items-end gap-2 border-b border-slate-200 bg-white px-4 py-2">
                          <Input value={f("name")} onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))} className="w-40" placeholder="Planta -1" />
                          <Input type="number" value={f("levelNumber")} onChange={(e) => setForm((p) => ({ ...p, levelNumber: e.target.value }))} className="w-20" placeholder="Nivel (-1)" />
                          <button onClick={saveFloor} disabled={loading} className="rounded-none bg-green-600 px-2 py-1 text-xs text-white"><Check className="h-3 w-3" /></button>
                          <button onClick={cancelEdit} className="rounded-none border border-slate-300 px-2 py-1 text-xs"><X className="h-3 w-3" /></button>
                        </div>
                      )}

                      {bFloors.length === 0 ? (
                        <p className="px-4 py-3 text-xs text-slate-400">{t("dcim.admin.no_floors")}</p>
                      ) : (
                        <div className="divide-y divide-slate-100">
                          {bFloors.sort((a, b) => a.levelNumber - b.levelNumber).map((floor) => {
                            const fRooms = rooms.filter((r) => r.floorId === floor.id);
                            const isFExpanded = expandedF === floor.id;

                            return (
                              <div key={floor.id}>
                                {editKind === "floor" && editId === floor.id ? (
                                  <div className="flex flex-wrap items-end gap-2 bg-amber-50 px-4 py-2">
                                    <Input value={f("name")} onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))} className="w-40" />
                                    <Input type="number" value={f("levelNumber")} onChange={(e) => setForm((p) => ({ ...p, levelNumber: e.target.value }))} className="w-20" />
                                    <button onClick={saveFloor} disabled={loading} className="rounded-none bg-green-600 px-2 py-1 text-xs text-white"><Check className="h-3 w-3" /></button>
                                    <button onClick={cancelEdit} className="rounded-none border border-slate-300 px-2 py-1 text-xs"><X className="h-3 w-3" /></button>
                                  </div>
                                ) : (
                                  <div className="flex items-center px-4 py-2 hover:bg-white">
                                    <button onClick={() => {
                                      setExpandedF(isFExpanded ? null : floor.id);
                                      if (!isFExpanded) loadRooms(floor.id);
                                    }} className="flex flex-1 items-center gap-2 text-left text-sm">
                                      {isFExpanded ? <ChevronDown className="h-3.5 w-3.5 text-slate-400" /> : <ChevronRight className="h-3.5 w-3.5 text-slate-400" />}
                                      <span className="text-slate-700">{floor.name}</span>
                                      <span className="text-xs text-slate-400">{t("dcim.floor.level")} {floor.levelNumber}</span>
                                    </button>
                                    <div className="flex gap-1">
                                      <button onClick={() => startEdit("floor", floor.id, { name: floor.name, levelNumber: String(floor.levelNumber), buildingId: building.id })}
                                        className="p-1 text-slate-400 hover:text-blue-600"><Pencil className="h-3 w-3" /></button>
                                      <button onClick={() => deleteFloor(floor.id, building.id)} className="p-1 text-slate-400 hover:text-red-600"><Trash2 className="h-3 w-3" /></button>
                                    </div>
                                  </div>
                                )}

                                {/* Rooms */}
                                {isFExpanded && (
                                  <div className="border-t border-slate-100 bg-white pl-8">
                                    <div className="flex items-center justify-between px-4 py-1.5">
                                      <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">{t("dcim.room.title")}</span>
                                      <button onClick={() => startAdd("room", { floorId: floor.id, kind: "CPD" })}
                                        className="flex items-center gap-1 rounded-none border border-slate-300 px-2 py-0.5 text-xs text-slate-600 hover:bg-slate-100">
                                        <Plus className="h-3 w-3" /> {t("dcim.room.new")}
                                      </button>
                                    </div>

                                    {addKind === "room" && f("floorId") === floor.id && (
                                      <div className="flex flex-wrap items-end gap-2 border-b border-slate-200 bg-slate-50 px-4 py-2">
                                        <Input value={f("name")} onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))} className="w-40" placeholder="CPD Principal" />
                                        <Sel value={f("kind")} onChange={(e) => setForm((p) => ({ ...p, kind: e.target.value }))} className="w-36">
                                          <option value="CPD">{t("dcim.room.kind_cpd")}</option>
                                          <option value="TECHNICAL_ROOM">{t("dcim.room.kind_technical")}</option>
                                        </Sel>
                                        <Input type="number" step="0.1" min="0" value={f("widthM")} onChange={(e) => setForm((p) => ({ ...p, widthM: e.target.value }))} className="w-24" placeholder="Ancho (m)" />
                                        <Input type="number" step="0.1" min="0" value={f("depthM")} onChange={(e) => setForm((p) => ({ ...p, depthM: e.target.value }))} className="w-24" placeholder="Fondo (m)" />
                                        <button onClick={saveRoom} disabled={loading} className="rounded-none bg-green-600 px-2 py-1 text-xs text-white"><Check className="h-3 w-3" /></button>
                                        <button onClick={cancelEdit} className="rounded-none border border-slate-300 px-2 py-1 text-xs"><X className="h-3 w-3" /></button>
                                      </div>
                                    )}

                                    {fRooms.length === 0 ? (
                                      <p className="px-4 py-2 text-xs text-slate-400">{t("dcim.admin.no_rooms")}</p>
                                    ) : (
                                      <div className="divide-y divide-slate-50">
                                        {fRooms.map((room) => (
                                          <div key={room.id}>
                                            {editKind === "room" && editId === room.id ? (
                                              <div className="flex flex-wrap items-end gap-2 bg-amber-50 px-4 py-2">
                                                <Input value={f("name")} onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))} className="w-40" />
                                                <Sel value={f("kind")} onChange={(e) => setForm((p) => ({ ...p, kind: e.target.value }))} className="w-36">
                                                  <option value="CPD">{t("dcim.room.kind_cpd")}</option>
                                                  <option value="TECHNICAL_ROOM">{t("dcim.room.kind_technical")}</option>
                                                </Sel>
                                                <Input type="number" step="0.1" min="0" value={f("widthM")} onChange={(e) => setForm((p) => ({ ...p, widthM: e.target.value }))} className="w-24" placeholder="Ancho (m)" />
                                                <Input type="number" step="0.1" min="0" value={f("depthM")} onChange={(e) => setForm((p) => ({ ...p, depthM: e.target.value }))} className="w-24" placeholder="Fondo (m)" />
                                                <button onClick={saveRoom} disabled={loading} className="rounded-none bg-green-600 px-2 py-1 text-xs text-white"><Check className="h-3 w-3" /></button>
                                                <button onClick={cancelEdit} className="rounded-none border border-slate-300 px-2 py-1 text-xs"><X className="h-3 w-3" /></button>
                                              </div>
                                            ) : (
                                              <div className="flex items-center px-4 py-2 hover:bg-slate-50">
                                                <div className="flex-1 text-sm">
                                                  <span className="text-slate-700">{room.name}</span>
                                                  <span className={`ml-2 rounded-full px-1.5 py-0.5 text-xs ${room.kind === "CPD" ? "bg-indigo-100 text-indigo-700" : "bg-slate-100 text-slate-600"}`}>
                                                    {room.kind === "CPD" ? t("dcim.room.kind_cpd") : t("dcim.room.kind_technical")}
                                                  </span>
                                                  {room.widthMm && <span className="ml-2 text-xs text-slate-400">{(room.widthMm / 1000).toFixed(1)}×{((room.depthMm ?? 0) / 1000).toFixed(1)}m</span>}
                                                </div>
                                                <div className="flex gap-1">
                                                  <button onClick={() => startEdit("room", room.id, { name: room.name, kind: room.kind, widthM: room.widthMm ? (room.widthMm / 1000).toString() : "", depthM: room.depthMm ? (room.depthMm / 1000).toString() : "", floorId: floor.id })}
                                                    className="p-1 text-slate-400 hover:text-blue-600"><Pencil className="h-3 w-3" /></button>
                                                  <button onClick={() => deleteRoom(room.id, floor.id)} className="p-1 text-slate-400 hover:text-red-600"><Trash2 className="h-3 w-3" /></button>
                                                </div>
                                              </div>
                                            )}
                                          </div>
                                        ))}
                                      </div>
                                    )}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

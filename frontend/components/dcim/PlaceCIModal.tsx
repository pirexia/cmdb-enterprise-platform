"use client";

import { useCallback, useEffect, useState } from "react";
import { X, Server, MapPin, AlertTriangle, Check, Trash2 } from "lucide-react";
import { apiFetch } from "@/lib/apiFetch";
import { useLanguage } from "@/contexts/LanguageContext";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Branch   { id: string; name: string }
interface Building { id: string; name: string; branchId: string }
interface Floor    { id: string; name: string; levelNumber: number; buildingId: string }
interface Room     { id: string; name: string; floorId: string }
interface RackOption { ciId: string; name: string; totalU: number | null; label: string }
interface OccupiedSlot { ciId: string; uPosition: number; sizeU: number; orientation: string | null }

export interface CurrentPlacement {
  parentRackCiId : string | null;
  uPosition      : number | null;
  orientation    : string | null;
  sizeU          : number | null;
  powerW         : number | null;
}

interface Props {
  ciId             : string;
  ciName           : string;
  currentPlacement?: CurrentPlacement;
  onClose          : () => void;
  onPlaced         : () => void;
}

function Sel(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`w-full rounded-none border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-800 focus:border-[var(--accent)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]/30 disabled:opacity-50 ${props.className ?? ""}`} />;
}
function Inp(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`w-full rounded-none border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-800 focus:border-[var(--accent)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]/30 disabled:opacity-50 ${props.className ?? ""}`} />;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function PlaceCIModal({ ciId, ciName, currentPlacement, onClose, onPlaced }: Props) {
  const { t } = useLanguage();

  const [branches, setBranches]   = useState<Branch[]>([]);
  const [buildings, setBuildings] = useState<Building[]>([]);
  const [floors, setFloors]       = useState<Floor[]>([]);
  const [rooms, setRooms]         = useState<Room[]>([]);
  const [racks, setRacks]         = useState<RackOption[]>([]);
  const [elevation, setElevation] = useState<OccupiedSlot[]>([]);

  const [selBranch,   setSelBranch]   = useState("");
  const [selBuilding, setSelBuilding] = useState("");
  const [selFloor,    setSelFloor]    = useState("");
  const [selRoom,     setSelRoom]     = useState("");
  const [selRack,     setSelRack]     = useState("");
  const [totalU,      setTotalU]      = useState<number | null>(null);

  const [uPosition,    setUPosition]    = useState(currentPlacement?.uPosition?.toString() ?? "1");
  const [sizeU,        setSizeU]        = useState(currentPlacement?.sizeU?.toString() ?? "1");
  const [powerW,       setPowerW]       = useState(currentPlacement?.powerW?.toString() ?? "");
  const [orientation,  setOrientation]  = useState<"FRONT" | "REAR">(
    (currentPlacement?.orientation as "FRONT" | "REAR") ?? "FRONT"
  );

  const [saving,    setSaving]    = useState(false);
  const [conflict,  setConflict]  = useState<string | null>(null);
  const [error,     setError]     = useState<string | null>(null);

  // ── Load branches on mount ─────────────────────────────────────────────────
  useEffect(() => {
    apiFetch("/api/masters/branches").then((r) => r.json()).then((d) => setBranches(Array.isArray(d) ? d : []));
  }, []);

  // ── Cascading loaders ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!selBranch) { setBuildings([]); setSelBuilding(""); return; }
    apiFetch("/api/dcim/buildings").then((r) => r.json()).then((d: Building[]) =>
      setBuildings(d.filter((b) => b.branchId === selBranch))
    );
    setSelBuilding(""); setSelFloor(""); setSelRoom(""); setSelRack("");
  }, [selBranch]);

  useEffect(() => {
    if (!selBuilding) { setFloors([]); setSelFloor(""); return; }
    apiFetch(`/api/dcim/floors?buildingId=${selBuilding}`).then((r) => r.json()).then((d) => setFloors(Array.isArray(d) ? d : []));
    setSelFloor(""); setSelRoom(""); setSelRack("");
  }, [selBuilding]);

  useEffect(() => {
    if (!selFloor) { setRooms([]); setSelRoom(""); return; }
    apiFetch(`/api/dcim/rooms?floorId=${selFloor}`).then((r) => r.json()).then((d) => setRooms(Array.isArray(d) ? d : []));
    setSelRoom(""); setSelRack("");
  }, [selFloor]);

  useEffect(() => {
    if (!selRoom) { setRacks([]); setSelRack(""); return; }
    apiFetch(`/api/dcim/rooms/${selRoom}/plan`).then((r) => r.json()).then((plan: any) => {
      const rackOptions: RackOption[] = (plan.footprints ?? [])
        .filter((fp: any) => fp.kind === "RACK_SLOT" && fp.rackCiId)
        .map((fp: any) => ({
          ciId   : fp.rackCiId,
          name   : fp.rackCi?.name ?? fp.label,
          totalU : fp.rackCi?.hardware?.rackTotalU ?? null,
          label  : `${fp.rackCi?.name ?? fp.label}${fp.rackCi?.hardware?.rackTotalU ? ` (${fp.rackCi.hardware.rackTotalU}U)` : ""}`,
        }));
      setRacks(rackOptions);
    });
    setSelRack("");
  }, [selRoom]);

  // ── Load elevation for conflict check ──────────────────────────────────────
  useEffect(() => {
    if (!selRack) { setElevation([]); setTotalU(null); return; }
    const rack = racks.find((r) => r.ciId === selRack);
    setTotalU(rack?.totalU ?? null);
    apiFetch(`/api/dcim/racks/${selRack}/elevation`).then((r) => r.json()).then((data: any) => {
      const occupants = (data.occupants ?? []) as OccupiedSlot[];
      setElevation(occupants.filter((o) => o.ciId !== ciId));
    });
  }, [selRack, racks, ciId]);

  // ── Conflict detection ─────────────────────────────────────────────────────
  useEffect(() => {
    setConflict(null);
    if (!selRack || !uPosition || !sizeU) return;
    const uStart = parseInt(uPosition);
    const uEnd   = uStart + parseInt(sizeU) - 1;
    if (totalU && uEnd > totalU) { setConflict(t("dcim.place.capacity")); return; }
    const slots = Array.from({ length: parseInt(sizeU) }, (_, i) => uStart + i);
    const blocked = elevation.filter((o) => {
      if (o.orientation && o.orientation !== orientation) return false;
      if (o.uPosition == null) return false;
      const oEnd = o.uPosition + (o.sizeU ?? 1) - 1;
      return slots.some((s) => s >= o.uPosition && s <= oEnd);
    });
    if (blocked.length) setConflict(t("dcim.place.conflict"));
  }, [selRack, uPosition, sizeU, orientation, elevation, totalU, t]);

  // ── Submit placement ───────────────────────────────────────────────────────
  const submit = async () => {
    if (!selRack || !uPosition || conflict) return;
    setSaving(true); setError(null);
    try {
      const r = await apiFetch(`/api/cis/${ciId}/placement`, {
        method : "PATCH",
        body   : JSON.stringify({
          parentRackCiId : selRack,
          uPosition      : parseInt(uPosition),
          orientation,
          sizeU          : parseInt(sizeU) || 1,
          powerW         : powerW ? parseInt(powerW) : null,
        }),
      });
      if (!r.ok) { setError(t("dcim.error")); return; }
      onPlaced();
    } catch { setError(t("dcim.error")); }
    finally { setSaving(false); }
  };

  // ── Remove from rack ───────────────────────────────────────────────────────
  const removeFromRack = async () => {
    if (!confirm(t("dcim.place.remove_confirm"))) return;
    setSaving(true);
    try {
      await apiFetch(`/api/cis/${ciId}/placement`, {
        method : "PATCH",
        body   : JSON.stringify({ parentRackCiId: null, uPosition: null, orientation: null, sizeU: null, powerW: null }),
      });
      onPlaced();
    } catch { setError(t("dcim.error")); }
    finally { setSaving(false); }
  };

  const canSubmit = selRack && uPosition && !conflict && !saving;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm">
      <div className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-none border border-slate-200 bg-white shadow-2xl">

        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <div className="flex items-center gap-2">
            <MapPin className="h-5 w-5 text-[var(--accent)]" />
            <div>
              <h2 className="font-semibold text-slate-800">{t("dcim.place.title")}</h2>
              <p className="text-xs text-slate-500 truncate max-w-xs">{ciName}</p>
            </div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X className="h-5 w-5" /></button>
        </div>

        <div className="flex-1 overflow-auto px-5 py-4 space-y-4">

          {/* Current placement info */}
          {currentPlacement?.parentRackCiId && (
            <div className="flex items-center justify-between rounded-none bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-700">
              <span className="flex items-center gap-1">
                <Server className="h-3.5 w-3.5" />
                {t("dcim.place.current")} — U{currentPlacement.uPosition} · {currentPlacement.orientation} · {currentPlacement.sizeU}U
              </span>
              <button onClick={removeFromRack} disabled={saving} className="flex items-center gap-1 text-red-600 hover:text-red-800 font-medium">
                <Trash2 className="h-3 w-3" /> {t("dcim.place.remove")}
              </button>
            </div>
          )}

          {/* Cascading selects */}
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-slate-600">{t("dcim.place.branch")}</span>
              <Sel value={selBranch} onChange={(e) => setSelBranch(e.target.value)}>
                <option value="">{t("dcim.place.select_branch")}</option>
                {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </Sel>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-slate-600">{t("dcim.place.building")}</span>
              <Sel value={selBuilding} onChange={(e) => setSelBuilding(e.target.value)} disabled={!selBranch}>
                <option value="">{t("dcim.place.select_building")}</option>
                {buildings.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </Sel>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-slate-600">{t("dcim.place.floor")}</span>
              <Sel value={selFloor} onChange={(e) => setSelFloor(e.target.value)} disabled={!selBuilding}>
                <option value="">{t("dcim.place.select_floor")}</option>
                {floors.sort((a, b) => a.levelNumber - b.levelNumber).map((f) => <option key={f.id} value={f.id}>{f.name} ({f.levelNumber})</option>)}
              </Sel>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-slate-600">{t("dcim.place.room")}</span>
              <Sel value={selRoom} onChange={(e) => setSelRoom(e.target.value)} disabled={!selFloor}>
                <option value="">{t("dcim.place.select_room")}</option>
                {rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </Sel>
            </label>
          </div>

          {/* Rack select (full width) */}
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-slate-600">{t("dcim.place.rack")}</span>
            <Sel value={selRack} onChange={(e) => setSelRack(e.target.value)} disabled={!selRoom}>
              <option value="">{t("dcim.place.select_rack")}</option>
              {racks.length === 0 && selRoom && <option disabled value="">{t("dcim.place.no_racks")}</option>}
              {racks.map((r) => <option key={r.ciId} value={r.ciId}>{r.label}</option>)}
            </Sel>
          </label>

          {/* Placement fields */}
          {selRack && (
            <div className="space-y-3 rounded-none border border-slate-200 bg-slate-50 p-3">
              <div className="grid grid-cols-3 gap-3">
                <label className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-slate-600">{t("dcim.place.u_position")}</span>
                  <Inp type="number" min={1} max={totalU ?? 99} value={uPosition} onChange={(e) => setUPosition(e.target.value)} />
                  {totalU && <span className="text-xs text-slate-400">Max: {totalU}U</span>}
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-slate-600">{t("dcim.place.size_u")}</span>
                  <Inp type="number" min={1} value={sizeU} onChange={(e) => setSizeU(e.target.value)} />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-slate-600">{t("dcim.place.power_w")}</span>
                  <Inp type="number" min={0} value={powerW} onChange={(e) => setPowerW(e.target.value)} placeholder="—" />
                </label>
              </div>

              {/* Orientation radio */}
              <div className="flex flex-col gap-1">
                <span className="text-xs font-medium text-slate-600">{t("dcim.place.orientation")}</span>
                <div className="flex gap-3">
                  {(["FRONT", "REAR"] as const).map((side) => (
                    <label key={side} className="flex cursor-pointer items-center gap-2 text-sm text-slate-700">
                      <input type="radio" name="orientation" value={side} checked={orientation === side} onChange={() => setOrientation(side)} className="accent-[var(--accent)]" />
                      {side === "FRONT" ? t("dcim.place.front") : t("dcim.place.rear")}
                    </label>
                  ))}
                </div>
              </div>

              {/* Conflict / capacity warning */}
              {conflict && (
                <div className="flex items-center gap-2 rounded-none border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> {conflict}
                </div>
              )}
            </div>
          )}

          {error && (
            <div className="flex items-center gap-2 rounded-none border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              <AlertTriangle className="h-4 w-4" /> {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 border-t border-slate-200 px-5 py-3">
          <button onClick={onClose} className="rounded-none border border-slate-300 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50">
            {t("dcim.actions.cancel")}
          </button>
          <button
            onClick={submit}
            disabled={!canSubmit}
            className="flex items-center gap-2 rounded-none bg-[var(--accent)] px-4 py-2 text-sm text-white hover:opacity-90 disabled:opacity-40"
          >
            <Check className="h-4 w-4" /> {t("dcim.place.save")}
          </button>
        </div>
      </div>
    </div>
  );
}

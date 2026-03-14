"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Building2, MapPin, Cpu, Layers, Package,
  Plus, Trash2, RefreshCw, AlertTriangle, ChevronRight,
} from "lucide-react";
import { apiFetch } from "@/lib/apiFetch";

// ─── Types ────────────────────────────────────────────────────────────────────

interface SupportArea { id: string; name: string }
interface Branch      { id: string; name: string; branch_code: string; physical_address: string | null; support_area_id: string; support_area_name: string }
interface Manufacturer { id: string; name: string }
interface DeviceModel  { id: string; name: string; manufacturer_id: string; manufacturer_name: string }
interface Provider     { id: string; name: string }

type TabId = "support-areas" | "branches" | "manufacturers" | "models" | "providers";

// ─── Reusable input components ────────────────────────────────────────────────

function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100 ${props.className ?? ""}`} />;
}
function Sel(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-800 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100 ${props.className ?? ""}`} />;
}

// ─── Generic list row ─────────────────────────────────────────────────────────

function ListRow({ label, sublabel, onDelete }: { label: string; sublabel?: string; onDelete: () => void }) {
  return (
    <div className="flex items-center justify-between px-4 py-2.5 hover:bg-slate-50 transition-colors group">
      <div>
        <p className="text-sm font-medium text-slate-700">{label}</p>
        {sublabel && <p className="text-xs text-slate-400">{sublabel}</p>}
      </div>
      <button onClick={onDelete}
        className="opacity-0 group-hover:opacity-100 rounded-lg p-1.5 text-red-400 hover:bg-red-50 hover:text-red-600 transition-all">
        <Trash2 className="h-4 w-4" />
      </button>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function MastersPage() {
  const [tab, setTab] = useState<TabId>("support-areas");

  const [supportAreas,  setSupportAreas]  = useState<SupportArea[]>([]);
  const [branches,      setBranches]      = useState<Branch[]>([]);
  const [manufacturers, setManufacturers] = useState<Manufacturer[]>([]);
  const [models,        setModels]        = useState<DeviceModel[]>([]);
  const [providers,     setProviders]     = useState<Provider[]>([]);

  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState<string | null>(null);

  // Add forms state
  const [newSA,   setNewSA]   = useState("");
  const [newBranch, setNewBranch] = useState({ name: "", code: "", address: "", supportAreaId: "" });
  const [newMfr,  setNewMfr]  = useState("");
  const [newModel, setNewModel] = useState({ name: "", manufacturerId: "" });
  const [newProv, setNewProv] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [saRes, brRes, mfRes, dmRes, pvRes] = await Promise.all([
        apiFetch("/api/masters/support-areas"),
        apiFetch("/api/masters/branches"),
        apiFetch("/api/masters/manufacturers"),
        apiFetch("/api/masters/device-models"),
        apiFetch("/api/masters/providers"),
      ]);
      setSupportAreas(await saRes.json());
      setBranches(    await brRes.json());
      setManufacturers(await mfRes.json());
      setModels(      await dmRes.json());
      setProviders(   await pvRes.json());
    } catch (e) { setError(e instanceof Error ? e.message : "Error al cargar maestros"); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const del = async (path: string, reload: () => void) => {
    if (!confirm("¿Eliminar este registro?")) return;
    await apiFetch(path, { method: "DELETE" });
    reload();
  };

  const post = async (path: string, body: Record<string, unknown>) => {
    const res = await apiFetch(path, { method: "POST", body: JSON.stringify(body) });
    if (!res.ok) { const d = await res.json(); throw new Error(d.error ?? `Error ${res.status}`); }
  };

  // ── Tab config ──────────────────────────────────────────────────────────────
  const tabs: { id: TabId; label: string; icon: React.ReactNode; count: number }[] = [
    { id: "support-areas",  label: "Áreas de Soporte", icon: <MapPin    className="h-4 w-4" />, count: supportAreas.length },
    { id: "branches",       label: "Sedes",            icon: <Building2 className="h-4 w-4" />, count: branches.length },
    { id: "manufacturers",  label: "Fabricantes",      icon: <Cpu       className="h-4 w-4" />, count: manufacturers.length },
    { id: "models",         label: "Modelos",          icon: <Layers    className="h-4 w-4" />, count: models.length },
    { id: "providers",      label: "Proveedores",      icon: <Package   className="h-4 w-4" />, count: providers.length },
  ];

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white px-8 py-5">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-slate-900">Administración de Datos Maestros</h1>
            <p className="text-sm text-slate-500 mt-0.5">Gestión de tablas maestras: Áreas, Sedes, Fabricantes, Modelos, Proveedores</p>
          </div>
          <button onClick={load} disabled={loading} className="flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50 transition-colors disabled:opacity-50">
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />Actualizar
          </button>
        </div>
      </header>

      <div className="px-8 py-8 max-w-5xl mx-auto">
        {error && (
          <div className="mb-6 flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
            <AlertTriangle className="h-4 w-4 flex-shrink-0" />{error}
          </div>
        )}

        {/* Tab bar */}
        <div className="flex gap-1 rounded-xl bg-white p-1 shadow-sm ring-1 ring-slate-200 mb-6 overflow-x-auto">
          {tabs.map((t) => (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium whitespace-nowrap transition-colors flex-1 justify-center ${tab === t.id ? "bg-indigo-600 text-white shadow-sm" : "text-slate-600 hover:bg-slate-100"}`}>
              {t.icon}{t.label}
              <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold ${tab === t.id ? "bg-indigo-500 text-white" : "bg-slate-100 text-slate-500"}`}>{t.count}</span>
            </button>
          ))}
        </div>

        {/* ── Support Areas ── */}
        {tab === "support-areas" && (
          <div className="rounded-2xl bg-white shadow-sm ring-1 ring-slate-200 overflow-hidden">
            <div className="border-b border-slate-100 px-6 py-4 bg-slate-50">
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Nueva Área de Soporte</p>
              <div className="flex gap-2 mt-2">
                <Input placeholder="Ej: Zona Centro" value={newSA} onChange={(e) => setNewSA(e.target.value)} />
                <button onClick={async () => { try { await post("/api/masters/support-areas", { name: newSA }); setNewSA(""); load(); } catch (e) { alert(e instanceof Error ? e.message : "Error"); }}}
                  className="flex-shrink-0 flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 transition-colors">
                  <Plus className="h-4 w-4" />Añadir
                </button>
              </div>
            </div>
            <div className="divide-y divide-slate-50">
              {supportAreas.length === 0 ? <p className="py-8 text-center text-sm text-slate-400">Sin áreas registradas.</p> :
                supportAreas.map((sa) => <ListRow key={sa.id} label={sa.name} onDelete={() => del(`/api/masters/support-areas/${sa.id}`, load)} />)}
            </div>
          </div>
        )}

        {/* ── Branches ── */}
        {tab === "branches" && (
          <div className="rounded-2xl bg-white shadow-sm ring-1 ring-slate-200 overflow-hidden">
            <div className="border-b border-slate-100 px-6 py-4 bg-slate-50 space-y-3">
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Nueva Sede</p>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <Input placeholder="Nombre de la sede" value={newBranch.name} onChange={(e) => setNewBranch((p) => ({ ...p, name: e.target.value }))} />
                <Input placeholder="Código (3 dígitos, ej: MAD)" value={newBranch.code} onChange={(e) => setNewBranch((p) => ({ ...p, code: e.target.value }))} maxLength={10} />
                <Input placeholder="Dirección física (opcional)" value={newBranch.address} onChange={(e) => setNewBranch((p) => ({ ...p, address: e.target.value }))} />
                <Sel value={newBranch.supportAreaId} onChange={(e) => setNewBranch((p) => ({ ...p, supportAreaId: e.target.value }))}>
                  <option value="">— Área de soporte —</option>
                  {supportAreas.map((sa) => <option key={sa.id} value={sa.id}>{sa.name}</option>)}
                </Sel>
              </div>
              <button onClick={async () => { try { await post("/api/masters/branches", { name: newBranch.name, branchCode: newBranch.code, physicalAddress: newBranch.address, supportAreaId: newBranch.supportAreaId }); setNewBranch({ name: "", code: "", address: "", supportAreaId: "" }); load(); } catch (e) { alert(e instanceof Error ? e.message : "Error"); }}}
                className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 transition-colors">
                <Plus className="h-4 w-4" />Añadir Sede
              </button>
            </div>
            <div className="divide-y divide-slate-50">
              {branches.length === 0 ? <p className="py-8 text-center text-sm text-slate-400">Sin sedes registradas.</p> :
                branches.map((b) => (
                  <ListRow key={b.id}
                    label={`${b.name} (${b.branch_code})`}
                    sublabel={`${b.support_area_name}${b.physical_address ? " · " + b.physical_address : ""}`}
                    onDelete={() => del(`/api/masters/branches/${b.id}`, load)} />
                ))}
            </div>
          </div>
        )}

        {/* ── Manufacturers ── */}
        {tab === "manufacturers" && (
          <div className="rounded-2xl bg-white shadow-sm ring-1 ring-slate-200 overflow-hidden">
            <div className="border-b border-slate-100 px-6 py-4 bg-slate-50">
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Nuevo Fabricante</p>
              <div className="flex gap-2 mt-2">
                <Input placeholder="Ej: Dell, HP, Cisco" value={newMfr} onChange={(e) => setNewMfr(e.target.value)} />
                <button onClick={async () => { try { await post("/api/masters/manufacturers", { name: newMfr }); setNewMfr(""); load(); } catch (e) { alert(e instanceof Error ? e.message : "Error"); }}}
                  className="flex-shrink-0 flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 transition-colors">
                  <Plus className="h-4 w-4" />Añadir
                </button>
              </div>
            </div>
            <div className="divide-y divide-slate-50">
              {manufacturers.length === 0 ? <p className="py-8 text-center text-sm text-slate-400">Sin fabricantes registrados.</p> :
                manufacturers.map((m) => <ListRow key={m.id} label={m.name} onDelete={() => del(`/api/masters/manufacturers/${m.id}`, load)} />)}
            </div>
          </div>
        )}

        {/* ── Device Models ── */}
        {tab === "models" && (
          <div className="rounded-2xl bg-white shadow-sm ring-1 ring-slate-200 overflow-hidden">
            <div className="border-b border-slate-100 px-6 py-4 bg-slate-50 space-y-3">
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Nuevo Modelo</p>
              <div className="flex gap-2">
                <Input placeholder="Ej: PowerEdge R740" value={newModel.name} onChange={(e) => setNewModel((p) => ({ ...p, name: e.target.value }))} />
                <Sel value={newModel.manufacturerId} onChange={(e) => setNewModel((p) => ({ ...p, manufacturerId: e.target.value }))}>
                  <option value="">— Fabricante —</option>
                  {manufacturers.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </Sel>
                <button onClick={async () => { try { await post("/api/masters/device-models", { name: newModel.name, manufacturerId: newModel.manufacturerId }); setNewModel({ name: "", manufacturerId: "" }); load(); } catch (e) { alert(e instanceof Error ? e.message : "Error"); }}}
                  className="flex-shrink-0 flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 transition-colors">
                  <Plus className="h-4 w-4" />Añadir
                </button>
              </div>
            </div>
            <div className="divide-y divide-slate-50">
              {models.length === 0 ? <p className="py-8 text-center text-sm text-slate-400">Sin modelos registrados.</p> :
                models.map((m) => <ListRow key={m.id} label={m.name} sublabel={m.manufacturer_name} onDelete={() => del(`/api/masters/device-models/${m.id}`, load)} />)}
            </div>
          </div>
        )}

        {/* ── Providers ── */}
        {tab === "providers" && (
          <div className="rounded-2xl bg-white shadow-sm ring-1 ring-slate-200 overflow-hidden">
            <div className="border-b border-slate-100 px-6 py-4 bg-slate-50">
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Nuevo Proveedor</p>
              <div className="flex gap-2 mt-2">
                <Input placeholder="Ej: Telefónica, AWS, Microsoft" value={newProv} onChange={(e) => setNewProv(e.target.value)} />
                <button onClick={async () => { try { await post("/api/masters/providers", { name: newProv }); setNewProv(""); load(); } catch (e) { alert(e instanceof Error ? e.message : "Error"); }}}
                  className="flex-shrink-0 flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 transition-colors">
                  <Plus className="h-4 w-4" />Añadir
                </button>
              </div>
            </div>
            <div className="divide-y divide-slate-50">
              {providers.length === 0 ? <p className="py-8 text-center text-sm text-slate-400">Sin proveedores registrados.</p> :
                providers.map((p) => <ListRow key={p.id} label={p.name} onDelete={() => del(`/api/masters/providers/${p.id}`, load)} />)}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// Suppress unused import warning for ChevronRight (kept for future breadcrumbs)
const _unused = ChevronRight;
void _unused;

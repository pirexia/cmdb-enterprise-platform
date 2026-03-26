"use client";

import { useEffect, useState } from "react";
import { X, Loader2, AlertTriangle } from "lucide-react";
import { apiFetch } from "@/lib/apiFetch";

// ─── Types ────────────────────────────────────────────────────────────────────

interface User         { id: string; username: string; email: string }
interface MasterItem   { id: string; name: string }
interface Branch       { id: string; name: string; branch_code: string; support_area_id: string; support_area_name: string }
interface DeviceModel  { id: string; name: string; manufacturer_id: string; manufacturer_name: string }

type CIType = "PHYSICAL_SERVER" | "VIRTUAL_SERVER" | "DATABASE" | "NETWORK_EQUIPMENT" | "STORAGE" | "BACKUP";
type Criticality = "LOW" | "MEDIUM" | "HIGH" | "MISSION_CRITICAL";
type Environment  = "DEVELOPMENT" | "TESTING" | "STAGING" | "PRODUCTION";

interface CI {
  id: string;
  name: string;
  apiSlug: string;
  criticality: Criticality;
  environment: Environment;
  ciType: string | null;  // API returns string, not enum
  status: string | null;
  inventoryNumber: string | null;
  businessOwnerId: string | null;
  technicalLeadId: string | null;
  branchId: string | null;
  ciModelId: string | null;
  eolDate: string | null;
  eosDate: string | null;
}

interface FormState {
  name: string;
  criticality: Criticality;
  environment: Environment;
  ciType: string;  // Internal form state uses string
  status: string;
  inventoryNumber: string;
  businessOwnerId: string;
  technicalLeadId: string;
  branchId: string;
  ciModelId: string;
  eolDate: string;
  eosDate: string;
}

function Label({ children }: { children: React.ReactNode }) {
  return <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1">{children}</label>;
}
function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100 disabled:opacity-50 ${props.className ?? ""}`} />;
}
function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-800 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100 disabled:opacity-50 ${props.className ?? ""}`} />;
}

// ─── Modal ────────────────────────────────────────────────────────────────────

export default function EditCIModal({ ci, onClose, onUpdated }: { ci: CI; onClose: () => void; onUpdated: () => void }): React.ReactElement {
  const [form, setForm] = useState<FormState>({
    name: ci.name,
    criticality: ci.criticality,
    environment: ci.environment,
    ciType: ci.ciType || "",
    status: ci.status || "ACTIVO",
    inventoryNumber: ci.inventoryNumber || "",
    businessOwnerId: ci.businessOwnerId || "",
    technicalLeadId: ci.technicalLeadId || "",
    branchId: ci.branchId || "",
    ciModelId: ci.ciModelId || "",
    eolDate: ci.eolDate ? ci.eolDate.slice(0, 10) : "",
    eosDate: ci.eosDate ? ci.eosDate.slice(0, 10) : "",
  });
  const [users,         setUsers]         = useState<User[]>([]);
  const [branches,      setBranches]      = useState<Branch[]>([]);
  const [manufacturers, setManufacturers] = useState<MasterItem[]>([]);
  const [allModels,     setAllModels]     = useState<DeviceModel[]>([]);
  const [submitting,    setSubmitting]    = useState(false);
  const [error,         setError]         = useState<string | null>(null);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  useEffect(() => {
    const safe = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
    Promise.all([
      apiFetch("/api/users").then((r) => r.json()).catch(() => []),
      apiFetch("/api/masters/branches").then((r) => r.json()).catch(() => []),
      apiFetch("/api/masters/manufacturers").then((r) => r.json()).catch(() => []),
      apiFetch("/api/masters/device-models").then((r) => r.json()).catch(() => []),
    ]).then(([u, b, m, dm]) => {
      setUsers(safe(u) as User[]);
      setBranches(safe(b) as Branch[]);
      setManufacturers(safe(m) as MasterItem[]);
      setAllModels(safe(dm) as DeviceModel[]);
    });
  }, []);

  // Filter models by selected manufacturer
  const selectedModel = allModels.find((m) => m.id === form.ciModelId);
  const manufacturerId = selectedModel?.manufacturer_id || "";
  const filteredModels = manufacturerId
    ? allModels.filter((m) => m.manufacturer_id === manufacturerId)
    : allModels;

  // Selected branch's support area
  const selectedBranch = branches.find((b) => b.id === form.branchId);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault(); setSubmitting(true); setError(null);

    const body: Record<string, unknown> = {
      name: form.name,
      environment: form.environment,
      criticality: form.criticality,
      ciType: form.ciType || null,
      status: form.status || null,
      inventoryNumber: form.inventoryNumber || null,
      branchId:  form.branchId  || null,
      ciModelId: form.ciModelId || null,
      eolDate:   form.eolDate   || null,
      eosDate:   form.eosDate   || null,
      businessOwnerId: form.businessOwnerId || null,
      technicalLeadId: form.technicalLeadId || null,
    };

    try {
      const res = await apiFetch(`/api/cis/${ci.id}`, { method: "PATCH", body: JSON.stringify(body) });
      if (!res.ok) {
        const ct = res.headers.get("content-type") ?? "";
        if (ct.includes("application/json")) { const err = await res.json(); throw new Error(err.error ?? `Error ${res.status}`); }
        else { const t = await res.text(); throw new Error(`Error ${res.status}: ${t.replace(/<[^>]+>/g, "").trim().slice(0, 120)}`); }
      }
      onUpdated(); onClose();
    } catch (err) { setError(err instanceof Error ? err.message : "Unknown error"); }
    finally { setSubmitting(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="relative w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-2xl bg-white shadow-2xl ring-1 ring-slate-200">
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
          <h2 className="text-base font-semibold text-slate-800">Editar Configuration Item</h2>
          <button onClick={onClose} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 transition-colors"><X className="h-4 w-4" /></button>
        </div>

        <form onSubmit={handleSubmit} className="px-6 py-6 space-y-5">
          {error && <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600"><AlertTriangle className="h-4 w-4 flex-shrink-0" />{error}</div>}

          {/* API Slug (read-only) */}
          <div>
            <Label>API Slug (solo lectura)</Label>
            <Input value={ci.apiSlug} disabled className="bg-slate-100 text-slate-500" />
          </div>

          {/* ── Governance (top) ── */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div>
              <Label>Estado</Label>
              <Select value={form.status} onChange={(e) => set("status", e.target.value)}>
                {["ACTIVO","INACTIVO","REPARACION","DESAPARECIDO","BAJA","OBSOLETO","DESTRUIDO"].map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </Select>
            </div>
            <div className="sm:col-span-2">
              <Label>Número de Inventario</Label>
              <Input placeholder="INV-2026-001" value={form.inventoryNumber} onChange={(e) => set("inventoryNumber", e.target.value)} />
            </div>
          </div>

          {/* ── Type ── */}
          <div>
            <Label>Tipo</Label>
            <Select value={form.ciType} onChange={(e) => set("ciType", e.target.value)}>
              <option value="">— Sin especificar —</option>
              <option value="PHYSICAL_SERVER">Servidor Físico</option>
              <option value="VIRTUAL_SERVER">Servidor Virtual</option>
              <option value="DATABASE">Base de Datos</option>
              <option value="NETWORK_EQUIPMENT">Equipo de Red</option>
              <option value="STORAGE">Almacenamiento</option>
              <option value="BACKUP">Backup</option>
            </Select>
          </div>

          {/* ── Name ── */}
          <div>
            <Label>Nombre *</Label>
            <Input required placeholder="ej. Web Server PRD-01" value={form.name} onChange={(e) => set("name", e.target.value)} />
          </div>

          {/* ── Env / Criticality ── */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div><Label>Entorno *</Label>
              <Select required value={form.environment} onChange={(e) => set("environment", e.target.value as Environment)}>
                <option value="PRODUCTION">Production</option><option value="STAGING">Staging</option>
                <option value="TESTING">Testing</option><option value="DEVELOPMENT">Development</option>
              </Select>
            </div>
            <div><Label>Criticidad *</Label>
              <Select required value={form.criticality} onChange={(e) => set("criticality", e.target.value as Criticality)}>
                <option value="MISSION_CRITICAL">Mission Critical</option><option value="HIGH">High</option>
                <option value="MEDIUM">Medium</option><option value="LOW">Low</option>
              </Select>
            </div>
          </div>

          {/* ── Sede (Branch) ── */}
          <div>
            <Label>Sede</Label>
            <Select value={form.branchId} onChange={(e) => set("branchId", e.target.value)}>
              <option value="">— Sin sede asignada —</option>
              {branches.map((b) => <option key={b.id} value={b.id}>{b.name} ({b.branch_code})</option>)}
            </Select>
            {selectedBranch && (
              <p className="mt-1 text-[11px] text-slate-400">
                Área de soporte: <span className="font-medium text-slate-600">{selectedBranch.support_area_name}</span>
              </p>
            )}
          </div>

          {/* ── Manufacturer + Model (master selects) ── */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <Label>Fabricante (catálogo)</Label>
              <Select value={manufacturerId} onChange={(e) => { set("ciModelId", ""); }} disabled>
                <option value="">— Sin especificar —</option>
                {manufacturers.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </Select>
              <p className="mt-1 text-[10px] text-slate-400">Vinculado al modelo seleccionado</p>
            </div>
            <div>
              <Label>Modelo (catálogo)</Label>
              <Select value={form.ciModelId} onChange={(e) => set("ciModelId", e.target.value)}>
                <option value="">— Sin especificar —</option>
                {allModels.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </Select>
            </div>
          </div>

          {/* ── Owners ── */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div><Label>Propietario de Negocio</Label>
              <Select value={form.businessOwnerId} onChange={(e) => set("businessOwnerId", e.target.value)}>
                <option value="">— Sin asignar —</option>
                {users.map((u) => <option key={u.id} value={u.id}>{u.username} ({u.email})</option>)}
              </Select>
            </div>
            <div><Label>Responsable Técnico</Label>
              <Select value={form.technicalLeadId} onChange={(e) => set("technicalLeadId", e.target.value)}>
                <option value="">— Sin asignar —</option>
                {users.map((u) => <option key={u.id} value={u.id}>{u.username} ({u.email})</option>)}
              </Select>
            </div>
          </div>

          {/* ── EOL / EoS dates ── */}
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 flex items-center gap-1.5">
              🕐 Fechas de Ciclo de Vida (EoL / EoS)
            </p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div><Label>End of Life (EoL)</Label><Input type="date" value={form.eolDate} onChange={(e) => set("eolDate", e.target.value)} /></div>
              <div><Label>End of Support (EoS)</Label><Input type="date" value={form.eosDate} onChange={(e) => set("eosDate", e.target.value)} /></div>
            </div>
          </div>

          <div className="flex justify-end gap-3 pt-2 border-t border-slate-100">
            <button type="button" onClick={onClose} className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 transition-colors">Cancelar</button>
            <button type="submit" disabled={submitting} className="flex items-center gap-2 rounded-lg bg-indigo-600 px-5 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-60 disabled:cursor-not-allowed transition-colors">
              {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
              {submitting ? "Guardando…" : "Guardar Cambios"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

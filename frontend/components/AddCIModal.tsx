"use client";

import { useEffect, useState } from "react";
import { X, Loader2, AlertTriangle } from "lucide-react";
import { apiFetch } from "@/lib/apiFetch";

// ─── Types ────────────────────────────────────────────────────────────────────

interface User         { id: string; username: string; email: string }
interface MasterItem   { id: string; name: string }
interface Branch       { id: string; name: string; branch_code: string; support_area_id: string; support_area_name: string }
interface DeviceModel  { id: string; name: string; manufacturer_id: string; manufacturer_name: string }
interface CITypeItem   { id: string; code: string; name: string; isSystem: boolean }
interface CITypeCategory { code: string; name: string; ciTypes: CITypeItem[] }

type Criticality = "LOW" | "MEDIUM" | "HIGH" | "MISSION_CRITICAL";
type Environment  = "DEVELOPMENT" | "TESTING" | "STAGING" | "PRODUCTION";
type BusinessImpact = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
type DataClassification = "PUBLIC" | "INTERNAL" | "CONFIDENTIAL" | "RESTRICTED";

// Category-based section helpers (which category shows which form section)
const HARDWARE_CATEGORIES = new Set(["INFRASTRUCTURE", "USER_DEVICE", "MOBILITY_IOT", "MEETING_ROOM"]);
const SOFTWARE_CATEGORIES = new Set(["SOFTWARE"]);
const LOCATION_CATEGORIES = new Set(["INFRASTRUCTURE"]);

interface FormState {
  ciTypeId: string; name: string; apiSlug: string;
  environment: Environment; criticality: Criticality;
  status: string; inventoryNumber: string;
  businessOwnerId: string; technicalLeadId: string;
  branchId: string; manufacturerId: string; ciModelId: string;
  // Hardware
  serialNumber: string; model: string; manufacturer: string;
  // Software
  version: string; licenseType: string; licenseModel: string; licenseMetric: string;
  // License
  licenseQty: string; licenseExpiry: string;
  // EOL dates (editable override)
  eolDate: string; eosDate: string;
  // Assignment (user devices)
  assignedUser: string; userDni: string;
  // Location + network (infra)
  floor: string; room: string; rack: string; rackUnit: string; vlan: string; consoleIp: string;
  // NIS2 / ISO 22301 / GDPR
  businessImpact: BusinessImpact | ""; recoveryPriority: string; rto: string; rpo: string;
  spofRisk: boolean; containsPii: boolean; dataClassification: DataClassification | "";
}

const INITIAL_FORM: FormState = {
  ciTypeId: "", name: "", apiSlug: "", environment: "PRODUCTION", criticality: "MEDIUM",
  status: "ACTIVO", inventoryNumber: "",
  businessOwnerId: "", technicalLeadId: "",
  branchId: "", manufacturerId: "", ciModelId: "",
  serialNumber: "", model: "", manufacturer: "",
  version: "", licenseType: "", licenseModel: "", licenseMetric: "",
  licenseQty: "", licenseExpiry: "",
  eolDate: "", eosDate: "",
  assignedUser: "", userDni: "",
  floor: "", room: "", rack: "", rackUnit: "", vlan: "", consoleIp: "",
  businessImpact: "", recoveryPriority: "", rto: "", rpo: "",
  spofRisk: false, containsPii: false, dataClassification: "",
};

function toSlug(name: string) {
  return name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
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

export default function AddCIModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }): React.ReactElement {
  const [form, setForm] = useState<FormState>(INITIAL_FORM);
  const [users,            setUsers]            = useState<User[]>([]);
  const [branches,         setBranches]         = useState<Branch[]>([]);
  const [manufacturers,    setManufacturers]    = useState<MasterItem[]>([]);
  const [allModels,        setAllModels]        = useState<DeviceModel[]>([]);
  const [ciTypeCategories, setCiTypeCategories] = useState<CITypeCategory[]>([]);
  const [submitting,       setSubmitting]       = useState(false);
  const [error,            setError]            = useState<string | null>(null);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value, ...(key === "name" ? { apiSlug: toSlug(value as string) } : {}) }));

  useEffect(() => {
    const safe = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
    Promise.all([
      apiFetch("/api/users").then((r) => r.json()).catch(() => []),
      apiFetch("/api/masters/branches").then((r) => r.json()).catch(() => []),
      apiFetch("/api/masters/manufacturers").then((r) => r.json()).catch(() => []),
      apiFetch("/api/masters/device-models").then((r) => r.json()).catch(() => []),
      apiFetch("/api/masters/ci-type-categories").then((r) => r.json()).catch(() => []),
    ]).then(([u, b, m, dm, cats]) => {
      setUsers(safe(u) as User[]);
      setBranches(safe(b) as Branch[]);
      setManufacturers(safe(m) as MasterItem[]);
      setAllModels(safe(dm) as DeviceModel[]);
      setCiTypeCategories(safe(cats) as CITypeCategory[]);
    });
  }, []);

  // Derive selected type's category code for section visibility
  const allFlatTypes = ciTypeCategories.flatMap((c) => c.ciTypes.map((t) => ({ ...t, categoryCode: c.code })));
  const selectedTypeInfo = allFlatTypes.find((t) => t.id === form.ciTypeId);
  const selectedCategoryCode = selectedTypeInfo?.categoryCode ?? "";
  const isHw    = HARDWARE_CATEGORIES.has(selectedCategoryCode);
  const isSw    = SOFTWARE_CATEGORIES.has(selectedCategoryCode);
  const isInfra = LOCATION_CATEGORIES.has(selectedCategoryCode);

  // Filter models by selected manufacturer
  const filteredModels = form.manufacturerId
    ? allModels.filter((m) => m.manufacturer_id === form.manufacturerId)
    : allModels;

  // Selected branch's support area
  const selectedBranch = branches.find((b) => b.id === form.branchId);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault(); setSubmitting(true); setError(null);

    const body: Record<string, unknown> = {
      name: form.name, apiSlug: form.apiSlug, environment: form.environment,
      criticality: form.criticality, ciTypeId: form.ciTypeId || undefined,
      status: form.status || undefined,
      inventoryNumber: form.inventoryNumber || undefined,
      branchId:  form.branchId  || undefined,
      ciModelId: form.ciModelId || undefined,
      eolDate:   form.eolDate   || undefined,
      eosDate:   form.eosDate   || undefined,
      businessOwnerId: form.businessOwnerId || undefined,
      technicalLeadId: form.technicalLeadId || undefined,
      // NIS2 fields
      businessImpact:     form.businessImpact     || undefined,
      recoveryPriority:   form.recoveryPriority    ? parseInt(form.recoveryPriority) : undefined,
      rto:                form.rto                 ? parseInt(form.rto)              : undefined,
      rpo:                form.rpo                 ? parseInt(form.rpo)              : undefined,
      spofRisk:           form.spofRisk,
      containsPii:        form.containsPii,
      dataClassification: form.dataClassification  || undefined,
    };

    // Hardware categories get hardware details
    if (isHw) {
      body.hardware = {
        serialNumber: form.serialNumber || `AUTO-${Date.now()}`,
        model:        form.model        || "Unknown",
        manufacturer: form.manufacturer || "Unknown",
      };
    }

    // Software category gets software details
    if (isSw) {
      body.software = {
        version: form.version || "1.0",
        licenseType: form.licenseType || "Unknown"
      };
    }

    // Infrastructure category gets location and network details
    const details: Record<string, unknown> = {};
    if (isInfra) {
      if (form.floor)     details.floor     = form.floor;
      if (form.room)      details.room      = form.room;
      if (form.rack)      details.rack      = form.rack;
      if (form.rackUnit)  details.rackUnit  = form.rackUnit;
      if (form.vlan)      details.vlan      = form.vlan;
      if (form.consoleIp) details.consoleIp = form.consoleIp;
    }

    if (Object.keys(details).length > 0) body.details = details;

    try {
      const res = await apiFetch("/api/cis", { method: "POST", body: JSON.stringify(body) });
      if (!res.ok) {
        const ct = res.headers.get("content-type") ?? "";
        if (ct.includes("application/json")) { const err = await res.json(); throw new Error(err.error ?? `Error ${res.status}`); }
        else { const t = await res.text(); throw new Error(`Error ${res.status}: ${t.replace(/<[^>]+>/g, "").trim().slice(0, 120)}`); }
      }
      onCreated(); onClose();
    } catch (err) { setError(err instanceof Error ? err.message : "Unknown error"); }
    finally { setSubmitting(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="relative w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-2xl bg-white shadow-2xl ring-1 ring-slate-200">
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
          <h2 className="text-base font-semibold text-slate-800">Añadir Configuration Item</h2>
          <button onClick={onClose} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 transition-colors"><X className="h-4 w-4" /></button>
        </div>

        <form onSubmit={handleSubmit} className="px-6 py-6 space-y-5">
          {error && <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600"><AlertTriangle className="h-4 w-4 flex-shrink-0" />{error}</div>}

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
            <Label>Tipo *</Label>
            <Select required value={form.ciTypeId} onChange={(e) => set("ciTypeId", e.target.value)}>
              <option value="">— Seleccionar tipo —</option>
              {ciTypeCategories.map((cat) => (
                <optgroup key={cat.code} label={cat.name}>
                  {cat.ciTypes.map((t) => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </optgroup>
              ))}
            </Select>
          </div>

          {/* ── Name / Slug ── */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div><Label>Nombre *</Label><Input required placeholder="ej. Web Server PRD-01" value={form.name} onChange={(e) => set("name", e.target.value)} /></div>
            <div>
              <Label>API Slug *</Label>
              <Input required placeholder="ej. web-server-prd-01" value={form.apiSlug} onChange={(e) => set("apiSlug", e.target.value)} />
              <p className="mt-1 text-[11px] text-slate-400">Auto-generado. Debe ser único.</p>
            </div>
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
          {isHw && (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <Label>Fabricante (catálogo)</Label>
                <Select value={form.manufacturerId} onChange={(e) => { set("manufacturerId", e.target.value); set("ciModelId", ""); }}>
                  <option value="">— Sin especificar —</option>
                  {manufacturers.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </Select>
              </div>
              <div>
                <Label>Modelo (catálogo)</Label>
                <Select value={form.ciModelId} onChange={(e) => set("ciModelId", e.target.value)} disabled={filteredModels.length === 0}>
                  <option value="">— Sin especificar —</option>
                  {filteredModels.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </Select>
              </div>
            </div>
          )}

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

          {/* ── Hardware section ── */}
          {isHw && (
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 space-y-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700">Detalles de Hardware</p>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <div><Label>Nº Serie / ID *</Label><Input required placeholder="SN-XXXXXXX" value={form.serialNumber} onChange={(e) => set("serialNumber", e.target.value)} /></div>
                <div><Label>Modelo / SKU</Label><Input placeholder="PowerEdge R740" value={form.model} onChange={(e) => set("model", e.target.value)} /></div>
                <div><Label>Fabricante / Proveedor</Label><Input placeholder="Dell / AWS" value={form.manufacturer} onChange={(e) => set("manufacturer", e.target.value)} /></div>
              </div>
            </div>
          )}

          {/* ── Software section ── */}
          {isSw && (
            <div className="rounded-xl border border-violet-200 bg-violet-50 p-4 space-y-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-violet-700">Detalles de Software</p>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div><Label>Versión</Label><Input placeholder="14.2.1" value={form.version} onChange={(e) => set("version", e.target.value)} /></div>
                <div><Label>Tipo de Licencia</Label><Input placeholder="Enterprise / OEM…" value={form.licenseType} onChange={(e) => set("licenseType", e.target.value)} /></div>
              </div>
            </div>
          )}

          {/* ── Technical Location + Network (infra) ── */}
          {isInfra && (
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-600">Ubicación Técnica y Red</p>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div><Label>Planta / Piso</Label><Input placeholder="PB" value={form.floor} onChange={(e) => set("floor", e.target.value)} /></div>
                <div><Label>Sala / CPD</Label><Input placeholder="CPD-01" value={form.room} onChange={(e) => set("room", e.target.value)} /></div>
                <div><Label>Rack</Label><Input placeholder="R01" value={form.rack} onChange={(e) => set("rack", e.target.value)} /></div>
                <div><Label>Unidad (U)</Label><Input placeholder="12" value={form.rackUnit} onChange={(e) => set("rackUnit", e.target.value)} /></div>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div><Label>VLAN</Label><Input placeholder="100" value={form.vlan} onChange={(e) => set("vlan", e.target.value)} /></div>
                <div><Label>IP de Consola (OOB)</Label><Input placeholder="10.0.0.1" value={form.consoleIp} onChange={(e) => set("consoleIp", e.target.value)} /></div>
              </div>
            </div>
          )}

          {/* ── EOL / EoS dates (optional override — backend auto-fills from endoflife.date) ── */}
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 flex items-center gap-1.5">
              Fechas de Ciclo de Vida (EoL / EoS)
              <span className="text-[10px] font-normal text-slate-400 lowercase">— se autocompletarán vía endoflife.date si se dejan vacías</span>
            </p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div><Label>End of Life (EoL)</Label><Input type="date" value={form.eolDate} onChange={(e) => set("eolDate", e.target.value)} /></div>
              <div><Label>End of Support (EoS)</Label><Input type="date" value={form.eosDate} onChange={(e) => set("eosDate", e.target.value)} /></div>
            </div>
          </div>

          {/* ── NIS2 / Resiliencia / GDPR ── */}
          <div className="rounded-xl border border-orange-200 bg-orange-50 p-4 space-y-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-orange-700">NIS2 · Resiliencia · GDPR</p>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <Label>Impacto de Negocio (NIS2)</Label>
                <Select value={form.businessImpact} onChange={(e) => set("businessImpact", e.target.value as BusinessImpact | "")}>
                  <option value="">— Sin clasificar —</option>
                  <option value="LOW">Bajo</option>
                  <option value="MEDIUM">Medio</option>
                  <option value="HIGH">Alto</option>
                  <option value="CRITICAL">Crítico</option>
                </Select>
              </div>
              <div>
                <Label>Clasificación de Datos (GDPR)</Label>
                <Select value={form.dataClassification} onChange={(e) => set("dataClassification", e.target.value as DataClassification | "")}>
                  <option value="">— Sin clasificar —</option>
                  <option value="PUBLIC">Público</option>
                  <option value="INTERNAL">Interno</option>
                  <option value="CONFIDENTIAL">Confidencial</option>
                  <option value="RESTRICTED">Restringido</option>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div>
                <Label>Prioridad de Recuperación (1-5)</Label>
                <Input type="number" min="1" max="5" placeholder="1 = primero" value={form.recoveryPriority} onChange={(e) => set("recoveryPriority", e.target.value)} />
              </div>
              <div>
                <Label>RTO (minutos)</Label>
                <Input type="number" min="0" placeholder="ej. 60" value={form.rto} onChange={(e) => set("rto", e.target.value)} />
                <p className="mt-1 text-[10px] text-slate-400">Recovery Time Objective</p>
              </div>
              <div>
                <Label>RPO (minutos)</Label>
                <Input type="number" min="0" placeholder="ej. 15" value={form.rpo} onChange={(e) => set("rpo", e.target.value)} />
                <p className="mt-1 text-[10px] text-slate-400">Recovery Point Objective</p>
              </div>
            </div>
            <div className="flex gap-6">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={form.spofRisk} onChange={(e) => set("spofRisk", e.target.checked)}
                  className="h-4 w-4 rounded border-slate-300 text-orange-600 focus:ring-orange-400" />
                <span className="text-sm text-slate-700">Punto Único de Fallo (SPOF)</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={form.containsPii} onChange={(e) => set("containsPii", e.target.checked)}
                  className="h-4 w-4 rounded border-slate-300 text-orange-600 focus:ring-orange-400" />
                <span className="text-sm text-slate-700">Contiene Datos Personales (PII / GDPR)</span>
              </label>
            </div>
          </div>

          <div className="flex justify-end gap-3 pt-2 border-t border-slate-100">
            <button type="button" onClick={onClose} className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 transition-colors">Cancelar</button>
            <button type="submit" disabled={submitting} className="flex items-center gap-2 rounded-lg bg-indigo-600 px-5 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-60 disabled:cursor-not-allowed transition-colors">
              {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
              {submitting ? "Guardando…" : "Crear CI"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

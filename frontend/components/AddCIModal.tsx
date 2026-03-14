"use client";

import { useEffect, useState } from "react";
import { X, Loader2, AlertTriangle } from "lucide-react";
import { apiFetch } from "@/lib/apiFetch";

// ─── Types ────────────────────────────────────────────────────────────────────

interface User { id: string; username: string; email: string }
type CIType =
  | "HARDWARE" | "SOFTWARE" | "OTHER"
  | "PHYSICAL_SERVER" | "VIRTUAL_SERVER"
  | "DATABASE" | "NETWORK" | "STORAGE" | "BACKUP"
  // Puesto de usuario
  | "DESKTOP" | "LAPTOP" | "PRINTER" | "SCANNER" | "MONITOR"
  // Oficina / Salas
  | "VIDEOCONFERENCE" | "SMART_DISPLAY" | "TIME_CLOCK" | "IP_PHONE"
  // Movilidad / Logística
  | "SMARTPHONE" | "TABLET" | "PDA" | "BARCODE_SCANNER"
  // IoT / Infra
  | "IP_CAMERA" | "UPS" | "WIFI_AP"
  // Cloud
  | "CLOUD_INSTANCE" | "CLOUD_STORAGE"
  // Software base y licencias
  | "BASE_SOFTWARE" | "LICENSE";
type Criticality = "LOW" | "MEDIUM" | "HIGH" | "MISSION_CRITICAL";
type Environment = "DEVELOPMENT" | "TESTING" | "STAGING" | "PRODUCTION";

interface FormState {
  type: CIType; name: string; apiSlug: string;
  environment: Environment; criticality: Criticality;
  businessOwnerId: string; technicalLeadId: string;
  serialNumber: string; model: string; manufacturer: string;
  version: string; licenseType: string;
  licenseModel: string; licenseMetric: string;
}

const INITIAL_FORM: FormState = {
  type: "PHYSICAL_SERVER", name: "", apiSlug: "", environment: "PRODUCTION", criticality: "MEDIUM",
  businessOwnerId: "", technicalLeadId: "",
  serialNumber: "", model: "", manufacturer: "", version: "", licenseType: "",
  licenseModel: "", licenseMetric: "",
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

interface AddCIModalProps { onClose: () => void; onCreated: () => void }

export default function AddCIModal({ onClose, onCreated }: AddCIModalProps) {
  const [form, setForm]       = useState<FormState>(INITIAL_FORM);
  const [users, setUsers]     = useState<User[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError]     = useState<string | null>(null);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value, ...(key === "name" ? { apiSlug: toSlug(value as string) } : {}) }));

  useEffect(() => {
    apiFetch("/api/users").then((r) => r.json()).then((d: User[]) => setUsers(d)).catch(() => setUsers([]));
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault(); setSubmitting(true); setError(null);
    const hwTypes: CIType[] = [
      "HARDWARE", "PHYSICAL_SERVER", "VIRTUAL_SERVER", "NETWORK", "STORAGE",
      "DESKTOP", "LAPTOP", "PRINTER", "SCANNER", "MONITOR",
      "VIDEOCONFERENCE", "SMART_DISPLAY", "TIME_CLOCK", "IP_PHONE",
      "SMARTPHONE", "TABLET", "PDA", "BARCODE_SCANNER",
      "IP_CAMERA", "UPS", "WIFI_AP",
      "CLOUD_INSTANCE", "CLOUD_STORAGE",
    ];
    const swTypes: CIType[] = ["SOFTWARE", "DATABASE", "BACKUP", "BASE_SOFTWARE", "LICENSE"];
    const body: Record<string, unknown> = {
      name: form.name, apiSlug: form.apiSlug, environment: form.environment, criticality: form.criticality,
      ciType: form.type,
      businessOwnerId: form.businessOwnerId || undefined, technicalLeadId: form.technicalLeadId || undefined,
    };
    if (hwTypes.includes(form.type)) body.hardware = { serialNumber: form.serialNumber, model: form.model, manufacturer: form.manufacturer };
    else if (swTypes.includes(form.type)) {
      body.software = { version: form.version, licenseType: form.licenseType };
      body.details  = { licenseModel: form.licenseModel || undefined, licenseMetric: form.licenseMetric || undefined };
    }

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
        <form onSubmit={handleSubmit} className="px-6 py-6 space-y-6">
          {error && <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600"><AlertTriangle className="h-4 w-4 flex-shrink-0" />{error}</div>}
          <div>
            <Label>Tipo *</Label>
            <Select required value={form.type} onChange={(e) => set("type", e.target.value as CIType)}>
              <optgroup label="🖥 Infraestructura">
                <option value="PHYSICAL_SERVER">Servidor Físico</option>
                <option value="VIRTUAL_SERVER">Servidor Virtual / VM</option>
                <option value="NETWORK">Red / Networking</option>
                <option value="STORAGE">Almacenamiento / Storage</option>
                <option value="UPS">SAI / UPS</option>
                <option value="WIFI_AP">Punto de Acceso WiFi</option>
              </optgroup>
              <optgroup label="☁️ Cloud">
                <option value="CLOUD_INSTANCE">Instancia Cloud (VM/Container)</option>
                <option value="CLOUD_STORAGE">Storage Cloud (S3/Blob)</option>
              </optgroup>
              <optgroup label="📦 Software y Datos">
                <option value="DATABASE">Base de Datos</option>
                <option value="SOFTWARE">Software / Aplicación</option>
                <option value="BACKUP">Backup / Recuperación</option>
                <option value="BASE_SOFTWARE">Software Base / SO</option>
                <option value="LICENSE">Licencia (standalone)</option>
              </optgroup>
              <optgroup label="💼 Puesto de Trabajo">
                <option value="DESKTOP">PC Escritorio</option>
                <option value="LAPTOP">Portátil / Laptop</option>
                <option value="MONITOR">Monitor (Periférico)</option>
                <option value="PRINTER">Impresora</option>
                <option value="SCANNER">Escáner Documental</option>
              </optgroup>
              <optgroup label="🏢 Oficina / Salas">
                <option value="VIDEOCONFERENCE">Equipo Videoconferencia</option>
                <option value="SMART_DISPLAY">Pantalla Smart / Pizarra</option>
                <option value="TIME_CLOCK">Reloj de Fichaje</option>
                <option value="IP_PHONE">Teléfono IP</option>
              </optgroup>
              <optgroup label="📱 Movilidad / Logística">
                <option value="SMARTPHONE">Smartphone</option>
                <option value="TABLET">Tablet</option>
                <option value="PDA">PDA / Terminal RF</option>
                <option value="BARCODE_SCANNER">Lector de Código de Barras</option>
              </optgroup>
              <optgroup label="🔌 IoT / Seguridad Física">
                <option value="IP_CAMERA">Cámara IP</option>
              </optgroup>
              <optgroup label="⚙️ Genérico">
                <option value="HARDWARE">Hardware (genérico)</option>
                <option value="OTHER">Otro</option>
              </optgroup>
            </Select>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div><Label>Nombre *</Label><Input required placeholder="ej. Web Server PRD-01" value={form.name} onChange={(e) => set("name", e.target.value)} /></div>
            <div>
              <Label>API Slug *</Label>
              <Input required placeholder="ej. web-server-prd-01" value={form.apiSlug} onChange={(e) => set("apiSlug", e.target.value)} />
              <p className="mt-1 text-[11px] text-slate-400">Auto-generado. Debe ser único.</p>
            </div>
          </div>
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
          {(["HARDWARE","PHYSICAL_SERVER","VIRTUAL_SERVER","NETWORK","STORAGE"] as CIType[]).includes(form.type) && (
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 space-y-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700">Detalles de Hardware</p>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <div><Label>Nº Serie *</Label><Input required placeholder="SN-XXXXXXX" value={form.serialNumber} onChange={(e) => set("serialNumber", e.target.value)} /></div>
                <div><Label>Modelo *</Label><Input required placeholder="PowerEdge R740" value={form.model} onChange={(e) => set("model", e.target.value)} /></div>
                <div><Label>Fabricante *</Label><Input required placeholder="Dell" value={form.manufacturer} onChange={(e) => set("manufacturer", e.target.value)} /></div>
              </div>
            </div>
          )}
          {(["SOFTWARE","DATABASE","BACKUP"] as CIType[]).includes(form.type) && (
            <div className="rounded-xl border border-violet-200 bg-violet-50 p-4 space-y-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-violet-700">Detalles de Software y Licenciamiento</p>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div><Label>Versión *</Label><Input required placeholder="14.2.1" value={form.version} onChange={(e) => set("version", e.target.value)} /></div>
                <div><Label>Tipo de Licencia</Label><Input placeholder="Enterprise / OEM…" value={form.licenseType} onChange={(e) => set("licenseType", e.target.value)} /></div>
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <Label>Modelo de Licencia</Label>
                  <Select value={form.licenseModel} onChange={(e) => set("licenseModel", e.target.value)}>
                    <option value="">— Sin especificar —</option>
                    <option value="subscription">Suscripción</option>
                    <option value="perpetual">Perpetua</option>
                    <option value="oem">OEM</option>
                    <option value="open_source">Open Source</option>
                    <option value="enterprise_agreement">Enterprise Agreement</option>
                  </Select>
                </div>
                <div>
                  <Label>Métrica de Licencia</Label>
                  <Select value={form.licenseMetric} onChange={(e) => set("licenseMetric", e.target.value)}>
                    <option value="">— Sin especificar —</option>
                    <option value="nominal">Nominal (por usuario)</option>
                    <option value="concurrent">Concurrente</option>
                    <option value="core_vcpu">Core / vCPU</option>
                    <option value="per_instance">Por Instancia</option>
                    <option value="pay_per_use">Pago por Uso</option>
                  </Select>
                </div>
              </div>
            </div>
          )}
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

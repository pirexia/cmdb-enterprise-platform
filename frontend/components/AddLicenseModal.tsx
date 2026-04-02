"use client";

import { useEffect, useState, useMemo } from "react";
import { X, Loader2, AlertTriangle, Search, Check } from "lucide-react";
import { apiFetch } from "@/lib/apiFetch";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Vendor         { id: string; name: string }
interface CIOption       { id: string; name: string; apiSlug: string; environment: string; criticality: string }
interface LicenseOption  { id: string; name: string; licenseNumber: string }
interface LicenseType    { id: string; code: string; name: string; categoryCode: string }
interface LicenseMetric  { id: string; code: string; name: string; categoryCode: string }

interface FormState {
  name: string; licenseNumber: string; vendorId: string;
  startDate: string; endDate: string;
  licenseTypeId: string; licenseMetricId: string;
  metricValue: string; metricUnit: string;
  cost: string; currency: string; status: string;
  notes: string; parentLicenseId: string;
  ciIds: string[];
}

const INITIAL_FORM: FormState = {
  name: "", licenseNumber: "", vendorId: "",
  startDate: "", endDate: "",
  licenseTypeId: "", licenseMetricId: "",
  metricValue: "", metricUnit: "",
  cost: "", currency: "EUR", status: "ACTIVO",
  notes: "", parentLicenseId: "",
  ciIds: [],
};

const STATUS_OPTIONS = ["ACTIVO", "BAJA"];
const CURRENCY_OPTIONS = ["EUR", "USD", "GBP", "CHF"];

function Label({ children, optional }: { children: React.ReactNode; optional?: boolean }) {
  return (
    <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1">
      {children}{optional && <span className="ml-1 normal-case font-normal text-slate-400">(opcional)</span>}
    </label>
  );
}
function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100 disabled:opacity-50 ${props.className ?? ""}`} />;
}
function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-800 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100 disabled:opacity-50 ${props.className ?? ""}`} />;
}
function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={`w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100 resize-none ${props.className ?? ""}`} />;
}

// ─── CI Multi-selector ────────────────────────────────────────────────────────

function CIMultiSelector({ cis, selected, onChange }: { cis: CIOption[]; selected: string[]; onChange: (ids: string[]) => void }) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => cis.filter((ci) => ci.name.toLowerCase().includes(query.toLowerCase()) || ci.apiSlug.toLowerCase().includes(query.toLowerCase())), [cis, query]);
  const toggle = (id: string) => onChange(selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id]);
  const selectedCIs = cis.filter((ci) => selected.includes(ci.id));

  return (
    <div className="space-y-2">
      {selectedCIs.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selectedCIs.map((ci) => (
            <span key={ci.id} className="inline-flex items-center gap-1 rounded-full bg-indigo-100 px-2.5 py-0.5 text-xs font-medium text-indigo-700">
              {ci.name}
              <button type="button" onClick={() => toggle(ci.id)} className="rounded-full hover:bg-indigo-200 p-0.5"><X className="h-3 w-3" /></button>
            </span>
          ))}
        </div>
      )}
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
        <input type="text" placeholder="Buscar CI…" value={query} onChange={(e) => setQuery(e.target.value)}
          className="w-full rounded-lg border border-slate-300 bg-slate-50 py-2 pl-9 pr-3 text-sm focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100" />
      </div>
      <div className="max-h-44 overflow-y-auto rounded-lg border border-slate-200 bg-white divide-y divide-slate-50">
        {filtered.length === 0 ? (
          <p className="px-4 py-3 text-xs text-slate-400 text-center">No hay CIs que coincidan.</p>
        ) : filtered.map((ci) => {
          const isSel = selected.includes(ci.id);
          return (
            <button key={ci.id} type="button" onClick={() => toggle(ci.id)}
              className={`flex w-full items-center justify-between px-4 py-2.5 text-left text-sm hover:bg-indigo-50 transition-colors ${isSel ? "bg-indigo-50" : ""}`}>
              <div>
                <p className={`font-medium ${isSel ? "text-indigo-700" : "text-slate-700"}`}>{ci.name}</p>
                <p className="text-xs text-slate-400">{ci.apiSlug} · {ci.environment}</p>
              </div>
              {isSel && <Check className="h-4 w-4 text-indigo-600 flex-shrink-0" />}
            </button>
          );
        })}
      </div>
      <p className="text-[11px] text-slate-400">
        {selected.length === 0 ? "Ningún CI seleccionado" : `${selected.length} CI${selected.length > 1 ? "s" : ""} seleccionado${selected.length > 1 ? "s" : ""}`}
      </p>
    </div>
  );
}

// ─── Modal ────────────────────────────────────────────────────────────────────

export default function AddLicenseModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [form, setForm]                 = useState<FormState>(INITIAL_FORM);
  const [vendors, setVendors]           = useState<Vendor[]>([]);
  const [cis, setCis]                   = useState<CIOption[]>([]);
  const [licenses, setLicenses]         = useState<LicenseOption[]>([]);
  const [licenseTypes, setLicenseTypes] = useState<LicenseType[]>([]);
  const [licenseMetrics, setLicenseMetrics] = useState<LicenseMetric[]>([]);
  const [submitting, setSubmitting]     = useState(false);
  const [error, setError]               = useState<string | null>(null);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  useEffect(() => {
    const safe = (p: Promise<Response>) => p.then((r) => r.json()).catch(() => []);
    Promise.all([
      safe(apiFetch("/api/vendors")),
      safe(apiFetch("/api/cis")),
      safe(apiFetch("/api/licenses")),
      safe(apiFetch("/api/masters/license-types")),
      safe(apiFetch("/api/masters/license-metrics")),
    ]).then(([v, c, l, lt, lm]) => {
      setVendors(v as Vendor[]);
      setCis(((c as { data?: CIOption[] }).data ?? []) as CIOption[]);
      setLicenses((((l as { data?: LicenseOption[] }).data ?? []) as LicenseOption[]));
      setLicenseTypes(lt as LicenseType[]);
      setLicenseMetrics(lm as LicenseMetric[]);
    });
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault(); setSubmitting(true); setError(null);
    const body = {
      name: form.name,
      licenseNumber: form.licenseNumber,
      startDate: form.startDate,
      endDate: form.endDate || undefined,
      vendorId: form.vendorId || undefined,
      licenseTypeId: form.licenseTypeId || undefined,
      licenseMetricId: form.licenseMetricId || undefined,
      metricValue: form.metricValue ? parseInt(form.metricValue, 10) : undefined,
      metricUnit: form.metricUnit || undefined,
      cost: form.cost || undefined,
      currency: form.currency || "EUR",
      status: form.status || "ACTIVO",
      notes: form.notes || undefined,
      parentLicenseId: form.parentLicenseId || undefined,
      ciIds: form.ciIds.length > 0 ? form.ciIds : undefined,
    };
    try {
      const res = await apiFetch("/api/licenses", { method: "POST", body: JSON.stringify(body) });
      if (!res.ok) {
        const ct = res.headers.get("content-type") ?? "";
        if (ct.includes("application/json")) { const err = await res.json(); throw new Error(err.error ?? `Error ${res.status}`); }
        else { const t = await res.text(); throw new Error(`Error ${res.status}: ${t.replace(/<[^>]+>/g, "").trim().slice(0, 120)}`); }
      }
      onCreated(); onClose();
    } catch (err) { setError(err instanceof Error ? err.message : "Unknown error"); }
    finally { setSubmitting(false); }
  };

  const isSubLicense = !!form.parentLicenseId;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="relative w-full max-w-2xl max-h-[92vh] overflow-y-auto rounded-2xl bg-white shadow-2xl ring-1 ring-slate-200">
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
          <div>
            <h2 className="text-base font-semibold text-slate-800">
              {isSubLicense ? "Nueva Sub-Licencia" : "Nueva Licencia"}
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              {isSubLicense ? "Vinculada a una licencia padre" : "Licencia de software o hardware"}
            </p>
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 transition-colors"><X className="h-4 w-4" /></button>
        </div>

        <form onSubmit={handleSubmit} className="px-6 py-6 space-y-6">
          {error && (
            <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
              <AlertTriangle className="h-4 w-4 flex-shrink-0" />{error}
            </div>
          )}

          {/* Name + License number */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <Label>Nombre de la Licencia *</Label>
              <Input required placeholder="Ej: Microsoft Office 365" value={form.name} onChange={(e) => set("name", e.target.value)} />
            </div>
            <div>
              <Label>Número de Licencia *</Label>
              <Input required placeholder="Ej: MS-O365-2025-001" value={form.licenseNumber} onChange={(e) => set("licenseNumber", e.target.value)} />
            </div>
          </div>

          {/* Vendor + Status */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <Label optional>Proveedor</Label>
              <Select value={form.vendorId} onChange={(e) => set("vendorId", e.target.value)}>
                <option value="">— Seleccionar —</option>
                {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </Select>
            </div>
            <div>
              <Label>Estado</Label>
              <Select value={form.status} onChange={(e) => set("status", e.target.value)}>
                {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
              </Select>
            </div>
          </div>

          {/* Dates */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div><Label>Fecha de Inicio *</Label><Input type="date" required value={form.startDate} onChange={(e) => set("startDate", e.target.value)} /></div>
            <div><Label optional>Fecha de Vencimiento</Label><Input type="date" value={form.endDate} onChange={(e) => set("endDate", e.target.value)} /></div>
          </div>

          {/* License type + metric */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <Label optional>Tipo de Licencia</Label>
              <Select value={form.licenseTypeId} onChange={(e) => set("licenseTypeId", e.target.value)}>
                <option value="">— Seleccionar —</option>
                {licenseTypes.map((lt) => <option key={lt.id} value={lt.id}>{lt.name}</option>)}
              </Select>
            </div>
            <div>
              <Label optional>Métrica de Licencia</Label>
              <Select value={form.licenseMetricId} onChange={(e) => set("licenseMetricId", e.target.value)}>
                <option value="">— Seleccionar —</option>
                {licenseMetrics.map((lm) => <option key={lm.id} value={lm.id}>{lm.name}</option>)}
              </Select>
            </div>
          </div>

          {/* Metric value + unit */}
          {form.licenseMetricId && (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <Label optional>Valor de la Métrica</Label>
                <Input type="number" min="0" placeholder="Ej: 100" value={form.metricValue} onChange={(e) => set("metricValue", e.target.value)} />
              </div>
              <div>
                <Label optional>Unidad</Label>
                <Input placeholder="Ej: usuarios, núcleos, GB" value={form.metricUnit} onChange={(e) => set("metricUnit", e.target.value)} />
              </div>
            </div>
          )}

          {/* Cost + currency */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <Label optional>Coste</Label>
              <Input type="number" min="0" step="0.01" placeholder="0.00" value={form.cost} onChange={(e) => set("cost", e.target.value)} />
            </div>
            <div>
              <Label>Moneda</Label>
              <Select value={form.currency} onChange={(e) => set("currency", e.target.value)}>
                {CURRENCY_OPTIONS.map((c) => <option key={c} value={c}>{c}</option>)}
              </Select>
            </div>
          </div>

          {/* Parent license */}
          <div>
            <Label optional>Licencia Padre (si es Sub-Licencia)</Label>
            <Select value={form.parentLicenseId} onChange={(e) => set("parentLicenseId", e.target.value)}>
              <option value="">— Esta es una licencia principal —</option>
              {licenses.map((l) => <option key={l.id} value={l.id}>{l.name} ({l.licenseNumber})</option>)}
            </Select>
            {isSubLicense && <p className="mt-1.5 text-xs text-amber-600 font-medium">Se guardará como sub-licencia de la licencia seleccionada.</p>}
          </div>

          {/* Notes */}
          <div>
            <Label optional>Notas</Label>
            <Textarea rows={3} placeholder="Observaciones, restricciones de uso, etc." value={form.notes} onChange={(e) => set("notes", e.target.value)} />
          </div>

          {/* CIs */}
          <div>
            <Label optional>CIs Asociados</Label>
            <CIMultiSelector cis={cis} selected={form.ciIds} onChange={(ids) => set("ciIds", ids)} />
          </div>

          <div className="flex justify-end gap-3 pt-2 border-t border-slate-100">
            <button type="button" onClick={onClose}
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 transition-colors">
              Cancelar
            </button>
            <button type="submit" disabled={submitting}
              className="flex items-center gap-2 rounded-lg bg-indigo-600 px-5 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-60 disabled:cursor-not-allowed transition-colors">
              {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
              {submitting ? "Guardando…" : isSubLicense ? "Crear Sub-Licencia" : "Crear Licencia"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

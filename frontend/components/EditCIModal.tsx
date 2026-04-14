"use client";

import { useEffect, useState } from "react";
import { X, Loader2, AlertTriangle } from "lucide-react";
import { apiFetch } from "@/lib/apiFetch";
import { useLanguage } from "@/contexts/LanguageContext";

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

interface ContractRef {
  id: string; contractNumber: string; endDate: string | null;
  vendor: { id: string; name: string };
}

interface CI {
  id: string;
  name: string;
  apiSlug: string;
  criticality: Criticality;
  environment: Environment;
  ciType: string | null;
  ciTypeId: string | null;
  status: string | null;
  inventoryNumber: string | null;
  businessOwnerId: string | null;
  technicalLeadId: string | null;
  branchId: string | null;
  ciModelId: string | null;
  eolDate: string | null;
  eosDate: string | null;
  contracts: ContractRef[];
  // NIS2 / GDPR
  businessImpact: string | null;
  recoveryPriority: number | null;
  rto: number | null;
  rpo: number | null;
  spofRisk: boolean;
  containsPii: boolean;
  dataClassification: string | null;
}

interface FormState {
  name: string;
  criticality: Criticality;
  environment: Environment;
  ciTypeId: string;
  status: string;
  inventoryNumber: string;
  businessOwnerId: string;
  technicalLeadId: string;
  branchId: string;
  ciModelId: string;
  eolDate: string;
  eosDate: string;
  // NIS2 / GDPR
  businessImpact: BusinessImpact | "";
  recoveryPriority: string;
  rto: string;
  rpo: string;
  spofRisk: boolean;
  containsPii: boolean;
  dataClassification: DataClassification | "";
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
  const { t } = useLanguage();
  const [form, setForm] = useState<FormState>({
    name: ci.name,
    criticality: ci.criticality,
    environment: ci.environment,
    ciTypeId: ci.ciTypeId || "",
    status: ci.status || "ACTIVO",
    inventoryNumber: ci.inventoryNumber || "",
    businessOwnerId: ci.businessOwnerId || "",
    technicalLeadId: ci.technicalLeadId || "",
    branchId: ci.branchId || "",
    ciModelId: ci.ciModelId || "",
    eolDate: ci.eolDate ? ci.eolDate.slice(0, 10) : "",
    eosDate: ci.eosDate ? ci.eosDate.slice(0, 10) : "",
    businessImpact: (ci.businessImpact as BusinessImpact | null) || "",
    recoveryPriority: ci.recoveryPriority != null ? String(ci.recoveryPriority) : "",
    rto: ci.rto != null ? String(ci.rto) : "",
    rpo: ci.rpo != null ? String(ci.rpo) : "",
    spofRisk: ci.spofRisk ?? false,
    containsPii: ci.containsPii ?? false,
    dataClassification: (ci.dataClassification as DataClassification | null) || "",
  });
  const [users,            setUsers]            = useState<User[]>([]);
  const [branches,         setBranches]         = useState<Branch[]>([]);
  const [manufacturers,    setManufacturers]    = useState<MasterItem[]>([]);
  const [allModels,        setAllModels]        = useState<DeviceModel[]>([]);
  const [ciTypeCategories, setCiTypeCategories] = useState<CITypeCategory[]>([]);
  const [submitting,       setSubmitting]       = useState(false);
  const [error,            setError]            = useState<string | null>(null);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

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
      ciTypeId: form.ciTypeId || null,
      status: form.status || null,
      inventoryNumber: form.inventoryNumber || null,
      branchId:  form.branchId  || null,
      ciModelId: form.ciModelId || null,
      eolDate:   form.eolDate   || null,
      eosDate:   form.eosDate   || null,
      businessOwnerId: form.businessOwnerId || null,
      technicalLeadId: form.technicalLeadId || null,
      businessImpact:     form.businessImpact     || null,
      recoveryPriority:   form.recoveryPriority    ? parseInt(form.recoveryPriority) : null,
      rto:                form.rto                 ? parseInt(form.rto)              : null,
      rpo:                form.rpo                 ? parseInt(form.rpo)              : null,
      spofRisk:           form.spofRisk,
      containsPii:        form.containsPii,
      dataClassification: form.dataClassification  || null,
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
          <h2 className="text-base font-semibold text-slate-800">{t("add_ci_modal.edit_title")}</h2>
          <button onClick={onClose} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 transition-colors"><X className="h-4 w-4" /></button>
        </div>

        <form onSubmit={handleSubmit} className="px-6 py-6 space-y-5">
          {error && <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600"><AlertTriangle className="h-4 w-4 flex-shrink-0" />{error}</div>}

          {/* API Slug (read-only) */}
          <div>
            <Label>{t("add_ci_modal.slug_readonly")}</Label>
            <Input value={ci.apiSlug} disabled className="bg-slate-100 text-slate-500" />
          </div>

          {/* ── Governance (top) ── */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div>
              <Label>{t("add_ci_modal.status_label")}</Label>
              <Select value={form.status} onChange={(e) => set("status", e.target.value)}>
                {["ACTIVO","INACTIVO","REPARACION","DESAPARECIDO","BAJA","OBSOLETO","DESTRUIDO"].map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </Select>
            </div>
            <div className="sm:col-span-2">
              <Label>{t("add_ci_modal.inventory_label")}</Label>
              <Input placeholder="INV-2026-001" value={form.inventoryNumber} onChange={(e) => set("inventoryNumber", e.target.value)} />
            </div>
          </div>

          {/* ── Type ── */}
          <div>
            <Label>{t("add_ci_modal.type_label")}</Label>
            <Select value={form.ciTypeId} onChange={(e) => set("ciTypeId", e.target.value)}>
              <option value="">{t("add_ci_modal.no_selection")}</option>
              {ciTypeCategories.map((cat) => (
                <optgroup key={cat.code} label={cat.name}>
                  {cat.ciTypes.map((ct) => (
                    <option key={ct.id} value={ct.id}>{ct.name}</option>
                  ))}
                </optgroup>
              ))}
            </Select>
          </div>

          {/* ── Name ── */}
          <div>
            <Label>{t("add_ci_modal.name_label")} *</Label>
            <Input required placeholder={t("add_ci_modal.name_placeholder")} value={form.name} onChange={(e) => set("name", e.target.value)} />
          </div>

          {/* ── Env / Criticality ── */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div><Label>{t("add_ci_modal.env_label")} *</Label>
              <Select required value={form.environment} onChange={(e) => set("environment", e.target.value as Environment)}>
                <option value="PRODUCTION">Production</option><option value="STAGING">Staging</option>
                <option value="TESTING">Testing</option><option value="DEVELOPMENT">Development</option>
              </Select>
            </div>
            <div><Label>{t("add_ci_modal.crit_label")} *</Label>
              <Select required value={form.criticality} onChange={(e) => set("criticality", e.target.value as Criticality)}>
                <option value="MISSION_CRITICAL">Mission Critical</option><option value="HIGH">High</option>
                <option value="MEDIUM">Medium</option><option value="LOW">Low</option>
              </Select>
            </div>
          </div>

          {/* ── Sede (Branch) ── */}
          <div>
            <Label>{t("add_ci_modal.branch_label")}</Label>
            <Select value={form.branchId} onChange={(e) => set("branchId", e.target.value)}>
              <option value="">{t("add_ci_modal.branch_placeholder")}</option>
              {branches.map((b) => <option key={b.id} value={b.id}>{b.name} ({b.branch_code})</option>)}
            </Select>
            {selectedBranch && (
              <p className="mt-1 text-[11px] text-slate-400">
                {t("add_ci_modal.support_area")} <span className="font-medium text-slate-600">{selectedBranch.support_area_name}</span>
              </p>
            )}
          </div>

          {/* ── Manufacturer + Model (master selects) ── */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <Label>{t("add_ci_modal.manufacturer_label")}</Label>
              <Select value={manufacturerId} onChange={(e) => { set("ciModelId", ""); }} disabled>
                <option value="">{t("add_ci_modal.no_selection")}</option>
                {manufacturers.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </Select>
              <p className="mt-1 text-[10px] text-slate-400">{t("add_ci_modal.manufacturer_hint")}</p>
            </div>
            <div>
              <Label>{t("add_ci_modal.model_label")}</Label>
              <Select value={form.ciModelId} onChange={(e) => set("ciModelId", e.target.value)}>
                <option value="">{t("add_ci_modal.no_selection")}</option>
                {allModels.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </Select>
            </div>
          </div>

          {/* ── Owners ── */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div><Label>{t("add_ci_modal.business_owner_label")}</Label>
              <Select value={form.businessOwnerId} onChange={(e) => set("businessOwnerId", e.target.value)}>
                <option value="">{t("add_ci_modal.unassigned")}</option>
                {users.map((u) => <option key={u.id} value={u.id}>{u.username} ({u.email})</option>)}
              </Select>
            </div>
            <div><Label>{t("add_ci_modal.technical_lead_label")}</Label>
              <Select value={form.technicalLeadId} onChange={(e) => set("technicalLeadId", e.target.value)}>
                <option value="">{t("add_ci_modal.unassigned")}</option>
                {users.map((u) => <option key={u.id} value={u.id}>{u.username} ({u.email})</option>)}
              </Select>
            </div>
          </div>

          {/* ── EOL / EoS dates ── */}
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 flex items-center gap-1.5">
              {t("add_ci_modal.eol_section")}
            </p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div><Label>{t("add_ci_modal.eol_label")}</Label><Input type="date" value={form.eolDate} onChange={(e) => set("eolDate", e.target.value)} /></div>
              <div><Label>{t("add_ci_modal.eos_label")}</Label><Input type="date" value={form.eosDate} onChange={(e) => set("eosDate", e.target.value)} /></div>
            </div>
          </div>

          {/* ── NIS2 / Resiliencia / GDPR ── */}
          <div className="rounded-xl border border-orange-200 bg-orange-50 p-4 space-y-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-orange-700">{t("add_ci_modal.nis2_section")}</p>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <Label>{t("add_ci_modal.business_impact_label")}</Label>
                <Select value={form.businessImpact} onChange={(e) => set("businessImpact", e.target.value as BusinessImpact | "")}>
                  <option value="">{t("add_ci_modal.unclassified")}</option>
                  <option value="LOW">{t("add_ci_modal.impact_low")}</option>
                  <option value="MEDIUM">{t("add_ci_modal.impact_medium")}</option>
                  <option value="HIGH">{t("add_ci_modal.impact_high")}</option>
                  <option value="CRITICAL">{t("add_ci_modal.impact_critical")}</option>
                </Select>
              </div>
              <div>
                <Label>{t("add_ci_modal.data_class_label")}</Label>
                <Select value={form.dataClassification} onChange={(e) => set("dataClassification", e.target.value as DataClassification | "")}>
                  <option value="">{t("add_ci_modal.unclassified")}</option>
                  <option value="PUBLIC">{t("add_ci_modal.class_public")}</option>
                  <option value="INTERNAL">{t("add_ci_modal.class_internal")}</option>
                  <option value="CONFIDENTIAL">{t("add_ci_modal.class_confidential")}</option>
                  <option value="RESTRICTED">{t("add_ci_modal.class_restricted")}</option>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div>
                <Label>{t("add_ci_modal.recovery_priority_label")}</Label>
                <Input type="number" min="1" max="5" placeholder="1 = primero" value={form.recoveryPriority} onChange={(e) => set("recoveryPriority", e.target.value)} />
              </div>
              <div>
                <Label>{t("add_ci_modal.rto_label")}</Label>
                <Input type="number" min="0" placeholder="ej. 60" value={form.rto} onChange={(e) => set("rto", e.target.value)} />
                <p className="mt-1 text-[10px] text-slate-400">{t("add_ci_modal.rto_hint")}</p>
              </div>
              <div>
                <Label>{t("add_ci_modal.rpo_label")}</Label>
                <Input type="number" min="0" placeholder="ej. 15" value={form.rpo} onChange={(e) => set("rpo", e.target.value)} />
                <p className="mt-1 text-[10px] text-slate-400">{t("add_ci_modal.rpo_hint")}</p>
              </div>
            </div>
            <div className="flex gap-6">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={form.spofRisk} onChange={(e) => set("spofRisk", e.target.checked)}
                  className="h-4 w-4 rounded border-slate-300 text-orange-600 focus:ring-orange-400" />
                <span className="text-sm text-slate-700">{t("add_ci_modal.spof_label")}</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={form.containsPii} onChange={(e) => set("containsPii", e.target.checked)}
                  className="h-4 w-4 rounded border-slate-300 text-orange-600 focus:ring-orange-400" />
                <span className="text-sm text-slate-700">{t("add_ci_modal.pii_label")}</span>
              </label>
            </div>
          </div>

          {/* ── Contratos asociados (solo lectura) ── */}
          {ci.contracts && ci.contracts.length > 0 && (
            <div className="rounded-xl border border-blue-200 bg-blue-50 p-4 space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-blue-700">{t("add_ci_modal.contracts_section")}</p>
              <div className="space-y-1">
                {ci.contracts.map((ct) => (
                  <div key={ct.id} className="flex items-center justify-between rounded-lg bg-white border border-blue-100 px-3 py-2">
                    <div>
                      <p className="text-sm font-medium text-slate-800">{ct.contractNumber}</p>
                      <p className="text-xs text-slate-400">{ct.vendor?.name ?? '—'}</p>
                    </div>
                    {ct.endDate && (
                      <span className="text-xs text-slate-500">{t("add_ci_modal.expires")} {ct.endDate.slice(0,10)}</span>
                    )}
                  </div>
                ))}
              </div>
              <p className="text-[10px] text-blue-600">{t("add_ci_modal.contracts_hint")}</p>
            </div>
          )}

          <div className="flex justify-end gap-3 pt-2 border-t border-slate-100">
            <button type="button" onClick={onClose} className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 transition-colors">{t("actions.cancel")}</button>
            <button type="submit" disabled={submitting} className="flex items-center gap-2 rounded-lg bg-indigo-600 px-5 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-60 disabled:cursor-not-allowed transition-colors">
              {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
              {submitting ? t("common.saving") : t("add_ci_modal.save_changes")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

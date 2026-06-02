"use client";

import { useEffect, useState } from "react";
import { X, Loader2, AlertTriangle, CheckCircle2 } from "lucide-react";
import { apiFetch } from "@/lib/apiFetch";
import { useLanguage } from "@/contexts/LanguageContext";

interface CITypeItem { id: string; code: string; name: string }
interface MasterItem { id: string; name: string }
interface UserRef    { id: string; username: string; email: string }

type Criticality        = "LOW" | "MEDIUM" | "HIGH" | "MISSION_CRITICAL";
type Environment        = "DEVELOPMENT" | "TESTING" | "STAGING" | "PRODUCTION";
type CIStatus           = "ACTIVO" | "INACTIVO" | "RETIRADO";
type BusinessImpact     = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
type DataClassification = "PUBLIC" | "INTERNAL" | "CONFIDENTIAL" | "RESTRICTED";

// Tri-state for each field: undefined = leave untouched, value = apply.
// Boolean fields share the same convention with a {value:boolean} wrapper.
interface BulkPayload {
  criticality?:        Criticality;
  environment?:        Environment;
  status?:             CIStatus;
  ciTypeId?:           string | null;
  costCenterId?:       string | null;
  branchId?:           string | null;
  businessOwnerId?:    string | null;
  technicalLeadId?:    string | null;
  businessImpact?:     BusinessImpact | null;
  dataClassification?: DataClassification | null;
  containsPii?:        boolean;
  spofRisk?:           boolean;
}

interface Props {
  ciIds: string[];
  onClose: () => void;
  onUpdated: () => void;
}

export default function BulkUpdateCIModal({ ciIds, onClose, onUpdated }: Props) {
  const { t } = useLanguage();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [ciTypes, setCITypes]         = useState<CITypeItem[]>([]);
  const [costCenters, setCostCenters] = useState<MasterItem[]>([]);
  const [branches, setBranches]       = useState<MasterItem[]>([]);
  const [users, setUsers]             = useState<UserRef[]>([]);

  const [payload, setPayload] = useState<BulkPayload>({});

  useEffect(() => {
    (async () => {
      try {
        const [tRes, ccRes, bRes, uRes] = await Promise.all([
          apiFetch("/api/masters/ci-types"),
          apiFetch("/api/masters/cost-centers"),
          apiFetch("/api/masters/branches"),
          apiFetch("/api/users"),
        ]);
        if (tRes.ok)  setCITypes(await tRes.json());
        if (ccRes.ok) setCostCenters(await ccRes.json());
        if (bRes.ok)  setBranches(await bRes.json());
        if (uRes.ok) {
          const data = await uRes.json();
          setUsers(Array.isArray(data) ? data : (data.data ?? []));
        }
      } catch { /* graceful — selects just stay empty */ }
    })();
  }, []);

  const setField = <K extends keyof BulkPayload>(key: K, value: BulkPayload[K] | undefined) =>
    setPayload((prev) => {
      const next = { ...prev };
      if (value === undefined) delete next[key]; else (next as Record<string, unknown>)[key] = value;
      return next;
    });

  const hasChanges = Object.keys(payload).length > 0;

  const handleSubmit = async () => {
    if (!hasChanges) return;
    setSaving(true); setError(null);
    try {
      const res = await apiFetch("/api/cis/bulk-update", {
        method: "PATCH",
        body: JSON.stringify({ ciIds, updates: payload }),
      });
      const body = await res.json().catch(() => ({})) as { updated?: number; error?: string };
      if (!res.ok) throw new Error(body.error ?? `Error ${res.status}`);
      onUpdated();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("inventory.bulk_update.error"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="w-full max-w-2xl rounded-none bg-white shadow-xl ring-1 ring-slate-200 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-200 bg-white px-6 py-4">
          <div>
            <h2 className="text-lg font-bold text-slate-800">{t("inventory.bulk_update.title")}</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              {t("inventory.bulk_update.selected_count", { count: String(ciIds.length) })}
              {" — "}
              {t("inventory.bulk_update.hint")}
            </p>
          </div>
          <button onClick={onClose} className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-colors">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="px-6 py-5 space-y-4">
          {error && (
            <div className="flex items-start gap-2 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {/* Criticality */}
          <Field label={t("inventory.bulk_update.field_criticality")}>
            <select value={payload.criticality ?? ""} onChange={(e) => setField("criticality", (e.target.value || undefined) as Criticality | undefined)} className={inputCls}>
              <option value="">{t("inventory.bulk_update.no_change")}</option>
              <option value="LOW">{t("inventory.criticality.LOW")}</option>
              <option value="MEDIUM">{t("inventory.criticality.MEDIUM")}</option>
              <option value="HIGH">{t("inventory.criticality.HIGH")}</option>
              <option value="MISSION_CRITICAL">{t("inventory.criticality.MISSION_CRITICAL")}</option>
            </select>
          </Field>

          {/* Environment */}
          <Field label={t("inventory.bulk_update.field_environment")}>
            <select value={payload.environment ?? ""} onChange={(e) => setField("environment", (e.target.value || undefined) as Environment | undefined)} className={inputCls}>
              <option value="">{t("inventory.bulk_update.no_change")}</option>
              <option value="DEVELOPMENT">{t("inventory.environment.DEVELOPMENT")}</option>
              <option value="TESTING">{t("inventory.environment.TESTING")}</option>
              <option value="STAGING">{t("inventory.environment.STAGING")}</option>
              <option value="PRODUCTION">{t("inventory.environment.PRODUCTION")}</option>
            </select>
          </Field>

          {/* Status */}
          <Field label={t("inventory.bulk_update.field_status")}>
            <select value={payload.status ?? ""} onChange={(e) => setField("status", (e.target.value || undefined) as CIStatus | undefined)} className={inputCls}>
              <option value="">{t("inventory.bulk_update.no_change")}</option>
              <option value="ACTIVO">{t("inventory.status.ACTIVO")}</option>
              <option value="INACTIVO">{t("inventory.status.INACTIVO")}</option>
              <option value="RETIRADO">{t("inventory.status.RETIRADO")}</option>
            </select>
          </Field>

          {/* CI Type */}
          <Field label={t("inventory.bulk_update.field_ciType")}>
            <FkSelect items={ciTypes.map((c) => ({ id: c.id, label: c.name }))} value={payload.ciTypeId} onChange={(v) => setField("ciTypeId", v)} t={t} />
          </Field>

          {/* Branch */}
          <Field label={t("inventory.bulk_update.field_branch")}>
            <FkSelect items={branches.map((b) => ({ id: b.id, label: b.name }))} value={payload.branchId} onChange={(v) => setField("branchId", v)} t={t} />
          </Field>

          {/* Cost center */}
          <Field label={t("inventory.bulk_update.field_costCenter")}>
            <FkSelect items={costCenters.map((c) => ({ id: c.id, label: c.name }))} value={payload.costCenterId} onChange={(v) => setField("costCenterId", v)} t={t} />
          </Field>

          {/* Owners */}
          <Field label={t("inventory.bulk_update.field_businessOwner")}>
            <FkSelect items={users.map((u) => ({ id: u.id, label: `${u.username} (${u.email})` }))} value={payload.businessOwnerId} onChange={(v) => setField("businessOwnerId", v)} t={t} />
          </Field>
          <Field label={t("inventory.bulk_update.field_technicalLead")}>
            <FkSelect items={users.map((u) => ({ id: u.id, label: `${u.username} (${u.email})` }))} value={payload.technicalLeadId} onChange={(v) => setField("technicalLeadId", v)} t={t} />
          </Field>

          {/* Business impact */}
          <Field label={t("inventory.bulk_update.field_businessImpact")}>
            <select value={payload.businessImpact ?? ""} onChange={(e) => setField("businessImpact", (e.target.value || undefined) as BusinessImpact | undefined)} className={inputCls}>
              <option value="">{t("inventory.bulk_update.no_change")}</option>
              <option value="LOW">LOW</option>
              <option value="MEDIUM">MEDIUM</option>
              <option value="HIGH">HIGH</option>
              <option value="CRITICAL">CRITICAL</option>
            </select>
          </Field>

          {/* Data classification */}
          <Field label={t("inventory.bulk_update.field_dataClassification")}>
            <select value={payload.dataClassification ?? ""} onChange={(e) => setField("dataClassification", (e.target.value || undefined) as DataClassification | undefined)} className={inputCls}>
              <option value="">{t("inventory.bulk_update.no_change")}</option>
              <option value="PUBLIC">PUBLIC</option>
              <option value="INTERNAL">INTERNAL</option>
              <option value="CONFIDENTIAL">CONFIDENTIAL</option>
              <option value="RESTRICTED">RESTRICTED</option>
            </select>
          </Field>

          {/* Booleans (tri-state) */}
          <Field label={t("inventory.bulk_update.field_containsPii")}>
            <TriState value={payload.containsPii} onChange={(v) => setField("containsPii", v)} t={t} />
          </Field>
          <Field label={t("inventory.bulk_update.field_spofRisk")}>
            <TriState value={payload.spofRisk} onChange={(v) => setField("spofRisk", v)} t={t} />
          </Field>
        </div>

        <div className="sticky bottom-0 z-10 flex items-center justify-end gap-2 border-t border-slate-200 bg-white px-6 py-4">
          <button onClick={onClose} disabled={saving} className="rounded-none border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 transition-colors disabled:opacity-50">
            {t("actions.cancel")}
          </button>
          <button onClick={handleSubmit} disabled={saving || !hasChanges} className="flex items-center gap-2 rounded-none bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white hover:bg-[var(--accent)]/90 disabled:opacity-50 transition-colors">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
            {t("inventory.bulk_update.apply")}
          </button>
        </div>
      </div>
    </div>
  );
}

const inputCls = "w-full rounded-none border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-[var(--accent)] focus:ring-1 focus:ring-[var(--accent)]/20";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-12 items-center gap-3">
      <label className="col-span-4 text-xs font-medium text-slate-600">{label}</label>
      <div className="col-span-8">{children}</div>
    </div>
  );
}

function FkSelect({ items, value, onChange, t }: { items: { id: string; label: string }[]; value: string | null | undefined; onChange: (v: string | null | undefined) => void; t: (k: string) => string }) {
  // Encoding: "" = no_change (undefined), "__null__" = clear (null), else id
  const display = value === undefined ? "" : value === null ? "__null__" : value;
  return (
    <select value={display} onChange={(e) => {
      const v = e.target.value;
      if (v === "") onChange(undefined);
      else if (v === "__null__") onChange(null);
      else onChange(v);
    }} className={inputCls}>
      <option value="">{t("inventory.bulk_update.no_change")}</option>
      <option value="__null__">{t("inventory.bulk_update.clear_value")}</option>
      {items.map((it) => <option key={it.id} value={it.id}>{it.label}</option>)}
    </select>
  );
}

function TriState({ value, onChange, t }: { value: boolean | undefined; onChange: (v: boolean | undefined) => void; t: (k: string) => string }) {
  const display = value === undefined ? "" : value ? "true" : "false";
  return (
    <select value={display} onChange={(e) => {
      const v = e.target.value;
      if (v === "") onChange(undefined);
      else onChange(v === "true");
    }} className={inputCls}>
      <option value="">{t("inventory.bulk_update.no_change")}</option>
      <option value="true">{t("inventory.bulk_update.set_true")}</option>
      <option value="false">{t("inventory.bulk_update.set_false")}</option>
    </select>
  );
}

"use client";

import { useState } from "react";
import { X, Check, Loader2, Server, AlertTriangle, Lock } from "lucide-react";
import { apiFetch } from "@/lib/apiFetch";
import { useLanguage } from "@/contexts/LanguageContext";
import { LifecycleDatesEditor } from "@/components/LifecycleDatesEditor";

type EntityType  = "device-models" | "operating-systems" | "base-software";
type DTCategory  = "HARDWARE" | "SOFTWARE" | "OS" | "GENERAL";

export interface CatalogEntity {
  id: string;
  name: string;
  version?: string | null;
  manufacturerId: string;
  isSystem?: boolean;
  subtitle?: string;
}

interface Props {
  entity: CatalogEntity;
  entityType: EntityType;
  patchUrl: string;
  title: string;
  categoryFilter: DTCategory;
  showVersion?: boolean;
  manufacturerRequired?: boolean;
  manufacturers: { id: string; name: string }[];
  onClose: () => void;
  onSaved: () => void;
}

export default function EditCatalogEntityModal({
  entity, entityType, patchUrl, title, categoryFilter,
  showVersion = false, manufacturerRequired = false, manufacturers, onClose, onSaved,
}: Props) {
  const { t } = useLanguage();
  const readOnlyFields = !!entity.isSystem;

  const [name, setName]                     = useState(entity.name);
  const [version, setVersion]               = useState(entity.version ?? "");
  const [manufacturerId, setManufacturerId] = useState(entity.manufacturerId);
  const [saving, setSaving]                 = useState(false);
  const [error, setError]                   = useState<string | null>(null);
  const [savedOk, setSavedOk]               = useState(false);

  const dirty =
    name.trim() !== entity.name ||
    (showVersion && version.trim() !== (entity.version ?? "")) ||
    manufacturerId !== entity.manufacturerId;

  const handleSave = async () => {
    if (!name.trim()) { setError(t("masters.entity_modal.name_required")); return; }
    if (manufacturerRequired && !manufacturerId) { setError(t("masters.entity_modal.manufacturer_required")); return; }
    setSaving(true); setError(null); setSavedOk(false);
    try {
      const body: Record<string, unknown> = { name: name.trim() };
      if (showVersion) body.version = version.trim() || null;
      body.manufacturerId = manufacturerId || null;
      const res = await apiFetch(patchUrl, { method: "PATCH", body: JSON.stringify(body) });
      if (!res.ok) {
        const d = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(d.error ?? `Error ${res.status}`);
      }
      setSavedOk(true);
      onSaved();
      setTimeout(() => setSavedOk(false), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error");
    } finally {
      setSaving(false);
    }
  };

  const inputCls = "w-full rounded-none border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:border-[var(--accent)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/20 disabled:bg-slate-100 disabled:text-slate-400";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="relative w-full max-w-2xl max-h-[92vh] overflow-y-auto rounded-2xl bg-white shadow-2xl ring-1 ring-slate-200">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="text-[var(--accent)]"><Server className="h-5 w-5" /></span>
            <div className="min-w-0">
              <p className="text-sm font-bold text-slate-800 truncate">{title}</p>
              <p className="text-xs text-slate-400 truncate">
                {entity.name}{entity.subtitle ? ` · ${entity.subtitle}` : ""}
              </p>
            </div>
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 transition-colors"><X className="h-4 w-4" /></button>
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-6">
          {/* Entity data */}
          <div className="space-y-3">
            <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">{t("masters.entity_modal.section_data")}</p>
            {readOnlyFields && (
              <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500">
                <Lock className="h-3.5 w-3.5 flex-shrink-0" />{t("masters.entity_modal.system_note")}
              </div>
            )}
            <div className={`grid grid-cols-1 gap-3 ${showVersion ? "sm:grid-cols-3" : "sm:grid-cols-2"}`}>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-slate-500">{t("masters.field.name")}</span>
                <input value={name} disabled={readOnlyFields}
                  onChange={(e) => { setName(e.target.value); setError(null); }} className={inputCls} />
              </label>
              {showVersion && (
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-slate-500">{t("masters.field.version")}</span>
                  <input value={version} disabled={readOnlyFields}
                    onChange={(e) => { setVersion(e.target.value); setError(null); }} className={inputCls} />
                </label>
              )}
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-slate-500">{t("masters.field.manufacturer")}</span>
                <select value={manufacturerId} disabled={readOnlyFields}
                  onChange={(e) => { setManufacturerId(e.target.value); setError(null); }}
                  className={inputCls}>
                  <option value="">{t("masters.os.manufacturer_label")}</option>
                  {manufacturers.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
              </label>
            </div>
            {error && (
              <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
                <AlertTriangle className="h-4 w-4 flex-shrink-0" />{error}
              </div>
            )}
            {!readOnlyFields && (
              <div className="flex items-center gap-2">
                <button onClick={handleSave} disabled={saving || !dirty}
                  className="flex items-center gap-1.5 rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white hover:bg-[var(--accent)]/90 disabled:opacity-50 transition-colors">
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                  {t("masters.entity_modal.save")}
                </button>
                {savedOk && <span className="text-xs font-medium text-emerald-600">{t("masters.entity_modal.saved")}</span>}
              </div>
            )}
          </div>

          {/* Lifecycle dates */}
          <div className="border-t border-slate-100 pt-5">
            <p className="mb-3 text-[10px] font-bold uppercase tracking-widest text-slate-500">{t("masters.dates_section")}</p>
            <LifecycleDatesEditor entityType={entityType} entityId={entity.id} categoryFilter={categoryFilter} />
          </div>
        </div>

        {/* Footer */}
        <div className="border-t border-slate-200 bg-slate-50 px-6 py-3 flex justify-end">
          <button onClick={onClose} className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 transition-colors">
            {t("masters.entity_modal.close")}
          </button>
        </div>
      </div>
    </div>
  );
}

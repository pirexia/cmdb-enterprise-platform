"use client";

import { useState } from "react";
import { X, Check, Loader2, Server, AlertTriangle } from "lucide-react";
import { apiFetch } from "@/lib/apiFetch";
import { useLanguage } from "@/contexts/LanguageContext";
import { LifecycleDatesEditor } from "@/components/LifecycleDatesEditor";

interface DeviceModel  { id: string; name: string; manufacturer_id: string; manufacturer_name: string; eolDate: string | null; eosDate: string | null }
interface Manufacturer { id: string; name: string }

interface Props {
  model: DeviceModel;
  manufacturers: Manufacturer[];
  onClose: () => void;
  onSaved: () => void;
}

export default function EditDeviceModelModal({ model, manufacturers, onClose, onSaved }: Props) {
  const { t } = useLanguage();
  const [name, setName]                   = useState(model.name);
  const [manufacturerId, setManufacturerId] = useState(model.manufacturer_id);
  const [saving, setSaving]               = useState(false);
  const [error, setError]                 = useState<string | null>(null);
  const [savedOk, setSavedOk]             = useState(false);

  const dirty = name.trim() !== model.name || manufacturerId !== model.manufacturer_id;

  const handleSave = async () => {
    if (!name.trim()) { setError(t("masters.models.modal.name_required")); return; }
    if (!manufacturerId) { setError(t("masters.models.modal.manufacturer_required")); return; }
    setSaving(true); setError(null); setSavedOk(false);
    try {
      const res = await apiFetch(`/api/masters/device-models/${model.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: name.trim(), manufacturerId }),
      });
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
              <p className="text-sm font-bold text-slate-800 truncate">{t("masters.models.modal.title")}</p>
              <p className="text-xs text-slate-400 truncate">{model.name} · {model.manufacturer_name}</p>
            </div>
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 transition-colors"><X className="h-4 w-4" /></button>
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-6">
          {/* Model data */}
          <div className="space-y-3">
            <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">{t("masters.models.modal.section_data")}</p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-slate-500">{t("masters.models.modal.name_label")}</span>
                <input
                  value={name}
                  onChange={(e) => { setName(e.target.value); setError(null); }}
                  placeholder={t("masters.models.placeholder")}
                  className="w-full rounded-none border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:border-[var(--accent)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/20"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-slate-500">{t("masters.models.modal.manufacturer_field")}</span>
                <select
                  value={manufacturerId}
                  onChange={(e) => { setManufacturerId(e.target.value); setError(null); }}
                  className="w-full rounded-none border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-800 focus:border-[var(--accent)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/20"
                >
                  <option value="">{t("masters.models.manufacturer_label")}</option>
                  {manufacturers.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
              </label>
            </div>
            {error && (
              <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
                <AlertTriangle className="h-4 w-4 flex-shrink-0" />{error}
              </div>
            )}
            <div className="flex items-center gap-2">
              <button
                onClick={handleSave}
                disabled={saving || !dirty}
                className="flex items-center gap-1.5 rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white hover:bg-[var(--accent)]/90 disabled:opacity-50 transition-colors"
              >
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                {t("masters.models.modal.save")}
              </button>
              {savedOk && <span className="text-xs font-medium text-emerald-600">{t("masters.models.modal.saved")}</span>}
            </div>
          </div>

          {/* Lifecycle dates */}
          <div className="border-t border-slate-100 pt-5">
            <p className="mb-3 text-[10px] font-bold uppercase tracking-widest text-slate-500">{t("masters.dates_section")}</p>
            <LifecycleDatesEditor entityType="device-models" entityId={model.id} categoryFilter="HARDWARE" />
          </div>
        </div>

        {/* Footer */}
        <div className="border-t border-slate-200 bg-slate-50 px-6 py-3 flex justify-end">
          <button onClick={onClose} className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 transition-colors">
            {t("masters.models.modal.close")}
          </button>
        </div>
      </div>
    </div>
  );
}

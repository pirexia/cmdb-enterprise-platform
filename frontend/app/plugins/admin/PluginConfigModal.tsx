"use client";

import { useEffect, useState } from "react";
import { X, Settings, Save, AlertCircle } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { apiFetch } from "@/lib/apiFetch";

interface Plugin {
  id: string;
  name: string;
  version: string;
  author: string;
  description: string;
  status: string;
  checksum: string;
  installedAt: string | null;
  activatedAt: string | null;
  lastError: string | null;
}

interface Props {
  plugin: Plugin;
  onClose: () => void;
}

export default function PluginConfigModal({ plugin, onClose }: Props) {
  const { t } = useLanguage();

  const [configText, setConfigText] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const res = await apiFetch(`/api/plugins/${plugin.id}/config`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: unknown = await res.json();
        if (!cancelled) {
          setConfigText(JSON.stringify(data, null, 2));
        }
      } catch (e) {
        if (!cancelled) {
          setConfigText("{}");
          setApiError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [plugin.id]);

  const handleTextChange = (val: string) => {
    setConfigText(val);
    setJsonError(null);
    setSaved(false);
  };

  const handleSave = async () => {
    // Validate JSON
    let parsed: unknown;
    try {
      parsed = JSON.parse(configText);
    } catch {
      setJsonError("Invalid JSON — please fix the syntax before saving.");
      return;
    }

    setSaving(true);
    setApiError(null);
    try {
      const res = await apiFetch(`/api/plugins/${plugin.id}/config`, {
        method: "PATCH",
        body: JSON.stringify(parsed),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      setApiError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-slate-900 border border-white/10 rounded-xl shadow-2xl w-full max-w-2xl flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/8 flex-shrink-0">
          <div className="flex items-center gap-2.5">
            <Settings className="h-5 w-5 text-[var(--accent)]" />
            <div>
              <h2 className="text-base font-semibold text-slate-100">{t("pluginConfigTitle")}</h2>
              <p className="text-xs text-slate-500">{plugin.name} · v{plugin.version}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-slate-500 hover:text-slate-300 transition-colors rounded"
            aria-label={t("actions.cancel")}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-3">
          {loading ? (
            <div className="text-sm text-slate-400 py-8 text-center">{t("common.loading_data")}</div>
          ) : (
            <>
              {apiError && (
                <div className="flex items-start gap-2 text-red-400 bg-red-900/20 rounded px-3 py-2 text-xs">
                  <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
                  <span>{apiError}</span>
                </div>
              )}
              <textarea
                value={configText}
                onChange={(e) => handleTextChange(e.target.value)}
                rows={18}
                spellCheck={false}
                className={`w-full bg-slate-800 text-slate-200 text-xs font-mono rounded border px-3 py-2.5 resize-y focus:outline-none focus:border-[var(--accent)] transition-colors ${
                  jsonError ? "border-red-500" : "border-white/10"
                }`}
              />
              {jsonError && (
                <p className="text-xs text-red-400 flex items-center gap-1.5">
                  <AlertCircle className="h-3.5 w-3.5" />
                  {jsonError}
                </p>
              )}
              {saved && (
                <p className="text-xs text-green-400">{t("actions.save")} ✓</p>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-3 px-5 py-4 border-t border-white/8 flex-shrink-0">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-slate-400 hover:text-slate-200 transition-colors"
          >
            {t("actions.cancel")}
          </button>
          <button
            onClick={handleSave}
            disabled={saving || loading}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium bg-[var(--accent)] text-white rounded hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            <Save className="h-4 w-4" />
            {saving ? t("common.saving") : t("pluginConfigSave")}
          </button>
        </div>
      </div>
    </div>
  );
}

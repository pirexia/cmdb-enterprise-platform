"use client";

import { useRef, useState } from "react";
import { X, Upload, FileArchive, AlertCircle, CheckCircle } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { apiFetch } from "@/lib/apiFetch";

interface Props {
  onClose: () => void;
  onSuccess: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function PluginUploadModal({ onClose, onSuccess }: Props) {
  const { t } = useLanguage();
  const inputRef = useRef<HTMLInputElement>(null);

  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] ?? null;
    setFile(f);
    setError(null);
    setSuccess(false);
  };

  const handleUpload = async () => {
    if (!file) return;

    setUploading(true);
    setError(null);

    const formData = new FormData();
    formData.append("plugin", file);

    try {
      const res = await apiFetch("/api/plugins/upload", {
        method: "POST",
        body: formData,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      setSuccess(true);
      setTimeout(() => onSuccess(), 1200);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={(e) => { if (e.target === e.currentTarget && !uploading) onClose(); }}
    >
      <div className="bg-slate-900 border border-white/10 rounded-xl shadow-2xl w-full max-w-md flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/8">
          <div className="flex items-center gap-2.5">
            <Upload className="h-5 w-5 text-[var(--accent)]" />
            <div>
              <h2 className="text-base font-semibold text-slate-100">{t("pluginUploadTitle")}</h2>
              <p className="text-xs text-slate-500">{t("pluginUploadDesc")}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            disabled={uploading}
            className="p-1.5 text-slate-500 hover:text-slate-300 transition-colors rounded disabled:opacity-40"
            aria-label={t("actions.cancel")}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-4">
          {/* Drop zone / file picker */}
          <div
            onClick={() => inputRef.current?.click()}
            className="border-2 border-dashed border-white/15 rounded-lg px-6 py-8 text-center cursor-pointer hover:border-[var(--accent)]/50 hover:bg-white/3 transition-colors"
          >
            <FileArchive className="h-8 w-8 mx-auto mb-2 text-slate-500" />
            {file ? (
              <div className="space-y-0.5">
                <p className="text-sm font-medium text-slate-200">{file.name}</p>
                <p className="text-xs text-slate-500">{formatBytes(file.size)}</p>
              </div>
            ) : (
              <div className="space-y-1">
                <p className="text-sm text-slate-400">Click to select a <span className="text-slate-200 font-medium">.zip</span> file</p>
                <p className="text-xs text-slate-600">{t("pluginUploadDesc")}</p>
              </div>
            )}
            <input
              ref={inputRef}
              type="file"
              accept=".zip"
              onChange={handleFileChange}
              className="hidden"
            />
          </div>

          {/* Error */}
          {error && (
            <div className="flex items-start gap-2 text-red-400 bg-red-900/20 rounded px-3 py-2 text-xs">
              <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {/* Success */}
          {success && (
            <div className="flex items-center gap-2 text-green-400 bg-green-900/20 rounded px-3 py-2 text-xs">
              <CheckCircle className="h-4 w-4" />
              <span>Upload successful — refreshing plugin list…</span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-3 px-5 py-4 border-t border-white/8">
          <button
            onClick={onClose}
            disabled={uploading}
            className="px-4 py-2 text-sm text-slate-400 hover:text-slate-200 transition-colors disabled:opacity-40"
          >
            {t("actions.cancel")}
          </button>
          <button
            onClick={handleUpload}
            disabled={!file || uploading || success}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium bg-[var(--accent)] text-white rounded hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {uploading ? (
              <>
                <span className="h-4 w-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                {t("common.processing")}
              </>
            ) : (
              <>
                <Upload className="h-4 w-4" />
                {t("uploadPlugin")}
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

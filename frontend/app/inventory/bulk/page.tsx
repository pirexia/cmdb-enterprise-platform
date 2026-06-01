"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Layers, ArrowLeft, RefreshCw, AlertTriangle, CheckCircle2,
  Clock, XCircle, ChevronRight, Upload, Download, Loader2, Inbox,
} from "lucide-react";

import { useAuth } from "@/contexts/AuthContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { apiFetch } from "@/lib/apiFetch";

// ─── Types ────────────────────────────────────────────────────────────────────

type BatchStatus =
  | "UPLOADED" | "ANALYZING" | "READY" | "ERROR"
  | "PARTIALLY_COMMITTED" | "COMMITTED" | "DISCARDED" | "REAPED";

interface BatchSummary {
  id: string;
  status: BatchStatus;
  rowCount: number;
  createdAt: string;
  committed: number;
  pending: number;
  errors: number;
}

type FilterMode = "all" | "open" | "done";

const TERMINAL: BatchStatus[] = ["COMMITTED", "DISCARDED", "REAPED"];

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function StatusBadge({ status, t }: { status: BatchStatus; t: (k: string) => string }) {
  const cfg: Record<BatchStatus, { cls: string; icon: React.ReactNode }> = {
    UPLOADED:            { cls: "bg-slate-100 text-slate-600",     icon: <Clock className="h-3 w-3" /> },
    ANALYZING:           { cls: "bg-amber-100 text-amber-700",     icon: <Loader2 className="h-3 w-3 animate-spin" /> },
    READY:               { cls: "bg-blue-100 text-blue-700",        icon: <CheckCircle2 className="h-3 w-3" /> },
    ERROR:               { cls: "bg-red-100 text-red-700",          icon: <XCircle className="h-3 w-3" /> },
    PARTIALLY_COMMITTED: { cls: "bg-orange-100 text-orange-700",   icon: <CheckCircle2 className="h-3 w-3" /> },
    COMMITTED:           { cls: "bg-emerald-100 text-emerald-700", icon: <CheckCircle2 className="h-3 w-3" /> },
    DISCARDED:           { cls: "bg-slate-100 text-slate-500",     icon: <XCircle className="h-3 w-3" /> },
    REAPED:              { cls: "bg-slate-100 text-slate-400",     icon: <Clock className="h-3 w-3" /> },
  };
  const { cls, icon } = cfg[status] ?? cfg.UPLOADED;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${cls}`}>
      {icon}{t(`inventory.bulk.status_${status}`)}
    </span>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function CIBulkPage() {
  const { t } = useLanguage();
  const { isAdmin } = useAuth();
  const router = useRouter();

  // ── Upload state ─────────────────────────────────────────────────────────────
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // ── Batch list state ──────────────────────────────────────────────────────────
  const [batches, setBatches] = useState<BatchSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterMode>("all");

  const loadBatches = useCallback(async () => {
    setLoading(true); setListError(null);
    try {
      const res = await apiFetch("/api/cis/bulk/batches");
      if (!res.ok) throw new Error(`Error ${res.status}`);
      const data = await res.json() as { batches?: BatchSummary[] };
      setBatches(data.batches ?? []);
    } catch (e) {
      setListError(e instanceof Error ? e.message : t("common.unknown_error"));
    } finally { setLoading(false); }
  }, [t]);

  useEffect(() => { void loadBatches(); }, [loadBatches]);

  const hasActive = batches.some((b) => b.status === "ANALYZING" || b.status === "UPLOADED");
  useEffect(() => {
    if (!hasActive) return;
    const id = setInterval(() => { void loadBatches(); }, 10_000);
    return () => clearInterval(id);
  }, [hasActive, loadBatches]);

  // ── File selection ────────────────────────────────────────────────────────────
  const pickFile = (f: File | null) => {
    if (!f) return;
    if (!f.name.endsWith(".xlsx")) { setUploadError("Solo se permiten ficheros .xlsx"); return; }
    if (f.size > 10 * 1024 * 1024) { setUploadError(t("inventory.bulk.dropzone_hint")); return; }
    setFile(f); setUploadError(null);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault(); setDragging(false);
    pickFile(e.dataTransfer.files[0] ?? null);
  };

  // ── Upload ────────────────────────────────────────────────────────────────────
  const handleUpload = async () => {
    if (!file) return;
    setUploading(true); setUploadError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await apiFetch("/api/cis/bulk/batches", { method: "POST", body: fd });
      const data = await res.json().catch(() => ({})) as { batchId?: string; error?: string };
      if (!res.ok) throw new Error(data.error ?? `Error ${res.status}`);
      if (data.batchId) router.push(`/inventory/bulk/${data.batchId}`);
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : t("common.unknown_error"));
      setUploading(false);
    }
  };

  // ── Template download ─────────────────────────────────────────────────────────
  const downloadTemplate = async () => {
    try {
      const res = await apiFetch("/api/cis/bulk/template.xlsx");
      if (!res.ok) return;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = "plantilla-cis.xlsx";
      document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    } catch { /* silent */ }
  };

  const filtered = batches.filter((b) => {
    if (filter === "open") return !TERMINAL.includes(b.status);
    if (filter === "done") return TERMINAL.includes(b.status);
    return true;
  });

  if (!isAdmin) {
    return <div className="flex h-screen items-center justify-center text-slate-400">{t("common.unknown_error")}</div>;
  }

  return (
    <div className="flex flex-col h-screen bg-slate-50 overflow-hidden">
      {/* Header */}
      <header className="sticky top-0 z-10 flex-shrink-0 border-b border-slate-200 bg-white px-8 py-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Layers className="h-6 w-6 text-[var(--accent)]" />
            <div>
              <h1 className="text-xl font-bold text-slate-900">{t("inventory.bulk.title")}</h1>
              <p className="text-sm text-slate-500 mt-0.5">{t("inventory.bulk.subtitle")}</p>
            </div>
          </div>
          <button onClick={() => router.push("/inventory")}
            className="flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50 transition-colors">
            <ArrowLeft className="h-3.5 w-3.5" />{t("actions.back") ?? "Volver"}
          </button>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto px-8 py-6 space-y-8">

        {/* Upload card */}
        <div className="bg-white rounded-xl shadow-sm ring-1 ring-slate-200 p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-base font-semibold text-slate-800">{t("inventory.bulk.start_upload")}</h2>
            <button onClick={downloadTemplate}
              className="flex items-center gap-1.5 text-xs text-[var(--accent)] hover:underline">
              <Download className="h-3.5 w-3.5" />{t("inventory.bulk.download_template")}
            </button>
          </div>

          {/* Drop zone */}
          <div
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
            onClick={() => inputRef.current?.click()}
            className={`cursor-pointer rounded-lg border-2 border-dashed p-10 text-center transition-colors
              ${dragging ? "border-[var(--accent)] bg-[var(--accent)]/5" : "border-slate-300 hover:border-[var(--accent)]/60 bg-slate-50"}`}
          >
            <input
              ref={inputRef} type="file" accept=".xlsx" className="hidden"
              onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
            />
            <Upload className="mx-auto h-8 w-8 text-slate-400 mb-2" />
            {file ? (
              <p className="text-sm font-medium text-slate-700">{file.name} <span className="text-slate-400">({(file.size / 1024).toFixed(0)} KB)</span></p>
            ) : (
              <>
                <p className="text-sm font-medium text-slate-600">{t("inventory.bulk.dropzone")}</p>
                <p className="text-xs text-slate-400 mt-1">{t("inventory.bulk.dropzone_hint")}</p>
              </>
            )}
          </div>

          {uploadError && (
            <div className="mt-3 flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-600">
              <AlertTriangle className="h-4 w-4 flex-shrink-0" />{uploadError}
            </div>
          )}

          <div className="mt-4 flex justify-end">
            <button
              onClick={handleUpload} disabled={!file || uploading}
              className="flex items-center gap-2 rounded-none bg-[var(--accent)] px-5 py-2.5 text-sm font-semibold text-white hover:bg-[var(--accent)]/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
            >
              {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              {uploading ? t("inventory.bulk.uploading") : t("inventory.bulk.start_upload")}
            </button>
          </div>
        </div>

        {/* Batch list */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-base font-semibold text-slate-800">{t("inventory.bulk.batches_title")}</h2>
            <div className="flex items-center gap-2">
              <div className="flex rounded-lg border border-slate-200 overflow-hidden">
                {(["all", "open", "done"] as FilterMode[]).map((f) => (
                  <button key={f} onClick={() => setFilter(f)}
                    className={`px-3 py-1.5 text-xs font-medium transition-colors
                      ${filter === f ? "bg-[var(--accent)] text-white" : "bg-white text-slate-600 hover:bg-slate-50"}`}>
                    {t(`inventory.bulk.filter_${f}`)}
                  </button>
                ))}
              </div>
              <button onClick={() => void loadBatches()} disabled={loading}
                className="flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 transition-colors disabled:opacity-50">
                <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
                {t("inventory.bulk.batches_refresh")}
              </button>
            </div>
          </div>

          {listError && (
            <div className="mb-3 flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
              <AlertTriangle className="h-4 w-4 flex-shrink-0" />{listError}
            </div>
          )}

          {loading && batches.length === 0 ? (
            <div className="flex items-center justify-center py-12 text-slate-400">
              <RefreshCw className="h-5 w-5 animate-spin mr-2" />
              <span className="text-sm">{t("common.loading_data")}</span>
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-slate-400">
              <Inbox className="h-10 w-10 mb-3 opacity-30" />
              <p className="text-sm">{t("inventory.bulk.batches_empty")}</p>
            </div>
          ) : (
            <div className="bg-white shadow-sm ring-1 ring-slate-200 overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-100 bg-slate-50">
                    <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">{t("inventory.bulk.col_date")}</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">{t("inventory.bulk.col_status")}</th>
                    <th className="px-4 py-3 text-center text-xs font-semibold text-slate-500 uppercase tracking-wider">{t("inventory.bulk.col_rows")}</th>
                    <th className="px-4 py-3 text-center text-xs font-semibold text-slate-500 uppercase tracking-wider">{t("inventory.bulk.col_committed")}</th>
                    <th className="px-4 py-3 text-center text-xs font-semibold text-slate-500 uppercase tracking-wider">{t("inventory.bulk.col_pending")}</th>
                    <th className="px-4 py-3 text-center text-xs font-semibold text-slate-500 uppercase tracking-wider">{t("inventory.bulk.col_errors")}</th>
                    <th className="px-4 py-3"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {filtered.map((b) => {
                    const isTerminal = TERMINAL.includes(b.status);
                    return (
                      <tr key={b.id}
                        onClick={() => !isTerminal && router.push(`/inventory/bulk/${b.id}`)}
                        className={`transition-colors ${isTerminal ? "opacity-60 cursor-default" : "cursor-pointer hover:bg-[var(--accent)]/5"}`}>
                        <td className="px-4 py-3 text-sm text-slate-600 whitespace-nowrap">{formatDate(b.createdAt)}</td>
                        <td className="px-4 py-3"><StatusBadge status={b.status} t={t} /></td>
                        <td className="px-4 py-3 text-center text-sm text-slate-600">{b.rowCount}</td>
                        <td className="px-4 py-3 text-center">
                          {b.committed > 0 && <span className="inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-700">{b.committed}</span>}
                        </td>
                        <td className="px-4 py-3 text-center">
                          {b.pending > 0 && <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700">{b.pending}</span>}
                        </td>
                        <td className="px-4 py-3 text-center">
                          {b.errors > 0 && <span className="inline-flex items-center rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-700">{b.errors}</span>}
                        </td>
                        <td className="px-4 py-3 text-right">
                          {!isTerminal && (
                            <button
                              onClick={(e) => { e.stopPropagation(); router.push(`/inventory/bulk/${b.id}`); }}
                              className="inline-flex items-center gap-1 rounded-none bg-[var(--accent)] px-3 py-1 text-xs font-semibold text-white hover:bg-[var(--accent)]/90 transition-colors">
                              {t("inventory.bulk.open_batch")} <ChevronRight className="h-3 w-3" />
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

      </main>
    </div>
  );
}

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Upload, RefreshCw, AlertTriangle, CheckCircle, X, FileJson,
  ChevronLeft, ChevronRight, Trash2, Loader2,
} from "lucide-react";
import { apiFetch } from "@/lib/apiFetch";
import { useAuth } from "@/contexts/AuthContext";
import { useLanguage } from "@/contexts/LanguageContext";
import type {
  VulnImportBatch,
  VulnImportBatchStatus,
  VulnImportClassification,
  ListBatchesResponse,
  UploadRequestBody,
  UploadResponse,
  VulnImportErrorResponse,
} from "@/lib/types/vulnImport";

// ─── Style maps ───────────────────────────────────────────────────────────────

const STATUS_PILL: Record<VulnImportBatchStatus, string> = {
  PENDING:   "bg-blue-100 text-blue-700",
  ACCEPTED:  "bg-emerald-100 text-emerald-700",
  DISCARDED: "bg-slate-100 text-slate-500",
};

const CLASSIFICATION_ORDER: VulnImportClassification[] = ["NUEVA", "EXISTENTE_PENDIENTE", "REAPARECIDA"];
const CLASSIFICATION_DOT: Record<VulnImportClassification, string> = {
  NUEVA:               "bg-red-400",
  EXISTENTE_PENDIENTE: "bg-amber-400",
  REAPARECIDA:         "bg-purple-400",
};

const STATUS_FILTERS: (VulnImportBatchStatus | "ALL")[] = ["ALL", "PENDING", "ACCEPTED", "DISCARDED"];

const PAGE_SIZE = 20;

// ─── Toast notification (same pattern as /vulnerabilities) ───────────────────

interface Toast {
  id:      number;
  type:    "error" | "success";
  message: string;
}

let _toastId = 0;

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function VulnImportListPage() {
  const { t } = useLanguage();
  const { canManageSecurity } = useAuth();
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);

  const [batches, setBatches]   = useState<VulnImportBatch[]>([]);
  const [total, setTotal]       = useState(0);
  const [page, setPage]         = useState(1);
  const [statusFilter, setStatusFilter] = useState<VulnImportBatchStatus | "ALL">("ALL");
  const [loading, setLoading]   = useState(true);
  const [uploading, setUploading] = useState(false);
  const [discarding, setDiscarding] = useState<string | null>(null);
  const [toasts, setToasts]     = useState<Toast[]>([]);

  const addToast = useCallback((type: Toast["type"], message: string) => {
    const id = ++_toastId;
    setToasts((prev) => [...prev, { id, type, message }]);
    setTimeout(() => setToasts((prev) => prev.filter((tt) => tt.id !== id)), 5000);
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((tt) => tt.id !== id));
  }, []);

  const fetchBatches = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (statusFilter !== "ALL") params.set("status", statusFilter);
      params.set("page", String(page));
      params.set("pageSize", String(PAGE_SIZE));
      const res = await apiFetch(`/api/vuln-import/batches?${params.toString()}`);
      if (!res.ok) throw new Error(`Error ${res.status}`);
      const data = (await res.json()) as ListBatchesResponse;
      setBatches(data.batches);
      setTotal(data.total);
    } catch (err) {
      addToast("error", err instanceof Error ? err.message : t("common.unknown_error"));
    } finally {
      setLoading(false);
    }
  }, [statusFilter, page, addToast, t]);

  useEffect(() => { fetchBatches(); }, [fetchBatches]);

  // Reset to page 1 whenever the status filter changes.
  useEffect(() => { setPage(1); }, [statusFilter]);

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (ev) => {
      const text = (ev.target?.result as string) ?? "";
      let report: unknown;
      try {
        report = JSON.parse(text);
      } catch {
        addToast("error", t("vulnImport.list.invalidJson"));
        return;
      }

      setUploading(true);
      try {
        const body: UploadRequestBody = { filename: file.name, report };
        const res = await apiFetch("/api/vuln-import/upload", {
          method: "POST",
          body: JSON.stringify(body),
        });

        if (!res.ok) {
          const errData = (await res.json().catch(() => null)) as VulnImportErrorResponse | null;
          throw new Error(errData?.error ?? `Error ${res.status}`);
        }

        const data = (await res.json()) as UploadResponse;
        addToast("success", t("vulnImport.list.uploadSuccess", { count: data.summary.totalEntries }));
        router.push(`/vulnerabilities/imports/${data.batchId}`);
      } catch (err) {
        addToast("error", err instanceof Error ? err.message : t("common.unknown_error"));
      } finally {
        setUploading(false);
      }
    };
    reader.readAsText(file);
  };

  const handleDiscard = async (batch: VulnImportBatch) => {
    if (!confirm(t("vulnImport.list.discardConfirm"))) return;
    setDiscarding(batch.id);
    try {
      const res = await apiFetch(`/api/vuln-import/batches/${batch.id}/discard`, { method: "POST" });
      if (!res.ok) {
        const errData = (await res.json().catch(() => null)) as VulnImportErrorResponse | null;
        throw new Error(errData?.error ?? `Error ${res.status}`);
      }
      addToast("success", t("vulnImport.list.discardSuccess"));
      fetchBatches();
    } catch (err) {
      addToast("error", err instanceof Error ? err.message : t("common.unknown_error"));
    } finally {
      setDiscarding(null);
    }
  };

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const formatDate = (iso: string | null) =>
    iso ? new Date(iso).toLocaleDateString() : "—";

  const formatDateTime = (iso: string) => new Date(iso).toLocaleString();

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Toast notifications */}
      {toasts.length > 0 && (
        <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-2 w-80" role="region" aria-label={t("vulnerabilities.notifications_region")}>
          {toasts.map((toast) => (
            <div
              key={toast.id}
              className={`flex items-start gap-3 rounded-xl px-4 py-3 shadow-lg ring-1 transition-all ${
                toast.type === "error"
                  ? "bg-red-50 ring-red-200 text-red-800"
                  : "bg-emerald-50 ring-emerald-200 text-emerald-800"
              }`}
              role="alert"
            >
              {toast.type === "error"
                ? <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5 text-red-500" />
                : <CheckCircle  className="h-4 w-4 flex-shrink-0 mt-0.5 text-emerald-500" />
              }
              <p className="text-xs font-medium flex-1">{toast.message}</p>
              <button
                onClick={() => dismissToast(toast.id)}
                className="flex-shrink-0 rounded p-0.5 hover:bg-black/10 transition-colors"
                aria-label={t("vulnerabilities.close_notification")}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Header */}
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white px-8 py-5">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-slate-900">{t("vulnImport.title")}</h1>
            <p className="text-sm text-slate-500 mt-0.5">{t("vulnImport.subtitle")}</p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={fetchBatches}
              className="flex items-center gap-2 rounded-none border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50 transition-colors"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            </button>
            {canManageSecurity && (
              <>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".json,application/json"
                  className="hidden"
                  onChange={handleFile}
                />
                <button
                  onClick={() => fileRef.current?.click()}
                  disabled={uploading}
                  className="flex items-center gap-2 rounded-none bg-[var(--accent)] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[var(--accent)]/90 disabled:opacity-60 disabled:cursor-not-allowed transition-colors shadow-sm"
                >
                  {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                  {t("vulnImport.actions.upload")}
                </button>
              </>
            )}
          </div>
        </div>
      </header>

      <div className="px-8 py-8 space-y-6 w-full">
        {/* Status filter tabs */}
        <div className="flex gap-1">
          {STATUS_FILTERS.map((s) => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`px-4 py-2 text-xs font-semibold uppercase tracking-wide transition-colors ${
                statusFilter === s
                  ? "bg-[var(--accent)] text-white"
                  : "bg-white text-slate-500 ring-1 ring-slate-200 hover:bg-slate-50"
              }`}
            >
              {s === "ALL" ? t("vulnImport.list.filterAll") : t(`vulnImport.batch.status.${s}`)}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="flex items-center gap-2 text-slate-400 py-16 justify-center">
            <RefreshCw className="h-4 w-4 animate-spin" />
            <span className="text-sm">{t("common.loading_data")}</span>
          </div>
        ) : batches.length === 0 ? (
          <div className="text-center py-16 text-slate-500">
            <FileJson className="h-10 w-10 mx-auto mb-3 opacity-30" />
            <p className="text-sm">{t("vulnImport.list.noBatches")}</p>
          </div>
        ) : (
          <div className="bg-white shadow-sm ring-1 ring-slate-200 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">{t("vulnImport.list.colFilename")}</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">{t("vulnImport.list.colScanDate")}</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">{t("vulnImport.list.colStatus")}</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">{t("vulnImport.list.colEntries")}</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">{t("vulnImport.list.colClassification")}</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">{t("vulnImport.list.colUploadedBy")}</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">{t("vulnImport.list.colUploadedAt")}</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody>
                  {batches.map((b) => (
                    <tr
                      key={b.id}
                      onClick={() => router.push(`/vulnerabilities/imports/${b.id}`)}
                      className="border-b border-slate-100 hover:bg-[var(--accent)]/5 transition-colors cursor-pointer"
                    >
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-slate-800">{b.filename}</span>
                          <span className="inline-block px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide rounded-full bg-slate-100 text-slate-500 flex-shrink-0">
                            {t(`vulnImport.batch.source.${b.source}`)}
                          </span>
                        </div>
                        {b.taskName && <div className="text-xs text-slate-400">{b.taskName}</div>}
                      </td>
                      <td className="px-4 py-3 text-slate-500 text-xs">
                        {formatDate(b.scanStart)} {b.scanEnd ? `– ${formatDate(b.scanEnd)}` : ""}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-block px-2 py-0.5 text-xs font-semibold rounded-full ${STATUS_PILL[b.status]}`}>
                          {t(`vulnImport.batch.status.${b.status}`)}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-slate-600">{b.entryCount ?? "—"}</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          {CLASSIFICATION_ORDER.map((c) => {
                            const n = b.byClassification?.[c];
                            if (!n) return null;
                            return (
                              <span key={c} className="flex items-center gap-1 text-xs text-slate-500" title={t(`vulnImport.classification.${c}`)}>
                                <span className={`inline-block h-2 w-2 rounded-full flex-shrink-0 ${CLASSIFICATION_DOT[c]}`} />
                                {n}
                              </span>
                            );
                          })}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-slate-500 text-xs">{b.uploadedBy}</td>
                      <td className="px-4 py-3 text-slate-500 text-xs">{formatDateTime(b.createdAt)}</td>
                      <td className="px-4 py-3">
                        <div className="flex gap-2 justify-end" onClick={(e) => e.stopPropagation()}>
                          <button
                            onClick={() => router.push(`/vulnerabilities/imports/${b.id}`)}
                            className="flex items-center gap-1 px-3 py-1.5 text-xs bg-slate-100 text-slate-600 rounded-none hover:bg-slate-200 transition-colors"
                          >
                            {t("vulnImport.actions.review")} <ChevronRight className="h-3.5 w-3.5" />
                          </button>
                          {canManageSecurity && b.status === "PENDING" && (
                            <button
                              onClick={() => handleDiscard(b)}
                              disabled={discarding === b.id}
                              className="p-1.5 text-red-500 hover:bg-red-50 rounded-none transition-colors disabled:opacity-50"
                              title={t("vulnImport.actions.discard")}
                            >
                              {discarding === b.id
                                ? <Loader2 className="h-4 w-4 animate-spin" />
                                : <Trash2 className="h-4 w-4" />}
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="flex items-center justify-between border-t border-slate-100 px-4 py-3">
                <span className="text-xs text-slate-500">
                  {t("vulnImport.list.pageInfo", { page, totalPages, total })}
                </span>
                <div className="flex gap-2">
                  <button
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={page <= 1}
                    className="flex items-center gap-1 rounded-none border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    <ChevronLeft className="h-3.5 w-3.5" /> {t("vulnImport.list.prevPage")}
                  </button>
                  <button
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                    disabled={page >= totalPages}
                    className="flex items-center gap-1 rounded-none border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    {t("vulnImport.list.nextPage")} <ChevronRight className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

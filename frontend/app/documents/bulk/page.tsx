"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Layers, ArrowLeft, RefreshCw, AlertTriangle, CheckCircle2,
  Clock, XCircle, ChevronRight, FileText, Loader2, Inbox,
} from "lucide-react";

import { useAuth } from "@/contexts/AuthContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { apiFetch } from "@/lib/apiFetch";

// ─── Types ────────────────────────────────────────────────────────────────────

type BatchStatus =
  | "UPLOADED" | "ANALYZING" | "READY" | "READY_WITH_WARNINGS" | "ERROR"
  | "PARTIALLY_COMMITTED" | "COMMITTED" | "DISCARDED" | "REAPED";

interface BatchSummary {
  id: string;
  status: BatchStatus;
  fileCount: number;
  totalBytes: number;
  createdAt: string;
  committed: number;
  pending: number;
  errors: number;
  warnings: number;
}

type FilterMode = "all" | "open" | "done";

const TERMINAL: BatchStatus[] = ["COMMITTED", "DISCARDED", "REAPED"];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

// ─── Status badge ─────────────────────────────────────────────────────────────

function StatusBadge({ status, t }: { status: BatchStatus; t: (k: string) => string }) {
  const key = `documents.bulk.status_${status}`;
  const label = t(key);

  const cfg: Record<BatchStatus, { cls: string; icon: React.ReactNode }> = {
    UPLOADED:             { cls: "bg-slate-100 text-slate-600",      icon: <Clock className="h-3 w-3" /> },
    ANALYZING:            { cls: "bg-amber-100 text-amber-700",      icon: <Loader2 className="h-3 w-3 animate-spin" /> },
    READY:                { cls: "bg-blue-100 text-blue-700",         icon: <FileText className="h-3 w-3" /> },
    READY_WITH_WARNINGS:  { cls: "bg-yellow-100 text-yellow-800",    icon: <AlertTriangle className="h-3 w-3" /> },
    ERROR:                { cls: "bg-red-100 text-red-700",           icon: <XCircle className="h-3 w-3" /> },
    PARTIALLY_COMMITTED:  { cls: "bg-orange-100 text-orange-700",    icon: <CheckCircle2 className="h-3 w-3" /> },
    COMMITTED:            { cls: "bg-emerald-100 text-emerald-700",  icon: <CheckCircle2 className="h-3 w-3" /> },
    DISCARDED:            { cls: "bg-slate-100 text-slate-500",      icon: <XCircle className="h-3 w-3" /> },
    REAPED:               { cls: "bg-slate-100 text-slate-400",      icon: <Clock className="h-3 w-3" /> },
  };

  const { cls, icon } = cfg[status] ?? cfg.UPLOADED;

  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${cls}`}>
      {icon}{label}
    </span>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function BulkBatchesListPage() {
  const { t } = useLanguage();
  const { isAdmin } = useAuth();
  const router = useRouter();

  const [batches, setBatches] = useState<BatchSummary[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterMode>("all");

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await apiFetch("/api/documents/bulk/batches");
      if (!res.ok) throw new Error(`Error ${res.status}`);
      const data = await res.json() as { total?: number; truncated?: boolean; batches?: BatchSummary[] } | BatchSummary[];
      // Support both old array shape and new { total, truncated, batches } shape
      if (Array.isArray(data)) {
        setBatches(data); setTotalCount(data.length); setTruncated(false);
      } else {
        setBatches(data.batches ?? []); setTotalCount(data.total ?? 0); setTruncated(data.truncated ?? false);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : t("common.unknown_error"));
    } finally { setLoading(false); }
  }, [t]);

  useEffect(() => { void load(); }, [load]);

  // Auto-refresh every 10s while any batch is still analyzing.
  const hasActive = batches.some((b) => b.status === "ANALYZING" || b.status === "UPLOADED");
  useEffect(() => {
    if (!hasActive) return;
    const id = setInterval(() => { void load(); }, 10_000);
    return () => clearInterval(id);
  }, [hasActive, load]);

  const filtered = batches.filter((b) => {
    if (filter === "open")  return !TERMINAL.includes(b.status);
    if (filter === "done")  return TERMINAL.includes(b.status);
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
              <h1 className="text-xl font-bold text-slate-900">{t("documents.bulk.batches_title")}</h1>
              <p className="text-sm text-slate-500 mt-0.5">{t("documents.bulk.batches_subtitle")}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {/* Filter tabs */}
            <div className="flex rounded-lg border border-slate-200 overflow-hidden">
              {(["all", "open", "done"] as FilterMode[]).map((f) => (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  className={`px-3 py-1.5 text-xs font-medium transition-colors
                    ${filter === f
                      ? "bg-[var(--accent)] text-white"
                      : "bg-white text-slate-600 hover:bg-slate-50"}`}
                >
                  {t(`documents.bulk.filter_${f}`)}
                </button>
              ))}
            </div>
            <button onClick={() => void load()} disabled={loading}
              className="flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50 transition-colors disabled:opacity-50">
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
              {t("documents.bulk.batches_refresh")}
            </button>
            <button onClick={() => router.push("/documents")}
              className="flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50 transition-colors">
              <ArrowLeft className="h-3.5 w-3.5" />
              {t("actions.back") ?? "Volver"}
            </button>
          </div>
        </div>
      </header>

      {/* Content */}
      <main className="flex-1 overflow-y-auto px-8 py-6">
        {error && (
          <div className="mb-4 flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
            <AlertTriangle className="h-4 w-4 flex-shrink-0" />{error}
          </div>
        )}

        {loading && batches.length === 0 ? (
          <div className="flex items-center justify-center py-16 text-slate-400">
            <RefreshCw className="h-5 w-5 animate-spin mr-2" />
            <span className="text-sm">{t("common.loading_data")}</span>
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-slate-400">
            <Inbox className="h-12 w-12 mb-3 opacity-30" />
            <p className="text-sm">{t("documents.bulk.batches_empty")}</p>
          </div>
        ) : (
          <>
          {truncated && (
            <div className="mb-3 flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-700">
              <AlertTriangle className="h-4 w-4 flex-shrink-0" />
              Mostrando los 100 lotes más recientes de {totalCount} en total. Los más antiguos no aparecen en esta lista.
            </div>
          )}
          <div className="bg-white shadow-sm ring-1 ring-slate-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50">
                  <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">{t("documents.bulk.col_date")}</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">{t("documents.bulk.col_status")}</th>
                  <th className="px-4 py-3 text-center text-xs font-semibold text-slate-500 uppercase tracking-wider">{t("documents.bulk.col_files")}</th>
                  <th className="px-4 py-3 text-center text-xs font-semibold text-slate-500 uppercase tracking-wider">{t("documents.bulk.col_committed")}</th>
                  <th className="px-4 py-3 text-center text-xs font-semibold text-slate-500 uppercase tracking-wider">{t("documents.bulk.col_pending")}</th>
                  <th className="px-4 py-3 text-center text-xs font-semibold text-slate-500 uppercase tracking-wider">{t("documents.bulk.col_warnings")}</th>
                  <th className="px-4 py-3 text-center text-xs font-semibold text-slate-500 uppercase tracking-wider">{t("documents.bulk.col_errors")}</th>
                  <th className="px-4 py-3 text-right text-xs font-semibold text-slate-500 uppercase tracking-wider">{t("documents.bulk.col_size")}</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {filtered.map((b) => {
                  const isTerminal = TERMINAL.includes(b.status);
                  return (
                    <tr
                      key={b.id}
                      onClick={() => !isTerminal && router.push(`/documents/bulk/${b.id}`)}
                      className={`transition-colors ${isTerminal ? "opacity-60 cursor-default" : "cursor-pointer hover:bg-[var(--accent)]/5"}`}
                    >
                      <td className="px-4 py-3 text-sm text-slate-600 whitespace-nowrap">{formatDate(b.createdAt)}</td>
                      <td className="px-4 py-3"><StatusBadge status={b.status} t={t} /></td>
                      <td className="px-4 py-3 text-center text-sm text-slate-600">{b.fileCount}</td>
                      <td className="px-4 py-3 text-center">
                        {b.committed > 0 && (
                          <span className="inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-700">{b.committed}</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-center">
                        {b.pending > 0 && (
                          <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700">{b.pending}</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-center">
                        {b.warnings > 0 && (
                          <span className="inline-flex items-center rounded-full bg-yellow-100 px-2 py-0.5 text-xs font-semibold text-yellow-800">{b.warnings}</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-center">
                        {b.errors > 0 && (
                          <span className="inline-flex items-center rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-700">{b.errors}</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right text-xs text-slate-400 whitespace-nowrap">{formatFileSize(b.totalBytes)}</td>
                      <td className="px-4 py-3 text-right">
                        {!isTerminal && (
                          <button
                            onClick={(e) => { e.stopPropagation(); router.push(`/documents/bulk/${b.id}`); }}
                            className="inline-flex items-center gap-1 rounded-none bg-[var(--accent)] px-3 py-1 text-xs font-semibold text-white hover:bg-[var(--accent)]/90 transition-colors"
                          >
                            {t("documents.bulk.open_batch")} <ChevronRight className="h-3 w-3" />
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          </>
        )}
      </main>
    </div>
  );
}

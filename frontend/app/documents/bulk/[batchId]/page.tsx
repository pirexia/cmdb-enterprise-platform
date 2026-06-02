"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  Layers, ArrowLeft, RefreshCw, AlertTriangle, FileText, Trash2,
  CheckCircle2, Sparkles, Plus, X, Loader2,
} from "lucide-react";

import { useAuth } from "@/contexts/AuthContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { apiFetch } from "@/lib/apiFetch";

// ─── Types ────────────────────────────────────────────────────────────────────

type Target = "contract" | "addendum" | "license" | "none";

interface CiMatch { ciId: string; name: string; serial: string | null; matchType: "serial" | "name"; }

interface ItemAnalysis {
  documentTypeGuess?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  vendorName?: string | null;
  entityNumber?: string | null;
  suggestedTarget?: Target | null;
  ciHints?: string[];
  ciMatches?: CiMatch[];
  textExtracted?: boolean;
}

interface BatchItem {
  id: string;
  originalName: string;
  mimeType: string;
  fileSize: number;
  status: "PENDING_ANALYSIS" | "ANALYZING" | "ANALYZED" | "WARNING" | "ERROR" | "COMMITTED" | "DISCARDED";
  analysis: ItemAnalysis | null;
  errorMessage: string | null;
  committedDocumentId: string | null;
}

interface BatchData {
  id: string;
  status: string;
  fileCount: number;
  items: BatchItem[];
}

interface DocType { id: string; code: string; name: string; }
interface Vendor { id: string; name: string; }
interface ContractOpt { id: string; contractNumber: string; }
interface CIOpt { id: string; name: string; apiSlug: string; }

interface Decision {
  target: Target;
  documentTypeId: string;
  title: string;
  description: string;
  startDate: string;
  endDate: string;
  vendorId: string;
  entityNumber: string;
  parentContractId: string;
  licenseName: string;
  ciIds: string[];
}

interface RowState { committing?: boolean; error?: string | null; done?: boolean; documentId?: string; }

// ─── Helpers ──────────────────────────────────────────────────────────────────

const stripExt = (n: string) => n.replace(/\.[^.]+$/, "");

function guessDocTypeId(guess: string | null | undefined, docTypes: DocType[]): string {
  if (!guess) return "";
  const g = guess.toLowerCase();
  const map: Record<string, string[]> = {
    contrato: ["contract", "contrat"],
    adenda: ["addend", "adenda", "amend"],
    oferta: ["offer", "oferta", "quote", "propuesta"],
    tecnico: ["technical", "tecnic", "técnic"],
    factura: ["invoice", "factura"],
  };
  const needles = map[g] ?? [g];
  const hit = docTypes.find((dt) =>
    needles.some((n) => dt.name.toLowerCase().includes(n) || dt.code.toLowerCase().includes(n)),
  );
  return hit?.id ?? "";
}

function guessVendorId(name: string | null | undefined, vendors: Vendor[]): string {
  if (!name) return "";
  const n = name.trim().toLowerCase();
  return vendors.find((v) => v.name.toLowerCase() === n)?.id
    ?? vendors.find((v) => v.name.toLowerCase().includes(n) || n.includes(v.name.toLowerCase()))?.id
    ?? "";
}

function seedDecision(item: BatchItem, docTypes: DocType[], vendors: Vendor[]): Decision {
  const a = item.analysis ?? {};
  const title = stripExt(item.originalName);
  return {
    target: (a.suggestedTarget as Target) ?? "none",
    documentTypeId: guessDocTypeId(a.documentTypeGuess, docTypes),
    title,
    description: "",
    startDate: a.startDate ?? "",
    endDate: a.endDate ?? "",
    vendorId: guessVendorId(a.vendorName, vendors),
    entityNumber: a.entityNumber ?? "",
    parentContractId: "",
    licenseName: title,
    ciIds: (a.ciMatches ?? []).map((m) => m.ciId),
  };
}

function toCommitBody(d: Decision) {
  return {
    target: d.target,
    documentTypeId: d.documentTypeId,
    title: d.title.trim(),
    description: d.description.trim() || null,
    startDate: d.startDate || null,
    endDate: d.endDate || null,
    vendorId: d.vendorId || null,
    entityNumber: d.entityNumber.trim() || null,
    parentContractId: d.parentContractId || null,
    licenseName: d.licenseName.trim() || null,
    ciIds: d.ciIds,
  };
}

const inputCls =
  "w-full rounded-none border border-slate-300 bg-slate-50 px-2.5 py-1.5 text-sm text-slate-800 focus:border-[var(--accent)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/20";

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function BulkReviewPage() {
  const { t } = useLanguage();
  const { isAdmin } = useAuth();
  const router = useRouter();
  const params = useParams();
  const batchId = String(params.batchId);

  const [batch, setBatch] = useState<BatchData | null>(null);
  const [docTypes, setDocTypes] = useState<DocType[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [contracts, setContracts] = useState<ContractOpt[]>([]);
  const [cis, setCIs] = useState<CIOpt[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const seededRef = useRef<Set<string>>(new Set());

  // ── Load reference data once ────────────────────────────────────────────────
  const loadRefs = useCallback(async () => {
    try {
      const [dt, vn, ct, ci] = await Promise.all([
        apiFetch("/api/masters/document-types"),
        apiFetch("/api/vendors"),
        apiFetch("/api/contracts"),
        apiFetch("/api/cis"),
      ]);
      setDocTypes(await dt.json().catch(() => []));
      setVendors(await vn.json().catch(() => []));
      setContracts(await ct.json().catch(() => []));
      const ciData = await ci.json().catch(() => ({}));
      setCIs((ciData as { data?: CIOpt[] }).data ?? []);
    } catch { /* non-blocking */ }
  }, []);

  // ── Load / poll the batch ────────────────────────────────────────────────────
  const loadBatch = useCallback(async () => {
    try {
      const res = await apiFetch(`/api/documents/bulk/batches/${batchId}`);
      if (!res.ok) {
        const d = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(d.error ?? `Error ${res.status}`);
      }
      const data = await res.json() as BatchData;
      setBatch(data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("common.unknown_error"));
    } finally {
      setLoading(false);
    }
  }, [batchId, t]);

  useEffect(() => { void loadRefs(); }, [loadRefs]);
  useEffect(() => { void loadBatch(); }, [loadBatch]);

  // Poll every 4s while any item is still pending/analyzing.
  const hasPending = useMemo(
    () => (batch?.items ?? []).some((i) => i.status === "PENDING_ANALYSIS" || i.status === "ANALYZING"),
    [batch],
  );
  useEffect(() => {
    if (!hasPending) return;
    const id = setInterval(() => { void loadBatch(); }, 4000);
    return () => clearInterval(id);
  }, [hasPending, loadBatch]);

  // Seed editable decisions once per item, when analysis first arrives.
  useEffect(() => {
    if (!batch || docTypes.length === 0) return;
    const next: Record<string, Decision> = {};
    let changed = false;
    for (const item of batch.items) {
      if (seededRef.current.has(item.id)) continue;
      if (item.status === "ANALYZED" || item.status === "ERROR" || item.status === "WARNING") {
        next[item.id] = seedDecision(item, docTypes, vendors);
        seededRef.current.add(item.id);
        changed = true;
      }
    }
    if (changed) setDecisions((prev) => ({ ...next, ...prev }));
  }, [batch, docTypes, vendors]);

  const patchDecision = (itemId: string, patch: Partial<Decision>) =>
    setDecisions((prev) => ({ ...prev, [itemId]: { ...prev[itemId], ...patch } }));

  // ── Vendor inline creation ───────────────────────────────────────────────────
  const createVendor = async (itemId: string) => {
    const name = window.prompt(t("documents.bulk.vendor_create_prompt"));
    if (!name?.trim()) return;
    try {
      const res = await apiFetch("/api/vendors", { method: "POST", body: JSON.stringify({ name: name.trim() }) });
      const v = await res.json() as Vendor & { error?: string };
      if (!res.ok || !v.id) throw new Error(v.error ?? "Error");
      setVendors((prev) => [...prev, { id: v.id, name: v.name }].sort((a, b) => a.name.localeCompare(b.name)));
      patchDecision(itemId, { vendorId: v.id });
    } catch (e) {
      alert(e instanceof Error ? e.message : "Error");
    }
  };

  // ── Commit one item ──────────────────────────────────────────────────────────
  const commitItem = useCallback(async (itemId: string): Promise<boolean> => {
    const dec = decisions[itemId];
    if (!dec) return false;
    setRows((prev) => ({ ...prev, [itemId]: { committing: true, error: null } }));
    try {
      const res = await apiFetch(`/api/documents/bulk/items/${itemId}/commit`, {
        method: "POST", body: JSON.stringify(toCommitBody(dec)),
      });
      const data = await res.json().catch(() => ({})) as { documentId?: string; error?: string };
      if (!res.ok) throw new Error(data.error ?? `Error ${res.status}`);
      setRows((prev) => ({ ...prev, [itemId]: { done: true, documentId: data.documentId } }));
      return true;
    } catch (e) {
      setRows((prev) => ({ ...prev, [itemId]: { error: e instanceof Error ? e.message : "Error" } }));
      return false;
    }
  }, [decisions]);

  const commitAll = async () => {
    const targets = (batch?.items ?? []).filter(
      (i) => (i.status === "ANALYZED" || i.status === "ERROR" || i.status === "WARNING") && !rows[i.id]?.done,
    );
    let ok = 0, fail = 0;
    for (const it of targets) {
      const success = await commitItem(it.id);
      if (success) ok++; else fail++;
    }
    await loadBatch();
    alert(t("documents.bulk.batch_done", { ok, fail }));
  };

  const discardItem = async (itemId: string) => {
    if (!confirm(t("documents.bulk.discard_item_confirm"))) return;
    try { await apiFetch(`/api/documents/bulk/items/${itemId}`, { method: "DELETE" }); await loadBatch(); }
    catch (e) { alert(e instanceof Error ? e.message : "Error"); }
  };

  const discardBatch = async () => {
    if (!confirm(t("documents.bulk.discard_batch_confirm"))) return;
    try { await apiFetch(`/api/documents/bulk/batches/${batchId}`, { method: "DELETE" }); router.push("/documents"); }
    catch (e) { alert(e instanceof Error ? e.message : "Error"); }
  };

  const reanalyzeItem = async (itemId: string) => {
    try {
      const res = await apiFetch(`/api/documents/bulk/items/${itemId}/reanalyze`, { method: "POST" });
      const d = await res.json().catch(() => ({})) as { error?: string };
      if (!res.ok) throw new Error(d.error ?? `Error ${res.status}`);
      seededRef.current.delete(itemId);   // allow re-seed once analysis completes
      await loadBatch();
    } catch (e) { alert(e instanceof Error ? e.message : "Error"); }
  };

  const reanalyzeBatch = async () => {
    if (!confirm(t("documents.bulk.reanalyze_batch_confirm"))) return;
    try {
      const res = await apiFetch(`/api/documents/bulk/batches/${batchId}/reanalyze`, { method: "POST" });
      const d = await res.json().catch(() => ({})) as { count?: number; error?: string };
      if (!res.ok) throw new Error(d.error ?? `Error ${res.status}`);
      seededRef.current.clear();          // all items will be re-seeded after analysis
      await loadBatch();
      alert(t("documents.bulk.reanalyze_done", { count: d.count ?? 0 }));
    } catch (e) { alert(e instanceof Error ? e.message : "Error"); }
  };

  if (!isAdmin) {
    return <div className="flex h-screen items-center justify-center text-slate-500">{t("common.unknown_error")}</div>;
  }

  return (
    <div className="flex flex-col h-screen bg-slate-50 overflow-hidden">
      {/* Header */}
      <header className="sticky top-0 z-10 flex-shrink-0 border-b border-slate-200 bg-white px-8 py-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Layers className="h-6 w-6 text-[var(--accent)]" />
            <div>
              <h1 className="text-xl font-bold text-slate-900">{t("documents.bulk.review_title")}</h1>
              <p className="text-sm text-slate-500 mt-0.5">{t("documents.bulk.review_subtitle")}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => router.push("/documents")}
              className="flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50 transition-colors">
              <ArrowLeft className="h-3.5 w-3.5" />{t("documents.bulk.back_to_docs")}
            </button>
            <button onClick={() => void loadBatch()}
              className="flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50 transition-colors">
              <RefreshCw className="h-3.5 w-3.5" />{t("documents.bulk.refresh")}
            </button>
            <button onClick={reanalyzeBatch}
              className="flex items-center gap-2 rounded-lg border border-[var(--accent)] bg-white px-3 py-2 text-xs font-medium text-[var(--accent)] hover:bg-[var(--accent)]/5 transition-colors">
              <Sparkles className="h-3.5 w-3.5" />{t("documents.bulk.reanalyze_batch")}
            </button>
            <button onClick={discardBatch}
              className="flex items-center gap-2 rounded-none border border-red-200 bg-red-50 px-3 py-2 text-xs font-medium text-red-600 hover:bg-red-100 transition-colors">
              <Trash2 className="h-3.5 w-3.5" />{t("documents.bulk.discard")}
            </button>
            <button onClick={commitAll}
              className="flex items-center gap-2 rounded-none bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white hover:bg-[var(--accent)]/90 transition-colors">
              <CheckCircle2 className="h-4 w-4" />{t("documents.bulk.create_all")}
            </button>
          </div>
        </div>
      </header>

      {/* Content */}
      <main className="flex-1 overflow-y-auto px-8 py-6 space-y-4">
        {error && (
          <div className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
            <AlertTriangle className="h-4 w-4 flex-shrink-0" />{error}
          </div>
        )}
        {loading ? (
          <div className="flex items-center justify-center py-16 text-slate-400">
            <RefreshCw className="h-5 w-5 animate-spin mr-2" /><span className="text-sm">{t("common.loading_data")}</span>
          </div>
        ) : !batch || batch.items.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-slate-400">
            <Layers className="h-12 w-12 mb-3 opacity-30" />
            <p className="text-sm">{t("documents.bulk.empty")}</p>
          </div>
        ) : (
          batch.items.map((item) => (
            <ItemCard
              key={item.id}
              item={item}
              decision={decisions[item.id]}
              row={rows[item.id]}
              docTypes={docTypes}
              vendors={vendors}
              contracts={contracts}
              cis={cis}
              onPatch={(p) => patchDecision(item.id, p)}
              onCreateVendor={() => createVendor(item.id)}
              onCommit={() => commitItem(item.id)}
              onDiscard={() => discardItem(item.id)}
              onReanalyze={() => reanalyzeItem(item.id)}
            />
          ))
        )}
      </main>
    </div>
  );
}

// ─── Item Card ────────────────────────────────────────────────────────────────

function ItemCard({
  item, decision, row, docTypes, vendors, contracts, cis,
  onPatch, onCreateVendor, onCommit, onDiscard, onReanalyze,
}: {
  item: BatchItem;
  decision?: Decision;
  row?: RowState;
  docTypes: DocType[];
  vendors: Vendor[];
  contracts: ContractOpt[];
  cis: CIOpt[];
  onPatch: (p: Partial<Decision>) => void;
  onCreateVendor: () => void;
  onCommit: () => void;
  onDiscard: () => void;
  onReanalyze: () => void;
}) {
  const { t } = useLanguage();
  const [ciSearch, setCiSearch] = useState("");

  const analyzing = item.status === "PENDING_ANALYSIS" || item.status === "ANALYZING";
  const committed = item.status === "COMMITTED" || row?.done;
  const a = item.analysis ?? {};

  const statusBadge = () => {
    if (committed) return <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-700"><CheckCircle2 className="h-3 w-3" />{t("documents.bulk.committed")}</span>;
    if (analyzing) return <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700"><Loader2 className="h-3 w-3 animate-spin" />{t("documents.bulk.analyzing")}</span>;
    if (item.status === "ERROR") return <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-700"><AlertTriangle className="h-3 w-3" />{t("documents.bulk.status_error")}</span>;
    if (item.status === "WARNING") return <span className="inline-flex items-center gap-1 rounded-full bg-yellow-100 px-2 py-0.5 text-xs font-semibold text-yellow-800"><AlertTriangle className="h-3 w-3" />{t("documents.bulk.status_warning")}</span>;
    return <span className="inline-flex items-center gap-1 rounded-full bg-[var(--accent)]/10 px-2 py-0.5 text-xs font-semibold text-[var(--accent)]"><Sparkles className="h-3 w-3" />{t("documents.bulk.analyzed")}</span>;
  };

  const selectedCis = cis.filter((c) => decision?.ciIds.includes(c.id));
  const matchedIds = new Set((a.ciMatches ?? []).map((m) => m.ciId));
  const ciResults = ciSearch.trim()
    ? cis.filter((c) =>
        !decision?.ciIds.includes(c.id) &&
        (c.name.toLowerCase().includes(ciSearch.toLowerCase()) || c.apiSlug.toLowerCase().includes(ciSearch.toLowerCase())),
      ).slice(0, 6)
    : [];

  const addCi = (id: string) => { onPatch({ ciIds: [...(decision?.ciIds ?? []), id] }); setCiSearch(""); };
  const removeCi = (id: string) => onPatch({ ciIds: (decision?.ciIds ?? []).filter((x) => x !== id) });

  const needsVendor = decision?.target === "contract" || decision?.target === "addendum" || decision?.target === "license";
  const needsNumber = needsVendor;
  const showDates = needsVendor;

  return (
    <div className="bg-white shadow-sm ring-1 ring-slate-200">
      <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
        <div className="flex items-center gap-2 min-w-0">
          <FileText className="h-4 w-4 text-slate-400 flex-shrink-0" />
          <span className="truncate text-sm font-medium text-slate-800">{item.originalName}</span>
        </div>
        {statusBadge()}
      </div>

      {analyzing ? (
        <div className="px-4 py-6 text-sm text-slate-400">{t("documents.bulk.pending_analysis")}…</div>
      ) : committed ? (
        <div className="px-4 py-4 text-sm text-emerald-700">{t("documents.bulk.commit_success")}.</div>
      ) : (
        <div className="px-4 py-4 space-y-3">
          {item.status === "WARNING" && (
            <p className="flex items-center gap-1.5 rounded border border-yellow-300 bg-yellow-50 px-3 py-2 text-xs text-yellow-800">
              <AlertTriangle className="h-3.5 w-3.5" />{t("documents.bulk.warning_hint")}
            </p>
          )}
          {item.status !== "WARNING" && a.textExtracted === false && (
            <p className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">{t("documents.bulk.no_text")}</p>
          )}
          {row?.error && (
            <p className="flex items-center gap-1.5 rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600">
              <AlertTriangle className="h-3.5 w-3.5" />{row.error}
            </p>
          )}

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {/* Title */}
            <div className="md:col-span-2">
              <label className="block text-xs font-semibold text-slate-600 mb-1">{t("documents.bulk.doc_title_label")}</label>
              <input className={inputCls} value={decision?.title ?? ""} onChange={(e) => onPatch({ title: e.target.value })} />
            </div>
            {/* Document type */}
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1">{t("documents.bulk.col_type")}</label>
              <select className={inputCls} value={decision?.documentTypeId ?? ""} onChange={(e) => onPatch({ documentTypeId: e.target.value })}>
                <option value="">—</option>
                {docTypes.map((dt) => <option key={dt.id} value={dt.id}>{dt.name}</option>)}
              </select>
            </div>
            {/* Target */}
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1">{t("documents.bulk.col_target")}</label>
              <select className={inputCls} value={decision?.target ?? "none"} onChange={(e) => onPatch({ target: e.target.value as Target })}>
                <option value="contract">{t("documents.bulk.target_contract")}</option>
                <option value="addendum">{t("documents.bulk.target_addendum")}</option>
                <option value="license">{t("documents.bulk.target_license")}</option>
                <option value="none">{t("documents.bulk.target_none")}</option>
              </select>
            </div>

            {decision?.target === "addendum" && (
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1">{t("documents.bulk.parent_contract")}</label>
                <select className={inputCls} value={decision?.parentContractId ?? ""} onChange={(e) => onPatch({ parentContractId: e.target.value })}>
                  <option value="">—</option>
                  {contracts.map((c) => <option key={c.id} value={c.id}>{c.contractNumber}</option>)}
                </select>
              </div>
            )}

            {decision?.target === "license" && (
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1">{t("documents.bulk.license_name")}</label>
                <input className={inputCls} value={decision?.licenseName ?? ""} onChange={(e) => onPatch({ licenseName: e.target.value })} />
              </div>
            )}

            {needsVendor && (
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1">{t("documents.bulk.col_vendor")}</label>
                <div className="flex gap-1">
                  <select className={inputCls} value={decision?.vendorId ?? ""} onChange={(e) => onPatch({ vendorId: e.target.value })}>
                    <option value="">{t("documents.bulk.vendor_select")}</option>
                    {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                  </select>
                  <button onClick={onCreateVendor} title={t("documents.bulk.vendor_create")}
                    className="flex-shrink-0 rounded-none border border-[var(--accent)] px-2 text-[var(--accent)] hover:bg-[var(--accent)]/5">
                    <Plus className="h-4 w-4" />
                  </button>
                </div>
                {a.vendorName && <p className="mt-0.5 text-xs text-slate-400">{t("documents.bulk.ai_suggested")}: {a.vendorName}</p>}
              </div>
            )}

            {needsNumber && (
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1">{t("documents.bulk.col_number")}</label>
                <input className={inputCls} value={decision?.entityNumber ?? ""} onChange={(e) => onPatch({ entityNumber: e.target.value })} />
              </div>
            )}

            {showDates && (
              <>
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">{t("documents.bulk.start_date")}</label>
                  <input type="date" className={inputCls} value={decision?.startDate ?? ""} onChange={(e) => onPatch({ startDate: e.target.value })} />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">{t("documents.bulk.end_date")}</label>
                  <input type="date" className={inputCls} value={decision?.endDate ?? ""} onChange={(e) => onPatch({ endDate: e.target.value })} />
                </div>
              </>
            )}
          </div>

          {/* CIs */}
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1">{t("documents.bulk.col_cis")}</label>
            <div className="flex flex-wrap gap-1.5 mb-1.5">
              {selectedCis.length === 0 && <span className="text-xs text-slate-400">{t("documents.bulk.no_ci_matches")}</span>}
              {selectedCis.map((c) => (
                <span key={c.id} className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${matchedIds.has(c.id) ? "bg-[var(--accent)]/10 text-[var(--accent)]" : "bg-slate-100 text-slate-600"}`}>
                  {c.name}
                  <button onClick={() => removeCi(c.id)} className="hover:text-red-600"><X className="h-3 w-3" /></button>
                </span>
              ))}
            </div>
            <div className="relative">
              <input className={inputCls} placeholder={t("documents.search_cis")} value={ciSearch} onChange={(e) => setCiSearch(e.target.value)} />
              {ciResults.length > 0 && (
                <div className="absolute z-10 mt-1 w-full rounded-none border border-slate-200 bg-white shadow-lg divide-y divide-slate-100">
                  {ciResults.map((c) => (
                    <button key={c.id} onClick={() => addCi(c.id)} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-[var(--accent)]/5">
                      <span className="text-slate-700">{c.name}</span>
                      <span className="font-mono text-slate-400">{c.apiSlug}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            {(a.ciHints?.length ?? 0) > 0 && (
              <p className="mt-1 text-xs text-slate-400">{t("documents.bulk.ci_hints")}: {a.ciHints!.join(", ")}</p>
            )}
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <button onClick={onReanalyze}
              className="flex items-center gap-1.5 rounded-lg border border-[var(--accent)] px-3 py-1.5 text-xs font-medium text-[var(--accent)] hover:bg-[var(--accent)]/5 transition-colors">
              <Sparkles className="h-3.5 w-3.5" />{t("documents.bulk.reanalyze")}
            </button>
            <button onClick={onDiscard}
              className="flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 transition-colors">
              <Trash2 className="h-3.5 w-3.5" />{t("documents.bulk.discard")}
            </button>
            <button onClick={onCommit} disabled={row?.committing}
              className="flex items-center gap-1.5 rounded-none bg-[var(--accent)] px-4 py-1.5 text-xs font-semibold text-white hover:bg-[var(--accent)]/90 disabled:opacity-50 transition-colors">
              {row?.committing ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
              {t("documents.bulk.create")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

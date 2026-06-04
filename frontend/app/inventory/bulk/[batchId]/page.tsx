"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  ArrowLeft, RefreshCw, AlertTriangle, CheckCircle2, Sparkles,
  Loader2, Trash2, ChevronDown, ChevronRight, XCircle, AlertCircle,
} from "lucide-react";

import { useAuth } from "@/contexts/AuthContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { apiFetch } from "@/lib/apiFetch";

// ─── Types ────────────────────────────────────────────────────────────────────

type ItemStatus = "PENDING_ANALYSIS" | "ANALYZING" | "ANALYZED" | "ERROR" | "COMMITTED" | "COMMITTING";

interface Conflict { field: string; existingId: string; existingName: string; }

interface CIItemAnalysis {
  normalized?: Record<string, string | null | undefined>;
  conflicts?: Conflict[];
  possibleDuplicate?: boolean;
  aiSkipped?: boolean;
  analyzedAt?: string;
  decision?: CIDecision;
}

interface CIBatchItem {
  id: string;
  rowIndex: number;
  rawData: Record<string, string | null>;
  status: ItemStatus;
  analysis: CIItemAnalysis | null;
  errorMessage: string | null;
  committedCiId: string | null;
}

interface CIBatchData {
  id: string;
  status: string;
  rowCount: number;
  items: CIBatchItem[];
}

interface CIDecision {
  name: string;
  ciType: string;
  criticality: "LOW" | "MEDIUM" | "HIGH" | "MISSION_CRITICAL";
  environment: "DEVELOPMENT" | "TESTING" | "STAGING" | "PRODUCTION";
  status?: "ACTIVO" | "INACTIVO" | "RETIRADO";
  inventoryNumber?: string | null;
  manufacturer?: string | null;
  serialNumber?: string | null;
  model?: string | null;
  branch?: string | null;
  costCenter?: string | null;
  version?: string | null;
  licenseType?: string | null;
  eolDate?: string | null;
  eosDate?: string | null;
  businessImpact?: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" | null;
  dataClassification?: "PUBLIC" | "INTERNAL" | "CONFIDENTIAL" | "RESTRICTED" | null;
  assignedUser?: string | null;
  ipAddress?: string | null;
  description?: string | null;
  forceCreate?: boolean;
}

interface RowState { committing?: boolean; error?: string | null; done?: boolean; ciId?: string; }

// ─── Constants ────────────────────────────────────────────────────────────────

const CI_TYPES = [
  "PHYSICAL_SERVER","VIRTUAL_SERVER","NETWORK","NETWORK_EQUIPMENT","STORAGE","BACKUP",
  "HARDWARE","DESKTOP","LAPTOP","PRINTER","SCANNER","MONITOR","VIDEOCONFERENCE","SMART_DISPLAY",
  "TIME_CLOCK","IP_PHONE","SMARTPHONE","TABLET","PDA","BARCODE_SCANNER","IP_CAMERA","UPS",
  "WIFI_AP","CLOUD_INSTANCE","CLOUD_STORAGE","SOFTWARE","DATABASE","BASE_SOFTWARE","LICENSE",
  "APPLICATION","OTHER",
];
const CRITICALITIES = ["LOW","MEDIUM","HIGH","MISSION_CRITICAL"] as const;
const ENVIRONMENTS  = ["DEVELOPMENT","TESTING","STAGING","PRODUCTION"] as const;
const STATUSES      = ["ACTIVO","INACTIVO","RETIRADO"] as const;
const BUSINESS_IMPACTS  = ["LOW","MEDIUM","HIGH","CRITICAL"] as const;
const DATA_CLASSIFICATIONS = ["PUBLIC","INTERNAL","CONFIDENTIAL","RESTRICTED"] as const;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function seedDecision(item: CIBatchItem): CIDecision {
  const n = item.analysis?.normalized ?? {};
  const r = item.rawData ?? {};
  const pick = (a: string | null | undefined, b: string | null | undefined) => (a ?? b ?? "").trim();
  return {
    name:               pick(n.name, r.name) || "",
    ciType:             pick(n.ciType, r.ciType) || "OTHER",
    criticality:        (CRITICALITIES.includes(pick(n.criticality, r.criticality) as never) ? pick(n.criticality, r.criticality) : "MEDIUM") as CIDecision["criticality"],
    environment:        (ENVIRONMENTS.includes(pick(n.environment, r.environment) as never) ? pick(n.environment, r.environment) : "PRODUCTION") as CIDecision["environment"],
    status:             (STATUSES.includes(pick(n.status, r.status) as never) ? pick(n.status, r.status) : "ACTIVO") as CIDecision["status"],
    inventoryNumber:    pick(n.inventoryNumber, r.inventoryNumber) || null,
    manufacturer:       pick(n.manufacturer, r.manufacturer) || null,
    serialNumber:       pick(n.serialNumber, r.serialNumber) || null,
    model:              pick(n.model, r.model) || null,
    branch:             pick(n.branch, r.branch) || null,
    costCenter:         pick(n.costCenter, r.costCenter) || null,
    version:            pick(n.version, r.version) || null,
    licenseType:        pick(n.licenseType, r.licenseType) || null,
    eolDate:            pick(n.eolDate, r.eolDate) || null,
    eosDate:            pick(n.eosDate, r.eosDate) || null,
    businessImpact:     (BUSINESS_IMPACTS.includes(pick(n.businessImpact, r.businessImpact) as never) ? pick(n.businessImpact, r.businessImpact) : null) as CIDecision["businessImpact"],
    dataClassification: (DATA_CLASSIFICATIONS.includes(pick(n.dataClassification, r.dataClassification) as never) ? pick(n.dataClassification, r.dataClassification) : null) as CIDecision["dataClassification"],
    assignedUser:       pick(n.assignedUser, r.assignedUser) || null,
    ipAddress:          pick(n.ipAddress, r.ipAddress) || null,
    description:        pick(n.description, r.description) || null,
    forceCreate:        false,
  };
}

const inp = "w-full rounded-none border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-800 focus:border-[var(--accent)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]/20";
const sel = inp + " cursor-pointer";

// ─── Item row component ───────────────────────────────────────────────────────

function ItemRow({
  item, decision, rowState, expanded, onExpand,
  onChange, onCommit, onDiscard, onReanalyze, t,
}: {
  item: CIBatchItem;
  decision: CIDecision | undefined;
  rowState: RowState;
  expanded: boolean;
  onExpand: () => void;
  onChange: (d: Partial<CIDecision>) => void;
  onCommit: () => void;
  onDiscard: () => void;
  onReanalyze: () => void;
  t: (k: string) => string;
}) {
  const conflicts = item.analysis?.conflicts ?? [];
  const hasConflicts = conflicts.length > 0;
  const possibleDuplicate = item.analysis?.possibleDuplicate ?? hasConflicts;
  const aiSkipped = item.analysis?.aiSkipped ?? false;
  const norm = item.analysis?.normalized;

  const statusCfg: Record<ItemStatus, { cls: string; label: string; icon: React.ReactNode }> = {
    PENDING_ANALYSIS: { cls: "bg-slate-100 text-slate-500", label: t("inventory.bulk.pending_analysis"), icon: <Loader2 className="h-3 w-3 animate-spin" /> },
    ANALYZING:        { cls: "bg-amber-100 text-amber-700", label: t("inventory.bulk.analyzing"),        icon: <Sparkles className="h-3 w-3 animate-pulse" /> },
    ANALYZED:         { cls: "bg-blue-100 text-blue-700",   label: t("inventory.bulk.analyzed"),         icon: <CheckCircle2 className="h-3 w-3" /> },
    ERROR:            { cls: "bg-red-100 text-red-700",     label: t("inventory.bulk.status_error"),      icon: <XCircle className="h-3 w-3" /> },
    COMMITTED:        { cls: "bg-emerald-100 text-emerald-700", label: t("inventory.bulk.committed"),    icon: <CheckCircle2 className="h-3 w-3" /> },
    COMMITTING:       { cls: "bg-slate-100 text-slate-500", label: "…",                                  icon: <Loader2 className="h-3 w-3 animate-spin" /> },
  };
  const { cls, label, icon } = statusCfg[item.status] ?? statusCfg.PENDING_ANALYSIS;

  const isPending = item.status === "PENDING_ANALYSIS" || item.status === "ANALYZING";
  const isCommitted = item.status === "COMMITTED" || rowState.done;

  const displayName = decision?.name || item.rawData?.name || `Row ${item.rowIndex}`;

  return (
    <>
      {/* ── Summary row ─────────────────────────────────────────────────────── */}
      <tr className={`border-b border-slate-100 transition-colors hover:bg-slate-50/60 ${isCommitted ? "opacity-60" : ""}`}>
        <td className="px-3 py-2.5 text-xs text-slate-400 w-10 text-center">{item.rowIndex}</td>
        <td className="px-3 py-2.5 font-medium text-slate-800 max-w-xs">
          <div className="flex items-center gap-1.5">
            {!isPending && !isCommitted && (
              <button onClick={onExpand}
                className="flex-shrink-0 text-slate-400 hover:text-[var(--accent)] transition-colors">
                {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              </button>
            )}
            <span className="truncate text-sm">{displayName}</span>
          </div>
        </td>
        <td className="px-3 py-2.5 text-xs text-slate-600">{decision?.ciType || norm?.ciType || item.rawData?.ciType || "—"}</td>
        <td className="px-3 py-2.5 text-xs text-slate-600">{decision?.criticality || "—"}</td>
        <td className="px-3 py-2.5 text-xs text-slate-600">{decision?.environment || "—"}</td>
        <td className="px-3 py-2.5">
          <div className="flex flex-col gap-1">
            {possibleDuplicate && !isCommitted && (
              <span
                title={t("inventory.bulk.possible_duplicate")}
                className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700"
              >
                <AlertCircle className="h-3 w-3" />
                {t("inventory.bulk.possible_duplicate")}
                {conflicts.length > 0 && ` (${conflicts.length})`}
              </span>
            )}
            {aiSkipped && !isCommitted && (
              <span
                title={t("inventory.bulk.ai_skipped")}
                className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-600"
              >
                {t("inventory.bulk.ai_skipped")}
              </span>
            )}
          </div>
        </td>
        <td className="px-3 py-2.5">
          <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${cls}`}>
            {icon}{label}
          </span>
          {rowState.error && <p className="text-xs text-red-600 mt-0.5 truncate max-w-xs">{rowState.error}</p>}
        </td>
        <td className="px-3 py-2.5 text-right whitespace-nowrap">
          {!isCommitted && !isPending && (
            <div className="flex items-center gap-1 justify-end">
              <button onClick={onCommit} disabled={rowState.committing}
                className="inline-flex items-center gap-1 rounded-none bg-[var(--accent)] px-2.5 py-1 text-xs font-semibold text-white hover:bg-[var(--accent)]/90 transition-colors disabled:opacity-50">
                {rowState.committing ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3 w-3" />}
                {t("inventory.bulk.commit")}
              </button>
              <button onClick={onReanalyze}
                className="rounded-none border border-slate-300 bg-white p-1 text-slate-500 hover:bg-slate-50 transition-colors"
                title={t("inventory.bulk.reanalyze")}>
                <RefreshCw className="h-3 w-3" />
              </button>
              <button onClick={onDiscard}
                className="rounded-none border border-slate-300 bg-white p-1 text-red-400 hover:bg-red-50 transition-colors"
                title={t("inventory.bulk.discard")}>
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          )}
          {isCommitted && item.committedCiId && (
            <a href={`/inventory?highlight=${item.committedCiId}`}
              className="text-xs text-[var(--accent)] hover:underline">CI →</a>
          )}
        </td>
      </tr>

      {/* ── Expanded edit panel ──────────────────────────────────────────────── */}
      {expanded && decision && (
        <tr>
          <td colSpan={8} className="bg-slate-50/80 px-6 py-4 border-b border-slate-200">
            {/* Conflicts banner */}
            {hasConflicts && (
              <div className="mb-3 flex flex-wrap gap-2">
                {conflicts.map((c, i) => (
                  <span key={i} className="inline-flex items-center gap-1.5 rounded-lg bg-amber-50 border border-amber-200 px-3 py-1.5 text-xs text-amber-800">
                    <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" />
                    {t("inventory.bulk.conflict_warning").replace("{field}", c.field)}: <strong>{c.existingName}</strong>
                  </span>
                ))}
                <label className="inline-flex items-center gap-2 cursor-pointer rounded-lg bg-amber-50 border border-amber-200 px-3 py-1.5 text-xs text-amber-800">
                  <input type="checkbox" checked={decision.forceCreate ?? false}
                    onChange={(e) => onChange({ forceCreate: e.target.checked })} />
                  {t("inventory.bulk.force_create")}
                </label>
              </div>
            )}

            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {/* Required fields */}
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">name *</label>
                <input className={inp} value={decision.name} onChange={(e) => onChange({ name: e.target.value })} />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">ciType *</label>
                <select className={sel} value={decision.ciType} onChange={(e) => onChange({ ciType: e.target.value })}>
                  {CI_TYPES.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">criticality *</label>
                <select className={sel} value={decision.criticality} onChange={(e) => onChange({ criticality: e.target.value as CIDecision["criticality"] })}>
                  {CRITICALITIES.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">environment *</label>
                <select className={sel} value={decision.environment} onChange={(e) => onChange({ environment: e.target.value as CIDecision["environment"] })}>
                  {ENVIRONMENTS.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">status</label>
                <select className={sel} value={decision.status ?? "ACTIVO"} onChange={(e) => onChange({ status: e.target.value as CIDecision["status"] })}>
                  {STATUSES.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">inventoryNumber</label>
                <input className={inp} value={decision.inventoryNumber ?? ""} onChange={(e) => onChange({ inventoryNumber: e.target.value || null })} />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">manufacturer</label>
                <input className={inp} value={decision.manufacturer ?? ""} onChange={(e) => onChange({ manufacturer: e.target.value || null })} />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">serialNumber</label>
                <input className={inp} value={decision.serialNumber ?? ""} onChange={(e) => onChange({ serialNumber: e.target.value || null })} />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">model</label>
                <input className={inp} value={decision.model ?? ""} onChange={(e) => onChange({ model: e.target.value || null })} />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">branch</label>
                <input className={inp} value={decision.branch ?? ""} onChange={(e) => onChange({ branch: e.target.value || null })} />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">costCenter</label>
                <input className={inp} value={decision.costCenter ?? ""} onChange={(e) => onChange({ costCenter: e.target.value || null })} />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">version (SW)</label>
                <input className={inp} value={decision.version ?? ""} onChange={(e) => onChange({ version: e.target.value || null })} />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">licenseType (SW)</label>
                <input className={inp} value={decision.licenseType ?? ""} onChange={(e) => onChange({ licenseType: e.target.value || null })} />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">eolDate</label>
                <input className={inp} type="date" value={decision.eolDate ?? ""} onChange={(e) => onChange({ eolDate: e.target.value || null })} />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">eosDate</label>
                <input className={inp} type="date" value={decision.eosDate ?? ""} onChange={(e) => onChange({ eosDate: e.target.value || null })} />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">businessImpact</label>
                <select className={sel} value={decision.businessImpact ?? ""} onChange={(e) => onChange({ businessImpact: (e.target.value || null) as CIDecision["businessImpact"] })}>
                  <option value=""></option>
                  {BUSINESS_IMPACTS.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">dataClassification</label>
                <select className={sel} value={decision.dataClassification ?? ""} onChange={(e) => onChange({ dataClassification: (e.target.value || null) as CIDecision["dataClassification"] })}>
                  <option value=""></option>
                  {DATA_CLASSIFICATIONS.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">assignedUser</label>
                <input className={inp} value={decision.assignedUser ?? ""} onChange={(e) => onChange({ assignedUser: e.target.value || null })} />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">ipAddress</label>
                <input className={inp} value={decision.ipAddress ?? ""} onChange={(e) => onChange({ ipAddress: e.target.value || null })} />
              </div>
              <div className="md:col-span-4">
                <label className="block text-xs font-medium text-slate-500 mb-1">description</label>
                <textarea className={inp} rows={2} value={decision.description ?? ""} onChange={(e) => onChange({ description: e.target.value || null })} />
              </div>
            </div>

            {item.errorMessage && (
              <div className="mt-3 text-xs text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">{item.errorMessage}</div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function CIBulkReviewPage() {
  const { t } = useLanguage();
  const { isAdmin } = useAuth();
  const router = useRouter();
  const params = useParams();
  const batchId = String(params.batchId);

  const [batch, setBatch] = useState<CIBatchData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [decisions, setDecisions] = useState<Record<string, CIDecision>>({});
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const seededRef = useRef<Set<string>>(new Set());
  const [committing, setCommitting] = useState(false);

  const loadBatch = useCallback(async () => {
    try {
      const res = await apiFetch(`/api/cis/bulk/batches/${batchId}`);
      if (!res.ok) {
        const d = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(d.error ?? `Error ${res.status}`);
      }
      const data = await res.json() as CIBatchData;
      setBatch(data); setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("common.unknown_error"));
    } finally { setLoading(false); }
  }, [batchId, t]);

  useEffect(() => { void loadBatch(); }, [loadBatch]);

  const hasPending = useMemo(
    () => (batch?.items ?? []).some((i) => i.status === "PENDING_ANALYSIS" || i.status === "ANALYZING"),
    [batch],
  );
  useEffect(() => {
    if (!hasPending) return;
    const id = setInterval(() => { void loadBatch(); }, 4000);
    return () => clearInterval(id);
  }, [hasPending, loadBatch]);

  // Seed decisions once per item when analysis arrives
  useEffect(() => {
    if (!batch) return;
    const next: Record<string, CIDecision> = {};
    let changed = false;
    for (const item of batch.items) {
      if (seededRef.current.has(item.id)) continue;
      if (item.status === "ANALYZED" || item.status === "ERROR") {
        // If user already saved a decision, restore it
        const saved = item.analysis?.decision;
        next[item.id] = saved ? (saved as CIDecision) : seedDecision(item);
        seededRef.current.add(item.id);
        changed = true;
      }
    }
    if (changed) setDecisions((prev) => ({ ...next, ...prev }));
  }, [batch]);

  const patchDecision = (itemId: string, d: Partial<CIDecision>) =>
    setDecisions((prev) => ({ ...prev, [itemId]: { ...prev[itemId], ...d } }));

  // ── Save decision to backend on change (debounced) ──────────────────────────
  const saveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const saveDecision = useCallback((itemId: string, dec: CIDecision) => {
    if (saveTimers.current[itemId]) clearTimeout(saveTimers.current[itemId]);
    saveTimers.current[itemId] = setTimeout(async () => {
      try {
        await apiFetch(`/api/cis/bulk/items/${itemId}`, {
          method: "PATCH", body: JSON.stringify(dec),
        });
      } catch { /* silent */ }
    }, 800);
  }, []);

  const handleChange = (itemId: string, d: Partial<CIDecision>) => {
    patchDecision(itemId, d);
    const next = { ...decisions[itemId], ...d };
    saveDecision(itemId, next);
  };

  // ── Commit one item ──────────────────────────────────────────────────────────
  const commitItem = useCallback(async (itemId: string): Promise<boolean> => {
    const dec = decisions[itemId];
    if (!dec?.name) { setRows((p) => ({ ...p, [itemId]: { error: "Nombre requerido" } })); return false; }
    setRows((p) => ({ ...p, [itemId]: { committing: true, error: null } }));
    try {
      const res = await apiFetch(`/api/cis/bulk/items/${itemId}/commit`, {
        method: "POST", body: JSON.stringify(dec),
      });
      const data = await res.json().catch(() => ({})) as { ciId?: string; error?: string };
      if (!res.ok) throw new Error(data.error ?? `Error ${res.status}`);
      setRows((p) => ({ ...p, [itemId]: { done: true, ciId: data.ciId } }));
      return true;
    } catch (e) {
      setRows((p) => ({ ...p, [itemId]: { error: e instanceof Error ? e.message : "Error" } }));
      return false;
    }
  }, [decisions]);

  const commitAll = async () => {
    setCommitting(true);
    const targets = (batch?.items ?? []).filter(
      (i) => (i.status === "ANALYZED" || i.status === "ERROR") && !rows[i.id]?.done,
    );
    let ok = 0, fail = 0;
    for (const it of targets) { if (await commitItem(it.id)) ok++; else fail++; }
    await loadBatch();
    setCommitting(false);
    if (targets.length > 0) alert(t("inventory.bulk.batch_done").replace("{ok}", String(ok)).replace("{fail}", String(fail)));
  };

  const discardItem = async (itemId: string) => {
    if (!confirm(t("inventory.bulk.discard_item_confirm"))) return;
    try { await apiFetch(`/api/cis/bulk/items/${itemId}`, { method: "DELETE" }); await loadBatch(); }
    catch (e) { alert(e instanceof Error ? e.message : "Error"); }
  };

  const discardBatch = async () => {
    if (!confirm(t("inventory.bulk.discard_batch_confirm"))) return;
    try { await apiFetch(`/api/cis/bulk/batches/${batchId}`, { method: "DELETE" }); router.push("/inventory/bulk"); }
    catch (e) { alert(e instanceof Error ? e.message : "Error"); }
  };

  const reanalyzeItem = async (itemId: string) => {
    try {
      const res = await apiFetch(`/api/cis/bulk/items/${itemId}/reanalyze`, { method: "POST" });
      const d = await res.json().catch(() => ({})) as { error?: string };
      if (!res.ok) throw new Error(d.error ?? `Error ${res.status}`);
      seededRef.current.delete(itemId);
      await loadBatch();
    } catch (e) { alert(e instanceof Error ? e.message : "Error"); }
  };

  const reanalyzeBatch = async () => {
    if (!confirm(t("inventory.bulk.reanalyze_batch_confirm"))) return;
    try {
      const res = await apiFetch(`/api/cis/bulk/batches/${batchId}/reanalyze`, { method: "POST" });
      const d = await res.json().catch(() => ({})) as { count?: number; error?: string };
      if (!res.ok) throw new Error(d.error ?? `Error ${res.status}`);
      seededRef.current.clear();
      await loadBatch();
      alert(t("inventory.bulk.reanalyze_done").replace("{count}", String(d.count ?? 0)));
    } catch (e) { alert(e instanceof Error ? e.message : "Error"); }
  };

  const toggleExpand = (id: string) =>
    setExpanded((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });

  if (!isAdmin) {
    return <div className="flex h-screen items-center justify-center text-slate-400">{t("common.unknown_error")}</div>;
  }

  const items = batch?.items ?? [];
  const pendingCount  = items.filter((i) => i.status === "PENDING_ANALYSIS" || i.status === "ANALYZING").length;
  const readyCount    = items.filter((i) => (i.status === "ANALYZED" || i.status === "ERROR") && !rows[i.id]?.done).length;
  const committedCount = items.filter((i) => i.status === "COMMITTED" || rows[i.id]?.done).length;

  return (
    <div className="flex flex-col h-screen bg-slate-50 overflow-hidden">
      {/* Header */}
      <header className="sticky top-0 z-10 flex-shrink-0 border-b border-slate-200 bg-white px-8 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-slate-900">{t("inventory.bulk.review_title")}</h1>
            <p className="text-xs text-slate-500 mt-0.5">{t("inventory.bulk.review_subtitle")}</p>
          </div>
          <div className="flex items-center gap-2">
            {hasPending && (
              <span className="flex items-center gap-1.5 text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-full px-3 py-1">
                <Loader2 className="h-3 w-3 animate-spin" />{pendingCount} {t("inventory.bulk.pending_analysis")}
              </span>
            )}
            <button onClick={() => void loadBatch()} disabled={loading}
              className="flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 transition-colors disabled:opacity-50">
              <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />{t("inventory.bulk.refresh")}
            </button>
            {readyCount > 0 && (
              <button onClick={commitAll} disabled={committing}
                className="flex items-center gap-1.5 rounded-none bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-700 transition-colors disabled:opacity-50 shadow-sm">
                {committing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                {t("inventory.bulk.commit_all")} ({readyCount})
              </button>
            )}
            <button onClick={reanalyzeBatch}
              className="flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 transition-colors">
              <RefreshCw className="h-3 w-3" />{t("inventory.bulk.reanalyze_batch")}
            </button>
            <button onClick={discardBatch}
              className="flex items-center gap-1.5 rounded-lg border border-red-200 bg-white px-3 py-1.5 text-xs font-medium text-red-500 hover:bg-red-50 transition-colors">
              <Trash2 className="h-3 w-3" />{t("inventory.bulk.discard")}
            </button>
            <button onClick={() => router.push("/inventory/bulk")}
              className="flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 transition-colors">
              <ArrowLeft className="h-3 w-3" />{t("actions.back") ?? "Volver"}
            </button>
          </div>
        </div>
        {/* Stats bar */}
        {batch && (
          <div className="flex items-center gap-4 mt-2 text-xs text-slate-500">
            <span>{batch.rowCount} {t("inventory.bulk.col_rows")}</span>
            {committedCount > 0 && <span className="text-emerald-600 font-medium">✓ {committedCount} {t("inventory.bulk.committed")}</span>}
            {pendingCount > 0 && <span className="text-amber-600">{pendingCount} {t("inventory.bulk.analyzing")}</span>}
          </div>
        )}
      </header>

      <main className="flex-1 overflow-y-auto">
        {error && (
          <div className="m-6 flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
            <AlertTriangle className="h-4 w-4 flex-shrink-0" />{error}
          </div>
        )}
        {loading && !batch ? (
          <div className="flex items-center justify-center py-16 text-slate-400">
            <RefreshCw className="h-5 w-5 animate-spin mr-2" />{t("common.loading_data")}
          </div>
        ) : items.length === 0 ? (
          <div className="flex items-center justify-center py-16 text-slate-400">{t("inventory.bulk.empty_batch")}</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-white border-b border-slate-200">
                <th className="px-3 py-3 text-center text-xs font-semibold text-slate-400 uppercase tracking-wider w-10">#</th>
                <th className="px-3 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">{t("inventory.bulk.col_name")}</th>
                <th className="px-3 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">{t("inventory.bulk.col_type")}</th>
                <th className="px-3 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">{t("inventory.bulk.col_crit")}</th>
                <th className="px-3 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">{t("inventory.bulk.col_env")}</th>
                <th className="px-3 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">{t("inventory.bulk.col_conflict")}</th>
                <th className="px-3 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">{t("inventory.bulk.col_status")}</th>
                <th className="px-3 py-3 text-right text-xs font-semibold text-slate-500 uppercase tracking-wider">{t("inventory.bulk.col_actions")}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <ItemRow
                  key={item.id}
                  item={item}
                  decision={decisions[item.id]}
                  rowState={rows[item.id] ?? {}}
                  expanded={expanded.has(item.id)}
                  onExpand={() => toggleExpand(item.id)}
                  onChange={(d) => handleChange(item.id, d)}
                  onCommit={() => void commitItem(item.id)}
                  onDiscard={() => void discardItem(item.id)}
                  onReanalyze={() => void reanalyzeItem(item.id)}
                  t={t}
                />
              ))}
            </tbody>
          </table>
        )}
      </main>
    </div>
  );
}

"use client";

// Batch-review page (task F3) — the centerpiece of the Greenbone staging
// workflow: inspect, correct, and finally accept or discard one uploaded
// scan batch before anything is written to a CI. See:
//   docs/internal/specs/2026-07-29-v3.6.0-greenbone-real-format-staging.md
//   backend/src/modules/vuln-import/router.ts   (the 7 endpoints this page calls)
//   frontend/lib/types/vulnImport.ts             (single source of truth for shapes)
//
// Tabs (spec D7 + "3. Decisiones de diseño"): Accionables / Informativas /
// Requieren atención / Reaparecidas are independent *views*, not a partition
// — an entry can appear under more than one (e.g. a REAPARECIDA entry that is
// also FUZZY-matched).

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  RefreshCw, AlertCircle, AlertTriangle, ChevronLeft, CheckCircle,
  X, Search, ChevronDown, Info, PackageCheck, Trash2,
  ChevronUp, ShieldAlert, Flame, Plus,
} from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAuth } from "@/contexts/AuthContext";
import { apiFetch, fetchAllCIs } from "@/lib/apiFetch";
import AddCIModal from "@/components/AddCIModal";
import type {
  VulnImportEntry,
  GetBatchDetailResponse,
  AcceptResponse,
  VulnImportErrorResponse,
  VulnImportBlockingEntry,
  VulnImportClassification,
  VulnImportDecision,
  VulnImportSeverity,
  MatchConfidence,
  VulnImportBatch,
} from "@/lib/types/vulnImport";

// Local shape for the 422 UNRESOLVED_MATCHES response body — a loosened
// mirror of the imported UnresolvedMatchesErrorResponse, used only to
// narrow res.json() without re-asserting the literal 'UNRESOLVED_MATCHES'
// discriminant on a value TypeScript can't statically know yet.
interface UnresolvedMatchesLike {
  error?: string;
  entries?: VulnImportBlockingEntry[];
}

// ─── Local types not covered by vulnImport.ts (page-local concerns only) ────

interface CiOption {
  id: string;
  name: string;
  apiSlug: string;
}

interface Toast {
  id: number;
  type: "error" | "success";
  message: string;
}
let _toastId = 0;

type TabKey = "all" | "actionable" | "informational" | "attention" | "reappeared";

// ─── Style maps ───────────────────────────────────────────────────────────

const SEVERITY_STYLES: Record<VulnImportSeverity, string> = {
  CRITICAL: "bg-red-100 text-red-700 ring-red-200",
  HIGH: "bg-orange-100 text-orange-700 ring-orange-200",
  MEDIUM: "bg-yellow-100 text-yellow-700 ring-yellow-200",
  LOW: "bg-slate-100 text-slate-600 ring-slate-200",
  INFO: "bg-sky-50 text-sky-600 ring-sky-100",
};

const CLASSIFICATION_STYLES: Record<VulnImportClassification, string> = {
  NUEVA: "bg-emerald-100 text-emerald-700 ring-emerald-200",
  EXISTENTE_PENDIENTE: "bg-slate-100 text-slate-600 ring-slate-200",
  REAPARECIDA: "bg-purple-100 text-purple-700 ring-purple-200",
};

const CONFIDENCE_STYLES: Record<string, string> = {
  EXACT_IP: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  EXACT_NAME: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  EXACT_HOSTNAME: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  EXACT_DNS: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  FUZZY: "bg-amber-50 text-amber-700 ring-amber-200",
  AMBIGUOUS: "bg-orange-50 text-orange-700 ring-orange-200",
  UNMATCHED: "bg-red-50 text-red-700 ring-red-200",
  MANUAL: "bg-indigo-50 text-indigo-700 ring-indigo-200",
};

const BATCH_STATUS_STYLES: Record<string, string> = {
  PENDING: "bg-blue-100 text-blue-700",
  ACCEPTED: "bg-emerald-100 text-emerald-700",
  DISCARDED: "bg-slate-200 text-slate-600",
};

const ACTIONABLE_SEVERITIES: VulnImportSeverity[] = ["MEDIUM", "HIGH", "CRITICAL"];
const INFORMATIONAL_SEVERITIES: VulnImportSeverity[] = ["LOW", "INFO"];
const ATTENTION_CONFIDENCES: (MatchConfidence | null)[] = ["UNMATCHED", "AMBIGUOUS", "FUZZY"];

// CrowdStrike Spotlight `exploitStatus` labels that count as "active
// exploitation" (task F2, spec D4). This project has no precedent for the
// frontend importing anything from backend/src/ (checked), so this list is a
// deliberate, honest duplication of
// backend/src/modules/vuln-import/classifier.ts `ACTIVE_EXPLOITATION_LABELS`
// — MUST stay in sync with that constant if it ever changes. Do not widen
// this to a substring/heuristic match; it must mirror the backend's own
// premarking decision exactly so the UI badge and the server's INCLUDE
// premarking are visibly explained by the same signal.
const ACTIVE_EXPLOITATION_LABELS: ReadonlySet<string> = new Set([
  "Actively used (critical)",
  "Easily Accessible (high)",
]);

function isActivelyExploited(exploitStatus: string | null | undefined): boolean {
  if (!exploitStatus) return false;
  return ACTIVE_EXPLOITATION_LABELS.has(exploitStatus);
}

// ─── Small presentational pieces ─────────────────────────────────────────

function SeverityPill({ severity, t }: { severity: VulnImportSeverity; t: (k: string) => string }) {
  return (
    <span className={`inline-flex items-center rounded-none px-2 py-0.5 text-[11px] font-semibold ring-1 ${SEVERITY_STYLES[severity] ?? "bg-slate-100 text-slate-600 ring-slate-200"}`}>
      {t(`vulnImport.severity.${severity}`)}
    </span>
  );
}

function ClassificationPill({ classification, t }: { classification: VulnImportClassification; t: (k: string) => string }) {
  return (
    <span className={`inline-flex items-center rounded-none px-2 py-0.5 text-[11px] font-semibold ring-1 ${CLASSIFICATION_STYLES[classification]}`}>
      {t(`vulnImport.classification.${classification}`)}
    </span>
  );
}

function ConfidencePill({ confidence, t }: { confidence: MatchConfidence | null; t: (k: string) => string }) {
  if (!confidence) return <span className="text-xs text-slate-400">—</span>;
  return (
    <span className={`inline-flex items-center rounded-none px-2 py-0.5 text-[11px] font-semibold ring-1 ${CONFIDENCE_STYLES[confidence] ?? "bg-slate-100 text-slate-600 ring-slate-200"}`}>
      {t(`vulnImport.matchConfidence.${confidence}`)}
    </span>
  );
}

// ─── CI reassignment picker (searchable, loaded lazily from the shared CI list) ──

function CiReassignPicker({
  entry, ciOptions, ciLoading, onAssign, onCreateCi, assigning, t,
}: {
  entry: VulnImportEntry;
  ciOptions: CiOption[];
  ciLoading: boolean;
  onAssign: (ciId: string) => void;
  onCreateCi: (entry: VulnImportEntry) => void;
  assigning: boolean;
  t: (k: string) => string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return ciOptions.slice(0, 50);
    return ciOptions
      .filter((c) => c.name.toLowerCase().includes(q) || c.apiSlug.toLowerCase().includes(q))
      .slice(0, 50);
  }, [ciOptions, search]);

  const candidates = entry.matchCandidates ?? [];

  return (
    <div className="relative">
      <button
        type="button"
        disabled={assigning}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 rounded-none border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] font-medium text-amber-700 hover:bg-amber-100 disabled:opacity-50"
      >
        <Search className="h-3 w-3" />
        {t("vulnImport.actions.reassignCi")}
        <ChevronDown className={`h-3 w-3 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="absolute z-30 mt-1 w-72 rounded-none border border-slate-200 bg-white shadow-xl">
          {candidates.length > 0 && (
            <div className="border-b border-slate-100 p-2">
              <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                {t("vulnImport.entry.candidates")}
              </p>
              <ul className="space-y-0.5">
                {candidates.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => { onAssign(c.id); setOpen(false); }}
                      className="w-full truncate rounded-none px-2 py-1 text-left text-xs text-slate-700 hover:bg-indigo-50"
                    >
                      {c.name}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {entry.matchConfidence === "UNMATCHED" && (
            <button
              type="button"
              onClick={() => { onCreateCi(entry); setOpen(false); }}
              className="flex w-full items-center gap-2 border-b border-slate-100 px-3 py-2 text-left text-xs font-medium text-indigo-600 hover:bg-indigo-50"
            >
              <Plus className="h-3.5 w-3.5" />
              {t("vulnImport.actions.createCi")}
            </button>
          )}
          <div className="border-b border-slate-100 p-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
              <input
                autoFocus
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t("common.search_ci")}
                className="w-full rounded-none border border-slate-200 bg-slate-50 py-1.5 pl-7 pr-2 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-200"
              />
            </div>
          </div>
          <ul className="max-h-48 overflow-y-auto py-1">
            {ciLoading ? (
              <li className="px-3 py-2 text-xs italic text-slate-400">{t("common.loading")}</li>
            ) : filtered.length === 0 ? (
              <li className="px-3 py-2 text-xs italic text-slate-400">{t("common.no_results")}</li>
            ) : (
              filtered.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => { onAssign(c.id); setOpen(false); }}
                    className={`flex w-full items-center justify-between px-3 py-1.5 text-left text-xs hover:bg-indigo-50 ${c.id === entry.ciId ? "bg-indigo-50 text-indigo-700" : "text-slate-700"}`}
                  >
                    <span className="truncate font-medium">{c.name}</span>
                    <span className="ml-2 flex-shrink-0 font-mono text-[10px] text-slate-400">{c.apiSlug}</span>
                  </button>
                </li>
              ))
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

// ─── One entry row ─────────────────────────────────────────────────────────

function EntryRow({
  entry, ciMap, ciOptions, ciLoading, canEdit, onToggleDecision, onReassignCi, onCreateCi, pending, expanded, onToggleExpand, t,
}: {
  entry: VulnImportEntry;
  ciMap: Map<string, CiOption>;
  ciOptions: CiOption[];
  ciLoading: boolean;
  canEdit: boolean;
  onToggleDecision: (entry: VulnImportEntry) => void;
  onReassignCi: (entry: VulnImportEntry, ciId: string) => void;
  onCreateCi: (entry: VulnImportEntry) => void;
  pending: boolean;
  expanded: boolean;
  onToggleExpand: () => void;
  t: (k: string) => string;
}) {
  const matchedCi = entry.ciId ? ciMap.get(entry.ciId) : null;
  const needsAttention = entry.matchConfidence === "AMBIGUOUS" || entry.matchConfidence === "UNMATCHED";
  const included = entry.decision === "INCLUDE";
  const activelyExploited = isActivelyExploited(entry.exploitStatus);
  const hasDetails = !!(
    entry.summary || entry.solution || entry.family || entry.qod != null ||
    entry.exprtRating || entry.daysOpen != null || entry.products.length > 0 ||
    entry.cvssVersion || entry.externalStatus || entry.redhatImpact || entry.knownExploit
  );

  return (
    <div className={`flex flex-col gap-2 border-b border-slate-100 p-4 last:border-b-0 ${included ? "" : "bg-slate-50/60"}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <SeverityPill severity={entry.severity} t={t} />
            <ClassificationPill classification={entry.classification} t={t} />
            <ConfidencePill confidence={entry.matchConfidence} t={t} />
            {entry.cisaKev && (
              <span className="inline-flex items-center gap-1 rounded-full bg-red-600 px-2 py-0.5 text-[11px] font-bold text-white ring-1 ring-red-700">
                <ShieldAlert className="h-3 w-3" />
                {entry.cisaDueDate
                  ? t("vulnImport.entry.cisaKevWithDue").replace("{date}", new Date(entry.cisaDueDate).toLocaleDateString())
                  : t("vulnImport.entry.cisaKevLabel")}
              </span>
            )}
            {activelyExploited && (
              <span className="inline-flex items-center gap-1 rounded-full bg-orange-100 px-2 py-0.5 text-[11px] font-bold text-orange-800 ring-1 ring-orange-300">
                <Flame className="h-3 w-3" />
                {t("vulnImport.entry.activeExploitationBadge")}
              </span>
            )}
            {entry.edited && (
              <span className="inline-flex items-center rounded-none bg-indigo-50 px-2 py-0.5 text-[11px] font-semibold text-indigo-600 ring-1 ring-indigo-100">
                {t("vulnImport.entry.edited")}
              </span>
            )}
            {entry.family && (
              <span className="inline-flex items-center rounded-none bg-slate-50 px-2 py-0.5 text-[11px] font-medium text-slate-500 ring-1 ring-slate-200">
                {entry.family}
              </span>
            )}
            {entry.qod != null && (
              <span className="inline-flex items-center rounded-none bg-slate-50 px-2 py-0.5 text-[11px] font-medium text-slate-500 ring-1 ring-slate-200">
                {t("vulnImport.entry.qodLabel")}: {entry.qod}%
              </span>
            )}
          </div>
          <p className="mt-1.5 text-sm font-semibold text-slate-800">{entry.name}</p>
          <p className="font-mono text-[11px] text-slate-400">
            {entry.oid}
            {entry.port ? ` · ${t("vulnImport.entry.port")}: ${entry.port}` : ""}
            {entry.hostAddress ? ` · ${entry.hostAddress}` : ""}
          </p>
          {entry.cves.length > 0 ? (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {entry.cves.map((cve) => (
                <span key={cve} className="rounded-none bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-600">{cve}</span>
              ))}
            </div>
          ) : (
            <p className="mt-1.5 text-[11px] italic text-slate-400">{t("vulnImport.entry.noCves")}</p>
          )}
          {entry.classification === "EXISTENTE_PENDIENTE" && (
            <p className="mt-1.5 text-[11px] italic text-slate-400">{t("vulnImport.entry.existingPendingHint")}</p>
          )}
          {hasDetails && (
            <button
              type="button"
              onClick={onToggleExpand}
              className="mt-2 flex items-center gap-1 text-[11px] font-medium text-indigo-600 hover:text-indigo-700"
            >
              {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
              {expanded ? t("vulnImport.entry.hideDetails") : t("vulnImport.entry.showDetails")}
            </button>
          )}
        </div>

        <div className="flex flex-shrink-0 flex-col items-end gap-2">
          {canEdit ? (
            <label
              className={`flex cursor-pointer items-center gap-1.5 rounded-none px-3 py-1.5 text-xs font-semibold ring-1 transition-colors ${
                pending ? "cursor-not-allowed opacity-50" : ""
              } ${
                included
                  ? "bg-emerald-50 text-emerald-700 ring-emerald-200 hover:bg-emerald-100"
                  : "bg-slate-100 text-slate-500 ring-slate-200 hover:bg-slate-200"
              }`}
            >
              <input
                type="checkbox"
                checked={included}
                disabled={pending}
                onChange={() => onToggleDecision(entry)}
                className="h-3.5 w-3.5 rounded-none border-slate-400 text-emerald-600 focus:ring-2 focus:ring-emerald-300 disabled:cursor-not-allowed"
              />
              {included ? t("vulnImport.decision.INCLUDE") : t("vulnImport.decision.EXCLUDE")}
            </label>
          ) : (
            <span className={`rounded-none px-2 py-0.5 text-[11px] font-semibold ${included ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>
              {included ? t("vulnImport.decision.INCLUDE") : t("vulnImport.decision.EXCLUDE")}
            </span>
          )}

          <div className="text-right text-[11px] text-slate-500">
            {matchedCi ? (
              <a href={`/inventory?highlight=${matchedCi.id}`} className="font-medium text-indigo-600 hover:underline">
                {matchedCi.name}
              </a>
            ) : entry.ciId ? (
              <span className="font-mono text-slate-400">{entry.ciId}</span>
            ) : (
              <span className="italic text-slate-400">{t("vulnImport.entry.noCi")}</span>
            )}
          </div>

          {canEdit && needsAttention && (
            <CiReassignPicker
              entry={entry}
              ciOptions={ciOptions}
              ciLoading={ciLoading}
              assigning={pending}
              onAssign={(ciId) => onReassignCi(entry, ciId)}
              onCreateCi={onCreateCi}
              t={t}
            />
          )}
        </div>
      </div>

      {expanded && hasDetails && (
        <div className="mt-1 space-y-2 rounded-none border border-slate-200 bg-white p-3 text-xs">
          {entry.summary && (
            <div>
              <p className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                {t("vulnImport.entry.summaryLabel")}
              </p>
              <p className="whitespace-pre-wrap text-slate-700">{entry.summary}</p>
            </div>
          )}
          {entry.solution && (
            <div>
              <p className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                {t("vulnImport.entry.solutionLabel")}
              </p>
              <p className="whitespace-pre-wrap text-slate-700">{entry.solution}</p>
            </div>
          )}
          {(entry.exprtRating || entry.daysOpen != null || entry.cvssVersion || entry.redhatImpact) && (
            <div className="flex flex-wrap gap-4">
              {entry.exprtRating && (
                <div>
                  <p className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                    {t("vulnImport.entry.exprtRatingLabel")}
                  </p>
                  {/* CrowdStrike's own AI-driven rating — a distinct signal
                      from the CVSS-derived `severity` pill shown in the
                      collapsed row, deliberately not merged with it. */}
                  <p className="text-slate-700">{entry.exprtRating}</p>
                </div>
              )}
              {entry.redhatImpact && (
                <div>
                  <p className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                    {t("vulnImport.entry.redhatImpactLabel")}
                  </p>
                  {/* Red Hat's own severity rating — a distinct signal from
                      the CVSS-derived `severity` pill, deliberately not
                      merged with it, same principle as exprtRating above. */}
                  <p className="text-slate-700">{entry.redhatImpact}</p>
                </div>
              )}
              {entry.daysOpen != null && (
                <div>
                  <p className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                    {t("vulnImport.entry.daysOpenLabel")}
                  </p>
                  <p className="text-slate-700">{entry.daysOpen}</p>
                </div>
              )}
              {entry.cvssVersion && (
                <div>
                  <p className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                    {t("vulnImport.entry.cvssVersionLabel")}
                  </p>
                  <p className="text-slate-700">{entry.cvssVersion}</p>
                </div>
              )}
            </div>
          )}
          {entry.products.length > 0 && (
            <div>
              <p className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                {t("vulnImport.entry.productsLabel")}
              </p>
              <ul className="list-disc space-y-0.5 pl-4 text-slate-700">
                {entry.products.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </div>
          )}
          {entry.externalStatus && (
            <div>
              <p className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                {t("vulnImport.entry.externalStatusLabel")}
              </p>
              <p className="text-slate-700">{entry.externalStatus}</p>
            </div>
          )}
          {!entry.summary && !entry.solution && !entry.exprtRating && entry.daysOpen == null &&
            entry.products.length === 0 && !entry.cvssVersion && !entry.externalStatus &&
            !entry.redhatImpact && (
            <p className="italic text-slate-400">{t("vulnImport.entry.noDetails")}</p>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main page ──────────────────────────────────────────────────────────────

export default function VulnImportBatchDetailPage() {
  const { t } = useLanguage();
  const { canManageSecurity } = useAuth();
  const params = useParams();
  const router = useRouter();
  const batchId = params.id as string;

  const [batch, setBatch] = useState<VulnImportBatch | null>(null);
  const [entries, setEntries] = useState<VulnImportEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [ciOptions, setCiOptions] = useState<CiOption[]>([]);
  const [ciLoading, setCiLoading] = useState(false);

  const [activeTab, setActiveTab] = useState<TabKey>("all");
  const [pendingEntryIds, setPendingEntryIds] = useState<Set<string>>(new Set());
  const [bulkLoading, setBulkLoading] = useState(false);
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number } | null>(null);
  const [expandedEntryIds, setExpandedEntryIds] = useState<Set<string>>(new Set());
  const toggleExpanded = useCallback((id: string) => {
    setExpandedEntryIds((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }, []);

  const [showAcceptConfirm, setShowAcceptConfirm] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const [acceptResult, setAcceptResult] = useState<AcceptResponse | null>(null);
  const [blockingEntries, setBlockingEntries] = useState<VulnImportBlockingEntry[] | null>(null);

  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);
  const [discarding, setDiscarding] = useState(false);

  const [toasts, setToasts] = useState<Toast[]>([]);
  const addToast = useCallback((type: Toast["type"], message: string) => {
    const id = ++_toastId;
    setToasts((prev) => [...prev, { id, type, message }]);
    setTimeout(() => setToasts((prev) => prev.filter((x) => x.id !== id)), 5000);
  }, []);
  const dismissToast = useCallback((id: number) => setToasts((prev) => prev.filter((x) => x.id !== id)), []);

  // ── Data fetch ─────────────────────────────────────────────────────────

  const fetchBatch = useCallback(async () => {
    setLoading(true);
    setError(null);
    setNotFound(false);
    try {
      const res = await apiFetch(`/api/vuln-import/batches/${batchId}`);
      if (res.status === 404) {
        setNotFound(true);
        return;
      }
      const data = await res.json();
      if (!res.ok) throw new Error((data as VulnImportErrorResponse).error ?? `Error ${res.status}`);
      const detail = data as GetBatchDetailResponse;
      setBatch(detail.batch);
      setEntries(detail.entries);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("common.unknown_error"));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batchId]);

  useEffect(() => { fetchBatch(); }, [fetchBatch]);

  // CI list, loaded once — used both to resolve matched-CI names for display
  // and to power the reassignment picker's search. Small enough dataset
  // (same fetchAllCIs helper already used by /vulnerabilities and
  // AddRelationModal) that eager, one-shot loading is simpler and safer than
  // a debounced per-keystroke search endpoint.
  useEffect(() => {
    let cancelled = false;
    setCiLoading(true);
    fetchAllCIs<{ id: string; name: string; apiSlug: string }>()
      .then((rows) => { if (!cancelled) setCiOptions(rows); })
      .catch(() => { /* CI picker degrades to empty list; not fatal to the page */ })
      .finally(() => { if (!cancelled) setCiLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const ciMap = useMemo(() => new Map(ciOptions.map((c) => [c.id, c])), [ciOptions]);

  const canEdit = canManageSecurity && batch?.status === "PENDING";

  // ── Tab filtering (client-side, per spec — tabs are independent views) ──

  const tabCounts = useMemo(() => ({
    all: entries.length,
    actionable: entries.filter((e) => ACTIONABLE_SEVERITIES.includes(e.severity)).length,
    informational: entries.filter((e) => INFORMATIONAL_SEVERITIES.includes(e.severity)).length,
    attention: entries.filter((e) => ATTENTION_CONFIDENCES.includes(e.matchConfidence)).length,
    reappeared: entries.filter((e) => e.classification === "REAPARECIDA").length,
  }), [entries]);

  const filteredEntries = useMemo(() => {
    switch (activeTab) {
      case "actionable": return entries.filter((e) => ACTIONABLE_SEVERITIES.includes(e.severity));
      case "informational": return entries.filter((e) => INFORMATIONAL_SEVERITIES.includes(e.severity));
      case "attention": return entries.filter((e) => ATTENTION_CONFIDENCES.includes(e.matchConfidence));
      case "reappeared": return entries.filter((e) => e.classification === "REAPARECIDA");
      default: return entries;
    }
  }, [entries, activeTab]);

  // ── Per-entry decision toggle (optimistic, rollback on failure — same
  //    pattern as /vulnerabilities' handleStatusChange) ──────────────────

  const handleToggleDecision = async (entry: VulnImportEntry) => {
    const newDecision: VulnImportDecision = entry.decision === "INCLUDE" ? "EXCLUDE" : "INCLUDE";
    const previous = entry.decision;
    setEntries((prev) => prev.map((e) => (e.id === entry.id ? { ...e, decision: newDecision } : e)));
    setPendingEntryIds((prev) => new Set(prev).add(entry.id));
    try {
      const res = await apiFetch(`/api/vuln-import/batches/${batchId}/entries/${entry.id}`, {
        method: "PATCH",
        body: JSON.stringify({ decision: newDecision }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error((d as VulnImportErrorResponse).error ?? `Error ${res.status}`);
      }
    } catch (e) {
      setEntries((prev) => prev.map((x) => (x.id === entry.id ? { ...x, decision: previous } : x)));
      addToast("error", `${t("vulnImport.errors.patchFailed")} ${e instanceof Error ? e.message : t("common.unknown_error")}`);
    } finally {
      setPendingEntryIds((prev) => { const n = new Set(prev); n.delete(entry.id); return n; });
    }
  };

  const handleReassignCi = async (entry: VulnImportEntry, ciId: string) => {
    const previous = { ciId: entry.ciId, matchConfidence: entry.matchConfidence, matchCandidates: entry.matchCandidates };
    setEntries((prev) => prev.map((e) => (e.id === entry.id ? { ...e, ciId, matchConfidence: "MANUAL", matchCandidates: null } : e)));
    setPendingEntryIds((prev) => new Set(prev).add(entry.id));
    try {
      const res = await apiFetch(`/api/vuln-import/batches/${batchId}/entries/${entry.id}`, {
        method: "PATCH",
        body: JSON.stringify({ ciId }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((d as VulnImportErrorResponse).error ?? `Error ${res.status}`);
      addToast("success", t("vulnImport.entry.reassignSuccess"));
    } catch (e) {
      setEntries((prev) => prev.map((x) => (x.id === entry.id ? { ...x, ...previous } : x)));
      addToast("error", `${t("vulnImport.errors.patchFailed")} ${e instanceof Error ? e.message : t("common.unknown_error")}`);
    } finally {
      setPendingEntryIds((prev) => { const n = new Set(prev); n.delete(entry.id); return n; });
    }
  };

  const [createCiForEntry, setCreateCiForEntry] = useState<VulnImportEntry | null>(null);

  const handleCiCreated = (entry: VulnImportEntry, ci: { id: string; name: string }) => {
    setCreateCiForEntry(null);
    void handleReassignCi(entry, ci.id);
  };

  // ── Bulk decision on the currently-visible (tab-filtered) entries ───────
  //
  // Where the tab's criterion is representable by BulkDecisionBody's filter
  // vocabulary (schemas.ts BulkDecisionSchema: classification / severity —
  // each a SINGLE value, no matchConfidence key at all), we call the real
  // bulk-decision endpoint (possibly more than once, one call per underlying
  // value, since "actionable"/"informational" are unions of several severity
  // values). For "attention" (matchConfidence-based — not representable at
  // all server-side) and "all" (no single filter maps to "everything"), we
  // fall back to per-entry PATCH calls against exactly the entries currently
  // visible in that tab. Either way the effect is identical: only the
  // currently-visible set changes.

  const postBulk = async (filter: Record<string, string>, decision: VulnImportDecision) => {
    const res = await apiFetch(`/api/vuln-import/batches/${batchId}/entries/bulk-decision`, {
      method: "POST",
      body: JSON.stringify({ filter, decision }),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      throw new Error((d as VulnImportErrorResponse).error ?? `Error ${res.status}`);
    }
  };

  // Bounded-concurrency chunk size for the per-entry PATCH fallback (path b —
  // "attention"/"all" tabs, not representable by the server's bulk-decision
  // filter vocabulary). A real batch can have hundreds of entries; firing
  // them all at once as a single Promise.all is a robustness gap against an
  // admin-gated write endpoint. Kept modest and not user-configurable —
  // this doesn't need a queue library, just bounded concurrency.
  const BULK_PATCH_CHUNK_SIZE = 8;

  const handleBulk = async (decision: VulnImportDecision) => {
    setBulkLoading(true);
    setBulkProgress(null);
    let failedCount = 0;
    try {
      if (activeTab === "reappeared") {
        await postBulk({ classification: "REAPARECIDA" }, decision);
      } else if (activeTab === "actionable") {
        for (const sev of ACTIONABLE_SEVERITIES) await postBulk({ severity: sev }, decision);
      } else if (activeTab === "informational") {
        for (const sev of INFORMATIONAL_SEVERITIES) await postBulk({ severity: sev }, decision);
      } else {
        const targets = filteredEntries.filter((e) => e.decision !== decision);
        setBulkProgress({ done: 0, total: targets.length });
        for (let i = 0; i < targets.length; i += BULK_PATCH_CHUNK_SIZE) {
          const chunk = targets.slice(i, i + BULK_PATCH_CHUNK_SIZE);
          // Promise.allSettled (not Promise.all): a single rejected/failed
          // PATCH in a chunk must not abort the remaining chunks — those
          // entries may otherwise never even be attempted, and whatever
          // already-in-flight requests in THIS chunk succeeded server-side
          // regardless of a sibling's outcome (finding #1).
          const results = await Promise.allSettled(chunk.map((e) =>
            apiFetch(`/api/vuln-import/batches/${batchId}/entries/${e.id}`, {
              method: "PATCH",
              body: JSON.stringify({ decision }),
            })
          ));
          for (const r of results) {
            if (r.status === "rejected" || !r.value.ok) failedCount += 1;
          }
          setBulkProgress({ done: Math.min(i + chunk.length, targets.length), total: targets.length });
        }
      }
      if (failedCount > 0) {
        throw new Error(t("vulnImport.errors.bulkFailed").replace(/:$/, "") + ` (${failedCount})`);
      }
      addToast("success", t("vulnImport.bulk.doneToast"));
    } catch (e) {
      addToast("error", `${t("vulnImport.errors.bulkFailed")} ${e instanceof Error ? e.message : t("common.unknown_error")}`);
    } finally {
      // Unconditional resync (success OR partial/total failure): whichever
      // entries actually got persisted server-side must be reflected on
      // screen — a stale on-screen state that no longer matches the server
      // is worse than an error toast alone (finding #1).
      await fetchBatch();
      setBulkLoading(false);
      setBulkProgress(null);
    }
  };

  // ── Accept / discard ─────────────────────────────────────────────────────

  const includedEntries = useMemo(() => entries.filter((e) => e.decision === "INCLUDE"), [entries]);
  const acceptPreview = useMemo(() => {
    const ciSet = new Set(includedEntries.map((e) => e.ciId).filter((x): x is string => !!x));
    return {
      total: includedEntries.length,
      newCount: includedEntries.filter((e) => e.classification === "NUEVA").length,
      reopenedCount: includedEntries.filter((e) => e.classification === "REAPARECIDA").length,
      existingCount: includedEntries.filter((e) => e.classification === "EXISTENTE_PENDIENTE").length,
      ciCount: ciSet.size,
      unresolvedCount: includedEntries.filter((e) => e.matchConfidence === "AMBIGUOUS" || e.matchConfidence === "UNMATCHED").length,
    };
  }, [includedEntries]);

  const handleAccept = async () => {
    setAccepting(true);
    setBlockingEntries(null);
    try {
      const res = await apiFetch(`/api/vuln-import/batches/${batchId}/accept`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 422 && (data as UnresolvedMatchesLike).error === "UNRESOLVED_MATCHES") {
          setBlockingEntries((data as UnresolvedMatchesLike).entries ?? []);
          setShowAcceptConfirm(false);
          setActiveTab("attention");
          addToast("error", t("vulnImport.accept.blockingTitle"));
          return;
        }
        throw new Error((data as VulnImportErrorResponse).error ?? `Error ${res.status}`);
      }
      setAcceptResult(data as AcceptResponse);
      setShowAcceptConfirm(false);
      addToast("success", t("vulnImport.accept.successTitle"));
      fetchBatch();
    } catch (e) {
      addToast("error", `${t("vulnImport.errors.acceptFailed")} ${e instanceof Error ? e.message : t("common.unknown_error")}`);
    } finally {
      setAccepting(false);
    }
  };

  const handleDiscard = async () => {
    setDiscarding(true);
    try {
      const res = await apiFetch(`/api/vuln-import/batches/${batchId}/discard`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data as VulnImportErrorResponse).error ?? `Error ${res.status}`);
      setShowDiscardConfirm(false);
      addToast("success", t("vulnImport.discard.successToast"));
      fetchBatch();
    } catch (e) {
      addToast("error", `${t("vulnImport.errors.discardFailed")} ${e instanceof Error ? e.message : t("common.unknown_error")}`);
    } finally {
      setDiscarding(false);
    }
  };

  // ── Render ──────────────────────────────────────────────────────────────

  if (notFound) {
    return (
      <div className="min-h-screen bg-slate-50">
        <div className="mx-auto max-w-xl px-8 py-24 text-center">
          <AlertCircle className="mx-auto mb-4 h-10 w-10 text-red-400" />
          <p className="text-sm font-medium text-slate-700">{t("vulnImport.detail.notFound")}</p>
          <p className="mt-1 text-xs text-slate-500">{t("vulnImport.detail.notFoundHint")}</p>
          <button
            onClick={() => router.push("/vulnerabilities/imports")}
            className="mt-6 inline-flex items-center gap-1.5 rounded-none border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
          >
            <ChevronLeft className="h-4 w-4" />
            {t("vulnImport.actions.backToList")}
          </button>
        </div>
      </div>
    );
  }

  const readOnly = !canEdit;

  const TABS: { key: TabKey; label: string }[] = [
    { key: "all", label: t("vulnImport.tabs.all") },
    { key: "actionable", label: t("vulnImport.tabs.actionable") },
    { key: "informational", label: t("vulnImport.tabs.informational") },
    { key: "attention", label: t("vulnImport.tabs.attention") },
    { key: "reappeared", label: t("vulnImport.tabs.reappeared") },
  ];

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Toast notifications */}
      {toasts.length > 0 && (
        <div className="fixed bottom-6 right-6 z-50 flex w-80 flex-col gap-2" role="region" aria-label={t("vulnImport.detail.notificationsRegion")}>
          {toasts.map((toast) => (
            <div
              key={toast.id}
              className={`flex items-start gap-3 rounded-none px-4 py-3 shadow-lg ring-1 transition-all ${
                toast.type === "error" ? "bg-red-50 ring-red-200 text-red-800" : "bg-emerald-50 ring-emerald-200 text-emerald-800"
              }`}
              role="alert"
            >
              {toast.type === "error" ? <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-red-500" /> : <CheckCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-emerald-500" />}
              <p className="flex-1 text-xs font-medium">{toast.message}</p>
              <button onClick={() => dismissToast(toast.id)} className="flex-shrink-0 rounded p-0.5 hover:bg-black/10" aria-label={t("vulnImport.detail.closeNotification")}>
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white px-8 py-5">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <button
              onClick={() => router.push("/vulnerabilities/imports")}
              className="mb-1 flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
              {t("vulnImport.actions.backToList")}
            </button>
            <div className="flex items-center gap-3">
              <h1 className="truncate text-xl font-bold text-slate-900">
                {batch?.filename ?? t("vulnImport.detail.title")}
              </h1>
              {batch && (
                <span className={`rounded-none px-2 py-0.5 text-xs font-semibold ${BATCH_STATUS_STYLES[batch.status]}`}>
                  {t(`vulnImport.batch.status.${batch.status}`)}
                </span>
              )}
            </div>
            <p className="mt-0.5 text-sm text-slate-500">
              {batch?.taskName ?? t("vulnImport.detail.subtitle")}
            </p>
          </div>

          <div className="flex flex-shrink-0 items-center gap-2">
            <button
              onClick={() => fetchBatch()}
              className="flex items-center gap-2 rounded-none border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
              {t("actions.refresh")}
            </button>
            {canEdit && (
              <>
                <button
                  onClick={() => setShowDiscardConfirm(true)}
                  className="flex items-center gap-2 rounded-none border border-red-300 bg-white px-3 py-2 text-xs font-medium text-red-600 hover:bg-red-50"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  {t("vulnImport.discard.button")}
                </button>
                <button
                  onClick={() => setShowAcceptConfirm(true)}
                  className="flex items-center gap-2 rounded-none bg-[var(--accent)] px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-[var(--accent)]/90"
                >
                  <PackageCheck className="h-4 w-4" />
                  {t("vulnImport.accept.button")}
                </button>
              </>
            )}
          </div>
        </div>
      </header>

      <div className="w-full space-y-8 px-8 py-8">
        {error && (
          <div className="flex items-center gap-2 rounded-none border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
            <AlertCircle className="h-4 w-4 flex-shrink-0" />
            {error}
            <button onClick={() => setError(null)} className="ml-auto text-xs underline">{t("common.close")}</button>
          </div>
        )}

        {loading && !batch ? (
          <div className="flex items-center justify-center gap-2 p-16 text-slate-400">
            <RefreshCw className="h-5 w-5 animate-spin" />
            <span>{t("common.loading_data")}</span>
          </div>
        ) : batch ? (
          <>
            {readOnly && (
              <div className="flex items-center gap-2 rounded-none border border-slate-200 bg-slate-100 px-4 py-3 text-sm text-slate-600 ring-1 ring-slate-200">
                <Info className="h-4 w-4 flex-shrink-0" />
                {batch.status === "PENDING" ? t("vulnImport.detail.readOnlyNoAdmin") : t("vulnImport.detail.readOnlyNotice")}
              </div>
            )}

            {acceptResult && (
              <div className="rounded-none bg-white p-5 shadow-sm ring-1 ring-emerald-200">
                <div className="mb-2 flex items-center gap-2 text-emerald-700">
                  <CheckCircle className="h-5 w-5" />
                  <span className="font-semibold">{t("vulnImport.accept.successTitle")}</span>
                </div>
                <div className="grid grid-cols-2 gap-3 text-sm text-slate-600 sm:grid-cols-4">
                  <div><p className="text-xs text-slate-400">{t("vulnImport.accept.previewCi")}</p><p className="text-lg font-bold text-slate-800">{acceptResult.ciCount}</p></div>
                  <div><p className="text-xs text-slate-400">{t("vulnImport.accept.previewNew")}</p><p className="text-lg font-bold text-slate-800">{acceptResult.newCount}</p></div>
                  <div><p className="text-xs text-slate-400">{t("vulnImport.accept.previewReopened")}</p><p className="text-lg font-bold text-slate-800">{acceptResult.reopenedCount}</p></div>
                  <div><p className="text-xs text-slate-400">{t("vulnImport.accept.previewRefreshed")}</p><p className="text-lg font-bold text-slate-800">{acceptResult.refreshedCount}</p></div>
                </div>
              </div>
            )}

            {blockingEntries && blockingEntries.length > 0 && (
              <div className="rounded-none bg-white p-5 shadow-sm ring-1 ring-red-200">
                <div className="mb-2 flex items-center gap-2 text-red-700">
                  <AlertTriangle className="h-5 w-5" />
                  <span className="font-semibold">{t("vulnImport.accept.blockingTitle")}</span>
                </div>
                <p className="mb-3 text-sm text-slate-600">{t("vulnImport.accept.blockingBody")}</p>
                <ul className="space-y-1 text-xs text-slate-600">
                  {blockingEntries.map((b) => (
                    <li key={b.id} className="flex items-center gap-2">
                      <span className="font-mono text-slate-400">{b.hostAddress}</span>
                      <span>·</span>
                      <span>{b.vulnKey}</span>
                      <span>·</span>
                      <ConfidencePill confidence={b.matchConfidence as MatchConfidence | null} t={t} />
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Batch metadata + summary */}
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <div className="rounded-none bg-white p-5 shadow-sm ring-1 ring-slate-200 md:col-span-2">
                <h2 className="mb-3 text-sm font-semibold text-slate-700">{t("vulnImport.detail.metadata")}</h2>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                  <dt className="text-slate-400">{t("vulnImport.detail.taskName")}</dt>
                  <dd className="text-slate-700">{batch.taskName ?? "—"}</dd>
                  <dt className="text-slate-400">{t("vulnImport.detail.scanRange")}</dt>
                  <dd className="text-slate-700">
                    {batch.scanStart ? new Date(batch.scanStart).toLocaleString() : "—"}
                    {" → "}
                    {batch.scanEnd ? new Date(batch.scanEnd).toLocaleString() : "—"}
                  </dd>
                  <dt className="text-slate-400">{t("vulnImport.detail.uploadedBy")}</dt>
                  <dd className="text-slate-700">{batch.uploadedBy}</dd>
                  <dt className="text-slate-400">{t("vulnImport.detail.createdAt")}</dt>
                  <dd className="text-slate-700">{new Date(batch.createdAt).toLocaleString()}</dd>
                  {batch.resolvedBy && (
                    <>
                      <dt className="text-slate-400">{t("vulnImport.detail.resolvedBy")}</dt>
                      <dd className="text-slate-700">{batch.resolvedBy}</dd>
                    </>
                  )}
                </dl>
              </div>
              <div className="rounded-none bg-white p-5 shadow-sm ring-1 ring-slate-200">
                <h2 className="mb-3 text-sm font-semibold text-slate-700">{t("vulnImport.detail.summary")}</h2>
                <ul className="space-y-1.5 text-xs">
                  <li className="flex justify-between"><span className="text-slate-500">{t("vulnImport.detail.entryCount")}</span><span className="font-semibold text-slate-800">{entries.length}</span></li>
                  <li className="flex justify-between"><span className="text-slate-500">{t("vulnImport.classification.NUEVA")}</span><span className="font-semibold text-slate-800">{entries.filter((e) => e.classification === "NUEVA").length}</span></li>
                  <li className="flex justify-between"><span className="text-slate-500">{t("vulnImport.classification.EXISTENTE_PENDIENTE")}</span><span className="font-semibold text-slate-800">{entries.filter((e) => e.classification === "EXISTENTE_PENDIENTE").length}</span></li>
                  <li className="flex justify-between"><span className="text-slate-500">{t("vulnImport.classification.REAPARECIDA")}</span><span className="font-semibold text-slate-800">{tabCounts.reappeared}</span></li>
                  <li className="flex justify-between border-t border-slate-100 pt-1.5"><span className="text-amber-600">{t("vulnImport.tabs.attention")}</span><span className="font-semibold text-amber-700">{tabCounts.attention}</span></li>
                </ul>
              </div>
            </div>

            {/* Tabs */}
            <div className="rounded-none bg-white shadow-sm ring-1 ring-slate-200">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-2">
                <div className="flex flex-wrap gap-1">
                  {TABS.map((tab) => (
                    <button
                      key={tab.key}
                      onClick={() => setActiveTab(tab.key)}
                      className={`rounded-none px-3 py-1.5 text-xs font-semibold transition-colors ${
                        activeTab === tab.key ? "bg-slate-800 text-white" : "text-slate-500 hover:bg-slate-100"
                      }`}
                    >
                      {tab.label} <span className="opacity-70">({tabCounts[tab.key]})</span>
                    </button>
                  ))}
                </div>
                {canEdit && filteredEntries.length > 0 && (
                  <div className="flex items-center gap-2">
                    {bulkLoading && bulkProgress && (
                      <span className="flex items-center gap-1.5 text-[11px] font-medium text-slate-500">
                        <RefreshCw className="h-3 w-3 animate-spin" />
                        {t("vulnImport.bulk.progress")
                          .replace("{done}", String(bulkProgress.done))
                          .replace("{total}", String(bulkProgress.total))}
                      </span>
                    )}
                    <button
                      disabled={bulkLoading}
                      onClick={() => handleBulk("INCLUDE")}
                      className="rounded-none border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-[11px] font-semibold text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"
                    >
                      {t("vulnImport.bulk.includeVisible")}
                    </button>
                    <button
                      disabled={bulkLoading}
                      onClick={() => handleBulk("EXCLUDE")}
                      className="rounded-none border border-slate-300 bg-white px-3 py-1.5 text-[11px] font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                    >
                      {t("vulnImport.bulk.excludeVisible")}
                    </button>
                  </div>
                )}
              </div>

              {filteredEntries.length === 0 ? (
                <div className="p-10 text-center text-sm text-slate-400">{t("common.no_results")}</div>
              ) : (
                <div>
                  {filteredEntries.map((entry) => (
                    <EntryRow
                      key={entry.id}
                      entry={entry}
                      ciMap={ciMap}
                      ciOptions={ciOptions}
                      ciLoading={ciLoading}
                      canEdit={canEdit}
                      onToggleDecision={handleToggleDecision}
                      onReassignCi={handleReassignCi}
                      onCreateCi={setCreateCiForEntry}
                      pending={pendingEntryIds.has(entry.id)}
                      expanded={expandedEntryIds.has(entry.id)}
                      onToggleExpand={() => toggleExpanded(entry.id)}
                      t={t}
                    />
                  ))}
                </div>
              )}
            </div>
          </>
        ) : null}
      </div>

      {/* Accept confirmation dialog */}
      {showAcceptConfirm && batch && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/40 px-4">
          <div className="w-full max-w-md rounded-none bg-white p-6 shadow-xl ring-1 ring-slate-200">
            <h3 className="mb-2 text-base font-bold text-slate-900">{t("vulnImport.accept.confirmTitle")}</h3>
            <p className="mb-4 text-sm text-slate-600">{t("vulnImport.accept.confirmBody")}</p>
            <dl className="mb-4 grid grid-cols-2 gap-2 text-xs">
              <dt className="text-slate-400">{t("vulnImport.accept.previewCi")}</dt><dd className="font-semibold text-slate-800">{acceptPreview.ciCount}</dd>
              <dt className="text-slate-400">{t("vulnImport.accept.previewNew")}</dt><dd className="font-semibold text-slate-800">{acceptPreview.newCount}</dd>
              <dt className="text-slate-400">{t("vulnImport.accept.previewReopened")}</dt><dd className="font-semibold text-slate-800">{acceptPreview.reopenedCount}</dd>
              <dt className="text-slate-400">{t("vulnImport.accept.previewIncluded")}</dt><dd className="font-semibold text-slate-800">{acceptPreview.total}</dd>
            </dl>
            {acceptPreview.unresolvedCount > 0 && (
              <div className="mb-4 flex items-start gap-2 rounded-none border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
                <span>{t("vulnImport.accept.unresolvedWarning").replace("{count}", String(acceptPreview.unresolvedCount))}</span>
              </div>
            )}
            <div className="flex justify-end gap-2">
              <button onClick={() => setShowAcceptConfirm(false)} disabled={accepting} className="rounded-none border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50">
                {t("actions.cancel")}
              </button>
              <button onClick={handleAccept} disabled={accepting} className="flex items-center gap-1.5 rounded-none bg-[var(--accent)] px-4 py-2 text-xs font-semibold text-white shadow-sm hover:bg-[var(--accent)]/90 disabled:opacity-50">
                {accepting && <RefreshCw className="h-3.5 w-3.5 animate-spin" />}
                {t("vulnImport.actions.confirmAccept")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Discard confirmation dialog */}
      {showDiscardConfirm && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/40 px-4">
          <div className="w-full max-w-md rounded-none bg-white p-6 shadow-xl ring-1 ring-slate-200">
            <h3 className="mb-2 text-base font-bold text-slate-900">{t("vulnImport.discard.confirmTitle")}</h3>
            <p className="mb-4 text-sm text-slate-600">{t("vulnImport.discard.confirmBody")}</p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setShowDiscardConfirm(false)} disabled={discarding} className="rounded-none border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50">
                {t("actions.cancel")}
              </button>
              <button onClick={handleDiscard} disabled={discarding} className="flex items-center gap-1.5 rounded-none border border-red-300 bg-red-50 px-4 py-2 text-xs font-semibold text-red-700 hover:bg-red-100 disabled:opacity-50">
                {discarding && <RefreshCw className="h-3.5 w-3.5 animate-spin" />}
                {t("vulnImport.actions.confirmDiscard")}
              </button>
            </div>
          </div>
        </div>
      )}

      {createCiForEntry && (
        <AddCIModal
          onClose={() => setCreateCiForEntry(null)}
          onCreated={(ci) => handleCiCreated(createCiForEntry, ci)}
          initialValues={{
            name: createCiForEntry.hostAddress,
            hostName: (createCiForEntry.raw as { hostname?: string } | null)?.hostname ?? "",
            adminIp: /^\d+\.\d+\.\d+\.\d+$/.test(createCiForEntry.hostAddress) ? createCiForEntry.hostAddress : "",
          }}
        />
      )}
    </div>
  );
}

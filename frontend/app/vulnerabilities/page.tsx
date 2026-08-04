"use client";

import { useEffect, useState, useCallback } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import { Shield, RefreshCw, AlertTriangle, Search, Download, FilterX, X, CheckCircle, Upload, ChevronLeft, ChevronRight } from "lucide-react";
import { apiFetch } from "@/lib/apiFetch";
import { useAuth } from "@/contexts/AuthContext";
import { useLanguage } from "@/contexts/LanguageContext";
import type { VulnSeverity, VulnStatus } from "@/lib/types/vulnImport";

// Real production bug (found live, post-v3.7.0): this page used to fetch
// EVERY CI (fetchAllCIs) with its full `vulnerabilities` JSON array and
// flatten all of them client-side — fine at hundreds of rows, but the
// browser hung once a real Red Hat Lightspeed batch pushed the CMDB to
// 458,043 vulnerabilities across 290 CIs. Filtering, pagination, and the
// severity/status summary counts all moved server-side
// (GET /api/vulnerabilities, /summary, /export — backend/src/index.ts,
// "Vulnerability Lifecycle" section) — this page now only ever holds one
// page's worth of rows in memory.
const PAGE_SIZE = 50;

// ─── Types ────────────────────────────────────────────────────────────────────
//
// VulnSeverity/VulnStatus are imported from frontend/lib/types/vulnImport.ts
// (single source of truth, mirrors backend/src/modules/integrations/types.ts)
// rather than hand-maintained locally — do not redeclare them here.

interface Vulnerability {
  cve:         string;
  severity:    VulnSeverity;
  description: string;
  source?:     string;
  cvss_score?: number | null;
  status:      VulnStatus;
  importedAt?: string;
  updatedAt?:  string;
  // Greenbone real-format fields (v3.6.0) — optional so legacy manually-
  // entered vulnerabilities (no `key`/`oid`/etc.) remain valid.
  key?:        string;
  oid?:        string;
  port?:       string;
  cves?:       string[];
  lastSeenAt?: string;
  resolvedAt?: string;
  reopenedAt?: string;
  qod?:        number;
  family?:     string;
  solution?:   string;
  epssScore?:  number;
  // Vulnerability owner assignment (v3.7.0 responsable phase) — optional so
  // legacy stored vulnerabilities (no assignment yet) remain valid.
  assignedTo?: string;  // user id
  assignedAt?: string;  // ISO date
  assignedBy?: string;  // user id of whoever made the assignment
}

// GET /api/vulnerabilities/assignable-users (Task 19) — ADMIN/SOC accounts
// only, no email (minimisation), `{ id, displayName }` per shared/queries
// pattern (see staff-schedule/queries.ts).
interface AssignableUser {
  id:          string;
  displayName: string;
}

interface VulnRow extends Vulnerability {
  ciId:   string;
  ciName: string;
  ciSlug: string;
}

// ─── Style maps ───────────────────────────────────────────────────────────────

const SEVERITY_STYLES: Record<VulnSeverity, string> = {
  CRITICAL: "bg-red-100 text-red-700 ring-red-200",
  HIGH:     "bg-orange-100 text-orange-700 ring-orange-200",
  MEDIUM:   "bg-yellow-100 text-yellow-700 ring-yellow-200",
  LOW:      "bg-slate-100 text-slate-600 ring-slate-200",
  INFO:     "bg-slate-50 text-slate-400 ring-slate-100",
};

const STATUS_PILL: Record<VulnStatus, string> = {
  NUEVO:     "bg-blue-100 text-blue-700",
  ASIGNADO:  "bg-purple-100 text-purple-700",
  EN_CURSO:  "bg-yellow-100 text-yellow-700",
  PARADO:    "bg-orange-100 text-orange-700",
  RESUELTO:  "bg-emerald-100 text-emerald-700",
  // Distinct amber treatment (spec D6): a RESUELTO vulnerability that
  // reappeared in a later scan — must read as visually different from a
  // fresh NUEVO so an operator immediately notices "this came back".
  REABIERTA: "bg-amber-100 text-amber-800",
};

// Used for the filter dropdown and the status pill lookup — includes every
// status a row can hold, including the system-computed REABIERTA.
const ALL_STATUSES: VulnStatus[] = ["NUEVO", "ASIGNADO", "EN_CURSO", "PARADO", "RESUELTO", "REABIERTA"];

// Used for the per-row manual status-change <select>. REABIERTA is excluded
// on purpose: it is only ever set by the batch-accept workflow when a
// resolved vulnerability reappears (backend/src/index.ts PATCH
// /api/vulnerabilities `validStatuses` also rejects it as a manual target) —
// offering it here would let an operator pick a value the API 400s on.
const EDITABLE_STATUSES: VulnStatus[] = ALL_STATUSES.filter((s) => s !== "REABIERTA");

// ─── Summary count bar ────────────────────────────────────────────────────────

function SeverityDot({ severity }: { severity: VulnSeverity }) {
  const colors: Record<VulnSeverity, string> = {
    CRITICAL: "bg-red-500", HIGH: "bg-orange-400", MEDIUM: "bg-yellow-400", LOW: "bg-slate-300", INFO: "bg-slate-200",
  };
  return <span className={`inline-block h-2.5 w-2.5 rounded-full flex-shrink-0 ${colors[severity]}`} />;
}

// ─── Toast notification ───────────────────────────────────────────────────────

interface Toast {
  id:      number;
  type:    "error" | "success";
  message: string;
}

let _toastId = 0;

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function VulnerabilitiesPage() {
  const { t } = useLanguage();
  // Task 20: PATCH /api/vulnerabilities is now gated server-side to
  // ADMIN/SOC (requireSecurityWrite) — the per-row status <select> must not
  // let anyone else attempt a change the API will now 403 anyway. Same
  // flag already used to gate write actions in the sibling
  // vulnerabilities/imports pages of this module.
  const { user, canManageSecurity } = useAuth();

  // `rows` holds only the CURRENT PAGE — never the whole filtered set, let
  // alone the whole CMDB. `total` is the server-computed count for the
  // active filter (used for pagination math and the footer), independent of
  // `summary` below (which is always the GLOBAL, unfiltered counts — same
  // semantics the old client-side `counts` had, computed over `allRows`
  // before this fix, never over the current filter).
  const [rows, setRows]       = useState<VulnRow[]>([]);
  const [total, setTotal]     = useState(0);
  const [page, setPage]       = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);
  const [filters, setFilters] = useState({ search: "", cve: "", severity: "ALL", status: "ALL", source: "", assignedTo: "" });
  const [summary, setSummary] = useState({ critical: 0, high: 0, medium: 0, low: 0, info: 0, resuelto: 0, open: 0, total: 0 });
  // Task 21: assignable users for the owner picker/column/filter (Task 19's
  // GET /api/vulnerabilities/assignable-users — ADMIN/AUDITOR/SOC readable).
  // Fetched once on mount; a non-privileged VIEWER simply gets a 403 here,
  // swallowed silently, leaving the list empty (its column/filter fall back
  // to raw ids rather than crashing — see resolveAssignee below).
  const [assignableUsers, setAssignableUsers] = useState<AssignableUser[]>([]);
  const [updating, setUpdating] = useState<Set<string>>(new Set());
  const [toasts, setToasts]   = useState<Toast[]>([]);
  const [exporting, setExporting] = useState(false);

  const addToast = useCallback((type: Toast["type"], message: string) => {
    const id = ++_toastId;
    setToasts((prev) => [...prev, { id, type, message }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 5000);
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const activeFilterCount = Object.values(filters).filter((v) => v && v !== "ALL").length;
  const setFilter = (key: keyof typeof filters, val: string) =>
    setFilters((prev) => ({ ...prev, [key]: val }));
  const clearFilters = () =>
    setFilters({ search: "", cve: "", severity: "ALL", status: "ALL", source: "", assignedTo: "" });

  const buildFilterParams = useCallback(() => {
    const params = new URLSearchParams();
    if (filters.search) params.set("search", filters.search);
    if (filters.cve) params.set("cve", filters.cve);
    if (filters.severity !== "ALL") params.set("severity", filters.severity);
    if (filters.status !== "ALL") params.set("status", filters.status);
    if (filters.source) params.set("source", filters.source);
    if (filters.assignedTo) params.set("assignedTo", filters.assignedTo);
    return params;
  }, [filters]);

  const fetchPage = useCallback(async (targetPage: number) => {
    setLoading(true); setError(null);
    try {
      const params = buildFilterParams();
      params.set("page", String(targetPage));
      params.set("pageSize", String(PAGE_SIZE));
      const res = await apiFetch(`/api/vulnerabilities?${params.toString()}`);
      if (!res.ok) throw new Error(`Status ${res.status}`);
      const json = (await res.json()) as { data: VulnRow[]; total: number };
      setRows(json.data);
      setTotal(json.total);
    } catch (err) { setError(err instanceof Error ? err.message : t("common.unknown_error")); }
    finally { setLoading(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildFilterParams]);

  const fetchSummary = useCallback(async () => {
    try {
      const res = await apiFetch("/api/vulnerabilities/summary");
      if (res.ok) setSummary(await res.json());
    } catch {
      // Non-critical — the summary cards just stay at their previous values.
    }
  }, []);

  // Debounced text filters (search/cve) — everything else (severity/status/
  // source/assignedTo <select>s) fires immediately, same as before. Refetch
  // whenever the *effective* (debounced) filter set changes, always
  // resetting to page 1 — a filter change on page 5 must not silently keep
  // showing page 5 of a completely different result set.
  const [debouncedFilters, setDebouncedFilters] = useState(filters);
  useEffect(() => {
    const t = setTimeout(() => setDebouncedFilters(filters), 300);
    return () => clearTimeout(t);
  }, [filters]);

  useEffect(() => {
    setPage(1);
    fetchPage(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedFilters]);

  useEffect(() => { fetchSummary(); }, [fetchSummary]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const goToPage = (p: number) => {
    setPage(p);
    fetchPage(p);
  };

  const refresh = () => { fetchPage(page); fetchSummary(); };

  // Task 21: load the assignable-users list once. Only ADMIN/SOC can act on
  // it (the picker below is gated by canManageSecurity), but ADMIN/AUDITOR/SOC
  // can all read it (requireSecurityRead) — fetching unconditionally lets a
  // read-only AUDITOR still see resolved assignee names in the table/filter,
  // not just a raw id. A VIEWER without security-read access gets a 403,
  // swallowed here — the list simply stays empty for them.
  useEffect(() => {
    (async () => {
      try {
        const res = await apiFetch("/api/vulnerabilities/assignable-users");
        if (res.ok) setAssignableUsers(await res.json());
      } catch {
        // Not privileged to read this list — leave it empty.
      }
    })();
  }, []);

  // Resolves an `assignedTo` user id to its display name using the list
  // above. Returns `null` when there is no assignment at all (distinct from
  // an assignment that couldn't be resolved, e.g. list not loaded for this
  // viewer's role — falls back to the raw id so it's never silently wrong).
  const resolveAssignee = useCallback((id?: string | null): string | null => {
    if (!id) return null;
    return assignableUsers.find((u) => u.id === id)?.displayName ?? id;
  }, [assignableUsers]);

  // RAG chat deep-link: ?cve=<cve-id> pre-fills the CVE filter. Server-side
  // filtering (this fix) means there's no longer any need to wait for rows
  // to be loaded first — setting the filter alone triggers its own fetch via
  // the debounced-filters effect above.
  const searchParams = useSearchParams();
  const router       = useRouter();
  useEffect(() => {
    const cve = searchParams.get("cve");
    if (!cve) return;
    setFilters((prev) => ({ ...prev, cve }));
    router.replace("/vulnerabilities", { scroll: false });
  }, [searchParams, router]);

  // A row's real identity is `key ?? cve` (spec D1/D1b, v3.6.0): ~96% of real
  // Greenbone findings carry no CVE, so keying by `cve` alone would silently
  // collapse many distinct rows sharing `cve === ""` into one. Mirrors the
  // backend's own resolution in PATCH /api/vulnerabilities (index.ts:
  // `const targetKey = key ?? cve`).
  const vulnIdentity = (v: { key?: string; cve: string }) => v.key ?? v.cve;

  const handleStatusChange = async (row: VulnRow, newStatus: VulnStatus) => {
    const identity   = vulnIdentity(row);
    const updateKey  = `${row.ciId}:${identity}`;

    // Capture previous status for rollback
    const previousStatus = rows.find(
      (r) => r.ciId === row.ciId && vulnIdentity(r) === identity
    )?.status;

    // Apply optimistic update immediately
    setRows((prev) =>
      prev.map((r) =>
        r.ciId === row.ciId && vulnIdentity(r) === identity ? { ...r, status: newStatus } : r
      )
    );
    setUpdating((prev) => new Set(prev).add(updateKey));

    try {
      const res = await apiFetch("/api/vulnerabilities", {
        method: "PATCH",
        // Send both fields — backend prefers `key`, falls back to `cve` for
        // legacy rows that never got a `key` (index.ts: `key ?? cve`).
        body:   JSON.stringify({ ciId: row.ciId, key: row.key, cve: row.cve, status: newStatus }),
      });

      if (!res.ok) {
        const ct = res.headers.get("content-type") ?? "";
        const msg = ct.includes("application/json")
          ? (await res.json()).error
          : `Error ${res.status}`;
        throw new Error(msg);
      }

      addToast("success", `${t("vulnerabilities.status_updated")} "${t(`vulnerabilities.status.${newStatus}`)}"`);
      void fetchSummary(); // status changed → global severity/status counts may have shifted
    } catch (err) {
      console.error("Failed to update status:", err);

      // Revert the optimistic update to the previous state
      if (previousStatus !== undefined) {
        setRows((prev) =>
          prev.map((r) =>
            r.ciId === row.ciId && vulnIdentity(r) === identity ? { ...r, status: previousStatus } : r
          )
        );
      }

      const errMsg = err instanceof Error ? err.message : t("common.unknown_error");
      addToast("error", `${t("vulnerabilities.update_failed")} ${errMsg}`);
    } finally {
      setUpdating((prev) => { const n = new Set(prev); n.delete(updateKey); return n; });
    }
  };

  // Task 21: assign/reassign/unassign a vulnerability's owner. Same
  // optimistic-update/rollback/toast shape as handleStatusChange above —
  // `newAssignee === null` unassigns (backend's `hasAssignmentChange` +
  // `assignedTo === null` branch, Task 20).
  const handleAssigneeChange = async (row: VulnRow, newAssignee: string | null) => {
    const identity  = vulnIdentity(row);
    const updateKey = `${row.ciId}:${identity}`;

    const previousAssignee = rows.find(
      (r) => r.ciId === row.ciId && vulnIdentity(r) === identity
    )?.assignedTo;

    setRows((prev) =>
      prev.map((r) =>
        r.ciId === row.ciId && vulnIdentity(r) === identity
          ? { ...r, assignedTo: newAssignee ?? undefined }
          : r
      )
    );
    setUpdating((prev) => new Set(prev).add(updateKey));

    try {
      const res = await apiFetch("/api/vulnerabilities", {
        method: "PATCH",
        body:   JSON.stringify({ ciId: row.ciId, key: row.key, cve: row.cve, assignedTo: newAssignee }),
      });

      if (!res.ok) {
        const ct = res.headers.get("content-type") ?? "";
        const msg = ct.includes("application/json")
          ? (await res.json()).error
          : `Error ${res.status}`;
        throw new Error(msg);
      }

      addToast(
        "success",
        newAssignee
          ? `${t("vulnerabilities.assignment_updated")} "${resolveAssignee(newAssignee)}"`
          : t("vulnerabilities.assignment_cleared")
      );
    } catch (err) {
      console.error("Failed to update assignee:", err);

      setRows((prev) =>
        prev.map((r) =>
          r.ciId === row.ciId && vulnIdentity(r) === identity
            ? { ...r, assignedTo: previousAssignee }
            : r
        )
      );

      const errMsg = err instanceof Error ? err.message : t("common.unknown_error");
      addToast("error", `${t("vulnerabilities.assignment_update_failed")} ${errMsg}`);
    } finally {
      setUpdating((prev) => { const n = new Set(prev); n.delete(updateKey); return n; });
    }
  };

  // CSV export now goes through GET /api/vulnerabilities/export — the same
  // filters as the current view, but never paginated (an export needs
  // everything the operator filtered down to, not one page). The backend
  // rejects (422) a filter broad enough to match more than 50,000 rows
  // rather than building a huge CSV string in memory — the same class of
  // bug this whole page's fix exists to close, just bounded instead of
  // eliminated, since a real "export everything" use case exists here in a
  // way it never did for the on-screen table.
  const handleExportCSV = async () => {
    setExporting(true);
    try {
      const res = await apiFetch(`/api/vulnerabilities/export?${buildFilterParams().toString()}`);
      if (!res.ok) {
        if (res.status === 422) {
          const body = await res.json().catch(() => ({}));
          addToast("error", t("vulnerabilities.export_too_many_rows", { total: body.total ?? "?", max: body.max ?? "?" }));
          return;
        }
        throw new Error(`Status ${res.status}`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `vulnerabilidades-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      addToast("error", err instanceof Error ? err.message : t("common.unknown_error"));
    } finally {
      setExporting(false);
    }
  };

  // Summary stats now come from GET /api/vulnerabilities/summary (server-
  // side aggregate over ALL vulnerabilities, unfiltered) — see the
  // `summary` state above. No client-side computation left.

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
          <div className="flex items-center gap-3">
            <Shield className="h-5 w-5 text-[var(--accent)]" />
            <div>
              <h1 className="text-xl font-bold text-slate-900">{t("vulnerabilities.title")}</h1>
              <p className="text-sm text-slate-500 mt-0.5">
                {loading
                  ? t("vulnerabilities.loading_records")
                  : t("vulnerabilities.header_subtitle", { total: summary.total, open: summary.open })}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Link
              href="/vulnerabilities/imports"
              className="flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50 transition-colors"
            >
              <Upload className="h-3.5 w-3.5" />{t("vulnImport.title")}
            </Link>
            <button onClick={refresh} className="flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50 transition-colors">
              <RefreshCw className="h-3.5 w-3.5" />{t("actions.refresh")}
            </button>
          </div>
        </div>
      </header>

      <div className="px-8 py-8 w-full space-y-6">
        {/* Summary cards — always global (unfiltered) totals from GET
            /api/vulnerabilities/summary, shown even while a page is loading
            since they don't depend on `rows`. */}
        {!error && (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
            {[
              { label: "CRITICAL", value: summary.critical, color: "bg-red-50 text-red-700 ring-red-200" },
              { label: "HIGH",     value: summary.high,     color: "bg-orange-50 text-orange-700 ring-orange-200" },
              { label: "MEDIUM",   value: summary.medium,   color: "bg-yellow-50 text-yellow-700 ring-yellow-200" },
              { label: "LOW",      value: summary.low,      color: "bg-slate-50 text-slate-600 ring-slate-200" },
              { label: "INFO",     value: summary.info,     color: "bg-slate-50 text-slate-400 ring-slate-100" },
              { label: t("vulnerabilities.open_label"),     value: summary.open,     color: "bg-[var(--accent)]/5 text-[var(--accent)] ring-[var(--accent)]/20" },
              { label: t("vulnerabilities.resolved_label"), value: summary.resuelto, color: "bg-emerald-50 text-emerald-700 ring-emerald-200" },
            ].map(({ label, value, color }) => (
              <div key={label} className={`px-4 py-3 ring-1 ring-inset ${color}`}>
                <p className="text-2xl font-bold">{value}</p>
                <p className="text-xs font-medium mt-0.5 text-slate-500">{label}</p>
              </div>
            ))}
          </div>
        )}

        {/* Table card */}
        <div className="bg-white shadow-sm ring-1 ring-slate-200 overflow-hidden">
          {/* Toolbar */}
          <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 px-6 py-4">
            {/* Active filter badge + clear button */}
            {activeFilterCount > 0 && (
              <>
                <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--accent)]/10 px-2.5 py-1 text-xs font-semibold text-[var(--accent)]">
                  <Search className="h-3 w-3" />
                  {activeFilterCount > 1
                    ? t("vulnerabilities.active_filter_plural", { count: activeFilterCount })
                    : t("vulnerabilities.active_filter", { count: activeFilterCount })}
                </span>
                <button
                  onClick={clearFilters}
                  className="flex items-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-medium text-red-600 hover:bg-red-100 transition-colors"
                >
                  <FilterX className="h-3.5 w-3.5" />{t("vulnerabilities.clear_filters")}
                </button>
              </>
            )}

            {/* CSV Export — exports the current FILTER (all matching rows,
                server-side, up to the 50,000-row cap), not just the loaded page. */}
            <button
              onClick={handleExportCSV}
              disabled={loading || exporting || total === 0}
              className="flex items-center gap-1.5 rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-100 transition-colors disabled:opacity-50 ml-auto order-last sm:order-none sm:ml-0"
            >
              {exporting ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
              {t("vulnerabilities.export_csv_count", { count: total })}
            </button>
          </div>

          {loading && (
            <div className="flex items-center justify-center py-20 text-slate-400">
              <RefreshCw className="mr-2 h-5 w-5 animate-spin" />
              <span className="text-sm">{t("vulnerabilities.loading_records")}</span>
            </div>
          )}

          {error && !loading && (
            <div className="flex flex-col items-center justify-center gap-2 py-16 text-red-500">
              <AlertTriangle className="h-8 w-8" />
              <p className="text-sm font-medium">{t("vulnerabilities.load_error")}</p>
              <p className="text-xs text-slate-400">{error}</p>
              <button onClick={refresh} className="mt-2 rounded-lg bg-red-50 px-4 py-1.5 text-xs font-medium text-red-600 hover:bg-red-100">{t("vulnerabilities.retry")}</button>
            </div>
          )}

          {!loading && !error && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  {/* Sort header row */}
                  <tr className="border-b border-slate-100 bg-slate-50 text-left">
                    <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wider text-slate-500">{t("vulnerabilities.col_ci_affected")}</th>
                    <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wider text-slate-500">{t("vulnerabilities.columns.cve")}</th>
                    <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wider text-slate-500">{t("vulnerabilities.columns.severity")}</th>
                    <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wider text-slate-500 max-w-xs">{t("vulnerabilities.columns.description")}</th>
                    <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wider text-slate-500">{t("vulnerabilities.columns.source")}</th>
                    <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wider text-slate-500">{t("vulnerabilities.columns.status")}</th>
                    <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wider text-slate-500">{t("vulnerabilities.columns.assignee")}</th>
                    <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wider text-slate-500">{t("vulnerabilities.col_imported")}</th>
                  </tr>
                  {/* Inline filter row */}
                  <tr className="border-b-2 border-[var(--accent)]/20 bg-[var(--accent)]/5">
                    {/* CI search */}
                    <td className="px-3 py-2">
                      <div className="relative">
                        <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                        <input
                          type="text"
                          placeholder={t("vulnerabilities.search_ci_placeholder")}
                          value={filters.search}
                          onChange={(e) => setFilter("search", e.target.value)}
                          className="w-full rounded-none border border-slate-200 bg-white py-1.5 pl-7 pr-2 text-xs text-slate-700 placeholder:text-slate-300 focus:border-[var(--accent)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]/20"
                        />
                      </div>
                    </td>
                    {/* CVE search */}
                    <td className="px-3 py-2">
                      <div className="relative">
                        <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                        <input
                          type="text"
                          placeholder={t("vulnerabilities.cve_placeholder")}
                          value={filters.cve}
                          onChange={(e) => setFilter("cve", e.target.value)}
                          className="w-full rounded-none border border-slate-200 bg-white py-1.5 pl-7 pr-2 text-xs text-slate-700 placeholder:text-slate-300 focus:border-[var(--accent)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]/20"
                        />
                      </div>
                    </td>
                    {/* Severity */}
                    <td className="px-3 py-2">
                      <select
                        value={filters.severity}
                        onChange={(e) => setFilter("severity", e.target.value)}
                        className={`w-full rounded-none border py-1.5 px-2 text-xs focus:border-[var(--accent)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]/20 ${
                          filters.severity !== "ALL"
                            ? "border-[var(--accent)] bg-[var(--accent)]/5 text-[var(--accent)] font-medium"
                            : "border-slate-200 bg-white text-slate-600"
                        }`}
                      >
                        <option value="ALL">{t("vulnerabilities.all_severities")}</option>
                        <option value="CRITICAL">CRITICAL</option>
                        <option value="HIGH">HIGH</option>
                        <option value="MEDIUM">MEDIUM</option>
                        <option value="LOW">LOW</option>
                        <option value="INFO">INFO</option>
                      </select>
                    </td>
                    {/* Description — no filter */}
                    <td className="px-3 py-2" />
                    {/* Source */}
                    <td className="px-3 py-2">
                      <select
                        value={filters.source}
                        onChange={(e) => setFilter("source", e.target.value)}
                        className={`w-full rounded-none border py-1.5 px-2 text-xs focus:border-[var(--accent)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]/20 ${
                          filters.source
                            ? "border-[var(--accent)] bg-[var(--accent)]/5 text-[var(--accent)] font-medium"
                            : "border-slate-200 bg-white text-slate-600"
                        }`}
                      >
                        <option value="">{t("vulnerabilities.all_sources")}</option>
                        <option value="manual">Manual</option>
                        <option value="greenbone">Greenbone</option>
                        <option value="crowdstrike">CrowdStrike</option>
                        <option value="redhat-lightspeed">Red Hat Lightspeed</option>
                      </select>
                    </td>
                    {/* Status */}
                    <td className="px-3 py-2">
                      <select
                        value={filters.status}
                        onChange={(e) => setFilter("status", e.target.value)}
                        className={`w-full rounded-none border py-1.5 px-2 text-xs focus:border-[var(--accent)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]/20 ${
                          filters.status !== "ALL"
                            ? "border-[var(--accent)] bg-[var(--accent)]/5 text-[var(--accent)] font-medium"
                            : "border-slate-200 bg-white text-slate-600"
                        }`}
                      >
                        <option value="ALL">{t("vulnerabilities.all_statuses")}</option>
                        {ALL_STATUSES.map((s) => (
                          <option key={s} value={s}>{t(`vulnerabilities.status.${s}`)}</option>
                        ))}
                      </select>
                    </td>
                    {/* Assignee */}
                    <td className="px-3 py-2">
                      <select
                        value={filters.assignedTo}
                        onChange={(e) => setFilter("assignedTo", e.target.value)}
                        className={`w-full rounded-none border py-1.5 px-2 text-xs focus:border-[var(--accent)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]/20 ${
                          filters.assignedTo
                            ? "border-[var(--accent)] bg-[var(--accent)]/5 text-[var(--accent)] font-medium"
                            : "border-slate-200 bg-white text-slate-600"
                        }`}
                      >
                        <option value="">{t("vulnerabilities.all_assignees")}</option>
                        {user && (
                          <option value="__me__">{t("vulnerabilities.assigned_to_me")}</option>
                        )}
                        <option value="__unassigned__">{t("vulnerabilities.unassigned")}</option>
                        {assignableUsers.map((u) => (
                          <option key={u.id} value={u.id}>{u.displayName}</option>
                        ))}
                      </select>
                    </td>
                    {/* Date — no filter */}
                    <td className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rows.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="py-16 text-center text-slate-400 text-sm">
                        {total === 0 && activeFilterCount === 0
                          ? t("vulnerabilities.no_vulns")
                          : t("vulnerabilities.no_vulns_filtered")}
                      </td>
                    </tr>
                  ) : (
                    rows.map((row, i) => {
                      const identity = vulnIdentity(row);
                      const key = `${row.ciId}:${identity}`;
                      const isUpdating = updating.has(key);
                      const pillClass = STATUS_PILL[row.status] ?? STATUS_PILL["NUEVO"];
                      const portFamily = [row.port && `${t("vulnerabilities.columns.port")} ${row.port}`, row.family]
                        .filter(Boolean)
                        .join(" · ");

                      return (
                        <tr key={`${row.ciId}-${identity}-${i}`} className="hover:bg-[var(--accent)]/5 transition-colors">
                          {/* CI */}
                          <td className="px-6 py-3">
                            <p className="font-medium text-slate-800">{row.ciName}</p>
                            <p className="text-xs text-slate-400 font-mono">{row.ciSlug}</p>
                          </td>

                          {/* CVE */}
                          <td className="px-6 py-3">
                            <code className="text-xs font-mono text-[var(--accent)] bg-[var(--accent)]/5 px-1.5 py-0.5">
                              {row.cve || "—"}
                            </code>
                            {row.cvss_score != null && (
                              <p className="text-[11px] text-slate-400 mt-0.5">CVSS {row.cvss_score}</p>
                            )}
                            {portFamily && (
                              <p className="text-[11px] text-slate-400 mt-0.5">{portFamily}</p>
                            )}
                          </td>

                          {/* Severity */}
                          <td className="px-6 py-3">
                            <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset ${SEVERITY_STYLES[row.severity]}`}>
                              <SeverityDot severity={row.severity} />
                              {row.severity}
                            </span>
                          </td>

                          {/* Description */}
                          <td className="px-6 py-3 max-w-xs">
                            <p className="text-xs text-slate-600 line-clamp-2">{row.description}</p>
                          </td>

                          {/* Source */}
                          <td className="px-6 py-3">
                            <span className="text-xs text-slate-500 capitalize">{row.source ?? "manual"}</span>
                          </td>

                          {/* Status dropdown */}
                          <td className="px-6 py-3">
                            <div className="flex items-center gap-2">
                              <span className={`inline-block rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${pillClass}`}>
                                {t(`vulnerabilities.status.${row.status}`)}
                              </span>
                              {/* Task 20: PATCH /api/vulnerabilities now requires ADMIN/SOC
                                  (requireSecurityWrite) server-side — a VIEWER/AUDITOR/etc. would
                                  just get a 403 from this <select>, so it isn't offered at all;
                                  the pill above already shows the current status read-only. */}
                              {canManageSecurity ? (
                                <div className="relative flex items-center">
                                  <select
                                    value={row.status}
                                    disabled={isUpdating}
                                    onChange={(e) => handleStatusChange(row, e.target.value as VulnStatus)}
                                    className="rounded-none border border-slate-300 bg-white px-1.5 py-1 text-[11px] text-slate-600 focus:border-[var(--accent)] focus:outline-none disabled:opacity-50 disabled:cursor-wait"
                                  >
                                    {/* REABIERTA excluded — system-computed only, see EDITABLE_STATUSES comment above.
                                        If the row is currently REABIERTA (not in this list), the <select> still shows
                                        it correctly via `value={row.status}` even though it's not a selectable option. */}
                                    {EDITABLE_STATUSES.map((s) => (
                                      <option key={s} value={s}>{t(`vulnerabilities.status.${s}`)}</option>
                                    ))}
                                  </select>
                                  {isUpdating && (
                                    <RefreshCw
                                      className="absolute -right-5 h-3.5 w-3.5 animate-spin text-[var(--accent)]"
                                      aria-label={t("common.saving")}
                                    />
                                  )}
                                </div>
                              ) : null}
                            </div>
                          </td>

                          {/* Assignee (Task 21) — editable picker for ADMIN/SOC (same gate as
                              the status <select> above, Task 20's requireSecurityWrite); read-only
                              text for everyone else. */}
                          <td className="px-6 py-3">
                            {canManageSecurity ? (
                              <div className="relative flex items-center">
                                <select
                                  value={row.assignedTo ?? ""}
                                  disabled={isUpdating}
                                  onChange={(e) => handleAssigneeChange(row, e.target.value || null)}
                                  className="rounded-none border border-slate-300 bg-white px-1.5 py-1 text-[11px] text-slate-600 focus:border-[var(--accent)] focus:outline-none disabled:opacity-50 disabled:cursor-wait"
                                >
                                  <option value="">{t("vulnerabilities.unassigned")}</option>
                                  {assignableUsers.map((u) => (
                                    <option key={u.id} value={u.id}>{u.displayName}</option>
                                  ))}
                                </select>
                                {isUpdating && (
                                  <RefreshCw
                                    className="absolute -right-5 h-3.5 w-3.5 animate-spin text-[var(--accent)]"
                                    aria-label={t("common.saving")}
                                  />
                                )}
                              </div>
                            ) : (
                              <span className="text-xs text-slate-500">
                                {row.assignedTo ? resolveAssignee(row.assignedTo) : t("vulnerabilities.unassigned")}
                              </span>
                            )}
                          </td>

                          {/* Imported date */}
                          <td className="px-6 py-3 text-xs text-slate-400">
                            {row.importedAt
                              ? new Date(row.importedAt).toLocaleDateString("es-ES", { day: "2-digit", month: "short", year: "numeric" })
                              : "—"}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          )}

          {!loading && !error && total > 0 && (
            <div className="flex items-center justify-between border-t border-slate-100 px-6 py-3 text-xs text-slate-400">
              <span>{t("vulnerabilities.footer_showing", { filtered: rows.length, total })}</span>
              {totalPages > 1 && (
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => goToPage(Math.max(1, page - 1))}
                    disabled={page <= 1 || loading}
                    className="flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    <ChevronLeft className="h-3.5 w-3.5" />{t("vulnImport.list.prevPage")}
                  </button>
                  <span className="text-slate-500">{t("vulnerabilities.page_info", { page, totalPages, total })}</span>
                  <button
                    onClick={() => goToPage(Math.min(totalPages, page + 1))}
                    disabled={page >= totalPages || loading}
                    className="flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    {t("vulnImport.list.nextPage")}<ChevronRight className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

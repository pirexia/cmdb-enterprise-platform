"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  PowerOff, RefreshCw, AlertCircle, ChevronLeft, Zap,
  FileText, FileCheck, Key, Printer, Play, Check,
  AlertTriangle, Trash2, Plus, ChevronDown, ChevronRight,
} from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAuth } from "@/contexts/AuthContext";
import { apiFetch } from "@/lib/apiFetch";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Plan {
  id: string; name: string; system_ci_name: string; status: string;
  created_by: string; created_at: string; completed_at: string | null;
}

interface PlanCI {
  id: string; plan_id: string; ci_id: string; ci_name: string;
  ci_type_name: string | null; parent_ci_id: string | null;
  depth: number; is_shared: boolean;
  scheduled_date: string | null; notes: string | null;
  sort_order: number; dateWarning: boolean;
}

interface DocRow    { id: string; document_id: string; doc_name: string; doc_type: string | null; source: string; }
interface ContractRow { id: string; contract_id: string; contract_name: string; contract_ref: string | null; source: string; }
interface LicenseRow  { id: string; license_id: string; license_name: string; source: string; }

interface GanttTask {
  ci_id: string; ci_name: string; depth: number;
  scheduled_date: string | null; is_shared: boolean; parent_ci_id: string | null;
}

// ─── Gantt (SVG custom — no npm dependency) ───────────────────────────────────

function GanttChart({ tasks }: { tasks: GanttTask[] }) {
  const dated = tasks.filter(t => t.scheduled_date);
  if (dated.length === 0) return (
    <div className="text-center py-8 text-slate-500 text-sm">No hay fechas configuradas aún.</div>
  );

  const dates   = dated.map(t => new Date(t.scheduled_date!).getTime());
  const minDate = Math.min(...dates);
  const maxDate = Math.max(...dates);
  const range   = maxDate - minDate || 1;
  const ROW_H   = 32;
  const LABEL_W = 220;
  const CHART_W = 600;
  const totalH  = dated.length * ROW_H + 30;

  return (
    <div className="overflow-x-auto">
      <svg width={LABEL_W + CHART_W + 20} height={totalH} className="text-xs font-mono select-none">
        {/* grid lines */}
        {[0, 0.25, 0.5, 0.75, 1].map(pct => {
          const x = LABEL_W + pct * CHART_W;
          const d = new Date(minDate + pct * range);
          return (
            <g key={pct}>
              <line x1={x} y1={0} x2={x} y2={totalH - 20} stroke="#334155" strokeWidth={1} strokeDasharray="4 4" />
              <text x={x} y={totalH - 5} textAnchor="middle" fill="#64748b" fontSize={10}>
                {d.toLocaleDateString("es-ES", { day: "2-digit", month: "short" })}
              </text>
            </g>
          );
        })}

        {dated.map((t, i) => {
          const y     = i * ROW_H + 4;
          const xPct  = (new Date(t.scheduled_date!).getTime() - minDate) / range;
          const xBar  = LABEL_W + xPct * CHART_W;
          const barW  = Math.max(8, (1 - xPct) * CHART_W * 0.08);
          const color = t.is_shared ? "#f59e0b" : t.depth === 0 ? "#ef4444" : "#3b82f6";
          const indent = t.depth * 12;
          return (
            <g key={t.ci_id}>
              <text x={indent + 4} y={y + 16} fill="#cbd5e1" fontSize={11}
                style={{ fontFamily: "inherit" }}
                clipPath={`url(#lbl-${i})`}>
                {t.ci_name}
              </text>
              <clipPath id={`lbl-${i}`}>
                <rect x={indent} y={y} width={LABEL_W - indent - 8} height={ROW_H} />
              </clipPath>
              <rect x={xBar} y={y + 4} width={barW} height={ROW_H - 10}
                fill={color} rx={3} opacity={0.85} />
              <title>{t.ci_name} — {new Date(t.scheduled_date!).toLocaleDateString()}</title>
            </g>
          );
        })}
      </svg>
      <div className="flex gap-4 mt-2 text-xs text-slate-500">
        <span><span className="inline-block w-3 h-3 rounded-sm bg-red-500 mr-1 align-middle" />Sistema</span>
        <span><span className="inline-block w-3 h-3 rounded-sm bg-blue-500 mr-1 align-middle" />CI</span>
        <span><span className="inline-block w-3 h-3 rounded-sm bg-amber-500 mr-1 align-middle" />Compartido</span>
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function DecommissionDetailPage() {
  const { t } = useLanguage();
  const { user } = useAuth();
  const params = useParams();
  const router = useRouter();
  const planId = params.id as string;
  const isAdmin = user?.role === "ADMIN";

  const [plan,      setPlan]      = useState<Plan | null>(null);
  const [cis,       setCis]       = useState<PlanCI[]>([]);
  const [docs,      setDocs]      = useState<DocRow[]>([]);
  const [contracts, setContracts] = useState<ContractRow[]>([]);
  const [licenses,  setLicenses]  = useState<LicenseRow[]>([]);
  const [gantt,     setGantt]     = useState<GanttTask[]>([]);
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [warnings,   setWarnings]   = useState<string[]>([]);
  const [activeTab,  setActiveTab]  = useState<"inventory"|"gantt"|"documents"|"contracts"|"licenses">("inventory");
  const [editingCi,  setEditingCi]  = useState<string | null>(null);
  const [editDate,   setEditDate]   = useState("");
  const [editNotes,  setEditNotes]  = useState("");
  const [savingCi,   setSavingCi]   = useState(false);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const [planRes, cisRes, docsRes, contractsRes, licensesRes, ganttRes] = await Promise.all([
        apiFetch(`/api/decommission/plans/${planId}`),
        apiFetch(`/api/decommission/plans/${planId}/cis`),
        apiFetch(`/api/decommission/plans/${planId}/documents`),
        apiFetch(`/api/decommission/plans/${planId}/contracts`),
        apiFetch(`/api/decommission/plans/${planId}/licenses`),
        apiFetch(`/api/decommission/plans/${planId}/gantt`),
      ]);
      if (!planRes.ok) throw new Error("Plan not found");
      const [pd, cd, dd, ctd, ld, gd] = await Promise.all([
        planRes.json(), cisRes.json(), docsRes.json(),
        contractsRes.json(), licensesRes.json(), ganttRes.json(),
      ]);
      setPlan(pd.plan);
      setCis(cd.cis ?? []);
      setDocs(dd.documents ?? []);
      setContracts(ctd.contracts ?? []);
      setLicenses(ld.licenses ?? []);
      setGantt(gd.tasks ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error");
    } finally {
      setLoading(false);
    }
  }, [planId]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const handleGenerate = async () => {
    setGenerating(true);
    setWarnings([]);
    try {
      const res = await apiFetch(`/api/decommission/plans/${planId}/generate`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Error generating inventory");
      setWarnings(data.warnings ?? []);
      fetchAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error");
    } finally {
      setGenerating(false);
    }
  };

  const openEditCi = (ci: PlanCI) => {
    setEditingCi(ci.ci_id);
    setEditDate(ci.scheduled_date ? ci.scheduled_date.slice(0, 10) : "");
    setEditNotes(ci.notes ?? "");
  };

  const saveCiEdit = async () => {
    if (!editingCi) return;
    setSavingCi(true);
    try {
      await apiFetch(`/api/decommission/plans/${planId}/cis/${editingCi}`, {
        method: "PATCH",
        body: JSON.stringify({
          scheduledDate: editDate ? new Date(editDate).toISOString() : null,
          notes: editNotes || null,
        }),
      });
      setEditingCi(null);
      fetchAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error");
    } finally {
      setSavingCi(false);
    }
  };

  const handleRemoveDoc = async (docId: string) => {
    await apiFetch(`/api/decommission/plans/${planId}/documents/${docId}`, { method: "DELETE" });
    fetchAll();
  };
  const handleRemoveContract = async (cid: string) => {
    await apiFetch(`/api/decommission/plans/${planId}/contracts/${cid}`, { method: "DELETE" });
    fetchAll();
  };
  const handleRemoveLicense = async (lid: string) => {
    await apiFetch(`/api/decommission/plans/${planId}/licenses/${lid}`, { method: "DELETE" });
    fetchAll();
  };

  const handlePrint = () => window.print();

  if (loading) return (
    <div className="flex items-center gap-2 text-slate-400 p-8 justify-center">
      <RefreshCw className="h-5 w-5 animate-spin" />
      <span>{t("common.loading_data")}</span>
    </div>
  );

  if (!plan) return (
    <div className="p-8 text-center text-red-400">
      <AlertCircle className="h-8 w-8 mx-auto mb-2" />
      <p>{t("decommission.plan_not_found")}</p>
      <button onClick={() => router.push("/decommission")} className="mt-4 text-sm underline text-slate-400">
        {t("decommission.back_to_plans")}
      </button>
    </div>
  );

  const TABS = [
    { key: "inventory",  label: t("decommission.tab_inventory"),  icon: Zap },
    { key: "gantt",      label: t("decommission.tab_gantt"),       icon: ChevronRight },
    { key: "documents",  label: t("decommission.tab_documents"),   icon: FileText },
    { key: "contracts",  label: t("decommission.tab_contracts"),   icon: FileCheck },
    { key: "licenses",   label: t("decommission.tab_licenses"),    icon: Key },
  ] as const;

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6 print:p-0">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 print:hidden">
        <div className="flex items-center gap-3">
          <button onClick={() => router.push("/decommission")}
            className="flex items-center gap-1 text-sm text-slate-400 hover:text-slate-200 transition-colors">
            <ChevronLeft className="h-4 w-4" />
            {t("decommission.back_to_plans")}
          </button>
        </div>
        <div className="flex gap-2">
          {isAdmin && cis.length === 0 && (
            <button onClick={handleGenerate} disabled={generating}
              className="flex items-center gap-2 px-4 py-2 text-sm font-medium bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 transition-colors">
              <Play className="h-4 w-4" />
              {generating ? t("common.loading") : t("decommission.generate")}
            </button>
          )}
          {isAdmin && cis.length > 0 && (
            <button onClick={handleGenerate} disabled={generating}
              className="flex items-center gap-2 px-3 py-2 text-xs bg-slate-700/50 text-slate-400 rounded hover:bg-slate-700 transition-colors">
              <RefreshCw className="h-3.5 w-3.5" />
              {t("decommission.regenerate")}
            </button>
          )}
          <button onClick={handlePrint}
            className="flex items-center gap-2 px-3 py-2 text-sm bg-slate-700/50 text-slate-300 rounded hover:bg-slate-700 transition-colors">
            <Printer className="h-4 w-4" />
            {t("actions.print")}
          </button>
        </div>
      </div>

      {/* Plan header */}
      <div className="rounded-xl border border-white/8 bg-slate-800/40 p-5">
        <div className="flex items-center gap-3 mb-1">
          <PowerOff className="h-5 w-5 text-red-400" />
          <h1 className="text-xl font-bold text-slate-100">{plan.name}</h1>
          <span className={`px-2 py-0.5 text-[11px] font-semibold rounded ${
            plan.status === "ACTIVE"    ? "bg-blue-900/70 text-blue-300" :
            plan.status === "COMPLETED" ? "bg-green-900/70 text-green-300" :
            plan.status === "CANCELLED" ? "bg-red-900/70 text-red-300" :
            "bg-slate-700 text-slate-300"
          }`}>
            {t(`decommission.status_${plan.status.toLowerCase()}`)}
          </span>
        </div>
        <p className="text-sm text-slate-400">{t("decommission.col_system")}: <span className="text-slate-300">{plan.system_ci_name}</span></p>
      </div>

      {/* Errors / warnings */}
      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-900/20 px-4 py-3 text-sm text-red-400">
          <AlertCircle className="h-4 w-4 flex-shrink-0" />
          {error}
          <button onClick={() => setError(null)} className="ml-auto text-xs underline">{t("actions.close")}</button>
        </div>
      )}
      {warnings.length > 0 && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-900/20 px-4 py-3 text-sm text-amber-300">
          <div className="flex items-center gap-2 mb-1">
            <AlertTriangle className="h-4 w-4" />
            <span className="font-medium">{t("decommission.date_warnings")}</span>
          </div>
          <ul className="list-disc list-inside text-xs space-y-0.5 text-amber-400">
            {warnings.map(w => <li key={w}>{w}</li>)}
          </ul>
        </div>
      )}

      {/* Tabs */}
      <div className="border-b border-white/8 print:hidden">
        <div className="flex gap-1">
          {TABS.map(({ key, label, icon: Icon }) => (
            <button key={key} onClick={() => setActiveTab(key as typeof activeTab)}
              className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                activeTab === key
                  ? "border-red-500 text-red-400"
                  : "border-transparent text-slate-400 hover:text-slate-300"
              }`}>
              <Icon className="h-4 w-4" />
              {label}
              {key === "inventory"  && cis.length > 0       && <span className="ml-1 text-xs bg-slate-700 px-1.5 py-0.5 rounded-full">{cis.length}</span>}
              {key === "documents"  && docs.length > 0       && <span className="ml-1 text-xs bg-slate-700 px-1.5 py-0.5 rounded-full">{docs.length}</span>}
              {key === "contracts"  && contracts.length > 0  && <span className="ml-1 text-xs bg-slate-700 px-1.5 py-0.5 rounded-full">{contracts.length}</span>}
              {key === "licenses"   && licenses.length > 0   && <span className="ml-1 text-xs bg-slate-700 px-1.5 py-0.5 rounded-full">{licenses.length}</span>}
            </button>
          ))}
        </div>
      </div>

      {/* ── Inventory tab ── */}
      {activeTab === "inventory" && (
        <div className="space-y-2">
          {cis.length === 0 ? (
            <div className="text-center py-12 text-slate-500">
              <Zap className="h-8 w-8 mx-auto mb-2 opacity-30" />
              <p className="text-sm">{t("decommission.no_cis_yet")}</p>
              {isAdmin && <p className="text-xs mt-1 text-slate-600">{t("decommission.generate_hint")}</p>}
            </div>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-white/8">
              <table className="w-full text-sm">
                <thead className="bg-slate-800/60">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-slate-400 uppercase tracking-wider">{t("decommission.ci_name")}</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-slate-400 uppercase tracking-wider">{t("decommission.ci_type")}</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-slate-400 uppercase tracking-wider">{t("decommission.scheduled_date")}</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-slate-400 uppercase tracking-wider">{t("decommission.ci_shared")}</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody>
                  {cis.map(ci => (
                    <tr key={ci.ci_id}
                      className={`border-b border-white/5 transition-colors ${
                        ci.dateWarning ? "bg-red-900/10" :
                        ci.is_shared   ? "bg-amber-900/10" :
                        "hover:bg-white/3"
                      }`}>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1" style={{ paddingLeft: `${ci.depth * 16}px` }}>
                          {ci.depth > 0 && <ChevronRight className="h-3 w-3 text-slate-600 flex-shrink-0" />}
                          <span className={`font-medium ${ci.depth === 0 ? "text-red-400" : "text-slate-200"}`}>{ci.ci_name}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-slate-500 text-xs">{ci.ci_type_name ?? "—"}</td>
                      <td className="px-4 py-3">
                        {editingCi === ci.ci_id ? (
                          <div className="flex items-center gap-2">
                            <input type="date" value={editDate} onChange={e => setEditDate(e.target.value)}
                              className="rounded border border-white/10 bg-slate-800 px-2 py-1 text-xs text-slate-200 focus:outline-none focus:border-red-500" />
                            <button onClick={saveCiEdit} disabled={savingCi}
                              className="p-1 text-green-400 hover:bg-green-900/30 rounded">
                              <Check className="h-4 w-4" />
                            </button>
                          </div>
                        ) : (
                          <div className="flex items-center gap-1">
                            <span className={`text-xs ${ci.dateWarning ? "text-red-400 font-medium" : "text-slate-400"}`}>
                              {ci.scheduled_date ? new Date(ci.scheduled_date).toLocaleDateString() : "—"}
                            </span>
                            {ci.dateWarning && <span title={t("decommission.date_incoherent")}><AlertTriangle className="h-3.5 w-3.5 text-red-400" /></span>}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {ci.is_shared && (
                          <span className="inline-block px-2 py-0.5 text-[10px] font-semibold rounded bg-amber-900/60 text-amber-300">
                            {t("decommission.shared")}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {isAdmin && editingCi !== ci.ci_id && (
                          <button onClick={() => openEditCi(ci)}
                            className="text-xs text-slate-500 hover:text-slate-300 px-2 py-1 rounded hover:bg-white/5 transition-colors">
                            {t("actions.edit")}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── Gantt tab ── */}
      {activeTab === "gantt" && (
        <div className="rounded-xl border border-white/8 bg-slate-800/30 p-5">
          <GanttChart tasks={gantt} />
        </div>
      )}

      {/* ── Documents tab ── */}
      {activeTab === "documents" && (
        <LinkedItems
          items={docs}
          getId={d => d.document_id}
          getName={d => d.doc_name}
          getSource={d => d.source}
          onRemove={isAdmin ? (d => handleRemoveDoc(d.document_id)) : undefined}
          emptyKey="decommission.no_documents"
          t={t}
        />
      )}

      {/* ── Contracts tab ── */}
      {activeTab === "contracts" && (
        <LinkedItems
          items={contracts}
          getId={c => c.contract_id}
          getName={c => c.contract_name}
          getSource={c => c.source}
          onRemove={isAdmin ? (c => handleRemoveContract(c.contract_id)) : undefined}
          emptyKey="decommission.no_contracts"
          t={t}
        />
      )}

      {/* ── Licenses tab ── */}
      {activeTab === "licenses" && (
        <LinkedItems
          items={licenses}
          getId={l => l.license_id}
          getName={l => l.license_name}
          getSource={l => l.source}
          onRemove={isAdmin ? (l => handleRemoveLicense(l.license_id)) : undefined}
          emptyKey="decommission.no_licenses"
          t={t}
        />
      )}

      {/* Print-only: full plan */}
      <div className="hidden print:block space-y-6">
        <h2 className="text-lg font-bold">Inventario de CIs</h2>
        <table className="w-full text-xs border-collapse border border-slate-300">
          <thead><tr className="bg-slate-100">
            <th className="border border-slate-300 px-2 py-1 text-left">CI</th>
            <th className="border border-slate-300 px-2 py-1 text-left">Tipo</th>
            <th className="border border-slate-300 px-2 py-1 text-left">Fecha baja</th>
            <th className="border border-slate-300 px-2 py-1 text-left">Compartido</th>
          </tr></thead>
          <tbody>{cis.map(ci => (
            <tr key={ci.ci_id}>
              <td className="border border-slate-300 px-2 py-1" style={{ paddingLeft: `${8 + ci.depth * 12}px` }}>{ci.ci_name}</td>
              <td className="border border-slate-300 px-2 py-1">{ci.ci_type_name ?? "—"}</td>
              <td className="border border-slate-300 px-2 py-1">{ci.scheduled_date ? new Date(ci.scheduled_date).toLocaleDateString() : "—"}</td>
              <td className="border border-slate-300 px-2 py-1">{ci.is_shared ? "Sí" : "No"}</td>
            </tr>
          ))}</tbody>
        </table>
        {docs.length > 0 && <>
          <h2 className="text-lg font-bold mt-6">Documentos</h2>
          <ul className="text-xs list-disc list-inside">{docs.map(d => <li key={d.document_id}>{d.doc_name}</li>)}</ul>
        </>}
        {contracts.length > 0 && <>
          <h2 className="text-lg font-bold mt-6">Contratos</h2>
          <ul className="text-xs list-disc list-inside">{contracts.map(c => <li key={c.contract_id}>{c.contract_name}</li>)}</ul>
        </>}
        {licenses.length > 0 && <>
          <h2 className="text-lg font-bold mt-6">Licencias</h2>
          <ul className="text-xs list-disc list-inside">{licenses.map(l => <li key={l.license_id}>{l.license_name}</li>)}</ul>
        </>}
      </div>
    </div>
  );
}

// ─── Reusable linked-items panel ──────────────────────────────────────────────

function LinkedItems<T>({
  items, getId, getName, getSource, onRemove, emptyKey, t,
}: {
  items    : T[];
  getId    : (item: T) => string;
  getName  : (item: T) => string;
  getSource: (item: T) => string;
  onRemove?: (item: T) => void;
  emptyKey : string;
  t        : (k: string) => string;
}) {
  if (items.length === 0) return (
    <div className="text-center py-10 text-slate-500 text-sm">{t(emptyKey)}</div>
  );
  return (
    <div className="overflow-x-auto rounded-lg border border-white/8">
      <table className="w-full text-sm">
        <thead className="bg-slate-800/60">
          <tr>
            <th className="px-4 py-3 text-left text-xs font-semibold text-slate-400 uppercase tracking-wider">{t("decommission.col_name")}</th>
            <th className="px-4 py-3 text-left text-xs font-semibold text-slate-400 uppercase tracking-wider">{t("decommission.source")}</th>
            {onRemove && <th className="px-4 py-3" />}
          </tr>
        </thead>
        <tbody>
          {items.map(item => (
            <tr key={getId(item)} className="border-b border-white/5 hover:bg-white/3 transition-colors">
              <td className="px-4 py-3 text-slate-200">{getName(item)}</td>
              <td className="px-4 py-3">
                <span className={`inline-block px-2 py-0.5 text-[10px] font-semibold rounded ${
                  getSource(item) === "AUTO"
                    ? "bg-slate-700 text-slate-400"
                    : "bg-blue-900/60 text-blue-300"
                }`}>{getSource(item)}</span>
              </td>
              {onRemove && (
                <td className="px-4 py-3 text-right">
                  <button onClick={() => onRemove(item)}
                    className="p-1.5 text-red-500 hover:bg-red-900/30 rounded transition-colors">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { PowerOff, Plus, RefreshCw, AlertCircle, ChevronRight, Trash2 } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAuth } from "@/contexts/AuthContext";
import { apiFetch } from "@/lib/apiFetch";

interface Plan {
  id: string;
  name: string;
  system_ci_name: string;
  status: "DRAFT" | "ACTIVE" | "COMPLETED" | "CANCELLED";
  created_by: string;
  created_at: string;
}

const STATUS_CLS: Record<string, string> = {
  DRAFT:     "bg-slate-700 text-slate-300",
  ACTIVE:    "bg-blue-900/70 text-blue-300",
  COMPLETED: "bg-green-900/70 text-green-300",
  CANCELLED: "bg-red-900/70 text-red-300",
};

export default function DecommissionPage() {
  const { t } = useLanguage();
  const { user } = useAuth();
  const router = useRouter();

  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newCiId, setNewCiId] = useState("");
  const [newCiSearch, setNewCiSearch] = useState("");
  const [ciOptions, setCiOptions] = useState<{id: string; name: string}[]>([]);
  const [creating, setCreating] = useState(false);

  const isAdmin = user?.role === "ADMIN";

  const fetchPlans = async () => {
    setLoading(true);
    try {
      const res = await apiFetch("/api/decommission/plans");
      if (!res.ok) throw new Error("Error loading plans");
      const data = await res.json();
      setPlans(data.plans ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchPlans(); }, []);

  // Search SISTEMA CIs
  useEffect(() => {
    if (newCiSearch.length < 2) { setCiOptions([]); return; }
    const controller = new AbortController();
    apiFetch(`/api/cis?search=${encodeURIComponent(newCiSearch)}&ciType=SISTEMA&limit=10`, { signal: controller.signal })
      .then(r => r.json())
      .then(d => setCiOptions(d.cis ?? []))
      .catch(() => {});
    return () => controller.abort();
  }, [newCiSearch]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName || !newCiId) return;
    setCreating(true);
    try {
      const res = await apiFetch("/api/decommission/plans", {
        method: "POST",
        body: JSON.stringify({ name: newName, systemCiId: newCiId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Error creating plan");
      setShowCreate(false);
      setNewName(""); setNewCiId(""); setNewCiSearch("");
      router.push(`/decommission/${data.plan.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error");
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm(t("decommission.confirm_delete"))) return;
    try {
      const res = await apiFetch(`/api/decommission/plans/${id}`, { method: "DELETE" });
      if (!res.ok) { const d = await res.json(); throw new Error(d.error); }
      fetchPlans();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error");
    }
  };

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-red-500/15">
            <PowerOff className="h-5 w-5 text-red-400" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-slate-100">{t("decommission.title")}</h1>
            <p className="text-sm text-slate-400">{t("decommission.subtitle")}</p>
          </div>
        </div>
        <div className="flex gap-2">
          <button onClick={fetchPlans} className="flex items-center gap-1.5 px-3 py-2 text-sm bg-slate-700/50 text-slate-300 rounded hover:bg-slate-700 transition-colors">
            <RefreshCw className="h-4 w-4" />
          </button>
          {isAdmin && (
            <button onClick={() => setShowCreate(true)}
              className="flex items-center gap-2 px-4 py-2 text-sm font-medium bg-red-600 text-white rounded hover:bg-red-700 transition-colors">
              <Plus className="h-4 w-4" />
              {t("decommission.new_plan")}
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-900/20 px-4 py-3 text-sm text-red-400">
          <AlertCircle className="h-4 w-4 flex-shrink-0" />
          {error}
          <button onClick={() => setError(null)} className="ml-auto text-xs underline">{t("actions.close")}</button>
        </div>
      )}

      {/* Plans table */}
      {loading ? (
        <div className="flex items-center gap-2 text-slate-400 py-8 justify-center">
          <RefreshCw className="h-4 w-4 animate-spin" />
          <span className="text-sm">{t("common.loading_data")}</span>
        </div>
      ) : plans.length === 0 ? (
        <div className="text-center py-16 text-slate-500">
          <PowerOff className="h-10 w-10 mx-auto mb-3 opacity-30" />
          <p className="text-sm">{t("decommission.no_plans")}</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-white/8">
          <table className="w-full text-sm">
            <thead className="bg-slate-800/60">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-400 uppercase tracking-wider">{t("decommission.col_name")}</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-400 uppercase tracking-wider">{t("decommission.col_system")}</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-400 uppercase tracking-wider">{t("decommission.col_status")}</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-400 uppercase tracking-wider">{t("decommission.col_created")}</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {plans.map(p => (
                <tr key={p.id} className="border-b border-white/5 hover:bg-white/3 transition-colors">
                  <td className="px-4 py-3 font-medium text-slate-200">{p.name}</td>
                  <td className="px-4 py-3 text-slate-400">{p.system_ci_name}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-block px-2 py-0.5 text-[11px] font-semibold rounded ${STATUS_CLS[p.status] ?? STATUS_CLS.DRAFT}`}>
                      {t(`decommission.status_${p.status.toLowerCase()}`)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-slate-500 text-xs">{new Date(p.created_at).toLocaleDateString()}</td>
                  <td className="px-4 py-3">
                    <div className="flex gap-2 justify-end">
                      <button onClick={() => router.push(`/decommission/${p.id}`)}
                        className="flex items-center gap-1 px-3 py-1.5 text-xs bg-slate-700/50 text-slate-300 rounded hover:bg-slate-700 transition-colors">
                        {t("actions.view")} <ChevronRight className="h-3.5 w-3.5" />
                      </button>
                      {isAdmin && (
                        <button onClick={() => handleDelete(p.id)}
                          className="p-1.5 text-red-500 hover:bg-red-900/30 rounded transition-colors">
                          <Trash2 className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Create modal */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-md rounded-xl bg-slate-900 border border-white/10 p-6 shadow-2xl">
            <h2 className="text-lg font-bold text-slate-100 mb-4">{t("decommission.new_plan")}</h2>
            <form onSubmit={handleCreate} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-400 uppercase mb-1">{t("decommission.col_name")}</label>
                <input type="text" required value={newName} onChange={e => setNewName(e.target.value)}
                  className="w-full rounded-lg border border-white/10 bg-slate-800 px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-red-500"
                  placeholder={t("decommission.plan_name_placeholder")} />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-400 uppercase mb-1">{t("decommission.col_system")} (SISTEMA)</label>
                <input type="text" value={newCiSearch} onChange={e => setNewCiSearch(e.target.value)}
                  className="w-full rounded-lg border border-white/10 bg-slate-800 px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-red-500"
                  placeholder={t("decommission.search_system")} />
                {ciOptions.length > 0 && (
                  <div className="mt-1 rounded-lg border border-white/10 bg-slate-800 divide-y divide-white/5 max-h-40 overflow-y-auto">
                    {ciOptions.map(ci => (
                      <button key={ci.id} type="button"
                        onClick={() => { setNewCiId(ci.id); setNewCiSearch(ci.name); setCiOptions([]); }}
                        className={`w-full text-left px-3 py-2 text-sm hover:bg-white/5 transition-colors ${newCiId === ci.id ? "text-red-400 font-medium" : "text-slate-300"}`}>
                        {ci.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className="flex gap-3 pt-2">
                <button type="button" onClick={() => { setShowCreate(false); setNewName(""); setNewCiId(""); setNewCiSearch(""); }}
                  className="flex-1 px-4 py-2 text-sm bg-slate-700 text-slate-300 rounded-lg hover:bg-slate-600 transition-colors">
                  {t("actions.cancel")}
                </button>
                <button type="submit" disabled={creating || !newCiId}
                  className="flex-1 px-4 py-2 text-sm font-medium bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 transition-colors">
                  {creating ? t("common.loading") : t("actions.create")}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

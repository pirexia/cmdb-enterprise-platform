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
  DRAFT:     "bg-slate-100 text-slate-600",
  ACTIVE:    "bg-blue-100 text-blue-700",
  COMPLETED: "bg-green-100 text-green-700",
  CANCELLED: "bg-red-100 text-red-700",
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
  const [systemsOpen, setSystemsOpen] = useState(false);
  const [systemsLoading, setSystemsLoading] = useState(false);
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

  // Search SISTEMA CIs — debounced (300ms). Empty term on focus loads the first
  // systems; typing filters by substring. Dedicated module endpoint (RBAC + filter).
  useEffect(() => {
    if (!systemsOpen) return;
    const controller = new AbortController();
    const handle = setTimeout(() => {
      setSystemsLoading(true);
      apiFetch(`/api/decommission/systems?search=${encodeURIComponent(newCiSearch.trim())}&limit=50`, { signal: controller.signal })
        .then(r => (r.ok ? r.json() : { systems: [] }))
        .then(d => setCiOptions(d.systems ?? []))
        .catch(() => {})
        .finally(() => setSystemsLoading(false));
    }, 300);
    return () => { clearTimeout(handle); controller.abort(); };
  }, [newCiSearch, systemsOpen]);

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
      setNewName(""); setNewCiId(""); setNewCiSearch(""); setSystemsOpen(false); setCiOptions([]);
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
    <div className="min-h-screen bg-slate-50">
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white px-8 py-5">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-slate-900">{t("decommission.title")}</h1>
            <p className="text-sm text-slate-500 mt-0.5">{t("decommission.subtitle")}</p>
          </div>
          <div className="flex gap-2">
            <button onClick={fetchPlans} className="flex items-center gap-2 rounded-none border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50 transition-colors">
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
            {isAdmin && (
              <button onClick={() => setShowCreate(true)}
                className="flex items-center gap-2 rounded-none bg-[var(--accent)] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[var(--accent)]/90 transition-colors shadow-sm">
                <Plus className="h-4 w-4" />
                {t("decommission.new_plan")}
              </button>
            )}
          </div>
        </div>
      </header>

      <div className="px-8 py-8 space-y-6 w-full">
        {error && (
          <div className="flex items-center gap-2 border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
            <AlertCircle className="h-4 w-4 flex-shrink-0" />
            {error}
            <button onClick={() => setError(null)} className="ml-auto text-xs underline">{t("actions.close")}</button>
          </div>
        )}

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
          <div className="bg-white shadow-sm ring-1 ring-slate-200 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">{t("decommission.col_name")}</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">{t("decommission.col_system")}</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">{t("decommission.col_status")}</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">{t("decommission.col_created")}</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody>
                  {plans.map(p => (
                    <tr key={p.id} className="border-b border-slate-100 hover:bg-[var(--accent)]/5 transition-colors">
                      <td className="px-4 py-3 font-medium text-slate-800">{p.name}</td>
                      <td className="px-4 py-3 text-slate-400">{p.system_ci_name}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-block px-2 py-0.5 text-xs font-semibold rounded-full ${STATUS_CLS[p.status] ?? STATUS_CLS.DRAFT}`}>
                          {t(`decommission.status_${p.status.toLowerCase()}`)}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-slate-500 text-xs">{new Date(p.created_at).toLocaleDateString()}</td>
                      <td className="px-4 py-3">
                        <div className="flex gap-2 justify-end">
                          <button onClick={() => router.push(`/decommission/${p.id}`)}
                            className="flex items-center gap-1 px-3 py-1.5 text-xs bg-slate-100 text-slate-600 rounded-none hover:bg-slate-200 transition-colors">
                            {t("actions.view")} <ChevronRight className="h-3.5 w-3.5" />
                          </button>
                          {isAdmin && (
                            <button onClick={() => handleDelete(p.id)}
                              className="p-1.5 text-red-500 hover:bg-red-50 rounded-none transition-colors">
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
          </div>
        )}
      </div>

      {/* Create modal */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-md rounded-none bg-white ring-1 ring-slate-200 p-6 shadow-2xl">
            <h2 className="text-lg font-bold text-slate-800 mb-4">{t("decommission.new_plan")}</h2>
            <form onSubmit={handleCreate} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-500 uppercase mb-1">{t("decommission.col_name")}</label>
                <input type="text" required value={newName} onChange={e => setNewName(e.target.value)}
                  className="w-full rounded-none border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 focus:outline-none focus:border-[var(--accent)]"
                  placeholder={t("decommission.plan_name_placeholder")} />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-500 uppercase mb-1">{t("decommission.col_system")}</label>
                <input type="text" value={newCiSearch}
                  onFocus={() => setSystemsOpen(true)}
                  onChange={e => { setNewCiSearch(e.target.value); setNewCiId(""); }}
                  className="w-full rounded-none border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 focus:outline-none focus:border-[var(--accent)]"
                  placeholder={t("decommission.search_system")} />
                {systemsOpen && (
                  <div className="mt-1 rounded-none border border-slate-200 bg-white divide-y divide-slate-100 max-h-40 overflow-y-auto">
                    {systemsLoading ? (
                      <div className="flex items-center gap-2 px-3 py-2 text-xs text-slate-500">
                        <RefreshCw className="h-3 w-3 animate-spin" /> {t("common.loading")}
                      </div>
                    ) : ciOptions.length === 0 ? (
                      <div className="px-3 py-2 text-xs text-slate-500">{t("decommission.no_systems")}</div>
                    ) : (
                      ciOptions.map(ci => (
                        <button key={ci.id} type="button"
                          onClick={() => { setNewCiId(ci.id); setNewCiSearch(ci.name); setSystemsOpen(false); setCiOptions([]); }}
                          className={`w-full text-left px-3 py-2 text-sm hover:bg-slate-50 transition-colors ${newCiId === ci.id ? "text-[var(--accent)] font-medium" : "text-slate-700"}`}>
                          {ci.name}
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>
              <div className="flex gap-3 pt-2">
                <button type="button" onClick={() => { setShowCreate(false); setNewName(""); setNewCiId(""); setNewCiSearch(""); setSystemsOpen(false); setCiOptions([]); }}
                  className="flex-1 px-4 py-2 text-sm bg-slate-100 text-slate-600 rounded-none hover:bg-slate-200 transition-colors">
                  {t("actions.cancel")}
                </button>
                <button type="submit" disabled={creating || !newCiId}
                  className="flex-1 px-4 py-2 text-sm font-semibold bg-[var(--accent)] text-white rounded-none hover:bg-[var(--accent)]/90 disabled:opacity-50 transition-colors">
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

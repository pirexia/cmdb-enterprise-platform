"use client";

import { useEffect, useState, useCallback } from "react";
import {
  Package, Upload, RefreshCw, CheckCircle, Download,
  Play, Square, Trash2, Settings, FileText, AlertCircle,
  ChevronDown, ChevronUp, Puzzle,
} from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAuth } from "@/contexts/AuthContext";
import { apiFetch } from "@/lib/apiFetch";
import AppShell from "@/components/AppShell";
import PluginConfigModal from "./PluginConfigModal";
import PluginUploadModal from "./PluginUploadModal";

// ─── Types ────────────────────────────────────────────────────────────────────

type PluginStatus =
  | "UPLOADED"
  | "VALIDATED"
  | "INSTALLED"
  | "ACTIVE"
  | "INACTIVE"
  | "UNINSTALLING"
  | "ERROR";

interface Plugin {
  id: string;
  name: string;
  version: string;
  author: string;
  description: string;
  status: PluginStatus;
  checksum: string;
  installedAt: string | null;
  activatedAt: string | null;
  lastError: string | null;
}

interface MarketplacePlugin {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  category?: string;
  minPlatformVersion?: string;
  permissions?: string[];
  iconUrl?: string;
}

interface MarketplaceResponse {
  available: boolean;
  plugins?: MarketplacePlugin[];
}

// Matches the audit-log rows returned by GET /api/plugins/:id/logs
interface LogEntry {
  id: string;
  action: string;
  user_email: string;
  details: Record<string, unknown> | null;
  created_at: string;
}

// ─── Status badge ─────────────────────────────────────────────────────────────

function StatusBadge({ status, t }: { status: PluginStatus; t: (k: string) => string }) {
  const cfg: Record<PluginStatus, { cls: string; label: string }> = {
    UPLOADED:    { cls: "bg-slate-700 text-slate-300",   label: t("pluginStatusUploaded")  },
    VALIDATED:   { cls: "bg-blue-900/70 text-blue-300",  label: t("pluginStatusValidated") },
    INSTALLED:   { cls: "bg-yellow-900/70 text-yellow-300", label: t("pluginStatusInstalled") },
    ACTIVE:      { cls: "bg-green-900/70 text-green-300", label: t("pluginStatusActive")   },
    INACTIVE:    { cls: "bg-orange-900/70 text-orange-300", label: t("pluginStatusInactive") },
    UNINSTALLING:{ cls: "bg-slate-700 text-slate-400",   label: "Uninstalling…"           },
    ERROR:       { cls: "bg-red-900/70 text-red-300",    label: t("pluginStatusError")     },
  };
  const { cls, label } = cfg[status] ?? cfg.ERROR;
  return (
    <span className={`inline-block px-2 py-0.5 text-[11px] font-semibold rounded ${cls}`}>
      {label}
    </span>
  );
}

// ─── Plugin row ───────────────────────────────────────────────────────────────

function PluginRow({
  plugin,
  t,
  onAction,
  onConfig,
}: {
  plugin: Plugin;
  t: (k: string) => string;
  onAction: (id: string, action: string) => Promise<void>;
  onConfig: (plugin: Plugin) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loadingLogs, setLoadingLogs] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const handleAction = async (action: string) => {
    setActionLoading(action);
    try {
      await onAction(plugin.id, action);
    } finally {
      setActionLoading(null);
    }
  };

  const toggleLogs = async () => {
    if (!expanded) {
      setLoadingLogs(true);
      try {
        const res = await apiFetch(`/api/plugins/${plugin.id}/logs?limit=50`);
        if (res.ok) {
          const data = await res.json() as { logs: LogEntry[] };
          setLogs(data.logs ?? []);
        }
      } finally {
        setLoadingLogs(false);
      }
    }
    setExpanded((v) => !v);
  };

  const s = plugin.status;
  const btnCls = "px-2.5 py-1 text-xs font-medium rounded transition-colors disabled:opacity-50";

  return (
    <>
      <tr className="border-b border-white/5 hover:bg-white/3 transition-colors">
        <td className="px-4 py-3">
          <div className="font-medium text-slate-200">{plugin.name}</div>
          {plugin.description && (
            <div className="text-xs text-slate-500 mt-0.5 line-clamp-1">{plugin.description}</div>
          )}
        </td>
        <td className="px-4 py-3 text-sm text-slate-400">{plugin.version}</td>
        <td className="px-4 py-3 text-sm text-slate-400">{plugin.author}</td>
        <td className="px-4 py-3">
          <StatusBadge status={s} t={t} />
          {s === "ERROR" && plugin.lastError && (
            <div className="text-xs text-red-400 mt-1 max-w-[200px] truncate" title={plugin.lastError}>
              {plugin.lastError}
            </div>
          )}
        </td>
        <td className="px-4 py-3">
          <div className="flex flex-wrap gap-1.5 items-center">
            {/* Lifecycle actions */}
            {s === "UPLOADED" && (
              <button
                onClick={() => handleAction("validate")}
                disabled={actionLoading !== null}
                className={`${btnCls} bg-blue-700/30 text-blue-300 hover:bg-blue-700/50`}
              >
                {actionLoading === "validate" ? "…" : t("pluginValidate")}
              </button>
            )}
            {s === "VALIDATED" && (
              <button
                onClick={() => handleAction("install")}
                disabled={actionLoading !== null}
                className={`${btnCls} bg-yellow-700/30 text-yellow-300 hover:bg-yellow-700/50`}
              >
                {actionLoading === "install" ? "…" : t("pluginInstall")}
              </button>
            )}
            {(s === "INSTALLED" || s === "INACTIVE") && (
              <button
                onClick={() => handleAction("activate")}
                disabled={actionLoading !== null}
                className={`${btnCls} bg-green-700/30 text-green-300 hover:bg-green-700/50`}
              >
                {actionLoading === "activate" ? "…" : t("pluginActivate")}
              </button>
            )}
            {s === "ACTIVE" && (
              <button
                onClick={() => handleAction("deactivate")}
                disabled={actionLoading !== null}
                className={`${btnCls} bg-orange-700/30 text-orange-300 hover:bg-orange-700/50`}
              >
                {actionLoading === "deactivate" ? "…" : t("pluginDeactivate")}
              </button>
            )}
            {(s === "INSTALLED" || s === "INACTIVE" || s === "ERROR") && (
              <button
                onClick={() => handleAction("uninstall")}
                disabled={actionLoading !== null}
                className={`${btnCls} bg-red-900/30 text-red-400 hover:bg-red-900/50`}
              >
                {actionLoading === "uninstall" ? "…" : t("pluginUninstall")}
              </button>
            )}
            {/* Config + Logs always visible */}
            <button
              onClick={() => onConfig(plugin)}
              className={`${btnCls} bg-slate-700/50 text-slate-300 hover:bg-slate-700`}
              title={t("pluginConfig")}
            >
              <Settings className="h-3.5 w-3.5 inline mr-1" />
              {t("pluginConfig")}
            </button>
            <button
              onClick={toggleLogs}
              className={`${btnCls} bg-slate-700/50 text-slate-300 hover:bg-slate-700`}
              title={t("pluginLogs")}
            >
              <FileText className="h-3.5 w-3.5 inline mr-1" />
              {t("pluginLogs")}
              {expanded ? (
                <ChevronUp className="h-3 w-3 inline ml-1" />
              ) : (
                <ChevronDown className="h-3 w-3 inline ml-1" />
              )}
            </button>
          </div>
        </td>
      </tr>
      {expanded && (
        <tr className="border-b border-white/5 bg-slate-900/50">
          <td colSpan={5} className="px-4 py-3">
            {loadingLogs ? (
              <div className="text-xs text-slate-500">Loading logs…</div>
            ) : logs.length === 0 ? (
              <div className="text-xs text-slate-500">No logs available.</div>
            ) : (
              <div className="space-y-0.5 max-h-48 overflow-y-auto font-mono text-xs">
                {logs.map((l) => {
                  const isError = /FAILED|ERROR/.test(l.action);
                  return (
                    <div key={l.id} className={`flex gap-2 ${isError ? "text-red-400" : "text-slate-400"}`}>
                      <span className="text-slate-600 flex-shrink-0">{l.created_at ? new Date(l.created_at).toLocaleTimeString() : ""}</span>
                      <span className="uppercase text-[10px] w-40 flex-shrink-0 truncate" title={l.action}>{l.action}</span>
                      <span className="truncate" title={l.user_email}>
                        {l.user_email}{l.details ? ` — ${JSON.stringify(l.details)}` : ""}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function PluginAdminPage() {
  const { t } = useLanguage();
  const { user } = useAuth();

  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [marketplace, setMarketplace] = useState<MarketplaceResponse | null>(null);
  const [marketplaceLoading, setMarketplaceLoading] = useState(true);

  const [configPlugin, setConfigPlugin] = useState<Plugin | null>(null);
  const [showUpload, setShowUpload] = useState(false);

  const [marketplaceSearch, setMarketplaceSearch] = useState("");
  const [marketplaceCategory, setMarketplaceCategory] = useState("all");
  const [installingId, setInstallingId] = useState<string | null>(null);

  const [toast, setToast] = useState<{ msg: string; type: "ok" | "err" } | null>(null);

  const showToast = (msg: string, type: "ok" | "err" = "ok") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  };

  const fetchPlugins = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch("/api/plugins");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // Backend returns { plugins: [...] } — unwrap to the array.
      const data = await res.json() as { plugins: Plugin[] };
      setPlugins(data.plugins ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchMarketplace = useCallback(async () => {
    setMarketplaceLoading(true);
    try {
      const res = await apiFetch("/api/plugins/marketplace");
      if (!res.ok) {
        setMarketplace({ available: false });
        return;
      }
      const data = await res.json() as MarketplaceResponse;
      setMarketplace(data);
    } catch {
      setMarketplace({ available: false });
    } finally {
      setMarketplaceLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPlugins();
    fetchMarketplace();
  }, [fetchPlugins, fetchMarketplace]);

  const handleAction = async (id: string, action: string) => {
    try {
      const res = await apiFetch(`/api/plugins/${id}/${action}`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      showToast(`${action} OK`, "ok");
      await fetchPlugins();
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), "err");
    }
  };

  const handleMarketplaceInstall = async (pluginId: string) => {
    setInstallingId(pluginId);
    try {
      const res = await apiFetch("/api/plugins/marketplace/install", {
        method: "POST",
        body: JSON.stringify({ pluginId }),
      });
      const body = await res.json().catch(() => ({})) as { error?: string; name?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      showToast(`${body.name ?? pluginId} ${t("pluginMarketplaceInstalled")}`, "ok");
      await fetchPlugins();
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), "err");
    } finally {
      setInstallingId(null);
    }
  };

  // Access control
  if (user && user.role !== "ADMIN") {
    return (
      <AppShell>
        <div className="flex flex-col items-center justify-center h-64 gap-3 text-slate-400">
          <AlertCircle className="h-10 w-10 text-red-400" />
          <p className="text-lg font-medium text-slate-300">{t("common.admin_only")}</p>
          <p className="text-sm">{t("common.admin_only")}</p>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="p-6 max-w-7xl mx-auto space-y-8">

        {/* Toast */}
        {toast && (
          <div className={`fixed top-5 right-5 z-50 px-4 py-3 rounded shadow-lg text-sm font-medium ${
            toast.type === "ok" ? "bg-green-800 text-green-100" : "bg-red-800 text-red-100"
          }`}>
            {toast.msg}
          </div>
        )}

        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[var(--accent)]/15">
              <Puzzle className="h-5 w-5 text-[var(--accent)]" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-slate-100">{t("pluginManager")}</h1>
              <p className="text-sm text-slate-400">{t("pluginManagerDesc")}</p>
            </div>
          </div>
          <div className="flex gap-2 flex-shrink-0">
            <button
              onClick={fetchPlugins}
              className="flex items-center gap-1.5 px-3 py-2 text-sm bg-slate-700/50 text-slate-300 rounded hover:bg-slate-700 transition-colors"
            >
              <RefreshCw className="h-4 w-4" />
            </button>
            <button
              onClick={() => setShowUpload(true)}
              className="flex items-center gap-2 px-4 py-2 text-sm font-medium bg-[var(--accent)] text-white rounded hover:opacity-90 transition-opacity"
            >
              <Upload className="h-4 w-4" />
              {t("uploadPlugin")}
            </button>
          </div>
        </div>

        {/* Installed plugins table */}
        <section>
          <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wider mb-3">
            {t("plugins")}
          </h2>

          {loading ? (
            <div className="flex items-center gap-2 text-slate-400 py-8 justify-center">
              <RefreshCw className="h-4 w-4 animate-spin" />
              <span className="text-sm">{t("common.loading_data")}</span>
            </div>
          ) : error ? (
            <div className="flex items-center gap-2 text-red-400 py-6">
              <AlertCircle className="h-4 w-4" />
              <span className="text-sm">{error}</span>
              <button onClick={fetchPlugins} className="ml-2 text-xs underline text-slate-400 hover:text-slate-200">
                {t("actions.retry")}
              </button>
            </div>
          ) : plugins.length === 0 ? (
            <div className="text-center py-12 text-slate-500">
              <Package className="h-8 w-8 mx-auto mb-2 opacity-40" />
              <p className="text-sm">{t("common.no_data")}</p>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-white/8">
              <table className="w-full text-sm">
                <thead className="bg-slate-800/60">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-slate-400 uppercase tracking-wider">{t("pluginName")}</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-slate-400 uppercase tracking-wider">{t("pluginVersion")}</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-slate-400 uppercase tracking-wider">{t("pluginAuthor")}</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-slate-400 uppercase tracking-wider">{t("pluginStatus")}</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-slate-400 uppercase tracking-wider">{t("pluginActions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {plugins.map((p) => (
                    <PluginRow
                      key={p.id}
                      plugin={p}
                      t={t}
                      onAction={handleAction}
                      onConfig={setConfigPlugin}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* Marketplace */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wider">
              {t("pluginMarketplace")}
            </h2>
            {marketplace?.available && (
              <button
                onClick={fetchMarketplace}
                className="flex items-center gap-1 px-2 py-1 text-xs text-slate-500 hover:text-slate-300 transition-colors"
              >
                <RefreshCw className="h-3 w-3" />
              </button>
            )}
          </div>

          {marketplaceLoading ? (
            <div className="flex items-center gap-2 text-slate-500 py-4">
              <RefreshCw className="h-4 w-4 animate-spin" />
              <span className="text-sm">{t("common.loading")}</span>
            </div>
          ) : !marketplace?.available ? (
            <div className="rounded-lg border border-white/8 bg-slate-800/30 px-5 py-6 text-center text-slate-500">
              <Download className="h-6 w-6 mx-auto mb-2 opacity-40" />
              <p className="text-sm">{t("pluginMarketplaceNotConfigured")}</p>
            </div>
          ) : (
            <>
              {/* Filters */}
              <div className="flex flex-wrap gap-2 mb-4">
                <input
                  type="text"
                  placeholder={t("pluginMarketplaceSearch")}
                  value={marketplaceSearch}
                  onChange={(e) => setMarketplaceSearch(e.target.value)}
                  className="flex-1 min-w-[180px] px-3 py-1.5 text-sm bg-slate-800/60 border border-white/10 text-slate-300 placeholder-slate-600 focus:outline-none focus:border-[var(--accent)]/50 rounded"
                />
                {(() => {
                  const cats = Array.from(new Set((marketplace.plugins ?? []).map((p) => p.category).filter(Boolean))) as string[];
                  return cats.length > 0 ? (
                    <select
                      value={marketplaceCategory}
                      onChange={(e) => setMarketplaceCategory(e.target.value)}
                      className="px-3 py-1.5 text-sm bg-slate-800/60 border border-white/10 text-slate-300 focus:outline-none focus:border-[var(--accent)]/50 rounded"
                    >
                      <option value="all">{t("pluginMarketplaceAllCategories")}</option>
                      {cats.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                  ) : null;
                })()}
              </div>

              {/* Grid */}
              {(() => {
                const filtered = (marketplace.plugins ?? []).filter((mp) => {
                  const q = marketplaceSearch.toLowerCase();
                  const matchText = !q || mp.name.toLowerCase().includes(q) || mp.description?.toLowerCase().includes(q) || mp.author?.toLowerCase().includes(q);
                  const matchCat = marketplaceCategory === "all" || mp.category === marketplaceCategory;
                  return matchText && matchCat;
                });

                if (filtered.length === 0) {
                  return (
                    <div className="text-center py-8 text-slate-500">
                      <Package className="h-6 w-6 mx-auto mb-2 opacity-40" />
                      <p className="text-sm">{t("common.no_data")}</p>
                    </div>
                  );
                }

                return (
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                    {filtered.map((mp) => {
                      const alreadyInstalled = plugins.some((p) => p.name === mp.name);
                      const isInstalling = installingId === mp.id;
                      return (
                        <div
                          key={mp.id}
                          className="rounded-lg border border-white/8 bg-slate-800/30 p-4 flex flex-col gap-2"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <p className="font-medium text-slate-200 text-sm truncate">{mp.name}</p>
                              <p className="text-xs text-slate-500">{mp.author} · v{mp.version}</p>
                            </div>
                            {mp.category && (
                              <span className="flex-shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-slate-700 text-slate-400">
                                {mp.category}
                              </span>
                            )}
                          </div>
                          {mp.description && (
                            <p className="text-xs text-slate-400 line-clamp-2">{mp.description}</p>
                          )}
                          {mp.minPlatformVersion && (
                            <p className="text-[10px] text-slate-600">
                              {t("pluginMarketplaceCompatible", { version: mp.minPlatformVersion })}
                            </p>
                          )}
                          <button
                            onClick={() => !alreadyInstalled && !isInstalling && handleMarketplaceInstall(mp.id)}
                            disabled={alreadyInstalled || isInstalling}
                            className={`mt-auto flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded transition-colors
                              ${alreadyInstalled
                                ? "bg-green-900/30 text-green-400 cursor-default"
                                : isInstalling
                                ? "bg-slate-700/50 text-slate-400 cursor-not-allowed"
                                : "bg-[var(--accent)]/15 text-[var(--accent)] hover:bg-[var(--accent)]/25"
                              }`}
                          >
                            {alreadyInstalled ? (
                              <><CheckCircle className="h-3.5 w-3.5" />{t("pluginMarketplaceInstalled")}</>
                            ) : isInstalling ? (
                              <><RefreshCw className="h-3.5 w-3.5 animate-spin" />{t("pluginMarketplaceInstalling")}</>
                            ) : (
                              <><Download className="h-3.5 w-3.5" />{t("pluginMarketplaceInstall")}</>
                            )}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                );
              })()}
            </>
          )}
        </section>
      </div>

      {/* Modals */}
      {configPlugin && (
        <PluginConfigModal
          plugin={configPlugin}
          onClose={() => setConfigPlugin(null)}
        />
      )}
      {showUpload && (
        <PluginUploadModal
          onClose={() => setShowUpload(false)}
          onSuccess={() => {
            setShowUpload(false);
            fetchPlugins();
          }}
        />
      )}
    </AppShell>
  );
}

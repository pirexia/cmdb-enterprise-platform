"use client";
import { useCallback, useEffect, useState } from "react";
import { RefreshCw, Users, CheckCircle, XCircle } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAuth } from "@/contexts/AuthContext";
import { apiFetch } from "@/lib/apiFetch";

interface LdapStatus {
  enabled: boolean;
  group: string;
  nested: boolean;
  useLdap: boolean;
  defaultRole: string;
  syncInProgress: boolean;
}

interface LdapSyncResult {
  created: number;
  updated: number;
  reactivated: number;
  deactivated: number;
  errors: string[];
}

interface LdapLogRow {
  action: string;
  entityId: string | null;
  userEmail: string;
  createdAt: string;
  /** sAMAccountName de la cuenta afectada; null si su fila ya no existe. */
  samAccountName: string | null;
}

/** Códigos de error que el backend devuelve con significado propio. */
type SyncError = "LDAP_GROUP_NOT_CONFIGURED" | "SYNC_IN_PROGRESS" | "LDAP_DIRECTORY_UNAVAILABLE" | "UNKNOWN";

export default function LdapSyncCard() {
  const { t } = useLanguage();
  const { user: me } = useAuth();
  const isAdmin = me?.role === "ADMIN";

  const [status, setStatus] = useState<LdapStatus | null>(null);
  const [log, setLog] = useState<LdapLogRow[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [result, setResult] = useState<LdapSyncResult | null>(null);
  const [error, setError] = useState<SyncError | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const r = await apiFetch("/api/integrations/ldap/status");
      if (r.ok) setStatus(await r.json());
    } catch {
      /* el badge queda en "no configurado"; no hay nada accionable que mostrar */
    }
  }, []);

  const loadLog = useCallback(async () => {
    try {
      const r = await apiFetch("/api/integrations/ldap/sync-log");
      if (r.ok) setLog(await r.json());
    } catch {
      /* historial vacío */
    }
  }, []);

  useEffect(() => {
    loadStatus();
    loadLog();
  }, [loadStatus, loadLog]);

  const handleSync = async () => {
    setSyncing(true);
    setResult(null);
    setError(null);
    try {
      const r = await apiFetch("/api/integrations/ldap/sync", { method: "POST" });
      const body = await r.json();
      // 200 = todo bien, 207 = parcial (hay errors[] pero se aplicó el resto).
      if (r.ok || r.status === 207) setResult(body as LdapSyncResult);
      else setError((body?.error as SyncError) ?? "UNKNOWN");
    } catch {
      setError("UNKNOWN");
    } finally {
      setSyncing(false);
      loadStatus();
      loadLog();
    }
  };

  const configured = status?.enabled === true;
  const canSync = isAdmin && configured && !syncing && !status?.syncInProgress;

  const errorMessage: Record<SyncError, string> = {
    LDAP_GROUP_NOT_CONFIGURED: t("settings.integrations.ldapSync.errorNotConfigured"),
    SYNC_IN_PROGRESS: t("settings.integrations.ldapSync.errorInProgress"),
    LDAP_DIRECTORY_UNAVAILABLE: t("settings.integrations.ldapSync.errorUnavailable"),
    UNKNOWN: t("settings.integrations.ldapSync.errorUnavailable"),
  };

  return (
    <div className="bg-white shadow-sm ring-1 ring-slate-200 rounded-none overflow-hidden">
      <div className="border-b border-slate-100 px-6 py-4 bg-slate-50 flex items-center justify-between">
        <div>
          <p className="text-sm font-semibold text-slate-700 flex items-center gap-2">
            <Users className="h-4 w-4 text-indigo-500" />
            {t("settings.integrations.ldapSync.title")}
          </p>
          <p className="text-xs text-slate-500 mt-0.5">{t("settings.integrations.ldapSync.description")}</p>
        </div>
        <span
          className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold ${
            configured ? "bg-green-100 text-green-700" : "bg-slate-100 text-slate-500"
          }`}
        >
          {configured ? <CheckCircle className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
          {configured
            ? t("settings.integrations.ldapSync.active")
            : t("settings.integrations.ldapSync.notConfigured")}
        </span>
      </div>

      <div className="p-6 space-y-4">
        <dl className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
          <div>
            <dt className="text-slate-500">{t("settings.integrations.ldapSync.group")}</dt>
            <dd className="font-mono text-slate-700 mt-0.5 break-all">
              {status?.group || "—"}
            </dd>
          </div>
          <div>
            <dt className="text-slate-500">{t("settings.integrations.ldapSync.nested")}</dt>
            <dd className="text-slate-700 mt-0.5">{status?.nested ? "✓" : "—"}</dd>
          </div>
          <div>
            <dt className="text-slate-500">{t("settings.integrations.ldapSync.defaultRole")}</dt>
            <dd className="text-slate-700 mt-0.5">{status?.defaultRole ?? "—"}</dd>
          </div>
        </dl>

        {!configured && (
          <p className="text-xs text-slate-500">{t("settings.integrations.ldapSync.notConfiguredHint")}</p>
        )}

        {isAdmin && (
          <button
            onClick={handleSync}
            disabled={!canSync}
            className="flex items-center justify-center gap-2 rounded-none bg-[var(--accent)] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[var(--accent)]/90 shadow-sm disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <RefreshCw className={`h-4 w-4 ${syncing ? "animate-spin" : ""}`} />
            {syncing
              ? t("settings.integrations.ldapSync.syncing")
              : t("settings.integrations.ldapSync.syncNow")}
          </button>
        )}

        {result && (
          <div className="rounded-none border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700 space-y-1">
            <p>
              {t("settings.integrations.ldapSync.resultCreated")}: <strong>{result.created}</strong>
              {" · "}
              {t("settings.integrations.ldapSync.resultUpdated")}: <strong>{result.updated}</strong>
              {" · "}
              {t("settings.integrations.ldapSync.resultReactivated")}: <strong>{result.reactivated}</strong>
              {" · "}
              {t("settings.integrations.ldapSync.resultDeactivated")}: <strong>{result.deactivated}</strong>
            </p>
            {result.errors.length > 0 && (
              <ul className="list-disc list-inside text-amber-700">
                {result.errors.slice(0, 10).map((e, i) => (
                  <li key={i} className="font-mono break-all">{e}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        {error && (
          <div className="rounded-none border border-red-200 bg-red-50 px-3 py-2 text-xs font-medium text-red-600">
            {errorMessage[error]}
          </div>
        )}

        <div>
          <p className="text-xs font-semibold text-slate-600 mb-2">
            {t("settings.integrations.ldapSync.historyTitle")}
          </p>
          {log.length === 0 ? (
            <p className="text-xs text-slate-400">{t("settings.integrations.ldapSync.historyEmpty")}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-slate-500 border-b border-slate-200">
                    <th className="py-1.5 pr-3 font-medium">{t("settings.integrations.ldapSync.colAction")}</th>
                    <th className="py-1.5 pr-3 font-medium">{t("settings.integrations.ldapSync.colSam")}</th>
                    <th className="py-1.5 pr-3 font-medium">{t("settings.integrations.ldapSync.colDate")}</th>
                    <th className="py-1.5 font-medium">{t("settings.integrations.ldapSync.colActor")}</th>
                  </tr>
                </thead>
                <tbody>
                  {log.slice(0, 20).map((row, i) => (
                    <tr key={i} className="border-b border-slate-100 last:border-0">
                      <td className="py-1.5 pr-3 font-mono text-slate-700">{row.action}</td>
                      <td className="py-1.5 pr-3 font-mono text-slate-700 break-all">
                        {row.samAccountName ?? "—"}
                      </td>
                      <td className="py-1.5 pr-3 text-slate-500">
                        {new Date(row.createdAt).toLocaleString()}
                      </td>
                      <td className="py-1.5 text-slate-500">{row.userEmail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

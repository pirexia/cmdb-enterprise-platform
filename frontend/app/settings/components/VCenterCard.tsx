"use client";
import { RefreshCw, Server, CheckCircle, XCircle, AlertTriangle } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAuth } from "@/contexts/AuthContext";
import { useVCenterStatus } from "../hooks/useVCenterStatus";
import { useVCenterTest } from "../hooks/useVCenterTest";
import { useSyncNow } from "../hooks/useSyncNow";
import { useSyncLog } from "../hooks/useSyncLog";
import SyncLogTable from "./SyncLogTable";

type TFunc = (key: string, vars?: Record<string, string | number>) => string;

/** Small local relative-time helper — no existing one found elsewhere in the codebase. */
function formatRelativeTime(iso: string, t: TFunc): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const diffMs = Date.now() - then;
  const diffSec = Math.max(0, Math.floor(diffMs / 1000));
  if (diffSec < 60) return t("settings.integrations.vcenter_time_seconds_ago", { n: diffSec });
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return t("settings.integrations.vcenter_time_minutes_ago", { n: diffMin });
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return t("settings.integrations.vcenter_time_hours_ago", { n: diffHour });
  const diffDay = Math.floor(diffHour / 24);
  return t("settings.integrations.vcenter_time_days_ago", { n: diffDay });
}

export default function VCenterCard() {
  const { t } = useLanguage();
  const { user: me } = useAuth();
  const isAdmin = me?.role === "ADMIN";

  const { status, refetch: refetchStatus } = useVCenterStatus();
  const { log, refetch: refetchLog } = useSyncLog();
  const { testing, result: testResult, testConnection } = useVCenterTest();
  const { syncing, result: syncResult, syncNow } = useSyncNow();

  const configured = status?.configured === true;
  const lastStatus = status?.lastSyncResult?.status;
  const hasErrors = lastStatus === "ERROR" || lastStatus === "PARTIAL";

  const badgeOk = configured && !hasErrors;
  const badgeLabel = !configured
    ? t("settings.integrations.vcenter_status_not_configured")
    : hasErrors
    ? t("settings.integrations.vcenter_status_error")
    : t("settings.integrations.vcenter_status_configured");

  const handleSync = async () => {
    await syncNow();
    refetchStatus();
    refetchLog();
  };

  const testOk = testResult && "ok" in testResult ? testResult.ok : undefined;
  const testMessage =
    testResult && "message" in testResult ? testResult.message
    : testResult && "error" in testResult ? testResult.error
    : null;

  const syncErrorMessage = syncResult && "error" in syncResult ? syncResult.error : null;

  return (
    <div className="bg-white shadow-sm ring-1 ring-slate-200 rounded-none overflow-hidden">
      <div className="border-b border-slate-100 px-6 py-4 bg-slate-50 flex items-center justify-between">
        <div>
          <p className="text-sm font-semibold text-slate-700 flex items-center gap-2">
            <Server className="h-4 w-4 text-indigo-500" />
            {t("settings.integrations.vcenter_title")}
          </p>
          <p className="text-xs text-slate-500 mt-0.5">{t("settings.integrations.vcenter_subtitle")}</p>
        </div>
        <span
          className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold ${
            !configured
              ? "bg-slate-100 text-slate-500"
              : hasErrors
              ? "bg-amber-100 text-amber-700"
              : "bg-green-100 text-green-700"
          }`}
        >
          {!configured ? (
            <XCircle className="h-3 w-3" />
          ) : hasErrors ? (
            <AlertTriangle className="h-3 w-3" />
          ) : (
            <CheckCircle className="h-3 w-3" />
          )}
          {badgeLabel}
        </span>
      </div>

      <div className="p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-slate-500">
          <span>
            {t("settings.integrations.vcenter_last_sync")}:{" "}
            <strong className="text-slate-700">
              {status?.lastSyncAt ? formatRelativeTime(status.lastSyncAt, t) : t("settings.integrations.vcenter_never_synced")}
            </strong>
          </span>
          {status?.host && <span className="font-mono text-slate-400">{status.host}</span>}
        </div>

        {!badgeOk && !configured && (
          <p className="text-xs text-slate-500">{t("settings.integrations.vcenter_not_configured_hint")}</p>
        )}
        {configured && status?.syncEnabled === false && (
          <p className="text-xs text-slate-500">{t("settings.integrations.vcenter_sync_disabled_hint")}</p>
        )}

        {isAdmin && (
          <div className="flex flex-wrap gap-3">
            <button
              onClick={testConnection}
              disabled={testing || !configured}
              className="flex items-center justify-center gap-2 rounded-none border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {testing ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              {testing ? t("settings.integrations.vcenter_testing") : t("settings.integrations.vcenter_test_connection")}
            </button>

            <button
              onClick={handleSync}
              disabled={syncing || !configured || status?.syncEnabled === false}
              className="flex items-center justify-center gap-2 rounded-none bg-[var(--accent)] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[var(--accent)]/90 shadow-sm disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {syncing ? <RefreshCw className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              {syncing ? t("settings.integrations.vcenter_syncing") : t("settings.integrations.vcenter_sync_now")}
            </button>
          </div>
        )}

        {testResult && (
          <div
            className={`rounded-none px-3 py-2 text-xs font-medium ${
              testOk ? "bg-green-50 text-green-700 border border-green-200" : "bg-red-50 text-red-600 border border-red-200"
            }`}
          >
            {testOk ? t("settings.integrations.vcenter_test_ok") : t("settings.integrations.vcenter_test_failed")}
            {testMessage ? ` — ${testMessage}` : ""}
          </div>
        )}

        {syncResult && "status" in syncResult && (
          <div
            className={`rounded-none px-3 py-2 text-xs font-medium ${
              syncResult.status === "SUCCESS"
                ? "bg-green-50 text-green-700 border border-green-200"
                : syncResult.status === "PARTIAL"
                ? "bg-amber-50 text-amber-700 border border-amber-200"
                : "bg-red-50 text-red-600 border border-red-200"
            }`}
          >
            {syncResult.status === "SUCCESS"
              ? t("settings.integrations.vcenter_sync_result_success")
              : syncResult.status === "PARTIAL"
              ? t("settings.integrations.vcenter_sync_result_partial")
              : t("settings.integrations.vcenter_sync_result_error")}
            {" — "}
            {syncResult.created}/{syncResult.updated}/{syncResult.retired}/{syncResult.errors}
          </div>
        )}
        {syncErrorMessage && (
          <div className="rounded-none px-3 py-2 text-xs font-medium bg-red-50 text-red-600 border border-red-200">
            {syncErrorMessage}
          </div>
        )}
      </div>

      <div className="border-t border-slate-100">
        <div className="px-6 py-3 bg-slate-50 border-b border-slate-100">
          <p className="text-sm font-semibold text-slate-700">{t("settings.integrations.vcenter_synclog_title")}</p>
        </div>
        <SyncLogTable log={log} />
      </div>
    </div>
  );
}

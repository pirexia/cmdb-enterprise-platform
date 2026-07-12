"use client";
import { useLanguage } from "@/contexts/LanguageContext";
import type { SyncLogEntry } from "../types/vcenter";

function LogStatusBadge({ status }: { status: SyncLogEntry["status"] }) {
  const cls =
    status === "SUCCESS" ? "bg-green-100 text-green-700"
    : status === "PARTIAL" ? "bg-amber-100 text-amber-700"
    : "bg-red-100 text-red-600";
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${cls}`}>
      {status}
    </span>
  );
}

export default function SyncLogTable({ log }: { log: SyncLogEntry[] }) {
  const { t } = useLanguage();

  if (log.length === 0) {
    return (
      <p className="px-4 py-6 text-center text-xs text-slate-400">
        {t("settings.integrations.vcenter_synclog_empty")}
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-slate-100 bg-slate-50">
            <th className="px-4 py-2 text-left font-semibold text-slate-500">{t("settings.integrations.vcenter_synclog_date")}</th>
            <th className="px-4 py-2 text-left font-semibold text-slate-500">{t("settings.integrations.vcenter_synclog_status")}</th>
            <th className="px-4 py-2 text-left font-semibold text-slate-500">{t("settings.integrations.vcenter_synclog_created")}</th>
            <th className="px-4 py-2 text-left font-semibold text-slate-500">{t("settings.integrations.vcenter_synclog_updated")}</th>
            <th className="px-4 py-2 text-left font-semibold text-slate-500">{t("settings.integrations.vcenter_synclog_retired")}</th>
            <th className="px-4 py-2 text-left font-semibold text-slate-500">{t("settings.integrations.vcenter_synclog_errors")}</th>
          </tr>
        </thead>
        <tbody>
          {log.map((entry, idx) => (
            <tr key={`${entry.date}-${idx}`} className="border-b border-slate-50 hover:bg-slate-50 transition-colors">
              <td className="px-4 py-2.5 text-slate-700">{new Date(entry.date).toLocaleString()}</td>
              <td className="px-4 py-2.5"><LogStatusBadge status={entry.status} /></td>
              <td className="px-4 py-2.5 text-slate-700">{entry.created}</td>
              <td className="px-4 py-2.5 text-slate-700">{entry.updated}</td>
              <td className="px-4 py-2.5 text-slate-700">{entry.retired}</td>
              <td className="px-4 py-2.5 text-slate-700">{entry.errors}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

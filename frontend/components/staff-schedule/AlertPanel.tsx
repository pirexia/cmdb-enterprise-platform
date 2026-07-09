"use client";

import { AlertTriangle, AlertCircle, RefreshCw } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import type { ScheduleAlertItem } from "@/app/staff-schedule/types";

interface Props {
  alerts: ScheduleAlertItem[];
  canEdit: boolean;
  onRevalidate: () => void;
  revalidating: boolean;
  usernameByUserId: Record<string, string>;
}

export default function AlertPanel({ alerts, canEdit, onRevalidate, revalidating, usernameByUserId }: Props) {
  const { t } = useLanguage();
  const errors = alerts.filter((a) => a.severity === "ERROR");
  const warnings = alerts.filter((a) => a.severity === "WARNING");

  const renderAlert = (a: ScheduleAlertItem) => {
    const isError = a.severity === "ERROR";
    return (
      <li
        key={a.id}
        className={`px-3 py-2.5 text-xs border-l-4 ${isError ? "border-red-500 bg-red-50" : "border-amber-400 bg-amber-50"}`}
      >
        <p className={`font-semibold ${isError ? "text-red-800" : "text-amber-800"}`}>
          {t(`staffSchedule.alert.${a.type}`)}
        </p>
        <p className="text-slate-600 mt-0.5">{a.message}</p>
        {(a.userId || a.date) && (
          <p className="text-slate-400 mt-1">
            {a.userId && (usernameByUserId[a.userId] ?? a.userId)}
            {a.userId && a.date && " · "}
            {a.date}
          </p>
        )}
      </li>
    );
  };

  return (
    <div className="bg-white shadow-sm ring-1 ring-slate-200 rounded-none">
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
        <h2 className="text-sm font-semibold text-slate-900">{t("staffSchedule.alert.title")}</h2>
        {canEdit && (
          <button
            type="button"
            onClick={onRevalidate}
            disabled={revalidating}
            className="rounded-none border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 flex items-center gap-1"
          >
            <RefreshCw className={`h-3 w-3 ${revalidating ? "animate-spin" : ""}`} />
            {t("staffSchedule.action.validate")}
          </button>
        )}
      </div>

      {alerts.length === 0 ? (
        <p className="px-4 py-6 text-xs text-slate-400 text-center">—</p>
      ) : (
        <ul className="divide-y divide-slate-100 max-h-[32rem] overflow-y-auto">
          {errors.length > 0 && (
            <li className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-red-700 bg-red-50/50 flex items-center gap-1">
              <AlertCircle className="h-3 w-3" /> {t("staffSchedule.alert.severity.ERROR")} ({errors.length})
            </li>
          )}
          {errors.map(renderAlert)}
          {warnings.length > 0 && (
            <li className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-amber-700 bg-amber-50/50 flex items-center gap-1">
              <AlertTriangle className="h-3 w-3" /> {t("staffSchedule.alert.severity.WARNING")} ({warnings.length})
            </li>
          )}
          {warnings.map(renderAlert)}
        </ul>
      )}
    </div>
  );
}

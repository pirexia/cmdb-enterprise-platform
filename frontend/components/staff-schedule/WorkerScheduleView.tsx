"use client";

import { useMemo } from "react";
import { RefreshCw, Lock } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import type { ScheduleStatus, WorkerEntryItem } from "@/app/staff-schedule/types";
import { addDaysIso, mondayOf, useWorkerEntries, useWorkerMonthlySummary } from "@/app/staff-schedule/hooks/useStaffSchedule";
import ScheduleCell from "./ScheduleCell";

interface Props {
  userId: string;
  workerLabel: string;
  // v3.5.13 (D3) — cuando isExternal, la impresión debe mostrar printLabel
  // ("Externo (INI)") en vez de workerLabel, incluso si el visor (ADMIN/
  // MANAGER) ve el nombre real en pantalla legítimamente.
  isExternal: boolean;
  printLabel: string | null;
  mode: "week" | "month";
  /** Monday (UTC ISO), used when mode === 'week'. */
  weekStart: string;
  /** Used when mode === 'month' (1-12). */
  year: number;
  month: number;
}

const TELEWORK_LIKE: ScheduleStatus[] = ["TELETRABAJO", "INTENSIVO_TELETRABAJO"];

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Last day of `month` (1-based) as UTC ISO yyyy-mm-dd. */
function lastDayOfMonthIso(year: number, month: number): string {
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

function formatDay(iso: string, opts: Intl.DateTimeFormatOptions) {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, { ...opts, timeZone: "UTC" });
}

// v3.5.12 (R5/F4) — read-only week/month view of a single worker's schedule,
// selected via WorkerFilter. Never editable (per spec §5 "Fuera de alcance":
// writing stays exclusive to the department-week view, where row-level
// authorization actually lives). Mode and date range are owned by the
// parent (page.tsx, F-INT) and passed in as props — this component doesn't
// keep its own period state, so wiring it up is a prop-drill, not a rewrite.
export default function WorkerScheduleView({ userId, workerLabel, isExternal, printLabel, mode, weekStart, year, month }: Props) {
  const { t } = useLanguage();

  const nameNode = isExternal ? (
    <>
      <span className="no-print">{workerLabel}</span>
      <span className="print-only">{printLabel}</span>
    </>
  ) : (
    workerLabel
  );

  const weekDays = useMemo(() => [0, 1, 2, 3, 4].map((n) => addDaysIso(weekStart, n)), [weekStart]);
  const weekTo = weekDays[weekDays.length - 1];

  const monthStart = useMemo(() => `${year}-${pad2(month)}-01`, [year, month]);
  const monthEnd = useMemo(() => lastDayOfMonthIso(year, month), [year, month]);

  // Weeks of the month, as Monday ISO dates, capped defensively at 6 (a
  // calendar month never needs more than 6 Mon-Fri rows).
  const monthWeeks = useMemo(() => {
    if (mode !== "month") return [];
    const weeks: string[] = [];
    let cursor = mondayOf(new Date(`${monthStart}T00:00:00Z`));
    for (let i = 0; i < 6 && cursor <= monthEnd; i++) {
      weeks.push(cursor);
      cursor = addDaysIso(cursor, 7);
    }
    return weeks;
  }, [mode, monthStart, monthEnd]);

  // Mon-Fri header labels for the month grid, derived from the browser's
  // locale (same `toLocaleDateString` used elsewhere in this module) rather
  // than hardcoded English abbreviations behind a translation key — any
  // Monday works, the weekday name doesn't depend on which one.
  const weekdayHeaderLabels = useMemo(() => {
    if (monthWeeks.length === 0) return ["", "", "", "", ""];
    const anyMonday = monthWeeks[0];
    return [0, 1, 2, 3, 4].map((n) => formatDay(addDaysIso(anyMonday, n), { weekday: "short" }));
  }, [monthWeeks]);

  const from = mode === "week" ? weekStart : monthStart;
  const to = mode === "week" ? weekTo : monthEnd;

  const { entries, loading, error } = useWorkerEntries(userId, from, to);
  const { summary: monthlySummary } = useWorkerMonthlySummary(mode === "month" ? userId : null, year, month);

  const entryMap = useMemo(() => {
    const map = new Map<string, WorkerEntryItem>();
    for (const e of entries) map.set(e.date, e);
    return map;
  }, [entries]);

  // Week-mode summary: derived client-side from the (already masked)
  // entries themselves — no separate weekly aggregate endpoint exists for a
  // single worker, and these counts don't need anything the masking hid.
  // `weeklyTargetHours` is shown only if the server actually sent it on at
  // least one entry (R2 omission pattern — nothing hidden client-side).
  const weekSummary = useMemo(() => {
    if (mode !== "week") return null;
    let teleworkDays = 0;
    let travelDays = 0;
    let guardDays = 0;
    let weeklyTargetHours: number | undefined;
    for (const day of weekDays) {
      const item = entryMap.get(day);
      if (!item) continue;
      if (TELEWORK_LIKE.includes(item.status as ScheduleStatus)) teleworkDays++;
      if (item.status === "VIAJE") travelDays++;
      if (item.onGuard) guardDays++;
      if (item.weeklyTargetHours !== undefined) weeklyTargetHours = item.weeklyTargetHours;
    }
    return { teleworkDays, travelDays, guardDays, weeklyTargetHours };
  }, [mode, entryMap, weekDays]);

  if (loading && entries.length === 0) {
    return (
      <div className="flex items-center gap-2 text-slate-400 py-8 justify-center">
        <RefreshCw className="h-4 w-4 animate-spin" />
        <span className="text-sm">{t("common.loading_data")}</span>
      </div>
    );
  }

  if (error) {
    return <div className="text-sm text-red-600 py-4">{t("staffSchedule.worker.loadError")}</div>;
  }

  return (
    <div className="print-block space-y-4">
      <div className="text-sm font-semibold text-slate-800">{nameNode}</div>

      {mode === "week" ? (
        <div className="bg-white shadow-sm ring-1 ring-slate-200 overflow-auto">
          <table className="w-full table-fixed border-collapse text-sm">
            <colgroup>
              <col style={{ width: "16%" }} />
              {weekDays.map((d) => (
                <col key={d} style={{ width: "16.8%" }} />
              ))}
            </colgroup>
            <thead className="bg-slate-50">
              <tr>
                <th className="border border-slate-100 px-3 py-2 text-left text-xs font-semibold text-slate-600">
                  {t("staffSchedule.calendar.person")}
                </th>
                {weekDays.map((d) => (
                  <th key={d} className="border border-slate-100 px-2 py-2 text-center text-xs font-semibold text-slate-600">
                    {formatDay(d, { weekday: "short", day: "2-digit", month: "2-digit" })}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="border border-slate-100 px-3 py-2 text-xs font-medium text-slate-800">{nameNode}</td>
                {weekDays.map((d) => (
                  <ScheduleCell key={d} entry={entryMap.get(d)} editable={false} onClick={() => {}} />
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      ) : (
        <div className="bg-white shadow-sm ring-1 ring-slate-200 overflow-auto">
          <table className="w-full table-fixed border-collapse text-sm">
            <colgroup>
              {[0, 1, 2, 3, 4].map((n) => (
                <col key={n} style={{ width: "20%" }} />
              ))}
            </colgroup>
            <thead className="bg-slate-50">
              <tr>
                {weekdayHeaderLabels.map((label, i) => (
                  <th key={i} className="border border-slate-100 px-2 py-2 text-center text-xs font-semibold text-slate-600">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {monthWeeks.length === 0 ? (
                <tr>
                  <td colSpan={5} className="border border-slate-100 px-3 py-6 text-center text-xs text-slate-400">
                    {t("staffSchedule.worker.noEntries")}
                  </td>
                </tr>
              ) : (
                monthWeeks.map((weekMonday) => (
                  <tr key={weekMonday}>
                    {[0, 1, 2, 3, 4].map((n) => {
                      const day = addDaysIso(weekMonday, n);
                      const inMonth = day >= monthStart && day <= monthEnd;
                      if (!inMonth) {
                        return <td key={day} className="border border-slate-100 bg-slate-50/50 h-11" />;
                      }
                      const dayNumber = Number(day.slice(8, 10));
                      return <ScheduleCell key={day} entry={entryMap.get(day)} editable={false} onClick={() => {}} dayNumber={dayNumber} />;
                    })}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {mode === "week" && weekSummary && (
        // no-print: same "no summary/hours block on paper" rule as the
        // department calendar's summary column, regardless of role.
        <div className="no-print bg-white shadow-sm ring-1 ring-slate-200 px-4 py-3 text-xs text-slate-600 space-y-1">
          {weekSummary.weeklyTargetHours !== undefined && (
            <div>
              {t("staffSchedule.summary.weeklyHours")}: {weekSummary.weeklyTargetHours.toFixed(1)}h
            </div>
          )}
          <div>{t("staffSchedule.summary.teleworkDaysWeek")}: {weekSummary.teleworkDays}</div>
          <div>{t("staffSchedule.summary.travelDays")}: {weekSummary.travelDays}</div>
          <div>{t("staffSchedule.summary.guardDays")}: {weekSummary.guardDays}</div>
        </div>
      )}

      {mode === "month" && monthlySummary && (
        <div className="no-print bg-white shadow-sm ring-1 ring-slate-200 px-4 py-3 text-xs text-slate-600 space-y-1">
          <div>{t("staffSchedule.worker.monthlyNetHours")}: {monthlySummary.netHours.toFixed(1)}h</div>
          <div>{t("staffSchedule.summary.teleworkDaysMonth")}: {monthlySummary.teleworkDays}</div>
          <div>{t("staffSchedule.summary.travelDays")}: {monthlySummary.travelDays}</div>
          <div>{t("staffSchedule.summary.guardDays")}: {monthlySummary.guardDays}</div>
          <div>{t("staffSchedule.worker.vacationDays")}: {monthlySummary.vacationDays}</div>
          {monthlySummary.healthLeaveDays !== undefined && (
            <div className="flex items-center gap-1">
              <Lock className="h-3 w-3" />
              {t("staffSchedule.worker.healthLeaveDays")}: {monthlySummary.healthLeaveDays}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

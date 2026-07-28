"use client";

import { useState } from "react";
import { useLanguage } from "@/contexts/LanguageContext";
import type { DepartmentScheduleConfig, EntryUpdateInput, ScheduleView } from "@/app/staff-schedule/types";
import ScheduleCell from "./ScheduleCell";
import ScheduleEntryPopover from "./ScheduleEntryPopover";
import { displayLabel } from "@/lib/displayLabel";

interface Props {
  view: ScheduleView;
  departmentConfig: DepartmentScheduleConfig | null;
  onSaveEntry: (entry: EntryUpdateInput) => Promise<void>;
  onSaveEntries: (entries: EntryUpdateInput[]) => Promise<void>;
  readOnly?: boolean;
}

export default function StaffScheduleCalendar({ view, departmentConfig, onSaveEntry, onSaveEntries, readOnly }: Props) {
  const { t } = useLanguage();
  const [editing, setEditing] = useState<{ userId: string; username: string; date: string } | null>(null);

  const editable = !readOnly && view.canEdit && view.schedule.status === "DRAFT";

  const breakMinutes = view.schedule.isSummerWeek
    ? (departmentConfig?.summerBreakMinutes ?? 30)
    : (departmentConfig?.winterBreakMinutes ?? 60);

  const formatDay = (iso: string) =>
    new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, {
      weekday: "short",
      day: "2-digit",
      month: "2-digit",
      timeZone: "UTC",
    });

  const editingRow = editing ? view.rows.find((r) => r.userId === editing.userId) : undefined;
  // R2/B1: `summary` may be absent for viewers not authorized to see it
  // (backend omits it entirely, not just zeroes it) — fall back to 8h/day.
  const dailyNetHours = editingRow?.summary ? editingRow.summary.weeklyTargetHours / 5 : 8;

  // R1: the summary column only exists (and only gets a colgroup slice) when
  // at least one row actually carries `summary`. Rows are per-viewer, not
  // per-row, so in practice it's all-or-nothing, but we don't assume that.
  const hasSummary = view.rows.some((r) => r.summary);

  return (
    <div className="print-block bg-white shadow-sm ring-1 ring-slate-200 overflow-auto max-h-[70vh]">
      <table className="w-full min-w-[60rem] table-fixed border-collapse text-sm">
        <colgroup>
          <col style={{ width: "16%" }} />
          {view.days.map((d) => (
            <col key={d} style={{ width: hasSummary ? "13.6%" : "16.8%" }} />
          ))}
          {/* no-print: the summary column never appears on paper, regardless
              of role (print requirement) — see app/print.css. */}
          {hasSummary && <col className="no-print" style={{ width: "16%" }} />}
        </colgroup>
        <thead className="sticky top-0 z-20 bg-slate-50">
          <tr>
            <th className="sticky left-0 z-30 bg-slate-50 border border-slate-100 px-3 py-2 text-left text-xs font-semibold text-slate-600">
              {t("staffSchedule.calendar.person")}
            </th>
            {view.days.map((d) => (
              <th key={d} className="border border-slate-100 px-2 py-2 text-center text-xs font-semibold text-slate-600">
                {formatDay(d)}
              </th>
            ))}
            {hasSummary && (
              <th className="no-print border border-slate-100 px-3 py-2 text-center text-xs font-semibold text-slate-600">
                {t("staffSchedule.summary.weeklyHours")}
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {view.rows.map((row) => (
            <tr key={row.userId}>
              <td className="sticky left-0 z-10 bg-white border border-slate-100 px-3 py-2 text-xs font-medium text-slate-800">
                {displayLabel(row)}
              </td>
              {view.days.map((d) => (
                <ScheduleCell
                  key={d}
                  entry={row.entries[d]}
                  editable={editable}
                  onClick={() => setEditing({ userId: row.userId, username: displayLabel(row), date: d })}
                />
              ))}
              {hasSummary && (
                <td className="no-print border border-slate-100 px-3 py-2 text-xs text-slate-600">
                  {row.summary ? (
                    <>
                      <div>{t("staffSchedule.summary.weeklyHours")}: {row.summary.weeklyNetHours.toFixed(1)}h / {row.summary.weeklyTargetHours.toFixed(1)}h</div>
                      <div>{t("staffSchedule.summary.teleworkDaysWeek")}: {row.summary.teleworkDaysWeek}</div>
                      <div>{t("staffSchedule.summary.teleworkDaysMonth")}: {row.summary.teleworkDaysMonth}</div>
                      <div>{t("staffSchedule.summary.travelDays")}: {row.summary.travelDays}</div>
                      <div>{t("staffSchedule.summary.guardDays")}: {row.summary.guardDays}</div>
                    </>
                  ) : (
                    <span className="text-slate-300">—</span>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>

      {editing && (
        <ScheduleEntryPopover
          userId={editing.userId}
          username={editing.username}
          date={editing.date}
          entry={view.rows.find((r) => r.userId === editing.userId)?.entries[editing.date]}
          breakMinutes={breakMinutes}
          dailyNetHours={dailyNetHours}
          onClose={() => setEditing(null)}
          onSave={onSaveEntry}
          onApplyWeek={async (partial) => {
            const entries: EntryUpdateInput[] = view.days.map((d) => ({ date: d, ...partial }));
            await onSaveEntries(entries);
          }}
        />
      )}
    </div>
  );
}

"use client";

import { useState } from "react";
import { useLanguage } from "@/contexts/LanguageContext";
import type { EntryUpdateInput, ScheduleView } from "@/app/staff-schedule/types";
import ScheduleCell from "./ScheduleCell";
import ScheduleEntryPopover from "./ScheduleEntryPopover";

interface Props {
  view: ScheduleView;
  onSaveEntry: (entry: EntryUpdateInput) => Promise<void>;
}

export default function StaffScheduleCalendar({ view, onSaveEntry }: Props) {
  const { t } = useLanguage();
  const [editing, setEditing] = useState<{ userId: string; username: string; date: string } | null>(null);

  const editable = view.canEdit && view.schedule.status === "DRAFT";

  const formatDay = (iso: string) =>
    new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, {
      weekday: "short",
      day: "2-digit",
      month: "2-digit",
      timeZone: "UTC",
    });

  return (
    <div className="bg-white shadow-sm ring-1 ring-slate-200 overflow-auto max-h-[70vh]">
      <table className="w-full border-collapse text-sm">
        <thead className="sticky top-0 z-20 bg-slate-50">
          <tr>
            <th className="sticky left-0 z-30 bg-slate-50 border border-slate-100 px-3 py-2 text-left text-xs font-semibold text-slate-600 min-w-[10rem]">
              {t("staffSchedule.calendar.person")}
            </th>
            {view.days.map((d) => (
              <th key={d} className="border border-slate-100 px-2 py-2 text-center text-xs font-semibold text-slate-600 min-w-[9rem]">
                {formatDay(d)}
              </th>
            ))}
            <th className="border border-slate-100 px-3 py-2 text-center text-xs font-semibold text-slate-600 min-w-[10rem]">
              {t("staffSchedule.summary.weeklyHours")}
            </th>
          </tr>
        </thead>
        <tbody>
          {view.rows.map((row) => (
            <tr key={row.userId}>
              <td className="sticky left-0 z-10 bg-white border border-slate-100 px-3 py-2 text-xs font-medium text-slate-800">
                {row.username}
              </td>
              {view.days.map((d) => (
                <ScheduleCell
                  key={d}
                  entry={row.entries[d]}
                  editable={editable}
                  onClick={() => setEditing({ userId: row.userId, username: row.username, date: d })}
                />
              ))}
              <td className="border border-slate-100 px-3 py-2 text-xs text-slate-600">
                <div>{t("staffSchedule.summary.weeklyHours")}: {row.summary.weeklyNetHours.toFixed(1)}h</div>
                <div>{t("staffSchedule.summary.teleworkDays")}: {row.summary.teleworkDaysMonth}</div>
                <div>{t("staffSchedule.summary.travelDays")}: {row.summary.travelDays}</div>
                <div>{t("staffSchedule.summary.guardDays")}: {row.summary.guardDays}</div>
              </td>
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
          onClose={() => setEditing(null)}
          onSave={onSaveEntry}
        />
      )}
    </div>
  );
}

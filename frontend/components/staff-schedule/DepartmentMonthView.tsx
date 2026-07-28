"use client";

import { RefreshCw, AlertTriangle } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { addDaysIso, useDepartmentMonth } from "@/app/staff-schedule/hooks/useStaffSchedule";
import StaffScheduleCalendar from "./StaffScheduleCalendar";

interface Props {
  departmentId: string;
  year: number;
  month: number; // 1-12
}

// Read-only: a department's schedules for every week overlapping a calendar
// month, stacked vertically. Editing always requires the single
// department+week view (row-level authorization and the write endpoints are
// per-schedule) — same product decision as AllDepartmentsView, applied here
// to a different axis (weeks of one department, not one department per
// week). Weeks with no schedule are rendered as an explicit empty row
// (D8) rather than omitted, so a genuine gap in planning is never confused
// with a loading/fetch failure.
export default function DepartmentMonthView({ departmentId, year, month }: Props) {
  const { t } = useLanguage();
  const { weeks, loading, error } = useDepartmentMonth(departmentId, year, month);

  const formatRange = (weekStart: string) => {
    const weekEnd = addDaysIso(weekStart, 4); // Monday..Friday, matches the weekly calendar's day range
    const fmt = (iso: string) =>
      new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        timeZone: "UTC",
      });
    return `${fmt(weekStart)} – ${fmt(weekEnd)}`;
  };

  if (loading) {
    return (
      <div className="bg-white shadow-sm ring-1 ring-slate-200 p-8 flex items-center justify-center gap-3 text-slate-500 text-sm">
        <RefreshCw className="h-4 w-4 animate-spin" />
        {t("common.loading")}
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center gap-2 bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
        <AlertTriangle className="h-4 w-4 shrink-0" />
        {t("common.unknown_error")}
      </div>
    );
  }

  if (weeks.length === 0) {
    return (
      <div className="bg-white shadow-sm ring-1 ring-slate-200 p-8 text-center text-sm text-slate-500">
        {t("staffSchedule.empty.noSchedule")}
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {weeks.map(({ weekStart, view }) => (
        <div key={weekStart} className="print-block space-y-2">
          <h2 className="text-sm font-bold text-slate-900">{formatRange(weekStart)}</h2>
          {view ? (
            <StaffScheduleCalendar
              view={view}
              departmentConfig={null}
              onSaveEntry={async () => {}}
              onSaveEntries={async () => {}}
              readOnly
            />
          ) : (
            <div className="bg-white shadow-sm ring-1 ring-slate-200 p-6 text-center text-sm text-slate-500">
              {t("staffSchedule.month.weekNoSchedule")}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

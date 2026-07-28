"use client";

import { RefreshCw, AlertTriangle } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAllDepartmentsSchedules } from "@/app/staff-schedule/hooks/useStaffSchedule";
import StaffScheduleCalendar from "./StaffScheduleCalendar";
import PrintButton from "./PrintButton";
import PrintHeader from "./PrintHeader";

interface Props {
  weekStart: string;
}

// Read-only aggregate of every department's schedule for the given week.
// Editing always requires picking a single department (row-level
// authorization and the write endpoints are per-department) — this view is
// deliberately view-only, per product decision.
export default function AllDepartmentsView({ weekStart }: Props) {
  const { t } = useLanguage();
  const { entries, loading, error } = useAllDepartmentsSchedules(weekStart);

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

  if (entries.length === 0) {
    return (
      <div className="bg-white shadow-sm ring-1 ring-slate-200 p-8 text-center text-sm text-slate-500">
        {t("staffSchedule.empty.noSchedule")}
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="flex justify-end no-print">
        <PrintButton
          scope="DEPARTMENT_WEEK"
          targetIds={entries.map((e) => e.department.id)}
          from={weekStart}
          to={weekStart}
        />
      </div>
      <PrintHeader
        title={t("staffSchedule.title")}
        subtitle={t("staffSchedule.filter.allDepartments")}
        rangeLabel={weekStart}
      />
      {entries.map(({ department, view }) => (
        <div key={department.id} className="print-block space-y-2">
          <h2 className="text-sm font-bold text-slate-900">{department.name}</h2>
          <StaffScheduleCalendar
            view={view}
            departmentConfig={null}
            onSaveEntry={async () => {}}
            onSaveEntries={async () => {}}
            readOnly
          />
        </div>
      ))}
    </div>
  );
}

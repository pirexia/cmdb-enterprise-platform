"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { addDaysIso, mondayOf } from "@/app/staff-schedule/hooks/useStaffSchedule";

interface Props {
  weekStart: string;
  onChange: (weekStart: string) => void;
}

export default function WeekSelector({ weekStart, onChange }: Props) {
  const { t } = useLanguage();

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => onChange(addDaysIso(weekStart, -7))}
        title={t("staffSchedule.weekSelector.prev")}
        className="rounded-none border border-slate-300 bg-white p-2 text-slate-600 hover:bg-slate-50"
      >
        <ChevronLeft className="h-4 w-4" />
      </button>
      <input
        type="date"
        value={weekStart}
        onChange={(e) => onChange(mondayOf(new Date(`${e.target.value}T00:00:00Z`)))}
        className="rounded-none border border-slate-300 px-2.5 py-2 text-sm"
      />
      <button
        type="button"
        onClick={() => onChange(addDaysIso(weekStart, 7))}
        title={t("staffSchedule.weekSelector.next")}
        className="rounded-none border border-slate-300 bg-white p-2 text-slate-600 hover:bg-slate-50"
      >
        <ChevronRight className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={() => onChange(mondayOf(new Date()))}
        className="rounded-none border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50"
      >
        {t("staffSchedule.weekSelector.today")}
      </button>
    </div>
  );
}

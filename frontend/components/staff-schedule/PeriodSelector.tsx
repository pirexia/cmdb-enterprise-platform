"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { addDaysIso, addMonthsIso, mondayOf } from "@/app/staff-schedule/hooks/useStaffSchedule";

type Props =
  | {
      mode: "week";
      weekStart: string;
      onWeekChange: (weekStart: string) => void;
    }
  | {
      mode: "month";
      year: number;
      month: number; // 1-12
      onMonthChange: (year: number, month: number) => void;
    };

const navButtonClass =
  "rounded-none border border-slate-300 bg-white p-2 text-slate-600 hover:bg-slate-50";
const todayButtonClass =
  "rounded-none border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50";
const inputClass = "rounded-none border border-slate-300 px-2.5 py-2 text-sm";

/** Generalizes WeekSelector (R6): navigates by week or by calendar month. */
export default function PeriodSelector(props: Props) {
  const { t } = useLanguage();

  if (props.mode === "week") {
    const { weekStart, onWeekChange } = props;
    return (
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => onWeekChange(addDaysIso(weekStart, -7))}
          title={t("staffSchedule.weekSelector.prev")}
          className={navButtonClass}
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <input
          type="date"
          value={weekStart}
          onChange={(e) => onWeekChange(mondayOf(new Date(`${e.target.value}T00:00:00Z`)))}
          className={inputClass}
        />
        <button
          type="button"
          onClick={() => onWeekChange(addDaysIso(weekStart, 7))}
          title={t("staffSchedule.weekSelector.next")}
          className={navButtonClass}
        >
          <ChevronRight className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => onWeekChange(mondayOf(new Date()))}
          className={todayButtonClass}
        >
          {t("staffSchedule.weekSelector.today")}
        </button>
      </div>
    );
  }

  const { year, month, onMonthChange } = props;
  const monthValue = `${year}-${String(month).padStart(2, "0")}`;

  const goToMonth = (delta: number) => {
    const next = addMonthsIso(year, month, delta);
    onMonthChange(next.year, next.month);
  };

  const goToThisMonth = () => {
    const now = new Date();
    onMonthChange(now.getFullYear(), now.getMonth() + 1);
  };

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => goToMonth(-1)}
        title={t("staffSchedule.periodSelector.prevMonth")}
        className={navButtonClass}
      >
        <ChevronLeft className="h-4 w-4" />
      </button>
      <input
        type="month"
        value={monthValue}
        onChange={(e) => {
          const [y, m] = e.target.value.split("-").map(Number);
          if (!Number.isNaN(y) && !Number.isNaN(m)) onMonthChange(y, m);
        }}
        className={inputClass}
      />
      <button
        type="button"
        onClick={() => goToMonth(1)}
        title={t("staffSchedule.periodSelector.nextMonth")}
        className={navButtonClass}
      >
        <ChevronRight className="h-4 w-4" />
      </button>
      <button type="button" onClick={goToThisMonth} className={todayButtonClass}>
        {t("staffSchedule.periodSelector.thisMonth")}
      </button>
    </div>
  );
}

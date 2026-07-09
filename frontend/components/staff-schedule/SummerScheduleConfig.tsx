"use client";

import { useEffect, useState } from "react";
import { useLanguage } from "@/contexts/LanguageContext";
import { useSummerSchedule } from "@/app/staff-schedule/hooks/useStaffSchedule";

export default function SummerScheduleConfig() {
  const { t } = useLanguage();
  const currentYear = new Date().getFullYear();
  const [year, setYear] = useState(currentYear);
  const { summer, save } = useSummerSchedule(year);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setStartDate(summer?.startDate?.slice(0, 10) ?? "");
    setEndDate(summer?.endDate?.slice(0, 10) ?? "");
  }, [summer]);

  const handleSave = async () => {
    if (!startDate || !endDate) return;
    setSaving(true);
    setError(null);
    try {
      await save({ year, startDate, endDate });
    } catch (e) {
      setError(e instanceof Error ? e.message : "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-white shadow-sm ring-1 ring-slate-200 p-5 space-y-4">
      <h3 className="text-sm font-semibold text-slate-900">{t("staffSchedule.config.summerSchedule")}</h3>

      <div className="grid grid-cols-3 gap-3">
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">{t("staffSchedule.summer.year")}</label>
          <input
            type="number"
            value={year}
            onChange={(e) => setYear(Number(e.target.value))}
            className="w-full rounded-none border border-slate-300 px-2.5 py-2 text-sm"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">{t("staffSchedule.config.summerStart")}</label>
          <input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            className="w-full rounded-none border border-slate-300 px-2.5 py-2 text-sm"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">{t("staffSchedule.config.summerEnd")}</label>
          <input
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            className="w-full rounded-none border border-slate-300 px-2.5 py-2 text-sm"
          />
        </div>
      </div>

      {error && <p className="text-xs text-red-600">{error}</p>}

      <button
        type="button"
        onClick={handleSave}
        disabled={saving || !startDate || !endDate}
        className="rounded-none bg-[var(--accent)] px-4 py-2 text-xs font-semibold text-white hover:bg-[var(--accent)]/90 shadow-sm disabled:opacity-50"
      >
        {t("staffSchedule.action.save")}
      </button>
    </div>
  );
}

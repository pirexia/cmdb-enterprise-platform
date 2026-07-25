"use client";

import { useState } from "react";
import { X } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { mondayOf } from "@/app/staff-schedule/hooks/useStaffSchedule";

interface Props {
  onClose: () => void;
  onConfirm: (targetWeekStart: string) => Promise<void>;
}

export default function WeekTargetPicker({ onClose, onConfirm }: Props) {
  const { t } = useLanguage();
  const [date, setDate] = useState(() => {
    const nextMonday = new Date();
    nextMonday.setDate(nextMonday.getDate() + 7);
    return mondayOf(nextMonday);
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleConfirm = async () => {
    setSaving(true);
    setError(null);
    try {
      await onConfirm(mondayOf(new Date(`${date}T00:00:00Z`)));
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4" onClick={onClose}>
      <div className="w-full max-w-sm bg-white shadow-sm ring-1 ring-slate-200 rounded-none" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3.5">
          <p className="text-sm font-semibold text-slate-900">{t("staffSchedule.clone.pickWeek")}</p>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-3 px-5 py-4">
          <label className="block text-xs font-medium text-slate-600 mb-1">{t("staffSchedule.clone.targetWeek")}</label>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="w-full rounded-none border border-slate-300 px-2.5 py-2 text-sm"
          />
          <p className="text-xs text-slate-500">{t("staffSchedule.clone.mustBeFutureEmpty")}</p>
          {error && <p className="text-xs text-red-600">{error}</p>}
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-200 px-5 py-3.5">
          <button
            onClick={onClose}
            className="rounded-none border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50"
          >
            {t("actions.cancel")}
          </button>
          <button
            onClick={handleConfirm}
            disabled={saving}
            className="rounded-none bg-[var(--accent)] px-4 py-2 text-xs font-semibold text-white hover:bg-[var(--accent)]/90 shadow-sm disabled:opacity-50"
          >
            {t("staffSchedule.action.clone")}
          </button>
        </div>
      </div>
    </div>
  );
}

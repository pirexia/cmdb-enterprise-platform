"use client";

import { useState } from "react";
import { X } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { SCHEDULE_STATUS, type EntryUpdateInput, type MaskedEntryFields, type ScheduleStatus } from "@/app/staff-schedule/types";

interface Props {
  userId: string;
  username: string;
  date: string;
  entry: MaskedEntryFields | undefined;
  onClose: () => void;
  onSave: (entry: EntryUpdateInput) => Promise<void>;
}

export default function ScheduleEntryPopover({ userId, username, date, entry, onClose, onSave }: Props) {
  const { t } = useLanguage();
  const [status, setStatus] = useState<ScheduleStatus>((entry?.status as ScheduleStatus) ?? "PRESENCIAL");
  const [startTime, setStartTime] = useState(entry?.startTime ?? "");
  const [endTime, setEndTime] = useState(entry?.endTime ?? "");
  const [notes, setNotes] = useState(entry?.notes ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave({
        userId,
        date,
        status,
        startTime: startTime || null,
        endTime: endTime || null,
        notes: notes || null,
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4" onClick={onClose}>
      <div
        className="w-full max-w-sm bg-white shadow-sm ring-1 ring-slate-200 rounded-none"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3.5">
          <div>
            <p className="text-sm font-semibold text-slate-900">{username}</p>
            <p className="text-xs text-slate-500">{date}</p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 px-5 py-4">
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">
              {t("staffSchedule.entry.status")}
            </label>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as ScheduleStatus)}
              className="w-full rounded-none border border-slate-300 px-2.5 py-2 text-sm"
            >
              {SCHEDULE_STATUS.map((s) => (
                <option key={s} value={s}>
                  {t(`staffSchedule.status.${s}`)}
                </option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">{t("staffSchedule.entry.startTime")}</label>
              <input
                type="time"
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
                className="w-full rounded-none border border-slate-300 px-2.5 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">{t("staffSchedule.entry.endTime")}</label>
              <input
                type="time"
                value={endTime}
                onChange={(e) => setEndTime(e.target.value)}
                className="w-full rounded-none border border-slate-300 px-2.5 py-2 text-sm"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">{t("staffSchedule.entry.notes")}</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className="w-full rounded-none border border-slate-300 px-2.5 py-2 text-sm"
            />
          </div>

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
            onClick={handleSave}
            disabled={saving}
            className="rounded-none bg-[var(--accent)] px-4 py-2 text-xs font-semibold text-white hover:bg-[var(--accent)]/90 shadow-sm disabled:opacity-50"
          >
            {t("staffSchedule.action.save")}
          </button>
        </div>
      </div>
    </div>
  );
}

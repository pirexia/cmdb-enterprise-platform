"use client";

import { Lock } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import type { MaskedEntryFields, ScheduleStatus } from "@/app/staff-schedule/types";

export const STATUS_META: Record<string, { bg: string; text: string }> = {
  PRESENCIAL: { bg: "bg-blue-100", text: "text-blue-800" },
  TELETRABAJO: { bg: "bg-green-100", text: "text-green-800" },
  VACACIONES: { bg: "bg-orange-100", text: "text-orange-800" },
  BAJA_MEDICA: { bg: "bg-red-100", text: "text-red-800" },
  BAJA_PATERNIDAD: { bg: "bg-emerald-200", text: "text-emerald-900" },
  GUARDIA: { bg: "bg-yellow-100", text: "text-yellow-800" },
  INTENSIVO: { bg: "bg-purple-100", text: "text-purple-800" },
  VIAJE: { bg: "bg-cyan-100", text: "text-cyan-800" },
  AUSENTE: { bg: "bg-slate-100", text: "text-slate-600" },
};

interface Props {
  entry: MaskedEntryFields | undefined;
  editable: boolean;
  onClick: () => void;
}

export default function ScheduleCell({ entry, editable, onClick }: Props) {
  const { t } = useLanguage();

  if (!entry) {
    return (
      <td className="border border-slate-100 p-1 align-top">
        <button
          type="button"
          onClick={editable ? onClick : undefined}
          disabled={!editable}
          className={`w-full h-full min-h-[3.5rem] text-xs text-slate-300 ${editable ? "hover:bg-slate-50 cursor-pointer" : "cursor-default"}`}
        >
          {editable ? "+" : "—"}
        </button>
      </td>
    );
  }

  const meta = STATUS_META[entry.status] ?? STATUS_META.AUSENTE;

  return (
    <td className="border border-slate-100 p-1 align-top">
      <button
        type="button"
        onClick={editable ? onClick : undefined}
        disabled={!editable}
        title={entry.healthMasked ? t("staffSchedule.gdpr.maskedNotice") : undefined}
        className={`w-full min-h-[3.5rem] rounded-none px-2 py-1.5 text-left text-xs ${meta.bg} ${meta.text} ${editable ? "hover:opacity-80 cursor-pointer" : "cursor-default"}`}
      >
        <span className="flex items-center gap-1 font-semibold">
          {t(`staffSchedule.status.${entry.status as ScheduleStatus}`)}
          {entry.healthMasked && <Lock className="h-3 w-3 shrink-0" />}
        </span>
        {entry.startTime && entry.endTime && (
          <span className="block mt-0.5 text-[11px] opacity-80">
            {entry.startTime}–{entry.endTime}
          </span>
        )}
      </button>
    </td>
  );
}

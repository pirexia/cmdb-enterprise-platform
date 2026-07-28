"use client";

import { Lock } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import type { MaskedEntryFields, ScheduleStatus } from "@/app/staff-schedule/types";

export const STATUS_META: Record<string, { bg: string; text: string }> = {
  PRESENCIAL: { bg: "bg-blue-100", text: "text-blue-800" },
  TELETRABAJO: { bg: "bg-green-100", text: "text-green-800" },
  VACACIONES: { bg: "bg-orange-100", text: "text-orange-800" },
  // v3.5.12 — national/local holidays: indigo/violet family, distinct from
  // VACACIONES' orange so the two "day off" reasons stay visually separable.
  FESTIVO: { bg: "bg-indigo-100", text: "text-indigo-800" },
  FESTIVO_LOCAL: { bg: "bg-violet-100", text: "text-violet-800" },
  BAJA_MEDICA: { bg: "bg-red-100", text: "text-red-800" },
  BAJA_PATERNIDAD: { bg: "bg-emerald-200", text: "text-emerald-900" },
  INTENSIVO: { bg: "bg-purple-100", text: "text-purple-800" },
  // Intensive shift worked remotely (v3.5.11): purple family (intensive) with
  // the teal cast that distinguishes it from the on-site intensive day.
  INTENSIVO_TELETRABAJO: { bg: "bg-teal-100", text: "text-teal-800" },
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
      <td className="border border-slate-100 p-0.5 align-top">
        <button
          type="button"
          onClick={editable ? onClick : undefined}
          disabled={!editable}
          className={`w-full h-11 overflow-hidden text-xs text-slate-300 ${editable ? "hover:bg-slate-50 cursor-pointer" : "cursor-default"}`}
        >
          {editable ? "+" : "—"}
        </button>
      </td>
    );
  }

  const meta = STATUS_META[entry.status] ?? STATUS_META.AUSENTE;

  return (
    <td className="border border-slate-100 p-0.5 align-top">
      <button
        type="button"
        onClick={editable ? onClick : undefined}
        disabled={!editable}
        title={entry.healthMasked ? t("staffSchedule.gdpr.maskedNotice") : undefined}
        className={`w-full h-11 overflow-hidden rounded-none px-1.5 py-0.5 text-left leading-tight ${meta.bg} ${meta.text} ${editable ? "hover:opacity-80 cursor-pointer" : "cursor-default"}`}
      >
        <span className="flex items-center gap-1 font-semibold text-[11px] leading-tight line-clamp-2">
          {t(`staffSchedule.status.${entry.status as ScheduleStatus}`)}
          {entry.onGuard && (
            <span className="rounded-none bg-yellow-500 px-1 text-[10px] font-bold text-white shrink-0" title={t("staffSchedule.entry.onGuard")}>
              G
            </span>
          )}
          {entry.healthMasked && <Lock className="h-3 w-3 shrink-0" />}
        </span>
        {entry.startTime && entry.endTime && (
          <span className="block mt-0.5 text-[10px] leading-tight opacity-80">
            {entry.startTime}–{entry.endTime}
          </span>
        )}
      </button>
    </td>
  );
}

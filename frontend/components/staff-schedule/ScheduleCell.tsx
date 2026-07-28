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
  /** Day-of-month (1-31) shown as a small corner badge — opt-in, for
   * contexts (month grids) where the column header alone doesn't identify
   * which calendar day a cell belongs to. Week views omit it: their column
   * header already shows the full date, so it would be redundant there. */
  dayNumber?: number;
}

export default function ScheduleCell({ entry, editable, onClick, dayNumber }: Props) {
  const { t } = useLanguage();

  const dayBadge = dayNumber !== undefined && (
    <span className="absolute top-0.5 right-1 text-[9px] font-semibold opacity-60 leading-none">
      {dayNumber}
    </span>
  );

  // The status colour lives on the <td>, not on the inner <button>, so it
  // always fills the ENTIRE cell. With the colour on a fixed-height button,
  // any row that grew taller (a sibling cell wrapping to two lines, or a
  // cell with no times needing less room) left uncoloured space inside the
  // cell and the coloured blocks came out visually different sizes. A table
  // cell is always stretched to its row's height, so colouring the cell
  // itself makes every block identical by construction. `h-11` on the cell
  // sets the baseline row height; the button fills it with `h-full`.
  if (!entry) {
    return (
      <td className="border border-slate-100 align-top h-11">
        <button
          type="button"
          onClick={editable ? onClick : undefined}
          disabled={!editable}
          className={`relative w-full h-full overflow-hidden text-xs text-slate-300 ${editable ? "hover:bg-slate-50 cursor-pointer" : "cursor-default"}`}
        >
          {dayBadge}
          {editable ? "+" : "—"}
        </button>
      </td>
    );
  }

  const meta = STATUS_META[entry.status] ?? STATUS_META.AUSENTE;

  return (
    <td className={`border border-slate-100 align-top h-11 ${meta.bg}`}>
      <button
        type="button"
        onClick={editable ? onClick : undefined}
        disabled={!editable}
        title={entry.healthMasked ? t("staffSchedule.gdpr.maskedNotice") : undefined}
        className={`relative w-full h-full overflow-hidden rounded-none px-1.5 py-0.5 text-left leading-tight ${meta.text} ${editable ? "hover:opacity-80 cursor-pointer" : "cursor-default"}`}
      >
        {dayBadge}
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

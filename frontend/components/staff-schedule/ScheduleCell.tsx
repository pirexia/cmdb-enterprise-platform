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

  // Layout contract for a uniform grid of status blocks:
  //   <td>  keeps `p-0.5` (the inset that visually separates the coloured
  //         block from the cell border) and `h-11` (the baseline row height).
  //   <button> carries the status colour and fills the cell with `h-full`.
  //
  // `h-full` — not the previous fixed `h-11` — is what keeps every block the
  // same size. A table cell is always stretched to its row's height, and a
  // percentage height on the cell's child resolves against that *used*
  // height. So when a row grows (a sibling cell wrapping to two lines, or a
  // longer status name), the block grows with it. With the old fixed height
  // the button stayed 44px and left uncoloured space inside a taller cell,
  // which is why the blocks looked like different sizes.
  //
  // Corners stay square (`rounded-none`): that is the app-wide convention
  // (see CLAUDE.md, "Esquinas: rounded-none en toda la app"), not an
  // oversight.
  if (!entry) {
    return (
      <td className="border border-slate-100 p-0.5 align-top h-11">
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
    <td className="border border-slate-100 p-0.5 align-top h-11">
      <button
        type="button"
        onClick={editable ? onClick : undefined}
        disabled={!editable}
        title={entry.healthMasked ? t("staffSchedule.gdpr.maskedNotice") : undefined}
        className={`relative w-full h-full overflow-hidden rounded-none px-1.5 py-0.5 text-left leading-tight ${meta.bg} ${meta.text} ${editable ? "hover:opacity-80 cursor-pointer" : "cursor-default"}`}
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

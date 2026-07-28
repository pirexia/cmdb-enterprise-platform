"use client";

import { useLanguage } from "@/contexts/LanguageContext";

interface Props {
  /** Module title, e.g. t("staffSchedule.title"). */
  title: string;
  /** Appended to the title on line 1 when printing a single week, e.g.
   * "semana 25 de 2026" — omitted for month/other ranges where a single
   * week number doesn't apply. */
  weekLabel?: string;
  /** Department name, "All departments", or worker display name. */
  subtitle: string;
  /** Human-readable date range being shown (e.g. "01/07/2026 – 07/07/2026"). */
  rangeLabel: string;
}

/**
 * Print-only document header (spec R7): a printed/PDF page must be
 * self-explanatory once it's outside the app, so every print-capable view
 * renders exactly ONE of these alongside its <PrintButton/>. Invisible in
 * the normal UI (`.print-only` is `display: none` outside @media print —
 * see app/print.css) and only rendered when printing.
 *
 * Exactly two lines, per the condensed-report requirement: line 1 is the
 * title (plus the week number, when applicable); line 2 folds subtitle,
 * date range and the "Generado" timestamp into one line, so the header
 * costs as little vertical space as possible on a page count the user
 * explicitly wants minimized.
 */
export default function PrintHeader({ title, weekLabel, subtitle, rangeLabel }: Props) {
  const { t } = useLanguage();
  const generatedAt = new Date().toLocaleString();

  return (
    <div className="print-only mb-2">
      <h1 className="text-sm font-bold text-slate-900">
        {title}
        {weekLabel ? ` ${weekLabel}` : ""}
      </h1>
      <p className="text-[10px] text-slate-600">
        {subtitle} {rangeLabel} - {t("staffSchedule.print.generatedAt")}: {generatedAt}
      </p>
    </div>
  );
}

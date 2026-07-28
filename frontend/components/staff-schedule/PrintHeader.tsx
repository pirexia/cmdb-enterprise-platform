"use client";

import { useLanguage } from "@/contexts/LanguageContext";

interface Props {
  /** Module title, e.g. t("staffSchedule.title"). */
  title: string;
  /** Department name or worker display name being printed. */
  subtitle: string;
  /** Human-readable date range being shown (e.g. "01/07/2026 – 07/07/2026"). */
  rangeLabel: string;
}

/**
 * Print-only document header (spec R7): a printed/PDF page must be
 * self-explanatory once it's outside the app, so every print-capable view
 * (department-week, department-month, worker) drops this in alongside its
 * <PrintButton/>. Invisible in the normal UI (`.print-only` is `display:
 * none` outside @media print — see app/print.css) and only rendered when
 * printing.
 */
export default function PrintHeader({ title, subtitle, rangeLabel }: Props) {
  const { t } = useLanguage();
  const generatedAt = new Date().toLocaleString();

  return (
    <div className="print-only mb-4">
      <h1 className="text-lg font-bold text-slate-900">{title}</h1>
      <p className="text-sm text-slate-700">{subtitle}</p>
      <p className="text-sm text-slate-700">{rangeLabel}</p>
      <p className="text-xs text-slate-500">
        {t("staffSchedule.print.generatedAt")}: {generatedAt}
      </p>
    </div>
  );
}

"use client";

import { useLanguage } from "@/contexts/LanguageContext";
import { PAGE_SIZE_OPTIONS, type PageSize } from "@/hooks/usePageSize";

interface Props {
  value: PageSize;
  onChange: (size: PageSize) => void;
}

export default function PageSizeSelector({ value, onChange }: Props) {
  const { t } = useLanguage();
  return (
    <div className="flex items-center gap-1.5 text-xs text-slate-500">
      <span>{t("pagination.records_per_page")}</span>
      <select
        value={value}
        onChange={(e) => onChange(Number(e.target.value) as PageSize)}
        className="border border-slate-200 bg-white px-1.5 py-0.5 text-xs text-slate-700 focus:border-[var(--accent)] focus:outline-none cursor-pointer"
      >
        {PAGE_SIZE_OPTIONS.map((n) => (
          <option key={n} value={n}>{n}</option>
        ))}
      </select>
    </div>
  );
}

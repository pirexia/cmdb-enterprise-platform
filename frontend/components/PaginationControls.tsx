"use client";

import { useLanguage } from "@/contexts/LanguageContext";
import { ChevronLeft, ChevronRight } from "lucide-react";

interface Props {
  page: number;
  totalPages: number;
  onPrev: () => void;
  onNext: () => void;
}

export default function PaginationControls({ page, totalPages, onPrev, onNext }: Props) {
  const { t } = useLanguage();
  if (totalPages <= 1) return null;
  return (
    <div className="flex items-center gap-1">
      <button
        onClick={onPrev}
        disabled={page === 1}
        className="flex h-6 w-6 items-center justify-center border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-30 disabled:cursor-not-allowed"
        aria-label={t("pagination.prev")}
      >
        <ChevronLeft className="h-3.5 w-3.5" />
      </button>
      <span className="text-xs text-slate-500 px-1">
        {t("pagination.page_of").replace("{page}", String(page)).replace("{total}", String(totalPages))}
      </span>
      <button
        onClick={onNext}
        disabled={page === totalPages}
        className="flex h-6 w-6 items-center justify-center border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-30 disabled:cursor-not-allowed"
        aria-label={t("pagination.next")}
      >
        <ChevronRight className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

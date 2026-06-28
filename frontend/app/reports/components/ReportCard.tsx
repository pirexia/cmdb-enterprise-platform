"use client";
import { useLanguage } from "@/contexts/LanguageContext";
import type { ReportMeta } from "../types/report";
import {
  Server, ShieldAlert, FileText, BarChart2, Activity, ClipboardCheck,
  Trash2, Network, Clock, Lock, LayoutGrid
} from "lucide-react";

const ICON_MAP: Record<string, React.ComponentType<{ className?: string }>> = {
  Server, ShieldAlert, FileText, BarChart2, Activity, ClipboardCheck,
  Trash2, Network, Clock, Lock, LayoutGrid,
};

const CATEGORY_COLORS: Record<string, string> = {
  inventory:  "bg-blue-50 text-blue-700",
  security:   "bg-red-50 text-red-700",
  financial:  "bg-emerald-50 text-emerald-700",
  compliance: "bg-violet-50 text-violet-700",
  lifecycle:  "bg-amber-50 text-amber-700",
  audit:      "bg-slate-100 text-slate-600",
};

const ROLE_COLORS: Record<string, string> = {
  VIEWER:  "bg-slate-100 text-slate-600",
  AUDITOR: "bg-blue-100 text-blue-700",
  ADMIN:   "bg-rose-100 text-rose-700",
};

interface Props {
  report: ReportMeta;
  onClick: () => void;
}

export default function ReportCard({ report, onClick }: Props) {
  const { t } = useLanguage();
  const Icon = ICON_MAP[report.icon] ?? LayoutGrid;

  return (
    <button
      onClick={onClick}
      disabled={!report.available}
      className={[
        "w-full text-left bg-white ring-1 ring-slate-200 shadow-sm p-5 transition-shadow",
        "hover:shadow-md focus:outline-none focus:ring-2 focus:ring-[var(--accent)]",
        !report.available ? "opacity-50 cursor-not-allowed" : "cursor-pointer",
      ].join(" ")}
    >
      <div className="flex items-start gap-4">
        <div className="flex-shrink-0 w-10 h-10 bg-slate-50 ring-1 ring-slate-200 flex items-center justify-center">
          <Icon className="w-5 h-5 text-slate-600" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <span className="text-sm font-semibold text-slate-900">{t(report.nameKey)}</span>
            <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 ${CATEGORY_COLORS[report.category] ?? "bg-slate-100 text-slate-600"}`}>
              {t(`reports.category.${report.category}`)}
            </span>
            <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 ${ROLE_COLORS[report.minRole] ?? "bg-slate-100 text-slate-600"}`}>
              {report.minRole}
            </span>
            {report.source === "plugin" && (
              <span className="text-[10px] font-bold uppercase px-1.5 py-0.5 bg-purple-50 text-purple-700">Plugin</span>
            )}
          </div>
          <p className="text-xs text-slate-500 line-clamp-2">{t(report.descriptionKey)}</p>
          <div className="mt-2 flex gap-1.5 flex-wrap">
            {report.tags.map((tag) => (
              <span key={tag} className="text-[10px] px-1.5 py-0.5 bg-slate-100 text-slate-500">{tag}</span>
            ))}
          </div>
        </div>
      </div>
    </button>
  );
}

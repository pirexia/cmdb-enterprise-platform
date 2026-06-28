"use client";
import { useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import { useLanguage } from "@/contexts/LanguageContext";
import { BarChart2, Search, RefreshCw } from "lucide-react";
import { useReports } from "./hooks/useReports";
import ReportCard from "./components/ReportCard";
import type { ReportCategory } from "./types/report";

const CATEGORIES: ReportCategory[] = ["inventory", "security", "financial", "compliance", "lifecycle", "audit"];

export default function ReportsPage() {
  const { t } = useLanguage();
  const router = useRouter();
  const { reports, loading, error } = useReports();
  const [search, setSearch]     = useState("");
  const [category, setCategory] = useState<ReportCategory | "">("");

  const filtered = useMemo(() => {
    return reports.filter((r) => {
      if (category && r.category !== category) return false;
      if (search) {
        const q = search.toLowerCase();
        return (
          t(r.nameKey).toLowerCase().includes(q) ||
          t(r.descriptionKey).toLowerCase().includes(q) ||
          r.tags.some((tg) => tg.includes(q))
        );
      }
      return true;
    });
  }, [reports, category, search, t]);

  const grouped = useMemo(() => {
    const map = new Map<ReportCategory, typeof filtered>();
    const cats = category ? [category as ReportCategory] : CATEGORIES;
    cats.forEach((c) => {
      const items = filtered.filter((r) => r.category === c);
      if (items.length) map.set(c, items);
    });
    return map;
  }, [filtered, category]);

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white px-8 py-5">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-slate-900 flex items-center gap-2">
              <BarChart2 className="w-5 h-5 text-[var(--accent)]" />
              {t("reports.list.title")}
            </h1>
            <p className="text-sm text-slate-500 mt-0.5">{t("reports.list.subtitle")}</p>
          </div>
        </div>
      </header>

      <div className="px-8 py-8 space-y-6 w-full">
        <div className="flex flex-wrap gap-3 items-center">
          <div className="relative flex-1 min-w-56">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("reports.list.search")}
              className="w-full border border-slate-200 pl-8 pr-3 py-2 text-sm text-slate-700 focus:outline-none focus:border-[var(--accent)] bg-white"
            />
          </div>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value as ReportCategory | "")}
            className="border border-slate-200 px-3 py-2 text-sm text-slate-700 focus:outline-none focus:border-[var(--accent)] bg-white"
          >
            <option value="">{t("reports.list.all_categories")}</option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>{t(`reports.category.${c}`)}</option>
            ))}
          </select>
          {loading && <RefreshCw className="w-4 h-4 text-slate-400 animate-spin" />}
        </div>

        {error && (
          <div className="bg-rose-50 text-rose-700 px-4 py-3 text-sm ring-1 ring-rose-200">{error}</div>
        )}

        {!loading && filtered.length === 0 && (
          <div className="py-16 text-center text-slate-400">{t("reports.list.no_results")}</div>
        )}

        {[...grouped.entries()].map(([cat, items]) => (
          <section key={cat}>
            <h2 className="text-xs font-bold text-slate-500 uppercase tracking-widest mb-3">
              {t(`reports.category.${cat}`)}
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {items.map((r) => (
                <ReportCard
                  key={r.id}
                  report={r}
                  onClick={() => router.push(`/reports/${r.id}`)}
                />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

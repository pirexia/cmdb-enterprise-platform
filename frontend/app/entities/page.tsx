"use client";

import { Building2, Construction } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";

export default function EntitiesPage() {
  const { t } = useLanguage();

  const categories = [
    {
      label:  t("entities.providers_label"),
      desc:   t("entities.providers_desc"),
      color:  "bg-blue-50 text-blue-600",
      border: "border-blue-200",
    },
    {
      label:  t("entities.locations_label"),
      desc:   t("entities.locations_desc"),
      color:  "bg-green-50 text-green-600",
      border: "border-green-200",
    },
    {
      label:  t("entities.cost_centers_label"),
      desc:   t("entities.cost_centers_desc"),
      color:  "bg-purple-50 text-purple-600",
      border: "border-purple-200",
    },
  ];

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white px-8 py-5">
        <div className="flex items-center gap-3">
          <Building2 className="h-5 w-5 text-slate-400" />
          <div>
            <h1 className="text-xl font-bold text-slate-900">{t("entities.title")}</h1>
            <p className="text-sm text-slate-500 mt-0.5">
              {t("entities.subtitle")}
            </p>
          </div>
        </div>
      </header>

      <div className="px-8 py-8 max-w-4xl mx-auto">
        {/* Category Cards */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3 mb-10">
          {categories.map(({ label, desc, color, border }) => (
            <div
              key={label}
              className={`border ${border} ${color.split(" ")[0]} p-5`}
            >
              <p className={`text-sm font-semibold ${color.split(" ")[1]}`}>{label}</p>
              <p className="mt-1 text-xs text-slate-500">{desc}</p>
            </div>
          ))}
        </div>

        <div className="flex flex-col items-center justify-center py-20 text-center">
          <div className="flex h-16 w-16 items-center justify-center bg-amber-100 mb-6">
            <Construction className="h-8 w-8 text-amber-500" />
          </div>
          <h2 className="text-lg font-semibold text-slate-700 mb-2">{t("entities.coming_soon_title")}</h2>
          <p className="text-sm text-slate-500 max-w-md">
            {t("entities.coming_soon_body")}
          </p>
        </div>
      </div>
    </div>
  );
}

"use client";

import { useLanguage } from "@/contexts/LanguageContext";
import Link from "next/link";

export default function PrivacyPage() {
  const { t } = useLanguage();

  return (
    <div className="min-h-screen bg-slate-50 py-12 px-4">
      <div className="max-w-3xl mx-auto bg-white rounded-xl shadow-sm border border-slate-200 p-8">
        <h1 className="text-2xl font-bold text-slate-800 mb-2">{t("privacy.page_title")}</h1>
        <p className="text-xs text-slate-400 mb-8">CMDB Enterprise Platform — GDPR Art. 13 / Art. 14</p>

        <section className="mb-6">
          <h2 className="text-base font-semibold text-slate-700 mb-2">{t("privacy.controller_title")}</h2>
          <p className="text-sm text-slate-600 leading-relaxed">{t("privacy.controller_body")}</p>
        </section>

        <section className="mb-6">
          <h2 className="text-base font-semibold text-slate-700 mb-2">{t("privacy.data_title")}</h2>
          <p className="text-sm text-slate-600 leading-relaxed">{t("privacy.data_body")}</p>
        </section>

        <section className="mb-6">
          <h2 className="text-base font-semibold text-slate-700 mb-2">{t("privacy.basis_title")}</h2>
          <p className="text-sm text-slate-600 leading-relaxed">{t("privacy.basis_body")}</p>
        </section>

        <section className="mb-6">
          <h2 className="text-base font-semibold text-slate-700 mb-2">{t("privacy.retention_title")}</h2>
          <p className="text-sm text-slate-600 leading-relaxed">{t("privacy.retention_body")}</p>
        </section>

        <section className="mb-6">
          <h2 className="text-base font-semibold text-slate-700 mb-2">{t("privacy.rights_title")}</h2>
          <p className="text-sm text-slate-600 leading-relaxed">{t("privacy.rights_body")}</p>
        </section>

        <section className="mb-8">
          <h2 className="text-base font-semibold text-slate-700 mb-2">{t("privacy.transfers_title")}</h2>
          <p className="text-sm text-slate-600 leading-relaxed">{t("privacy.transfers_body")}</p>
        </section>

        <Link
          href="/login"
          className="text-sm text-indigo-600 hover:text-indigo-800 transition-colors"
        >
          {t("privacy.back")}
        </Link>
      </div>
    </div>
  );
}

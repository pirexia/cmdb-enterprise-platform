"use client";

import { useState } from "react";
import { RefreshCw, CheckCircle, XCircle, AlertTriangle, Loader2 } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { apiFetch } from "@/lib/apiFetch";

interface CredReport { name: string; action: "created" | "recreated" | "skipped" }
interface WfReport   { name: string; action: "created" | "updated"; active: boolean }
interface ProvisionReport {
  credentials: CredReport[];
  workflows:   WfReport[];
  errors:      string[];
}

type State = "idle" | "loading" | "done" | "error";

const ACTION_BADGE: Record<string, string> = {
  created:   "bg-green-100 text-green-700",
  recreated: "bg-amber-100 text-amber-700",
  skipped:   "bg-slate-100 text-slate-500",
  updated:   "bg-blue-100 text-blue-700",
};

export default function N8nResyncCard() {
  const { t } = useLanguage();
  const [state,  setState]  = useState<State>("idle");
  const [report, setReport] = useState<ProvisionReport | null>(null);
  const [errMsg, setErrMsg] = useState<string>("");

  const handleResync = async () => {
    setState("loading");
    setReport(null);
    setErrMsg("");
    try {
      const res = await apiFetch("/api/admin/n8n/resync", { method: "POST" });
      if (res.status === 503) {
        const d = await res.json();
        setErrMsg(d.error ?? t("settings.n8n.no_apikey"));
        setState("error");
        return;
      }
      if (!res.ok) {
        const d = await res.json();
        setErrMsg(d.error ?? t("settings.n8n.error"));
        setState("error");
        return;
      }
      const { report: r } = await res.json() as { report: ProvisionReport };
      setReport(r);
      setState("done");
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : t("settings.n8n.error"));
      setState("error");
    }
  };

  return (
    <div className="bg-white shadow-sm ring-1 ring-slate-200">
      {/* Header */}
      <div className="border-b border-slate-100 bg-slate-50 px-6 py-4">
        <p className="text-sm font-semibold text-slate-700">{t("settings.n8n.title")}</p>
        <p className="text-xs text-slate-500 mt-0.5">{t("settings.n8n.desc")}</p>
      </div>

      <div className="px-6 py-5 space-y-5">
        {/* Button */}
        <button
          onClick={handleResync}
          disabled={state === "loading"}
          className="flex items-center gap-2 rounded-none bg-[var(--accent)] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[var(--accent)]/90 shadow-sm disabled:opacity-60 disabled:cursor-not-allowed transition-opacity"
        >
          {state === "loading"
            ? <><Loader2 className="h-4 w-4 animate-spin" />{t("settings.n8n.running")}</>
            : <><RefreshCw className="h-4 w-4" />{t("settings.n8n.button")}</>
          }
        </button>

        {/* Error banner */}
        {state === "error" && (
          <div className="flex items-start gap-2 border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" />
            <span>{errMsg}</span>
          </div>
        )}

        {/* Report */}
        {state === "done" && report && (
          <div className="space-y-4">
            {/* Success header */}
            <div className="flex items-center gap-2 text-sm text-green-700 font-medium">
              <CheckCircle className="h-4 w-4" />
              {t("settings.n8n.success")}
            </div>

            {/* Errors within report */}
            {report.errors.length > 0 && (
              <div className="space-y-1">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{t("settings.n8n.section_errors")}</p>
                {report.errors.map((e, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs text-red-600 bg-red-50 border border-red-100 px-3 py-1.5">
                    <XCircle className="h-3.5 w-3.5 flex-shrink-0" />{e}
                  </div>
                ))}
              </div>
            )}

            {/* Credentials */}
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">{t("settings.n8n.section_creds")}</p>
              <div className="divide-y divide-slate-100 border border-slate-200">
                {report.credentials.map((c) => (
                  <div key={c.name} className="flex items-center justify-between px-4 py-2.5 text-sm">
                    <span className="font-medium text-slate-700">{c.name}</span>
                    <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${ACTION_BADGE[c.action] ?? ""}`}>
                      {t(`settings.n8n.cred_${c.action}`)}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Workflows */}
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">{t("settings.n8n.section_wfs")}</p>
              <div className="divide-y divide-slate-100 border border-slate-200">
                {report.workflows.map((w) => (
                  <div key={w.name} className="flex items-center justify-between px-4 py-2.5 text-sm">
                    <span className="font-medium text-slate-700">{w.name}</span>
                    <div className="flex items-center gap-2">
                      <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${ACTION_BADGE[w.action] ?? ""}`}>
                        {t(`settings.n8n.wf_${w.action}`)}
                      </span>
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${w.active ? "bg-green-50 text-green-600" : "bg-slate-100 text-slate-400"}`}>
                        {w.active ? t("settings.n8n.wf_active") : t("settings.n8n.wf_inactive")}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

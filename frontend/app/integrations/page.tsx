"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import {
  Bug, Shield, Upload, Play, CheckCircle, XCircle, AlertTriangle,
  Loader2, RefreshCw, ArrowRight,
} from "lucide-react";
import { apiFetch } from "@/lib/apiFetch";
import { useLanguage } from "@/contexts/LanguageContext";
import type { UploadResponse } from "@/lib/types/vulnImport";

// ─── Types ────────────────────────────────────────────────────────────────────

// CrowdStrike's endpoint still applies directly and reports per-host results
// inline (unchanged backend response shape).
interface ProcessedEntry {
  ci:        string;
  matched:   boolean;
  vulnCount?: number;
  status?:   string;
}

interface IntegrationResult {
  message:        string;
  processed:      ProcessedEntry[];
  totalMatched:   number;
  totalUnmatched: number;
}

// Greenbone's endpoint (v3.6.0) is a thin compat shim over the vuln-import
// staging workflow — it creates a PENDING batch and writes nothing to any
// CI. Response shape matches POST /api/vuln-import/upload's, plus a message.
interface StagingResult extends UploadResponse {
  message: string;
}

type CardResult = IntegrationResult | StagingResult;

function isStagingResult(r: CardResult): r is StagingResult {
  return "batchId" in r;
}

type CardState = "idle" | "loading" | "success" | "error";

// ─── Integration Card ─────────────────────────────────────────────────────────

interface IntegrationCardProps {
  title:       string;
  subtitle:    string;
  description: string;
  icon:        React.ReactNode;
  accent:      string;          // Tailwind bg class for header
  endpoint:    string;
  placeholder: string;
  sampleFile?: string;
}

function IntegrationCard({
  title, subtitle, description, icon, accent, endpoint, placeholder, sampleFile,
}: IntegrationCardProps) {
  const { t } = useLanguage();
  const [json,   setJson]   = useState("");
  const [state,  setState]  = useState<CardState>("idle");
  const [result, setResult] = useState<CardResult | null>(null);
  const [error,  setError]  = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => setJson((ev.target?.result as string) ?? "");
    reader.readAsText(file);
    e.target.value = "";
  };

  const handleProcess = async () => {
    if (!json.trim()) { setError(t("integrations.load_error")); return; }

    let body: unknown;
    try { body = JSON.parse(json); }
    catch { setError(t("integrations.json_invalid")); return; }

    setState("loading");
    setError(null);
    setResult(null);

    try {
      const res = await apiFetch(endpoint, {
        method: "POST",
        body:   JSON.stringify(body),
      });

      // Check ok BEFORE calling .json() — HTML error pages crash JSON.parse
      if (!res.ok) {
        const ct = res.headers.get("content-type") ?? "";
        if (ct.includes("application/json")) {
          const err = await res.json();
          throw new Error(err.error ?? `Error ${res.status}`);
        } else {
          const text = await res.text();
          throw new Error(`Error ${res.status}: ${text.replace(/<[^>]+>/g, "").trim().slice(0, 120)}`);
        }
      }

      const data = await res.json();
      setResult(data as CardResult);
      setState("success");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("common.unknown_error"));
      setState("error");
    }
  };

  return (
    <div className="bg-white shadow-sm ring-1 ring-slate-200 overflow-hidden flex flex-col">
      {/* Header */}
      <div className={`${accent} px-6 py-5`}>
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/20">
            {icon}
          </div>
          <div>
            <h2 className="text-base font-bold text-white">{title}</h2>
            <p className="text-xs text-white/70">{subtitle}</p>
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 px-6 py-5 space-y-4">
        <p className="text-sm text-slate-600">{description}</p>

        {/* Textarea */}
        <div>
          <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1.5">
            {t("integrations.json_label")}
          </label>
          <textarea
            rows={10}
            placeholder={placeholder}
            value={json}
            onChange={(e) => setJson(e.target.value)}
            className="w-full rounded-none border border-slate-300 bg-slate-50 px-3 py-2 text-xs font-mono text-slate-800 placeholder:text-slate-400 focus:border-[var(--accent)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/20 resize-y"
          />
        </div>

        {/* Actions */}
        <div className="flex items-center gap-3 flex-wrap">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="flex items-center gap-2 rounded-none border border-slate-300 bg-slate-50 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 transition-colors"
          >
            <Upload className="h-4 w-4" />
            {t("integrations.load_file")}
          </button>
          <input ref={fileRef} type="file" accept=".json,application/json" className="hidden" onChange={handleFile} />

          {sampleFile && (
            <a
              href={sampleFile}
              download
              className="flex items-center gap-2 rounded-none border border-slate-300 bg-slate-50 px-4 py-2 text-sm font-medium text-slate-500 hover:bg-slate-100 transition-colors"
            >
              {t("integrations.example")}
            </a>
          )}

          <button
            type="button"
            onClick={handleProcess}
            disabled={state === "loading"}
            className="ml-auto flex items-center gap-2 rounded-none bg-[var(--accent)] px-5 py-2 text-sm font-semibold text-white hover:bg-[var(--accent)]/90 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
          >
            {state === "loading" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            {state === "loading" ? t("integrations.processing") : t("integrations.process_btn")}
          </button>
        </div>

        {/* Error */}
        {error && (
          <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
            <AlertTriangle className="h-4 w-4 flex-shrink-0" />
            {error}
          </div>
        )}

        {/* Result — staging (Greenbone, v3.6.0): nothing was written to any
            CI yet, this created a PENDING batch that still needs review. */}
        {result && state === "success" && isStagingResult(result) && (
          <div className="rounded-xl border border-blue-200 bg-blue-50 p-4 space-y-3">
            <div className="flex items-center gap-2 text-blue-700">
              <CheckCircle className="h-4 w-4" />
              <span className="text-sm font-semibold">{result.message}</span>
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-blue-700">
              <span>{t("integrations.staging_total")}: <strong>{result.summary.totalEntries}</strong></span>
              <span>{t("integrations.staging_matched")}: <strong>{result.summary.matched}</strong></span>
              <span>{t("integrations.staging_nueva")}: <strong>{result.summary.nueva}</strong></span>
              <span>{t("integrations.staging_reaparecida")}: <strong>{result.summary.reaparecida}</strong></span>
              {(result.summary.ambiguous > 0 || result.summary.unmatched > 0) && (
                <span className="col-span-2 text-amber-600">
                  {result.summary.ambiguous + result.summary.unmatched} {t("integrations.staging_needs_attention")}
                </span>
              )}
            </div>
            <Link
              href={`/vulnerabilities/imports/${result.batchId}`}
              className="flex items-center justify-center gap-2 rounded-none bg-[var(--accent)] px-4 py-2 text-xs font-semibold text-white hover:bg-[var(--accent)]/90 transition-colors"
            >
              {t("integrations.staging_review_cta")}
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        )}

        {/* Result — direct apply (CrowdStrike): unchanged legacy shape. */}
        {result && state === "success" && !isStagingResult(result) && (
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 space-y-3">
            <div className="flex items-center gap-2 text-emerald-700">
              <CheckCircle className="h-4 w-4" />
              <span className="text-sm font-semibold">{result.message}</span>
            </div>
            <div className="flex gap-4 text-xs">
              <span className="font-medium text-emerald-700">
                {t("integrations.cis_updated").replace("{count}", String(result.totalMatched))}
              </span>
              {result.totalUnmatched > 0 && (
                <span className="font-medium text-amber-600">
                  {result.totalUnmatched} {t("integrations.no_match")}
                </span>
              )}
            </div>
            <div className="max-h-36 overflow-y-auto space-y-1">
              {result.processed.map((p, i) => (
                <div key={i} className={`flex items-center justify-between rounded px-3 py-1.5 text-xs ${p.matched ? "bg-white text-slate-700" : "bg-amber-50 text-amber-700"}`}>
                  <span className="font-medium truncate">{p.ci}</span>
                  {p.matched ? (
                    <span className="text-emerald-600 flex-shrink-0 ml-2">
                      {p.vulnCount !== undefined ? `${p.vulnCount} vuln.` : p.status ?? "ok"}
                    </span>
                  ) : (
                    <span className="flex items-center gap-1 text-amber-600 flex-shrink-0 ml-2">
                      <XCircle className="h-3 w-3" />{t("integrations.no_match")}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function IntegrationsPage() {
  const { t } = useLanguage();

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header */}
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white px-8 py-5">
        <div>
          <h1 className="text-xl font-bold text-slate-900">{t("integrations.page_title")}</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            {t("integrations.page_subtitle")}
          </p>
        </div>
      </header>

      <div className="px-8 py-8 max-w-6xl mx-auto space-y-6">
        {/* Info banner */}
        <div className="flex items-start gap-3 rounded-xl border border-blue-100 bg-blue-50 px-5 py-4">
          <RefreshCw className="mt-0.5 h-4 w-4 flex-shrink-0 text-blue-500" />
          <div className="text-sm text-blue-700">
            <p className="font-semibold mb-0.5">{t("integrations.how_it_works")}</p>
            <p>
              {t("integrations.how_it_works_body_pre")}{" "}
              <a href="/inventory" className="underline font-medium">{t("sidebar.inventory")}</a>
              {" "}{t("integrations.how_it_works_body_mid")}{" "}
              <a href="/map" className="underline font-medium">{t("sidebar.map")}</a>
              {" "}{t("integrations.how_it_works_body_post")}
            </p>
          </div>
        </div>

        {/* Cards grid */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <IntegrationCard
            title="Greenbone OpenVAS"
            subtitle={t("integrations.greenbone_subtitle")}
            description={t("integrations.greenbone_desc")}
            icon={<Bug className="h-5 w-5 text-white" />}
            accent="bg-green-600"
            endpoint="/api/integrations/greenbone"
            placeholder={`{
  "taskName": "800_Madrid - Recheck 02",
  "greenboneTaskId": "ce3d933a-175b-44c2-a203-4fb3dec1ee20",
  "scanStart": "2026-07-29T09:38:15Z",
  "scanEnd": "2026-07-29T10:18:50Z",
  "allHostSubreportEntries": [
    {
      "host": "10.100.12.61",
      "vulnerabilities": [
        {
          "name": "SSL/TLS: Deprecated TLSv1.0 and TLSv1.1 Protocol Detection",
          "severity": 4.3,
          "port": "3389/tcp",
          "oid": "1.3.6.1.4.1.25623.1.0.117274",
          "cve": ["CVE-2011-3389"],
          "thread": "Alarm"
        }
      ]
    }
  ]
}`}
          />

          <IntegrationCard
            title="CrowdStrike Falcon"
            subtitle={t("integrations.crowdstrike_subtitle")}
            description={t("integrations.crowdstrike_desc")}
            icon={<Shield className="h-5 w-5 text-white" />}
            accent="bg-red-700"
            endpoint="/api/integrations/crowdstrike"
            placeholder={`[
  {
    "hostname": "SRV-MYGESTR01D",
    "local_ip": "10.100.12.61",
    "vulnerability_id": "CVE-2025-41244",
    "cve_id": "CVE-2025-41244",
    "base_score": "7.8 v3.x",
    "exprt_rating": "Critical",
    "severity": "High",
    "exploit_status": { "value": 0, "label": "Actively used (critical)" },
    "cisa_info": { "is_cisa_kev": true, "due_date": "2025-11-20T00:00:00Z" },
    "products": [
      { "product_name": "Windows Server 2019", "product_name_version": "Windows Server 2019 1809", "sub_status": "open" }
    ],
    "status": "Reopened",
    "days_open": 301
  }
]`}
          />
        </div>
      </div>
    </div>
  );
}

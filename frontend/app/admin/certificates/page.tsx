"use client";

import { useState } from "react";
import { Shield, Download, Upload, Loader2, CheckCircle, AlertTriangle, Info } from "lucide-react";
import { apiFetch } from "@/lib/apiFetch";
import { useLanguage } from "@/contexts/LanguageContext";

export default function CertificatesPage() {
  const { t } = useLanguage();

  // CSR Generation
  const [cn, setCn]                         = useState("");
  const [organization, setOrganization]     = useState("");
  const [organizationalUnit, setOu]         = useState("");
  const [country, setCountry]               = useState("ES");
  const [state, setState]                   = useState("");
  const [locality, setLocality]             = useState("");
  const [san, setSan]                       = useState("");
  const [generatingCSR, setGeneratingCSR]   = useState(false);
  const [csrResult, setCsrResult]           = useState<string | null>(null);
  const [csrSan, setCsrSan]                 = useState<string | null>(null);

  // Certificate Upload
  const [certContent, setCertContent]       = useState("");
  const [uploading, setUploading]           = useState(false);
  const [uploadSuccess, setUploadSuccess]   = useState(false);
  const [uploadMessage, setUploadMessage]   = useState("");
  const [restartCmd, setRestartCmd]         = useState("");

  const [error, setError] = useState<string | null>(null);

  const handleGenerateCSR = async (e: React.FormEvent) => {
    e.preventDefault();
    setGeneratingCSR(true);
    setError(null);
    setCsrResult(null);
    setCsrSan(null);

    try {
      const response = await apiFetch("/api/admin/certificates/csr", {
        method: "POST",
        body: JSON.stringify({
          cn,
          o:   organization,
          ou:  organizationalUnit,
          c:   country,
          st:  state,
          l:   locality,
          san: san || undefined,
        }),
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error || t("admin.certificates.csr_error"));

      setCsrResult(data.csr);
      setCsrSan(data.san ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("admin.certificates.csr_error"));
    } finally {
      setGeneratingCSR(false);
    }
  };

  const handleDownloadCSR = () => {
    if (!csrResult) return;
    const blob = new Blob([csrResult], { type: "text/plain" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href = url;
    a.download = "server.csr";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleUploadCertificate = async (e: React.FormEvent) => {
    e.preventDefault();
    setUploading(true);
    setError(null);
    setUploadSuccess(false);
    setUploadMessage("");
    setRestartCmd("");

    try {
      const response = await apiFetch("/api/admin/certificates/upload", {
        method: "POST",
        body: JSON.stringify({ certificate: certContent }),
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error || t("admin.certificates.upload_error"));

      setUploadSuccess(true);
      setUploadMessage(data.message || t("admin.certificates.upload_success"));
      setRestartCmd(data.restartCommand || "docker compose restart nginx");
      setCertContent("");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("admin.certificates.upload_error"));
    } finally {
      setUploading(false);
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => setCertContent(ev.target?.result as string);
    reader.readAsText(file);
  };

  const inputCls = "w-full rounded-none border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-800 focus:border-[var(--accent)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/20";
  const labelCls = "block text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1.5";

  return (
    <>
      <div className="p-8">
        <div className="mb-8">
          <div className="flex items-center gap-3 mb-2">
            <Shield className="h-7 w-7 text-[var(--accent)]" />
            <h1 className="text-3xl font-bold text-slate-800">{t("admin.certificates.title")}</h1>
          </div>
          <p className="text-sm text-slate-500">{t("admin.certificates.subtitle")}</p>
        </div>

        {/* 4096-bit notice */}
        <div className="mb-6 flex items-start gap-2 border border-[var(--accent)]/20 bg-[var(--accent)]/5 px-4 py-3 text-sm text-[var(--accent)]">
          <Info className="h-4 w-4 mt-0.5 flex-shrink-0" />
          <span>{t("admin.certificates.key_notice")}</span>
        </div>

        {error && (
          <div className="mb-6 flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
            <AlertTriangle className="h-4 w-4 flex-shrink-0" />
            {error}
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* ── CSR Generation ─────────────────────────────────────────────── */}
          <div className="border border-slate-200 bg-white shadow-sm">
            <div className="border-b border-slate-200 bg-slate-50 px-6 py-4">
              <h2 className="text-lg font-semibold text-slate-800 flex items-center gap-2">
                <Download className="h-5 w-5 text-[var(--accent)]" />
                {t("admin.certificates.csr_title")}
              </h2>
              <p className="text-xs text-slate-500 mt-1">{t("admin.certificates.csr_subtitle")}</p>
            </div>

            <form onSubmit={handleGenerateCSR} className="p-6 space-y-4">
              {/* CN */}
              <div>
                <label className={labelCls}>{t("admin.certificates.field_cn")} *</label>
                <input type="text" required placeholder="cmdb.yourdomain.com"
                  value={cn} onChange={(e) => setCn(e.target.value)} className={inputCls} />
                <p className="text-xs text-slate-400 mt-1">{t("admin.certificates.field_cn_hint")}</p>
              </div>

              {/* Organization */}
              <div>
                <label className={labelCls}>{t("admin.certificates.field_o")}</label>
                <input type="text" placeholder="Your Company Name"
                  value={organization} onChange={(e) => setOrganization(e.target.value)} className={inputCls} />
              </div>

              {/* OU */}
              <div>
                <label className={labelCls}>{t("admin.certificates.field_ou")}</label>
                <input type="text" placeholder="IT Department"
                  value={organizationalUnit} onChange={(e) => setOu(e.target.value)} className={inputCls} />
              </div>

              {/* Country + State + Locality */}
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className={labelCls}>{t("admin.certificates.field_c")}</label>
                  <input type="text" maxLength={2} placeholder="ES"
                    value={country} onChange={(e) => setCountry(e.target.value.toUpperCase())} className={inputCls} />
                </div>
                <div>
                  <label className={labelCls}>{t("admin.certificates.field_st")}</label>
                  <input type="text" placeholder="Madrid"
                    value={state} onChange={(e) => setState(e.target.value)} className={inputCls} />
                </div>
                <div>
                  <label className={labelCls}>{t("admin.certificates.field_l")}</label>
                  <input type="text" placeholder="Madrid"
                    value={locality} onChange={(e) => setLocality(e.target.value)} className={inputCls} />
                </div>
              </div>

              {/* SAN */}
              <div>
                <label className={labelCls}>{t("admin.certificates.field_san")}</label>
                <input type="text"
                  placeholder="DNS:cmdb.example.com,DNS:cmdb2.example.com,IP:10.0.0.1"
                  value={san} onChange={(e) => setSan(e.target.value)} className={inputCls} />
                <p className="text-xs text-slate-400 mt-1">{t("admin.certificates.field_san_hint")}</p>
              </div>

              <button type="submit" disabled={generatingCSR || !cn}
                className="w-full flex items-center justify-center gap-2 rounded-none bg-[var(--accent)] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[var(--accent)]/90 disabled:opacity-60 disabled:cursor-not-allowed transition-colors">
                {generatingCSR ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                {generatingCSR ? t("admin.certificates.csr_generating") : t("admin.certificates.csr_button")}
              </button>
            </form>

            {csrResult && (
              <div className="px-6 pb-6">
                <div className="rounded-lg border border-green-200 bg-green-50 p-4">
                  <div className="flex items-center gap-2 mb-1">
                    <CheckCircle className="h-4 w-4 text-green-600" />
                    <p className="text-sm font-semibold text-green-700">{t("admin.certificates.csr_success")}</p>
                  </div>
                  {csrSan && (
                    <p className="text-xs text-green-600 mb-2">SAN: <code className="bg-green-100 px-1 rounded">{csrSan}</code></p>
                  )}
                  <textarea readOnly value={csrResult}
                    className="w-full rounded border border-green-300 bg-white px-3 py-2 font-mono text-xs text-slate-700 h-32 resize-none" />
                  <button onClick={handleDownloadCSR}
                    className="mt-3 flex items-center gap-2 rounded-lg bg-green-600 px-4 py-2 text-sm font-semibold text-white hover:bg-green-700 transition-colors">
                    <Download className="h-4 w-4" />
                    {t("admin.certificates.csr_download")}
                  </button>
                  <p className="text-xs text-green-600 mt-2">{t("admin.certificates.csr_send_ca")}</p>
                </div>
              </div>
            )}
          </div>

          {/* ── Certificate Upload ──────────────────────────────────────────── */}
          <div className="border border-slate-200 bg-white shadow-sm">
            <div className="border-b border-slate-200 bg-slate-50 px-6 py-4">
              <h2 className="text-lg font-semibold text-slate-800 flex items-center gap-2">
                <Upload className="h-5 w-5 text-[var(--accent)]" />
                {t("admin.certificates.upload_title")}
              </h2>
              <p className="text-xs text-slate-500 mt-1">{t("admin.certificates.upload_subtitle")}</p>
            </div>

            <form onSubmit={handleUploadCertificate} className="p-6 space-y-4">
              <div>
                <label className={labelCls}>{t("admin.certificates.upload_file_label")}</label>
                <input type="file" accept=".crt,.pem,.cer" onChange={handleFileUpload}
                  className="w-full text-sm text-slate-600 file:mr-4 file:py-2 file:px-4 file:rounded-none file:border-0 file:text-sm file:font-semibold file:bg-[var(--accent)]/5 file:text-[var(--accent)] hover:file:bg-[var(--accent)]/10" />
                <p className="text-xs text-slate-400 mt-1">{t("admin.certificates.upload_or_paste")}</p>
              </div>

              <div>
                <label className={labelCls}>{t("admin.certificates.upload_pem_label")}</label>
                <textarea
                  placeholder={"-----BEGIN CERTIFICATE-----\nMIIDXTCCAkWgAwIBAgIJAKZ...\n-----END CERTIFICATE-----"}
                  value={certContent} onChange={(e) => setCertContent(e.target.value)}
                  className="w-full rounded-none border border-slate-300 bg-slate-50 px-3 py-2 font-mono text-xs text-slate-800 h-40 resize-none focus:border-[var(--accent)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/20" />
              </div>

              <button type="submit" disabled={uploading || !certContent}
                className="w-full flex items-center justify-center gap-2 rounded-none bg-[var(--accent)] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[var(--accent)]/90 disabled:opacity-60 disabled:cursor-not-allowed transition-colors">
                {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                {uploading ? t("admin.certificates.upload_uploading") : t("admin.certificates.upload_button")}
              </button>
            </form>

            {uploadSuccess && uploadMessage && (
              <div className="px-6 pb-6">
                <div className="rounded-lg border border-green-200 bg-green-50 p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <CheckCircle className="h-4 w-4 text-green-600" />
                    <p className="text-sm font-semibold text-green-700">{t("admin.certificates.upload_done")}</p>
                  </div>
                  <p className="text-sm text-green-600 mb-3">{uploadMessage}</p>
                  <div className="rounded bg-green-100 border border-green-300 px-3 py-2 font-mono text-xs text-green-800">
                    {restartCmd}
                  </div>
                  <p className="text-xs text-green-600 mt-2">{t("admin.certificates.upload_restart_note")}</p>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Workflow instructions */}
        <div className="mt-8 rounded-xl border border-blue-200 bg-blue-50 px-6 py-5">
          <h3 className="text-sm font-semibold text-blue-800 mb-3">{t("admin.certificates.workflow_title")}</h3>
          <ol className="text-sm text-blue-700 space-y-2 list-decimal list-inside">
            <li>{t("admin.certificates.workflow_step1")}</li>
            <li>{t("admin.certificates.workflow_step2")}</li>
            <li>{t("admin.certificates.workflow_step3")}</li>
            <li>{t("admin.certificates.workflow_step4")}</li>
            <li>{t("admin.certificates.workflow_step5")}</li>
          </ol>
          <p className="text-xs text-blue-600 mt-3">
            {t("admin.certificates.workflow_verify")}:{" "}
            <code className="bg-blue-100 px-1.5 py-0.5 rounded font-mono">
              openssl s_client -connect localhost:443
            </code>
          </p>
        </div>
      </div>
    </>
  );
}

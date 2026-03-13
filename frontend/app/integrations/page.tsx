"use client";

import { useRef, useState } from "react";
import {
  Bug, Shield, Upload, Play, CheckCircle, XCircle, AlertTriangle,
  Loader2, RefreshCw,
} from "lucide-react";
import { apiFetch } from "@/lib/apiFetch";

// ─── Types ────────────────────────────────────────────────────────────────────

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
  const [json,   setJson]   = useState("");
  const [state,  setState]  = useState<CardState>("idle");
  const [result, setResult] = useState<IntegrationResult | null>(null);
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
    if (!json.trim()) { setError("Pega o carga un JSON antes de procesar."); return; }

    let body: unknown;
    try { body = JSON.parse(json); }
    catch { setError("JSON no válido. Verifica la sintaxis."); return; }

    setState("loading");
    setError(null);
    setResult(null);

    try {
      const res = await apiFetch(endpoint, {
        method: "POST",
        body:   JSON.stringify(body),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `Error ${res.status}`);
      setResult(data as IntegrationResult);
      setState("success");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
      setState("error");
    }
  };

  return (
    <div className="rounded-2xl bg-white shadow-sm ring-1 ring-slate-200 overflow-hidden flex flex-col">
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
            JSON del Reporte
          </label>
          <textarea
            rows={10}
            placeholder={placeholder}
            value={json}
            onChange={(e) => setJson(e.target.value)}
            className="w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-xs font-mono text-slate-800 placeholder:text-slate-400 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100 resize-y"
          />
        </div>

        {/* Actions */}
        <div className="flex items-center gap-3 flex-wrap">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="flex items-center gap-2 rounded-lg border border-slate-300 bg-slate-50 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 transition-colors"
          >
            <Upload className="h-4 w-4" />
            Cargar .json
          </button>
          <input ref={fileRef} type="file" accept=".json,application/json" className="hidden" onChange={handleFile} />

          {sampleFile && (
            <a
              href={sampleFile}
              download
              className="flex items-center gap-2 rounded-lg border border-slate-300 bg-slate-50 px-4 py-2 text-sm font-medium text-slate-500 hover:bg-slate-100 transition-colors"
            >
              Ejemplo
            </a>
          )}

          <button
            type="button"
            onClick={handleProcess}
            disabled={state === "loading"}
            className="ml-auto flex items-center gap-2 rounded-lg bg-indigo-600 px-5 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
          >
            {state === "loading" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            {state === "loading" ? "Procesando…" : "Procesar Datos"}
          </button>
        </div>

        {/* Error */}
        {error && (
          <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
            <AlertTriangle className="h-4 w-4 flex-shrink-0" />
            {error}
          </div>
        )}

        {/* Result */}
        {result && state === "success" && (
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 space-y-3">
            <div className="flex items-center gap-2 text-emerald-700">
              <CheckCircle className="h-4 w-4" />
              <span className="text-sm font-semibold">{result.message}</span>
            </div>
            <div className="flex gap-4 text-xs">
              <span className="font-medium text-emerald-700">✅ {result.totalMatched} CIs actualizados</span>
              {result.totalUnmatched > 0 && (
                <span className="font-medium text-amber-600">⚠️ {result.totalUnmatched} sin coincidencia</span>
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
                      <XCircle className="h-3 w-3" />no match
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
  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header */}
      <header className="border-b border-slate-200 bg-white px-8 py-5">
        <div>
          <h1 className="text-xl font-bold text-slate-900">Conectores de Seguridad</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            Importa datos de escáneres de vulnerabilidades y agentes EDR para enriquecer el inventario
          </p>
        </div>
      </header>

      <div className="px-8 py-8 max-w-6xl mx-auto space-y-6">
        {/* Info banner */}
        <div className="flex items-start gap-3 rounded-xl border border-blue-100 bg-blue-50 px-5 py-4">
          <RefreshCw className="mt-0.5 h-4 w-4 flex-shrink-0 text-blue-500" />
          <div className="text-sm text-blue-700">
            <p className="font-semibold mb-0.5">¿Cómo funciona?</p>
            <p>
              Cada conector busca los CIs en la base de datos por nombre y los actualiza automáticamente.
              Después de procesar, ve al <a href="/inventory" className="underline font-medium">Inventario</a> o
              al <a href="/map" className="underline font-medium">Mapa</a> para ver los indicadores de riesgo actualizados.
            </p>
          </div>
        </div>

        {/* Cards grid */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <IntegrationCard
            title="Greenbone OpenVAS"
            subtitle="Vulnerability Scanner"
            description="Importa un reporte de escaneo de Greenbone. Los CVEs y su severidad se asignarán a cada CI encontrado en el inventario."
            icon={<Bug className="h-5 w-5 text-white" />}
            accent="bg-green-600"
            endpoint="/api/integrations/greenbone"
            placeholder={`{
  "scanner": "Greenbone Security Manager",
  "scan_date": "2026-03-13T18:00:00Z",
  "results": [
    {
      "host": { "hostname": "PROD-SRV-01 Web Server", "ip": "10.0.1.10" },
      "vulnerabilities": [
        {
          "cve": "CVE-2024-21413",
          "severity": "CRITICAL",
          "name": "Outlook RCE",
          "cvss_score": 9.8,
          "description": "Remote Code Execution via MIME link"
        }
      ]
    }
  ]
}`}
          />

          <IntegrationCard
            title="CrowdStrike Falcon"
            subtitle="EDR Agent Status"
            description="Importa el estado de los agentes Falcon. Se registrará si el agente está activo, su política de prevención y las detecciones recientes."
            icon={<Shield className="h-5 w-5 text-white" />}
            accent="bg-red-700"
            endpoint="/api/integrations/crowdstrike"
            placeholder={`{
  "platform": "CrowdStrike Falcon",
  "export_date": "2026-03-13T19:00:00Z",
  "devices": [
    {
      "hostname": "PROD-SRV-01",
      "agent_id": "a1b2c3d4e5f6",
      "agent_version": "7.14.17706.0",
      "status": "normal",
      "prevention_policy": "active",
      "last_seen": "2026-03-13T18:55:00Z",
      "detections": []
    }
  ]
}`}
          />
        </div>
      </div>
    </div>
  );
}

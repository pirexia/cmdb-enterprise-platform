"use client";

import { useEffect, useState } from "react";
import {
  Server, Cpu, Package, AlertTriangle, RefreshCw,
  ShieldAlert, ShieldCheck, ShieldOff, Globe, Wrench,
} from "lucide-react";
import { apiFetch } from "@/lib/apiFetch";

// ─── Types ────────────────────────────────────────────────────────────────────

type Criticality  = "LOW" | "MEDIUM" | "HIGH" | "MISSION_CRITICAL";
type Environment  = "DEVELOPMENT" | "TESTING" | "STAGING" | "PRODUCTION";
type VulnSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

interface Vulnerability { cve: string; severity: VulnSeverity; description: string }

interface CI {
  id:              string;
  criticality:     Criticality;
  environment:     Environment;
  hardware:        unknown | null;
  software:        unknown | null;
  vulnerabilities: Vulnerability[] | null;
}

// ─── Components ───────────────────────────────────────────────────────────────

function StatCard({ label, value, icon, color, loading }: {
  label: string; value: number; icon: React.ReactNode; color: string; loading: boolean;
}) {
  return (
    <div className="flex items-center gap-4 rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
      <div className={`flex h-12 w-12 items-center justify-center rounded-xl ${color}`}>{icon}</div>
      <div>
        <p className="text-sm font-medium text-slate-500">{label}</p>
        {loading
          ? <div className="mt-1 h-8 w-16 animate-pulse rounded-md bg-slate-200" />
          : <p className="text-3xl font-bold text-slate-800">{value}</p>}
      </div>
    </div>
  );
}

function MiniBar({ label, value, total, color }: { label: string; value: number; total: number; color: string }) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs text-slate-500">
        <span>{label}</span>
        <span className="font-medium text-slate-700">{value} <span className="text-slate-400">({pct}%)</span></span>
      </div>
      <div className="h-2 w-full rounded-full bg-slate-100 overflow-hidden">
        <div className={`h-2 rounded-full ${color} transition-all duration-500`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

// ─── Security Widget ──────────────────────────────────────────────────────────

function SecurityWidget({ cis, loading }: { cis: CI[]; loading: boolean }) {
  if (loading) {
    return (
      <div className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200 space-y-3">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-5 animate-pulse rounded bg-slate-100" />
        ))}
      </div>
    );
  }

  const scanned    = cis.filter((c) => c.vulnerabilities !== null);
  const notScanned = cis.filter((c) => c.vulnerabilities === null).length;
  const clean      = scanned.filter((c) => c.vulnerabilities!.length === 0).length;
  const critical   = scanned.filter((c) => c.vulnerabilities!.some((v) => v.severity === "CRITICAL")).length;
  const high       = scanned.filter((c) => !c.vulnerabilities!.some((v) => v.severity === "CRITICAL") && c.vulnerabilities!.some((v) => v.severity === "HIGH")).length;
  const medium     = scanned.filter((c) => !c.vulnerabilities!.some((v) => v.severity === "CRITICAL" || v.severity === "HIGH") && c.vulnerabilities!.length > 0).length;

  const compromised = critical + high + medium;

  return (
    <section className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
      <h2 className="mb-5 flex items-center gap-2 text-sm font-semibold text-slate-700">
        <ShieldAlert className="h-4 w-4 text-slate-400" />
        Estado de Seguridad Global
      </h2>

      {/* Summary row */}
      <div className="grid grid-cols-2 gap-3 mb-5 sm:grid-cols-4">
        <div className="rounded-xl bg-emerald-50 p-3 text-center ring-1 ring-emerald-100">
          <ShieldCheck className="mx-auto h-5 w-5 text-emerald-600 mb-1" />
          <p className="text-lg font-bold text-emerald-700">{clean}</p>
          <p className="text-[11px] text-emerald-600">Limpios</p>
        </div>
        <div className="rounded-xl bg-red-50 p-3 text-center ring-1 ring-red-100">
          <ShieldAlert className="mx-auto h-5 w-5 text-red-600 mb-1" />
          <p className="text-lg font-bold text-red-700">{compromised}</p>
          <p className="text-[11px] text-red-600">Comprometidos</p>
        </div>
        <div className="rounded-xl bg-slate-50 p-3 text-center ring-1 ring-slate-200">
          <ShieldOff className="mx-auto h-5 w-5 text-slate-400 mb-1" />
          <p className="text-lg font-bold text-slate-600">{notScanned}</p>
          <p className="text-[11px] text-slate-500">No escaneados</p>
        </div>
        <div className="rounded-xl bg-indigo-50 p-3 text-center ring-1 ring-indigo-100">
          <Server className="mx-auto h-5 w-5 text-indigo-600 mb-1" />
          <p className="text-lg font-bold text-indigo-700">{scanned.length}</p>
          <p className="text-[11px] text-indigo-600">Escaneados</p>
        </div>
      </div>

      {/* Breakdown bars */}
      <div className="space-y-3">
        <MiniBar label="CRITICAL"  value={critical} total={cis.length} color="bg-red-600" />
        <MiniBar label="HIGH"      value={high}     total={cis.length} color="bg-orange-500" />
        <MiniBar label="MEDIUM/LOW" value={medium}  total={cis.length} color="bg-yellow-400" />
        <MiniBar label="Limpios"   value={clean}    total={cis.length} color="bg-emerald-500" />
      </div>

      {compromised > 0 && (
        <div className="mt-4 flex items-start gap-2 rounded-xl bg-red-50 px-4 py-3 text-xs text-red-700">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <span>
            <strong>{compromised}</strong> activo{compromised !== 1 ? "s" : ""} con vulnerabilidades detectadas.
            Ve a <strong>Inventario de CIs</strong> para lanzar un re-escaneo.
          </span>
        </div>
      )}
    </section>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const [cis, setCis]         = useState<CI[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);

  const fetchCIs = async () => {
    setLoading(true); setError(null);
    try {
      const res = await apiFetch("/api/cis");
      if (!res.ok) throw new Error(`Status ${res.status}`);
      const json: { total: number; data: CI[] } = await res.json();
      setCis(json.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchCIs(); }, []);

  const total    = cis.length;
  const hardware = cis.filter((c) => c.hardware !== null).length;
  const software = cis.filter((c) => c.software !== null).length;

  const byEnv  = (env: Environment) => cis.filter((c) => c.environment === env).length;
  const byCrit = (level: Criticality) => cis.filter((c) => c.criticality === level).length;

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white px-8 py-5">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-slate-900">Dashboard</h1>
            <p className="text-sm text-slate-500 mt-0.5">Resumen general de la plataforma</p>
          </div>
          <button onClick={fetchCIs} className="flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50 transition-colors">
            <RefreshCw className="h-3.5 w-3.5" />Actualizar
          </button>
        </div>
      </header>

      <div className="px-8 py-8 space-y-8 max-w-6xl mx-auto">
        {error && (
          <div className="flex items-center gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
            <AlertTriangle className="h-4 w-4 flex-shrink-0" />
            No se pudo conectar con el backend: {error}
          </div>
        )}

        {/* Summary Cards */}
        <section>
          <h2 className="mb-4 text-xs font-semibold uppercase tracking-wider text-slate-400">Totales</h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <StatCard label="Total CIs" value={total}    loading={loading} color="bg-indigo-50"  icon={<Server  className="h-6 w-6 text-indigo-600" />} />
            <StatCard label="Hardware"  value={hardware} loading={loading} color="bg-emerald-50" icon={<Cpu     className="h-6 w-6 text-emerald-600" />} />
            <StatCard label="Software"  value={software} loading={loading} color="bg-violet-50"  icon={<Package className="h-6 w-6 text-violet-600" />} />
          </div>
        </section>

        <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
          {/* By Environment */}
          <section className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
            <h2 className="mb-5 flex items-center gap-2 text-sm font-semibold text-slate-700">
              <Globe className="h-4 w-4 text-slate-400" />
              CIs por Entorno
            </h2>
            <div className="space-y-3">
              <MiniBar label="Production"  value={byEnv("PRODUCTION")}  total={total} color="bg-red-400" />
              <MiniBar label="Staging"     value={byEnv("STAGING")}     total={total} color="bg-orange-400" />
              <MiniBar label="Testing"     value={byEnv("TESTING")}     total={total} color="bg-blue-400" />
              <MiniBar label="Development" value={byEnv("DEVELOPMENT")} total={total} color="bg-green-400" />
            </div>
          </section>

          {/* By Criticality */}
          <section className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
            <h2 className="mb-5 flex items-center gap-2 text-sm font-semibold text-slate-700">
              <AlertTriangle className="h-4 w-4 text-slate-400" />
              CIs por Criticidad
            </h2>
            <div className="space-y-3">
              <MiniBar label="Mission Critical" value={byCrit("MISSION_CRITICAL")} total={total} color="bg-red-600" />
              <MiniBar label="High"             value={byCrit("HIGH")}             total={total} color="bg-orange-500" />
              <MiniBar label="Medium"           value={byCrit("MEDIUM")}           total={total} color="bg-yellow-400" />
              <MiniBar label="Low"              value={byCrit("LOW")}              total={total} color="bg-slate-300" />
            </div>
          </section>
        </div>

        {/* Security Widget */}
        <SecurityWidget cis={cis} loading={loading} />

        {/* Quick Tips */}
        <section className="rounded-2xl border border-indigo-100 bg-indigo-50 p-6">
          <div className="flex items-start gap-3">
            <Wrench className="mt-0.5 h-5 w-5 flex-shrink-0 text-indigo-500" />
            <div>
              <p className="text-sm font-semibold text-indigo-800">Para empezar</p>
              <p className="mt-1 text-sm text-indigo-600">
                Ve a <strong>Inventario de CIs</strong> para ver y escanear activos.
                Usa <strong>Mapa de Dependencias</strong> para visualizar relaciones y alertas de seguridad.
              </p>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

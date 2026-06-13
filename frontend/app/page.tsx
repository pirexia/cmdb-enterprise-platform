"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Server, Cpu, Package, AlertTriangle, RefreshCw,
  ShieldAlert, ShieldCheck, ShieldOff, Globe, Wrench,
  FileText, CalendarX2, BarChart3,
} from "lucide-react";
import { apiFetch } from "@/lib/apiFetch";
import { useLanguage } from "@/contexts/LanguageContext";
import PluginSlot from "@/components/plugins/PluginSlot";

// ─── Types ────────────────────────────────────────────────────────────────────

type Criticality  = "LOW" | "MEDIUM" | "HIGH" | "MISSION_CRITICAL";
type Environment  = "DEVELOPMENT" | "TESTING" | "STAGING" | "PRODUCTION";
type VulnSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

interface Vulnerability { cve: string; severity: VulnSeverity; description: string; status?: string }

interface CI {
  id:              string;
  criticality:     Criticality;
  environment:     Environment;
  hardware:        unknown | null;
  software:        unknown | null;
  vulnerabilities: Vulnerability[] | null;
  eolDate:         string | null;
  eosDate:         string | null;
}

interface Contract {
  id: string;
  endDate: string | null;
  parentContract: { id: string } | null;
}

// ─── Components ───────────────────────────────────────────────────────────────

function StatCard({ label, value, icon, color, loading, href }: {
  label: string; value: number; icon: React.ReactNode;
  color: string; loading: boolean; href?: string;
}) {
  const { t } = useLanguage();
  const inner = (
    <div className={`flex items-center gap-4 bg-white p-6 shadow-sm ring-1 ring-slate-200 transition-all ${href ? "hover:shadow-md hover:ring-[var(--accent)]/20 cursor-pointer" : ""}`}>
      <div className={`flex h-12 w-12 items-center justify-center ${color}`}>{icon}</div>
      <div>
        <p className="text-sm font-medium text-slate-500">{label}</p>
        {loading
          ? <div className="mt-1 h-8 w-16 animate-pulse rounded-md bg-slate-200" />
          : <p className="text-3xl font-bold text-slate-800">{value}</p>}
        {href && !loading && <p className="text-xs text-[var(--accent)] mt-0.5 font-medium">{t("dashboard.view_details")}</p>}
      </div>
    </div>
  );
  if (href) return <Link href={href}>{inner}</Link>;
  return inner;
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
  const { t } = useLanguage();

  if (loading) {
    return (
      <div className="bg-white p-6 shadow-sm ring-1 ring-slate-200 space-y-3">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-5 animate-pulse rounded bg-slate-100" />
        ))}
      </div>
    );
  }

  const scanned    = cis.filter((c) => c.vulnerabilities !== null);
  const notScanned = cis.filter((c) => c.vulnerabilities === null).length;
  const clean      = scanned.filter((c) => c.vulnerabilities!.filter((v) => v.status !== "RESUELTO").length === 0).length;
  const critical   = scanned.filter((c) => c.vulnerabilities!.some((v) => v.severity === "CRITICAL" && v.status !== "RESUELTO")).length;
  const high       = scanned.filter((c) => !c.vulnerabilities!.some((v) => v.severity === "CRITICAL" && v.status !== "RESUELTO") && c.vulnerabilities!.some((v) => v.severity === "HIGH" && v.status !== "RESUELTO")).length;
  const medium     = scanned.filter((c) => !c.vulnerabilities!.some((v) => (v.severity === "CRITICAL" || v.severity === "HIGH") && v.status !== "RESUELTO") && c.vulnerabilities!.filter((v) => v.status !== "RESUELTO").length > 0).length;

  const compromised = critical + high + medium;

  return (
    <section className="bg-white p-6 shadow-sm ring-1 ring-slate-200">
      <h2 className="mb-5 flex items-center gap-2 text-sm font-semibold text-slate-700">
        <ShieldAlert className="h-4 w-4 text-slate-400" />
        {t("dashboard.security_title")}
        <Link href="/vulnerabilities" className="ml-auto text-xs font-medium text-[var(--accent)] hover:text-[var(--accent)]">
          {t("dashboard.view_vulnerabilities")}
        </Link>
      </h2>

      {/* Summary row */}
      <div className="grid grid-cols-2 gap-3 mb-5 sm:grid-cols-4">
        <Link href="/vulnerabilities" className="bg-emerald-50 p-3 text-center ring-1 ring-emerald-100 hover:ring-emerald-300 transition-all">
          <ShieldCheck className="mx-auto h-5 w-5 text-emerald-600 mb-1" />
          <p className="text-lg font-bold text-emerald-700">{clean}</p>
          <p className="text-[11px] text-emerald-600">{t("dashboard.clean_label")}</p>
        </Link>
        <Link href="/vulnerabilities" className="bg-red-50 p-3 text-center ring-1 ring-red-100 hover:ring-red-300 transition-all">
          <ShieldAlert className="mx-auto h-5 w-5 text-red-600 mb-1" />
          <p className="text-lg font-bold text-red-700">{compromised}</p>
          <p className="text-[11px] text-red-600">{t("dashboard.compromised_label")}</p>
        </Link>
        <div className="bg-slate-50 p-3 text-center ring-1 ring-slate-200">
          <ShieldOff className="mx-auto h-5 w-5 text-slate-400 mb-1" />
          <p className="text-lg font-bold text-slate-600">{notScanned}</p>
          <p className="text-[11px] text-slate-500">{t("dashboard.not_scanned")}</p>
        </div>
        <Link href="/reports" className="bg-[var(--accent)]/5 p-3 text-center ring-1 ring-[var(--accent)]/20 hover:ring-[var(--accent)]/40 transition-all">
          <Server className="mx-auto h-5 w-5 text-[var(--accent)] mb-1" />
          <p className="text-lg font-bold text-[var(--accent)]">{scanned.length}</p>
          <p className="text-[11px] text-[var(--accent)]">{t("dashboard.view_report")}</p>
        </Link>
      </div>

      {/* Breakdown bars */}
      <div className="space-y-3">
        <MiniBar label="CRITICAL"   value={critical} total={cis.length} color="bg-red-600" />
        <MiniBar label="HIGH"       value={high}     total={cis.length} color="bg-orange-500" />
        <MiniBar label="MEDIUM/LOW" value={medium}   total={cis.length} color="bg-yellow-400" />
        <MiniBar label={t("dashboard.clean_label")} value={clean} total={cis.length} color="bg-emerald-500" />
      </div>

      {compromised > 0 && (
        <Link href="/vulnerabilities" className="mt-4 flex items-start gap-2 bg-red-50 px-4 py-3 text-xs text-red-700 hover:bg-red-100 transition-colors">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <span>
            <strong>{compromised}</strong> {t("dashboard.compromised_cta")}
          </span>
        </Link>
      )}
    </section>
  );
}

// ─── Contracts Widget ─────────────────────────────────────────────────────────

function ContractsWidget({ contracts, loading }: { contracts: Contract[]; loading: boolean }) {
  const { t } = useLanguage();

  if (loading) {
    return (
      <div className="bg-white p-6 shadow-sm ring-1 ring-slate-200 space-y-3">
        {[1, 2].map((i) => <div key={i} className="h-5 animate-pulse rounded bg-slate-100" />)}
      </div>
    );
  }

  const now   = Date.now();
  const days  = (iso: string) => Math.floor((new Date(iso).getTime() - now) / 86_400_000);

  const expired  = contracts.filter((c) => c.endDate && days(c.endDate) < 0).length;
  const expiring = contracts.filter((c) => c.endDate && days(c.endDate) >= 0 && days(c.endDate) < 60).length;
  const addendums = contracts.filter((c) => c.parentContract !== null).length;
  const active   = contracts.filter((c) => !c.endDate || days(c.endDate) >= 60).length;

  return (
    <section className="bg-white p-6 shadow-sm ring-1 ring-slate-200">
      <h2 className="mb-5 flex items-center gap-2 text-sm font-semibold text-slate-700">
        <FileText className="h-4 w-4 text-slate-400" />
        {t("dashboard.contracts_section")}
        <Link href="/contracts" className="ml-auto text-xs font-medium text-[var(--accent)] hover:text-[var(--accent)]">
          {t("dashboard.manage_contracts")}
        </Link>
      </h2>

      <div className="grid grid-cols-2 gap-3">
        <Link href="/contracts" className="bg-[var(--accent)]/5 p-3 text-center ring-1 ring-[var(--accent)]/20 hover:ring-[var(--accent)]/40 transition-all">
          <FileText className="mx-auto h-5 w-5 text-[var(--accent)] mb-1" />
          <p className="text-lg font-bold text-[var(--accent)]">{contracts.length}</p>
          <p className="text-[11px] text-[var(--accent)]">{t("dashboard.total_contracts_label")}</p>
        </Link>
        <Link href="/contracts?filter=adenda" className="bg-violet-50 p-3 text-center ring-1 ring-violet-100 hover:ring-violet-300 transition-all">
          <BarChart3 className="mx-auto h-5 w-5 text-violet-600 mb-1" />
          <p className="text-lg font-bold text-violet-700">{addendums}</p>
          <p className="text-[11px] text-violet-600">{t("dashboard.addendum_label")}</p>
        </Link>
        <Link href="/contracts?filter=active" className="bg-emerald-50 p-3 text-center ring-1 ring-emerald-100 hover:ring-emerald-300 transition-all">
          <ShieldCheck className="mx-auto h-5 w-5 text-emerald-600 mb-1" />
          <p className="text-lg font-bold text-emerald-700">{active}</p>
          <p className="text-[11px] text-emerald-600">{t("dashboard.active_label")}</p>
        </Link>
        <Link href={expired > 0 ? "/contracts?filter=expired" : "/contracts?filter=expiring"} className={`p-3 text-center ring-1 transition-all ${expiring > 0 || expired > 0 ? "bg-orange-50 ring-orange-100 hover:ring-orange-300" : "bg-slate-50 ring-slate-100"}`}>
          <CalendarX2 className={`mx-auto h-5 w-5 mb-1 ${expiring > 0 || expired > 0 ? "text-orange-500" : "text-slate-400"}`} />
          <p className={`text-lg font-bold ${expired > 0 ? "text-red-700" : expiring > 0 ? "text-orange-700" : "text-slate-600"}`}>
            {expired > 0 ? expired : expiring}
          </p>
          <p className={`text-[11px] ${expired > 0 ? "text-red-600" : expiring > 0 ? "text-orange-600" : "text-slate-500"}`}>
            {expired > 0 ? t("dashboard.expired_label") : t("dashboard.expiring_60d")}
          </p>
        </Link>
      </div>

      {(expiring > 0 || expired > 0) && (
        <Link href={expired > 0 ? "/contracts?filter=expired" : "/contracts?filter=expiring"} className="mt-4 flex items-start gap-2 bg-orange-50 px-4 py-3 text-xs text-orange-700 hover:bg-orange-100 transition-colors">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <span>
            {expired > 0 && <><strong>{expired}</strong> contrato{expired !== 1 ? "s" : ""} vencido{expired !== 1 ? "s" : ""}. </>}
            {expiring > 0 && <><strong>{expiring}</strong> vence{expiring === 1 ? "" : "n"} en los próximos 60 días. </>}
            {t("dashboard.contracts_renew_cta")}
          </span>
        </Link>
      )}
    </section>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const [cis, setCis]             = useState<CI[]>([]);
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState<string | null>(null);
  const { t } = useLanguage();

  const fetchAll = async () => {
    setLoading(true); setError(null);
    try {
      const [cisRes, contrRes] = await Promise.all([
        apiFetch("/api/cis"),
        apiFetch("/api/contracts"),
      ]);
      if (!cisRes.ok)   throw new Error(`CIs: ${cisRes.status}`);
      if (!contrRes.ok) throw new Error(`Contratos: ${contrRes.status}`);
      const cisJson   = await cisRes.json();
      const contrJson = await contrRes.json();
      setCis(cisJson.data ?? []);
      setContracts(contrJson.data ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchAll(); }, []);

  const total    = cis.length;
  const hardware = cis.filter((c) => c.hardware !== null).length;
  const software = cis.filter((c) => c.software !== null).length;

  const byEnv  = (env: Environment) => cis.filter((c) => c.environment === env).length;
  const byCrit = (level: Criticality) => cis.filter((c) => c.criticality === level).length;

  // EoL urgency for banner
  const eolUrgent = cis.filter((c) => {
    const dates = [c.eolDate, c.eosDate].filter(Boolean);
    if (!dates.length) return false;
    const nearest = Math.min(...dates.map((d) => Math.floor((new Date(d!).getTime() - Date.now()) / 86_400_000)));
    return nearest < 90;
  }).length;

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white px-8 py-5">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-slate-900">{t("dashboard.title")}</h1>
            <p className="text-sm text-slate-500 mt-0.5">{t("dashboard.subtitle")}</p>
          </div>
          <button onClick={fetchAll} className="flex items-center gap-2 rounded-none border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50 transition-colors">
            <RefreshCw className="h-3.5 w-3.5" />{t("dashboard.refresh")}
          </button>
        </div>
      </header>

      <div className="px-8 py-8 space-y-8 w-full">
        {error && (
          <div className="flex items-center gap-3 border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
            <AlertTriangle className="h-4 w-4 flex-shrink-0" />
            {t("dashboard.backend_error")} {error}
          </div>
        )}

        {/* EoL alert banner */}
        {!loading && eolUrgent > 0 && (
          <Link href="/reports" className="flex items-center gap-3 border border-orange-200 bg-orange-50 px-4 py-3 text-sm text-orange-700 hover:bg-orange-100 transition-colors">
            <AlertTriangle className="h-4 w-4 flex-shrink-0 text-orange-500" />
            <span>
              <strong>{eolUrgent}</strong> {t("dashboard.eol_approaching")}
            </span>
          </Link>
        )}

        {/* Summary Cards */}
        <section>
          <h2 className="mb-4 text-xs font-semibold uppercase tracking-wider text-slate-400">{t("dashboard.totals_section")}</h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <StatCard label={t("dashboard.total_cis")} value={total}    loading={loading} color="bg-[var(--accent)]/5"  href="/inventory" icon={<Server  className="h-6 w-6 text-[var(--accent)]" />} />
            <StatCard label={t("dashboard.hardware_label")}  value={hardware} loading={loading} color="bg-emerald-50" href="/inventory?type=hardware" icon={<Cpu     className="h-6 w-6 text-emerald-600" />} />
            <StatCard label={t("dashboard.software_label")}  value={software} loading={loading} color="bg-violet-50"  href="/inventory?type=software" icon={<Package className="h-6 w-6 text-violet-600" />} />
          </div>
        </section>

        <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
          {/* By Environment */}
          <section className="bg-white p-6 shadow-sm ring-1 ring-slate-200">
            <h2 className="mb-5 flex items-center gap-2 text-sm font-semibold text-slate-700">
              <Globe className="h-4 w-4 text-slate-400" />
              {t("dashboard.by_environment")}
            </h2>
            <div className="space-y-3">
              <MiniBar label="Production"  value={byEnv("PRODUCTION")}  total={total} color="bg-red-400" />
              <MiniBar label="Staging"     value={byEnv("STAGING")}     total={total} color="bg-orange-400" />
              <MiniBar label="Testing"     value={byEnv("TESTING")}     total={total} color="bg-blue-400" />
              <MiniBar label="Development" value={byEnv("DEVELOPMENT")} total={total} color="bg-green-400" />
            </div>
          </section>

          {/* By Criticality */}
          <section className="bg-white p-6 shadow-sm ring-1 ring-slate-200">
            <h2 className="mb-5 flex items-center gap-2 text-sm font-semibold text-slate-700">
              <AlertTriangle className="h-4 w-4 text-slate-400" />
              {t("dashboard.by_criticality")}
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

        {/* Contracts Widget */}
        <ContractsWidget contracts={contracts} loading={loading} />

        {/* Plugin DashboardWidget slots */}
        <PluginSlot slotName="DashboardWidget" />

        {/* Quick Tips */}
        <section className="border border-[var(--accent)]/20 bg-[var(--accent)]/5 p-6">
          <div className="flex items-start gap-3">
            <Wrench className="mt-0.5 h-5 w-5 flex-shrink-0 text-[var(--accent)]" />
            <div>
              <p className="text-sm font-semibold text-slate-800">{t("dashboard.getting_started_title")}</p>
              <p className="mt-1 text-sm text-slate-700">
                Ve a <Link href="/inventory" className="font-bold underline">{t("dashboard.inventory_link")}</Link> para ver y escanear activos.
                Usa <Link href="/map" className="font-bold underline">{t("dashboard.map_link")}</Link> para visualizar relaciones.
                Genera informes ejecutivos desde <Link href="/reports" className="font-bold underline">{t("dashboard.reports_link")}</Link>.
              </p>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Server, Building2, LayoutGrid, AlertTriangle, RefreshCw,
  ChevronRight, Settings, Zap,
} from "lucide-react";
import { apiFetch } from "@/lib/apiFetch";
import { useAuth } from "@/contexts/AuthContext";
import { useLanguage } from "@/contexts/LanguageContext";

// ─── Types ────────────────────────────────────────────────────────────────────

interface DcimDashboard {
  buildings: number;
  rooms: number;
  racks: number;
  alerts: number;
}

interface PowerAlert {
  rackCiId: string;
  rackName: string;
  sumPowerW: number;
  maxPowerW: number;
  usagePct: number;
}

interface Room {
  id: string;
  name: string;
  kind: string;
  floor: {
    id: string;
    name: string;
    levelNumber: number;
    building: { id: string; name: string };
  };
  _count: { footprints: number };
}

// ─── KPI Card ────────────────────────────────────────────────────────────────

function KpiCard({
  icon: Icon, label, value, accent,
}: {
  icon: React.ElementType; label: string; value: number; accent: string;
}) {
  return (
    <div className="flex items-center gap-4 rounded-none ring-1 ring-slate-200 bg-white p-5 shadow-sm">
      <div className={`flex h-12 w-12 items-center justify-center rounded-none ${accent}`}>
        <Icon className="h-6 w-6" />
      </div>
      <div>
        <p className="text-2xl font-bold text-slate-800">{value}</p>
        <p className="text-xs text-slate-500">{label}</p>
      </div>
    </div>
  );
}

// ─── Alert Row ────────────────────────────────────────────────────────────────

function AlertRow({ alert }: { alert: PowerAlert }) {
  const pct = Math.min(alert.usagePct, 100);
  const color = pct >= 100 ? "bg-red-500" : pct >= 80 ? "bg-amber-500" : "bg-green-500";
  return (
    <div className="flex items-center gap-3 border-b border-slate-100 py-2 last:border-0">
      <Zap className="h-4 w-4 shrink-0 text-red-500" />
      <span className="flex-1 truncate text-sm text-slate-700">{alert.rackName}</span>
      <div className="flex items-center gap-2">
        <div className="h-2 w-24 rounded-full bg-slate-200">
          <div className={`h-2 rounded-full ${color}`} style={{ width: `${pct}%` }} />
        </div>
        <span className="w-12 text-right text-xs font-medium text-slate-600">{alert.usagePct}%</span>
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function DcimPage() {
  const { user } = useAuth();
  const { t } = useLanguage();
  const router = useRouter();

  const [kpis, setKpis] = useState<DcimDashboard | null>(null);
  const [alerts, setAlerts] = useState<PowerAlert[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [kpiData, alertData, roomData] = await Promise.all([
        apiFetch("/api/dcim/dashboard").then((r) => r.json()),
        apiFetch("/api/dcim/alerts").then((r) => r.json()),
        apiFetch("/api/dcim/rooms").then((r) => r.json()),
      ]);
      setKpis(kpiData);
      setAlerts(Array.isArray(alertData) ? alertData : []);
      setRooms(Array.isArray(roomData) ? roomData : []);
    } catch {
      setError(t("dcim.error"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center text-slate-400">
        <RefreshCw className="mr-2 h-5 w-5 animate-spin" />
        {t("dcim.loading")}
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center gap-2 text-red-500">
        <AlertTriangle className="h-8 w-8" />
        <p>{error}</p>
        <button onClick={load} className="mt-2 rounded-none border border-red-300 px-4 py-2 text-sm hover:bg-red-50">
          {t("actions.retry") ?? "Reintentar"}
        </button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white px-8 py-5">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-slate-900">{t("dcim.dashboard.title")}</h1>
            <p className="text-sm text-slate-500 mt-0.5">{t("dcim.dashboard.subtitle")}</p>
          </div>
          <div className="flex gap-2">
            <button onClick={load} className="flex items-center gap-2 rounded-none border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50 transition-colors">
              <RefreshCw className="h-3.5 w-3.5" /> {t("actions.refresh") ?? "Actualizar"}
            </button>
            {user?.role === "ADMIN" && (
              <Link
                href="/dcim/admin"
                className="flex items-center gap-2 rounded-none bg-[var(--accent)] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[var(--accent)]/90 transition-colors shadow-sm"
              >
                <Settings className="h-4 w-4" /> {t("dcim.dashboard.manage")}
              </Link>
            )}
          </div>
        </div>
      </header>

      <div className="px-8 py-8 space-y-8 w-full">
      {/* KPI Cards */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiCard icon={Building2}    label={t("dcim.dashboard.buildings")} value={kpis?.buildings ?? 0} accent="bg-blue-100 text-blue-600" />
        <KpiCard icon={LayoutGrid}   label={t("dcim.dashboard.rooms")}     value={kpis?.rooms ?? 0}     accent="bg-indigo-100 text-indigo-600" />
        <KpiCard icon={Server}       label={t("dcim.dashboard.racks")}     value={kpis?.racks ?? 0}     accent="bg-slate-100 text-slate-600" />
        <KpiCard icon={AlertTriangle} label={t("dcim.dashboard.alerts")}   value={kpis?.alerts ?? 0}    accent={kpis?.alerts ? "bg-red-100 text-red-600" : "bg-green-100 text-green-600"} />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">

        {/* Room list */}
        <div className="lg:col-span-2">
          <div className="rounded-none ring-1 ring-slate-200 bg-white shadow-sm">
            <div className="border-b border-slate-200 px-4 py-3">
              <h2 className="font-semibold text-slate-700">{t("dcim.room.title")}</h2>
            </div>
            {rooms.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-12 text-slate-400">
                <LayoutGrid className="h-10 w-10 opacity-30" />
                <p className="text-sm">{t("dcim.room.no_rooms")}</p>
                {user?.role === "ADMIN" && (
                  <Link href="/dcim/admin" className="mt-1 text-xs text-[var(--accent)] hover:underline">
                    {t("dcim.dashboard.manage")}
                  </Link>
                )}
              </div>
            ) : (
              <div className="divide-y divide-slate-100">
                {rooms.map((room) => (
                  <button
                    key={room.id}
                    onClick={() => router.push(`/dcim/rooms/${room.id}`)}
                    className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-slate-50"
                  >
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-none bg-indigo-50 text-indigo-600">
                      <Server className="h-4 w-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="truncate font-medium text-slate-800">{room.name}</p>
                      <p className="truncate text-xs text-slate-500">
                        {room.floor.building.name} · {room.floor.name} ·{" "}
                        <span className={`font-medium ${room.kind === "CPD" ? "text-indigo-600" : "text-slate-600"}`}>
                          {room.kind === "CPD" ? t("dcim.room.kind_cpd") : t("dcim.room.kind_technical")}
                        </span>
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="text-xs text-slate-400">{room._count.footprints} fp</p>
                      <ChevronRight className="ml-auto h-4 w-4 text-slate-300" />
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Power alerts */}
        <div>
          <div className="rounded-none ring-1 ring-slate-200 bg-white shadow-sm">
            <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
              <h2 className="font-semibold text-slate-700">{t("dcim.alert.title")}</h2>
              {alerts.length > 0 && (
                <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">
                  {alerts.length}
                </span>
              )}
            </div>
            <div className="px-4 py-3">
              {alerts.length === 0 ? (
                <div className="flex flex-col items-center gap-1 py-6 text-slate-400">
                  <Zap className="h-8 w-8 opacity-30" />
                  <p className="text-sm">{t("dcim.dashboard.no_alerts")}</p>
                </div>
              ) : (
                <div>
                  {alerts.slice(0, 8).map((a) => (
                    <AlertRow key={a.rackCiId} alert={a} />
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

      </div>

      </div>
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";
import {
  Search, RefreshCw, AlertTriangle, Plus,
  Shield, ShieldAlert, ShieldCheck, ShieldOff, Scan, Loader2,
} from "lucide-react";
import AddCIModal from "@/components/AddCIModal";
import { useAuth } from "@/contexts/AuthContext";
import { apiFetch } from "@/lib/apiFetch";

// ─── Types ────────────────────────────────────────────────────────────────────

type Criticality  = "LOW" | "MEDIUM" | "HIGH" | "MISSION_CRITICAL";
type Environment  = "DEVELOPMENT" | "TESTING" | "STAGING" | "PRODUCTION";
type VulnSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

interface User          { id: string; username: string; email: string }
interface Vulnerability { cve: string; severity: VulnSeverity; description: string; source?: string }

interface AgentStatus {
  agentId:          string;
  agentVersion:     string;
  status:           string;
  preventionPolicy: string;
  lastSeen:         string;
  detections:       unknown[];
  source:           string;
  updatedAt:        string;
}

interface CI {
  id:              string;
  name:            string;
  apiSlug:         string;
  criticality:     Criticality;
  environment:     Environment;
  technicalLead:   User | null;
  hardware:        { serialNumber: string; model: string; manufacturer: string } | null;
  software:        { version: string; licenseType: string } | null;
  vulnerabilities: Vulnerability[] | null;
  agentStatus:     AgentStatus | null;
}

// ─── Badge helpers ─────────────────────────────────────────────────────────────

const ENV_STYLES: Record<Environment, string> = {
  PRODUCTION:  "bg-red-100 text-red-800 ring-red-200",
  STAGING:     "bg-orange-100 text-orange-800 ring-orange-200",
  TESTING:     "bg-blue-100 text-blue-800 ring-blue-200",
  DEVELOPMENT: "bg-green-100 text-green-800 ring-green-200",
};
const CRIT_STYLES: Record<Criticality, string> = {
  MISSION_CRITICAL: "bg-red-600 text-white",
  HIGH:             "bg-orange-500 text-white",
  MEDIUM:           "bg-yellow-400 text-yellow-900",
  LOW:              "bg-slate-200 text-slate-700",
};
const CRIT_LABEL: Record<Criticality, string> = {
  MISSION_CRITICAL: "Mission Critical", HIGH: "High", MEDIUM: "Medium", LOW: "Low",
};

function EnvironmentBadge({ env }: { env: Environment }) {
  return <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${ENV_STYLES[env]}`}>{env.charAt(0) + env.slice(1).toLowerCase()}</span>;
}
function CriticalityBadge({ level }: { level: Criticality }) {
  return <span className={`inline-flex items-center rounded-md px-2 py-1 text-xs font-semibold ${CRIT_STYLES[level]}`}>{CRIT_LABEL[level]}</span>;
}

// ─── Greenbone vuln badge ──────────────────────────────────────────────────────

function VulnBadge({ vulns }: { vulns: Vulnerability[] | null }) {
  if (vulns === null) return <div className="flex items-center gap-1.5 text-slate-400"><ShieldOff className="h-4 w-4" /><span className="text-xs">No escaneado</span></div>;
  if (vulns.length === 0) return <div className="flex items-center gap-1.5 text-emerald-600"><ShieldCheck className="h-4 w-4" /><span className="text-xs font-medium">Limpio</span></div>;

  const critical = vulns.filter((v) => v.severity === "CRITICAL").length;
  const high     = vulns.filter((v) => v.severity === "HIGH").length;
  const medium   = vulns.filter((v) => v.severity === "MEDIUM").length;
  const low      = vulns.filter((v) => v.severity === "LOW").length;
  const topSev   = critical > 0 ? "CRITICAL" : high > 0 ? "HIGH" : medium > 0 ? "MEDIUM" : "LOW";
  const colors   = { CRITICAL: "text-red-600", HIGH: "text-orange-500", MEDIUM: "text-yellow-600", LOW: "text-slate-500" };

  // Check if sourced from Greenbone
  const hasGreenbone = vulns.some((v) => v.source === "greenbone");

  return (
    <div className={`flex items-center gap-1.5 ${colors[topSev]}`}>
      <ShieldAlert className="h-4 w-4" />
      <div className="text-xs font-medium space-y-0.5">
        {critical > 0 && <p className="text-red-600">CRITICAL ×{critical}</p>}
        {high     > 0 && <p className="text-orange-500">HIGH ×{high}</p>}
        {medium   > 0 && <p className="text-yellow-600">MEDIUM ×{medium}</p>}
        {low      > 0 && <p className="text-slate-500">LOW ×{low}</p>}
        {hasGreenbone && <p className="text-slate-400 text-[10px]">via Greenbone</p>}
      </div>
    </div>
  );
}

// ─── CrowdStrike agent badge ──────────────────────────────────────────────────

function AgentBadge({ agent }: { agent: AgentStatus | null }) {
  if (!agent) {
    return (
      <div className="flex items-center gap-1.5 text-slate-400">
        <Shield className="h-3.5 w-3.5" />
        <span className="text-xs">Sin agente</span>
      </div>
    );
  }

  const hasDetections = (agent.detections?.length ?? 0) > 0;
  const isActive      = agent.status === "normal" && agent.preventionPolicy === "active";
  const isReduced     = agent.status === "reduced_functionality" || agent.preventionPolicy === "disabled";

  const color = hasDetections ? "text-red-600" : isActive ? "text-emerald-600" : isReduced ? "text-orange-500" : "text-slate-500";
  const bg    = hasDetections ? "bg-red-50" : isActive ? "bg-emerald-50" : isReduced ? "bg-orange-50" : "bg-slate-50";
  const label = hasDetections
    ? `${agent.detections.length} detección${agent.detections.length > 1 ? "es" : ""}`
    : isActive ? "Protegido" : isReduced ? "Reducido" : agent.status;

  return (
    <div className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 ${bg} ${color}`}>
      <Shield className="h-3.5 w-3.5 flex-shrink-0" />
      <div className="text-xs font-medium">
        <p>{label}</p>
        <p className="text-[10px] text-slate-400">Falcon v{agent.agentVersion?.split(".").slice(0, 2).join(".")}</p>
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function InventoryPage() {
  const { isAdmin }                   = useAuth();
  const [cis, setCis]                 = useState<CI[]>([]);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState<string | null>(null);
  const [search, setSearch]           = useState("");
  const [showModal, setShowModal]     = useState(false);
  const [scanning, setScanning]       = useState<Set<string>>(new Set());

  const fetchCIs = async () => {
    setLoading(true); setError(null);
    try {
      const res = await apiFetch("/api/cis");
      if (!res.ok) throw new Error(`Status ${res.status}`);
      const json: { total: number; data: CI[] } = await res.json();
      setCis(json.data);
    } catch (err) { setError(err instanceof Error ? err.message : "Unknown error"); }
    finally { setLoading(false); }
  };

  useEffect(() => { fetchCIs(); }, []);

  const handleScan = async (ciId: string) => {
    setScanning((prev) => new Set(prev).add(ciId));
    try {
      const res = await apiFetch(`/api/cis/${ciId}/scan`, { method: "POST" });
      if (!res.ok) throw new Error(`Status ${res.status}`);
      const { vulnerabilities }: { vulnerabilities: Vulnerability[] } = await res.json();
      setCis((prev) => prev.map((ci) => (ci.id === ciId ? { ...ci, vulnerabilities } : ci)));
    } catch (err) { console.error("Scan failed:", err); }
    finally {
      setScanning((prev) => { const n = new Set(prev); n.delete(ciId); return n; });
    }
  };

  const filtered = cis.filter((ci) => ci.name.toLowerCase().includes(search.toLowerCase()));

  return (
    <>
      {showModal && <AddCIModal onClose={() => setShowModal(false)} onCreated={fetchCIs} />}

      <div className="min-h-screen bg-slate-50">
        <header className="border-b border-slate-200 bg-white px-8 py-5">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-xl font-bold text-slate-900">Inventario de CIs</h1>
              <p className="text-sm text-slate-500 mt-0.5">{loading ? "Cargando…" : `${cis.length} configuration items`}</p>
            </div>
            {isAdmin && (
              <button onClick={() => setShowModal(true)} className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700 transition-colors shadow-sm">
                <Plus className="h-4 w-4" />Añadir CI
              </button>
            )}
          </div>
        </header>

        <div className="px-8 py-8 max-w-7xl mx-auto">
          <div className="rounded-2xl bg-white shadow-sm ring-1 ring-slate-200 overflow-hidden">
            <div className="flex flex-col gap-3 border-b border-slate-200 px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
              <h2 className="text-sm font-semibold text-slate-700">Todos los activos</h2>
              <div className="flex items-center gap-2">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <input type="text" placeholder="Buscar por nombre…" value={search} onChange={(e) => setSearch(e.target.value)}
                    className="w-64 rounded-lg border border-slate-300 bg-slate-50 py-2 pl-9 pr-3 text-sm focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100" />
                </div>
                <button onClick={fetchCIs} className="flex items-center justify-center rounded-lg border border-slate-300 bg-slate-50 p-2 text-slate-500 hover:bg-slate-100 transition-colors">
                  <RefreshCw className="h-4 w-4" />
                </button>
              </div>
            </div>

            {loading && <div className="flex items-center justify-center py-20 text-slate-400"><RefreshCw className="mr-2 h-5 w-5 animate-spin" /><span className="text-sm">Cargando…</span></div>}

            {error && !loading && (
              <div className="flex flex-col items-center justify-center gap-2 py-16 text-red-500">
                <AlertTriangle className="h-8 w-8" />
                <p className="text-sm font-medium">Error al cargar los CIs</p>
                <p className="text-xs text-slate-400">{error}</p>
                <button onClick={fetchCIs} className="mt-2 rounded-lg bg-red-50 px-4 py-1.5 text-xs font-medium text-red-600 hover:bg-red-100">Reintentar</button>
              </div>
            )}

            {!loading && !error && (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-100 bg-slate-50 text-left">
                      <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wider text-slate-500">Nombre</th>
                      <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wider text-slate-500">Tipo</th>
                      <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wider text-slate-500">Entorno</th>
                      <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wider text-slate-500">Criticidad</th>
                      <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wider text-slate-500">
                        <div className="flex items-center gap-1.5"><ShieldAlert className="h-3.5 w-3.5" />Greenbone</div>
                      </th>
                      <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wider text-slate-500">
                        <div className="flex items-center gap-1.5"><Shield className="h-3.5 w-3.5" />CrowdStrike</div>
                      </th>
                      <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wider text-slate-500">Responsable Técnico</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {filtered.length === 0 ? (
                      <tr><td colSpan={7} className="py-12 text-center text-slate-400 text-sm">No se encontraron CIs.</td></tr>
                    ) : (
                      filtered.map((ci) => {
                        const type = ci.hardware ? "Hardware" : ci.software ? "Software" : "Otro";
                        const typeColor = ci.hardware ? "bg-emerald-50 text-emerald-700" : ci.software ? "bg-violet-50 text-violet-700" : "bg-slate-100 text-slate-600";
                        const isScanning = scanning.has(ci.id);

                        return (
                          <tr key={ci.id} className="group hover:bg-indigo-50/40 transition-colors">
                            <td className="px-6 py-4 font-medium text-slate-800">
                              <span className="group-hover:text-indigo-700 transition-colors">{ci.name}</span>
                              <p className="text-xs text-slate-400 font-normal mt-0.5">{ci.apiSlug}</p>
                            </td>
                            <td className="px-6 py-4"><span className={`inline-flex items-center rounded-md px-2 py-1 text-xs font-medium ${typeColor}`}>{type}</span></td>
                            <td className="px-6 py-4"><EnvironmentBadge env={ci.environment} /></td>
                            <td className="px-6 py-4"><CriticalityBadge level={ci.criticality} /></td>

                            {/* Greenbone / vulnerability column */}
                            <td className="px-6 py-4">
                              <div className="flex items-center gap-2">
                                <VulnBadge vulns={ci.vulnerabilities} />
                                {isAdmin && (
                                  <button onClick={() => handleScan(ci.id)} disabled={isScanning}
                                    title="Scan manual"
                                    className="flex items-center gap-1 rounded border border-slate-300 bg-white px-2 py-1 text-[11px] text-slate-500 hover:bg-indigo-50 hover:border-indigo-300 hover:text-indigo-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
                                    {isScanning ? <Loader2 className="h-3 w-3 animate-spin" /> : <Scan className="h-3 w-3" />}
                                    {isScanning ? "…" : "Scan"}
                                  </button>
                                )}
                              </div>
                            </td>

                            {/* CrowdStrike agent column */}
                            <td className="px-6 py-4">
                              <AgentBadge agent={ci.agentStatus} />
                            </td>

                            <td className="px-6 py-4">
                              {ci.technicalLead ? (
                                <div>
                                  <p className="font-medium text-slate-700">{ci.technicalLead.username}</p>
                                  <p className="text-xs text-slate-400">{ci.technicalLead.email}</p>
                                </div>
                              ) : <span className="text-xs italic text-slate-400">Sin asignar</span>}
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            )}

            {!loading && !error && (
              <div className="border-t border-slate-100 px-6 py-3 text-xs text-slate-400">
                Mostrando {filtered.length} de {cis.length} activos
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

"use client";

import { useEffect, useState } from "react";
import {
  Search, RefreshCw, AlertTriangle, Plus, Download, Upload, FileDown,
  Shield, ShieldAlert, ShieldCheck, ShieldOff, CheckCircle2, XCircle,
  Server, Box, Database, Network, HardDrive, Archive, Package, Cpu,
  Monitor, Laptop, Printer, ScanLine, Tv, Video, Cast, Clock,
  Phone, Smartphone, Tablet, QrCode, Camera, BatteryCharging,
  Key, Cloud, Terminal,
} from "lucide-react";
import Papa from "papaparse";
import AddCIModal from "@/components/AddCIModal";
import { useAuth } from "@/contexts/AuthContext";
import { apiFetch } from "@/lib/apiFetch";
import { exportToCSV } from "@/lib/csvExport";

// ─── Types ────────────────────────────────────────────────────────────────────

type Criticality  = "LOW" | "MEDIUM" | "HIGH" | "MISSION_CRITICAL";
type Environment  = "DEVELOPMENT" | "TESTING" | "STAGING" | "PRODUCTION";
type VulnSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
type VulnStatus   = "NUEVO" | "ASIGNADO" | "EN_CURSO" | "PARADO" | "RESUELTO";

interface User          { id: string; username: string; email: string }
interface Vulnerability { cve: string; severity: VulnSeverity; description: string; source?: string; status?: VulnStatus }

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
  ciType:          string | null;
  technicalLead:   User | null;
  hardware:        { serialNumber: string; model: string; manufacturer: string } | null;
  software:        { version: string; licenseType: string } | null;
  vulnerabilities: Vulnerability[] | null;
  agentStatus:     AgentStatus | null;
}

// ─── CI type visual map ───────────────────────────────────────────────────────

const CI_TYPE_META: Record<string, { label: string; color: string; icon: React.ReactNode }> = {
  PHYSICAL_SERVER: { label: "Servidor Físico",   color: "bg-emerald-50 text-emerald-700", icon: <Server    className="h-3 w-3" /> },
  VIRTUAL_SERVER:  { label: "Servidor Virtual",  color: "bg-teal-50 text-teal-700",       icon: <Box       className="h-3 w-3" /> },
  DATABASE:        { label: "Base de Datos",     color: "bg-blue-50 text-blue-700",        icon: <Database  className="h-3 w-3" /> },
  NETWORK:         { label: "Red",               color: "bg-cyan-50 text-cyan-700",        icon: <Network   className="h-3 w-3" /> },
  STORAGE:         { label: "Almacenamiento",    color: "bg-amber-50 text-amber-700",      icon: <HardDrive className="h-3 w-3" /> },
  BACKUP:          { label: "Backup",            color: "bg-purple-50 text-purple-700",    icon: <Archive   className="h-3 w-3" /> },
  HARDWARE:        { label: "Hardware",          color: "bg-emerald-50 text-emerald-700",  icon: <Cpu       className="h-3 w-3" /> },
  SOFTWARE:        { label: "Software",          color: "bg-violet-50 text-violet-700",    icon: <Package   className="h-3 w-3" /> },
  OTHER:           { label: "Otro",              color: "bg-slate-100 text-slate-600",     icon: null },
  // Puesto de usuario
  DESKTOP:         { label: "Escritorio",        color: "bg-sky-50 text-sky-700",          icon: <Monitor   className="h-3 w-3" /> },
  LAPTOP:          { label: "Portátil",          color: "bg-indigo-50 text-indigo-700",    icon: <Laptop    className="h-3 w-3" /> },
  PRINTER:         { label: "Impresora",         color: "bg-slate-100 text-slate-600",     icon: <Printer   className="h-3 w-3" /> },
  SCANNER:         { label: "Escáner",           color: "bg-gray-100 text-gray-600",       icon: <ScanLine  className="h-3 w-3" /> },
  MONITOR:         { label: "Monitor",           color: "bg-slate-50 text-slate-600",      icon: <Monitor   className="h-3 w-3" /> },
  // Oficina / Salas
  VIDEOCONFERENCE: { label: "Videoconf.",        color: "bg-cyan-50 text-cyan-700",        icon: <Video     className="h-3 w-3" /> },
  SMART_DISPLAY:   { label: "Pantalla Smart",    color: "bg-blue-50 text-blue-700",        icon: <Tv        className="h-3 w-3" /> },
  TIME_CLOCK:      { label: "Reloj Fichaje",     color: "bg-orange-50 text-orange-700",    icon: <Clock     className="h-3 w-3" /> },
  IP_PHONE:        { label: "Teléfono IP",       color: "bg-green-50 text-green-700",      icon: <Phone     className="h-3 w-3" /> },
  // Movilidad / Logística
  SMARTPHONE:      { label: "Smartphone",        color: "bg-violet-50 text-violet-700",    icon: <Smartphone className="h-3 w-3" /> },
  TABLET:          { label: "Tablet",            color: "bg-purple-50 text-purple-700",    icon: <Tablet    className="h-3 w-3" /> },
  PDA:             { label: "PDA",               color: "bg-fuchsia-50 text-fuchsia-700",  icon: <Smartphone className="h-3 w-3" /> },
  BARCODE_SCANNER: { label: "Lector Código",     color: "bg-amber-50 text-amber-700",      icon: <QrCode    className="h-3 w-3" /> },
  // IoT / Infra
  IP_CAMERA:       { label: "Cámara IP",         color: "bg-red-50 text-red-700",          icon: <Camera    className="h-3 w-3" /> },
  UPS:             { label: "SAI / UPS",         color: "bg-yellow-50 text-yellow-700",    icon: <BatteryCharging className="h-3 w-3" /> },
  // Conectividad
  WIFI_AP:         { label: "Punto de Acceso",   color: "bg-teal-50 text-teal-700",        icon: <Cast      className="h-3 w-3" /> },
  // Cloud
  CLOUD_INSTANCE:  { label: "Instancia Cloud",   color: "bg-sky-50 text-sky-700",          icon: <Cloud     className="h-3 w-3" /> },
  CLOUD_STORAGE:   { label: "Storage Cloud",     color: "bg-blue-50 text-blue-700",        icon: <Database  className="h-3 w-3" /> },
  // Software base y licencias
  BASE_SOFTWARE:   { label: "Software Base",     color: "bg-slate-100 text-slate-700",     icon: <Terminal  className="h-3 w-3" /> },
  LICENSE:         { label: "Licencia",          color: "bg-amber-50 text-amber-700",      icon: <Key       className="h-3 w-3" /> },
};

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
  if (vulns === null) return <div className="flex items-center gap-1.5 text-slate-400"><ShieldOff className="h-4 w-4" /><span className="text-xs">Sin datos</span></div>;
  const open = vulns.filter((v) => v.status !== "RESUELTO");
  if (open.length === 0 && vulns.length === 0) return <div className="flex items-center gap-1.5 text-emerald-600"><ShieldCheck className="h-4 w-4" /><span className="text-xs font-medium">Limpio</span></div>;
  if (open.length === 0) return <div className="flex items-center gap-1.5 text-emerald-600"><ShieldCheck className="h-4 w-4" /><span className="text-xs font-medium">Todo resuelto</span></div>;

  const critical = open.filter((v) => v.severity === "CRITICAL").length;
  const high     = open.filter((v) => v.severity === "HIGH").length;
  const medium   = open.filter((v) => v.severity === "MEDIUM").length;
  const low      = open.filter((v) => v.severity === "LOW").length;
  const topSev   = critical > 0 ? "CRITICAL" : high > 0 ? "HIGH" : medium > 0 ? "MEDIUM" : "LOW";
  const colors   = { CRITICAL: "text-red-600", HIGH: "text-orange-500", MEDIUM: "text-yellow-600", LOW: "text-slate-500" };

  return (
    <div className={`flex items-center gap-1.5 ${colors[topSev]}`}>
      <ShieldAlert className="h-4 w-4" />
      <div className="text-xs font-medium space-y-0.5">
        {critical > 0 && <p className="text-red-600">CRITICAL ×{critical}</p>}
        {high     > 0 && <p className="text-orange-500">HIGH ×{high}</p>}
        {medium   > 0 && <p className="text-yellow-600">MEDIUM ×{medium}</p>}
        {low      > 0 && <p className="text-slate-500">LOW ×{low}</p>}
        <p className="text-slate-400 text-[10px]">{open.length} abierto{open.length !== 1 ? "s" : ""}</p>
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
        {agent.agentVersion && <p className="text-[10px] text-slate-400">Falcon v{agent.agentVersion.split(".").slice(0, 2).join(".")}</p>}
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function InventoryPage() {
  const { isAdmin }               = useAuth();
  const [cis, setCis]             = useState<CI[]>([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState<string | null>(null);
  const [search, setSearch]       = useState("");
  const [showModal, setShowModal] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{ success: number; errors: number; message: string } | null>(null);

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

  const filtered = cis.filter((ci) => ci.name.toLowerCase().includes(search.toLowerCase()));

  const handleExportCSV = () => {
    exportToCSV(
      `inventario-cis-${new Date().toISOString().slice(0, 10)}.csv`,
      ["Nombre", "Slug", "Tipo", "Entorno", "Criticidad", "Responsable Técnico", "Vulns CRITICAL", "Vulns HIGH", "Vulns MEDIUM", "CrowdStrike"],
      filtered.map((ci) => {
        const type = ci.hardware ? "Hardware" : ci.software ? "Software" : "Otro";
        const critVulns   = ci.vulnerabilities?.filter((v) => v.severity === "CRITICAL" && v.status !== "RESUELTO").length ?? 0;
        const highVulns   = ci.vulnerabilities?.filter((v) => v.severity === "HIGH"     && v.status !== "RESUELTO").length ?? 0;
        const medVulns    = ci.vulnerabilities?.filter((v) => v.severity === "MEDIUM"   && v.status !== "RESUELTO").length ?? 0;
        const agentState  = ci.agentStatus ? ci.agentStatus.status : "Sin agente";
        return [ci.name, ci.apiSlug, type, ci.environment, ci.criticality, ci.technicalLead?.username ?? "", critVulns, highVulns, medVulns, agentState];
      })
    );
  };

  const CSV_TEMPLATE_HEADERS = [
    "name","ciType","criticality","environment","manufacturer","serialNumber","model",
    "version","licenseType","licenseModel","licenseMetric","licenseQty","licenseExpiry",
    "ipAddress","description","status",
  ];

  const handleDownloadTemplate = () => {
    exportToCSV("plantilla-cis.csv", CSV_TEMPLATE_HEADERS, [
      // Hardware example
      ["Server-PRD-01","PHYSICAL_SERVER","HIGH","PRODUCTION","Dell","SN-DL-00001","PowerEdge R740","","","","","","","192.168.1.10","Primary web server","active"],
      // License example
      ["Office 365 E3","LICENSE","MEDIUM","PRODUCTION","Microsoft","","","","","subscription","nominal","50","2026-12-31","","Microsoft Office suite","active"],
    ]);
  };

  const handleImportCSV = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(true);
    setImportResult(null);

    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: async (result) => {
        try {
          const res = await apiFetch("/api/cis/bulk", {
            method: "POST",
            body: JSON.stringify(result.data),
          });
          const json: { successCount: number; errorCount: number; message: string } = await res.json();
          setImportResult({ success: json.successCount, errors: json.errorCount, message: json.message });
          if (json.successCount > 0) fetchCIs();
        } catch (err) {
          setImportResult({ success: 0, errors: 1, message: err instanceof Error ? err.message : "Error de red al importar" });
        } finally {
          setImporting(false);
          e.target.value = "";
        }
      },
      error: (err) => {
        setImportResult({ success: 0, errors: 1, message: `Error al parsear CSV: ${err.message}` });
        setImporting(false);
      },
    });
  };

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
              <div className="flex items-center gap-2">
                <button
                  onClick={handleDownloadTemplate}
                  className="flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50 transition-colors"
                  title="Descargar plantilla CSV para importación masiva"
                >
                  <FileDown className="h-3.5 w-3.5" />Plantilla CSV
                </button>
                <label className={`flex items-center gap-1.5 cursor-pointer rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50 transition-colors ${importing ? "opacity-50 pointer-events-none" : ""}`}
                  title="Importar CIs desde CSV">
                  {importing ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                  {importing ? "Importando…" : "Importar CSV"}
                  <input type="file" accept=".csv" className="hidden" onChange={handleImportCSV} disabled={importing} />
                </label>
                <button onClick={() => setShowModal(true)} className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700 transition-colors shadow-sm">
                  <Plus className="h-4 w-4" />Añadir CI
                </button>
              </div>
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
                <button
                  onClick={handleExportCSV}
                  disabled={loading || filtered.length === 0}
                  className="flex items-center gap-1.5 rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-100 transition-colors disabled:opacity-50"
                >
                  <Download className="h-3.5 w-3.5" />📥 CSV
                </button>
              </div>
            </div>

            {/* Import result banner */}
            {importResult && (
              <div className={`flex items-center justify-between gap-3 px-6 py-3 text-sm border-b ${importResult.errors === 0 ? "bg-emerald-50 border-emerald-200 text-emerald-700" : importResult.success === 0 ? "bg-red-50 border-red-200 text-red-700" : "bg-amber-50 border-amber-200 text-amber-700"}`}>
                <div className="flex items-center gap-2">
                  {importResult.errors === 0 ? <CheckCircle2 className="h-4 w-4 flex-shrink-0" /> : <XCircle className="h-4 w-4 flex-shrink-0" />}
                  <span>{importResult.message}</span>
                </div>
                <button onClick={() => setImportResult(null)} className="text-slate-400 hover:text-slate-600 text-xs">✕ Cerrar</button>
              </div>
            )}

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
                        const resolvedType = ci.ciType || (ci.hardware ? "HARDWARE" : ci.software ? "SOFTWARE" : "OTHER");
                        const typeMeta = CI_TYPE_META[resolvedType] ?? CI_TYPE_META["OTHER"];

                        return (
                          <tr key={ci.id} className="group hover:bg-indigo-50/40 transition-colors">
                            <td className="px-6 py-4 font-medium text-slate-800">
                              <span className="group-hover:text-indigo-700 transition-colors">{ci.name}</span>
                              <p className="text-xs text-slate-400 font-normal mt-0.5">{ci.apiSlug}</p>
                            </td>
                            <td className="px-6 py-4">
                              <span className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium ${typeMeta.color}`}>
                                {typeMeta.icon}{typeMeta.label}
                              </span>
                            </td>
                            <td className="px-6 py-4"><EnvironmentBadge env={ci.environment} /></td>
                            <td className="px-6 py-4"><CriticalityBadge level={ci.criticality} /></td>
                            <td className="px-6 py-4"><VulnBadge vulns={ci.vulnerabilities} /></td>
                            <td className="px-6 py-4"><AgentBadge agent={ci.agentStatus} /></td>
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

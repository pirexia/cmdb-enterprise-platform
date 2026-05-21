"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { useLanguage } from "@/contexts/LanguageContext";
import {
  Search, RefreshCw, AlertTriangle, Plus, Download, Upload, FileDown,
  Shield, ShieldAlert, ShieldCheck, ShieldOff, CheckCircle2, XCircle,
  ChevronUp, ChevronDown, ChevronsUpDown, FilterX,
  Server, Box, Database, Network, HardDrive, Archive, Package, Cpu,
  Monitor, Laptop, Printer, ScanLine, Tv, Video, Cast, Clock,
  Phone, Smartphone, Tablet, QrCode, Camera, BatteryCharging,
  Key, Cloud, Terminal, Pencil, Trash2, Link2,
} from "lucide-react";
import Papa from "papaparse";
import AddCIModal from "@/components/AddCIModal";
import EditCIModal from "@/components/EditCIModal";
import AddRelationModal from "@/components/AddRelationModal";
import CIDetailModal from "@/components/CIDetailModal";
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

interface ContractRef {
  id: string; contractNumber: string; endDate: string | null;
  vendor: { id: string; name: string };
}

interface CITypeItem   { id: string; code: string; name: string }
interface CITypeCategory { code: string; name: string; ciTypes: CITypeItem[] }

interface CI {
  id:              string;
  name:            string;
  apiSlug:         string;
  criticality:     Criticality;
  environment:     Environment;
  ciType:          string | null;
  ciTypeId:        string | null;
  ciTypeName:      string | null;
  eolDate:         string | null;
  eosDate:         string | null;
  status:          string | null;
  inventoryNumber: string | null;
  businessOwnerId: string | null;
  technicalLeadId: string | null;
  branchId:        string | null;
  ciModelId:       string | null;
  technicalLead:   User | null;
  hardware:        { serialNumber: string; model: string; manufacturer: string } | null;
  software:        { version: string; licenseType: string } | null;
  vulnerabilities: Vulnerability[] | null;
  agentStatus:     AgentStatus | null;
  contracts:       ContractRef[];
  // NIS2 / GDPR
  businessImpact:     string | null;
  recoveryPriority:   number | null;
  rto:                number | null;
  rpo:                number | null;
  spofRisk:           boolean;
  containsPii:        boolean;
  dataClassification: string | null;
}

// ─── Support status badge ─────────────────────────────────────────────────────

function SupportBadge({ eolDate, eosDate }: { eolDate: string | null; eosDate: string | null }) {
  const { t } = useLanguage();
  const now = Date.now();
  const sixMonths = 180 * 86_400_000;
  const dates = [eolDate, eosDate].filter(Boolean).map((d) => new Date(d!).getTime());
  if (dates.length === 0) return null;

  const nearest = Math.min(...dates);
  const daysLeft = Math.floor((nearest - now) / 86_400_000);

  if (nearest < now) {
    return <span className="inline-block rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-semibold text-red-700">{t('inventory.support_badge.expired')}</span>;
  }
  if (nearest - now < sixMonths) {
    return <span className="inline-block rounded-full bg-orange-100 px-2 py-0.5 text-[10px] font-semibold text-orange-700">{t('inventory.support_badge.warning', { days: String(daysLeft) })}</span>;
  }
  return <span className="inline-block rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">{t('inventory.support_badge.ok')}</span>;
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
  const { t } = useLanguage();
  if (vulns === null) return <div className="flex items-center gap-1.5 text-slate-400"><ShieldOff className="h-4 w-4" /><span className="text-xs">{t('inventory.vuln_badge.no_data')}</span></div>;
  const open = vulns.filter((v) => v.status !== "RESUELTO");
  if (open.length === 0 && vulns.length === 0) return <div className="flex items-center gap-1.5 text-emerald-600"><ShieldCheck className="h-4 w-4" /><span className="text-xs font-medium">{t('inventory.vuln_badge.clean')}</span></div>;
  if (open.length === 0) return <div className="flex items-center gap-1.5 text-emerald-600"><ShieldCheck className="h-4 w-4" /><span className="text-xs font-medium">{t('inventory.vuln_badge.all_resolved')}</span></div>;

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
        <p className="text-slate-400 text-[10px]">{open.length !== 1 ? t('inventory.vuln_badge.open_many', { count: String(open.length) }) : t('inventory.vuln_badge.open_one', { count: String(open.length) })}</p>
      </div>
    </div>
  );
}

// ─── CrowdStrike agent badge ──────────────────────────────────────────────────

function AgentBadge({ agent }: { agent: AgentStatus | null }) {
  const { t } = useLanguage();
  if (!agent) {
    return (
      <div className="flex items-center gap-1.5 text-slate-400">
        <Shield className="h-3.5 w-3.5" />
        <span className="text-xs">{t('inventory.agent_badge.no_agent')}</span>
      </div>
    );
  }

  const hasDetections = (agent.detections?.length ?? 0) > 0;
  const isActive      = agent.status === "normal" && agent.preventionPolicy === "active";
  const isReduced     = agent.status === "reduced_functionality" || agent.preventionPolicy === "disabled";
  const color = hasDetections ? "text-red-600" : isActive ? "text-emerald-600" : isReduced ? "text-orange-500" : "text-slate-500";
  const bg    = hasDetections ? "bg-red-50" : isActive ? "bg-emerald-50" : isReduced ? "bg-orange-50" : "bg-slate-50";
  const n = agent.detections?.length ?? 0;
  const label = hasDetections
    ? (n === 1 ? t('inventory.agent_badge.detection_one', { count: String(n) }) : t('inventory.agent_badge.detection_many', { count: String(n) }))
    : isActive ? t('inventory.agent_badge.protected') : isReduced ? t('inventory.agent_badge.reduced') : agent.status;

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
  const { t }                     = useLanguage();
  const [cis, setCis]                         = useState<CI[]>([]);
  const [ciTypeCategories, setCiTypeCategories] = useState<CITypeCategory[]>([]);
  const [loading, setLoading]                 = useState(true);
  const [error, setError]                     = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [editingCI, setEditingCI] = useState<CI | null>(null);
  const [detailCI, setDetailCI]   = useState<CI | null>(null);
  const [deletingCI, setDeletingCI] = useState<string | null>(null);
  const [relatingCI, setRelatingCI] = useState<CI | null>(null);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{ success: number; errors: number; message: string } | null>(null);

  type SortCol = "name" | "ciType" | "environment" | "criticality" | null;
  type SortDir = "asc" | "desc";
  const [sort, setSort] = useState<{ col: SortCol; dir: SortDir }>({ col: null, dir: "asc" });
  const [filters, setFilters] = useState({ name: "", ciType: "", environment: "", criticality: "", vulns: "", agent: "" });

  const activeFilterCount = Object.values(filters).filter(Boolean).length;

  const toggleSort = (col: SortCol) =>
    setSort((prev) => prev.col !== col ? { col, dir: "asc" } : prev.dir === "asc" ? { col, dir: "desc" } : { col: null, dir: "asc" });

  const setFilter = (key: keyof typeof filters, val: string) =>
    setFilters((prev) => ({ ...prev, [key]: val }));

  const clearFilters = () => { setFilters({ name: "", ciType: "", environment: "", criticality: "", vulns: "", agent: "" }); setSort({ col: null, dir: "asc" }); };

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

  useEffect(() => {
    fetchCIs();
    apiFetch("/api/masters/ci-type-categories").then((r) => r.json())
      .then((d) => { if (Array.isArray(d)) setCiTypeCategories(d); })
      .catch(() => {});
  }, []);

  // RAG chat deep-link: ?focus=<ciId> opens the detail modal once cis are loaded.
  const searchParams = useSearchParams();
  const router       = useRouter();
  useEffect(() => {
    const focusId = searchParams.get("focus");
    if (!focusId || cis.length === 0) return;
    const target = cis.find((c) => c.id === focusId);
    if (target) {
      setDetailCI(target);
      router.replace("/inventory", { scroll: false });
    }
  }, [searchParams, cis, router]);

  const filtered = useMemo(() => {
    const CRIT_ORDER: Record<string, number> = { LOW: 1, MEDIUM: 2, HIGH: 3, MISSION_CRITICAL: 4 };
    let result = cis.filter((ci) => {
      const resolvedType = ci.ciType || (ci.hardware ? "HARDWARE" : ci.software ? "SOFTWARE" : "OTHER");
      const openVulns = (ci.vulnerabilities ?? []).filter((v) => v.status !== "RESUELTO");
      if (filters.name && !ci.name.toLowerCase().includes(filters.name.toLowerCase())) return false;
      if (filters.ciType && resolvedType !== filters.ciType) return false;
      if (filters.environment && ci.environment !== filters.environment) return false;
      if (filters.criticality && ci.criticality !== filters.criticality) return false;
      if (filters.vulns) {
        if (filters.vulns === "no_data" && ci.vulnerabilities !== null) return false;
        if (filters.vulns === "clean" && (ci.vulnerabilities === null || openVulns.length > 0)) return false;
        if (filters.vulns === "with_vulns" && openVulns.length === 0) return false;
        if (filters.vulns === "critical" && !openVulns.some((v) => v.severity === "CRITICAL")) return false;
        if (filters.vulns === "high" && !openVulns.some((v) => v.severity === "HIGH")) return false;
      }
      if (filters.agent) {
        if (filters.agent === "no_agent" && ci.agentStatus !== null) return false;
        if (filters.agent === "protected" && (ci.agentStatus === null || ci.agentStatus.status !== "normal" || ci.agentStatus.preventionPolicy !== "active")) return false;
        if (filters.agent === "detections" && (ci.agentStatus?.detections?.length ?? 0) === 0) return false;
        if (filters.agent === "reduced" && ci.agentStatus?.status !== "reduced_functionality") return false;
      }
      return true;
    });
    if (sort.col) {
      result = [...result].sort((a, b) => {
        const dir = sort.dir === "asc" ? 1 : -1;
        if (sort.col === "name")        return dir * a.name.localeCompare(b.name);
        if (sort.col === "environment") return dir * a.environment.localeCompare(b.environment);
        if (sort.col === "criticality") return dir * ((CRIT_ORDER[a.criticality] ?? 0) - (CRIT_ORDER[b.criticality] ?? 0));
        if (sort.col === "ciType") {
          const at = a.ciType ?? (a.hardware ? "HARDWARE" : a.software ? "SOFTWARE" : "OTHER");
          const bt = b.ciType ?? (b.hardware ? "HARDWARE" : b.software ? "SOFTWARE" : "OTHER");
          return dir * at.localeCompare(bt);
        }
        return 0;
      });
    }
    return result;
  }, [cis, filters, sort]);

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`¿Está seguro de eliminar el CI "${name}"? Esta acción no se puede deshacer.`)) return;
    setDeletingCI(id);
    try {
      const res = await apiFetch(`/api/cis/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`Error ${res.status}`);
      fetchCIs();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Error al eliminar CI");
    } finally {
      setDeletingCI(null);
    }
  };

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
      {editingCI && <EditCIModal ci={editingCI} onClose={() => setEditingCI(null)} onUpdated={fetchCIs} />}
      {detailCI && (
        <CIDetailModal
          ci={detailCI}
          onClose={() => setDetailCI(null)}
          onEdit={() => { setEditingCI(detailCI); setDetailCI(null); }}
          onDelete={() => { handleDelete(detailCI.id, detailCI.name); setDetailCI(null); }}
        />
      )}
      {relatingCI && (
        <AddRelationModal
          preselectedSourceId={relatingCI.id}
          onClose={() => setRelatingCI(null)}
          onCreated={() => setRelatingCI(null)}
        />
      )}

      <div className="min-h-screen bg-slate-50">
        <header className="sticky top-0 z-10 border-b border-slate-200 bg-white px-8 py-5">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-xl font-bold text-slate-900">{t('inventory.title')}</h1>
              <p className="text-sm text-slate-500 mt-0.5">{loading ? t('common.loading') : t('inventory.total', { count: String(cis.length) })}</p>
            </div>
            {isAdmin && (
              <div className="flex items-center gap-2">
                <button
                  onClick={handleDownloadTemplate}
                  className="flex items-center gap-1.5 rounded-none border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50 transition-colors"
                  title="Descargar plantilla CSV para importación masiva"
                >
                  <FileDown className="h-3.5 w-3.5" />{t('inventory.download_template')}
                </button>
                <label className={`flex items-center gap-1.5 cursor-pointer rounded-none border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50 transition-colors ${importing ? "opacity-50 pointer-events-none" : ""}`}
                  title={t('inventory.import_csv')}>
                  {importing ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                  {importing ? t('common.loading') : t('inventory.import_csv')}
                  <input type="file" accept=".csv" className="hidden" onChange={handleImportCSV} disabled={importing} />
                </label>
                <button onClick={() => setShowModal(true)} className="flex items-center gap-2 rounded-none bg-[var(--accent)] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[var(--accent)]/90 transition-colors shadow-sm">
                  <Plus className="h-4 w-4" />{t('inventory.add_ci')}
                </button>
              </div>
            )}
          </div>
        </header>

        <div className="px-4 py-6">
          <div className="bg-white shadow-sm ring-1 ring-slate-200 overflow-hidden">
            <div className="flex flex-col gap-3 border-b border-slate-200 px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-3">
                <h2 className="text-sm font-semibold text-slate-700">Todos los activos</h2>
                {activeFilterCount > 0 && (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--accent)]/10 px-2.5 py-1 text-xs font-semibold text-[var(--accent)]">
                    <Search className="h-3 w-3" />{activeFilterCount} filtro{activeFilterCount > 1 ? "s" : ""} activo{activeFilterCount > 1 ? "s" : ""}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {activeFilterCount > 0 && (
                  <button onClick={clearFilters} className="flex items-center gap-1.5 rounded-none border border-red-200 bg-red-50 px-3 py-2 text-xs font-medium text-red-600 hover:bg-red-100 transition-colors">
                    <FilterX className="h-3.5 w-3.5" />Limpiar filtros
                  </button>
                )}
                <button onClick={fetchCIs} className="flex items-center justify-center rounded-none border border-slate-300 bg-slate-50 p-2 text-slate-500 hover:bg-slate-100 transition-colors">
                  <RefreshCw className="h-4 w-4" />
                </button>
                <button
                  onClick={handleExportCSV}
                  disabled={loading || filtered.length === 0}
                  className="flex items-center gap-1.5 rounded-none border border-slate-300 bg-slate-50 px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-100 transition-colors disabled:opacity-50"
                >
                  <Download className="h-3.5 w-3.5" />CSV
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

            {loading && <div className="flex items-center justify-center py-20 text-slate-400"><RefreshCw className="mr-2 h-5 w-5 animate-spin" /><span className="text-sm">{t('common.loading')}</span></div>}

            {error && !loading && (
              <div className="flex flex-col items-center justify-center gap-2 py-16 text-red-500">
                <AlertTriangle className="h-8 w-8" />
                <p className="text-sm font-medium">{t('common.error')}</p>
                <p className="text-xs text-slate-400">{error}</p>
                <button onClick={fetchCIs} className="mt-2 rounded-none bg-red-50 px-4 py-1.5 text-xs font-medium text-red-600 hover:bg-red-100">{t('actions.retry')}</button>
              </div>
            )}

            {!loading && !error && (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 z-10">
                    {/* ── Sort row ── */}
                    <tr className="border-b border-slate-100 bg-slate-50 text-left">
                      {/* Name */}
                      <th className="px-4 py-3 whitespace-nowrap">
                        <button onClick={() => toggleSort("name")} className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wider text-slate-500 hover:text-[var(--accent)] transition-colors">
                          {t('common.name')}
                          {sort.col === "name" ? (sort.dir === "asc" ? <ChevronUp className="h-3.5 w-3.5 text-[var(--accent)]" /> : <ChevronDown className="h-3.5 w-3.5 text-[var(--accent)]" />) : <ChevronsUpDown className="h-3.5 w-3.5 opacity-30" />}
                        </button>
                      </th>
                      {/* Type */}
                      <th className="px-4 py-3 whitespace-nowrap">
                        <button onClick={() => toggleSort("ciType")} className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wider text-slate-500 hover:text-[var(--accent)] transition-colors">
                          {t('inventory.columns.type')}
                          {sort.col === "ciType" ? (sort.dir === "asc" ? <ChevronUp className="h-3.5 w-3.5 text-[var(--accent)]" /> : <ChevronDown className="h-3.5 w-3.5 text-[var(--accent)]" />) : <ChevronsUpDown className="h-3.5 w-3.5 opacity-30" />}
                        </button>
                      </th>
                      {/* Environment */}
                      <th className="px-4 py-3 whitespace-nowrap">
                        <button onClick={() => toggleSort("environment")} className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wider text-slate-500 hover:text-[var(--accent)] transition-colors">
                          {t('inventory.columns.environment')}
                          {sort.col === "environment" ? (sort.dir === "asc" ? <ChevronUp className="h-3.5 w-3.5 text-[var(--accent)]" /> : <ChevronDown className="h-3.5 w-3.5 text-[var(--accent)]" />) : <ChevronsUpDown className="h-3.5 w-3.5 opacity-30" />}
                        </button>
                      </th>
                      {/* Criticality */}
                      <th className="px-4 py-3 whitespace-nowrap">
                        <button onClick={() => toggleSort("criticality")} className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wider text-slate-500 hover:text-[var(--accent)] transition-colors">
                          {t('inventory.columns.criticality')}
                          {sort.col === "criticality" ? (sort.dir === "asc" ? <ChevronUp className="h-3.5 w-3.5 text-[var(--accent)]" /> : <ChevronDown className="h-3.5 w-3.5 text-[var(--accent)]" />) : <ChevronsUpDown className="h-3.5 w-3.5 opacity-30" />}
                        </button>
                      </th>
                      <th className="px-4 py-3 whitespace-nowrap"><div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-slate-500"><ShieldAlert className="h-3.5 w-3.5" />Greenbone</div></th>
                      <th className="px-4 py-3 whitespace-nowrap"><div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-slate-500"><Shield className="h-3.5 w-3.5" />CrowdStrike</div></th>
                      <th className="px-4 py-3 whitespace-nowrap text-xs font-semibold uppercase tracking-wider text-slate-500">{t('inventory.columns.agent')}</th>
                      {isAdmin && <th className="px-4 py-3 whitespace-nowrap text-xs font-semibold uppercase tracking-wider text-slate-500">Acciones</th>}
                    </tr>
                    {/* ── Filter row ── */}
                    <tr className="border-b-2 border-[var(--accent)]/20 bg-[var(--accent)]/5">
                      {/* Name filter */}
                      <td className="px-3 py-2">
                        <div className="relative">
                          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                          <input type="text" placeholder="Buscar nombre…" value={filters.name} onChange={(e) => setFilter("name", e.target.value)}
                            className="w-full rounded-none border border-slate-200 bg-white py-1.5 pl-7 pr-2 text-xs text-slate-700 placeholder:text-slate-300 focus:border-[var(--accent)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]/20" />
                        </div>
                      </td>
                      {/* Type filter */}
                      <td className="px-3 py-2">
                        <select value={filters.ciType} onChange={(e) => setFilter("ciType", e.target.value)}
                          className={`w-full rounded-none border py-1.5 px-2 text-xs focus:border-[var(--accent)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]/20 ${filters.ciType ? "border-[var(--accent)] bg-[var(--accent)]/5 text-[var(--accent)] font-medium" : "border-slate-200 bg-white text-slate-600"}`}>
                          <option value="">Todos los tipos</option>
                          {ciTypeCategories.map((cat) => (
                            <optgroup key={cat.code} label={cat.name}>
                              {cat.ciTypes.map((t) => (
                                <option key={t.code} value={t.code}>{CI_TYPE_META[t.code]?.label ?? t.name}</option>
                              ))}
                            </optgroup>
                          ))}
                        </select>
                      </td>
                      {/* Environment filter */}
                      <td className="px-3 py-2">
                        <select value={filters.environment} onChange={(e) => setFilter("environment", e.target.value)}
                          className={`w-full rounded-none border py-1.5 px-2 text-xs focus:border-[var(--accent)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]/20 ${filters.environment ? "border-[var(--accent)] bg-[var(--accent)]/5 text-[var(--accent)] font-medium" : "border-slate-200 bg-white text-slate-600"}`}>
                          <option value="">Todos</option>
                          <option value="PRODUCTION">Production</option>
                          <option value="STAGING">Staging</option>
                          <option value="TESTING">Testing</option>
                          <option value="DEVELOPMENT">Development</option>
                        </select>
                      </td>
                      {/* Criticality filter */}
                      <td className="px-3 py-2">
                        <select value={filters.criticality} onChange={(e) => setFilter("criticality", e.target.value)}
                          className={`w-full rounded-none border py-1.5 px-2 text-xs focus:border-[var(--accent)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]/20 ${filters.criticality ? "border-[var(--accent)] bg-[var(--accent)]/5 text-[var(--accent)] font-medium" : "border-slate-200 bg-white text-slate-600"}`}>
                          <option value="">Todas</option>
                          <option value="MISSION_CRITICAL">Mission Critical</option>
                          <option value="HIGH">High</option>
                          <option value="MEDIUM">Medium</option>
                          <option value="LOW">Low</option>
                        </select>
                      </td>
                      {/* Vulns filter */}
                      <td className="px-3 py-2">
                        <select value={filters.vulns} onChange={(e) => setFilter("vulns", e.target.value)}
                          className={`w-full rounded-none border py-1.5 px-2 text-xs focus:border-[var(--accent)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]/20 ${filters.vulns ? "border-[var(--accent)] bg-[var(--accent)]/5 text-[var(--accent)] font-medium" : "border-slate-200 bg-white text-slate-600"}`}>
                          <option value="">Todos</option>
                          <option value="no_data">Sin datos escáner</option>
                          <option value="clean">Sin vulns abiertas</option>
                          <option value="with_vulns">Con vulns abiertas</option>
                          <option value="critical">Con CRITICAL</option>
                          <option value="high">Con HIGH</option>
                        </select>
                      </td>
                      {/* Agent filter */}
                      <td className="px-3 py-2">
                        <select value={filters.agent} onChange={(e) => setFilter("agent", e.target.value)}
                          className={`w-full rounded-none border py-1.5 px-2 text-xs focus:border-[var(--accent)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]/20 ${filters.agent ? "border-[var(--accent)] bg-[var(--accent)]/5 text-[var(--accent)] font-medium" : "border-slate-200 bg-white text-slate-600"}`}>
                          <option value="">Todos</option>
                          <option value="no_agent">Sin agente</option>
                          <option value="protected">Protegido (activo)</option>
                          <option value="reduced">Funcionalidad reducida</option>
                          <option value="detections">Con detecciones</option>
                        </select>
                      </td>
                      {/* Responsable técnico — no filter, empty cell */}
                      <td className="px-3 py-2" />
                      {isAdmin && <td className="px-3 py-2" />}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {filtered.length === 0 ? (
                      <tr><td colSpan={isAdmin ? 8 : 7} className="py-12 text-center text-slate-400 text-sm">
                        {activeFilterCount > 0 ? "No hay CIs que coincidan con los filtros activos." : t('inventory.no_cis')}
                      </td></tr>
                    ) : (
                      filtered.map((ci) => {
                        const resolvedType = ci.ciType || (ci.hardware ? "HARDWARE" : ci.software ? "SOFTWARE" : "OTHER");
                        const typeMeta = CI_TYPE_META[resolvedType] ?? CI_TYPE_META["OTHER"];

                        return (
                          <tr key={ci.id} className="group hover:bg-[var(--accent)]/5 transition-colors">
                            <td className="px-4 py-3 font-medium text-slate-800">
                              <button
                                onClick={() => setDetailCI(ci)}
                                className="text-left hover:text-[var(--accent)] transition-colors font-medium text-slate-800 group-hover:text-[var(--accent)]"
                              >{ci.name}</button>
                              <p className="text-xs text-slate-400 font-normal mt-0.5">{ci.apiSlug}</p>
                              <div className="flex flex-wrap gap-1 mt-1">
                                <SupportBadge eolDate={ci.eolDate} eosDate={ci.eosDate} />
                                {ci.spofRisk && (
                                  <span className="inline-block rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-semibold text-red-700" title="Punto Único de Fallo">SPOF</span>
                                )}
                                {ci.containsPii && (
                                  <span className="inline-block rounded-full bg-purple-100 px-2 py-0.5 text-[10px] font-semibold text-purple-700" title="Contiene datos personales (GDPR)">PII</span>
                                )}
                                {ci.businessImpact === "CRITICAL" && (
                                  <span className="inline-block rounded-full bg-orange-100 px-2 py-0.5 text-[10px] font-semibold text-orange-700">NIS2 Crítico</span>
                                )}
                              </div>
                              {ci.contracts && ci.contracts.length > 0 && (
                                <div className="mt-1.5 flex flex-wrap gap-1">
                                  {ci.contracts.map((ct) => (
                                    <span key={ct.id} className="inline-block rounded bg-blue-50 border border-blue-200 px-1.5 py-0.5 text-[10px] font-medium text-blue-700" title={`Proveedor: ${ct.vendor?.name ?? '—'}`}>
                                      {ct.contractNumber}
                                    </span>
                                  ))}
                                </div>
                              )}
                            </td>
                            <td className="px-4 py-3">
                              <span className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium ${typeMeta.color}`}>
                                {typeMeta.icon}{ci.ciTypeName ?? (t(`inventory.ci_types.${resolvedType}`, {}) || typeMeta.label)}
                              </span>
                            </td>
                            <td className="px-4 py-3"><EnvironmentBadge env={ci.environment} /></td>
                            <td className="px-4 py-3"><CriticalityBadge level={ci.criticality} /></td>
                            <td className="px-4 py-3"><VulnBadge vulns={ci.vulnerabilities} /></td>
                            <td className="px-4 py-3"><AgentBadge agent={ci.agentStatus} /></td>
                            <td className="px-4 py-3">
                              {ci.technicalLead ? (
                                <div>
                                  <p className="font-medium text-slate-700">{ci.technicalLead.username}</p>
                                  <p className="text-xs text-slate-400">{ci.technicalLead.email}</p>
                                </div>
                              ) : <span className="text-xs italic text-slate-400">Sin asignar</span>}
                            </td>
                            {isAdmin && (
                              <td className="px-4 py-3">
                                <div className="flex items-center gap-2">
                                  <button
                                    onClick={() => setRelatingCI(ci)}
                                    className="rounded-none p-2 text-violet-600 hover:bg-violet-50 transition-colors"
                                    title="Crear relación"
                                  >
                                    <Link2 className="h-4 w-4" />
                                  </button>
                                  <button
                                    onClick={() => setEditingCI(ci)}
                                    className="rounded-none p-2 text-[var(--accent)] hover:bg-[var(--accent)]/10 transition-colors"
                                    title="Editar CI"
                                  >
                                    <Pencil className="h-4 w-4" />
                                  </button>
                                  <button
                                    onClick={() => handleDelete(ci.id, ci.name)}
                                    disabled={deletingCI === ci.id}
                                    className="rounded-none p-2 text-red-600 hover:bg-red-50 transition-colors disabled:opacity-50"
                                    title="Eliminar CI"
                                  >
                                    <Trash2 className="h-4 w-4" />
                                  </button>
                                </div>
                              </td>
                            )}
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            )}

            {!loading && !error && (
              <div className="border-t border-slate-100 px-6 py-3 flex items-center justify-between text-xs text-slate-400">
                <span>Mostrando <strong className="text-slate-600">{filtered.length}</strong> de <strong className="text-slate-600">{cis.length}</strong> activos</span>
                {activeFilterCount > 0 && (
                  <button onClick={clearFilters} className="flex items-center gap-1 text-red-500 hover:text-red-700 transition-colors">
                    <FilterX className="h-3 w-3" />Limpiar filtros
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

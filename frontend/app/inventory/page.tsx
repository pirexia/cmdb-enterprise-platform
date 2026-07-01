"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useSearchParams, useRouter } from "next/navigation";
import { useLanguage } from "@/contexts/LanguageContext";
import { Layers } from "lucide-react";
import {
  Search, RefreshCw, AlertTriangle, Plus, Download,
  Shield, ShieldAlert, ShieldCheck, ShieldOff,
  ChevronUp, ChevronDown, ChevronsUpDown, FilterX,
  Server, Box, Database, Network, HardDrive, Archive, Package, Cpu,
  Monitor, Laptop, Printer, ScanLine, Tv, Video, Cast, Clock,
  Phone, Smartphone, Tablet, QrCode, Camera, BatteryCharging,
  Key, Cloud, Terminal, Pencil, Trash2, Link2, X,
} from "lucide-react";
import AddCIModal from "@/components/AddCIModal";
import EditCIModal from "@/components/EditCIModal";
import AddRelationModal from "@/components/AddRelationModal";
import CIDetailModal from "@/components/CIDetailModal";
import BulkUpdateCIModal from "@/components/BulkUpdateCIModal";
import { useAuth } from "@/contexts/AuthContext";
import { apiFetch, fetchAllCIs } from "@/lib/apiFetch";
import { exportToCSV } from "@/lib/csvExport";
import { usePageSize } from "@/hooks/usePageSize";
import PageSizeSelector from "@/components/PageSizeSelector";
import PaginationControls from "@/components/PaginationControls";
import ColumnPicker from "@/app/reports/components/ColumnPicker";

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
  eolEffective:    string | null;
  eosEffective:    string | null;
  eolSource:       'ci' | 'model' | null;
  eosSource:       'ci' | 'model' | null;
  ciModelName:     string | null;
  status:          string | null;
  inventoryNumber: string | null;
  businessOwnerId: string | null;
  technicalLeadId: string | null;
  branchId:        string | null;
  ciModelId:       string | null;
  technicalLead:   User | null;
  hardware:        { serialNumber: string; model: string; manufacturer: string; sizeU?: number | null; powerW?: number | null; uPosition?: number | null; orientation?: string | null } | null;
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
  // v3.4.3 — extra fields surfaced by /api/cis (CI_INCLUDE) for the column picker
  businessOwner?:     User | null;
  location?:          { id: string; name: string } | null;
  costCenter?:        { id: string; name: string } | null;
  branch?:            { id: string; name: string } | null;
  operatingSystem?:   { id: string; name: string; version: string | null } | null;
  ciModel?:           { id: string; name: string; manufacturer: { id: string; name: string } | null } | null;
  manufacturerName?:  string | null;
  parentCI?:          { id: string; name: string } | null;
  assignedUser?:      string | null;
  userDni?:           string | null;
  floor?:             string | null;
  room?:              string | null;
  rack?:              string | null;
  rackUnit?:          string | null;
  cpuModel?:          string | null;
  vCpus?:             number | null;
  ram?:               string | null;
  disk?:              string | null;
  firmwareVersion?:   string | null;
  clusterName?:       string | null;
  hostName?:          string | null;
  adminIp?:           string | null;
  mgmtIp?:            string | null;
  consoleIp?:         string | null;
  dns?:               string | null;
  vlan?:              string | null;
  verificationSource?: string | null;
  lastCheckDate?:     string | null;
  createdAt?:         string | null;
  updatedAt?:         string | null;
  lifecycleDates?:    { dateValue: string; dateType: { code: string } }[] | null;
}

// ─── Support status badge ─────────────────────────────────────────────────────

function SupportBadge({
  eolDate, eosDate,
  eolEffective, eosEffective,
  eolSource, eosSource,
}: {
  eolDate: string | null; eosDate: string | null;
  eolEffective?: string | null; eosEffective?: string | null;
  eolSource?: 'ci' | 'model' | null; eosSource?: 'ci' | 'model' | null;
}) {
  const { t } = useLanguage();
  const now = Date.now();
  const sixMonths = 180 * 86_400_000;
  const effEol = eolEffective ?? eolDate;
  const effEos = eosEffective ?? eosDate;
  const dates = [effEol, effEos].filter(Boolean).map((d) => new Date(d!).getTime());
  if (dates.length === 0) return null;

  const nearest  = Math.min(...dates);
  const daysLeft = Math.floor((nearest - now) / 86_400_000);
  const fromModel = (effEol && eolSource === 'model') || (effEos && eosSource === 'model');

  const statusBadge = nearest < now
    ? <span className="inline-block rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-semibold text-red-700">{t('inventory.support_badge.expired')}</span>
    : nearest - now < sixMonths
      ? <span className="inline-block rounded-full bg-orange-100 px-2 py-0.5 text-[10px] font-semibold text-orange-700">{t('inventory.support_badge.warning', { days: String(daysLeft) })}</span>
      : <span className="inline-block rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">{t('inventory.support_badge.ok')}</span>;

  return (
    <>
      {statusBadge}
      {fromModel && (
        <span className="inline-block rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-500 ml-1">
          {t('inventory.eol_from_model')}
        </span>
      )}
    </>
  );
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

// ─── CI Status badge ──────────────────────────────────────────────────────────

function CIStatusBadge({ status, t }: { status: string; t: (k: string) => string }) {
  const cfg: Record<string, string> = {
    ACTIVO:   "bg-emerald-100 text-emerald-700",
    INACTIVO: "bg-amber-100 text-amber-700",
    RETIRADO: "bg-slate-100 text-slate-500",
  };
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${cfg[status] ?? "bg-slate-100 text-slate-500"}`}>
      {t(`inventory.status.${status}`) ?? status}
    </span>
  );
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

function invUserId(): string {
  try { const u = JSON.parse(localStorage.getItem("cmdb_user") ?? "{}"); return u.id ?? u.email ?? "anon"; } catch { return "anon"; }
}

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

  // Bulk-update / bulk-delete selection state (admin only)
  const [selectedIds, setSelectedIds]               = useState<Set<string>>(new Set());
  const [selectAllFiltered, setSelectAllFiltered]   = useState(false);
  const [showSelectDropdown, setShowSelectDropdown] = useState(false);
  const [dropdownPos, setDropdownPos]               = useState<{ top: number; left: number } | null>(null);
  const selectBtnRef                                = useRef<HTMLButtonElement>(null);
  const selectMenuRef                               = useRef<HTMLDivElement>(null);
  const [showBulkUpdate, setShowBulkUpdate]         = useState(false);
  const [showBulkDelete, setShowBulkDelete]         = useState(false);
  const [bulkDeleteLoading, setBulkDeleteLoading]   = useState(false);
  const [bulkDeleteError, setBulkDeleteError]       = useState<string | null>(null);

  type SortCol = "name" | "ciType" | "environment" | "criticality" | "status" | null;
  type SortDir = "asc" | "desc";
  interface InvCol {
    key: string;
    labelKey: string;
    group: string;
    defaultVisible?: boolean;
    sortCol?: SortCol;
    headerExtra?: React.ReactNode;
    filterCell?: React.ReactNode;
    cell: (ci: CI) => React.ReactNode;
  }
  const [sort, setSort] = useState<{ col: SortCol; dir: SortDir }>({ col: null, dir: "asc" });
  const [filters, setFilters] = useState({ name: "", ciType: "", environment: "", criticality: "", status: "", vulns: "", agent: "" });
  const { pageSize, setPageSize } = usePageSize();
  const [page, setPage] = useState(1);

  const activeFilterCount = Object.values(filters).filter(Boolean).length;

  const toggleSort = (col: SortCol) =>
    setSort((prev) => prev.col !== col ? { col, dir: "asc" } : prev.dir === "asc" ? { col, dir: "desc" } : { col: null, dir: "asc" });

  const setFilter = (key: keyof typeof filters, val: string) =>
    setFilters((prev) => ({ ...prev, [key]: val }));

  const clearFilters = () => { setFilters({ name: "", ciType: "", environment: "", criticality: "", status: "", vulns: "", agent: "" }); setSort({ col: null, dir: "asc" }); };

  useEffect(() => { setPage(1); }, [filters, sort]);

  // Selection helpers (bulk-update flow)
  const toggleSelect = (id: string) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  const clearSelection = () => { setSelectedIds(new Set()); setSelectAllFiltered(false); };

  useEffect(() => { setSelectAllFiltered(false); }, [filters, sort]);

  useEffect(() => {
    if (!showSelectDropdown) return;
    const handler = (e: MouseEvent) => {
      const t = e.target as Node;
      if (selectBtnRef.current?.contains(t) || selectMenuRef.current?.contains(t)) return;
      setShowSelectDropdown(false);
    };
    const close = () => setShowSelectDropdown(false);
    document.addEventListener('mousedown', handler);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('mousedown', handler);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [showSelectDropdown]);

  // Two-step delete: 1st call without force, server returns 409 + brokenRefs if
  // active associations exist; we ask the user once more, then re-send with force.
  const [bulkDeleteBrokenRefs, setBulkDeleteBrokenRefs] = useState<{ contracts: number; licenses: number; documents: number } | null>(null);

  const handleBulkDelete = async (force = false) => {
    setBulkDeleteLoading(true); setBulkDeleteError(null);
    if (!force) setBulkDeleteBrokenRefs(null);
    try {
      const res = await apiFetch("/api/cis/bulk-delete", {
        method: "POST",
        body: JSON.stringify({ ciIds: Array.from(selectedIds), force }),
      });
      const body = await res.json().catch(() => ({})) as {
        deleted?: number;
        error?: string;
        brokenRefs?: { contracts: number; licenses: number; documents: number };
      };
      if (res.status === 409 && body.brokenRefs) {
        setBulkDeleteBrokenRefs(body.brokenRefs);
        return; // surface the confirmation step — user must opt in with force=true
      }
      if (!res.ok) throw new Error(body.error ?? `Error ${res.status}`);
      setShowBulkDelete(false);
      setBulkDeleteBrokenRefs(null);
      clearSelection();
      fetchCIs();
    } catch (e) {
      setBulkDeleteError(e instanceof Error ? e.message : t('inventory.bulk_update.error'));
    } finally {
      setBulkDeleteLoading(false);
    }
  };

  const fetchCIs = async () => {
    setLoading(true); setError(null);
    try {
      const data = await fetchAllCIs<CI>();
      setCis(data);
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

  // Dashboard deep-link: ?type=hardware|software pre-filters the CI type column.
  useEffect(() => {
    const type = searchParams.get("type");
    if (!type) return;
    const mapped = type === "hardware" ? "HARDWARE" : type === "software" ? "SOFTWARE" : null;
    if (mapped) {
      setFilter("ciType", mapped);
      router.replace("/inventory", { scroll: false });
    }
  }, [searchParams, router]);

  const filtered = useMemo(() => {
    const CRIT_ORDER: Record<string, number> = { LOW: 1, MEDIUM: 2, HIGH: 3, MISSION_CRITICAL: 4 };
    let result = cis.filter((ci) => {
      const resolvedType = ci.ciType || (ci.hardware ? "HARDWARE" : ci.software ? "SOFTWARE" : "OTHER");
      const openVulns = (ci.vulnerabilities ?? []).filter((v) => v.status !== "RESUELTO");
      if (filters.name && !ci.name.toLowerCase().includes(filters.name.toLowerCase())) return false;
      if (filters.ciType && resolvedType !== filters.ciType) return false;
      if (filters.environment && ci.environment !== filters.environment) return false;
      if (filters.criticality && ci.criticality !== filters.criticality) return false;
      if (filters.status && (ci.status ?? "ACTIVO") !== filters.status) return false;
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
        if (sort.col === "status")      return dir * (a.status ?? "ACTIVO").localeCompare(b.status ?? "ACTIVO");
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

  const totalPages  = Math.max(1, Math.ceil(filtered.length / pageSize));
  const displayed   = filtered.slice((page - 1) * pageSize, page * pageSize);

  // ─── v3.4.3 — configurable columns ──────────────────────────────────────────
  const filterSelectCls = (active: string) =>
    `w-full rounded-none border py-1.5 px-2 text-xs focus:border-[var(--accent)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]/20 ${active ? "border-[var(--accent)] bg-[var(--accent)]/5 text-[var(--accent)] font-medium" : "border-slate-200 bg-white text-slate-600"}`;

  const ALL_COLS: InvCol[] = useMemo(() => {
    const lifeDate = (ci: CI, code: string) => {
      const d = (ci.lifecycleDates ?? []).find((x) => x.dateType?.code === code);
      return d ? String(d.dateValue).slice(0, 10) : "";
    };
    const txt = (v: unknown): React.ReactNode =>
      v === null || v === undefined || v === "" ? <span className="text-slate-300">—</span> : <span className="text-slate-600">{String(v)}</span>;
    const dateCell = (v: unknown): React.ReactNode =>
      v ? <span className="text-slate-600">{String(v).slice(0, 10)}</span> : <span className="text-slate-300">—</span>;
    const yesno = (v: boolean): React.ReactNode =>
      <span className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold ${v ? "bg-rose-100 text-rose-700" : "bg-emerald-50 text-emerald-700"}`}>{v ? t("common.yes") : t("common.no")}</span>;

    return [
      // general
      { key: "support",     labelKey: "inventory.columns.support",     group: "general", defaultVisible: true,
        cell: (ci) => <SupportBadge eolDate={ci.eolDate} eosDate={ci.eosDate} eolEffective={ci.eolEffective} eosEffective={ci.eosEffective} eolSource={ci.eolSource} eosSource={ci.eosSource} /> },
      { key: "ciType",      labelKey: "inventory.columns.type",        group: "general", defaultVisible: true, sortCol: "ciType",
        filterCell: <select value={filters.ciType} onChange={(e) => setFilter("ciType", e.target.value)} className={filterSelectCls(filters.ciType)}><option value="">{t("inventory.filter_type_all") || "Todos los tipos"}</option>{ciTypeCategories.map((cat) => <optgroup key={cat.code} label={cat.name}>{cat.ciTypes.map((ty) => <option key={ty.code} value={ty.code}>{CI_TYPE_META[ty.code]?.label ?? ty.name}</option>)}</optgroup>)}</select>,
        cell: (ci) => { const rt = ci.ciType || (ci.hardware ? "HARDWARE" : ci.software ? "SOFTWARE" : "OTHER"); const tm = CI_TYPE_META[rt] ?? CI_TYPE_META["OTHER"]; return <span className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium ${tm.color}`}>{tm.icon}{ci.ciTypeName ?? (t(`inventory.ci_types.${rt}`, {}) || tm.label)}</span>; } },
      { key: "environment", labelKey: "inventory.columns.environment", group: "general", defaultVisible: true, sortCol: "environment",
        filterCell: <select value={filters.environment} onChange={(e) => setFilter("environment", e.target.value)} className={filterSelectCls(filters.environment)}><option value="">Todos</option><option value="PRODUCTION">Production</option><option value="STAGING">Staging</option><option value="TESTING">Testing</option><option value="DEVELOPMENT">Development</option></select>,
        cell: (ci) => <EnvironmentBadge env={ci.environment} /> },
      { key: "criticality", labelKey: "inventory.columns.criticality", group: "general", defaultVisible: true, sortCol: "criticality",
        filterCell: <select value={filters.criticality} onChange={(e) => setFilter("criticality", e.target.value)} className={filterSelectCls(filters.criticality)}><option value="">Todas</option><option value="MISSION_CRITICAL">Mission Critical</option><option value="HIGH">High</option><option value="MEDIUM">Medium</option><option value="LOW">Low</option></select>,
        cell: (ci) => <CriticalityBadge level={ci.criticality} /> },
      { key: "status",      labelKey: "inventory.columns.status",      group: "general", defaultVisible: true, sortCol: "status",
        filterCell: <select value={filters.status} onChange={(e) => setFilter("status", e.target.value)} className={filterSelectCls(filters.status)}><option value="">{t("inventory.filter_status_all")}</option><option value="ACTIVO">{t("inventory.status.ACTIVO")}</option><option value="INACTIVO">{t("inventory.status.INACTIVO")}</option><option value="RETIRADO">{t("inventory.status.RETIRADO")}</option></select>,
        cell: (ci) => <CIStatusBadge status={ci.status ?? "ACTIVO"} t={t} /> },
      { key: "vulns",       labelKey: "inventory.columns.greenbone",    group: "general", defaultVisible: true, headerExtra: <ShieldAlert className="h-3.5 w-3.5" />,
        filterCell: <select value={filters.vulns} onChange={(e) => setFilter("vulns", e.target.value)} className={filterSelectCls(filters.vulns)}><option value="">Todos</option><option value="no_data">Sin datos escáner</option><option value="clean">Sin vulns abiertas</option><option value="with_vulns">Con vulns abiertas</option><option value="critical">Con CRITICAL</option><option value="high">Con HIGH</option></select>,
        cell: (ci) => <VulnBadge vulns={ci.vulnerabilities} /> },
      { key: "agent",       labelKey: "inventory.columns.crowdstrike",  group: "general", defaultVisible: true, headerExtra: <Shield className="h-3.5 w-3.5" />,
        filterCell: <select value={filters.agent} onChange={(e) => setFilter("agent", e.target.value)} className={filterSelectCls(filters.agent)}><option value="">Todos</option><option value="no_agent">Sin agente</option><option value="protected">Protegido (activo)</option><option value="reduced">Funcionalidad reducida</option><option value="detections">Con detecciones</option></select>,
        cell: (ci) => <AgentBadge agent={ci.agentStatus} /> },
      { key: "technicalLead", labelKey: "inventory.columns.technical_lead", group: "governance", defaultVisible: true,
        cell: (ci) => ci.technicalLead ? <div><p className="font-medium text-slate-700">{ci.technicalLead.username}</p><p className="text-xs text-slate-400">{ci.technicalLead.email}</p></div> : <span className="text-xs italic text-slate-400">{t("inventory.unassigned") || "Sin asignar"}</span> },
      { key: "inventoryNumber",   labelKey: "reports.col.inventoryNumber",   group: "general",  cell: (ci) => txt(ci.inventoryNumber) },
      { key: "apiSlug",           labelKey: "reports.col.apiSlug",           group: "general",  cell: (ci) => txt(ci.apiSlug) },
      { key: "verificationSource",labelKey: "reports.col.verificationSource",group: "general",  cell: (ci) => txt(ci.verificationSource) },
      { key: "lastCheckDate",     labelKey: "reports.col.lastCheckDate",     group: "general",  cell: (ci) => dateCell(ci.lastCheckDate) },
      { key: "createdAt",         labelKey: "reports.col.createdAt",         group: "general",  cell: (ci) => dateCell(ci.createdAt) },
      { key: "updatedAt",         labelKey: "reports.col.updatedAt",         group: "general",  cell: (ci) => dateCell(ci.updatedAt) },
      // location
      { key: "location",   labelKey: "reports.col.location",   group: "location", cell: (ci) => txt(ci.location?.name) },
      { key: "branch",     labelKey: "reports.col.branch",     group: "location", cell: (ci) => txt(ci.branch?.name) },
      { key: "costCenter", labelKey: "reports.col.costCenter", group: "location", cell: (ci) => txt(ci.costCenter?.name) },
      { key: "floor",      labelKey: "reports.col.floor",      group: "location", cell: (ci) => txt(ci.floor) },
      { key: "room",       labelKey: "reports.col.room",       group: "location", cell: (ci) => txt(ci.room) },
      { key: "rack",       labelKey: "reports.col.rack",       group: "location", cell: (ci) => txt(ci.rack) },
      { key: "rackUnit",   labelKey: "reports.col.rackUnit",   group: "location", cell: (ci) => txt(ci.rackUnit) },
      { key: "assignedUser", labelKey: "reports.col.assignedUser", group: "location", cell: (ci) => txt(ci.assignedUser) },
      { key: "userDni",    labelKey: "reports.col.userDni",    group: "location", cell: (ci) => txt(ci.userDni) },
      // network
      { key: "adminIp",   labelKey: "reports.col.adminIp",   group: "network", cell: (ci) => txt(ci.adminIp) },
      { key: "mgmtIp",    labelKey: "reports.col.mgmtIp",    group: "network", cell: (ci) => txt(ci.mgmtIp) },
      { key: "consoleIp", labelKey: "reports.col.consoleIp", group: "network", cell: (ci) => txt(ci.consoleIp) },
      { key: "dns",       labelKey: "reports.col.dns",       group: "network", cell: (ci) => txt(ci.dns) },
      { key: "vlan",      labelKey: "reports.col.vlan",      group: "network", cell: (ci) => txt(ci.vlan) },
      { key: "hostName",  labelKey: "reports.col.hostName",  group: "network", cell: (ci) => txt(ci.hostName) },
      // hardware
      { key: "cpuModel",        labelKey: "reports.col.cpuModel",        group: "hardware", cell: (ci) => txt(ci.cpuModel) },
      { key: "vCpus",           labelKey: "reports.col.vCpus",           group: "hardware", cell: (ci) => txt(ci.vCpus) },
      { key: "ram",             labelKey: "reports.col.ram",             group: "hardware", cell: (ci) => txt(ci.ram) },
      { key: "disk",            labelKey: "reports.col.disk",            group: "hardware", cell: (ci) => txt(ci.disk) },
      { key: "firmwareVersion", labelKey: "reports.col.firmwareVersion", group: "hardware", cell: (ci) => txt(ci.firmwareVersion) },
      { key: "clusterName",     labelKey: "reports.col.clusterName",     group: "hardware", cell: (ci) => txt(ci.clusterName) },
      { key: "ciModel",         labelKey: "reports.col.ciModel",         group: "hardware", cell: (ci) => txt(ci.ciModelName ?? ci.ciModel?.name) },
      { key: "manufacturer",    labelKey: "reports.col.manufacturer",    group: "hardware", cell: (ci) => txt(ci.manufacturerName ?? ci.ciModel?.manufacturer?.name) },
      { key: "operatingSystem", labelKey: "reports.col.operatingSystem", group: "hardware", cell: (ci) => txt(ci.operatingSystem?.name) },
      { key: "hwSerialNumber",  labelKey: "reports.col.hwSerialNumber",  group: "hardware", cell: (ci) => txt(ci.hardware?.serialNumber) },
      { key: "hwModel",         labelKey: "reports.col.hwModel",         group: "hardware", cell: (ci) => txt(ci.hardware?.model) },
      { key: "hwManufacturer",  labelKey: "reports.col.hwManufacturer",  group: "hardware", cell: (ci) => txt(ci.hardware?.manufacturer) },
      { key: "sizeU",           labelKey: "reports.col.sizeU",           group: "hardware", cell: (ci) => txt(ci.hardware?.sizeU) },
      { key: "powerW",          labelKey: "reports.col.powerW",          group: "hardware", cell: (ci) => txt(ci.hardware?.powerW) },
      // software
      { key: "swVersion",     labelKey: "reports.col.swVersion",     group: "software", cell: (ci) => txt(ci.software?.version) },
      { key: "swLicenseType", labelKey: "reports.col.swLicenseType", group: "software", cell: (ci) => txt(ci.software?.licenseType) },
      // governance
      { key: "businessOwner",      labelKey: "reports.col.businessOwner",      group: "governance", cell: (ci) => txt(ci.businessOwner?.username ?? ci.businessOwner?.email) },
      { key: "parentCI",           labelKey: "reports.col.parentCI",           group: "governance", cell: (ci) => txt(ci.parentCI?.name) },
      { key: "businessImpact",     labelKey: "reports.col.businessImpact",     group: "governance", cell: (ci) => txt(ci.businessImpact) },
      { key: "dataClassification", labelKey: "reports.col.dataClassification", group: "governance", cell: (ci) => txt(ci.dataClassification) },
      { key: "recoveryPriority",   labelKey: "reports.col.recoveryPriority",   group: "governance", cell: (ci) => txt(ci.recoveryPriority) },
      { key: "rto",                labelKey: "reports.col.rto",                group: "governance", cell: (ci) => txt(ci.rto) },
      { key: "rpo",                labelKey: "reports.col.rpo",                group: "governance", cell: (ci) => txt(ci.rpo) },
      { key: "spofRisk",           labelKey: "reports.col.spofRisk",           group: "governance", cell: (ci) => yesno(ci.spofRisk) },
      { key: "containsPii",        labelKey: "reports.col.containsPii",        group: "governance", cell: (ci) => yesno(ci.containsPii) },
      // lifecycle
      { key: "eolDate",          labelKey: "reports.col.eolDate",          group: "lifecycle", cell: (ci) => dateCell(ci.eolEffective ?? ci.eolDate) },
      { key: "eosDate",          labelKey: "reports.col.eosDate",          group: "lifecycle", cell: (ci) => dateCell(ci.eosEffective ?? ci.eosDate) },
      { key: "purchaseDate",     labelKey: "reports.col.purchaseDate",     group: "lifecycle", cell: (ci) => dateCell(lifeDate(ci, "purchase-date")) },
      { key: "warrantyEndDate",  labelKey: "reports.col.warrantyEndDate",  group: "lifecycle", cell: (ci) => dateCell(lifeDate(ci, "hw-end-of-warranty")) },
      { key: "deploymentDate",   labelKey: "reports.col.deploymentDate",   group: "lifecycle", cell: (ci) => dateCell(lifeDate(ci, "deployment-date")) },
      { key: "decommissionDate", labelKey: "reports.col.decommissionDate", group: "lifecycle", cell: (ci) => dateCell(lifeDate(ci, "decommission-date")) },
      { key: "reviewDate",       labelKey: "reports.col.reviewDate",       group: "lifecycle", cell: (ci) => dateCell(lifeDate(ci, "review-date")) },
    ];
  }, [t, filters, ciTypeCategories]);

  const DEFAULT_COL_KEYS = useMemo(() => ALL_COLS.filter((c) => c.defaultVisible).map((c) => c.key), [ALL_COLS]);
  const colByKey = useMemo(() => Object.fromEntries(ALL_COLS.map((c) => [c.key, c])), [ALL_COLS]);
  const [visibleKeys, setVisibleKeys] = useState<string[]>([]);
  const colsLsKey = `inventory_columns_${typeof window !== "undefined" ? invUserId() : "anon"}`;

  useEffect(() => {
    if (ALL_COLS.length === 0) return;
    let initial = DEFAULT_COL_KEYS;
    try {
      const saved = JSON.parse(localStorage.getItem(colsLsKey) ?? "null");
      if (Array.isArray(saved) && saved.length) {
        const valid = saved.filter((k: string) => colByKey[k]);
        if (valid.length) initial = valid;
      }
    } catch { /* ignore */ }
    setVisibleKeys((prev) => (prev.length ? prev : initial));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [DEFAULT_COL_KEYS]);

  const handleColumnsChange = (keys: string[]) => {
    setVisibleKeys(keys);
    try { localStorage.setItem(colsLsKey, JSON.stringify(keys)); } catch { /* ignore */ }
  };
  const visibleCols = visibleKeys.map((k) => colByKey[k]).filter(Boolean) as InvCol[];

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

  return (
    <>
      {showModal && <AddCIModal onClose={() => setShowModal(false)} onCreated={fetchCIs} />}
      {editingCI && <EditCIModal ci={editingCI} onClose={() => setEditingCI(null)} onUpdated={fetchCIs} />}
      {showBulkUpdate && (
        <BulkUpdateCIModal
          ciIds={Array.from(selectedIds)}
          onClose={() => setShowBulkUpdate(false)}
          onUpdated={() => { setShowBulkUpdate(false); clearSelection(); fetchCIs(); }}
        />
      )}
      {showBulkDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => { if (!bulkDeleteLoading) { setShowBulkDelete(false); setBulkDeleteBrokenRefs(null); } }}>
          <div className="w-full max-w-md rounded-none bg-white shadow-xl ring-1 ring-slate-200" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
              <h2 className="text-base font-bold text-slate-800 flex items-center gap-2">
                <AlertTriangle className="h-5 w-5 text-red-600" />
                {t('inventory.bulk_delete.title')}
              </h2>
              <button onClick={() => { setShowBulkDelete(false); setBulkDeleteBrokenRefs(null); }} disabled={bulkDeleteLoading}
                      className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-colors disabled:opacity-50">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="px-5 py-4">
              {!bulkDeleteBrokenRefs ? (
                <>
                  <p className="text-sm text-slate-700 mb-2">
                    {t('inventory.bulk_delete.confirm', { count: String(selectedIds.size) })}
                  </p>
                  <p className="text-xs text-slate-500 mb-3">{t('inventory.bulk_delete.warning')}</p>
                </>
              ) : (
                <>
                  <p className="text-sm font-semibold text-amber-800 mb-2 flex items-center gap-2">
                    <AlertTriangle className="h-4 w-4" />
                    {t('inventory.bulk_delete.has_refs_title')}
                  </p>
                  <ul className="text-xs text-slate-700 mb-3 ml-6 list-disc space-y-0.5">
                    {bulkDeleteBrokenRefs.contracts > 0 && <li>{t('inventory.bulk_delete.refs_contracts', { count: String(bulkDeleteBrokenRefs.contracts) })}</li>}
                    {bulkDeleteBrokenRefs.licenses > 0 && <li>{t('inventory.bulk_delete.refs_licenses', { count: String(bulkDeleteBrokenRefs.licenses) })}</li>}
                    {bulkDeleteBrokenRefs.documents > 0 && <li>{t('inventory.bulk_delete.refs_documents', { count: String(bulkDeleteBrokenRefs.documents) })}</li>}
                  </ul>
                  <p className="text-xs text-slate-600 mb-3">{t('inventory.bulk_delete.has_refs_warning')}</p>
                </>
              )}
              {bulkDeleteError && (
                <div className="flex items-start gap-2 rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                  <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
                  <span>{bulkDeleteError}</span>
                </div>
              )}
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-slate-200 px-5 py-3 bg-slate-50">
              <button onClick={() => { setShowBulkDelete(false); setBulkDeleteBrokenRefs(null); }} disabled={bulkDeleteLoading}
                      className="rounded-none border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 transition-colors disabled:opacity-50">
                {t('actions.cancel')}
              </button>
              <button onClick={() => handleBulkDelete(!!bulkDeleteBrokenRefs)} disabled={bulkDeleteLoading}
                      className="flex items-center gap-1.5 rounded-none bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-50 transition-colors">
                {bulkDeleteLoading ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                {bulkDeleteBrokenRefs ? t('inventory.bulk_delete.force_button') : t('inventory.bulk_delete.confirm_button')}
              </button>
            </div>
          </div>
        </div>
      )}
      {detailCI && (
        <CIDetailModal
          ci={detailCI}
          onClose={() => setDetailCI(null)}
          onEdit={() => { setEditingCI(detailCI); setDetailCI(null); }}
          onDelete={() => { handleDelete(detailCI.id, detailCI.name); setDetailCI(null); }}
          onUpdated={() => { fetchCIs(); setDetailCI(null); }}
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
                <button onClick={() => router.push('/inventory/bulk')}
                  className="flex items-center gap-1.5 rounded-none border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50 transition-colors">
                  <Layers className="h-3.5 w-3.5" />{t('inventory.bulk.button')}
                </button>
                <button onClick={() => router.push('/inventory/bulk?tab=list')}
                  className="flex items-center gap-1.5 rounded-none border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50 transition-colors">
                  <Layers className="h-3.5 w-3.5" />{t('inventory.my_imports')}
                </button>
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
                {isAdmin && selectedIds.size > 0 && (
                  <>
                    <span className={`text-xs font-medium ${selectAllFiltered ? 'text-[var(--accent)]' : 'text-slate-500'}`}>
                      {selectAllFiltered
                        ? t('inventory.bulk.all_filtered_banner').replace('{count}', String(selectedIds.size))
                        : t('inventory.bulk_update.selected_count', { count: String(selectedIds.size) })}
                    </span>
                    <button
                      onClick={() => setShowBulkUpdate(true)}
                      className="flex items-center gap-1.5 rounded-none bg-[var(--accent)] px-3 py-2 text-xs font-semibold text-white hover:bg-[var(--accent)]/90 transition-colors"
                    >
                      <Pencil className="h-3.5 w-3.5" />{t('inventory.bulk_update.button')}
                    </button>
                    <button
                      onClick={() => { setBulkDeleteError(null); setShowBulkDelete(true); }}
                      className="flex items-center gap-1.5 rounded-none border border-red-300 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700 hover:bg-red-100 transition-colors"
                    >
                      <Trash2 className="h-3.5 w-3.5" />{t('inventory.bulk_delete.button')}
                    </button>
                    <button
                      onClick={clearSelection}
                      className="flex items-center gap-1.5 rounded-none border border-slate-300 bg-white px-2 py-2 text-xs font-medium text-slate-500 hover:bg-slate-50 transition-colors"
                      title={t('inventory.bulk_update.clear_selection')}
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </>
                )}
                {activeFilterCount > 0 && (
                  <button onClick={clearFilters} className="flex items-center gap-1.5 rounded-none border border-red-200 bg-red-50 px-3 py-2 text-xs font-medium text-red-600 hover:bg-red-100 transition-colors">
                    <FilterX className="h-3.5 w-3.5" />Limpiar filtros
                  </button>
                )}
                {visibleKeys.length > 0 && (
                  <ColumnPicker
                    allColumns={ALL_COLS}
                    visible={visibleKeys}
                    defaultKeys={DEFAULT_COL_KEYS}
                    onChange={handleColumnsChange}
                  />
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
              <div className="overflow-auto max-h-[calc(100vh-16rem)]">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 z-20 bg-slate-50">
                    {/* ── Sort row ── */}
                    <tr className="border-b border-slate-100 bg-slate-50 text-left">
                      {/* Bulk-select checkbox column (admin only) */}
                      {isAdmin && (
                        <th className="px-3 py-3 whitespace-nowrap w-10">
                          <div className="flex items-center gap-0.5">
                            <input
                              type="checkbox"
                              aria-label={t('inventory.bulk_update.select_all')}
                              checked={displayed.length > 0 && displayed.every((c) => selectedIds.has(c.id))}
                              ref={(el) => {
                                if (el) {
                                  const someSelected = displayed.some((c) => selectedIds.has(c.id));
                                  const allSelected  = displayed.length > 0 && displayed.every((c) => selectedIds.has(c.id));
                                  el.indeterminate = someSelected && !allSelected;
                                }
                              }}
                              onChange={(e) => {
                                if (e.target.checked) {
                                  setSelectedIds((prev) => new Set([...prev, ...displayed.map((c) => c.id)]));
                                  setSelectAllFiltered(false);
                                } else {
                                  setSelectAllFiltered(false);
                                  setSelectedIds((prev) => { const next = new Set(prev); displayed.forEach((c) => next.delete(c.id)); return next; });
                                }
                              }}
                              className="h-4 w-4 cursor-pointer accent-[var(--accent)]"
                            />
                            <button
                              ref={selectBtnRef}
                              onClick={() => {
                                if (!showSelectDropdown && selectBtnRef.current) {
                                  const r = selectBtnRef.current.getBoundingClientRect();
                                  setDropdownPos({ top: r.bottom + 4, left: r.left });
                                }
                                setShowSelectDropdown((v) => !v);
                              }}
                              className="p-0.5 text-slate-400 hover:text-[var(--accent)] transition-colors"
                              aria-label={t('inventory.bulk.dropdown_label')}
                            >
                              <ChevronDown className="h-3 w-3" />
                            </button>
                          </div>
                        </th>
                      )}
                      {/* Name */}
                      <th className="px-4 py-3 whitespace-nowrap">
                        <button onClick={() => toggleSort("name")} className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wider text-slate-500 hover:text-[var(--accent)] transition-colors">
                          {t('common.name')}
                          {sort.col === "name" ? (sort.dir === "asc" ? <ChevronUp className="h-3.5 w-3.5 text-[var(--accent)]" /> : <ChevronDown className="h-3.5 w-3.5 text-[var(--accent)]" />) : <ChevronsUpDown className="h-3.5 w-3.5 opacity-30" />}
                        </button>
                      </th>
                      {/* Configurable columns */}
                      {visibleCols.map((col) => (
                        <th key={col.key} className="px-4 py-3 whitespace-nowrap">
                          {col.sortCol ? (
                            <button onClick={() => toggleSort(col.sortCol!)} className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-slate-500 hover:text-[var(--accent)] transition-colors">
                              {col.headerExtra}{t(col.labelKey)}
                              {sort.col === col.sortCol ? (sort.dir === "asc" ? <ChevronUp className="h-3.5 w-3.5 text-[var(--accent)]" /> : <ChevronDown className="h-3.5 w-3.5 text-[var(--accent)]" />) : <ChevronsUpDown className="h-3.5 w-3.5 opacity-30" />}
                            </button>
                          ) : (
                            <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-slate-500">{col.headerExtra}{t(col.labelKey)}</div>
                          )}
                        </th>
                      ))}
                      {isAdmin && <th className="px-4 py-3 whitespace-nowrap text-xs font-semibold uppercase tracking-wider text-slate-500">Acciones</th>}
                    </tr>
                    {/* ── Filter row ── */}
                    <tr className="border-b-2 border-[var(--accent)]/20 bg-slate-50">
                      {/* Bulk-select column (empty cell in filter row) */}
                      {isAdmin && <td className="px-3 py-2" />}
                      {/* Name filter */}
                      <td className="px-3 py-2">
                        <div className="relative">
                          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                          <input type="text" placeholder="Buscar nombre…" value={filters.name} onChange={(e) => setFilter("name", e.target.value)}
                            className="w-full rounded-none border border-slate-200 bg-white py-1.5 pl-7 pr-2 text-xs text-slate-700 placeholder:text-slate-300 focus:border-[var(--accent)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]/20" />
                        </div>
                      </td>
                      {/* Configurable column filters */}
                      {visibleCols.map((col) => (
                        <td key={col.key} className="px-3 py-2">{col.filterCell ?? null}</td>
                      ))}
                      {isAdmin && <td className="px-3 py-2" />}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {filtered.length === 0 ? (
                      <tr><td colSpan={visibleCols.length + 1 + (isAdmin ? 2 : 0)} className="py-12 text-center text-slate-400 text-sm">
                        {activeFilterCount > 0 ? "No hay CIs que coincidan con los filtros activos." : t('inventory.no_cis')}
                      </td></tr>
                    ) : (
                      displayed.map((ci) => {
                        const isSelected = selectedIds.has(ci.id);

                        return (
                          <tr key={ci.id} className={`group transition-colors ${isSelected ? "bg-[var(--accent)]/10" : "hover:bg-[var(--accent)]/5"}`}>
                            {isAdmin && (
                              <td className="px-3 py-3 w-10">
                                <input
                                  type="checkbox"
                                  checked={isSelected}
                                  onChange={() => toggleSelect(ci.id)}
                                  onClick={(e) => e.stopPropagation()}
                                  className="h-4 w-4 cursor-pointer accent-[var(--accent)]"
                                  aria-label={`Seleccionar ${ci.name}`}
                                />
                              </td>
                            )}
                            <td className="px-4 py-3 font-medium text-slate-800">
                              <button
                                onClick={() => setDetailCI(ci)}
                                className="text-left hover:text-[var(--accent)] transition-colors font-medium text-slate-800 group-hover:text-[var(--accent)]"
                              >{ci.name}</button>
                              <p className="text-xs text-slate-400 font-normal mt-0.5">{ci.apiSlug}</p>
                              <div className="flex flex-wrap gap-1 mt-1">
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
                            {visibleCols.map((col) => (
                              <td key={col.key} className="px-4 py-3">{col.cell(ci)}</td>
                            ))}
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
                <span>{t("pagination.showing").replace("{from}", String(filtered.length === 0 ? 0 : (page - 1) * pageSize + 1)).replace("{to}", String(Math.min(page * pageSize, filtered.length))).replace("{total}", String(filtered.length))}{cis.length !== filtered.length ? ` / ${cis.length}` : ""}</span>
                <div className="flex items-center gap-3">
                  {activeFilterCount > 0 && (
                    <button onClick={clearFilters} className="flex items-center gap-1 text-red-500 hover:text-red-700 transition-colors">
                      <FilterX className="h-3 w-3" />Limpiar filtros
                    </button>
                  )}
                  <PaginationControls page={page} totalPages={totalPages} onPrev={() => setPage(p => p - 1)} onNext={() => setPage(p => p + 1)} />
                  <PageSizeSelector value={pageSize} onChange={(s) => { setPageSize(s); setPage(1); }} />
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Bulk-select dropdown rendered in a portal to escape overflow-x-auto clipping */}
      {showSelectDropdown && dropdownPos && createPortal(
        <div
          ref={selectMenuRef}
          className="fixed z-[9999] w-56 border border-slate-200 bg-white shadow-lg rounded"
          style={{ top: dropdownPos.top, left: dropdownPos.left }}
        >
          <button
            className="w-full px-3 py-2.5 text-left text-xs text-slate-700 hover:bg-[var(--accent)]/5 transition-colors"
            onClick={() => {
              setSelectedIds(new Set(displayed.map((c) => c.id)));
              setSelectAllFiltered(false);
              setShowSelectDropdown(false);
            }}
          >
            {t('inventory.bulk.select_page').replace('{count}', String(displayed.length))}
          </button>
          <button
            className="w-full px-3 py-2.5 text-left text-xs text-slate-700 hover:bg-[var(--accent)]/5 transition-colors"
            onClick={() => {
              setSelectedIds(new Set(filtered.map((c) => c.id)));
              setSelectAllFiltered(true);
              setShowSelectDropdown(false);
            }}
          >
            {t('inventory.bulk.select_all_filtered').replace('{count}', String(filtered.length))}
          </button>
        </div>,
        document.body
      )}
    </>
  );
}

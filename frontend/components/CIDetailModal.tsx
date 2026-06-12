"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { X, Pencil, Trash2, Shield, ShieldAlert, ShieldCheck, ShieldOff, Server, Box, Database, Network, HardDrive, Archive, Package, Cpu, Monitor, Laptop, Printer, ScanLine, Tv, Video, Cast, Clock, Phone, Smartphone, Tablet, QrCode, Camera, BatteryCharging, Key, Cloud, Terminal, AlertTriangle, Calendar, Hash, Building2, User, Briefcase, Tag, Activity, Download, FileText, Plus, RefreshCw, Check, Loader2, MapPin } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { apiFetch } from "@/lib/apiFetch";
import PlaceCIModal from "@/components/dcim/PlaceCIModal";

// ─── Types (mirrors inventory/page.tsx) ───────────────────────────────────────

type Criticality  = "LOW" | "MEDIUM" | "HIGH" | "MISSION_CRITICAL";
type Environment  = "DEVELOPMENT" | "TESTING" | "STAGING" | "PRODUCTION";
type VulnSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
type VulnStatus   = "NUEVO" | "ASIGNADO" | "EN_CURSO" | "PARADO" | "RESUELTO";

interface UserRef        { id: string; username: string; email: string }
interface Vulnerability  { cve: string; severity: VulnSeverity; description: string; source?: string; status?: VulnStatus }
interface AgentStatus    { agentId: string; agentVersion: string; status: string; preventionPolicy: string; lastSeen: string; detections: unknown[]; source: string; updatedAt: string }
interface ContractRef    { id: string; contractNumber: string; endDate: string | null; vendor: { id: string; name: string } }
interface DocRef         { id: string; title: string; documentTypeName: string; documentTypeCode: string; originalName: string; versionNumber: number; uploadedBy: string; createdAt: string }

export interface CIDetail {
  id:              string;
  name:            string;
  apiSlug:         string;
  criticality:     Criticality;
  environment:     Environment;
  ciType:          string | null;
  eolDate:         string | null;
  eosDate:         string | null;
  status:          string | null;
  inventoryNumber: string | null;
  businessOwnerId: string | null;
  technicalLeadId: string | null;
  branchId:        string | null;
  ciModelId:       string | null;
  technicalLead:   UserRef | null;
  hardware:        {
    serialNumber   : string;
    model          : string;
    manufacturer   : string;
    parentRackCiId?: string | null;
    uPosition?     : number | null;
    orientation?   : string | null;
    sizeU?         : number | null;
    powerW?        : number | null;
  } | null;
  software:        { version: string; licenseType: string } | null;
  vulnerabilities: Vulnerability[] | null;
  agentStatus:     AgentStatus | null;
  contracts:       ContractRef[];
  businessImpact:     string | null;
  recoveryPriority:   number | null;
  rto:                number | null;
  rpo:                number | null;
  spofRisk:           boolean;
  containsPii:        boolean;
  dataClassification: string | null;
  // Infrastructure specs (T6)
  cpuModel?:          string | null;
  vCpus?:             number | null;
  ram?:               string | null;
  disk?:              string | null;
  adminIp?:           string | null;
  mgmtIp?:            string | null;
  hostName?:          string | null;
  clusterName?:       string | null;
  operatingSystem?:   { id: string; name: string; version: string | null } | null;
  firmwareVersion?:   string | null;
  dns?:               string | null;
}

interface Props {
  ci: CIDetail;
  onClose: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onUpdated?: () => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const CI_TYPE_LABELS: Record<string, string> = {
  PHYSICAL_SERVER: "Servidor Físico", VIRTUAL_SERVER: "Servidor Virtual", DATABASE: "Base de Datos",
  NETWORK: "Red", STORAGE: "Almacenamiento", BACKUP: "Backup", HARDWARE: "Hardware",
  SOFTWARE: "Software", OTHER: "Otro", DESKTOP: "Escritorio", LAPTOP: "Portátil",
  PRINTER: "Impresora", SCANNER: "Escáner", MONITOR: "Monitor", VIDEOCONFERENCE: "Videoconferencia",
  SMART_DISPLAY: "Pantalla Smart", TIME_CLOCK: "Reloj de Fichaje", IP_PHONE: "Teléfono IP",
  SMARTPHONE: "Smartphone", TABLET: "Tablet", PDA: "PDA", BARCODE_SCANNER: "Lector Código",
  IP_CAMERA: "Cámara IP", UPS: "SAI / UPS", WIFI_AP: "Punto de Acceso",
  CLOUD_INSTANCE: "Instancia Cloud", CLOUD_STORAGE: "Storage Cloud",
  BASE_SOFTWARE: "Software Base", LICENSE: "Licencia",
};

const CI_TYPE_ICONS: Record<string, React.ReactNode> = {
  PHYSICAL_SERVER: <Server className="h-4 w-4" />, VIRTUAL_SERVER: <Box className="h-4 w-4" />,
  DATABASE: <Database className="h-4 w-4" />, NETWORK: <Network className="h-4 w-4" />,
  STORAGE: <HardDrive className="h-4 w-4" />, BACKUP: <Archive className="h-4 w-4" />,
  HARDWARE: <Cpu className="h-4 w-4" />, SOFTWARE: <Package className="h-4 w-4" />,
  DESKTOP: <Monitor className="h-4 w-4" />, LAPTOP: <Laptop className="h-4 w-4" />,
  PRINTER: <Printer className="h-4 w-4" />, SCANNER: <ScanLine className="h-4 w-4" />,
  MONITOR: <Monitor className="h-4 w-4" />, VIDEOCONFERENCE: <Video className="h-4 w-4" />,
  SMART_DISPLAY: <Tv className="h-4 w-4" />, TIME_CLOCK: <Clock className="h-4 w-4" />,
  IP_PHONE: <Phone className="h-4 w-4" />, SMARTPHONE: <Smartphone className="h-4 w-4" />,
  TABLET: <Tablet className="h-4 w-4" />, PDA: <Smartphone className="h-4 w-4" />,
  BARCODE_SCANNER: <QrCode className="h-4 w-4" />, IP_CAMERA: <Camera className="h-4 w-4" />,
  UPS: <BatteryCharging className="h-4 w-4" />, WIFI_AP: <Cast className="h-4 w-4" />,
  CLOUD_INSTANCE: <Cloud className="h-4 w-4" />, CLOUD_STORAGE: <Database className="h-4 w-4" />,
  BASE_SOFTWARE: <Terminal className="h-4 w-4" />, LICENSE: <Key className="h-4 w-4" />,
};

const CRIT_STYLES: Record<Criticality, string> = {
  MISSION_CRITICAL: "bg-red-100 text-red-800", HIGH: "bg-orange-100 text-orange-800",
  MEDIUM: "bg-yellow-100 text-yellow-900", LOW: "bg-slate-100 text-slate-700",
};
const CRIT_LABELS: Record<Criticality, string> = {
  MISSION_CRITICAL: "Mission Critical", HIGH: "High", MEDIUM: "Medium", LOW: "Low",
};
const ENV_STYLES: Record<Environment, string> = {
  PRODUCTION: "bg-red-100 text-red-800", STAGING: "bg-orange-100 text-orange-800",
  TESTING: "bg-blue-100 text-blue-800", DEVELOPMENT: "bg-green-100 text-green-800",
};

const selectCls = "w-full rounded-lg border border-slate-300 bg-white px-2 py-1 text-sm text-slate-800 outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-100";

function Field({ label, value, icon }: { label: string; value: React.ReactNode; icon?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
        {icon && <span className="text-slate-400">{icon}</span>}{label}
      </dt>
      <dd className="text-sm text-slate-800">{value ?? <span className="italic text-slate-400">—</span>}</dd>
    </div>
  );
}

function Section({ title, children, color = "slate" }: { title: string; children: React.ReactNode; color?: string }) {
  const colors: Record<string, string> = {
    slate: "bg-slate-50 border-slate-200 text-slate-700",
    blue: "bg-blue-50 border-blue-200 text-blue-800",
    orange: "bg-orange-50 border-orange-200 text-orange-800",
    purple: "bg-purple-50 border-purple-200 text-purple-800",
    red: "bg-red-50 border-red-200 text-red-800",
  };
  return (
    <div className={`rounded-xl border p-4 ${colors[color]}`}>
      <p className={`mb-3 text-[10px] font-bold uppercase tracking-widest ${colors[color].split(" ")[2]}`}>{title}</p>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3">{children}</dl>
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function CIDetailModal({ ci, onClose, onEdit, onDelete, onUpdated }: Props) {
  const { t } = useLanguage();
  const resolvedType = ci.ciType || (ci.hardware ? "HARDWARE" : ci.software ? "SOFTWARE" : "OTHER");
  const typeLabel = t(`inventory.ci_types.${resolvedType}`) !== `inventory.ci_types.${resolvedType}`
    ? t(`inventory.ci_types.${resolvedType}`)
    : (CI_TYPE_LABELS[resolvedType] ?? resolvedType);
  const typeIcon  = CI_TYPE_ICONS[resolvedType] ?? <Server className="h-4 w-4" />;

  const { isAdmin } = useAuth();
  const [docs, setDocs]         = useState<DocRef[]>([]);
  const [docsLoading, setDocsLoading] = useState(true);
  const [contracts, setContracts] = useState<ContractRef[]>(ci.contracts ?? []);
  const [showAddDocs, setShowAddDocs] = useState(false);
  const [showAddContracts, setShowAddContracts] = useState(false);
  const [showPlaceModal, setShowPlaceModal] = useState(false);

  // Base Software (only for physical/virtual server CIs)
  interface BswRef { id: string; code: string; name: string; version: string | null; manufacturer: { id: string; name: string } | null }
  const bswEligible = ci.ciType !== null && ["PHYSICAL_SERVER", "VIRTUAL_SERVER", "CLOUD_INSTANCE"].includes(ci.ciType);
  const [baseSw, setBaseSw]           = useState<BswRef[]>([]);
  const [bswLoading, setBswLoading]   = useState(false);
  const [allBsw, setAllBsw]           = useState<BswRef[]>([]);
  const [bswToAdd, setBswToAdd]       = useState("");
  const [showAddBsw, setShowAddBsw]   = useState(false);

  interface RackLocation {
    footprintLabel: string;
    roomName: string; floorName: string;
    buildingName: string; branchName: string | null;
  }
  const [rackLocation, setRackLocation] = useState<RackLocation | null>(null);

  // Inline editing state (admin only)
  const [users, setUsers]         = useState<UserRef[]>([]);
  const [saving, setSaving]       = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [edited, setEdited]       = useState({
    status:          ci.status ?? "ACTIVO",
    criticality:     ci.criticality as string,
    environment:     ci.environment as string,
    businessOwnerId: ci.businessOwnerId,
    technicalLeadId: ci.technicalLeadId,
  });

  // Compute changed fields (only send what actually changed)
  const changedFields: Record<string, unknown> = {};
  if (edited.status          !== (ci.status ?? "ACTIVO"))    changedFields.status          = edited.status;
  if (edited.criticality     !== ci.criticality)             changedFields.criticality     = edited.criticality;
  if (edited.environment     !== ci.environment)             changedFields.environment     = edited.environment;
  if (edited.businessOwnerId !== ci.businessOwnerId)         changedFields.businessOwnerId = edited.businessOwnerId;
  if (edited.technicalLeadId !== ci.technicalLeadId)         changedFields.technicalLeadId = edited.technicalLeadId;
  const hasChanges = Object.keys(changedFields).length > 0;

  const handleSave = async () => {
    if (!hasChanges || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await apiFetch(`/api/cis/${ci.id}`, {
        method: "PATCH",
        body: JSON.stringify(changedFields),
      });
      const body = await res.json().catch(() => ({})) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? `Error ${res.status}`);
      onUpdated?.();
      onClose();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : t("ci_detail.save_error"));
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    if (!ci.hardware?.parentRackCiId) { setRackLocation(null); return; }
    apiFetch(`/api/dcim/racks/${ci.hardware.parentRackCiId}/location`)
      .then((r) => r.ok ? r.json() : null)
      .then((d) => setRackLocation(d))
      .catch(() => setRackLocation(null));
  }, [ci.hardware?.parentRackCiId]);

  const loadDocs = () => {
    setDocsLoading(true);
    apiFetch(`/api/cis/${ci.id}/documents`)
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((data: DocRef[]) => setDocs(data))
      .catch(() => setDocs([]))
      .finally(() => setDocsLoading(false));
  };

  const loadContracts = () => {
    apiFetch(`/api/cis/${ci.id}/contracts`)
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((data: ContractRef[]) => setContracts(data))
      .catch(() => {/* keep existing */});
  };

  const loadBaseSw = () => {
    if (!bswEligible) return;
    setBswLoading(true);
    apiFetch(`/api/catalog/cis/${ci.id}/base-software`)
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((data: BswRef[]) => setBaseSw(Array.isArray(data) ? data : []))
      .catch(() => setBaseSw([]))
      .finally(() => setBswLoading(false));
  };

  useEffect(() => {
    loadBaseSw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ci.id]);

  const handleAddBsw = async () => {
    if (!bswToAdd) return;
    const res = await apiFetch(`/api/catalog/cis/${ci.id}/base-software`, {
      method: "POST",
      body: JSON.stringify({ baseSoftwareId: bswToAdd }),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({})) as { error?: string };
      alert(d.error ?? `Error ${res.status}`);
      return;
    }
    setBswToAdd(""); setShowAddBsw(false);
    loadBaseSw();
  };

  const handleRemoveBsw = async (bswId: string) => {
    if (!confirm(t("ci_detail.bsw_confirm_remove"))) return;
    const res = await apiFetch(`/api/catalog/cis/${ci.id}/base-software/${bswId}`, { method: "DELETE" });
    if (res.ok || res.status === 404) loadBaseSw();
  };

  const openAddBsw = () => {
    setShowAddBsw(true);
    apiFetch("/api/catalog/base-software")
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => setAllBsw(Array.isArray(data) ? data : []))
      .catch(() => setAllBsw([]));
  };

  useEffect(() => {
    loadDocs();
    if (isAdmin) {
      apiFetch("/api/users")
        .then((r) => (r.ok ? r.json() : []))
        .then((data) => setUsers(Array.isArray(data) ? data : (data.data ?? [])))
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ci.id]);

  const handleRemoveDoc = async (docId: string) => {
    if (!confirm(t("ci_detail.confirm_remove_doc"))) return;
    try {
      await apiFetch(`/api/cis/${ci.id}/documents/${docId}`, { method: "DELETE" });
      loadDocs();
    } catch {/* silent */}
  };

  const handleRemoveContract = async (contractId: string) => {
    if (!confirm(t("ci_detail.confirm_remove_contract"))) return;
    try {
      await apiFetch(`/api/cis/${ci.id}/contracts/${contractId}`, { method: "DELETE" });
      loadContracts();
    } catch {/* silent */}
  };

  const handleDownload = async (docId: string, fileName: string) => {
    const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/documents/${docId}/download`, {
      credentials: "include",
    });
    if (!res.ok) return;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(url);
  };

  const openVulns = (ci.vulnerabilities ?? []).filter((v) => v.status !== "RESUELTO");
  const criticalVulns = openVulns.filter((v) => v.severity === "CRITICAL").length;
  const highVulns     = openVulns.filter((v) => v.severity === "HIGH").length;

  const hasSpof = ci.spofRisk;
  const hasPii  = ci.containsPii;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
      <div className="relative flex max-h-[90vh] w-full max-w-3xl flex-col rounded-2xl bg-white shadow-2xl ring-1 ring-slate-200 overflow-hidden">

        {/* Header */}
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 bg-slate-50 px-6 py-4">
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-indigo-100 text-indigo-600">
              {typeIcon}
            </div>
            <div className="min-w-0">
              <h2 className="text-base font-bold text-slate-900 truncate">{ci.name}</h2>
              <p className="text-xs text-slate-400 font-mono">{ci.apiSlug}</p>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {isAdmin && ci.hardware && (
              <button
                onClick={() => setShowPlaceModal(true)}
                className="flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50 transition-colors"
              >
                <MapPin className="h-3.5 w-3.5" />
                {ci.hardware.parentRackCiId ? t("dcim.place.change") : t("dcim.place.title")}
              </button>
            )}
            <button
              onClick={onEdit}
              className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-700 transition-colors"
            >
              <Pencil className="h-3.5 w-3.5" />{t("ci_detail.edit_btn")}
            </button>
            <button
              onClick={onDelete}
              className="flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-700 transition-colors"
            >
              <Trash2 className="h-3.5 w-3.5" />{t("ci_detail.delete_btn")}
            </button>
            <button onClick={onClose} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-colors">
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* Badges row */}
        <div className="flex flex-wrap gap-2 border-b border-slate-100 bg-white px-6 py-3">
          <span className={`inline-flex items-center rounded-md px-2.5 py-1 text-xs font-semibold ${CRIT_STYLES[ci.criticality]}`}>
            {CRIT_LABELS[ci.criticality]}
          </span>
          <span className={`inline-flex items-center rounded-md px-2.5 py-1 text-xs font-medium ${ENV_STYLES[ci.environment]}`}>
            {ci.environment}
          </span>
          <span className="inline-flex items-center gap-1 rounded-md bg-indigo-50 px-2.5 py-1 text-xs font-medium text-indigo-700">
            {typeIcon}{typeLabel}
          </span>
          {ci.status && (
            <span className="inline-flex items-center rounded-md bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600">
              {ci.status}
            </span>
          )}
          {hasSpof && (
            <span className="inline-flex items-center rounded-md bg-red-100 px-2.5 py-1 text-xs font-semibold text-red-700" title={t("ci_detail.spof_tooltip")}>
              SPOF
            </span>
          )}
          {hasPii && (
            <span className="inline-flex items-center rounded-md bg-purple-100 px-2.5 py-1 text-xs font-semibold text-purple-700" title={t("ci_detail.pii_tooltip")}>
              PII
            </span>
          )}
          {ci.businessImpact === "CRITICAL" && (
            <span className="inline-flex items-center rounded-md bg-orange-100 px-2.5 py-1 text-xs font-semibold text-orange-700">
              {t("ci_detail.nis2_critical")}
            </span>
          )}
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">

          {/* General info */}
          <Section title={t("ci_detail.section_general")} color="slate">
            <Field label={t("ci_detail.field_inventory")} value={ci.inventoryNumber} icon={<Hash className="h-3 w-3" />} />
            <Field label={t("ci_detail.field_type")} value={typeLabel} icon={<Tag className="h-3 w-3" />} />
            <Field
              label={t("ci_detail.field_eol_eos")}
              icon={<Calendar className="h-3 w-3" />}
              value={
                (ci.eolDate || ci.eosDate) ? (
                  <span>
                    {ci.eolDate ? <span>EoL: <strong>{new Date(ci.eolDate).toLocaleDateString("es-ES")}</strong></span> : null}
                    {ci.eolDate && ci.eosDate ? " · " : null}
                    {ci.eosDate ? <span>EoS: <strong>{new Date(ci.eosDate).toLocaleDateString("es-ES")}</strong></span> : null}
                  </span>
                ) : null
              }
            />
            <Field label={t("ci_detail.field_status")} icon={<Activity className="h-3 w-3" />} value={
              isAdmin ? (
                <select value={edited.status} onChange={(e) => setEdited((p) => ({ ...p, status: e.target.value }))} className={selectCls}>
                  <option value="ACTIVO">{t("inventory.status.ACTIVO")}</option>
                  <option value="INACTIVO">{t("inventory.status.INACTIVO")}</option>
                  <option value="RETIRADO">{t("inventory.status.RETIRADO")}</option>
                </select>
              ) : ci.status
            } />
            <Field label={t("ci_detail.field_criticality")} icon={<Tag className="h-3 w-3" />} value={
              isAdmin ? (
                <select value={edited.criticality} onChange={(e) => setEdited((p) => ({ ...p, criticality: e.target.value }))} className={selectCls}>
                  <option value="LOW">{t("inventory.criticality.LOW")}</option>
                  <option value="MEDIUM">{t("inventory.criticality.MEDIUM")}</option>
                  <option value="HIGH">{t("inventory.criticality.HIGH")}</option>
                  <option value="MISSION_CRITICAL">{t("inventory.criticality.MISSION_CRITICAL")}</option>
                </select>
              ) : ci.criticality
            } />
            <Field label={t("ci_detail.field_environment")} icon={<Server className="h-3 w-3" />} value={
              isAdmin ? (
                <select value={edited.environment} onChange={(e) => setEdited((p) => ({ ...p, environment: e.target.value }))} className={selectCls}>
                  <option value="DEVELOPMENT">{t("inventory.environment.DEVELOPMENT")}</option>
                  <option value="TESTING">{t("inventory.environment.TESTING")}</option>
                  <option value="STAGING">{t("inventory.environment.STAGING")}</option>
                  <option value="PRODUCTION">{t("inventory.environment.PRODUCTION")}</option>
                </select>
              ) : ci.environment
            } />
            <Field label={t("ci_detail.field_business_owner")} icon={<Briefcase className="h-3 w-3" />} value={
              isAdmin ? (
                <select value={edited.businessOwnerId ?? ""} onChange={(e) => setEdited((p) => ({ ...p, businessOwnerId: e.target.value || null }))} className={selectCls}>
                  <option value="">—</option>
                  {users.map((u) => <option key={u.id} value={u.id}>{u.username} ({u.email})</option>)}
                </select>
              ) : null
            } />
            <Field label={t("ci_detail.field_tech_lead")} icon={<User className="h-3 w-3" />} value={
              isAdmin ? (
                <select value={edited.technicalLeadId ?? ""} onChange={(e) => setEdited((p) => ({ ...p, technicalLeadId: e.target.value || null }))} className={selectCls}>
                  <option value="">—</option>
                  {users.map((u) => <option key={u.id} value={u.id}>{u.username} ({u.email})</option>)}
                </select>
              ) : (ci.technicalLead ? `${ci.technicalLead.username} (${ci.technicalLead.email})` : null)
            } />
          </Section>

          {/* Hardware / Software details */}
          {ci.hardware && (
            <Section title={t("ci_detail.section_hardware")} color="slate">
              <Field label={t("ci_detail.field_manufacturer")} value={ci.hardware.manufacturer} icon={<Building2 className="h-3 w-3" />} />
              <Field label={t("ci_detail.field_model")} value={ci.hardware.model} icon={<Cpu className="h-3 w-3" />} />
              <Field label={t("ci_detail.field_serial")} value={ci.hardware.serialNumber} icon={<Hash className="h-3 w-3" />} />
            </Section>
          )}

          {/* Ubicación física en CPD — only when CI is placed in a rack */}
          {ci.hardware?.parentRackCiId && (
            <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-4 space-y-2">
              <p className="text-[10px] font-bold uppercase tracking-widest text-indigo-600 flex items-center gap-1.5">
                <MapPin className="h-3.5 w-3.5" /> {t("dcim.place.title")}
              </p>
              <dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3">
                {rackLocation && (
                  <>
                    {rackLocation.branchName  && <Field label={t("dcim.place.branch")}   value={rackLocation.branchName}   icon={<Building2 className="h-3 w-3" />} />}
                    <Field label={t("dcim.place.building")} value={rackLocation.buildingName} icon={<Building2 className="h-3 w-3" />} />
                    <Field label={t("dcim.place.floor")}    value={rackLocation.floorName}    icon={<Tag className="h-3 w-3" />} />
                    <Field label={t("dcim.place.room")}     value={rackLocation.roomName}     icon={<Tag className="h-3 w-3" />} />
                    <Field label={t("dcim.place.rack")}     value={rackLocation.footprintLabel} icon={<Server className="h-3 w-3" />} />
                  </>
                )}
                <Field label={t("dcim.place.u_position")} value={ci.hardware.uPosition != null ? `U${ci.hardware.uPosition}` : null} icon={<Hash className="h-3 w-3" />} />
                <Field label={t("dcim.place.size_u")}     value={ci.hardware.sizeU     != null ? `${ci.hardware.sizeU}U`   : null} />
                <Field label={t("dcim.place.orientation")} value={ci.hardware.orientation ?? null} />
                {ci.hardware.powerW != null && <Field label={t("dcim.place.power_w")} value={`${ci.hardware.powerW}W`} icon={<Activity className="h-3 w-3" />} />}
              </dl>
            </div>
          )}
          {ci.software && (
            <Section title={t("ci_detail.section_software")} color="slate">
              <Field label={t("ci_detail.field_version")} value={ci.software.version} icon={<Package className="h-3 w-3" />} />
              <Field label={t("ci_detail.field_license_type")} value={ci.software.licenseType} icon={<Key className="h-3 w-3" />} />
            </Section>
          )}

          {/* Infrastructure specs (T6) */}
          {(ci.cpuModel || ci.vCpus != null || ci.ram || ci.disk || ci.adminIp || ci.mgmtIp || ci.hostName || ci.clusterName || ci.operatingSystem || ci.firmwareVersion || ci.dns) && (
            <Section title={t("ci_detail.section_infra")} color="slate">
              {ci.cpuModel        && <Field label={t("add_ci_modal.cpu_model_label")} value={ci.cpuModel} icon={<Cpu className="h-3 w-3" />} />}
              {ci.vCpus != null   && <Field label={t("add_ci_modal.vcpus_label")} value={String(ci.vCpus)} icon={<Cpu className="h-3 w-3" />} />}
              {ci.ram             && <Field label={t("add_ci_modal.ram_label")} value={ci.ram} />}
              {ci.disk            && <Field label={t("add_ci_modal.disk_label")} value={ci.disk} icon={<HardDrive className="h-3 w-3" />} />}
              {ci.hostName        && <Field label={t("add_ci_modal.hostname_label")} value={ci.hostName} icon={<Terminal className="h-3 w-3" />} />}
              {ci.clusterName     && <Field label={t("add_ci_modal.cluster_label")} value={ci.clusterName} icon={<Network className="h-3 w-3" />} />}
              {ci.adminIp         && <Field label={t("add_ci_modal.admin_ip_label")} value={ci.adminIp} icon={<Network className="h-3 w-3" />} />}
              {ci.mgmtIp          && <Field label={t("add_ci_modal.mgmt_ip_label")} value={ci.mgmtIp} icon={<Network className="h-3 w-3" />} />}
              {ci.operatingSystem && <Field label={t("add_ci_modal.os_label")} value={`${ci.operatingSystem.name}${ci.operatingSystem.version ? ` ${ci.operatingSystem.version}` : ""}`} icon={<Monitor className="h-3 w-3" />} />}
              {ci.firmwareVersion && <Field label={t("add_ci_modal.firmware_label")} value={ci.firmwareVersion} />}
              {ci.dns             && <Field label={t("add_ci_modal.dns_label")} value={ci.dns} />}
            </Section>
          )}

          {/* Vulnerabilities */}
          <div className={`rounded-xl border p-4 ${criticalVulns > 0 ? "bg-red-50 border-red-200" : openVulns.length > 0 ? "bg-orange-50 border-orange-200" : "bg-emerald-50 border-emerald-200"}`}>
            <p className="mb-2 text-[10px] font-bold uppercase tracking-widest text-slate-500">{t("ci_detail.section_vulns")}</p>
            {ci.vulnerabilities === null ? (
              <div className="flex items-center gap-2 text-slate-400"><ShieldOff className="h-4 w-4" /><span className="text-sm">{t("ci_detail.vuln_no_scanner")}</span></div>
            ) : openVulns.length === 0 ? (
              <div className="flex items-center gap-2 text-emerald-600"><ShieldCheck className="h-4 w-4" /><span className="text-sm font-medium">{t("ci_detail.vuln_clean")}</span></div>
            ) : (
              <div className="flex items-center gap-2 text-red-700">
                <ShieldAlert className="h-4 w-4" />
                <span className="text-sm font-medium">{t("ci_detail.vuln_open", { count: openVulns.length })}</span>
                {criticalVulns > 0 && <span className="rounded bg-red-100 px-1.5 py-0.5 text-xs font-bold text-red-700">CRITICAL ×{criticalVulns}</span>}
                {highVulns > 0    && <span className="rounded bg-orange-100 px-1.5 py-0.5 text-xs font-bold text-orange-700">HIGH ×{highVulns}</span>}
              </div>
            )}
          </div>

          {/* CrowdStrike */}
          {ci.agentStatus && (
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
              <p className="mb-2 text-[10px] font-bold uppercase tracking-widest text-slate-500">{t("ci_detail.section_crowdstrike")}</p>
              <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
                <Field label={t("ci_detail.field_cs_status")} value={ci.agentStatus.status} icon={<Shield className="h-3 w-3" />} />
                <Field label={t("ci_detail.field_cs_policy")} value={ci.agentStatus.preventionPolicy} icon={<Briefcase className="h-3 w-3" />} />
                <Field label={t("ci_detail.field_version")} value={ci.agentStatus.agentVersion ? `Falcon v${ci.agentStatus.agentVersion.split(".").slice(0,2).join(".")}` : null} />
                <Field label={t("ci_detail.field_cs_last_seen")} value={ci.agentStatus.lastSeen ? new Date(ci.agentStatus.lastSeen).toLocaleString("es-ES") : null} icon={<Calendar className="h-3 w-3" />} />
                <Field label={t("ci_detail.field_cs_detections")} value={String((ci.agentStatus.detections ?? []).length)} icon={<AlertTriangle className="h-3 w-3" />} />
              </dl>
            </div>
          )}

          {/* NIS2 / GDPR */}
          {(ci.businessImpact || ci.recoveryPriority != null || ci.rto != null || ci.rpo != null || ci.spofRisk || ci.containsPii || ci.dataClassification) && (
            <Section title={t("ci_detail.section_nis2")} color="orange">
              <Field label={t("ci_detail.field_business_impact")} value={ci.businessImpact} icon={<Activity className="h-3 w-3" />} />
              <Field label={t("ci_detail.field_recovery_priority")} value={ci.recoveryPriority != null ? String(ci.recoveryPriority) : null} />
              <Field label={t("ci_detail.field_rto")} value={ci.rto != null ? `${ci.rto} min` : null} />
              <Field label={t("ci_detail.field_rpo")} value={ci.rpo != null ? `${ci.rpo} min` : null} />
              <Field label={t("ci_detail.field_spof_risk")} value={ci.spofRisk ? t("common.yes") : t("common.no")} />
              <Field label={t("ci_detail.field_pii")} value={ci.containsPii ? t("ci_detail.yes_gdpr") : t("common.no")} />
              <Field label={t("ci_detail.field_data_class")} value={ci.dataClassification} />
            </Section>
          )}

          {/* Contracts */}
          <div className="rounded-xl border border-blue-200 bg-blue-50 p-4">
            <div className="flex items-center justify-between mb-3">
              <p className="text-[10px] font-bold uppercase tracking-widest text-blue-700">{t("ci_detail.section_contracts")}</p>
              {isAdmin && (
                <button
                  onClick={() => setShowAddContracts(true)}
                  className="flex items-center gap-1 rounded-lg bg-blue-100 px-2 py-1 text-xs font-medium text-blue-700 hover:bg-blue-200 transition-colors"
                >
                  <Plus className="h-3 w-3" />{t("ci_detail.associate_contracts")}
                </button>
              )}
            </div>
            {contracts.length === 0 ? (
              <p className="text-sm italic text-blue-400">{t("ci_detail.no_contracts")}</p>
            ) : (
              <div className="space-y-2">
                {contracts.map((ct) => (
                  <div key={ct.id} className="flex items-center justify-between rounded-lg bg-white border border-blue-100 px-3 py-2 group">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-blue-700">{ct.contractNumber}</span>
                      <span className="text-xs text-slate-500">{ct.vendor?.name ?? "—"}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      {ct.endDate && (
                        <span className="text-xs text-slate-400">{t("ci_detail.expires")}: {new Date(ct.endDate).toLocaleDateString("es-ES")}</span>
                      )}
                      {isAdmin && (
                        <button
                          onClick={() => handleRemoveContract(ct.id)}
                          className="rounded p-1 text-slate-300 hover:bg-red-50 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all"
                          title={t("ci_detail.remove_contract")}
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Documents */}
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
            <div className="flex items-center justify-between mb-3">
              <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">{t("ci_detail.section_docs")}</p>
              {isAdmin && (
                <button
                  onClick={() => setShowAddDocs(true)}
                  className="flex items-center gap-1 rounded-lg bg-slate-200 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-300 transition-colors"
                >
                  <Plus className="h-3 w-3" />{t("ci_detail.associate_docs")}
                </button>
              )}
            </div>
            {docsLoading ? (
              <div className="flex items-center gap-2 text-slate-400 text-sm">
                <FileText className="h-4 w-4 animate-pulse" />
                <span>{t("ci_detail.loading_docs")}</span>
              </div>
            ) : docs.length === 0 ? (
              <p className="text-sm italic text-slate-400">{t("ci_detail.no_docs")}</p>
            ) : (
              <div className="space-y-2">
                {docs.map((doc) => (
                  <div key={doc.id} className="flex items-center justify-between rounded-lg bg-white border border-slate-100 px-3 py-2 gap-3 group">
                    <div className="flex items-start gap-2 min-w-0">
                      <FileText className="h-4 w-4 flex-shrink-0 text-indigo-400 mt-0.5" />
                      <div className="min-w-0">
                        <Link href={`/documents/${doc.id}`} className="text-sm font-medium text-indigo-700 hover:underline truncate block">
                          {doc.title}
                        </Link>
                        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                          <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold bg-slate-100 text-slate-600">
                            {doc.documentTypeName}
                          </span>
                          <span className="text-[11px] text-slate-400 truncate">{doc.originalName}</span>
                          <span className="text-[11px] text-slate-400">v{doc.versionNumber}</span>
                          <span className="text-[11px] text-slate-400">{new Date(doc.createdAt).toLocaleDateString("es-ES")}</span>
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <button
                        onClick={() => handleDownload(doc.id, doc.originalName)}
                        className="flex items-center gap-1 rounded-md bg-slate-100 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-indigo-50 hover:text-indigo-700 transition-colors"
                        title={t("ci_detail.download")}
                      >
                        <Download className="h-3.5 w-3.5" />
                        {t("ci_detail.download")}
                      </button>
                      {isAdmin && (
                        <button
                          onClick={() => handleRemoveDoc(doc.id)}
                          className="rounded p-1 text-slate-300 hover:bg-red-50 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all"
                          title={t("ci_detail.remove_doc")}
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
            {!docsLoading && (
              <div className="mt-3 text-right">
                <Link href="/documents" className="text-xs text-indigo-500 hover:text-indigo-700 hover:underline transition-colors">
                  {t("ci_detail.view_all_docs")}
                </Link>
              </div>
            )}
          </div>

          {/* ── Base Software (physical/virtual servers only) ── */}
          {bswEligible && (
            <div className="mt-6 rounded-xl bg-slate-50 border border-slate-200 p-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-700">
                  <Package className="h-4 w-4 text-indigo-500" />
                  {t("ci_detail.bsw_title")}
                  <span className="rounded-full bg-slate-200 px-1.5 py-0.5 text-[10px] font-bold text-slate-600 tabular-nums">{baseSw.length}</span>
                </h3>
                {isAdmin && (
                  <button
                    onClick={openAddBsw}
                    className="flex items-center gap-1 rounded-lg bg-slate-200 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-300 transition-colors"
                  >
                    <Plus className="h-3 w-3" />{t("ci_detail.bsw_add")}
                  </button>
                )}
              </div>
              {showAddBsw && (
                <div className="mb-3 flex items-center gap-2">
                  <select
                    value={bswToAdd}
                    onChange={(e) => setBswToAdd(e.target.value)}
                    className="flex-1 rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-700 focus:border-indigo-400 focus:outline-none"
                  >
                    <option value="">{t("ci_detail.bsw_select")}</option>
                    {allBsw
                      .filter((sw) => !baseSw.some((b) => b.id === sw.id))
                      .map((sw) => (
                        <option key={sw.id} value={sw.id}>
                          {sw.name}{sw.version ? ` ${sw.version}` : ""}{sw.manufacturer ? ` — ${sw.manufacturer.name}` : ""}
                        </option>
                      ))}
                  </select>
                  <button
                    onClick={handleAddBsw}
                    disabled={!bswToAdd}
                    className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-50 transition-colors"
                  >
                    <Check className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={() => { setShowAddBsw(false); setBswToAdd(""); }}
                    className="rounded-lg border border-slate-200 px-2 py-1.5 text-xs text-slate-500 hover:bg-slate-100 transition-colors"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
              {bswLoading ? (
                <div className="flex items-center gap-2 text-slate-400 text-sm">
                  <Package className="h-4 w-4 animate-pulse" />
                  <span>{t("ci_detail.bsw_loading")}</span>
                </div>
              ) : baseSw.length === 0 ? (
                <p className="text-sm italic text-slate-400">{t("ci_detail.bsw_empty")}</p>
              ) : (
                <div className="space-y-2">
                  {baseSw.map((sw) => (
                    <div key={sw.id} className="flex items-center justify-between rounded-lg bg-white border border-slate-100 px-3 py-2 gap-3 group">
                      <div className="flex items-center gap-2 min-w-0">
                        <Package className="h-4 w-4 flex-shrink-0 text-indigo-400" />
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-slate-700 truncate">
                            {sw.name}
                            {sw.version && <span className="ml-1.5 text-xs text-slate-400">{sw.version}</span>}
                          </p>
                          {sw.manufacturer && <p className="text-[11px] text-slate-400">{sw.manufacturer.name}</p>}
                        </div>
                      </div>
                      {isAdmin && (
                        <button
                          onClick={() => handleRemoveBsw(sw.id)}
                          className="rounded p-1 text-slate-300 hover:bg-red-50 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all"
                          title={t("ci_detail.bsw_remove")}
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-slate-200 bg-slate-50 px-6 py-3 space-y-2">
          {saveError && (
            <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
              <AlertTriangle className="h-4 w-4 flex-shrink-0" />{saveError}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <button onClick={onClose} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 transition-colors">
              {t("ci_detail.btn_close")}
            </button>
            {isAdmin && (
              <button
                onClick={handleSave}
                disabled={saving || !hasChanges}
                className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50 transition-colors"
              >
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                {t("ci_detail.btn_save_changes")}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Associate Documents sub-modal */}
      {showAddDocs && (
        <AddDocumentsSubModal
          ciId={ci.id}
          existingDocIds={docs.map((d) => d.id)}
          onClose={() => setShowAddDocs(false)}
          onSuccess={() => { setShowAddDocs(false); loadDocs(); }}
        />
      )}

      {/* Associate Contracts sub-modal */}
      {showAddContracts && (
        <AddContractsSubModal
          ciId={ci.id}
          existingContractIds={contracts.map((c) => c.id)}
          onClose={() => setShowAddContracts(false)}
          onSuccess={() => { setShowAddContracts(false); loadContracts(); }}
        />
      )}

      {/* Place CI in rack modal */}
      {showPlaceModal && (
        <PlaceCIModal
          ciId={ci.id}
          ciName={ci.name}
          currentPlacement={ci.hardware ? {
            parentRackCiId: ci.hardware.parentRackCiId ?? null,
            uPosition     : ci.hardware.uPosition      ?? null,
            orientation   : ci.hardware.orientation    ?? null,
            sizeU         : ci.hardware.sizeU           ?? null,
            powerW        : ci.hardware.powerW          ?? null,
          } : undefined}
          onClose={() => setShowPlaceModal(false)}
          onPlaced={() => { setShowPlaceModal(false); onUpdated?.(); }}
        />
      )}
    </div>
  );
}

// ─── AddDocumentsSubModal ─────────────────────────────────────────────────────

interface DocListItem {
  id: string;
  title: string;
  documentTypeName: string;
}

function AddDocumentsSubModal({
  ciId,
  existingDocIds,
  onClose,
  onSuccess,
}: {
  ciId: string;
  existingDocIds: string[];
  onClose: () => void;
  onSuccess: () => void;
}) {
  const { t } = useLanguage();
  const [allDocs, setAllDocs] = useState<DocListItem[]>([]);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    apiFetch("/api/documents")
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((data: { data: DocListItem[] }) => {
        setAllDocs((data.data ?? []).filter((d) => !existingDocIds.includes(d.id)));
      })
      .catch(() => setAllDocs([]))
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ciId]);

  const filtered = allDocs.filter(
    (d) =>
      d.title.toLowerCase().includes(search.toLowerCase()) ||
      d.documentTypeName.toLowerCase().includes(search.toLowerCase()),
  );

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const handleSubmit = async () => {
    if (selected.size === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/cis/${ciId}/documents`, {
        method: "POST",
        body: JSON.stringify({ documentIds: Array.from(selected) }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(d.error ?? `Error ${res.status}`);
      }
      onSuccess();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("ci_detail.unknown_error"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
          <h2 className="text-base font-semibold text-slate-900">{t("ci_detail.subdoc_title")}</h2>
          <button onClick={onClose} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="px-6 py-5 space-y-3">
          {error && (
            <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
              <AlertTriangle className="h-4 w-4 flex-shrink-0" />{error}
            </div>
          )}
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("ci_detail.subdoc_search")}
            className="w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-800 placeholder-slate-400 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
          />
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-6 text-slate-400 text-sm">
              <RefreshCw className="h-4 w-4 animate-spin" />{t("ci_detail.loading_data")}
            </div>
          ) : filtered.length === 0 ? (
            <p className="py-6 text-center text-sm text-slate-400">{t("ci_detail.subdoc_no_docs")}</p>
          ) : (
            <div className="overflow-y-auto max-h-64 divide-y divide-slate-50 rounded-lg border border-slate-200">
              {filtered.map((d) => (
                <label key={d.id} className="flex items-center gap-3 px-4 py-2.5 hover:bg-slate-50 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selected.has(d.id)}
                    onChange={() => toggle(d.id)}
                    className="accent-indigo-600 h-4 w-4"
                  />
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-slate-800 truncate">{d.title}</p>
                    <p className="text-xs text-slate-400 truncate">{d.documentTypeName}</p>
                  </div>
                </label>
              ))}
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-200 px-6 py-4">
          <button onClick={onClose} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 transition-colors">
            {t("actions.cancel")}
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting || selected.size === 0}
            className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50 transition-colors"
          >
            {submitting ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            {t("ci_detail.subdoc_associate")}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── AddContractsSubModal ─────────────────────────────────────────────────────

interface ContractSubItem {
  id: string;
  contractNumber: string;
  vendor: { name: string } | null;
}

function AddContractsSubModal({
  ciId,
  existingContractIds,
  onClose,
  onSuccess,
}: {
  ciId: string;
  existingContractIds: string[];
  onClose: () => void;
  onSuccess: () => void;
}) {
  const { t } = useLanguage();
  const [allContracts, setAllContracts] = useState<ContractSubItem[]>([]);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    apiFetch("/api/contracts")
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((data: ContractSubItem[]) => {
        setAllContracts(data.filter((c) => !existingContractIds.includes(c.id)));
      })
      .catch(() => setAllContracts([]))
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ciId]);

  const filtered = allContracts.filter(
    (c) =>
      c.contractNumber.toLowerCase().includes(search.toLowerCase()) ||
      (c.vendor?.name ?? "").toLowerCase().includes(search.toLowerCase()),
  );

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const handleSubmit = async () => {
    if (selected.size === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/cis/${ciId}/contracts`, {
        method: "POST",
        body: JSON.stringify({ contractIds: Array.from(selected) }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(d.error ?? `Error ${res.status}`);
      }
      onSuccess();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("ci_detail.unknown_error"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
          <h2 className="text-base font-semibold text-slate-900">{t("ci_detail.subcontract_title")}</h2>
          <button onClick={onClose} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="px-6 py-5 space-y-3">
          {error && (
            <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
              <AlertTriangle className="h-4 w-4 flex-shrink-0" />{error}
            </div>
          )}
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("ci_detail.subcontract_search")}
            className="w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-800 placeholder-slate-400 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
          />
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-6 text-slate-400 text-sm">
              <RefreshCw className="h-4 w-4 animate-spin" />{t("ci_detail.loading_data")}
            </div>
          ) : filtered.length === 0 ? (
            <p className="py-6 text-center text-sm text-slate-400">{t("ci_detail.subcontract_no_contracts")}</p>
          ) : (
            <div className="overflow-y-auto max-h-64 divide-y divide-slate-50 rounded-lg border border-slate-200">
              {filtered.map((c) => (
                <label key={c.id} className="flex items-center gap-3 px-4 py-2.5 hover:bg-slate-50 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selected.has(c.id)}
                    onChange={() => toggle(c.id)}
                    className="accent-indigo-600 h-4 w-4"
                  />
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-slate-800 font-mono truncate">{c.contractNumber}</p>
                    <p className="text-xs text-slate-400 truncate">{c.vendor?.name ?? "—"}</p>
                  </div>
                </label>
              ))}
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-200 px-6 py-4">
          <button onClick={onClose} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 transition-colors">
            {t("actions.cancel")}
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting || selected.size === 0}
            className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50 transition-colors"
          >
            {submitting ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            {t("ci_detail.subdoc_associate")}
          </button>
        </div>
      </div>
    </div>
  );
}

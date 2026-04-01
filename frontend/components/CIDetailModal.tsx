"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { X, Pencil, Trash2, Shield, ShieldAlert, ShieldCheck, ShieldOff, Server, Box, Database, Network, HardDrive, Archive, Package, Cpu, Monitor, Laptop, Printer, ScanLine, Tv, Video, Cast, Clock, Phone, Smartphone, Tablet, QrCode, Camera, BatteryCharging, Key, Cloud, Terminal, AlertTriangle, Calendar, Hash, Building2, User, Briefcase, Tag, Activity, Download, FileText, Plus, RefreshCw, Check } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { apiFetch } from "@/lib/apiFetch";

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
  hardware:        { serialNumber: string; model: string; manufacturer: string } | null;
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
}

interface Props {
  ci: CIDetail;
  onClose: () => void;
  onEdit: () => void;
  onDelete: () => void;
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

export default function CIDetailModal({ ci, onClose, onEdit, onDelete }: Props) {
  const resolvedType = ci.ciType || (ci.hardware ? "HARDWARE" : ci.software ? "SOFTWARE" : "OTHER");
  const typeLabel = CI_TYPE_LABELS[resolvedType] ?? resolvedType;
  const typeIcon  = CI_TYPE_ICONS[resolvedType] ?? <Server className="h-4 w-4" />;

  const { token, isAdmin } = useAuth();
  const [docs, setDocs]         = useState<DocRef[]>([]);
  const [docsLoading, setDocsLoading] = useState(true);
  const [contracts, setContracts] = useState<ContractRef[]>(ci.contracts ?? []);
  const [showAddDocs, setShowAddDocs] = useState(false);
  const [showAddContracts, setShowAddContracts] = useState(false);

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

  useEffect(() => {
    loadDocs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ci.id]);

  const handleRemoveDoc = async (docId: string) => {
    if (!confirm("¿Quitar este documento del CI?")) return;
    try {
      await apiFetch(`/api/cis/${ci.id}/documents/${docId}`, { method: "DELETE" });
      loadDocs();
    } catch {/* silent */}
  };

  const handleRemoveContract = async (contractId: string) => {
    if (!confirm("¿Quitar este contrato del CI?")) return;
    try {
      await apiFetch(`/api/cis/${ci.id}/contracts/${contractId}`, { method: "DELETE" });
      loadContracts();
    } catch {/* silent */}
  };

  const handleDownload = async (docId: string, fileName: string) => {
    const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/documents/${docId}/download`, {
      headers: { Authorization: `Bearer ${token}` },
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
            <button
              onClick={onEdit}
              className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-700 transition-colors"
            >
              <Pencil className="h-3.5 w-3.5" />Editar
            </button>
            <button
              onClick={onDelete}
              className="flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-700 transition-colors"
            >
              <Trash2 className="h-3.5 w-3.5" />Eliminar
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
            <span className="inline-flex items-center rounded-md bg-red-100 px-2.5 py-1 text-xs font-semibold text-red-700" title="Punto Único de Fallo">
              SPOF
            </span>
          )}
          {hasPii && (
            <span className="inline-flex items-center rounded-md bg-purple-100 px-2.5 py-1 text-xs font-semibold text-purple-700" title="Contiene datos personales (GDPR)">
              PII
            </span>
          )}
          {ci.businessImpact === "CRITICAL" && (
            <span className="inline-flex items-center rounded-md bg-orange-100 px-2.5 py-1 text-xs font-semibold text-orange-700">
              NIS2 Crítico
            </span>
          )}
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">

          {/* General info */}
          <Section title="Información General" color="slate">
            <Field label="Número de Inventario" value={ci.inventoryNumber} icon={<Hash className="h-3 w-3" />} />
            <Field label="Responsable Técnico" value={ci.technicalLead ? `${ci.technicalLead.username} (${ci.technicalLead.email})` : null} icon={<User className="h-3 w-3" />} />
            <Field label="Tipo" value={typeLabel} icon={<Tag className="h-3 w-3" />} />
            <Field
              label="EoL / EoS"
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
            <Field label="Estado" value={ci.status} icon={<Activity className="h-3 w-3" />} />
          </Section>

          {/* Hardware / Software details */}
          {ci.hardware && (
            <Section title="Hardware" color="slate">
              <Field label="Fabricante" value={ci.hardware.manufacturer} icon={<Building2 className="h-3 w-3" />} />
              <Field label="Modelo" value={ci.hardware.model} icon={<Cpu className="h-3 w-3" />} />
              <Field label="Número de Serie" value={ci.hardware.serialNumber} icon={<Hash className="h-3 w-3" />} />
            </Section>
          )}
          {ci.software && (
            <Section title="Software / Licencia" color="slate">
              <Field label="Versión" value={ci.software.version} icon={<Package className="h-3 w-3" />} />
              <Field label="Tipo de Licencia" value={ci.software.licenseType} icon={<Key className="h-3 w-3" />} />
            </Section>
          )}

          {/* Vulnerabilities */}
          <div className={`rounded-xl border p-4 ${criticalVulns > 0 ? "bg-red-50 border-red-200" : openVulns.length > 0 ? "bg-orange-50 border-orange-200" : "bg-emerald-50 border-emerald-200"}`}>
            <p className="mb-2 text-[10px] font-bold uppercase tracking-widest text-slate-500">Vulnerabilidades</p>
            {ci.vulnerabilities === null ? (
              <div className="flex items-center gap-2 text-slate-400"><ShieldOff className="h-4 w-4" /><span className="text-sm">Sin datos de escáner</span></div>
            ) : openVulns.length === 0 ? (
              <div className="flex items-center gap-2 text-emerald-600"><ShieldCheck className="h-4 w-4" /><span className="text-sm font-medium">Sin vulnerabilidades abiertas</span></div>
            ) : (
              <div className="flex items-center gap-2 text-red-700">
                <ShieldAlert className="h-4 w-4" />
                <span className="text-sm font-medium">{openVulns.length} abiertas</span>
                {criticalVulns > 0 && <span className="rounded bg-red-100 px-1.5 py-0.5 text-xs font-bold text-red-700">CRITICAL ×{criticalVulns}</span>}
                {highVulns > 0    && <span className="rounded bg-orange-100 px-1.5 py-0.5 text-xs font-bold text-orange-700">HIGH ×{highVulns}</span>}
              </div>
            )}
          </div>

          {/* CrowdStrike */}
          {ci.agentStatus && (
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
              <p className="mb-2 text-[10px] font-bold uppercase tracking-widest text-slate-500">CrowdStrike Falcon</p>
              <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
                <Field label="Estado" value={ci.agentStatus.status} icon={<Shield className="h-3 w-3" />} />
                <Field label="Política" value={ci.agentStatus.preventionPolicy} icon={<Briefcase className="h-3 w-3" />} />
                <Field label="Versión" value={ci.agentStatus.agentVersion ? `Falcon v${ci.agentStatus.agentVersion.split(".").slice(0,2).join(".")}` : null} />
                <Field label="Última vez visto" value={ci.agentStatus.lastSeen ? new Date(ci.agentStatus.lastSeen).toLocaleString("es-ES") : null} icon={<Calendar className="h-3 w-3" />} />
                <Field label="Detecciones" value={String((ci.agentStatus.detections ?? []).length)} icon={<AlertTriangle className="h-3 w-3" />} />
              </dl>
            </div>
          )}

          {/* NIS2 / GDPR */}
          {(ci.businessImpact || ci.recoveryPriority != null || ci.rto != null || ci.rpo != null || ci.spofRisk || ci.containsPii || ci.dataClassification) && (
            <Section title="Resiliencia NIS2 / GDPR" color="orange">
              <Field label="Impacto de Negocio" value={ci.businessImpact} icon={<Activity className="h-3 w-3" />} />
              <Field label="Prioridad de Recuperación" value={ci.recoveryPriority != null ? String(ci.recoveryPriority) : null} />
              <Field label="RTO (min)" value={ci.rto != null ? `${ci.rto} min` : null} />
              <Field label="RPO (min)" value={ci.rpo != null ? `${ci.rpo} min` : null} />
              <Field label="Riesgo SPOF" value={ci.spofRisk ? "Sí" : "No"} />
              <Field label="Contiene PII" value={ci.containsPii ? "Sí (GDPR)" : "No"} />
              <Field label="Clasificación de Datos" value={ci.dataClassification} />
            </Section>
          )}

          {/* Contracts */}
          <div className="rounded-xl border border-blue-200 bg-blue-50 p-4">
            <div className="flex items-center justify-between mb-3">
              <p className="text-[10px] font-bold uppercase tracking-widest text-blue-700">Contratos Asociados</p>
              {isAdmin && (
                <button
                  onClick={() => setShowAddContracts(true)}
                  className="flex items-center gap-1 rounded-lg bg-blue-100 px-2 py-1 text-xs font-medium text-blue-700 hover:bg-blue-200 transition-colors"
                >
                  <Plus className="h-3 w-3" />Asociar Contratos
                </button>
              )}
            </div>
            {contracts.length === 0 ? (
              <p className="text-sm italic text-blue-400">No hay contratos asociados.</p>
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
                        <span className="text-xs text-slate-400">Vence: {new Date(ct.endDate).toLocaleDateString("es-ES")}</span>
                      )}
                      {isAdmin && (
                        <button
                          onClick={() => handleRemoveContract(ct.id)}
                          className="rounded p-1 text-slate-300 hover:bg-red-50 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all"
                          title="Quitar contrato"
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
              <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Documentos adjuntos</p>
              {isAdmin && (
                <button
                  onClick={() => setShowAddDocs(true)}
                  className="flex items-center gap-1 rounded-lg bg-slate-200 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-300 transition-colors"
                >
                  <Plus className="h-3 w-3" />Asociar Documentos
                </button>
              )}
            </div>
            {docsLoading ? (
              <div className="flex items-center gap-2 text-slate-400 text-sm">
                <FileText className="h-4 w-4 animate-pulse" />
                <span>Cargando documentos…</span>
              </div>
            ) : docs.length === 0 ? (
              <p className="text-sm italic text-slate-400">No hay documentos asociados.</p>
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
                        title="Descargar"
                      >
                        <Download className="h-3.5 w-3.5" />
                        Descargar
                      </button>
                      {isAdmin && (
                        <button
                          onClick={() => handleRemoveDoc(doc.id)}
                          className="rounded p-1 text-slate-300 hover:bg-red-50 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all"
                          title="Quitar documento"
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
                  Ver todos los documentos →
                </Link>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="border-t border-slate-200 bg-slate-50 px-6 py-3 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 transition-colors">
            Cerrar
          </button>
          <button onClick={onEdit} className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 transition-colors">
            <Pencil className="h-4 w-4" />Editar CI
          </button>
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
      .then((data: DocListItem[]) => {
        setAllDocs(data.filter((d) => !existingDocIds.includes(d.id)));
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
      setError(e instanceof Error ? e.message : "Error desconocido");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
          <h2 className="text-base font-semibold text-slate-900">Asociar Documentos</h2>
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
            placeholder="Buscar documento por título o tipo…"
            className="w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-800 placeholder-slate-400 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
          />
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-6 text-slate-400 text-sm">
              <RefreshCw className="h-4 w-4 animate-spin" />Cargando datos…
            </div>
          ) : filtered.length === 0 ? (
            <p className="py-6 text-center text-sm text-slate-400">No hay documentos disponibles para asociar.</p>
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
            Cancelar
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting || selected.size === 0}
            className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50 transition-colors"
          >
            {submitting ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            Asociar seleccionados
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
      setError(e instanceof Error ? e.message : "Error desconocido");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
          <h2 className="text-base font-semibold text-slate-900">Asociar Contratos</h2>
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
            placeholder="Buscar contrato por número o proveedor…"
            className="w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-800 placeholder-slate-400 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
          />
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-6 text-slate-400 text-sm">
              <RefreshCw className="h-4 w-4 animate-spin" />Cargando datos…
            </div>
          ) : filtered.length === 0 ? (
            <p className="py-6 text-center text-sm text-slate-400">No hay contratos disponibles para añadir.</p>
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
            Cancelar
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting || selected.size === 0}
            className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50 transition-colors"
          >
            {submitting ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            Asociar seleccionados
          </button>
        </div>
      </div>
    </div>
  );
}

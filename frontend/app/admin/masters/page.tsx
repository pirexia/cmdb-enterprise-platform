"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Building2, MapPin, Cpu, Layers, Package, Wallet, Tags, Lock, FileText, Key, Monitor, Calendar, Server,
  Plus, Trash2, RefreshCw, AlertTriangle, ChevronRight, Pencil, Check, X,
} from "lucide-react";
import { apiFetch } from "@/lib/apiFetch";
import { useLanguage } from "@/contexts/LanguageContext";
import { LifecycleDatesEditor } from "@/components/LifecycleDatesEditor";
import EditCatalogEntityModal, { type CatalogEntity } from "@/components/EditCatalogEntityModal";

// ─── Types ────────────────────────────────────────────────────────────────────

interface SupportArea  { id: string; name: string }
interface Branch       { id: string; name: string; branch_code: string; physical_address: string | null; support_area_id: string; support_area_name: string }
interface Manufacturer { id: string; name: string }
interface DeviceModel  { id: string; name: string; manufacturer_id: string; manufacturer_name: string; eolDate: string | null; eosDate: string | null }
interface Provider     { id: string; name: string }
interface CostCenter   { id: string; code: string; name: string }
interface CITypeItem   { id: string; code: string; name: string; isSystem: boolean; categoryCode: string }
interface CITypeCategory { code: string; name: string; ciTypes: CITypeItem[] }
interface DocumentTypeItem { id: string; code: string; name: string; isSystem: boolean }
interface LicenseMetricItem { id: string; code: string; name: string; isSystem: boolean; categoryCode: string; description: string | null }
interface LicenseMetricCategory { code: string; name: string; sortOrder: number; metrics: LicenseMetricItem[] }
interface LicenseTypeItem { id: string; code: string; name: string; isSystem: boolean; categoryCode: string; description: string | null }
interface LicenseTypeCategory { code: string; name: string; sortOrder: number; types: LicenseTypeItem[] }
interface OsItem { id: string; code: string; name: string; version: string | null; isSystem: boolean; manufacturer: { id: string; name: string } | null }
interface BswItem { id: string; code: string; name: string; version: string | null; isSystem: boolean; manufacturer: { id: string; name: string } | null }
interface DateTypeItem { id: string; code: string; name: string; description: string | null; category: "HARDWARE" | "SOFTWARE" | "OS" | "GENERAL"; sortOrder: number; isSystem: boolean }
interface HypervisorItem { id: string; code: string; name: string; isSystem: boolean }

type TabId = "support-areas" | "branches" | "manufacturers" | "models" | "providers" | "cost-centers" | "ci-types" | "doc-types" | "license-metrics" | "license-types" | "operating-systems" | "base-software" | "date-types" | "hypervisors";

type EditState =
  | { kind: "simple";    path: string; id: string; name: string }
  | { kind: "branch";    id: string; name: string; code: string; address: string; supportAreaId: string }
  | { kind: "cc";        id: string; code: string; name: string }
  | { kind: "citype";    id: string; name: string; categoryCode: string }
  | { kind: "doctype";   id: string; name: string }
  | { kind: "licmetric"; id: string; name: string; description: string }
  | { kind: "lictype";   id: string; name: string; description: string }
  | { kind: "datetype";  id: string; code: string; name: string; description: string; category: string; sortOrder: string }
  | { kind: "hypervisor"; id: string; name: string }
  | null;

// ─── Reusable input components ────────────────────────────────────────────────

function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`w-full rounded-none border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:border-[var(--accent)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/20 ${props.className ?? ""}`} />;
}
function Sel(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`w-full rounded-none border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-800 focus:border-[var(--accent)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/20 ${props.className ?? ""}`} />;
}

// ─── Editable list row (name-only) ───────────────────────────────────────────

function EditableRow({ id, label, sublabel, editState, onStartEdit, onSaveEdit, onCancelEdit, onDelete }: {
  id: string; label: string; sublabel?: string;
  editState: EditState;
  onStartEdit: () => void;
  onSaveEdit: (name: string) => void;
  onCancelEdit: () => void;
  onDelete: () => void;
}) {
  const isEditing = editState !== null && editState.kind === "simple" && editState.id === id;
  const [val, setVal] = useState(label);
  useEffect(() => { if (!isEditing) setVal(label); }, [label, isEditing]);

  if (isEditing) {
    return (
      <div className="flex items-center gap-2 px-4 py-2 bg-[var(--accent)]/5 border-b border-[var(--accent)]/20">
        <Input value={val} onChange={(e) => setVal(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") onSaveEdit(val); if (e.key === "Escape") onCancelEdit(); }} autoFocus className="flex-1" />
        <button onClick={() => onSaveEdit(val)} className="rounded-lg p-1.5 text-emerald-600 hover:bg-emerald-50 transition-colors"><Check className="h-4 w-4" /></button>
        <button onClick={onCancelEdit} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 transition-colors"><X className="h-4 w-4" /></button>
      </div>
    );
  }
  return (
    <div className="flex items-center justify-between px-4 py-2.5 hover:bg-slate-50 transition-colors group">
      <div>
        <p className="text-sm font-medium text-slate-700">{label}</p>
        {sublabel && <p className="text-xs text-slate-400">{sublabel}</p>}
      </div>
      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-all">
        <button onClick={onStartEdit} className="rounded-none p-1.5 text-[var(--accent)] hover:bg-[var(--accent)]/10 hover:text-[var(--accent)] transition-colors"><Pencil className="h-4 w-4" /></button>
        <button onClick={onDelete} className="rounded-lg p-1.5 text-red-400 hover:bg-red-50 hover:text-red-600 transition-colors"><Trash2 className="h-4 w-4" /></button>
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function MastersPage() {
  const { t } = useLanguage();
  const [tab, setTab] = useState<TabId>("support-areas");

  const [supportAreas,     setSupportAreas]     = useState<SupportArea[]>([]);
  const [branches,         setBranches]         = useState<Branch[]>([]);
  const [manufacturers,    setManufacturers]    = useState<Manufacturer[]>([]);
  const [models,           setModels]           = useState<DeviceModel[]>([]);
  const [providers,        setProviders]        = useState<Provider[]>([]);
  const [costCenters,      setCostCenters]      = useState<CostCenter[]>([]);
  const [ciTypeCategories, setCiTypeCategories] = useState<CITypeCategory[]>([]);
  const [docTypes,         setDocTypes]         = useState<DocumentTypeItem[]>([]);
  const [licenseMetricCats, setLicenseMetricCats] = useState<LicenseMetricCategory[]>([]);
  const [licenseTypeCats,   setLicenseTypeCats]   = useState<LicenseTypeCategory[]>([]);
  const [operatingSystems,  setOperatingSystems]  = useState<OsItem[]>([]);
  const [baseSoftwares,     setBaseSoftwares]     = useState<BswItem[]>([]);
  const [dateTypes,         setDateTypes]         = useState<DateTypeItem[]>([]);
  const [hypervisors,       setHypervisors]       = useState<HypervisorItem[]>([]);

  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState<string | null>(null);
  const [editState, setEditState] = useState<EditState>(null);

  // Add forms state
  const [newSA,   setNewSA]   = useState("");
  const [newBranch, setNewBranch] = useState({ name: "", code: "", address: "", supportAreaId: "" });
  const [newMfr,  setNewMfr]  = useState("");
  const [newModel, setNewModel] = useState({ name: "", manufacturerId: "" });
  const [newProv, setNewProv] = useState("");
  const [newCC,   setNewCC]   = useState({ code: "", name: "" });
  const [newCIType, setNewCIType] = useState({ name: "", categoryCode: "" });
  const [newDocType, setNewDocType] = useState({ code: "", name: "" });
  const [newLicMetric, setNewLicMetric] = useState<{ catCode: string; code: string; name: string; description: string } | null>(null);
  const [newLicType,   setNewLicType]   = useState<{ catCode: string; code: string; name: string; description: string } | null>(null);
  const [newOs,        setNewOs]        = useState({ name: "", version: "", manufacturerId: "" });
  const [newBsw,       setNewBsw]       = useState({ name: "", version: "", manufacturerId: "" });
  const [newDt,        setNewDt]        = useState({ code: "", name: "", description: "", category: "GENERAL", sortOrder: "0" });
  const [newHv,        setNewHv]        = useState("");


  // EOL catalog search state (Models tab)
  const [eolSearchOpen,    setEolSearchOpen]    = useState(false);
  const [eolQuery,         setEolQuery]         = useState("");
  const [eolSearching,     setEolSearching]     = useState(false);
  const [eolResults,       setEolResults]       = useState<{ product: string; found: boolean; cycles: { cycle: string; eol?: string | boolean | null; support?: string | boolean | null; latest?: string }[]; message?: string } | null>(null);
  const [eolImportMfrId,   setEolImportMfrId]   = useState("");

  // Edit modal state — Models / OS / Base Software share one generic modal
  const [modalEntity, setModalEntity] = useState<null | {
    entity: CatalogEntity;
    entityType: "device-models" | "operating-systems" | "base-software";
    patchUrl: string;
    title: string;
    categoryFilter: "HARDWARE" | "OS" | "SOFTWARE";
    showVersion: boolean;
    manufacturerRequired: boolean;
  }>(null);
  const [newModelType,   setNewModelType]   = useState<"software" | "hardware" | "">("");
  const [suggestedDates, setSuggestedDates] = useState<{ eolDate: string; eosDate: string; label: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [saRes, brRes, mfRes, dmRes, pvRes, ccRes, ctRes, dtRes, lmcRes, ltcRes, osRes, bswRes, dateTypeRes, hvRes] = await Promise.all([
        apiFetch("/api/masters/support-areas"),
        apiFetch("/api/masters/branches"),
        apiFetch("/api/masters/manufacturers"),
        apiFetch("/api/masters/device-models"),
        apiFetch("/api/vendors"),
        apiFetch("/api/masters/cost-centers"),
        apiFetch("/api/masters/ci-type-categories"),
        apiFetch("/api/masters/document-types"),
        apiFetch("/api/masters/license-metric-categories"),
        apiFetch("/api/masters/license-type-categories"),
        apiFetch("/api/catalog/operating-systems"),
        apiFetch("/api/catalog/base-software"),
        apiFetch("/api/catalog/date-types"),
        apiFetch("/api/masters/hypervisors"),
      ]);
      const safe = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
      const saData  = await saRes.json();
      const brData  = await brRes.json();
      const mfData  = await mfRes.json();
      const dmData  = await dmRes.json();
      const pvData  = await pvRes.json();
      const ccData  = await ccRes.json();
      const ctData  = await ctRes.json();
      const dtData  = await dtRes.json();
      const lmcData = await lmcRes.json();
      const ltcData = await ltcRes.json();
      const osData  = await osRes.json();
      const bswData      = await bswRes.json();
      const dateTypeData = await dateTypeRes.json();
      const hvData       = await hvRes.json();
      setSupportAreas(    safe(saData)       as SupportArea[]);
      setBranches(        safe(brData)       as Branch[]);
      setManufacturers(   safe(mfData)       as Manufacturer[]);
      setModels(          safe(dmData)       as DeviceModel[]);
      setProviders(       safe(pvData)       as Provider[]);
      setCostCenters(     safe(ccData)       as CostCenter[]);
      setCiTypeCategories(safe(ctData)       as CITypeCategory[]);
      setDocTypes(        safe(dtData)       as DocumentTypeItem[]);
      setLicenseMetricCats(safe(lmcData)    as LicenseMetricCategory[]);
      setLicenseTypeCats(  safe(ltcData)    as LicenseTypeCategory[]);
      setOperatingSystems( safe(osData)     as OsItem[]);
      setBaseSoftwares(    safe(bswData)    as BswItem[]);
      setDateTypes(        safe(dateTypeData) as DateTypeItem[]);
      setHypervisors(      safe(hvData)       as HypervisorItem[]);
    } catch (e) { setError(e instanceof Error ? e.message : "Error al cargar maestros"); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const del = async (path: string, reload: () => void) => {
    if (!confirm("¿Eliminar este registro?")) return;
    await apiFetch(path, { method: "DELETE" });
    reload();
  };

  const deleteCIType = async (id: string, name: string) => {
    if (!confirm(`¿Eliminar el tipo "${name}"?`)) return;
    const res = await apiFetch(`/api/masters/ci-types/${id}`, { method: "DELETE" });
    if (!res.ok) {
      const d = await res.json().catch(() => ({})) as { error?: string };
      alert(d.error ?? `Error ${res.status}`);
      return;
    }
    load();
  };

  const post = async (path: string, body: Record<string, unknown>) => {
    const res = await apiFetch(path, { method: "POST", body: JSON.stringify(body) });
    if (!res.ok) { const d = await res.json(); throw new Error(d.error ?? `Error ${res.status}`); }
  };

  const patch = async (path: string, body: Record<string, unknown>) => {
    const res = await apiFetch(path, { method: "PATCH", body: JSON.stringify(body) });
    if (!res.ok) { const d = await res.json(); throw new Error(d.error ?? `Error ${res.status}`); }
  };

  // ── Open the shared edit modal for each catalog master ──
  const openModelModal = (m: DeviceModel) => setModalEntity({
    entity: { id: m.id, name: m.name, manufacturerId: m.manufacturer_id, subtitle: m.manufacturer_name },
    entityType: "device-models", patchUrl: `/api/masters/device-models/${m.id}`,
    title: t("masters.models.modal.title"), categoryFilter: "HARDWARE",
    showVersion: false, manufacturerRequired: true,
  });
  const openOsModal = (os: OsItem) => setModalEntity({
    entity: { id: os.id, name: os.name, version: os.version, manufacturerId: os.manufacturer?.id ?? "", isSystem: os.isSystem, subtitle: os.manufacturer?.name },
    entityType: "operating-systems", patchUrl: `/api/catalog/operating-systems/${os.id}`,
    title: t("masters.os.modal_title"), categoryFilter: "OS",
    showVersion: true, manufacturerRequired: false,
  });
  const openBswModal = (sw: BswItem) => setModalEntity({
    entity: { id: sw.id, name: sw.name, version: sw.version, manufacturerId: sw.manufacturer?.id ?? "", isSystem: sw.isSystem, subtitle: sw.manufacturer?.name },
    entityType: "base-software", patchUrl: `/api/catalog/base-software/${sw.id}`,
    title: t("masters.bsw.modal_title"), categoryFilter: "SOFTWARE",
    showVersion: true, manufacturerRequired: false,
  });

  const totalCITypes = ciTypeCategories.reduce((s, c) => s + c.ciTypes.length, 0);

  // ── Tab config ──────────────────────────────────────────────────────────────
  const tabs: { id: TabId; label: string; icon: React.ReactNode; count: number }[] = [
    { id: "support-areas",  label: t('masters.tabs.support_areas'), icon: <MapPin    className="h-4 w-4" />, count: supportAreas.length },
    { id: "branches",       label: t('masters.tabs.branches'),      icon: <Building2 className="h-4 w-4" />, count: branches.length },
    { id: "manufacturers",  label: t('masters.tabs.manufacturers'), icon: <Cpu       className="h-4 w-4" />, count: manufacturers.length },
    { id: "models",         label: t('masters.tabs.models'),        icon: <Layers    className="h-4 w-4" />, count: models.length },
    { id: "providers",      label: "Proveedores",                   icon: <Package   className="h-4 w-4" />, count: providers.length },
    { id: "cost-centers",   label: "Centros de Coste",              icon: <Wallet    className="h-4 w-4" />, count: costCenters.length },
    { id: "ci-types",       label: "Tipos de CI",                   icon: <Tags      className="h-4 w-4" />, count: totalCITypes },
    { id: "doc-types",      label: t('masters.doc_types'),          icon: <FileText  className="h-4 w-4" />, count: docTypes.length },
    { id: "license-metrics",    label: t('masters.license_metrics'),    icon: <Key     className="h-4 w-4" />, count: licenseMetricCats.reduce((s, c) => s + c.metrics.length, 0) },
    { id: "license-types",      label: t('masters.license_types'),      icon: <Key     className="h-4 w-4" />, count: licenseTypeCats.reduce((s, c) => s + c.types.length, 0) },
    { id: "operating-systems",  label: t('masters.operating_systems'),  icon: <Monitor  className="h-4 w-4" />, count: operatingSystems.length },
    { id: "base-software",      label: t('masters.base_software'),      icon: <Package  className="h-4 w-4" />, count: baseSoftwares.length },
    { id: "date-types",         label: t('masters.date_types'),         icon: <Calendar className="h-4 w-4" />, count: dateTypes.length },
    { id: "hypervisors",        label: t('masters.hypervisors'),        icon: <Server   className="h-4 w-4" />, count: hypervisors.length },
  ];

  return (
    <div className="flex flex-col h-screen bg-slate-50 overflow-hidden">

      {/* ── Header ── */}
      <header className="sticky top-0 z-10 flex-shrink-0 border-b border-slate-200 bg-white px-8 py-5">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-slate-900">{t('masters.title')}</h1>
            <p className="text-sm text-slate-500 mt-0.5">{t('masters.subtitle')}</p>
          </div>
          <button onClick={load} disabled={loading} className="flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50 transition-colors disabled:opacity-50">
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />Actualizar
          </button>
        </div>
      </header>

      {/* ── Body: sidebar + content ── */}
      <div className="flex flex-1 overflow-hidden">

        {/* Sidebar nav */}
        <aside className="w-56 flex-shrink-0 bg-white border-r border-slate-200 overflow-y-auto">
          <nav className="py-3">
            {tabs.map((item) => {
              const active = tab === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => setTab(item.id)}
                  className={`w-full flex items-center gap-3 px-5 py-2.5 text-sm font-medium transition-colors text-left ${
                    active
                      ? "bg-[var(--accent)]/5 text-[var(--accent)] border-r-2 border-[var(--accent)]"
                      : "text-slate-600 hover:bg-slate-50 hover:text-slate-900"
                  }`}
                >
                  <span className={active ? "text-[var(--accent)]" : "text-slate-400"}>{item.icon}</span>
                  <span className="flex-1 truncate">{item.label}</span>
                  <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold tabular-nums ${
                    active ? "bg-[var(--accent)]/10 text-[var(--accent)]" : "bg-slate-100 text-slate-500"
                  }`}>{item.count}</span>
                </button>
              );
            })}
          </nav>
        </aside>

        {/* Content area */}
        <main className="flex-1 overflow-y-auto">
          <div className="px-8 py-8">
            {error && (
              <div className="mb-6 flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
                <AlertTriangle className="h-4 w-4 flex-shrink-0" />{error}
              </div>
            )}

        {/* ── Support Areas ── */}
        {tab === "support-areas" && (
          <div className="bg-white shadow-sm ring-1 ring-slate-200 overflow-hidden">
            <div className="border-b border-slate-100 px-6 py-4 bg-slate-50">
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Nueva Área de Soporte</p>
              <div className="flex gap-2 mt-2">
                <Input placeholder="Ej: Zona Centro" value={newSA} onChange={(e) => setNewSA(e.target.value)} />
                <button onClick={async () => { try { await post("/api/masters/support-areas", { name: newSA }); setNewSA(""); load(); } catch (e) { alert(e instanceof Error ? e.message : "Error"); }}}
                  className="flex-shrink-0 flex items-center gap-1.5 rounded-none bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white hover:bg-[var(--accent)]/90 transition-colors">
                  <Plus className="h-4 w-4" />Añadir
                </button>
              </div>
            </div>
            <div className="divide-y divide-slate-50">
              {supportAreas.length === 0 ? <p className="py-8 text-center text-sm text-slate-400">Sin áreas registradas.</p> :
                supportAreas.map((sa) => (
                  <EditableRow key={sa.id} id={sa.id} label={sa.name} editState={editState}
                    onStartEdit={() => setEditState({ kind: "simple", path: "/api/masters/support-areas", id: sa.id, name: sa.name })}
                    onSaveEdit={async (name) => { try { await patch(`/api/masters/support-areas/${sa.id}`, { name }); setEditState(null); load(); } catch (e) { alert(e instanceof Error ? e.message : "Error"); } }}
                    onCancelEdit={() => setEditState(null)}
                    onDelete={() => del(`/api/masters/support-areas/${sa.id}`, load)} />
                ))}
            </div>
          </div>
        )}

        {/* ── Branches ── */}
        {tab === "branches" && (
          <div className="bg-white shadow-sm ring-1 ring-slate-200 overflow-hidden">
            <div className="border-b border-slate-100 px-6 py-4 bg-slate-50 space-y-3">
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Nueva Sede</p>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <Input placeholder="Nombre de la sede" value={newBranch.name} onChange={(e) => setNewBranch((p) => ({ ...p, name: e.target.value }))} />
                <Input placeholder="Código (3 dígitos, ej: MAD)" value={newBranch.code} onChange={(e) => setNewBranch((p) => ({ ...p, code: e.target.value }))} maxLength={10} />
                <Input placeholder="Dirección física (opcional)" value={newBranch.address} onChange={(e) => setNewBranch((p) => ({ ...p, address: e.target.value }))} />
                <Sel value={newBranch.supportAreaId} onChange={(e) => setNewBranch((p) => ({ ...p, supportAreaId: e.target.value }))}>
                  <option value="">— Área de soporte —</option>
                  {supportAreas.map((sa) => <option key={sa.id} value={sa.id}>{sa.name}</option>)}
                </Sel>
              </div>
              <button onClick={async () => { try { await post("/api/masters/branches", { name: newBranch.name, branchCode: newBranch.code, physicalAddress: newBranch.address, supportAreaId: newBranch.supportAreaId }); setNewBranch({ name: "", code: "", address: "", supportAreaId: "" }); load(); } catch (e) { alert(e instanceof Error ? e.message : "Error"); }}}
                className="flex items-center gap-1.5 rounded-none bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white hover:bg-[var(--accent)]/90 transition-colors">
                <Plus className="h-4 w-4" />Añadir Sede
              </button>
            </div>
            <div className="divide-y divide-slate-50">
              {branches.length === 0 ? <p className="py-8 text-center text-sm text-slate-400">Sin sedes registradas.</p> :
                branches.map((b) => {
                  const isEditing = editState?.kind === "branch" && editState.id === b.id;
                  if (isEditing && editState?.kind === "branch") {
                    return (
                      <div key={b.id} className="grid grid-cols-1 gap-2 px-4 py-3 bg-[var(--accent)]/5 border-b border-[var(--accent)]/20 sm:grid-cols-2">
                        <Input value={editState.name} onChange={(e) => setEditState({ ...editState, name: e.target.value })} placeholder="Nombre" />
                        <Input value={editState.code} onChange={(e) => setEditState({ ...editState, code: e.target.value })} placeholder="Código" maxLength={10} />
                        <Input value={editState.address} onChange={(e) => setEditState({ ...editState, address: e.target.value })} placeholder="Dirección (opcional)" />
                        <Sel value={editState.supportAreaId} onChange={(e) => setEditState({ ...editState, supportAreaId: e.target.value })}>
                          <option value="">— Área de soporte —</option>
                          {supportAreas.map((sa) => <option key={sa.id} value={sa.id}>{sa.name}</option>)}
                        </Sel>
                        <div className="flex gap-2 sm:col-span-2">
                          <button onClick={async () => { try { await patch(`/api/masters/branches/${b.id}`, { name: editState.name, branchCode: editState.code, physicalAddress: editState.address, supportAreaId: editState.supportAreaId }); setEditState(null); load(); } catch (e) { alert(e instanceof Error ? e.message : "Error"); }}} className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 transition-colors"><Check className="h-3.5 w-3.5" />Guardar</button>
                          <button onClick={() => setEditState(null)} className="flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-100 transition-colors"><X className="h-3.5 w-3.5" />Cancelar</button>
                        </div>
                      </div>
                    );
                  }
                  return (
                    <div key={b.id} className="flex items-center justify-between px-4 py-2.5 hover:bg-slate-50 transition-colors group">
                      <div>
                        <p className="text-sm font-medium text-slate-700">{b.name} <span className="text-slate-400">({b.branch_code})</span></p>
                        <p className="text-xs text-slate-400">{b.support_area_name}{b.physical_address ? " · " + b.physical_address : ""}</p>
                      </div>
                      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-all">
                        <button onClick={() => setEditState({ kind: "branch", id: b.id, name: b.name, code: b.branch_code, address: b.physical_address ?? "", supportAreaId: b.support_area_id })} className="rounded-none p-1.5 text-[var(--accent)] hover:bg-[var(--accent)]/10 hover:text-[var(--accent)] transition-colors"><Pencil className="h-4 w-4" /></button>
                        <button onClick={() => del(`/api/masters/branches/${b.id}`, load)} className="rounded-lg p-1.5 text-red-400 hover:bg-red-50 hover:text-red-600 transition-colors"><Trash2 className="h-4 w-4" /></button>
                      </div>
                    </div>
                  );
                })}
            </div>
          </div>
        )}

        {/* ── Manufacturers ── */}
        {tab === "manufacturers" && (
          <div className="bg-white shadow-sm ring-1 ring-slate-200 overflow-hidden">
            <div className="border-b border-slate-100 px-6 py-4 bg-slate-50">
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Nuevo Fabricante</p>
              <div className="flex gap-2 mt-2">
                <Input placeholder="Ej: Dell, HP, Cisco" value={newMfr} onChange={(e) => setNewMfr(e.target.value)} />
                <button onClick={async () => { try { await post("/api/masters/manufacturers", { name: newMfr }); setNewMfr(""); load(); } catch (e) { alert(e instanceof Error ? e.message : "Error"); }}}
                  className="flex-shrink-0 flex items-center gap-1.5 rounded-none bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white hover:bg-[var(--accent)]/90 transition-colors">
                  <Plus className="h-4 w-4" />Añadir
                </button>
                <button
                  onClick={async () => {
                    if (!confirm("¿Insertar 30 fabricantes populares de TI? Los duplicados se omitirán.")) return;
                    try {
                      const res = await apiFetch("/api/masters/sync-catalog", { method: "POST", body: JSON.stringify({ action: "sync-manufacturers" }) });
                      const d = await res.json();
                      // Directly re-fetch manufacturers and update state (avoids race with load())
                      const mfrRes  = await apiFetch("/api/masters/manufacturers");
                      const mfrData: unknown = await mfrRes.json();
                      console.log("[CMDB] sync-manufacturers response:", d);
                      console.log("[CMDB] fabricantes recibidos de la API:", mfrData);
                      if (Array.isArray(mfrData)) {
                        setManufacturers(mfrData as Manufacturer[]);
                      } else {
                        console.warn("[CMDB] Respuesta inesperada, iniciando carga completa");
                        await load();
                      }
                      alert(d.message ?? "Sincronización completada");
                    } catch (e) {
                      console.error("[CMDB] Error sync-manufacturers:", e);
                      alert("Error al sincronizar fabricantes");
                    }
                  }}
                  className="flex-shrink-0 flex items-center gap-1.5 rounded-lg bg-amber-500 px-3 py-2 text-sm font-semibold text-white hover:bg-amber-600 transition-colors"
                  title="Inserta fabricantes populares de TI desde catálogo curado"
                >
                  Sugerir Populares
                </button>
                <button
                  onClick={async () => {
                    if (!confirm("Esto eliminará TODOS los fabricantes. ¿Continuar?")) return;
                    try {
                      const res = await apiFetch("/api/masters/manufacturers/all", { method: "DELETE" });
                      const d = await res.json();
                      console.log("[CMDB] delete-all manufacturers response:", d);
                      await load();
                      alert(d.message ?? "Fabricantes eliminados");
                    } catch (e) {
                      console.error("[CMDB] Error delete-all manufacturers:", e);
                      alert("Error al borrar fabricantes");
                    }
                  }}
                  className="flex-shrink-0 flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-2 text-sm font-semibold text-white hover:bg-red-700 transition-colors"
                  title="Eliminar todos los fabricantes"
                >
                  Borrar todo
                </button>
              </div>
            </div>
            <div className="divide-y divide-slate-50">
              {manufacturers.length === 0 ? <p className="py-8 text-center text-sm text-slate-400">Sin fabricantes registrados.</p> :
                manufacturers.map((m) => (
                  <EditableRow key={m.id} id={m.id} label={m.name} editState={editState}
                    onStartEdit={() => setEditState({ kind: "simple", path: "/api/masters/manufacturers", id: m.id, name: m.name })}
                    onSaveEdit={async (name) => { try { await patch(`/api/masters/manufacturers/${m.id}`, { name }); setEditState(null); load(); } catch (e) { alert(e instanceof Error ? e.message : "Error"); } }}
                    onCancelEdit={() => setEditState(null)}
                    onDelete={() => del(`/api/masters/manufacturers/${m.id}`, load)} />
                ))}
            </div>
          </div>
        )}

        {/* ── Device Models ── */}
        {tab === "models" && (
          <div className="space-y-4">

            {/* ── Add Model Form ── */}
            <div className="bg-white shadow-sm ring-1 ring-slate-200 overflow-hidden">
              <div className="border-b border-slate-100 px-6 py-4 bg-slate-50 space-y-3">
                <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Nuevo Modelo</p>

                {/* Row 1: name + manufacturer + type */}
                <div className="flex flex-wrap gap-2">
                  <label className="flex-1 min-w-[160px]">
                    <span className="mb-1 block text-xs font-medium text-slate-500">{t('masters.field.name')}</span>
                    <Input
                      placeholder="Ej: PowerEdge R740"
                      value={newModel.name}
                      onChange={(e) => { setNewModel((p) => ({ ...p, name: e.target.value })); setSuggestedDates(null); }}
                      className="w-full"
                    />
                  </label>
                  <label className="flex-1 min-w-[140px]">
                    <span className="mb-1 block text-xs font-medium text-slate-500">{t('masters.field.manufacturer')}</span>
                    <Sel value={newModel.manufacturerId} onChange={(e) => setNewModel((p) => ({ ...p, manufacturerId: e.target.value }))} className="w-full">
                      <option value="">— Fabricante —</option>
                      {manufacturers.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                    </Sel>
                  </label>
                  <label className="w-36">
                    <span className="mb-1 block text-xs font-medium text-slate-500">{t('masters.field.type')}</span>
                    <Sel value={newModelType} onChange={(e) => { setNewModelType(e.target.value as "software" | "hardware" | ""); setSuggestedDates(null); }} className="w-full">
                      <option value="">— Tipo —</option>
                      <option value="software">Software</option>
                      <option value="hardware">Hardware</option>
                    </Sel>
                  </label>
                </div>

                {/* Row 2: action buttons */}
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={async () => {
                      if (!newModel.name.trim()) { alert("Introduce el nombre del modelo"); return; }
                      try {
                        await post("/api/masters/device-models", { name: newModel.name, manufacturerId: newModel.manufacturerId });
                        setNewModel({ name: "", manufacturerId: "" });
                        setNewModelType("");
                        setSuggestedDates(null);
                        load();
                      } catch (e) { alert(e instanceof Error ? e.message : "Error"); }
                    }}
                    className="flex items-center gap-1.5 rounded-none bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white hover:bg-[var(--accent)]/90 transition-colors">
                    <Plus className="h-4 w-4" />Añadir
                  </button>

                  {/* ✨ Suggest Standard Dates (Tarea 2) */}
                  <button
                    disabled={!newModelType}
                    onClick={() => {
                      if (!newModelType) return;
                      const now     = new Date();
                      const years   = newModelType === "software" ? 2 : 5;
                      const eolDate = new Date(now); eolDate.setFullYear(eolDate.getFullYear() + years);
                      const eosDate = new Date(now); eosDate.setFullYear(eosDate.getFullYear() + years + 1);
                      setSuggestedDates({
                        eolDate: eolDate.toISOString().split("T")[0],
                        eosDate: eosDate.toISOString().split("T")[0],
                        label: newModelType === "software"
                          ? "Software (+2 años estándar de ciclo)"
                          : "Hardware (+5 años garantía + soporte extendido)",
                      });
                    }}
                    title={newModelType ? "Calcular fechas estándar según el tipo" : "Selecciona primero el tipo (Software/Hardware)"}
                    className="flex items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-2 text-sm font-semibold text-white hover:bg-violet-700 transition-colors disabled:opacity-40">
                    Sugerir Fechas Estándar
                  </button>

                  {/* 🔍 EOL Catalog Search */}
                  <button
                    onClick={() => setEolSearchOpen((v) => !v)}
                    className="flex items-center gap-1.5 rounded-lg bg-teal-500 px-3 py-2 text-sm font-semibold text-white hover:bg-teal-600 transition-colors"
                    title="Buscar producto en endoflife.date e importar versiones como modelos">
                    Catálogo EOL
                  </button>
                </div>

                {/* Suggested Dates Banner */}
                {suggestedDates && (
                  <div className="rounded-xl border border-violet-200 bg-violet-50 px-4 py-3 flex items-start justify-between gap-4">
                    <div>
                      <p className="text-xs font-semibold text-violet-700 uppercase tracking-wide mb-1">Fechas Sugeridas</p>
                      <p className="text-sm text-violet-800 font-medium">{suggestedDates.label}</p>
                      <div className="flex gap-4 mt-1 text-xs text-violet-600">
                        <span>EoL estimado: <strong>{suggestedDates.eolDate}</strong></span>
                        <span>EoS estimado: <strong>{suggestedDates.eosDate}</strong></span>
                      </div>
                      <p className="text-xs text-violet-500 mt-1">Estas fechas se calcularán automáticamente al sincronizar EOL. Úsalas como referencia si las fuentes externas no son concluyentes.</p>
                    </div>
                    <button onClick={() => setSuggestedDates(null)} className="text-violet-400 hover:text-violet-600 text-lg leading-none">✕</button>
                  </div>
                )}

                {/* EOL Search Panel */}
                {eolSearchOpen && (
                  <div className="rounded-xl border border-teal-200 bg-teal-50 p-4 space-y-3">
                    <p className="text-xs font-semibold text-teal-700 uppercase tracking-wide">Buscar en endoflife.date</p>
                    <div className="flex gap-2">
                      <Input
                        placeholder="Ej: windows, ubuntu, mysql…"
                        value={eolQuery}
                        onChange={(e) => setEolQuery(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && eolQuery.trim()) {
                            void (async () => {
                              setEolSearching(true); setEolResults(null);
                              try { setEolResults(await (await apiFetch("/api/masters/sync-catalog", { method: "POST", body: JSON.stringify({ action: "search", query: eolQuery }) })).json()); }
                              finally { setEolSearching(false); }
                            })();
                          }
                        }}
                      />
                      <button
                        disabled={eolSearching || !eolQuery.trim()}
                        onClick={async () => {
                          setEolSearching(true); setEolResults(null);
                          try { setEolResults(await (await apiFetch("/api/masters/sync-catalog", { method: "POST", body: JSON.stringify({ action: "search", query: eolQuery }) })).json()); }
                          finally { setEolSearching(false); }
                        }}
                        className="flex-shrink-0 rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700 disabled:opacity-50 transition-colors">
                        {eolSearching ? "…" : "Buscar"}
                      </button>
                    </div>

                    {eolResults && !eolResults.found && (
                      <p className="text-sm text-teal-700">{eolResults.message ?? "No encontrado en endoflife.date"}</p>
                    )}

                    {eolResults?.found && eolResults.cycles.length > 0 && (
                      <div className="space-y-2">
                        <p className="text-xs text-teal-600 font-medium">
                          Producto: <strong>{eolResults.product}</strong> — {eolResults.cycles.length} versiones. Selecciona fabricante e importa:
                        </p>
                        <Sel value={eolImportMfrId} onChange={(e) => setEolImportMfrId(e.target.value)} className="text-xs">
                          <option value="">— Fabricante para importar —</option>
                          {manufacturers.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                        </Sel>
                        <div className="max-h-40 overflow-y-auto divide-y divide-teal-100 rounded-lg border border-teal-200 bg-white">
                          {eolResults.cycles.map((c) => (
                            <div key={c.cycle} className="flex items-center justify-between px-3 py-2">
                              <div>
                                <span className="text-sm font-medium text-slate-700">{eolResults.product} {c.cycle}</span>
                                {c.eol && typeof c.eol === "string" && <span className="ml-2 text-xs text-red-500">EoL: {c.eol}</span>}
                              </div>
                              <button
                                disabled={!eolImportMfrId}
                                onClick={async () => {
                                  try { await post("/api/masters/device-models", { name: `${eolResults.product} ${c.cycle}`, manufacturerId: eolImportMfrId }); load(); }
                                  catch (e) { alert(e instanceof Error ? e.message : "Error al importar"); }
                                }}
                                className="rounded-lg bg-teal-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-teal-700 disabled:opacity-40 transition-colors">
                                Importar
                              </button>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* ── Models list ── */}
            <div className="bg-white shadow-sm ring-1 ring-slate-200 overflow-hidden">
              <div className="divide-y divide-slate-50">
                {models.length === 0 ? <p className="py-8 text-center text-sm text-slate-400">{t("masters.models.empty")}</p> :
                  models.map((m) => (
                    <div
                      key={m.id}
                      className="flex items-center justify-between px-4 py-2.5 transition-colors group cursor-pointer hover:bg-slate-50"
                      onClick={() => openModelModal(m)}
                      title={t("masters.entity_modal.open_hint")}
                    >
                      <div>
                        <p className="text-sm font-medium text-slate-700">{m.name}</p>
                        <p className="text-xs text-slate-400">
                          {m.manufacturer_name}
                          {(m.eolDate || m.eosDate) && (
                            <span className="ml-2 text-slate-500">
                              {m.eolDate && <> · EOL <span className="font-mono text-slate-600">{m.eolDate}</span></>}
                              {m.eosDate && <> · EOS <span className="font-mono text-slate-600">{m.eosDate}</span></>}
                            </span>
                          )}
                        </p>
                      </div>
                      <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                        <button onClick={() => del(`/api/masters/device-models/${m.id}`, load)}
                          className="rounded-lg p-1.5 text-red-400 hover:bg-red-50 hover:text-red-600 transition-colors opacity-0 group-hover:opacity-100"
                          title={t("actions.delete")}>
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                  ))}
              </div>
            </div>
          </div>
        )}

        {/* ── Cost Centers ── */}
        {tab === "cost-centers" && (
          <div className="bg-white shadow-sm ring-1 ring-slate-200 overflow-hidden">
            <div className="border-b border-slate-100 px-6 py-4 bg-slate-50">
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Nuevo Centro de Coste</p>
              <div className="flex gap-2 mt-2">
                <Input placeholder="Código (ej: CC-001)" value={newCC.code} onChange={(e) => setNewCC((p) => ({ ...p, code: e.target.value }))} className="w-36" />
                <Input placeholder="Nombre del centro de coste" value={newCC.name} onChange={(e) => setNewCC((p) => ({ ...p, name: e.target.value }))} />
                <button
                  onClick={async () => {
                    try { await post("/api/masters/cost-centers", { code: newCC.code, name: newCC.name }); setNewCC({ code: "", name: "" }); load(); }
                    catch (e) { alert(e instanceof Error ? e.message : "Error"); }
                  }}
                  className="flex-shrink-0 flex items-center gap-1.5 rounded-none bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white hover:bg-[var(--accent)]/90 transition-colors">
                  <Plus className="h-4 w-4" />Añadir
                </button>
              </div>
            </div>
            <div className="divide-y divide-slate-50">
              {costCenters.length === 0 ? <p className="py-8 text-center text-sm text-slate-400">Sin centros de coste registrados.</p> :
                costCenters.map((cc) => {
                  const isEditing = editState?.kind === "cc" && editState.id === cc.id;
                  if (isEditing && editState?.kind === "cc") {
                    return (
                      <div key={cc.id} className="flex flex-wrap items-center gap-2 px-4 py-3 bg-[var(--accent)]/5 border-b border-[var(--accent)]/20">
                        <Input value={editState.code} onChange={(e) => setEditState({ ...editState, code: e.target.value })} placeholder="Código" className="w-32" />
                        <Input value={editState.name} onChange={(e) => setEditState({ ...editState, name: e.target.value })} placeholder="Nombre" className="flex-1" />
                        <button onClick={async () => { try { await patch(`/api/masters/cost-centers/${cc.id}`, { code: editState.code, name: editState.name }); setEditState(null); load(); } catch (e) { alert(e instanceof Error ? e.message : "Error"); }}} className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 transition-colors"><Check className="h-3.5 w-3.5" />Guardar</button>
                        <button onClick={() => setEditState(null)} className="flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-100 transition-colors"><X className="h-3.5 w-3.5" />Cancelar</button>
                      </div>
                    );
                  }
                  return (
                    <div key={cc.id} className="flex items-center justify-between px-4 py-2.5 hover:bg-slate-50 transition-colors group">
                      <div>
                        <p className="text-sm font-medium text-slate-700">{cc.name}</p>
                        <p className="text-xs text-slate-400 font-mono">{cc.code}</p>
                      </div>
                      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-all">
                        <button onClick={() => setEditState({ kind: "cc", id: cc.id, code: cc.code, name: cc.name })} className="rounded-none p-1.5 text-[var(--accent)] hover:bg-[var(--accent)]/10 hover:text-[var(--accent)] transition-colors"><Pencil className="h-4 w-4" /></button>
                        <button onClick={() => del(`/api/masters/cost-centers/${cc.id}`, load)} className="rounded-lg p-1.5 text-red-400 hover:bg-red-50 hover:text-red-600 transition-colors"><Trash2 className="h-4 w-4" /></button>
                      </div>
                    </div>
                  );
                })}
            </div>
          </div>
        )}

        {/* ── CI Types ── */}
        {tab === "ci-types" && (
          <div className="space-y-6">
            {/* Add new type form */}
            <div className="bg-white shadow-sm ring-1 ring-slate-200 overflow-hidden">
              <div className="border-b border-slate-100 px-6 py-4 bg-slate-50">
                <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Nuevo Tipo de CI</p>
                <p className="text-[11px] text-slate-400 mt-0.5">Las categorías principales son fijas. Solo puedes añadir subcategorías.</p>
                <div className="flex gap-2 mt-2">
                  <Sel value={newCIType.categoryCode} onChange={(e) => setNewCIType((p) => ({ ...p, categoryCode: e.target.value }))} className="w-52">
                    <option value="">— Categoría —</option>
                    {ciTypeCategories.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
                  </Sel>
                  <Input placeholder="Nombre del tipo (ej: Firewall)" value={newCIType.name} onChange={(e) => setNewCIType((p) => ({ ...p, name: e.target.value }))} />
                  <button
                    onClick={async () => {
                      if (!newCIType.categoryCode || !newCIType.name.trim()) { alert("Selecciona categoría e introduce un nombre"); return; }
                      try {
                        await post("/api/masters/ci-types", { name: newCIType.name, categoryCode: newCIType.categoryCode });
                        setNewCIType({ name: "", categoryCode: "" });
                        load();
                      } catch (e) { alert(e instanceof Error ? e.message : "Error"); }
                    }}
                    className="flex-shrink-0 flex items-center gap-1.5 rounded-none bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white hover:bg-[var(--accent)]/90 transition-colors">
                    <Plus className="h-4 w-4" />Añadir
                  </button>
                </div>
              </div>
            </div>

            {/* Categories with their types */}
            {ciTypeCategories.map((cat) => (
              <div key={cat.code} className="bg-white shadow-sm ring-1 ring-slate-200 overflow-hidden">
                <div className="flex items-center gap-3 border-b border-slate-100 bg-slate-50 px-6 py-3">
                  <Tags className="h-4 w-4 text-[var(--accent)]" />
                  <p className="text-sm font-semibold text-slate-700">{cat.name}</p>
                  <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-bold text-slate-600">{cat.ciTypes.length}</span>
                  <span className="ml-auto text-[10px] font-mono text-slate-400">{cat.code}</span>
                </div>
                <div className="divide-y divide-slate-50">
                  {cat.ciTypes.length === 0 ? (
                    <p className="py-6 text-center text-sm text-slate-400">Sin tipos en esta categoría.</p>
                  ) : cat.ciTypes.map((t) => {
                    const isEditing = editState?.kind === "citype" && editState.id === t.id;
                    if (isEditing && editState?.kind === "citype") {
                      return (
                        <div key={t.id} className="flex flex-wrap items-center gap-2 px-4 py-3 bg-[var(--accent)]/5 border-b border-[var(--accent)]/20">
                          <Sel value={editState.categoryCode} onChange={(e) => setEditState({ ...editState, categoryCode: e.target.value })} className="w-44">
                            {ciTypeCategories.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
                          </Sel>
                          <Input value={editState.name} onChange={(e) => setEditState({ ...editState, name: e.target.value })} placeholder="Nombre" className="flex-1 min-w-[160px]" />
                          <button
                            onClick={async () => {
                              try { await patch(`/api/masters/ci-types/${t.id}`, { name: editState.name, categoryCode: editState.categoryCode }); setEditState(null); load(); }
                              catch (e) { alert(e instanceof Error ? e.message : "Error"); }
                            }}
                            className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 transition-colors">
                            <Check className="h-3.5 w-3.5" />Guardar
                          </button>
                          <button onClick={() => setEditState(null)} className="flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-100 transition-colors"><X className="h-3.5 w-3.5" />Cancelar</button>
                        </div>
                      );
                    }
                    return (
                      <div key={t.id} className="flex items-center justify-between px-4 py-2.5 hover:bg-slate-50 transition-colors group">
                        <div className="flex items-center gap-3">
                          {t.isSystem && <span title="Tipo de sistema — no se puede eliminar"><Lock className="h-3 w-3 text-slate-300 flex-shrink-0" /></span>}
                          <div>
                            <p className="text-sm font-medium text-slate-700">{t.name}</p>
                            <p className="text-xs font-mono text-slate-400">{t.code}</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-all">
                          <button
                            onClick={() => setEditState({ kind: "citype", id: t.id, name: t.name, categoryCode: t.categoryCode })}
                            className="rounded-none p-1.5 text-[var(--accent)] hover:bg-[var(--accent)]/10 hover:text-[var(--accent)] transition-colors"
                            title="Editar nombre o categoría">
                            <Pencil className="h-4 w-4" />
                          </button>
                          <button
                            onClick={() => deleteCIType(t.id, t.name)}
                            className="rounded-lg p-1.5 text-red-400 hover:bg-red-50 hover:text-red-600 transition-colors"
                            title="Eliminar tipo">
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ── Providers ── */}
        {tab === "providers" && (
          <div className="bg-white shadow-sm ring-1 ring-slate-200 overflow-hidden">
            <div className="border-b border-slate-100 px-6 py-4 bg-slate-50">
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Nuevo Proveedor</p>
              <div className="flex gap-2 mt-2">
                <Input placeholder="Ej: Telefónica, AWS, Microsoft" value={newProv} onChange={(e) => setNewProv(e.target.value)} />
                <button onClick={async () => { try { await post("/api/vendors", { name: newProv }); setNewProv(""); load(); } catch (e) { alert(e instanceof Error ? e.message : "Error"); }}}
                  className="flex-shrink-0 flex items-center gap-1.5 rounded-none bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white hover:bg-[var(--accent)]/90 transition-colors">
                  <Plus className="h-4 w-4" />Añadir
                </button>
              </div>
            </div>
            <div className="divide-y divide-slate-50">
              {providers.length === 0 ? <p className="py-8 text-center text-sm text-slate-400">Sin proveedores registrados.</p> :
                providers.map((p) => (
                  <EditableRow key={p.id} id={p.id} label={p.name} editState={editState}
                    onStartEdit={() => setEditState({ kind: "simple", path: "/api/vendors", id: p.id, name: p.name })}
                    onSaveEdit={async (name) => { try { await patch(`/api/vendors/${p.id}`, { name }); setEditState(null); load(); } catch (e) { alert(e instanceof Error ? e.message : "Error"); } }}
                    onCancelEdit={() => setEditState(null)}
                    onDelete={() => del(`/api/vendors/${p.id}`, load)} />
                ))}
            </div>
          </div>
        )}

        {/* ── Document Types ── */}
        {tab === "doc-types" && (
          <div className="bg-white shadow-sm ring-1 ring-slate-200 overflow-hidden">
            <div className="border-b border-slate-100 px-6 py-4 bg-slate-50">
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Nuevo Tipo de Documento</p>
              <div className="flex gap-2 mt-2">
                <Input
                  placeholder="Código (ej: POLICY)"
                  value={newDocType.code}
                  onChange={(e) => setNewDocType((p) => ({ ...p, code: e.target.value.toUpperCase() }))}
                  className="w-40"
                />
                <Input
                  placeholder="Nombre (ej: Política)"
                  value={newDocType.name}
                  onChange={(e) => setNewDocType((p) => ({ ...p, name: e.target.value }))}
                />
                <button
                  onClick={async () => {
                    if (!newDocType.code.trim() || !newDocType.name.trim()) { alert("Introduce código y nombre"); return; }
                    try {
                      await post("/api/masters/document-types", { code: newDocType.code.trim(), name: newDocType.name.trim() });
                      setNewDocType({ code: "", name: "" });
                      load();
                    } catch (e) { alert(e instanceof Error ? e.message : "Error"); }
                  }}
                  className="flex-shrink-0 flex items-center gap-1.5 rounded-none bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white hover:bg-[var(--accent)]/90 transition-colors"
                >
                  <Plus className="h-4 w-4" />Añadir
                </button>
              </div>
            </div>
            <div className="divide-y divide-slate-50">
              {docTypes.length === 0 ? (
                <p className="py-8 text-center text-sm text-slate-400">Sin tipos de documento registrados.</p>
              ) : (
                docTypes.map((dt) => {
                  const isEditing = editState?.kind === "doctype" && editState.id === dt.id;
                  if (isEditing && editState?.kind === "doctype") {
                    return (
                      <div key={dt.id} className="flex items-center gap-2 px-4 py-2 bg-[var(--accent)]/5 border-b border-[var(--accent)]/20">
                        <Input
                          value={editState.name}
                          onChange={(e) => setEditState({ ...editState, name: e.target.value })}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              void (async () => {
                                try { await patch(`/api/masters/document-types/${dt.id}`, { name: editState.name }); setEditState(null); load(); }
                                catch (err) { alert(err instanceof Error ? err.message : "Error"); }
                              })();
                            }
                            if (e.key === "Escape") setEditState(null);
                          }}
                          autoFocus
                          className="flex-1"
                        />
                        <button
                          onClick={async () => {
                            try { await patch(`/api/masters/document-types/${dt.id}`, { name: editState.name }); setEditState(null); load(); }
                            catch (e) { alert(e instanceof Error ? e.message : "Error"); }
                          }}
                          className="rounded-lg p-1.5 text-emerald-600 hover:bg-emerald-50 transition-colors"
                        >
                          <Check className="h-4 w-4" />
                        </button>
                        <button onClick={() => setEditState(null)} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 transition-colors">
                          <X className="h-4 w-4" />
                        </button>
                      </div>
                    );
                  }
                  return (
                    <div key={dt.id} className="flex items-center justify-between px-4 py-2.5 hover:bg-slate-50 transition-colors group">
                      <div className="flex items-center gap-3">
                        {dt.isSystem && (
                          <span title="Tipo de sistema — no se puede editar ni eliminar">
                            <Lock className="h-3 w-3 text-slate-300 flex-shrink-0" />
                          </span>
                        )}
                        <div>
                          <p className="text-sm font-medium text-slate-700">{dt.name}</p>
                          <p className="text-xs font-mono text-slate-400">{dt.code}</p>
                        </div>
                      </div>
                      {!dt.isSystem && (
                        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-all">
                          <button
                            onClick={() => setEditState({ kind: "doctype", id: dt.id, name: dt.name })}
                            className="rounded-none p-1.5 text-[var(--accent)] hover:bg-[var(--accent)]/10 hover:text-[var(--accent)] transition-colors"
                          >
                            <Pencil className="h-4 w-4" />
                          </button>
                          <button
                            onClick={async () => {
                              if (!confirm(`¿Eliminar el tipo "${dt.name}"?`)) return;
                              try {
                                const res = await apiFetch(`/api/masters/document-types/${dt.id}`, { method: "DELETE" });
                                if (!res.ok) {
                                  const d = await res.json().catch(() => ({})) as { error?: string };
                                  alert(d.error ?? `Error ${res.status}`);
                                  return;
                                }
                                load();
                              } catch (e) { alert(e instanceof Error ? e.message : "Error"); }
                            }}
                            className="rounded-lg p-1.5 text-red-400 hover:bg-red-50 hover:text-red-600 transition-colors"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        )}
        {/* ── License Metrics ── */}
        {tab === "license-metrics" && (
          <div className="space-y-6">
            {licenseMetricCats.map((cat) => {
              const isAddingHere = newLicMetric?.catCode === cat.code;
              return (
                <div key={cat.code} className="bg-white shadow-sm ring-1 ring-slate-200 overflow-hidden">
                  {/* Category header */}
                  <div className="flex items-center gap-3 border-b border-slate-100 bg-slate-50 px-6 py-3">
                    <Key className="h-4 w-4 text-[var(--accent)]" />
                    <p className="text-sm font-semibold text-slate-700">{cat.name}</p>
                    <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-bold text-slate-600">{cat.metrics.length}</span>
                    <span className="text-[10px] font-mono text-slate-400">{cat.code}</span>
                    <button
                      onClick={() => setNewLicMetric(isAddingHere ? null : { catCode: cat.code, code: "", name: "", description: "" })}
                      className="ml-auto flex items-center gap-1.5 rounded-none border border-[var(--accent)]/20 bg-[var(--accent)]/5 px-3 py-1 text-xs font-semibold text-[var(--accent)] hover:bg-[var(--accent)]/10 transition-colors"
                    >
                      <Plus className="h-3.5 w-3.5" />{isAddingHere ? "Cancelar" : "Nueva métrica"}
                    </button>
                  </div>

                  <div className="divide-y divide-slate-50">
                    {/* Rows */}
                    {cat.metrics.length === 0 && !isAddingHere && (
                      <p className="py-6 text-center text-sm text-slate-400">Sin métricas en esta categoría.</p>
                    )}
                    {cat.metrics.map((m) => {
                      const isEditing = editState?.kind === "licmetric" && editState.id === m.id;
                      if (isEditing && editState?.kind === "licmetric") {
                        return (
                          <div key={m.id} className="px-4 py-3 bg-[var(--accent)]/5 border-b border-[var(--accent)]/20 space-y-2">
                            <Input
                              value={editState.name}
                              onChange={(e) => setEditState({ ...editState, name: e.target.value })}
                              placeholder="Nombre"
                              autoFocus
                            />
                            <Input
                              value={editState.description}
                              onChange={(e) => setEditState({ ...editState, description: e.target.value })}
                              placeholder="Descripción (opcional)"
                            />
                            <div className="flex gap-2">
                              <button
                                onClick={async () => {
                                  try {
                                    await patch(`/api/masters/license-metrics/${m.id}`, { name: editState.name, description: editState.description });
                                    setEditState(null); load();
                                  } catch (e) { alert(e instanceof Error ? e.message : "Error"); }
                                }}
                                className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 transition-colors"
                              ><Check className="h-3.5 w-3.5" />Guardar</button>
                              <button onClick={() => setEditState(null)} className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs text-slate-500 hover:bg-slate-50 transition-colors">Cancelar</button>
                            </div>
                          </div>
                        );
                      }
                      return (
                        <div key={m.id} className="flex items-start justify-between px-4 py-3 hover:bg-slate-50 transition-colors group">
                          <div className="flex items-start gap-3 min-w-0">
                            {m.isSystem
                              ? <span title="Métrica de sistema — solo lectura"><Lock className="h-3 w-3 text-slate-300 flex-shrink-0 mt-0.5" /></span>
                              : <span className="h-3 w-3 flex-shrink-0 mt-0.5" />
                            }
                            <div className="min-w-0">
                              <p className="text-sm font-medium text-slate-700">{m.name}</p>
                              <p className="text-xs font-mono text-slate-400">{m.code}</p>
                              {m.description && <p className="text-xs text-slate-500 mt-0.5 leading-relaxed">{m.description}</p>}
                            </div>
                          </div>
                          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-all flex-shrink-0">
                            <button
                              onClick={() => setEditState({ kind: "licmetric", id: m.id, name: m.name, description: m.description ?? "" })}
                              className="rounded-none p-1.5 text-[var(--accent)] hover:bg-[var(--accent)]/10 hover:text-[var(--accent)] transition-colors"
                            ><Pencil className="h-4 w-4" /></button>
                            <button
                              onClick={async () => {
                                if (!confirm(`¿Eliminar la métrica "${m.name}"?`)) return;
                                const res = await apiFetch(`/api/masters/license-metrics/${m.id}`, { method: "DELETE" });
                                if (!res.ok) { const d = await res.json().catch(() => ({})) as { error?: string }; alert(d.error ?? `Error ${res.status}`); return; }
                                load();
                              }}
                              className="rounded-lg p-1.5 text-red-400 hover:bg-red-50 hover:text-red-600 transition-colors"
                            ><Trash2 className="h-4 w-4" /></button>
                          </div>
                        </div>
                      );
                    })}

                    {/* Inline create form */}
                    {isAddingHere && newLicMetric && (
                      <div className="px-4 py-3 bg-emerald-50 border-t border-emerald-100 space-y-2">
                        <p className="text-xs font-semibold text-emerald-700 uppercase tracking-wider">Nueva métrica en {cat.name}</p>
                        <div className="flex gap-2">
                          <Input
                            placeholder="Código (ej: NAMED_USER)"
                            value={newLicMetric.code}
                            onChange={(e) => setNewLicMetric({ ...newLicMetric, code: e.target.value.toUpperCase() })}
                            className="w-44"
                          />
                          <Input
                            placeholder="Nombre"
                            value={newLicMetric.name}
                            onChange={(e) => setNewLicMetric({ ...newLicMetric, name: e.target.value })}
                          />
                        </div>
                        <Input
                          placeholder="Descripción (opcional)"
                          value={newLicMetric.description}
                          onChange={(e) => setNewLicMetric({ ...newLicMetric, description: e.target.value })}
                        />
                        <div className="flex gap-2">
                          <button
                            onClick={async () => {
                              if (!newLicMetric.code.trim() || !newLicMetric.name.trim()) { alert("Código y nombre son obligatorios"); return; }
                              try {
                                await post("/api/masters/license-metrics", {
                                  code: newLicMetric.code.trim(),
                                  name: newLicMetric.name.trim(),
                                  categoryCode: cat.code,
                                  description: newLicMetric.description.trim() || undefined,
                                });
                                setNewLicMetric(null); load();
                              } catch (e) { alert(e instanceof Error ? e.message : "Error"); }
                            }}
                            className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 transition-colors"
                          ><Plus className="h-3.5 w-3.5" />Crear</button>
                          <button onClick={() => setNewLicMetric(null)} className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs text-slate-500 hover:bg-slate-50 transition-colors">Cancelar</button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* ── License Types ── */}
        {tab === "license-types" && (
          <div className="space-y-6">
            {licenseTypeCats.map((cat) => {
              const isAddingHere = newLicType?.catCode === cat.code;
              return (
                <div key={cat.code} className="bg-white shadow-sm ring-1 ring-slate-200 overflow-hidden">
                  {/* Category header */}
                  <div className="flex items-center gap-3 border-b border-slate-100 bg-slate-50 px-6 py-3">
                    <FileText className="h-4 w-4 text-[var(--accent)]" />
                    <p className="text-sm font-semibold text-slate-700">{cat.name}</p>
                    <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-bold text-slate-600">{cat.types.length}</span>
                    <span className="text-[10px] font-mono text-slate-400">{cat.code}</span>
                    <button
                      onClick={() => setNewLicType(isAddingHere ? null : { catCode: cat.code, code: "", name: "", description: "" })}
                      className="ml-auto flex items-center gap-1.5 rounded-none border border-[var(--accent)]/20 bg-[var(--accent)]/5 px-3 py-1 text-xs font-semibold text-[var(--accent)] hover:bg-[var(--accent)]/10 transition-colors"
                    >
                      <Plus className="h-3.5 w-3.5" />{isAddingHere ? "Cancelar" : "Nuevo tipo"}
                    </button>
                  </div>

                  <div className="divide-y divide-slate-50">
                    {/* Rows */}
                    {cat.types.length === 0 && !isAddingHere && (
                      <p className="py-6 text-center text-sm text-slate-400">Sin tipos en esta categoría.</p>
                    )}
                    {cat.types.map((tp) => {
                      const isEditing = editState?.kind === "lictype" && editState.id === tp.id;
                      if (isEditing && editState?.kind === "lictype") {
                        return (
                          <div key={tp.id} className="px-4 py-3 bg-[var(--accent)]/5 border-b border-[var(--accent)]/20 space-y-2">
                            <Input
                              value={editState.name}
                              onChange={(e) => setEditState({ ...editState, name: e.target.value })}
                              placeholder="Nombre"
                              autoFocus
                            />
                            <Input
                              value={editState.description}
                              onChange={(e) => setEditState({ ...editState, description: e.target.value })}
                              placeholder="Descripción (opcional)"
                            />
                            <div className="flex gap-2">
                              <button
                                onClick={async () => {
                                  try {
                                    await patch(`/api/masters/license-types/${tp.id}`, { name: editState.name, description: editState.description });
                                    setEditState(null); load();
                                  } catch (e) { alert(e instanceof Error ? e.message : "Error"); }
                                }}
                                className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 transition-colors"
                              ><Check className="h-3.5 w-3.5" />Guardar</button>
                              <button onClick={() => setEditState(null)} className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs text-slate-500 hover:bg-slate-50 transition-colors">Cancelar</button>
                            </div>
                          </div>
                        );
                      }
                      return (
                        <div key={tp.id} className="flex items-start justify-between px-4 py-3 hover:bg-slate-50 transition-colors group">
                          <div className="flex items-start gap-3 min-w-0">
                            {tp.isSystem
                              ? <span title="Tipo de sistema — solo lectura"><Lock className="h-3 w-3 text-slate-300 flex-shrink-0 mt-0.5" /></span>
                              : <span className="h-3 w-3 flex-shrink-0 mt-0.5" />
                            }
                            <div className="min-w-0">
                              <p className="text-sm font-medium text-slate-700">{tp.name}</p>
                              <p className="text-xs font-mono text-slate-400">{tp.code}</p>
                              {tp.description && <p className="text-xs text-slate-500 mt-0.5 leading-relaxed">{tp.description}</p>}
                            </div>
                          </div>
                          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-all flex-shrink-0">
                            <button
                              onClick={() => setEditState({ kind: "lictype", id: tp.id, name: tp.name, description: tp.description ?? "" })}
                              className="rounded-none p-1.5 text-[var(--accent)] hover:bg-[var(--accent)]/10 hover:text-[var(--accent)] transition-colors"
                            ><Pencil className="h-4 w-4" /></button>
                            <button
                              onClick={async () => {
                                if (!confirm(`¿Eliminar el tipo "${tp.name}"?`)) return;
                                const res = await apiFetch(`/api/masters/license-types/${tp.id}`, { method: "DELETE" });
                                if (!res.ok) { const d = await res.json().catch(() => ({})) as { error?: string }; alert(d.error ?? `Error ${res.status}`); return; }
                                load();
                              }}
                              className="rounded-lg p-1.5 text-red-400 hover:bg-red-50 hover:text-red-600 transition-colors"
                            ><Trash2 className="h-4 w-4" /></button>
                          </div>
                        </div>
                      );
                    })}

                    {/* Inline create form */}
                    {isAddingHere && newLicType && (
                      <div className="px-4 py-3 bg-emerald-50 border-t border-emerald-100 space-y-2">
                        <p className="text-xs font-semibold text-emerald-700 uppercase tracking-wider">Nuevo tipo en {cat.name}</p>
                        <div className="flex gap-2">
                          <Input
                            placeholder="Código (ej: SAAS)"
                            value={newLicType.code}
                            onChange={(e) => setNewLicType({ ...newLicType, code: e.target.value.toUpperCase() })}
                            className="w-44"
                          />
                          <Input
                            placeholder="Nombre"
                            value={newLicType.name}
                            onChange={(e) => setNewLicType({ ...newLicType, name: e.target.value })}
                          />
                        </div>
                        <Input
                          placeholder="Descripción (opcional)"
                          value={newLicType.description}
                          onChange={(e) => setNewLicType({ ...newLicType, description: e.target.value })}
                        />
                        <div className="flex gap-2">
                          <button
                            onClick={async () => {
                              if (!newLicType.code.trim() || !newLicType.name.trim()) { alert("Código y nombre son obligatorios"); return; }
                              try {
                                await post("/api/masters/license-types", {
                                  code: newLicType.code.trim(),
                                  name: newLicType.name.trim(),
                                  categoryCode: cat.code,
                                  description: newLicType.description.trim() || undefined,
                                });
                                setNewLicType(null); load();
                              } catch (e) { alert(e instanceof Error ? e.message : "Error"); }
                            }}
                            className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 transition-colors"
                          ><Plus className="h-3.5 w-3.5" />Crear</button>
                          <button onClick={() => setNewLicType(null)} className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs text-slate-500 hover:bg-slate-50 transition-colors">Cancelar</button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* ── Operating Systems ── */}
        {tab === "operating-systems" && (
          <div className="bg-white shadow-sm ring-1 ring-slate-200 overflow-hidden">
            <div className="border-b border-slate-100 px-6 py-4 bg-slate-50 space-y-3">
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">{t('masters.os.new')}</p>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-slate-500">{t('masters.field.name')}</span>
                  <Input
                    placeholder={t('masters.os.name_placeholder')}
                    value={newOs.name}
                    onChange={(e) => setNewOs((p) => ({ ...p, name: e.target.value }))}
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-slate-500">{t('masters.field.version')}</span>
                  <Input
                    placeholder={t('masters.os.version_placeholder')}
                    value={newOs.version}
                    onChange={(e) => setNewOs((p) => ({ ...p, version: e.target.value }))}
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-slate-500">{t('masters.field.manufacturer')}</span>
                  <Sel
                    value={newOs.manufacturerId}
                    onChange={(e) => setNewOs((p) => ({ ...p, manufacturerId: e.target.value }))}
                  >
                    <option value="">{t('masters.os.manufacturer_label')}</option>
                    {manufacturers.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </Sel>
                </label>
              </div>
              <button
                onClick={async () => {
                  if (!newOs.name.trim()) { alert("El nombre es obligatorio"); return; }
                  try {
                    await post("/api/catalog/operating-systems", {
                      name          : newOs.name.trim(),
                      version       : newOs.version.trim() || undefined,
                      manufacturerId: newOs.manufacturerId || undefined,
                    });
                    setNewOs({ name: "", version: "", manufacturerId: "" });
                    load();
                  } catch (e) { alert(e instanceof Error ? e.message : "Error"); }
                }}
                className="flex items-center gap-1.5 rounded-none bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white hover:bg-[var(--accent)]/90 transition-colors"
              >
                <Plus className="h-4 w-4" />{t('masters.os.add')}
              </button>
            </div>
            <div className="divide-y divide-slate-50">
              {operatingSystems.length === 0 ? (
                <p className="py-8 text-center text-sm text-slate-400">{t('masters.os.empty')}</p>
              ) : operatingSystems.map((os) => (
                <div
                  key={os.id}
                  className="flex items-center justify-between px-4 py-2.5 transition-colors group cursor-pointer hover:bg-slate-50"
                  onClick={() => openOsModal(os)}
                  title={t("masters.entity_modal.open_hint")}
                >
                  <div>
                    <p className="text-sm font-medium text-slate-700">
                      {os.name}
                      {os.version && <span className="ml-1.5 text-xs text-slate-400">{os.version}</span>}
                      {os.isSystem && <span className="ml-2 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500 uppercase">{t('masters.os.system')}</span>}
                    </p>
                    {os.manufacturer && <p className="text-xs text-slate-400">{os.manufacturer.name}</p>}
                    <p className="text-[10px] font-mono text-slate-300">{os.code}</p>
                  </div>
                  {!os.isSystem && (
                    <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                      <button
                        onClick={async () => {
                          if (!confirm(`¿Eliminar "${os.name}"?`)) return;
                          const res = await apiFetch(`/api/catalog/operating-systems/${os.id}`, { method: "DELETE" });
                          if (!res.ok) { const d = await res.json().catch(() => ({})) as { error?: string }; alert(d.error ?? `Error ${res.status}`); return; }
                          load();
                        }}
                        className="rounded-lg p-1.5 text-red-400 hover:bg-red-50 hover:text-red-600 transition-colors opacity-0 group-hover:opacity-100"
                        title={t("actions.delete")}
                      ><Trash2 className="h-4 w-4" /></button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Base Software ── */}
        {tab === "base-software" && (
          <div className="bg-white shadow-sm ring-1 ring-slate-200 overflow-hidden">
            <div className="border-b border-slate-100 px-6 py-4 bg-slate-50 space-y-3">
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">{t('masters.bsw.new')}</p>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-slate-500">{t('masters.field.name')}</span>
                  <Input
                    placeholder={t('masters.bsw.name_placeholder')}
                    value={newBsw.name}
                    onChange={(e) => setNewBsw((p) => ({ ...p, name: e.target.value }))}
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-slate-500">{t('masters.field.version')}</span>
                  <Input
                    placeholder={t('masters.bsw.version_placeholder')}
                    value={newBsw.version}
                    onChange={(e) => setNewBsw((p) => ({ ...p, version: e.target.value }))}
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-slate-500">{t('masters.field.manufacturer')}</span>
                  <Sel
                    value={newBsw.manufacturerId}
                    onChange={(e) => setNewBsw((p) => ({ ...p, manufacturerId: e.target.value }))}
                  >
                    <option value="">{t('masters.os.manufacturer_label')}</option>
                    {manufacturers.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </Sel>
                </label>
              </div>
              <button
                onClick={async () => {
                  if (!newBsw.name.trim()) { alert("El nombre es obligatorio"); return; }
                  try {
                    await post("/api/catalog/base-software", {
                      name          : newBsw.name.trim(),
                      version       : newBsw.version.trim() || undefined,
                      manufacturerId: newBsw.manufacturerId || undefined,
                    });
                    setNewBsw({ name: "", version: "", manufacturerId: "" });
                    load();
                  } catch (e) { alert(e instanceof Error ? e.message : "Error"); }
                }}
                className="flex items-center gap-1.5 rounded-none bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white hover:bg-[var(--accent)]/90 transition-colors"
              >
                <Plus className="h-4 w-4" />{t('masters.os.add')}
              </button>
            </div>
            <div className="divide-y divide-slate-50">
              {baseSoftwares.length === 0 ? (
                <p className="py-8 text-center text-sm text-slate-400">{t('masters.bsw.empty')}</p>
              ) : baseSoftwares.map((sw) => (
                <div
                  key={sw.id}
                  className="flex items-center justify-between px-4 py-2.5 transition-colors group cursor-pointer hover:bg-slate-50"
                  onClick={() => openBswModal(sw)}
                  title={t("masters.entity_modal.open_hint")}
                >
                  <div>
                    <p className="text-sm font-medium text-slate-700">
                      {sw.name}
                      {sw.version && <span className="ml-1.5 text-xs text-slate-400">{sw.version}</span>}
                      {sw.isSystem && <span className="ml-2 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500 uppercase">{t('masters.os.system')}</span>}
                    </p>
                    {sw.manufacturer && <p className="text-xs text-slate-400">{sw.manufacturer.name}</p>}
                    <p className="text-[10px] font-mono text-slate-300">{sw.code}</p>
                  </div>
                  {!sw.isSystem && (
                    <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                      <button
                        onClick={async () => {
                          if (!confirm(`¿Eliminar "${sw.name}"?`)) return;
                          const res = await apiFetch(`/api/catalog/base-software/${sw.id}`, { method: "DELETE" });
                          if (!res.ok) { const d = await res.json().catch(() => ({})) as { error?: string }; alert(d.error ?? `Error ${res.status}`); return; }
                          load();
                        }}
                        className="rounded-lg p-1.5 text-red-400 hover:bg-red-50 hover:text-red-600 transition-colors opacity-0 group-hover:opacity-100"
                        title={t("actions.delete")}
                      ><Trash2 className="h-4 w-4" /></button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Date Types ── */}
        {tab === "date-types" && (
          <div className="bg-white shadow-sm ring-1 ring-slate-200 overflow-hidden">

            {/* Add form */}
            <div className="border-b border-slate-100 px-6 py-4 bg-slate-50 space-y-3">
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">{t('masters.dt.new')}</p>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-slate-500">{t('masters.field.code')}</span>
                  <Input
                    placeholder={t('masters.dt.code_placeholder')}
                    value={newDt.code}
                    onChange={(e) => setNewDt((p) => ({ ...p, code: e.target.value }))}
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-slate-500">{t('masters.field.name')}</span>
                  <Input
                    placeholder={t('masters.dt.name_placeholder')}
                    value={newDt.name}
                    onChange={(e) => setNewDt((p) => ({ ...p, name: e.target.value }))}
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-slate-500">{t('masters.field.category')}</span>
                  <Sel
                    value={newDt.category}
                    onChange={(e) => setNewDt((p) => ({ ...p, category: e.target.value }))}
                  >
                    <option value="GENERAL">{t('masters.dt.category_general')}</option>
                    <option value="HARDWARE">{t('masters.dt.category_hardware')}</option>
                    <option value="SOFTWARE">{t('masters.dt.category_software')}</option>
                    <option value="OS">{t('masters.dt.category_os')}</option>
                  </Sel>
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-slate-500">{t('masters.field.sort_order')}</span>
                  <Input
                    type="number"
                    min="0"
                    placeholder={t('masters.dt.sort_order_placeholder')}
                    value={newDt.sortOrder}
                    onChange={(e) => setNewDt((p) => ({ ...p, sortOrder: e.target.value }))}
                  />
                </label>
              </div>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-slate-500">{t('masters.field.description')}</span>
                <Input
                  placeholder={t('masters.dt.description_placeholder')}
                  value={newDt.description}
                  onChange={(e) => setNewDt((p) => ({ ...p, description: e.target.value }))}
                />
              </label>
              <button
                onClick={async () => {
                  if (!newDt.code.trim() || !newDt.name.trim()) { alert("Código y nombre son obligatorios"); return; }
                  try {
                    await post("/api/catalog/date-types", {
                      code       : newDt.code.trim(),
                      name       : newDt.name.trim(),
                      description: newDt.description.trim() || null,
                      category   : newDt.category,
                      sortOrder  : parseInt(newDt.sortOrder, 10) || 0,
                    });
                    setNewDt({ code: "", name: "", description: "", category: "GENERAL", sortOrder: "0" });
                    load();
                  } catch (e) { alert(e instanceof Error ? e.message : "Error"); }
                }}
                className="flex items-center gap-2 rounded-none border border-[var(--accent)] bg-[var(--accent)] px-4 py-2 text-xs font-medium text-white hover:opacity-90 transition-opacity"
              >
                <Plus className="h-4 w-4" />{t('masters.dt.add')}
              </button>
            </div>

            {/* List grouped by category */}
            <div className="divide-y divide-slate-100">
              {(["GENERAL", "HARDWARE", "SOFTWARE", "OS"] as const).map((cat) => {
                const rows = dateTypes.filter((d) => d.category === cat);
                const catLabel: Record<string, string> = {
                  GENERAL: t('masters.dt.category_general'),
                  HARDWARE: t('masters.dt.category_hardware'),
                  SOFTWARE: t('masters.dt.category_software'),
                  OS: t('masters.dt.category_os'),
                };
                return (
                  <div key={cat}>
                    <div className="flex items-center gap-2 bg-slate-50 px-6 py-2 border-b border-slate-100">
                      <Calendar className="h-3.5 w-3.5 text-slate-400" />
                      <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">{catLabel[cat]}</span>
                      <span className="ml-auto text-xs text-slate-400">{rows.length}</span>
                    </div>
                    {rows.length === 0 && (
                      <p className="px-6 py-3 text-sm text-slate-400 italic">{t('masters.dt.empty')}</p>
                    )}
                    {rows.map((dt) => {
                      const isEditing = editState !== null && editState.kind === "datetype" && editState.id === dt.id;
                      if (isEditing && editState && editState.kind === "datetype") {
                        return (
                          <div key={dt.id} className="px-4 py-3 bg-[var(--accent)]/5 border-b border-[var(--accent)]/20 space-y-2">
                            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                              <Input
                                value={editState.name}
                                onChange={(e) => setEditState((p) => p && p.kind === "datetype" ? { ...p, name: e.target.value } : p)}
                                placeholder={t('masters.dt.name_placeholder')}
                              />
                              <Input
                                value={editState.description}
                                onChange={(e) => setEditState((p) => p && p.kind === "datetype" ? { ...p, description: e.target.value } : p)}
                                placeholder={t('masters.dt.description_placeholder')}
                              />
                              <Input
                                type="number"
                                min="0"
                                value={editState.sortOrder}
                                onChange={(e) => setEditState((p) => p && p.kind === "datetype" ? { ...p, sortOrder: e.target.value } : p)}
                                placeholder={t('masters.dt.sort_order_placeholder')}
                              />
                            </div>
                            <div className="flex gap-2">
                              <button
                                onClick={async () => {
                                  if (!editState || editState.kind !== "datetype") return;
                                  try {
                                    await patch(`/api/catalog/date-types/${editState.id}`, {
                                      name       : editState.name.trim(),
                                      description: editState.description.trim() || null,
                                      sortOrder  : parseInt(editState.sortOrder, 10) || 0,
                                    });
                                    setEditState(null); load();
                                  } catch (e) { alert(e instanceof Error ? e.message : "Error"); }
                                }}
                                className="rounded-lg p-1.5 text-emerald-600 hover:bg-emerald-50 transition-colors"
                              ><Check className="h-4 w-4" /></button>
                              <button onClick={() => setEditState(null)} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 transition-colors"><X className="h-4 w-4" /></button>
                            </div>
                          </div>
                        );
                      }
                      return (
                        <div key={dt.id} className="flex items-center justify-between px-4 py-2.5 hover:bg-slate-50 transition-colors group">
                          <div>
                            <p className="text-sm font-medium text-slate-700">
                              {dt.name}
                              {dt.isSystem && <span className="ml-2 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500 uppercase">{t('masters.dt.system')}</span>}
                            </p>
                            {dt.description && <p className="text-xs text-slate-400">{dt.description}</p>}
                            <p className="text-[10px] font-mono text-slate-300">{dt.code}</p>
                          </div>
                          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-all">
                            <button
                              onClick={() => setEditState({ kind: "datetype", id: dt.id, code: dt.code, name: dt.name, description: dt.description ?? "", category: dt.category, sortOrder: String(dt.sortOrder) })}
                              className="rounded-none p-1.5 text-[var(--accent)] hover:bg-[var(--accent)]/10 transition-colors"
                            ><Pencil className="h-4 w-4" /></button>
                            {!dt.isSystem && (
                              <button
                                onClick={async () => {
                                  if (!confirm(`¿Eliminar "${dt.name}"?`)) return;
                                  const res = await apiFetch(`/api/catalog/date-types/${dt.id}`, { method: "DELETE" });
                                  if (!res.ok) {
                                    const d = await res.json().catch(() => ({})) as { error?: string };
                                    alert(d.error ?? `Error ${res.status}`); return;
                                  }
                                  load();
                                }}
                                className="rounded-lg p-1.5 text-red-400 hover:bg-red-50 hover:text-red-600 transition-colors"
                              ><Trash2 className="h-4 w-4" /></button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── Hypervisors ── */}
        {tab === "hypervisors" && (
          <div className="bg-white shadow-sm ring-1 ring-slate-200 overflow-hidden">
            <div className="border-b border-slate-100 px-6 py-4 bg-slate-50">
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">{t('masters.hv.new')}</p>
              <div className="flex gap-2 mt-2">
                <Input
                  placeholder={t('masters.hv.name_placeholder')}
                  value={newHv}
                  onChange={(e) => setNewHv(e.target.value)}
                />
                <button
                  onClick={async () => {
                    if (!newHv.trim()) { alert(t('masters.hv.name_required')); return; }
                    try {
                      await post("/api/masters/hypervisors", { name: newHv.trim() });
                      setNewHv("");
                      load();
                    } catch (e) { alert(e instanceof Error ? e.message : "Error"); }
                  }}
                  className="flex-shrink-0 flex items-center gap-1.5 rounded-none bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white hover:bg-[var(--accent)]/90 transition-colors"
                >
                  <Plus className="h-4 w-4" />Añadir
                </button>
              </div>
            </div>
            <div className="divide-y divide-slate-50">
              {hypervisors.length === 0 ? (
                <p className="py-8 text-center text-sm text-slate-400">{t('masters.hv.empty')}</p>
              ) : (
                hypervisors.map((hv) => {
                  const isEditing = editState?.kind === "hypervisor" && editState.id === hv.id;
                  if (isEditing && editState?.kind === "hypervisor") {
                    return (
                      <div key={hv.id} className="flex items-center gap-2 px-4 py-2 bg-[var(--accent)]/5 border-b border-[var(--accent)]/20">
                        <Input
                          value={editState.name}
                          onChange={(e) => setEditState({ ...editState, name: e.target.value })}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              void (async () => {
                                try { await patch(`/api/masters/hypervisors/${hv.id}`, { name: editState.name }); setEditState(null); load(); }
                                catch (err) { alert(err instanceof Error ? err.message : "Error"); }
                              })();
                            }
                            if (e.key === "Escape") setEditState(null);
                          }}
                          autoFocus
                          className="flex-1"
                        />
                        <button
                          onClick={async () => {
                            try { await patch(`/api/masters/hypervisors/${hv.id}`, { name: editState.name }); setEditState(null); load(); }
                            catch (e) { alert(e instanceof Error ? e.message : "Error"); }
                          }}
                          className="rounded-lg p-1.5 text-emerald-600 hover:bg-emerald-50 transition-colors"
                        >
                          <Check className="h-4 w-4" />
                        </button>
                        <button onClick={() => setEditState(null)} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 transition-colors">
                          <X className="h-4 w-4" />
                        </button>
                      </div>
                    );
                  }
                  return (
                    <div key={hv.id} className="flex items-center justify-between px-4 py-2.5 hover:bg-slate-50 transition-colors group">
                      <div className="flex items-center gap-3">
                        {hv.isSystem && (
                          <span title={t('masters.hv.system_note')}>
                            <Lock className="h-3 w-3 text-slate-300 flex-shrink-0" />
                          </span>
                        )}
                        <div>
                          <p className="text-sm font-medium text-slate-700">{hv.name}</p>
                          <p className="text-xs font-mono text-slate-400">{hv.code}</p>
                        </div>
                      </div>
                      {!hv.isSystem && (
                        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-all">
                          <button
                            onClick={() => setEditState({ kind: "hypervisor", id: hv.id, name: hv.name })}
                            className="rounded-none p-1.5 text-[var(--accent)] hover:bg-[var(--accent)]/10 hover:text-[var(--accent)] transition-colors"
                          >
                            <Pencil className="h-4 w-4" />
                          </button>
                          <button
                            onClick={async () => {
                              if (!confirm(`¿Eliminar el hipervisor "${hv.name}"?`)) return;
                              try {
                                const res = await apiFetch(`/api/masters/hypervisors/${hv.id}`, { method: "DELETE" });
                                if (!res.ok) {
                                  const d = await res.json().catch(() => ({})) as { error?: string };
                                  alert(d.error ?? `Error ${res.status}`);
                                  return;
                                }
                                load();
                              } catch (e) { alert(e instanceof Error ? e.message : "Error"); }
                            }}
                            className="rounded-lg p-1.5 text-red-400 hover:bg-red-50 hover:text-red-600 transition-colors"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        )}

        {modalEntity && (
          <EditCatalogEntityModal
            entity={modalEntity.entity}
            entityType={modalEntity.entityType}
            patchUrl={modalEntity.patchUrl}
            title={modalEntity.title}
            categoryFilter={modalEntity.categoryFilter}
            showVersion={modalEntity.showVersion}
            manufacturerRequired={modalEntity.manufacturerRequired}
            manufacturers={manufacturers}
            onClose={() => { setModalEntity(null); load(); }}
            onSaved={load}
          />
        )}

          </div>
        </main>
      </div>
    </div>
  );
}

// Suppress unused import warning for ChevronRight (kept for future breadcrumbs)
const _unused = ChevronRight;
void _unused;

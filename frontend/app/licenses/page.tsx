"use client";

import { useEffect, useState, useRef, useMemo } from "react";
import Link from "next/link";
import {
  Key, Plus, RefreshCw, AlertTriangle, Building, Calendar, Server,
  ChevronRight, Download, Eye, EyeOff, X, Search, Check, User,
  FileText, Trash2, Mail, FilterX,
} from "lucide-react";
import AddLicenseModal from "@/components/AddLicenseModal";
import { useAuth } from "@/contexts/AuthContext";
import { apiFetch } from "@/lib/apiFetch";
import { exportToCSV } from "@/lib/csvExport";

// ─── Types ────────────────────────────────────────────────────────────────────

interface CIRef { id: string; name: string; apiSlug: string; environment: string; criticality: string }
interface DocRef {
  id: string; title: string; documentTypeName: string; documentTypeCode: string;
  originalName: string; versionNumber: number; uploadedBy: string; createdAt: string;
  mimeType: string;
}
interface AllDocRef {
  id: string; title: string; documentTypeName: string; originalName: string;
  mimeType: string; latestVersionId: string;
}
interface LicenseUser {
  id: string; name: string; dni: string | null; email: string | null; createdAt: string;
}
interface License {
  id: string; name: string; licenseNumber: string;
  vendorName: string | null;
  licenseTypeName: string | null;
  licenseMetricName: string | null;
  metricValue: number | null; metricUnit: string | null;
  cost: number | null; currency: string | null;
  status: string | null; notes: string | null;
  startDate: string; endDate: string | null;
  addendumCount: number;
  ciCount: number;
}

interface PreviewState {
  blobUrl: string | null; text: string | null; loading: boolean; error: boolean; mimeType: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getLicenseStatus(status: string | null, endDate: string | null) {
  const s = (status ?? "ACTIVO").toUpperCase();
  if (s === "BAJA") return { label: "Baja", color: "text-slate-500", dot: "bg-slate-400" };
  if (endDate) {
    const diff = (new Date(endDate).getTime() - Date.now()) / 86400000;
    if (diff < 0)  return { label: "Expirada",      color: "text-red-600",    dot: "bg-red-500" };
    if (diff < 30) return { label: "Renueva pronto", color: "text-orange-600", dot: "bg-orange-400" };
  }
  return { label: "Activa", color: "text-emerald-600", dot: "bg-emerald-400" };
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("es-ES", { day: "2-digit", month: "short", year: "numeric" });
}

function formatCost(cost: number | null, currency: string | null) {
  if (cost === null || cost === undefined) return null;
  return new Intl.NumberFormat("es-ES", { style: "currency", currency: currency ?? "EUR", maximumFractionDigits: 2 }).format(cost);
}

// ─── LicenseRow ───────────────────────────────────────────────────────────────

function LicenseRow({ license, onExpand, expanded }: { license: License; onExpand: () => void; expanded: boolean }) {
  const status = getLicenseStatus(license.status, license.endDate);
  const { token, isAdmin } = useAuth();
  const apiBase = process.env.NEXT_PUBLIC_API_URL ?? "";

  // ── Docs state ──────────────────────────────────────────────────────────────
  const [docs, setDocs]               = useState<DocRef[]>([]);
  const [docsLoading, setDocsLoading] = useState(false);
  const [docsFetched, setDocsFetched] = useState(false);
  const [previews, setPreviews]       = useState<Map<string, PreviewState>>(new Map());
  const [openPreviews, setOpenPreviews] = useState<Set<string>>(new Set());
  const blobUrlsRef = useRef<string[]>([]);
  useEffect(() => { return () => { blobUrlsRef.current.forEach((u) => URL.revokeObjectURL(u)); }; }, []);

  const [showDocSelector, setShowDocSelector] = useState(false);
  const [allDocs, setAllDocs]                 = useState<AllDocRef[]>([]);
  const [allDocsLoading, setAllDocsLoading]   = useState(false);
  const [docSearch, setDocSearch]             = useState("");
  const [selectedDocIds, setSelectedDocIds]   = useState<Set<string>>(new Set());
  const [docAssocLoading, setDocAssocLoading] = useState(false);

  // ── CIs state ───────────────────────────────────────────────────────────────
  const [cis, setCis]               = useState<CIRef[]>([]);
  const [cisFetched, setCisFetched] = useState(false);
  const [showCISelector, setShowCISelector]   = useState(false);
  const [allCIs, setAllCIs]                   = useState<CIRef[]>([]);
  const [allCIsLoading, setAllCIsLoading]     = useState(false);
  const [ciSearch, setCiSearch]               = useState("");
  const [selectedCiIds, setSelectedCiIds]     = useState<Set<string>>(new Set());
  const [ciAssocLoading, setCiAssocLoading]   = useState(false);

  // ── License Users state ─────────────────────────────────────────────────────
  const [licenseUsers, setLicenseUsers]       = useState<LicenseUser[]>([]);
  const [usersFetched, setUsersFetched]       = useState(false);
  const [showAddUser, setShowAddUser]         = useState(false);
  const [newUser, setNewUser]                 = useState({ name: "", dni: "", email: "" });
  const [userSaving, setUserSaving]           = useState(false);

  // ── Fetch on expand ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!expanded || docsFetched) return;
    setDocsLoading(true);
    apiFetch(`/api/licenses/${license.id}/documents`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d: DocRef[]) => setDocs(d))
      .catch(() => setDocs([]))
      .finally(() => { setDocsLoading(false); setDocsFetched(true); });
  }, [expanded, license.id, docsFetched]);

  useEffect(() => {
    if (!expanded || cisFetched) return;
    apiFetch(`/api/licenses/${license.id}/cis`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d: CIRef[]) => setCis(d))
      .catch(() => {})
      .finally(() => setCisFetched(true));
  }, [expanded, license.id, cisFetched]);

  useEffect(() => {
    if (!expanded || usersFetched) return;
    apiFetch(`/api/licenses/${license.id}/users`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d: LicenseUser[]) => setLicenseUsers(d))
      .catch(() => {})
      .finally(() => setUsersFetched(true));
  }, [expanded, license.id, usersFetched]);

  // ── Download ────────────────────────────────────────────────────────────────
  const handleDownload = async (docId: string, fileName: string) => {
    const res = await fetch(`${apiBase}/api/documents/${docId}/download`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = fileName; a.click();
    URL.revokeObjectURL(url);
  };

  // ── Preview ─────────────────────────────────────────────────────────────────
  const togglePreview = async (doc: DocRef) => {
    const docId = doc.id;
    if (openPreviews.has(docId)) {
      setOpenPreviews((prev) => { const s = new Set(prev); s.delete(docId); return s; });
      return;
    }
    if (previews.has(docId)) { setOpenPreviews((prev) => new Set(prev).add(docId)); return; }
    setPreviews((prev) => new Map(prev).set(docId, { blobUrl: null, text: null, loading: true, error: false, mimeType: doc.mimeType }));
    setOpenPreviews((prev) => new Set(prev).add(docId));
    try {
      const res = await fetch(`${apiBase}/api/documents/${docId}/download?inline=true`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error("fetch failed");
      const mimeType = doc.mimeType;
      if (mimeType === "application/pdf" || mimeType.startsWith("image/")) {
        const blob = await res.blob();
        const blobUrl = URL.createObjectURL(blob);
        blobUrlsRef.current.push(blobUrl);
        setPreviews((prev) => new Map(prev).set(docId, { blobUrl, text: null, loading: false, error: false, mimeType }));
      } else if (mimeType.startsWith("text/") || mimeType === "application/csv") {
        const text = await res.text();
        setPreviews((prev) => new Map(prev).set(docId, { blobUrl: null, text, loading: false, error: false, mimeType }));
      } else {
        setPreviews((prev) => new Map(prev).set(docId, { blobUrl: null, text: null, loading: false, error: false, mimeType }));
      }
    } catch {
      setPreviews((prev) => new Map(prev).set(docId, { blobUrl: null, text: null, loading: false, error: true, mimeType: doc.mimeType }));
    }
  };

  // ── CI actions ───────────────────────────────────────────────────────────────
  const handleRemoveCI = async (ciId: string) => {
    const res = await apiFetch(`/api/licenses/${license.id}/cis/${ciId}`, { method: "DELETE" });
    if (res.ok) setCis((prev) => prev.filter((c) => c.id !== ciId));
  };

  const openCISelector = async () => {
    setShowCISelector(true); setSelectedCiIds(new Set()); setCiSearch("");
    if (allCIs.length === 0) {
      setAllCIsLoading(true);
      apiFetch("/api/cis")
        .then((r) => (r.ok ? r.json() : Promise.reject()))
        .then((d) => { const list: CIRef[] = Array.isArray(d) ? d : (d.data ?? []); setAllCIs(list); })
        .catch(() => {}).finally(() => setAllCIsLoading(false));
    }
  };

  const confirmCIAssoc = async () => {
    if (selectedCiIds.size === 0) return;
    setCiAssocLoading(true);
    try {
      const res = await apiFetch(`/api/licenses/${license.id}/cis`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ciIds: Array.from(selectedCiIds) }),
      });
      if (res.ok) { const fresh = await apiFetch(`/api/licenses/${license.id}/cis`); if (fresh.ok) setCis(await fresh.json()); }
    } finally { setCiAssocLoading(false); setShowCISelector(false); }
  };

  // ── Doc actions ──────────────────────────────────────────────────────────────
  const openDocSelector = async () => {
    setShowDocSelector(true); setSelectedDocIds(new Set()); setDocSearch("");
    if (allDocs.length === 0) {
      setAllDocsLoading(true);
      apiFetch("/api/documents")
        .then((r) => (r.ok ? r.json() : Promise.reject()))
        .then((d: AllDocRef[]) => setAllDocs(Array.isArray(d) ? d : []))
        .catch(() => {}).finally(() => setAllDocsLoading(false));
    }
  };

  const confirmDocAssoc = async () => {
    if (selectedDocIds.size === 0) return;
    setDocAssocLoading(true);
    try {
      await Promise.all(
        Array.from(selectedDocIds).map((docId) =>
          apiFetch(`/api/licenses/${license.id}/documents`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ documentIds: [docId] }),
          })
        )
      );
      const fresh = await apiFetch(`/api/licenses/${license.id}/documents`);
      if (fresh.ok) setDocs(await fresh.json());
    } finally { setDocAssocLoading(false); setShowDocSelector(false); }
  };

  // ── User actions ─────────────────────────────────────────────────────────────
  const handleAddUser = async () => {
    if (!newUser.name.trim()) return;
    setUserSaving(true);
    try {
      const res = await apiFetch(`/api/licenses/${license.id}/users`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newUser.name, dni: newUser.dni || undefined, email: newUser.email || undefined }),
      });
      if (res.ok) {
        const created: LicenseUser = await res.json();
        setLicenseUsers((prev) => [...prev, created]);
        setNewUser({ name: "", dni: "", email: "" }); setShowAddUser(false);
      }
    } finally { setUserSaving(false); }
  };

  const handleRemoveUser = async (userId: string) => {
    if (!confirm("¿Eliminar este usuario de la licencia?")) return;
    const res = await apiFetch(`/api/licenses/${license.id}/users/${userId}`, { method: "DELETE" });
    if (res.ok) setLicenseUsers((prev) => prev.filter((u) => u.id !== userId));
  };

  // ── Filtered lists ────────────────────────────────────────────────────────────
  const associatedCiIds  = new Set(cis.map((c) => c.id));
  const filteredAllCIs   = allCIs
    .filter((ci) => !associatedCiIds.has(ci.id))
    .filter((ci) => ci.name.toLowerCase().includes(ciSearch.toLowerCase()) || ci.apiSlug.toLowerCase().includes(ciSearch.toLowerCase()));

  const associatedDocIds = new Set(docs.map((d) => d.id));
  const filteredAllDocs  = allDocs
    .filter((d) => !associatedDocIds.has(d.id))
    .filter((d) => d.title.toLowerCase().includes(docSearch.toLowerCase()) || d.originalName.toLowerCase().includes(docSearch.toLowerCase()));

  return (
    <>
      <tr className="group cursor-pointer hover:bg-indigo-50/40 transition-colors" onClick={onExpand}>
        <td className="px-6 py-4">
          <div className="flex items-center gap-2">
            <div>
              <p className="font-semibold text-slate-800 group-hover:text-indigo-700 transition-colors">{license.name}</p>
              <p className="text-xs text-slate-400 font-mono">{license.licenseNumber}</p>
              {license.addendumCount > 0 && <p className="text-[11px] text-slate-400">{license.addendumCount} sub-licencia{license.addendumCount > 1 ? "s" : ""}</p>}
            </div>
          </div>
        </td>
        <td className="px-6 py-4">
          <div className="flex items-center gap-2 text-slate-700">
            <Building className="h-3.5 w-3.5 text-slate-400 flex-shrink-0" />
            <span className="text-sm font-medium">{license.vendorName ?? "—"}</span>
          </div>
        </td>
        <td className="px-6 py-4">
          <div className="space-y-0.5">
            {license.licenseTypeName && (
              <span className="inline-block rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-semibold text-indigo-700">{license.licenseTypeName}</span>
            )}
            {license.licenseMetricName && (
              <p className="text-xs text-slate-500">
                {license.licenseMetricName}
                {license.metricValue ? <span className="ml-1 font-semibold text-slate-700">{license.metricValue}{license.metricUnit ? ` ${license.metricUnit}` : ""}</span> : null}
              </p>
            )}
          </div>
        </td>
        <td className="px-6 py-4">
          <div className="flex items-center gap-2">
            <span className={`inline-flex h-2 w-2 rounded-full flex-shrink-0 ${status.dot}`} />
            <div>
              <p className={`text-sm font-medium ${status.color}`}>{status.label}</p>
              {license.endDate && <p className="text-xs text-slate-400">{formatDate(license.endDate)}</p>}
              {!license.endDate && <p className="text-xs text-slate-400">Perpetua</p>}
            </div>
          </div>
        </td>
        <td className="px-6 py-4">
          {license.cost ? (
            <p className="text-sm font-semibold text-slate-700">{formatCost(license.cost, license.currency)}</p>
          ) : (
            <p className="text-sm text-slate-400">—</p>
          )}
        </td>
        <td className="px-6 py-4">
          <div className="flex items-center gap-1.5 text-slate-600">
            <Server className="h-3.5 w-3.5 text-slate-400 flex-shrink-0" />
            <span className="text-sm font-medium">{license.ciCount}</span>
            <span className="text-xs text-slate-400">CI{license.ciCount !== 1 ? "s" : ""}</span>
          </div>
        </td>
        <td className="px-4 py-4 text-right">
          <ChevronRight className={`h-4 w-4 text-slate-400 transition-transform inline-block ${expanded ? "rotate-90" : ""}`} />
        </td>
      </tr>

      {expanded && (
        <tr>
          <td colSpan={7} className="px-6 pb-4 bg-indigo-50/30">
            <div className="space-y-3 pt-1">

              {/* ── CIs asociados ─────────────────────────────────────────── */}
              <div className="rounded-xl border border-indigo-100 bg-white overflow-hidden">
                <div className="border-b border-slate-100 bg-slate-50 px-4 py-2 flex items-center justify-between">
                  <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">CIs asociados</p>
                  {isAdmin && (
                    <button onClick={(e) => { e.stopPropagation(); openCISelector(); }}
                      className="flex items-center gap-1 rounded-md bg-indigo-50 px-2 py-1 text-xs font-medium text-indigo-600 hover:bg-indigo-100 transition-colors">
                      <Plus className="h-3 w-3" />Asociar CIs
                    </button>
                  )}
                </div>
                {cis.length === 0 && cisFetched ? (
                  <p className="px-4 py-3 text-sm italic text-slate-400">Esta licencia no tiene CIs asociados.</p>
                ) : (
                  <div className="divide-y divide-slate-50">
                    {cis.map((ci) => (
                      <div key={ci.id} className="flex items-center justify-between px-4 py-2.5">
                        <div><p className="text-sm font-medium text-slate-700">{ci.name}</p><p className="text-xs text-slate-400">{ci.apiSlug}</p></div>
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-slate-500">{ci.environment}</span>
                          <span className="text-xs text-slate-400">·</span>
                          <span className="text-xs text-slate-500">{ci.criticality}</span>
                          {isAdmin && (
                            <button onClick={(e) => { e.stopPropagation(); handleRemoveCI(ci.id); }}
                              className="ml-1 rounded p-0.5 text-slate-400 hover:text-red-500 hover:bg-red-50 transition-colors" title="Quitar CI">
                              <X className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {showCISelector && (
                  <div className="border-t border-indigo-100 px-4 py-3 bg-indigo-50/40" onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center gap-2 mb-2">
                      <Search className="h-3.5 w-3.5 text-slate-400 flex-shrink-0" />
                      <input type="text" placeholder="Buscar CI…" value={ciSearch} onChange={(e) => setCiSearch(e.target.value)}
                        className="flex-1 text-sm border border-slate-200 rounded-md px-2 py-1 outline-none focus:ring-1 focus:ring-indigo-400 bg-white" />
                      <button onClick={() => setShowCISelector(false)} className="text-slate-400 hover:text-slate-600"><X className="h-4 w-4" /></button>
                    </div>
                    {allCIsLoading ? (
                      <div className="flex items-center gap-2 py-2 text-slate-400 text-xs"><RefreshCw className="h-3.5 w-3.5 animate-spin" />Cargando…</div>
                    ) : (
                      <div className="max-h-48 overflow-y-auto space-y-0.5 rounded-md border border-slate-200 bg-white">
                        {filteredAllCIs.length === 0 ? (
                          <p className="px-3 py-2 text-xs text-slate-400 italic">No hay CIs disponibles.</p>
                        ) : filteredAllCIs.map((ci) => {
                          const checked = selectedCiIds.has(ci.id);
                          return (
                            <label key={ci.id} className="flex items-center gap-2 px-3 py-2 hover:bg-indigo-50 cursor-pointer text-sm">
                              <input type="checkbox" checked={checked} onChange={() => setSelectedCiIds((prev) => { const s = new Set(prev); if (checked) s.delete(ci.id); else s.add(ci.id); return s; })} className="accent-indigo-600" />
                              <span className="font-medium text-slate-700">{ci.name}</span>
                              <span className="text-xs text-slate-400 truncate">{ci.apiSlug}</span>
                            </label>
                          );
                        })}
                      </div>
                    )}
                    <div className="flex items-center justify-end gap-2 mt-2">
                      <button onClick={() => setShowCISelector(false)} className="text-xs text-slate-500 hover:text-slate-700 px-2 py-1">Cancelar</button>
                      <button onClick={confirmCIAssoc} disabled={selectedCiIds.size === 0 || ciAssocLoading}
                        className="flex items-center gap-1 rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-50 transition-colors">
                        {ciAssocLoading ? <RefreshCw className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                        Confirmar ({selectedCiIds.size})
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {/* ── Documentos adjuntos ────────────────────────────────────── */}
              <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
                <div className="border-b border-slate-100 bg-slate-50 px-4 py-2 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <FileText className="h-3.5 w-3.5 text-slate-400" />
                    <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Documentos adjuntos</p>
                  </div>
                  {isAdmin && docsFetched && (
                    <button onClick={(e) => { e.stopPropagation(); openDocSelector(); }}
                      className="flex items-center gap-1 rounded-md bg-slate-100 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-indigo-50 hover:text-indigo-700 transition-colors">
                      <Plus className="h-3 w-3" />Asociar Documentos
                    </button>
                  )}
                </div>
                {docsLoading ? (
                  <div className="flex items-center gap-2 px-4 py-3 text-slate-400 text-sm"><RefreshCw className="h-3.5 w-3.5 animate-spin" /><span>Cargando documentos…</span></div>
                ) : docs.length === 0 ? (
                  <p className="px-4 py-3 text-sm italic text-slate-400">No hay documentos asociados a esta licencia.</p>
                ) : (
                  <div className="divide-y divide-slate-50">
                    {docs.map((doc) => {
                      const previewOpen  = openPreviews.has(doc.id);
                      const previewState = previews.get(doc.id);
                      return (
                        <div key={doc.id}>
                          <div className="flex items-center justify-between px-4 py-2.5 gap-3">
                            <div className="flex items-start gap-2 min-w-0">
                              <FileText className="h-4 w-4 flex-shrink-0 text-indigo-400 mt-0.5" />
                              <div className="min-w-0">
                                <Link href={`/documents/${doc.id}`} className="text-sm font-medium text-indigo-700 hover:underline truncate block" onClick={(e) => e.stopPropagation()}>
                                  {doc.title}
                                </Link>
                                <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                                  <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold bg-slate-100 text-slate-600">{doc.documentTypeName}</span>
                                  <span className="text-[11px] text-slate-400 truncate">{doc.originalName}</span>
                                  <span className="text-[11px] text-slate-400">v{doc.versionNumber}</span>
                                  <span className="text-[11px] text-slate-400">{new Date(doc.createdAt).toLocaleDateString("es-ES")}</span>
                                </div>
                              </div>
                            </div>
                            <div className="flex items-center gap-1.5 flex-shrink-0">
                              <button onClick={(e) => { e.stopPropagation(); togglePreview(doc); }}
                                className="flex items-center gap-1 rounded-md bg-slate-100 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-indigo-50 hover:text-indigo-700 transition-colors"
                                title={previewOpen ? "Ocultar vista previa" : "Vista previa"}>
                                {previewOpen ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                                {previewOpen ? "Ocultar" : "Vista previa"}
                              </button>
                              <button onClick={(e) => { e.stopPropagation(); handleDownload(doc.id, doc.originalName); }}
                                className="flex items-center gap-1 rounded-md bg-slate-100 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-indigo-50 hover:text-indigo-700 transition-colors">
                                <Download className="h-3.5 w-3.5" />Descargar
                              </button>
                            </div>
                          </div>
                          {previewOpen && (
                            <div className="px-4 pb-3" onClick={(e) => e.stopPropagation()}>
                              {!previewState || previewState.loading ? (
                                <div className="flex items-center gap-2 py-3 text-slate-400 text-xs"><RefreshCw className="h-3.5 w-3.5 animate-spin" /><span>Cargando vista previa…</span></div>
                              ) : previewState.error ? (
                                <div className="flex items-center gap-2 py-3 text-red-400 text-xs"><AlertTriangle className="h-3.5 w-3.5" /><span>Error al cargar la vista previa.</span></div>
                              ) : previewState.mimeType === "application/pdf" && previewState.blobUrl ? (
                                <iframe src={previewState.blobUrl} style={{ height: "400px" }} className="w-full border-0 rounded-lg ring-1 ring-slate-200" title={doc.title} />
                              ) : previewState.mimeType.startsWith("image/") && previewState.blobUrl ? (
                                <img src={previewState.blobUrl} alt={doc.title} className="max-w-full max-h-60 rounded-lg object-contain ring-1 ring-slate-200" />
                              ) : previewState.text !== null ? (
                                <pre className="max-h-60 overflow-auto rounded-lg bg-slate-50 ring-1 ring-slate-200 p-3 text-xs text-slate-700 whitespace-pre-wrap">{previewState.text}</pre>
                              ) : (
                                <p className="py-2 text-xs italic text-slate-400">Vista previa no disponible para este tipo de archivo.</p>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
                {showDocSelector && (
                  <div className="border-t border-slate-100 px-4 py-3 bg-slate-50/60" onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center gap-2 mb-2">
                      <Search className="h-3.5 w-3.5 text-slate-400 flex-shrink-0" />
                      <input type="text" placeholder="Buscar documento…" value={docSearch} onChange={(e) => setDocSearch(e.target.value)}
                        className="flex-1 text-sm border border-slate-200 rounded-md px-2 py-1 outline-none focus:ring-1 focus:ring-indigo-400 bg-white" />
                      <button onClick={() => setShowDocSelector(false)} className="text-slate-400 hover:text-slate-600"><X className="h-4 w-4" /></button>
                    </div>
                    {allDocsLoading ? (
                      <div className="flex items-center gap-2 py-2 text-slate-400 text-xs"><RefreshCw className="h-3.5 w-3.5 animate-spin" />Cargando…</div>
                    ) : (
                      <div className="max-h-48 overflow-y-auto space-y-0.5 rounded-md border border-slate-200 bg-white">
                        {filteredAllDocs.length === 0 ? (
                          <p className="px-3 py-2 text-xs text-slate-400 italic">No hay documentos disponibles.</p>
                        ) : filteredAllDocs.map((d) => {
                          const checked = selectedDocIds.has(d.id);
                          return (
                            <label key={d.id} className="flex items-center gap-2 px-3 py-2 hover:bg-slate-50 cursor-pointer text-sm">
                              <input type="checkbox" checked={checked} onChange={() => setSelectedDocIds((prev) => { const s = new Set(prev); if (checked) s.delete(d.id); else s.add(d.id); return s; })} className="accent-indigo-600" />
                              <span className="font-medium text-slate-700 truncate">{d.title}</span>
                              <span className="text-xs text-slate-400 truncate flex-shrink-0">{d.documentTypeName}</span>
                            </label>
                          );
                        })}
                      </div>
                    )}
                    <div className="flex items-center justify-end gap-2 mt-2">
                      <button onClick={() => setShowDocSelector(false)} className="text-xs text-slate-500 hover:text-slate-700 px-2 py-1">Cancelar</button>
                      <button onClick={confirmDocAssoc} disabled={selectedDocIds.size === 0 || docAssocLoading}
                        className="flex items-center gap-1 rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-50 transition-colors">
                        {docAssocLoading ? <RefreshCw className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                        Confirmar ({selectedDocIds.size})
                      </button>
                    </div>
                  </div>
                )}
                {docsFetched && (
                  <div className="border-t border-slate-50 px-4 py-2 text-right">
                    <Link href="/documents" className="text-xs text-indigo-500 hover:text-indigo-700 hover:underline transition-colors">Ver todos los documentos →</Link>
                  </div>
                )}
              </div>

              {/* ── Usuarios de licencia ───────────────────────────────────── */}
              <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
                <div className="border-b border-slate-100 bg-slate-50 px-4 py-2 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <User className="h-3.5 w-3.5 text-slate-400" />
                    <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Usuarios de licencia</p>
                    {usersFetched && <span className="rounded-full bg-slate-200 px-1.5 py-0.5 text-[10px] font-bold text-slate-600">{licenseUsers.length}</span>}
                  </div>
                  {isAdmin && usersFetched && (
                    <button onClick={(e) => { e.stopPropagation(); setShowAddUser((v) => !v); setNewUser({ name: "", dni: "", email: "" }); }}
                      className="flex items-center gap-1 rounded-md bg-slate-100 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-emerald-50 hover:text-emerald-700 transition-colors">
                      <Plus className="h-3 w-3" />Añadir Usuario
                    </button>
                  )}
                </div>

                {!usersFetched ? (
                  <div className="flex items-center gap-2 px-4 py-3 text-slate-400 text-sm"><RefreshCw className="h-3.5 w-3.5 animate-spin" /><span>Cargando usuarios…</span></div>
                ) : licenseUsers.length === 0 && !showAddUser ? (
                  <p className="px-4 py-3 text-sm italic text-slate-400">No hay usuarios asociados a esta licencia.</p>
                ) : (
                  <div className="divide-y divide-slate-50">
                    {licenseUsers.map((u) => (
                      <div key={u.id} className="flex items-center justify-between px-4 py-2.5 group">
                        <div className="flex items-center gap-3">
                          <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-indigo-100">
                            <User className="h-3.5 w-3.5 text-indigo-600" />
                          </div>
                          <div>
                            <p className="text-sm font-medium text-slate-700">{u.name}</p>
                            <div className="flex items-center gap-2 mt-0.5">
                              {u.dni && <span className="text-xs text-slate-400">DNI: {u.dni}</span>}
                              {u.email && (
                                <span className="flex items-center gap-0.5 text-xs text-slate-400">
                                  <Mail className="h-3 w-3" />{u.email}
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                        {isAdmin && (
                          <button onClick={(e) => { e.stopPropagation(); handleRemoveUser(u.id); }}
                            className="opacity-0 group-hover:opacity-100 rounded p-1 text-slate-400 hover:text-red-500 hover:bg-red-50 transition-all" title="Eliminar usuario">
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {showAddUser && (
                  <div className="border-t border-slate-100 px-4 py-3 bg-slate-50/60" onClick={(e) => e.stopPropagation()}>
                    <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Nuevo Usuario</p>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                      <input type="text" placeholder="Nombre *" value={newUser.name} onChange={(e) => setNewUser((p) => ({ ...p, name: e.target.value }))}
                        className="text-sm border border-slate-200 rounded-md px-2 py-1.5 outline-none focus:ring-1 focus:ring-indigo-400 bg-white" />
                      <input type="text" placeholder="DNI (opcional)" value={newUser.dni} onChange={(e) => setNewUser((p) => ({ ...p, dni: e.target.value }))}
                        className="text-sm border border-slate-200 rounded-md px-2 py-1.5 outline-none focus:ring-1 focus:ring-indigo-400 bg-white" />
                      <input type="email" placeholder="Email (opcional)" value={newUser.email} onChange={(e) => setNewUser((p) => ({ ...p, email: e.target.value }))}
                        className="text-sm border border-slate-200 rounded-md px-2 py-1.5 outline-none focus:ring-1 focus:ring-indigo-400 bg-white" />
                    </div>
                    <div className="flex items-center justify-end gap-2 mt-2">
                      <button onClick={() => setShowAddUser(false)} className="text-xs text-slate-500 hover:text-slate-700 px-2 py-1">Cancelar</button>
                      <button onClick={handleAddUser} disabled={!newUser.name.trim() || userSaving}
                        className="flex items-center gap-1 rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50 transition-colors">
                        {userSaving ? <RefreshCw className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                        Guardar Usuario
                      </button>
                    </div>
                  </div>
                )}
              </div>

            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function LicensesPage() {
  const { isAdmin }             = useAuth();
  const [licenses, setLicenses] = useState<License[]>([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const fetchLicenses = async () => {
    setLoading(true); setError(null);
    try {
      const res = await apiFetch("/api/licenses");
      if (!res.ok) throw new Error(`Status ${res.status}`);
      const json: License[] = await res.json();
      setLicenses(Array.isArray(json) ? json : []);
    } catch (err) { setError(err instanceof Error ? err.message : "Unknown error"); }
    finally { setLoading(false); }
  };

  useEffect(() => { fetchLicenses(); }, []);

  const [filters, setFilters] = useState({ name: "", vendor: "", licenseType: "", status: "" });
  const activeFilterCount = Object.values(filters).filter(Boolean).length;
  const setFilter = (key: keyof typeof filters, val: string) => setFilters((prev) => ({ ...prev, [key]: val }));
  const clearFilters = () => setFilters({ name: "", vendor: "", licenseType: "", status: "" });

  const filteredLicenses = useMemo(() => {
    return licenses.filter((l) => {
      if (filters.name && !l.name.toLowerCase().includes(filters.name.toLowerCase()) &&
          !l.licenseNumber.toLowerCase().includes(filters.name.toLowerCase())) return false;
      if (filters.vendor && !(l.vendorName ?? "").toLowerCase().includes(filters.vendor.toLowerCase())) return false;
      if (filters.licenseType && !(l.licenseTypeName ?? "").toLowerCase().includes(filters.licenseType.toLowerCase())) return false;
      if (filters.status) {
        const st = getLicenseStatus(l.status, l.endDate);
        if (filters.status === "activa" && st.label !== "Activa") return false;
        if (filters.status === "renueva" && st.label !== "Renueva pronto") return false;
        if (filters.status === "expirada" && st.label !== "Expirada") return false;
        if (filters.status === "baja" && st.label !== "Baja") return false;
      }
      return true;
    });
  }, [licenses, filters]);

  const total    = licenses.length;
  const expiredCount = licenses.filter((l) => l.endDate && new Date(l.endDate) < new Date()).length;
  const activeCount  = licenses.filter((l) => {
    if (l.status === "BAJA") return false;
    if (l.endDate && new Date(l.endDate) < new Date()) return false;
    return true;
  }).length;
  const perpetualCount = licenses.filter((l) => !l.endDate && l.status !== "BAJA").length;

  const handleExportCSV = () => {
    exportToCSV(
      `licencias-${new Date().toISOString().slice(0, 10)}.csv`,
      ["Nº Licencia", "Nombre", "Proveedor", "Tipo", "Métrica", "Valor", "Estado", "Inicio", "Vencimiento", "Coste"],
      licenses.map((l) => {
        const st = getLicenseStatus(l.status, l.endDate);
        return [
          l.licenseNumber, l.name, l.vendorName ?? "—",
          l.licenseTypeName ?? "—", l.licenseMetricName ?? "—",
          l.metricValue ? `${l.metricValue}${l.metricUnit ? " " + l.metricUnit : ""}` : "—",
          st.label, formatDate(l.startDate),
          l.endDate ? formatDate(l.endDate) : "Perpetua",
          formatCost(l.cost, l.currency) ?? "—",
        ];
      })
    );
  };

  return (
    <>
      {showModal && <AddLicenseModal onClose={() => setShowModal(false)} onCreated={fetchLicenses} />}
      <div className="min-h-screen bg-slate-50">
        <header className="border-b border-slate-200 bg-white px-8 py-5">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-xl font-bold text-slate-900">Licencias de Software</h1>
              <p className="text-sm text-slate-500 mt-0.5">
                {loading ? "Cargando…" : `${total} licencias · ${activeCount} activas · ${expiredCount} expiradas · ${perpetualCount} perpetuas`}
              </p>
            </div>
            {isAdmin && (
              <button onClick={() => setShowModal(true)}
                className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700 transition-colors shadow-sm">
                <Plus className="h-4 w-4" />Nueva Licencia
              </button>
            )}
          </div>
        </header>

        <div className="px-8 py-8 w-full space-y-6">
          {!loading && !error && (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              {[
                { label: "Total",     value: total,         color: "bg-indigo-50 text-indigo-700" },
                { label: "Activas",   value: activeCount,   color: "bg-emerald-50 text-emerald-700" },
                { label: "Expiradas", value: expiredCount,  color: "bg-red-50 text-red-700" },
                { label: "Perpetuas", value: perpetualCount, color: "bg-slate-50 text-slate-700" },
              ].map(({ label, value, color }) => (
                <div key={label} className={`rounded-xl ${color.split(" ")[0]} px-4 py-3 ring-1 ring-inset ring-current/10`}>
                  <p className={`text-2xl font-bold ${color.split(" ")[1]}`}>{value}</p>
                  <p className="text-xs font-medium text-slate-500 mt-0.5">{label}</p>
                </div>
              ))}
            </div>
          )}

          <div className="rounded-2xl bg-white shadow-sm ring-1 ring-slate-200 overflow-hidden">
            <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
              <h2 className="text-sm font-semibold text-slate-700 flex items-center gap-2"><Key className="h-4 w-4 text-slate-400" />Listado de licencias</h2>
              <div className="flex items-center gap-2">
                {activeFilterCount > 0 && (
                  <>
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-indigo-100 px-2.5 py-1 text-xs font-semibold text-indigo-700">
                      <Search className="h-3 w-3" />{activeFilterCount} filtro{activeFilterCount > 1 ? "s" : ""} activo{activeFilterCount > 1 ? "s" : ""}
                    </span>
                    <button onClick={clearFilters} className="flex items-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-medium text-red-600 hover:bg-red-100 transition-colors">
                      <FilterX className="h-3.5 w-3.5" />Limpiar filtros
                    </button>
                  </>
                )}
                <button onClick={handleExportCSV} disabled={loading || licenses.length === 0}
                  className="flex items-center gap-1.5 rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-100 transition-colors disabled:opacity-50">
                  <Download className="h-3.5 w-3.5" />CSV
                </button>
                <button onClick={fetchLicenses}
                  className="flex items-center justify-center rounded-lg border border-slate-300 bg-slate-50 p-2 text-slate-500 hover:bg-slate-100 transition-colors">
                  <RefreshCw className="h-4 w-4" />
                </button>
              </div>
            </div>

            {loading && (
              <div className="flex items-center justify-center py-20 text-slate-400">
                <RefreshCw className="mr-2 h-5 w-5 animate-spin" /><span className="text-sm">Cargando licencias…</span>
              </div>
            )}
            {error && !loading && (
              <div className="flex flex-col items-center justify-center gap-2 py-16 text-red-500">
                <AlertTriangle className="h-8 w-8" /><p className="text-sm font-medium">Error al cargar las licencias</p>
                <p className="text-xs text-slate-400">{error}</p>
                <button onClick={fetchLicenses} className="mt-2 rounded-lg bg-red-50 px-4 py-1.5 text-xs font-medium text-red-600 hover:bg-red-100">Reintentar</button>
              </div>
            )}

            {!loading && !error && (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-100 bg-slate-50 text-left">
                      <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wider text-slate-500">Licencia</th>
                      <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wider text-slate-500">Proveedor</th>
                      <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wider text-slate-500">Tipo / Métrica</th>
                      <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wider text-slate-500">
                        <div className="flex items-center gap-1"><Calendar className="h-3.5 w-3.5" />Estado / Vencimiento</div>
                      </th>
                      <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wider text-slate-500">Coste</th>
                      <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wider text-slate-500">CIs</th>
                      <th className="px-4 py-3" />
                    </tr>
                    <tr className="border-b-2 border-indigo-100 bg-indigo-50/60">
                      {/* Licencia name/number search */}
                      <td className="px-3 py-2">
                        <div className="relative">
                          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                          <input type="text" placeholder="Nombre o nº licencia…" value={filters.name}
                            onChange={(e) => setFilter("name", e.target.value)}
                            className="w-full rounded-md border border-slate-200 bg-white py-1.5 pl-7 pr-2 text-xs text-slate-700 placeholder:text-slate-300 focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-200" />
                        </div>
                      </td>
                      {/* Proveedor */}
                      <td className="px-3 py-2">
                        <div className="relative">
                          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                          <input type="text" placeholder="Proveedor…" value={filters.vendor}
                            onChange={(e) => setFilter("vendor", e.target.value)}
                            className="w-full rounded-md border border-slate-200 bg-white py-1.5 pl-7 pr-2 text-xs text-slate-700 placeholder:text-slate-300 focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-200" />
                        </div>
                      </td>
                      {/* Tipo — text search on type name */}
                      <td className="px-3 py-2">
                        <div className="relative">
                          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                          <input type="text" placeholder="Tipo…" value={filters.licenseType}
                            onChange={(e) => setFilter("licenseType", e.target.value)}
                            className="w-full rounded-md border border-slate-200 bg-white py-1.5 pl-7 pr-2 text-xs text-slate-700 placeholder:text-slate-300 focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-200" />
                        </div>
                      </td>
                      {/* Estado */}
                      <td className="px-3 py-2">
                        <select value={filters.status} onChange={(e) => setFilter("status", e.target.value)}
                          className={`w-full rounded-md border py-1.5 px-2 text-xs focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-200 ${filters.status ? "border-indigo-400 bg-indigo-50 text-indigo-700 font-medium" : "border-slate-200 bg-white text-slate-600"}`}>
                          <option value="">Todos</option>
                          <option value="activa">Activa</option>
                          <option value="renueva">Renueva pronto</option>
                          <option value="expirada">Expirada</option>
                          <option value="baja">Baja</option>
                        </select>
                      </td>
                      {/* Coste — no filter */}
                      <td className="px-3 py-2" />
                      {/* CIs — no filter */}
                      <td className="px-3 py-2" />
                      {/* Chevron — empty */}
                      <td className="px-3 py-2" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {filteredLicenses.length === 0 ? (
                      <tr><td colSpan={7} className="py-16 text-center text-slate-400 text-sm">
                        {licenses.length === 0
                          ? <>{`No hay licencias. `}{isAdmin && <><strong>Nueva Licencia</strong> para empezar.</>}</>
                          : "Ninguna licencia coincide con los filtros activos."}
                      </td></tr>
                    ) : (
                      filteredLicenses.map((l) => (
                        <LicenseRow
                          key={l.id}
                          license={l}
                          expanded={expanded === l.id}
                          onExpand={() => setExpanded((p) => (p === l.id ? null : l.id))}
                        />
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            )}

            {!loading && !error && (
              <div className="border-t border-slate-100 px-6 py-3 text-xs text-slate-400">
                {filteredLicenses.length} licencia{filteredLicenses.length !== 1 ? "s" : ""}
                {activeFilterCount > 0 ? ` (de ${total} totales)` : " · Haz clic en una fila para ver detalles"}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

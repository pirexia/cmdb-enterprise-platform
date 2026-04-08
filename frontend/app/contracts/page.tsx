"use client";

import { useEffect, useState, useRef, useMemo } from "react";
import Link from "next/link";
import {
  FileText, Plus, RefreshCw, AlertTriangle, Building, Calendar, Server,
  ChevronRight, GitBranch, Download, Eye, EyeOff, X, Search, Check, FilterX,
} from "lucide-react";
import AddContractModal from "@/components/AddContractModal";
import { useAuth } from "@/contexts/AuthContext";
import { apiFetch } from "@/lib/apiFetch";
import { exportToCSV } from "@/lib/csvExport";

// ─── Types ────────────────────────────────────────────────────────────────────

interface CIRef       { id: string; name: string; apiSlug: string; environment: string; criticality: string }
interface ContractRef { id: string; contractNumber: string }
interface DocRef      {
  id: string; title: string; documentTypeName: string; documentTypeCode: string;
  originalName: string; versionNumber: number; uploadedBy: string; createdAt: string;
  mimeType: string;
}
interface AllDocRef   {
  id: string; title: string; documentTypeName: string; originalName: string;
  mimeType: string; latestVersionId: string;
}
interface Contract {
  id: string; contractNumber: string; startDate: string; endDate: string | null;
  vendor: { id: string; name: string }; cis: CIRef[];
  parentContract: ContractRef | null; addendums: ContractRef[];
}

// Preview state stored per-doc
interface PreviewState {
  blobUrl: string | null;
  text: string | null;
  loading: boolean;
  error: boolean;
  mimeType: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getContractStatus(endDate: string | null) {
  if (!endDate) return { label: "Sin vencimiento", color: "text-slate-500", dot: "bg-slate-300" };
  const diff = (new Date(endDate).getTime() - Date.now()) / 86400000;
  if (diff < 0)  return { label: "Vencido",      color: "text-red-600",    dot: "bg-red-500" };
  if (diff < 30) return { label: "Vence pronto", color: "text-orange-600", dot: "bg-orange-400" };
  return            { label: "Activo",       color: "text-emerald-600",dot: "bg-emerald-400" };
}
function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("es-ES", { day: "2-digit", month: "short", year: "numeric" });
}

// ─── Row ──────────────────────────────────────────────────────────────────────

function ContractRow({ contract, onExpand, expanded }: { contract: Contract; onExpand: () => void; expanded: boolean }) {
  const status     = getContractStatus(contract.endDate);
  const isAddendum = !!contract.parentContract;
  const { token, isAdmin }  = useAuth();
  const apiBase = process.env.NEXT_PUBLIC_API_URL ?? "";

  // ── Docs state ──────────────────────────────────────────────────────────────
  const [docs, setDocs]               = useState<DocRef[]>([]);
  const [docsLoading, setDocsLoading] = useState(false);
  const [docsFetched, setDocsFetched] = useState(false);

  // Preview state map: docId → PreviewState
  const [previews, setPreviews] = useState<Map<string, PreviewState>>(new Map());
  const [openPreviews, setOpenPreviews] = useState<Set<string>>(new Set());

  // Blob URLs to revoke on unmount
  const blobUrlsRef = useRef<string[]>([]);
  useEffect(() => {
    return () => { blobUrlsRef.current.forEach((u) => URL.revokeObjectURL(u)); };
  }, []);

  // ── All-docs selector for "Asociar Documentos" ──────────────────────────────
  const [showDocSelector, setShowDocSelector] = useState(false);
  const [allDocs, setAllDocs]                 = useState<AllDocRef[]>([]);
  const [allDocsLoading, setAllDocsLoading]   = useState(false);
  const [docSearch, setDocSearch]             = useState("");
  const [selectedDocIds, setSelectedDocIds]   = useState<Set<string>>(new Set());
  const [docAssocLoading, setDocAssocLoading] = useState(false);

  // ── CIs state ───────────────────────────────────────────────────────────────
  const [cis, setCis]               = useState<CIRef[]>(contract.cis);
  const [cisFetched, setCisFetched] = useState(false);

  // All-CIs selector for "Asociar CIs"
  const [showCISelector, setShowCISelector]   = useState(false);
  const [allCIs, setAllCIs]                   = useState<CIRef[]>([]);
  const [allCIsLoading, setAllCIsLoading]     = useState(false);
  const [ciSearch, setCiSearch]               = useState("");
  const [selectedCiIds, setSelectedCiIds]     = useState<Set<string>>(new Set());
  const [ciAssocLoading, setCiAssocLoading]   = useState(false);

  // ── Fetch docs on expand ────────────────────────────────────────────────────
  useEffect(() => {
    if (!expanded || docsFetched) return;
    setDocsLoading(true);
    apiFetch(`/api/contracts/${contract.id}/documents`)
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((data: DocRef[]) => setDocs(data))
      .catch(() => setDocs([]))
      .finally(() => { setDocsLoading(false); setDocsFetched(true); });
  }, [expanded, contract.id, docsFetched]);

  // Fetch CIs on expand (fresh from API, overrides prop)
  useEffect(() => {
    if (!expanded || cisFetched) return;
    apiFetch(`/api/contracts/${contract.id}/cis`)
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((data: CIRef[]) => setCis(data))
      .catch(() => {})
      .finally(() => setCisFetched(true));
  }, [expanded, contract.id, cisFetched]);

  // ── Download ────────────────────────────────────────────────────────────────
  const handleDownload = async (docId: string, fileName: string) => {
    const res = await fetch(`${apiBase}/api/documents/${docId}/download`, {
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

  // ── Preview ─────────────────────────────────────────────────────────────────
  const togglePreview = async (doc: DocRef) => {
    const docId = doc.id;

    if (openPreviews.has(docId)) {
      setOpenPreviews((prev) => { const s = new Set(prev); s.delete(docId); return s; });
      return;
    }

    // Already fetched
    if (previews.has(docId)) {
      setOpenPreviews((prev) => new Set(prev).add(docId));
      return;
    }

    // Mark loading
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
      } else if (mimeType.startsWith("text/") || mimeType === "text/csv" || mimeType === "application/csv") {
        const text = await res.text();
        setPreviews((prev) => new Map(prev).set(docId, { blobUrl: null, text, loading: false, error: false, mimeType }));
      } else {
        setPreviews((prev) => new Map(prev).set(docId, { blobUrl: null, text: null, loading: false, error: false, mimeType }));
      }
    } catch {
      setPreviews((prev) => new Map(prev).set(docId, { blobUrl: null, text: null, loading: false, error: true, mimeType: doc.mimeType }));
    }
  };

  // ── CI remove ───────────────────────────────────────────────────────────────
  const handleRemoveCI = async (ciId: string) => {
    const res = await apiFetch(`/api/contracts/${contract.id}/cis/${ciId}`, { method: "DELETE" });
    if (res.ok) setCis((prev) => prev.filter((c) => c.id !== ciId));
  };

  // ── CI associate ─────────────────────────────────────────────────────────────
  const openCISelector = async () => {
    setShowCISelector(true);
    setSelectedCiIds(new Set());
    setCiSearch("");
    if (allCIs.length === 0) {
      setAllCIsLoading(true);
      apiFetch("/api/cis")
        .then((r) => (r.ok ? r.json() : Promise.reject()))
        .then((data) => {
          // API may return { data: CIRef[] } or CIRef[]
          const list: CIRef[] = Array.isArray(data) ? data : (data.data ?? []);
          setAllCIs(list);
        })
        .catch(() => {})
        .finally(() => setAllCIsLoading(false));
    }
  };

  const confirmCIAssoc = async () => {
    if (selectedCiIds.size === 0) return;
    setCiAssocLoading(true);
    try {
      const res = await apiFetch(`/api/contracts/${contract.id}/cis`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ciIds: Array.from(selectedCiIds) }),
      });
      if (res.ok) {
        // Reload CIs
        const fresh = await apiFetch(`/api/contracts/${contract.id}/cis`);
        if (fresh.ok) setCis(await fresh.json());
      }
    } finally {
      setCiAssocLoading(false);
      setShowCISelector(false);
    }
  };

  // ── Doc associate ────────────────────────────────────────────────────────────
  const openDocSelector = async () => {
    setShowDocSelector(true);
    setSelectedDocIds(new Set());
    setDocSearch("");
    if (allDocs.length === 0) {
      setAllDocsLoading(true);
      apiFetch("/api/documents")
        .then((r) => (r.ok ? r.json() : Promise.reject()))
        .then((data: AllDocRef[]) => setAllDocs(Array.isArray(data) ? data : []))
        .catch(() => {})
        .finally(() => setAllDocsLoading(false));
    }
  };

  const confirmDocAssoc = async () => {
    if (selectedDocIds.size === 0) return;
    setDocAssocLoading(true);
    try {
      await Promise.all(
        Array.from(selectedDocIds).map((docId) =>
          apiFetch(`/api/documents/${docId}/contracts`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ contractIds: [contract.id] }),
          })
        )
      );
      // Reload docs
      const fresh = await apiFetch(`/api/contracts/${contract.id}/documents`);
      if (fresh.ok) setDocs(await fresh.json());
    } finally {
      setDocAssocLoading(false);
      setShowDocSelector(false);
    }
  };

  // ── Filtered lists ────────────────────────────────────────────────────────────
  const associatedCiIds = new Set(cis.map((c) => c.id));
  const filteredAllCIs  = allCIs
    .filter((ci) => !associatedCiIds.has(ci.id))
    .filter((ci) => ci.name.toLowerCase().includes(ciSearch.toLowerCase()) || ci.apiSlug.toLowerCase().includes(ciSearch.toLowerCase()));

  const associatedDocIds  = new Set(docs.map((d) => d.id));
  const filteredAllDocs   = allDocs
    .filter((d) => !associatedDocIds.has(d.id))
    .filter((d) => d.title.toLowerCase().includes(docSearch.toLowerCase()) || d.originalName.toLowerCase().includes(docSearch.toLowerCase()));

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <>
      <tr className="group cursor-pointer hover:bg-indigo-50/40 transition-colors" onClick={onExpand}>
        <td className="px-6 py-4">
          <div className="flex items-center gap-2">
            {isAddendum && <span title="Adenda"><GitBranch className="h-3.5 w-3.5 flex-shrink-0 text-amber-400" /></span>}
            <div>
              <p className="font-semibold text-slate-800 group-hover:text-indigo-700 transition-colors">{contract.contractNumber}</p>
              {isAddendum && <p className="text-[11px] text-amber-600">Adenda de {contract.parentContract!.contractNumber}</p>}
              {contract.addendums.length > 0 && <p className="text-[11px] text-slate-400">{contract.addendums.length} adenda{contract.addendums.length > 1 ? "s" : ""}</p>}
            </div>
          </div>
        </td>
        <td className="px-6 py-4"><div className="flex items-center gap-2 text-slate-700"><Building className="h-3.5 w-3.5 text-slate-400 flex-shrink-0" /><span className="text-sm font-medium">{contract.vendor.name}</span></div></td>
        <td className="px-6 py-4">
          <div className="flex items-center gap-2">
            <span className={`inline-flex h-2 w-2 rounded-full flex-shrink-0 ${status.dot}`} />
            <div>
              <p className={`text-sm font-medium ${status.color}`}>{status.label}</p>
              {contract.endDate && <p className="text-xs text-slate-400">{formatDate(contract.endDate)}</p>}
            </div>
          </div>
        </td>
        <td className="px-6 py-4">
          <div className="flex items-center gap-1.5 text-slate-600">
            <Server className="h-3.5 w-3.5 text-slate-400 flex-shrink-0" />
            <span className="text-sm font-medium">{cis.length}</span>
            <span className="text-xs text-slate-400">CI{cis.length !== 1 ? "s" : ""}</span>
          </div>
        </td>
        <td className="px-4 py-4 text-right">
          <ChevronRight className={`h-4 w-4 text-slate-400 transition-transform inline-block ${expanded ? "rotate-90" : ""}`} />
        </td>
      </tr>

      {expanded && (
        <tr>
          <td colSpan={5} className="px-6 pb-4 bg-indigo-50/30">
            <div className="space-y-3 pt-1">

              {/* ── CIs cubiertos ─────────────────────────────────────────── */}
              <div className="rounded-xl border border-indigo-100 bg-white overflow-hidden">
                <div className="border-b border-slate-100 bg-slate-50 px-4 py-2 flex items-center justify-between">
                  <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">CIs cubiertos</p>
                  {isAdmin && (
                    <button
                      onClick={(e) => { e.stopPropagation(); openCISelector(); }}
                      className="flex items-center gap-1 rounded-md bg-indigo-50 px-2 py-1 text-xs font-medium text-indigo-600 hover:bg-indigo-100 transition-colors"
                    >
                      <Plus className="h-3 w-3" />Asociar CIs
                    </button>
                  )}
                </div>

                {cis.length === 0 ? (
                  <p className="px-4 py-3 text-sm italic text-slate-400">Este contrato no tiene CIs asociados.</p>
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
                            <button
                              onClick={(e) => { e.stopPropagation(); handleRemoveCI(ci.id); }}
                              className="ml-1 rounded p-0.5 text-slate-400 hover:text-red-500 hover:bg-red-50 transition-colors"
                              title="Quitar CI"
                            >
                              <X className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* CI inline selector */}
                {showCISelector && (
                  <div className="border-t border-indigo-100 px-4 py-3 bg-indigo-50/40" onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center gap-2 mb-2">
                      <Search className="h-3.5 w-3.5 text-slate-400 flex-shrink-0" />
                      <input
                        type="text"
                        placeholder="Buscar CI…"
                        value={ciSearch}
                        onChange={(e) => setCiSearch(e.target.value)}
                        className="flex-1 text-sm border border-slate-200 rounded-md px-2 py-1 outline-none focus:ring-1 focus:ring-indigo-400 bg-white"
                      />
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
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => setSelectedCiIds((prev) => {
                                  const s = new Set(prev);
                                  if (checked) s.delete(ci.id); else s.add(ci.id);
                                  return s;
                                })}
                                className="accent-indigo-600"
                              />
                              <span className="font-medium text-slate-700">{ci.name}</span>
                              <span className="text-xs text-slate-400 truncate">{ci.apiSlug}</span>
                            </label>
                          );
                        })}
                      </div>
                    )}
                    <div className="flex items-center justify-end gap-2 mt-2">
                      <button onClick={() => setShowCISelector(false)} className="text-xs text-slate-500 hover:text-slate-700 px-2 py-1">Cancelar</button>
                      <button
                        onClick={confirmCIAssoc}
                        disabled={selectedCiIds.size === 0 || ciAssocLoading}
                        className="flex items-center gap-1 rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-50 transition-colors"
                      >
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
                    <button
                      onClick={(e) => { e.stopPropagation(); openDocSelector(); }}
                      className="flex items-center gap-1 rounded-md bg-slate-100 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-indigo-50 hover:text-indigo-700 transition-colors"
                    >
                      <Plus className="h-3 w-3" />Asociar Documentos
                    </button>
                  )}
                </div>

                {docsLoading ? (
                  <div className="flex items-center gap-2 px-4 py-3 text-slate-400 text-sm">
                    <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                    <span>Cargando documentos…</span>
                  </div>
                ) : docs.length === 0 ? (
                  <p className="px-4 py-3 text-sm italic text-slate-400">No hay documentos asociados a este contrato.</p>
                ) : (
                  <div className="divide-y divide-slate-50">
                    {docs.map((doc) => {
                      const previewOpen   = openPreviews.has(doc.id);
                      const previewState  = previews.get(doc.id);

                      return (
                        <div key={doc.id}>
                          {/* Document row */}
                          <div className="flex items-center justify-between px-4 py-2.5 gap-3">
                            <div className="flex items-start gap-2 min-w-0">
                              <FileText className="h-4 w-4 flex-shrink-0 text-indigo-400 mt-0.5" />
                              <div className="min-w-0">
                                <Link href={`/documents/${doc.id}`} className="text-sm font-medium text-indigo-700 hover:underline truncate block" onClick={(e) => e.stopPropagation()}>
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
                            <div className="flex items-center gap-1.5 flex-shrink-0">
                              {/* Preview toggle */}
                              <button
                                onClick={(e) => { e.stopPropagation(); togglePreview(doc); }}
                                className="flex items-center gap-1 rounded-md bg-slate-100 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-indigo-50 hover:text-indigo-700 transition-colors"
                                title={previewOpen ? "Ocultar vista previa" : "Vista previa"}
                              >
                                {previewOpen ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                                {previewOpen ? "Ocultar" : "Vista previa"}
                              </button>
                              {/* Download */}
                              <button
                                onClick={(e) => { e.stopPropagation(); handleDownload(doc.id, doc.originalName); }}
                                className="flex items-center gap-1 rounded-md bg-slate-100 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-indigo-50 hover:text-indigo-700 transition-colors"
                                title="Descargar"
                              >
                                <Download className="h-3.5 w-3.5" />
                                Descargar
                              </button>
                            </div>
                          </div>

                          {/* Preview panel */}
                          {previewOpen && (
                            <div className="px-4 pb-3" onClick={(e) => e.stopPropagation()}>
                              {!previewState || previewState.loading ? (
                                <div className="flex items-center gap-2 py-3 text-slate-400 text-xs">
                                  <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                                  <span>Cargando vista previa…</span>
                                </div>
                              ) : previewState.error ? (
                                <div className="flex items-center gap-2 py-3 text-red-400 text-xs">
                                  <AlertTriangle className="h-3.5 w-3.5" />
                                  <span>Error al cargar la vista previa.</span>
                                </div>
                              ) : previewState.mimeType === "application/pdf" && previewState.blobUrl ? (
                                <iframe
                                  src={previewState.blobUrl}
                                  style={{ height: "400px" }}
                                  className="w-full border-0 rounded-lg ring-1 ring-slate-200"
                                  title={doc.title}
                                />
                              ) : previewState.mimeType.startsWith("image/") && previewState.blobUrl ? (
                                <img
                                  src={previewState.blobUrl}
                                  alt={doc.title}
                                  className="max-w-full max-h-60 rounded-lg object-contain ring-1 ring-slate-200"
                                />
                              ) : previewState.text !== null ? (
                                <pre className="max-h-60 overflow-auto rounded-lg bg-slate-50 ring-1 ring-slate-200 p-3 text-xs text-slate-700 whitespace-pre-wrap">
                                  {previewState.text}
                                </pre>
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

                {/* Doc inline selector */}
                {showDocSelector && (
                  <div className="border-t border-slate-100 px-4 py-3 bg-slate-50/60" onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center gap-2 mb-2">
                      <Search className="h-3.5 w-3.5 text-slate-400 flex-shrink-0" />
                      <input
                        type="text"
                        placeholder="Buscar documento…"
                        value={docSearch}
                        onChange={(e) => setDocSearch(e.target.value)}
                        className="flex-1 text-sm border border-slate-200 rounded-md px-2 py-1 outline-none focus:ring-1 focus:ring-indigo-400 bg-white"
                      />
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
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => setSelectedDocIds((prev) => {
                                  const s = new Set(prev);
                                  if (checked) s.delete(d.id); else s.add(d.id);
                                  return s;
                                })}
                                className="accent-indigo-600"
                              />
                              <span className="font-medium text-slate-700 truncate">{d.title}</span>
                              <span className="text-xs text-slate-400 truncate flex-shrink-0">{d.documentTypeName}</span>
                            </label>
                          );
                        })}
                      </div>
                    )}
                    <div className="flex items-center justify-end gap-2 mt-2">
                      <button onClick={() => setShowDocSelector(false)} className="text-xs text-slate-500 hover:text-slate-700 px-2 py-1">Cancelar</button>
                      <button
                        onClick={confirmDocAssoc}
                        disabled={selectedDocIds.size === 0 || docAssocLoading}
                        className="flex items-center gap-1 rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-50 transition-colors"
                      >
                        {docAssocLoading ? <RefreshCw className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                        Confirmar ({selectedDocIds.size})
                      </button>
                    </div>
                  </div>
                )}

                {docsFetched && (
                  <div className="border-t border-slate-50 px-4 py-2 text-right">
                    <Link href="/documents" className="text-xs text-indigo-500 hover:text-indigo-700 hover:underline transition-colors">
                      Ver todos los documentos →
                    </Link>
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

export default function ContractsPage() {
  const { isAdmin }               = useAuth();
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [expanded, setExpanded]   = useState<string | null>(null);

  const [filters, setFilters] = useState({ contractNumber: "", vendor: "", status: "", type: "" });
  const activeFilterCount = Object.values(filters).filter(Boolean).length;
  const setFilter = (key: keyof typeof filters, val: string) => setFilters((prev) => ({ ...prev, [key]: val }));
  const clearFilters = () => setFilters({ contractNumber: "", vendor: "", status: "", type: "" });

  const fetchContracts = async () => {
    setLoading(true); setError(null);
    try {
      const res = await apiFetch("/api/contracts");
      if (!res.ok) throw new Error(`Status ${res.status}`);
      const json: { total: number; data: Contract[] } = await res.json();
      setContracts(json.data);
    } catch (err) { setError(err instanceof Error ? err.message : "Unknown error"); }
    finally { setLoading(false); }
  };

  useEffect(() => { fetchContracts(); }, []);

  const filteredContracts = useMemo(() => {
    return contracts.filter((c) => {
      if (filters.contractNumber && !c.contractNumber.toLowerCase().includes(filters.contractNumber.toLowerCase())) return false;
      if (filters.vendor && !c.vendor.name.toLowerCase().includes(filters.vendor.toLowerCase())) return false;
      if (filters.type) {
        if (filters.type === "principal" && c.parentContract !== null) return false;
        if (filters.type === "adenda" && c.parentContract === null) return false;
      }
      if (filters.status) {
        const st = getContractStatus(c.endDate);
        if (filters.status === "activo" && st.label !== "Activo") return false;
        if (filters.status === "vence_pronto" && st.label !== "Vence pronto") return false;
        if (filters.status === "vencido" && st.label !== "Vencido") return false;
        if (filters.status === "sin_vencimiento" && st.label !== "Sin vencimiento") return false;
      }
      return true;
    });
  }, [contracts, filters]);

  const total    = contracts.length;
  const addendums = contracts.filter((c) => c.parentContract !== null).length;
  const expiredCount = contracts.filter((c) => c.endDate && new Date(c.endDate) < new Date()).length;

  const handleExportCSV = () => {
    exportToCSV(
      `contratos-${new Date().toISOString().slice(0, 10)}.csv`,
      ["Nº Contrato", "Proveedor", "Tipo", "Fecha Inicio", "Fecha Fin", "Estado", "CIs Cubiertos", "Adendas"],
      contracts.map((c) => {
        const status = getContractStatus(c.endDate);
        const type   = c.parentContract ? "Adenda" : "Principal";
        return [
          c.contractNumber, c.vendor.name, type,
          formatDate(c.startDate),
          c.endDate ? formatDate(c.endDate) : "—",
          status.label,
          c.cis.length,
          c.addendums.length,
        ];
      })
    );
  };

  return (
    <>
      {showModal && <AddContractModal onClose={() => setShowModal(false)} onCreated={fetchContracts} />}
      <div className="min-h-screen bg-slate-50">
        <header className="sticky top-0 z-10 border-b border-slate-200 bg-white px-8 py-5">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-xl font-bold text-slate-900">Contratos y Adendas</h1>
              <p className="text-sm text-slate-500 mt-0.5">{loading ? "Cargando…" : `${total} contratos · ${addendums} adendas · ${expiredCount} vencidos`}</p>
            </div>
            {isAdmin && (
              <button onClick={() => setShowModal(true)} className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700 transition-colors shadow-sm">
                <Plus className="h-4 w-4" />Nuevo Contrato
              </button>
            )}
          </div>
        </header>

        <div className="px-8 py-8 w-full space-y-6">
          {!loading && !error && (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              {[
                { label: "Total",     value: total,     color: "bg-indigo-50 text-indigo-700" },
                { label: "Adendas",   value: addendums, color: "bg-amber-50 text-amber-700" },
                { label: "Vencidos",  value: expiredCount, color: "bg-red-50 text-red-700" },
                { label: "Con CIs",   value: contracts.filter((c) => c.cis.length > 0).length, color: "bg-emerald-50 text-emerald-700" },
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
              <h2 className="text-sm font-semibold text-slate-700 flex items-center gap-2"><FileText className="h-4 w-4 text-slate-400" />Listado de contratos</h2>
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
                <button
                  onClick={handleExportCSV}
                  disabled={loading || contracts.length === 0}
                  className="flex items-center gap-1.5 rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-100 transition-colors disabled:opacity-50"
                >
                  <Download className="h-3.5 w-3.5" />CSV
                </button>
                <button onClick={fetchContracts} className="flex items-center justify-center rounded-lg border border-slate-300 bg-slate-50 p-2 text-slate-500 hover:bg-slate-100 transition-colors"><RefreshCw className="h-4 w-4" /></button>
              </div>
            </div>

            {loading && <div className="flex items-center justify-center py-20 text-slate-400"><RefreshCw className="mr-2 h-5 w-5 animate-spin" /><span className="text-sm">Cargando contratos…</span></div>}
            {error && !loading && (
              <div className="flex flex-col items-center justify-center gap-2 py-16 text-red-500">
                <AlertTriangle className="h-8 w-8" /><p className="text-sm font-medium">Error al cargar los contratos</p>
                <p className="text-xs text-slate-400">{error}</p>
                <button onClick={fetchContracts} className="mt-2 rounded-lg bg-red-50 px-4 py-1.5 text-xs font-medium text-red-600 hover:bg-red-100">Reintentar</button>
              </div>
            )}

            {!loading && !error && (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-100 bg-slate-50 text-left">
                      <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wider text-slate-500">Nº Contrato</th>
                      <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wider text-slate-500">Proveedor</th>
                      <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wider text-slate-500">
                        <div className="flex items-center gap-1"><Calendar className="h-3.5 w-3.5" />Estado / Vencimiento</div>
                      </th>
                      <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wider text-slate-500">CIs Cubiertos</th>
                      <th className="px-4 py-3" />
                    </tr>
                    <tr className="border-b-2 border-indigo-100 bg-indigo-50/60">
                      {/* Nº Contrato */}
                      <td className="px-3 py-2">
                        <div className="relative">
                          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                          <input type="text" placeholder="Buscar contrato…" value={filters.contractNumber}
                            onChange={(e) => setFilter("contractNumber", e.target.value)}
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
                      {/* Status */}
                      <td className="px-3 py-2">
                        <select value={filters.status} onChange={(e) => setFilter("status", e.target.value)}
                          className={`w-full rounded-md border py-1.5 px-2 text-xs focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-200 ${filters.status ? "border-indigo-400 bg-indigo-50 text-indigo-700 font-medium" : "border-slate-200 bg-white text-slate-600"}`}>
                          <option value="">Todos</option>
                          <option value="activo">Activo</option>
                          <option value="vence_pronto">Vence pronto</option>
                          <option value="vencido">Vencido</option>
                          <option value="sin_vencimiento">Sin vencimiento</option>
                        </select>
                      </td>
                      {/* CIs — type filter */}
                      <td className="px-3 py-2">
                        <select value={filters.type} onChange={(e) => setFilter("type", e.target.value)}
                          className={`w-full rounded-md border py-1.5 px-2 text-xs focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-200 ${filters.type ? "border-indigo-400 bg-indigo-50 text-indigo-700 font-medium" : "border-slate-200 bg-white text-slate-600"}`}>
                          <option value="">Todos</option>
                          <option value="principal">Principal</option>
                          <option value="adenda">Adenda</option>
                        </select>
                      </td>
                      {/* Chevron col — empty */}
                      <td className="px-3 py-2" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {filteredContracts.length === 0 ? (
                      <tr><td colSpan={5} className="py-16 text-center text-slate-400 text-sm">
                        {activeFilterCount > 0
                          ? "No hay contratos que coincidan con los filtros aplicados."
                          : <>No hay contratos. {isAdmin && <><strong>Nuevo Contrato</strong> para empezar.</>}</>}
                      </td></tr>
                    ) : (
                      filteredContracts.map((c) => (
                        <ContractRow key={c.id} contract={c} expanded={expanded === c.id} onExpand={() => setExpanded((p) => (p === c.id ? null : c.id))} />
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            )}
            {!loading && !error && (
              <div className="border-t border-slate-100 px-6 py-3 text-xs text-slate-400">
                {filteredContracts.length} contrato{filteredContracts.length !== 1 ? "s" : ""}
                {activeFilterCount > 0 ? ` (de ${total} totales)` : " · Haz clic en una fila para ver los CIs"}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

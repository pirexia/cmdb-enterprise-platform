"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  FolderOpen, Upload, Trash2, Download, RefreshCw,
  AlertTriangle, FileText, X, ChevronUp, ChevronDown, ChevronsUpDown,
  FilterX, Search,
} from "lucide-react";

import { useAuth } from "@/contexts/AuthContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { apiFetch } from "@/lib/apiFetch";

// ─── Types ────────────────────────────────────────────────────────────────────

interface DocumentListItem {
  id: string;
  title: string;
  description: string | null;
  documentTypeId: string;
  documentTypeName: string;
  documentTypeCode: string;
  versionNumber: number;
  originalName: string;
  mimeType: string;
  fileSize: number;
  uploadedBy: string;
  createdAt: string;
  latestVersionId: string;
}

interface DocumentType {
  id: string;
  code: string;
  name: string;
  isSystem: boolean;
}

interface CIOption {
  id: string;
  name: string;
  apiSlug: string;
}

interface ContractOption {
  id: string;
  contractNumber: string;
}

type SortField = keyof Pick<DocumentListItem, "title" | "documentTypeName" | "originalName" | "fileSize" | "versionNumber" | "uploadedBy" | "createdAt">;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    day: "2-digit", month: "short", year: "numeric",
  });
}

// ─── Sort header ──────────────────────────────────────────────────────────────

function SortTh({
  field, label, sortField, sortDir, onSort,
}: {
  field: SortField; label: string;
  sortField: SortField; sortDir: "asc" | "desc";
  onSort: (f: SortField) => void;
}) {
  const active = sortField === field;
  const Icon = active ? (sortDir === "asc" ? ChevronUp : ChevronDown) : ChevronsUpDown;
  return (
    <th
      onClick={() => onSort(field)}
      className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider cursor-pointer select-none whitespace-nowrap hover:text-slate-700 hover:bg-slate-100 transition-colors"
    >
      <span className="flex items-center gap-1">
        {label}
        <Icon className={`h-3.5 w-3.5 ${active ? "text-indigo-600" : "text-slate-300"}`} />
      </span>
    </th>
  );
}

// ─── Upload Modal ─────────────────────────────────────────────────────────────

function UploadModal({
  docTypes, cis, contracts, token, onClose, onSuccess,
}: {
  docTypes: DocumentType[]; cis: CIOption[]; contracts: ContractOption[];
  token: string | null; onClose: () => void; onSuccess: () => void;
}) {
  const { t } = useLanguage();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [typeId, setTypeId] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [selectedCIs, setSelectedCIs] = useState<string[]>([]);
  const [selectedContracts, setSelectedContracts] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleCI = (id: string) =>
    setSelectedCIs((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  const toggleContract = (id: string) =>
    setSelectedContracts((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);

  const handleSubmit = async () => {
    if (!title.trim()) { setError("El título es obligatorio"); return; }
    if (!typeId) { setError("Selecciona un tipo de documento"); return; }
    if (!file) { setError("Selecciona un archivo"); return; }
    setSubmitting(true); setError(null);
    try {
      const formData = new FormData();
      formData.append("title", title.trim());
      if (description.trim()) formData.append("description", description.trim());
      formData.append("documentTypeId", typeId);
      formData.append("file", file);
      if (selectedCIs.length) formData.append("ciIds", JSON.stringify(selectedCIs));
      if (selectedContracts.length) formData.append("contractIds", JSON.stringify(selectedContracts));
      const apiBase = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";
      const res = await fetch(`${apiBase}/api/documents`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(d.error ?? `Error ${res.status}`);
      }
      onSuccess();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("documents.upload_error"));
    } finally { setSubmitting(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-lg rounded-2xl bg-white shadow-xl flex flex-col max-h-[90vh]">
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
          <div className="flex items-center gap-2">
            <Upload className="h-5 w-5 text-indigo-600" />
            <h2 className="text-base font-semibold text-slate-900">{t("documents.upload")}</h2>
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 transition-colors"><X className="h-4 w-4" /></button>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
          {error && (
            <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
              <AlertTriangle className="h-4 w-4 flex-shrink-0" />{error}
            </div>
          )}
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1">{t("documents.form_title")} *</label>
            <input value={title} onChange={(e) => setTitle(e.target.value)}
              className="w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
              placeholder={t("documents.form_title")} />
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1">{t("documents.form_description")}</label>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2}
              className="w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100 resize-none"
              placeholder={t("documents.form_description")} />
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1">{t("documents.form_type")} *</label>
            <select value={typeId} onChange={(e) => setTypeId(e.target.value)}
              className="w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-800 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100">
              <option value="">— {t("documents.form_type")} —</option>
              {docTypes.map((dt) => <option key={dt.id} value={dt.id}>{dt.name}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1">{t("documents.form_file")} *</label>
            <input type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-800 file:mr-3 file:rounded-md file:border-0 file:bg-indigo-600 file:px-3 file:py-1 file:text-xs file:font-semibold file:text-white hover:file:bg-indigo-700 focus:outline-none" />
            {file && <p className="mt-1 text-xs text-slate-500">{file.name} ({formatFileSize(file.size)})</p>}
          </div>
          {cis.length > 0 && (
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1">{t("documents.form_associate_cis")}</label>
              <div className="max-h-32 overflow-y-auto rounded-lg border border-slate-200 divide-y divide-slate-100">
                {cis.map((ci) => (
                  <label key={ci.id} className="flex items-center gap-2 px-3 py-1.5 hover:bg-slate-50 cursor-pointer">
                    <input type="checkbox" checked={selectedCIs.includes(ci.id)} onChange={() => toggleCI(ci.id)} className="h-3.5 w-3.5 accent-indigo-600" />
                    <span className="text-xs text-slate-700">{ci.name}</span>
                    <span className="text-xs text-slate-400 font-mono">{ci.apiSlug}</span>
                  </label>
                ))}
              </div>
            </div>
          )}
          {contracts.length > 0 && (
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1">{t("documents.form_associate_contracts")}</label>
              <div className="max-h-32 overflow-y-auto rounded-lg border border-slate-200 divide-y divide-slate-100">
                {contracts.map((c) => (
                  <label key={c.id} className="flex items-center gap-2 px-3 py-1.5 hover:bg-slate-50 cursor-pointer">
                    <input type="checkbox" checked={selectedContracts.includes(c.id)} onChange={() => toggleContract(c.id)} className="h-3.5 w-3.5 accent-indigo-600" />
                    <span className="text-xs text-slate-700 font-mono">{c.contractNumber}</span>
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-200 px-6 py-4">
          <button onClick={onClose} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 transition-colors">{t("actions.cancel")}</button>
          <button onClick={handleSubmit} disabled={submitting}
            className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50 transition-colors">
            {submitting ? <><RefreshCw className="h-4 w-4 animate-spin" />{t("common.loading")}</> : <><Upload className="h-4 w-4" />{t("documents.upload")}</>}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function DocumentsPage() {
  const { t } = useLanguage();
  const { isAdmin, token } = useAuth();
  const router = useRouter();
  const apiBase = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";

  const [documents, setDocuments] = useState<DocumentListItem[]>([]);
  const [docTypes, setDocTypes] = useState<DocumentType[]>([]);
  const [cis, setCIs] = useState<CIOption[]>([]);
  const [contracts, setContracts] = useState<ContractOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showUpload, setShowUpload] = useState(false);

  // ── Filters ─────────────────────────────────────────────────────────────────
  const [filterTitle, setFilterTitle] = useState("");
  const [filterType, setFilterType] = useState("");
  const [filterUser, setFilterUser] = useState("");

  // ── Sort ────────────────────────────────────────────────────────────────────
  const [sortField, setSortField] = useState<SortField>("createdAt");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const handleSort = (field: SortField) => {
    if (sortField === field) setSortDir((d) => d === "asc" ? "desc" : "asc");
    else { setSortField(field); setSortDir("asc"); }
  };

  const hasFilters = filterTitle || filterType || filterUser;
  const activeFilterCount = [filterTitle, filterType, filterUser].filter(Boolean).length;
  const clearFilters = () => { setFilterTitle(""); setFilterType(""); setFilterUser(""); };

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [docsRes, typesRes] = await Promise.all([
        apiFetch("/api/documents"),
        apiFetch("/api/masters/document-types"),
      ]);
      const docsData: unknown = await docsRes.json();
      const typesData: unknown = await typesRes.json();
      setDocuments(((docsData as { data?: DocumentListItem[] }).data) ?? []);
      setDocTypes(Array.isArray(typesData) ? (typesData as DocumentType[]) : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("common.unknown_error"));
    } finally { setLoading(false); }
  }, [t]);

  const loadModalData = useCallback(async () => {
    try {
      const [cisRes, contractsRes] = await Promise.all([apiFetch("/api/cis"), apiFetch("/api/contracts")]);
      const cisData: unknown = await cisRes.json();
      const contractsData: unknown = await contractsRes.json();
      setCIs(((cisData as { data?: CIOption[] }).data) ?? []);
      setContracts(Array.isArray(contractsData) ? (contractsData as ContractOption[]) : []);
    } catch { /* non-blocking */ }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handleOpenUpload = () => { setShowUpload(true); void loadModalData(); };

  const handleDelete = async (doc: DocumentListItem) => {
    if (!confirm(t("documents.delete_confirm"))) return;
    try {
      await apiFetch(`/api/documents/${doc.id}`, { method: "DELETE" });
      void load();
    } catch (e) { alert(e instanceof Error ? e.message : t("common.unknown_error")); }
  };

  const handleDownload = async (doc: DocumentListItem, e: React.MouseEvent) => {
    e.stopPropagation();
    const res = await fetch(`${apiBase}/api/documents/${doc.latestVersionId}/download`, {
      headers: { Authorization: `Bearer ${token ?? ""}` },
    });
    if (!res.ok) return;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = window.document.createElement("a");
    a.href = url; a.download = doc.originalName; a.click();
    URL.revokeObjectURL(url);
  };

  // ── Filter + Sort ────────────────────────────────────────────────────────────
  const filtered = documents
    .filter((d) => {
      const tOk = !filterTitle || d.title.toLowerCase().includes(filterTitle.toLowerCase());
      const yOk = !filterType  || d.documentTypeCode === filterType;
      const uOk = !filterUser  || d.uploadedBy.toLowerCase().includes(filterUser.toLowerCase());
      return tOk && yOk && uOk;
    })
    .sort((a, b) => {
      const va = String(a[sortField] ?? "");
      const vb = String(b[sortField] ?? "");
      const cmp = va.localeCompare(vb, undefined, { numeric: true });
      return sortDir === "asc" ? cmp : -cmp;
    });

  const sortProps = { sortField, sortDir, onSort: handleSort };

  return (
    <>
      <div className="flex flex-col h-screen bg-slate-50 overflow-hidden">
        {/* Header */}
        <header className="flex-shrink-0 border-b border-slate-200 bg-white px-8 py-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <FolderOpen className="h-6 w-6 text-indigo-600" />
              <div>
                <h1 className="text-xl font-bold text-slate-900">{t("documents.title")}</h1>
                <p className="text-sm text-slate-500 mt-0.5">{t("documents.subtitle")}</p>
              </div>
            </div>
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
              <button onClick={() => void load()} disabled={loading}
                className="flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50 transition-colors disabled:opacity-50">
                <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
                {t("actions.refresh")}
              </button>
              {isAdmin && (
                <button onClick={handleOpenUpload}
                  className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 transition-colors">
                  <Upload className="h-4 w-4" />{t("documents.upload")}
                </button>
              )}
            </div>
          </div>

        </header>

        {/* Content */}
        <main className="flex-1 overflow-y-auto px-8 py-6">
          {error && (
            <div className="mb-4 flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
              <AlertTriangle className="h-4 w-4 flex-shrink-0" />{error}
            </div>
          )}
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <div className="flex items-center gap-3 text-slate-400">
                <RefreshCw className="h-5 w-5 animate-spin" />
                <span className="text-sm">{t("common.loading_data")}</span>
              </div>
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-slate-400">
              <FolderOpen className="h-12 w-12 mb-3 opacity-30" />
              <p className="text-sm">{activeFilterCount > 0 ? "No hay documentos que coincidan con los filtros." : t("documents.no_documents")}</p>
            </div>
          ) : (
            <div className="rounded-2xl bg-white shadow-sm ring-1 ring-slate-200 overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-100 bg-slate-50">
                    <SortTh field="title"          label={t("documents.doc_title")}       {...sortProps} />
                    <SortTh field="documentTypeName" label={t("documents.doc_type")}      {...sortProps} />
                    <SortTh field="originalName"   label={t("documents.doc_file")}        {...sortProps} />
                    <SortTh field="fileSize"        label={t("documents.doc_size")}       {...sortProps} />
                    <SortTh field="versionNumber"   label={t("documents.doc_version")}    {...sortProps} />
                    <SortTh field="uploadedBy"      label={t("documents.doc_uploaded_by")} {...sortProps} />
                    <SortTh field="createdAt"       label={t("documents.doc_date")}       {...sortProps} />
                    <th className="px-4 py-3 text-right text-xs font-semibold text-slate-500 uppercase tracking-wider">{t("common.actions")}</th>
                  </tr>
                  <tr className="border-b-2 border-indigo-100 bg-indigo-50/60">
                    {/* Título */}
                    <td className="px-3 py-2">
                      <div className="relative">
                        <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                        <input type="text" placeholder="Buscar título…" value={filterTitle}
                          onChange={(e) => setFilterTitle(e.target.value)}
                          className="w-full rounded-md border border-slate-200 bg-white py-1.5 pl-7 pr-2 text-xs text-slate-700 placeholder:text-slate-300 focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-200" />
                      </div>
                    </td>
                    {/* Tipo */}
                    <td className="px-3 py-2">
                      <select value={filterType} onChange={(e) => setFilterType(e.target.value)}
                        className={`w-full rounded-md border py-1.5 px-2 text-xs focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-200 ${filterType ? "border-indigo-400 bg-indigo-50 text-indigo-700 font-medium" : "border-slate-200 bg-white text-slate-600"}`}>
                        <option value="">Todos los tipos</option>
                        {docTypes.map((dt) => (
                          <option key={dt.code} value={dt.code}>{dt.name}</option>
                        ))}
                      </select>
                    </td>
                    {/* Archivo — no filter */}
                    <td className="px-3 py-2" />
                    {/* Tamaño — no filter */}
                    <td className="px-3 py-2" />
                    {/* Versión — no filter */}
                    <td className="px-3 py-2" />
                    {/* Subido por */}
                    <td className="px-3 py-2">
                      <div className="relative">
                        <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                        <input type="text" placeholder="Usuario…" value={filterUser}
                          onChange={(e) => setFilterUser(e.target.value)}
                          className="w-full rounded-md border border-slate-200 bg-white py-1.5 pl-7 pr-2 text-xs text-slate-700 placeholder:text-slate-300 focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-200" />
                      </div>
                    </td>
                    {/* Fecha — no filter */}
                    <td className="px-3 py-2" />
                    {/* Actions — no filter */}
                    <td className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {filtered.map((doc) => (
                    <tr
                      key={doc.id}
                      className="group cursor-pointer hover:bg-indigo-50/40 transition-colors"
                      onClick={() => router.push(`/documents/${doc.id}`)}
                    >
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <FileText className="h-4 w-4 text-slate-400 flex-shrink-0" />
                          <span className="font-medium text-slate-800 group-hover:text-indigo-700 transition-colors">{doc.title}</span>
                        </div>
                        {doc.description && <p className="ml-6 mt-0.5 text-xs text-slate-400 line-clamp-1">{doc.description}</p>}
                      </td>
                      <td className="px-4 py-3">
                        <span className="inline-flex items-center rounded-full bg-indigo-50 px-2.5 py-0.5 text-xs font-medium text-indigo-700">
                          {doc.documentTypeName}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs text-slate-500 font-mono max-w-[140px] truncate">{doc.originalName}</td>
                      <td className="px-4 py-3 text-xs text-slate-500 whitespace-nowrap">{formatFileSize(doc.fileSize)}</td>
                      <td className="px-4 py-3">
                        <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-600">
                          v{doc.versionNumber}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs text-slate-600 max-w-[120px] truncate">{doc.uploadedBy}</td>
                      <td className="px-4 py-3 text-xs text-slate-500 whitespace-nowrap">{formatDate(doc.createdAt)}</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                          <button onClick={(e) => handleDownload(doc, e)} title={t("documents.download")}
                            className="rounded-lg p-1.5 text-slate-400 hover:bg-indigo-50 hover:text-indigo-600 transition-colors">
                            <Download className="h-4 w-4" />
                          </button>
                          {isAdmin && (
                            <button onClick={() => handleDelete(doc)} title={t("actions.delete")}
                              className="rounded-lg p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600 transition-colors">
                              <Trash2 className="h-4 w-4" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </main>
      </div>

      {showUpload && (
        <UploadModal
          docTypes={docTypes} cis={cis} contracts={contracts} token={token}
          onClose={() => setShowUpload(false)}
          onSuccess={() => { setShowUpload(false); void load(); }}
        />
      )}
    </>
  );
}

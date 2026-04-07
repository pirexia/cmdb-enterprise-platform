"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  FolderOpen, ArrowLeft, Download, Trash2, RefreshCw, AlertTriangle,
  FileText, Upload, Plus, X, Check, Pencil, Link2, Server, Eye, MessageSquare,
} from "lucide-react";

import { useAuth } from "@/contexts/AuthContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { apiFetch } from "@/lib/apiFetch";

// ─── Types ────────────────────────────────────────────────────────────────────

interface DocVersion {
  id: string;
  versionNumber: number;
  isLatest: boolean;
  originalName: string;
  mimeType: string;
  uploadedBy: string;
  createdAt: string;
}

interface DocRelation {
  id: string;
  targetDocId: string;
  targetTitle: string;
  relationType: string;
}

interface DocCI {
  ciId: string;
  ciName: string;
  ciSlug: string;
}

interface DocContract {
  contractId: string;
  contractNumber: string;
}

interface DocNote {
  id: string;
  content: string;
  createdBy: string;
  createdAt: string;
}

interface DocumentDetail {
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
  rootId: string | null;
  isLatest: boolean;
  fileName: string;
  versions: DocVersion[];
  relations: DocRelation[];
  cis: DocCI[];
  contracts: DocContract[];
  notes: DocNote[];
}

interface DocumentType {
  id: string;
  code: string;
  name: string;
  isSystem: boolean;
}

interface DocumentListItem {
  id: string;
  title: string;
  documentTypeName: string;
}

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

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

// ─── Section Card ─────────────────────────────────────────────────────────────

function SectionCard({
  title,
  icon,
  children,
  action,
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl bg-white shadow-sm ring-1 ring-slate-200 overflow-hidden">
      <div className="flex items-center justify-between border-b border-slate-100 bg-slate-50 px-5 py-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-slate-700">
          <span className="text-indigo-500">{icon}</span>
          {title}
        </div>
        {action}
      </div>
      <div>{children}</div>
    </div>
  );
}

// ─── Document Viewer ──────────────────────────────────────────────────────────
// Fetches the file as a blob via the Authorization header (avoids direct browser
// connections to the backend, which would fail with self-signed TLS certs).

function DocumentViewer({
  docId,
  mimeType,
  originalName,
  token,
}: {
  docId: string;
  mimeType: string;
  originalName: string;
  token: string | null;
}) {
  const { t } = useLanguage();
  const apiBase = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";

  const isPdf = mimeType === "application/pdf";
  const isImage = mimeType.startsWith("image/");
  const isText = mimeType === "text/plain" || mimeType === "text/csv" || originalName.endsWith(".csv");

  // blobUrl is used for PDF and image previews
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  // textContent is used for text/csv previews
  const [textContent, setTextContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState(false);

  useEffect(() => {
    if (!isPdf && !isImage && !isText) return;
    setLoading(true);
    setFetchError(false);
    setBlobUrl(null);
    setTextContent(null);

    fetch(`${apiBase}/api/documents/${docId}/download?inline=true`, {
      headers: { Authorization: `Bearer ${token ?? ""}` },
    })
      .then(async (r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        if (isText) {
          const text = await r.text();
          setTextContent(text);
        } else {
          const blob = await r.blob();
          setBlobUrl(URL.createObjectURL(blob));
        }
      })
      .catch(() => setFetchError(true))
      .finally(() => setLoading(false));

    // Revoke blob URL on cleanup to avoid memory leaks
    return () => {
      setBlobUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId, mimeType]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-slate-400 text-sm py-10 justify-center">
        <RefreshCw className="h-4 w-4 animate-spin" />
        {t("common.loading_data")}
      </div>
    );
  }

  if (fetchError) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-10 text-slate-400">
        <AlertTriangle className="h-8 w-8 opacity-40" />
        <p className="text-sm">{t("documents.preview_unavailable")}</p>
      </div>
    );
  }

  if (isPdf && blobUrl) {
    return (
      <div className="w-full" style={{ height: "640px" }}>
        <iframe
          src={blobUrl}
          className="w-full h-full rounded-b-xl border-0"
          title={originalName}
        />
      </div>
    );
  }

  if (isImage && blobUrl) {
    return (
      <div className="flex items-center justify-center bg-slate-100 p-4 rounded-b-xl" style={{ minHeight: "240px" }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={blobUrl}
          alt={originalName}
          className="max-w-full max-h-[560px] rounded-lg shadow-md object-contain"
        />
      </div>
    );
  }

  if (isText) {
    return (
      <div className="px-5 py-4">
        {textContent !== null ? (
          <pre className="text-xs text-slate-700 bg-slate-50 rounded-lg p-4 overflow-auto max-h-96 whitespace-pre-wrap font-mono leading-relaxed">
            {textContent}
          </pre>
        ) : (
          <p className="text-sm text-slate-400 py-4 text-center">{t("documents.preview_unavailable")}</p>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center gap-3 py-10 text-slate-400">
      <FileText className="h-10 w-10 opacity-30" />
      <p className="text-sm">{t("documents.preview_unavailable")}</p>
    </div>
  );
}

// ─── Add Version Modal ────────────────────────────────────────────────────────

function AddVersionModal({
  docId,
  token,
  onClose,
  onSuccess,
}: {
  docId: string;
  token: string | null;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const { t } = useLanguage();
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    if (!file) { setError("Selecciona un archivo"); return; }
    setSubmitting(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const apiBase = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";
      const res = await fetch(`${apiBase}/api/documents/${docId}/versions`, {
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
      setError(e instanceof Error ? e.message : t("common.unknown_error"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
          <h2 className="text-base font-semibold text-slate-900">{t("documents.add_version")}</h2>
          <button onClick={onClose} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="px-6 py-5 space-y-4">
          {error && (
            <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
              <AlertTriangle className="h-4 w-4 flex-shrink-0" />{error}
            </div>
          )}
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1">{t("documents.form_file")} *</label>
            <input
              type="file"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-800 file:mr-3 file:rounded-md file:border-0 file:bg-indigo-600 file:px-3 file:py-1 file:text-xs file:font-semibold file:text-white hover:file:bg-indigo-700 focus:outline-none"
            />
            {file && (
              <p className="mt-1 text-xs text-slate-500">{file.name} ({formatFileSize(file.size)})</p>
            )}
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-200 px-6 py-4">
          <button onClick={onClose} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 transition-colors">
            {t("actions.cancel")}
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting}
            className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50 transition-colors"
          >
            {submitting ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
            {t("documents.add_version")}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Add Relation Modal ───────────────────────────────────────────────────────

function AddRelationModal({
  docId,
  allDocs,
  onClose,
  onSuccess,
}: {
  docId: string;
  allDocs: DocumentListItem[];
  onClose: () => void;
  onSuccess: () => void;
}) {
  const { t } = useLanguage();
  const [targetId, setTargetId] = useState("");
  const [relationType, setRelationType] = useState("RELATED_TO");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    if (!targetId) { setError("Selecciona un documento"); return; }
    setSubmitting(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/documents/${docId}/relations`, {
        method: "POST",
        body: JSON.stringify({ targetDocId: targetId, relationType }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(d.error ?? `Error ${res.status}`);
      }
      onSuccess();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("common.unknown_error"));
    } finally {
      setSubmitting(false);
    }
  };

  const availableDocs = allDocs.filter((d) => d.id !== docId);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
          <h2 className="text-base font-semibold text-slate-900">{t("documents.add_relation")}</h2>
          <button onClick={onClose} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="px-6 py-5 space-y-4">
          {error && (
            <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
              <AlertTriangle className="h-4 w-4 flex-shrink-0" />{error}
            </div>
          )}
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1">{t("documents.relation_type")}</label>
            <select
              value={relationType}
              onChange={(e) => setRelationType(e.target.value)}
              className="w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-800 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
            >
              <option value="RELATED_TO">{t("documents.relation_RELATED_TO")}</option>
              <option value="AMENDMENT_OF">{t("documents.relation_AMENDMENT_OF")}</option>
              <option value="SUPERSEDES">{t("documents.relation_SUPERSEDES")}</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1">{t("documents.doc_title")}</label>
            <select
              value={targetId}
              onChange={(e) => setTargetId(e.target.value)}
              className="w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-800 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
            >
              <option value="">— {t("documents.doc_title")} —</option>
              {availableDocs.map((d) => (
                <option key={d.id} value={d.id}>{d.title}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-200 px-6 py-4">
          <button onClick={onClose} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 transition-colors">
            {t("actions.cancel")}
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting}
            className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50 transition-colors"
          >
            {submitting ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            {t("actions.add")}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Add CIs Modal ────────────────────────────────────────────────────────────

interface CIListItem {
  id: string;
  name: string;
  apiSlug: string;
  ciTypeName: string | null;
  environment: string;
}

function AddCIsModal({
  docId,
  existingCiIds,
  onClose,
  onSuccess,
}: {
  docId: string;
  existingCiIds: string[];
  onClose: () => void;
  onSuccess: () => void;
}) {
  const { t } = useLanguage();
  const [allCIs, setAllCIs] = useState<CIListItem[]>([]);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    apiFetch("/api/cis")
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((data: CIListItem[]) => {
        setAllCIs(data.filter((ci) => !existingCiIds.includes(ci.id)));
      })
      .catch(() => setAllCIs([]))
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId]);

  const filtered = allCIs.filter(
    (ci) =>
      ci.name.toLowerCase().includes(search.toLowerCase()) ||
      ci.apiSlug.toLowerCase().includes(search.toLowerCase()),
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
      const res = await apiFetch(`/api/documents/${docId}/cis`, {
        method: "POST",
        body: JSON.stringify({ ciIds: Array.from(selected) }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(d.error ?? `Error ${res.status}`);
      }
      onSuccess();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("common.unknown_error"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
          <h2 className="text-base font-semibold text-slate-900">{t("documents.associate_cis")}</h2>
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
            placeholder={t("documents.search_cis")}
            className="w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-800 placeholder-slate-400 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
          />
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-6 text-slate-400 text-sm">
              <RefreshCw className="h-4 w-4 animate-spin" />{t("common.loading_data")}
            </div>
          ) : filtered.length === 0 ? (
            <p className="py-6 text-center text-sm text-slate-400">{t("documents.no_cis_to_add")}</p>
          ) : (
            <div className="overflow-y-auto max-h-64 divide-y divide-slate-50 rounded-lg border border-slate-200">
              {filtered.map((ci) => (
                <label key={ci.id} className="flex items-center gap-3 px-4 py-2.5 hover:bg-slate-50 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selected.has(ci.id)}
                    onChange={() => toggle(ci.id)}
                    className="accent-indigo-600 h-4 w-4"
                  />
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-slate-800 truncate">{ci.name}</p>
                    <p className="text-xs text-slate-400 font-mono truncate">{ci.apiSlug}</p>
                  </div>
                  {ci.environment && (
                    <span className="ml-auto flex-shrink-0 text-xs text-slate-400">{ci.environment}</span>
                  )}
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
            {t("documents.associate_selected")}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Add Contracts Modal ──────────────────────────────────────────────────────

interface ContractListItem {
  id: string;
  contractNumber: string;
  vendor: { name: string } | null;
}

function AddContractsModal({
  docId,
  existingContractIds,
  onClose,
  onSuccess,
}: {
  docId: string;
  existingContractIds: string[];
  onClose: () => void;
  onSuccess: () => void;
}) {
  const { t } = useLanguage();
  const [allContracts, setAllContracts] = useState<ContractListItem[]>([]);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    apiFetch("/api/contracts")
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((data: ContractListItem[]) => {
        setAllContracts(data.filter((c) => !existingContractIds.includes(c.id)));
      })
      .catch(() => setAllContracts([]))
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId]);

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
      const res = await apiFetch(`/api/documents/${docId}/contracts`, {
        method: "POST",
        body: JSON.stringify({ contractIds: Array.from(selected) }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(d.error ?? `Error ${res.status}`);
      }
      onSuccess();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("common.unknown_error"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
          <h2 className="text-base font-semibold text-slate-900">{t("documents.associate_contracts")}</h2>
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
            placeholder={t("documents.search_contracts")}
            className="w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-800 placeholder-slate-400 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
          />
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-6 text-slate-400 text-sm">
              <RefreshCw className="h-4 w-4 animate-spin" />{t("common.loading_data")}
            </div>
          ) : filtered.length === 0 ? (
            <p className="py-6 text-center text-sm text-slate-400">{t("documents.no_contracts_to_add")}</p>
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
            {t("documents.associate_selected")}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Edit Metadata Modal ──────────────────────────────────────────────────────

function EditMetadataModal({
  doc,
  docTypes,
  onClose,
  onSuccess,
}: {
  doc: DocumentDetail;
  docTypes: DocumentType[];
  onClose: () => void;
  onSuccess: () => void;
}) {
  const { t } = useLanguage();
  const [title, setTitle] = useState(doc.title);
  const [description, setDescription] = useState(doc.description ?? "");
  const [typeId, setTypeId] = useState(doc.documentTypeId);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    if (!title.trim()) { setError("El título es obligatorio"); return; }
    setSubmitting(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/documents/${doc.id}`, {
        method: "PATCH",
        body: JSON.stringify({ title: title.trim(), description: description.trim() || null, documentTypeId: typeId }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(d.error ?? `Error ${res.status}`);
      }
      onSuccess();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("common.unknown_error"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
          <h2 className="text-base font-semibold text-slate-900">{t("actions.edit")}</h2>
          <button onClick={onClose} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="px-6 py-5 space-y-4">
          {error && (
            <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
              <AlertTriangle className="h-4 w-4 flex-shrink-0" />{error}
            </div>
          )}
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1">{t("documents.form_title")} *</label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-800 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1">{t("documents.form_description")}</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className="w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-800 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100 resize-none"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1">{t("documents.form_type")}</label>
            <select
              value={typeId}
              onChange={(e) => setTypeId(e.target.value)}
              className="w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-800 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
            >
              {docTypes.map((dt) => (
                <option key={dt.id} value={dt.id}>{dt.name}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-200 px-6 py-4">
          <button onClick={onClose} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 transition-colors">
            {t("actions.cancel")}
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting}
            className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50 transition-colors"
          >
            {submitting ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            {t("actions.save")}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function DocumentDetailPage() {
  const { t } = useLanguage();
  const { isAdmin, token } = useAuth();
  const router = useRouter();
  const params = useParams();
  const docId = params.id as string;

  const [doc, setDoc] = useState<DocumentDetail | null>(null);
  const [docTypes, setDocTypes] = useState<DocumentType[]>([]);
  const [allDocs, setAllDocs] = useState<DocumentListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showAddVersion, setShowAddVersion] = useState(false);
  const [showAddRelation, setShowAddRelation] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const [showAddCIs, setShowAddCIs] = useState(false);
  const [showAddContracts, setShowAddContracts] = useState(false);

  // Notes state
  const [noteText, setNoteText] = useState("");
  const [noteSubmitting, setNoteSubmitting] = useState(false);
  const [noteError, setNoteError] = useState<string | null>(null);
  const notesEndRef = useRef<HTMLDivElement>(null);

  // Determine which document id to use for preview (latest version or root)
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [previewMime, setPreviewMime] = useState<string>("");
  const [previewName, setPreviewName] = useState<string>("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [docRes, typesRes, allDocsRes] = await Promise.all([
        apiFetch(`/api/documents/${docId}`),
        apiFetch("/api/masters/document-types"),
        apiFetch("/api/documents"),
      ]);
      const docData: unknown = await docRes.json();
      const typesData: unknown = await typesRes.json();
      const allDocsData: unknown = await allDocsRes.json();

      if (!docRes.ok) throw new Error((docData as { error?: string }).error ?? `Error ${docRes.status}`);

      const d = docData as DocumentDetail;
      setDoc(d);
      setDocTypes(Array.isArray(typesData) ? (typesData as DocumentType[]) : []);
      setAllDocs(((allDocsData as { data?: DocumentListItem[] }).data) ?? []);

      // Determine preview: use latest version if any, else root document itself
      const latestVersion = d.versions.find((v) => v.isLatest);
      if (latestVersion) {
        setPreviewId(latestVersion.id);
        setPreviewMime(latestVersion.mimeType);
        setPreviewName(latestVersion.originalName);
      } else {
        // root document with no version children — preview the root itself
        setPreviewId(d.id);
        setPreviewMime(d.mimeType);
        setPreviewName(d.originalName);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : t("common.unknown_error"));
    } finally {
      setLoading(false);
    }
  }, [docId, t]);

  useEffect(() => { void load(); }, [load]);

  const handleDownload = async (versionId?: string) => {
    const id = versionId ?? docId;
    const apiBase = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";
    const res = await fetch(`${apiBase}/api/documents/${id}/download`, {
      headers: { Authorization: `Bearer ${token ?? ""}` },
    });
    if (!res.ok) return;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = window.document.createElement("a");
    a.href = url;
    a.download = doc?.originalName ?? "document";
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleDelete = async () => {
    if (!confirm(t("documents.delete_confirm"))) return;
    try {
      await apiFetch(`/api/documents/${docId}`, { method: "DELETE" });
      router.push("/documents");
    } catch (e) {
      alert(e instanceof Error ? e.message : t("common.unknown_error"));
    }
  };

  const handleDeleteVersion = async (versionId: string) => {
    if (!confirm(t("documents.delete_version_confirm"))) return;
    try {
      const rootId = doc?.rootId ?? docId;
      await apiFetch(`/api/documents/${rootId}/versions/${versionId}`, { method: "DELETE" });
      void load();
    } catch (e) {
      alert(e instanceof Error ? e.message : t("common.unknown_error"));
    }
  };

  const handleRemoveRelation = async (targetId: string) => {
    if (!confirm(t("common.confirm_delete"))) return;
    try {
      await apiFetch(`/api/documents/${docId}/relations/${targetId}`, { method: "DELETE" });
      void load();
    } catch (e) {
      alert(e instanceof Error ? e.message : t("common.unknown_error"));
    }
  };

  const handleRemoveCI = async (ciId: string) => {
    if (!confirm(t("common.confirm_delete"))) return;
    try {
      await apiFetch(`/api/documents/${docId}/ci/${ciId}`, { method: "DELETE" });
      void load();
    } catch (e) {
      alert(e instanceof Error ? e.message : t("common.unknown_error"));
    }
  };

  const handleRemoveContract = async (contractId: string) => {
    if (!confirm(t("common.confirm_delete"))) return;
    try {
      await apiFetch(`/api/documents/${docId}/contract/${contractId}`, { method: "DELETE" });
      void load();
    } catch (e) {
      alert(e instanceof Error ? e.message : t("common.unknown_error"));
    }
  };

  const handleAddNote = async () => {
    const content = noteText.trim();
    if (!content) return;
    setNoteSubmitting(true);
    setNoteError(null);
    try {
      const rootId = doc?.rootId ?? docId;
      const res = await apiFetch(`/api/documents/${rootId}/notes`, {
        method: "POST",
        body: JSON.stringify({ content }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(d.error ?? `Error ${res.status}`);
      }
      setNoteText("");
      void load();
      setTimeout(() => notesEndRef.current?.scrollIntoView({ behavior: "smooth" }), 300);
    } catch (e) {
      setNoteError(e instanceof Error ? e.message : t("common.unknown_error"));
    } finally {
      setNoteSubmitting(false);
    }
  };

  const getRelationLabel = (type: string): string => {
    const val = t(`documents.relation_${type}`);
    return val === `documents.relation_${type}` ? type : val;
  };

  if (loading) {
    return (
      <>
        <div className="flex h-screen items-center justify-center bg-slate-50">
          <div className="flex items-center gap-3 text-slate-400">
            <RefreshCw className="h-5 w-5 animate-spin" />
            <span className="text-sm">{t("common.loading_data")}</span>
          </div>
        </div>
      </>
    );
  }

  if (error || !doc) {
    return (
      <>
        <div className="flex h-screen flex-col items-center justify-center gap-4 bg-slate-50">
          <div className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-5 py-3 text-sm text-red-600">
            <AlertTriangle className="h-4 w-4 flex-shrink-0" />
            {error ?? t("common.no_data")}
          </div>
          <button
            onClick={() => router.push("/documents")}
            className="flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 transition-colors"
          >
            <ArrowLeft className="h-4 w-4" />
            {t("documents.title")}
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="min-h-screen bg-slate-50">
        {/* Header */}
        <header className="border-b border-slate-200 bg-white px-8 py-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <button
                onClick={() => router.push("/documents")}
                className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-colors"
              >
                <ArrowLeft className="h-5 w-5" />
              </button>
              <FolderOpen className="h-5 w-5 text-indigo-600" />
              <div>
                <h1 className="text-lg font-bold text-slate-900">{doc.title}</h1>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="inline-flex items-center rounded-full bg-indigo-50 px-2.5 py-0.5 text-xs font-medium text-indigo-700">
                    {doc.documentTypeName}
                  </span>
                  <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-600">
                    v{doc.versionNumber}
                  </span>
                  {doc.isLatest && (
                    <span className="inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700">
                      latest
                    </span>
                  )}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => handleDownload()}
                className="flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 transition-colors"
              >
                <Download className="h-4 w-4" />
                {t("documents.download")}
              </button>
              {isAdmin && (
                <>
                  <button
                    onClick={() => setShowAddVersion(true)}
                    className="flex items-center gap-1.5 rounded-lg border border-indigo-300 bg-indigo-50 px-3 py-2 text-sm font-medium text-indigo-700 hover:bg-indigo-100 transition-colors"
                  >
                    <Upload className="h-4 w-4" />
                    {t("documents.add_version")}
                  </button>
                  <button
                    onClick={() => setShowEdit(true)}
                    className="flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 transition-colors"
                  >
                    <Pencil className="h-4 w-4" />
                    {t("actions.edit")}
                  </button>
                  <button
                    onClick={handleDelete}
                    className="flex items-center gap-1.5 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-100 transition-colors"
                  >
                    <Trash2 className="h-4 w-4" />
                    {t("actions.delete")}
                  </button>
                </>
              )}
            </div>
          </div>
        </header>

        {/* Body */}
        <div className="px-8 py-6 space-y-6">
          {/* Metadata card */}
          <div className="rounded-2xl bg-white shadow-sm ring-1 ring-slate-200 overflow-hidden">
            <div className="border-b border-slate-100 bg-slate-50 px-5 py-3">
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-700">
                <FileText className="h-4 w-4 text-indigo-500" />
                Metadatos
              </div>
            </div>
            <div className="grid grid-cols-2 gap-x-8 gap-y-4 px-5 py-4 sm:grid-cols-3 lg:grid-cols-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">{t("documents.doc_file")}</p>
                <p className="mt-1 text-sm text-slate-700 font-mono">{doc.originalName}</p>
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">{t("documents.doc_size")}</p>
                <p className="mt-1 text-sm text-slate-700">{formatFileSize(doc.fileSize)}</p>
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">{t("documents.doc_uploaded_by")}</p>
                <p className="mt-1 text-sm text-slate-700">{doc.uploadedBy}</p>
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">{t("documents.doc_date")}</p>
                <p className="mt-1 text-sm text-slate-700">{formatDate(doc.createdAt)}</p>
              </div>
              {doc.description && (
                <div className="col-span-2 sm:col-span-3 lg:col-span-4">
                  <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">{t("documents.form_description")}</p>
                  <p className="mt-1 text-sm text-slate-700">{doc.description}</p>
                </div>
              )}
            </div>
          </div>

          {/* Document Viewer */}
          {previewId && (
            <SectionCard
              title={t("documents.preview")}
              icon={<Eye className="h-4 w-4" />}
            >
              <DocumentViewer
                docId={previewId}
                mimeType={previewMime}
                originalName={previewName}
                token={token}
              />
            </SectionCard>
          )}

          {/* Version History */}
          <SectionCard
            title={t("documents.version_history")}
            icon={<Upload className="h-4 w-4" />}
          >
            {doc.versions.length === 0 ? (
              <p className="py-6 text-center text-sm text-slate-400">{t("common.no_data")}</p>
            ) : (
              <div className="divide-y divide-slate-50">
                {doc.versions.map((v) => (
                  <div
                    key={v.id}
                    className={`flex items-center justify-between px-5 py-3 group ${v.isLatest ? "bg-emerald-50/50" : ""}`}
                  >
                    <div className="flex items-center gap-3">
                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-bold ${v.isLatest ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>
                        v{v.versionNumber}
                      </span>
                      <div>
                        <p className="text-sm font-medium text-slate-700 font-mono">{v.originalName}</p>
                        <p className="text-xs text-slate-400">{v.uploadedBy} · {formatDate(v.createdAt)}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => handleDownload(v.id)}
                        className="rounded-lg p-1.5 text-slate-400 hover:bg-indigo-50 hover:text-indigo-600 transition-colors"
                        title={t("documents.download")}
                      >
                        <Download className="h-4 w-4" />
                      </button>
                      {isAdmin && (
                        <button
                          onClick={() => handleDeleteVersion(v.id)}
                          className="rounded-lg p-1.5 text-slate-300 hover:bg-red-50 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all"
                          title={t("documents.delete_version")}
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </SectionCard>

          {/* Notes */}
          <SectionCard
            title={t("documents.notes")}
            icon={<MessageSquare className="h-4 w-4" />}
          >
            <div className="px-5 py-4 space-y-4">
              {/* Note list */}
              {doc.notes.length === 0 ? (
                <p className="text-center text-sm text-slate-400 py-2">{t("documents.no_notes")}</p>
              ) : (
                <div className="space-y-3">
                  {doc.notes.map((note) => (
                    <div key={note.id} className="rounded-xl border border-slate-100 bg-slate-50 px-4 py-3">
                      <div className="flex items-center gap-2 mb-1.5">
                        <span className="text-xs font-semibold text-indigo-700">{note.createdBy}</span>
                        <span className="text-xs text-slate-400">{formatDateTime(note.createdAt)}</span>
                      </div>
                      <p className="text-sm text-slate-700 whitespace-pre-wrap">{note.content}</p>
                    </div>
                  ))}
                  <div ref={notesEndRef} />
                </div>
              )}

              {/* Add note form */}
              <div className="border-t border-slate-100 pt-4">
                {noteError && (
                  <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600 mb-3">
                    <AlertTriangle className="h-4 w-4 flex-shrink-0" />{noteError}
                  </div>
                )}
                <textarea
                  value={noteText}
                  onChange={(e) => setNoteText(e.target.value)}
                  placeholder={t("documents.note_placeholder")}
                  rows={3}
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 placeholder-slate-400 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100 resize-none"
                />
                <div className="flex justify-end mt-2">
                  <button
                    onClick={handleAddNote}
                    disabled={noteSubmitting || !noteText.trim()}
                    className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50 transition-colors"
                  >
                    {noteSubmitting ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                    {t("documents.add_note")}
                  </button>
                </div>
              </div>
            </div>
          </SectionCard>

          {/* Relations */}
          <SectionCard
            title={t("documents.relations")}
            icon={<Link2 className="h-4 w-4" />}
            action={
              isAdmin ? (
                <button
                  onClick={() => setShowAddRelation(true)}
                  className="flex items-center gap-1 rounded-lg bg-indigo-50 px-2.5 py-1.5 text-xs font-medium text-indigo-700 hover:bg-indigo-100 transition-colors"
                >
                  <Plus className="h-3.5 w-3.5" />{t("documents.add_relation")}
                </button>
              ) : undefined
            }
          >
            {doc.relations.length === 0 ? (
              <p className="py-6 text-center text-sm text-slate-400">{t("common.no_data")}</p>
            ) : (
              <div className="divide-y divide-slate-50">
                {doc.relations.map((rel) => (
                  <div key={rel.id} className="flex items-center justify-between px-5 py-3 hover:bg-slate-50 transition-colors group">
                    <div className="flex items-center gap-3">
                      <span className="text-xs rounded-full bg-slate-100 px-2.5 py-0.5 text-slate-600 font-medium">
                        {getRelationLabel(rel.relationType)}
                      </span>
                      <button
                        onClick={() => router.push(`/documents/${rel.targetDocId}`)}
                        className="text-sm text-indigo-700 hover:underline font-medium"
                      >
                        {rel.targetTitle}
                      </button>
                    </div>
                    {isAdmin && (
                      <button
                        onClick={() => handleRemoveRelation(rel.targetDocId)}
                        className="rounded-lg p-1.5 text-slate-300 hover:bg-red-50 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </SectionCard>

          {/* Associated CIs */}
          <SectionCard
            title={t("documents.associated_cis")}
            icon={<Server className="h-4 w-4" />}
            action={
              isAdmin ? (
                <button
                  onClick={() => setShowAddCIs(true)}
                  className="flex items-center gap-1 rounded-lg bg-indigo-50 px-2.5 py-1.5 text-xs font-medium text-indigo-700 hover:bg-indigo-100 transition-colors"
                >
                  <Plus className="h-3.5 w-3.5" />{t("documents.associate_cis")}
                </button>
              ) : undefined
            }
          >
            {doc.cis.length === 0 ? (
              <p className="py-6 text-center text-sm text-slate-400">{t("common.no_data")}</p>
            ) : (
              <div className="divide-y divide-slate-50">
                {doc.cis.map((ci) => (
                  <div key={ci.ciId} className="flex items-center justify-between px-5 py-3 hover:bg-slate-50 transition-colors group">
                    <button
                      onClick={() => router.push(`/inventory`)}
                      className="text-sm text-indigo-700 hover:underline font-medium"
                    >
                      {ci.ciName}
                    </button>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-slate-400 font-mono">{ci.ciSlug}</span>
                      {isAdmin && (
                        <button
                          onClick={() => handleRemoveCI(ci.ciId)}
                          className="rounded-lg p-1.5 text-slate-300 hover:bg-red-50 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </SectionCard>

          {/* Associated Contracts */}
          <SectionCard
            title={t("documents.associated_contracts")}
            icon={<FileText className="h-4 w-4" />}
            action={
              isAdmin ? (
                <button
                  onClick={() => setShowAddContracts(true)}
                  className="flex items-center gap-1 rounded-lg bg-indigo-50 px-2.5 py-1.5 text-xs font-medium text-indigo-700 hover:bg-indigo-100 transition-colors"
                >
                  <Plus className="h-3.5 w-3.5" />{t("documents.associate_contracts")}
                </button>
              ) : undefined
            }
          >
            {doc.contracts.length === 0 ? (
              <p className="py-6 text-center text-sm text-slate-400">{t("common.no_data")}</p>
            ) : (
              <div className="divide-y divide-slate-50">
                {doc.contracts.map((c) => (
                  <div key={c.contractId} className="flex items-center justify-between px-5 py-3 hover:bg-slate-50 transition-colors group">
                    <button
                      onClick={() => router.push(`/contracts`)}
                      className="text-sm text-indigo-700 hover:underline font-mono font-medium"
                    >
                      {c.contractNumber}
                    </button>
                    {isAdmin && (
                      <button
                        onClick={() => handleRemoveContract(c.contractId)}
                        className="rounded-lg p-1.5 text-slate-300 hover:bg-red-50 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </SectionCard>
        </div>
      </div>

      {/* Modals */}
      {showAddVersion && (
        <AddVersionModal
          docId={docId}
          token={token}
          onClose={() => setShowAddVersion(false)}
          onSuccess={() => { setShowAddVersion(false); void load(); }}
        />
      )}
      {showAddRelation && (
        <AddRelationModal
          docId={docId}
          allDocs={allDocs}
          onClose={() => setShowAddRelation(false)}
          onSuccess={() => { setShowAddRelation(false); void load(); }}
        />
      )}
      {showEdit && (
        <EditMetadataModal
          doc={doc}
          docTypes={docTypes}
          onClose={() => setShowEdit(false)}
          onSuccess={() => { setShowEdit(false); void load(); }}
        />
      )}
      {showAddCIs && (
        <AddCIsModal
          docId={docId}
          existingCiIds={doc.cis.map((c) => c.ciId)}
          onClose={() => setShowAddCIs(false)}
          onSuccess={() => { setShowAddCIs(false); void load(); }}
        />
      )}
      {showAddContracts && (
        <AddContractsModal
          docId={docId}
          existingContractIds={doc.contracts.map((c) => c.contractId)}
          onClose={() => setShowAddContracts(false)}
          onSuccess={() => { setShowAddContracts(false); void load(); }}
        />
      )}
    </>
  );
}

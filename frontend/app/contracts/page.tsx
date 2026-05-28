"use client";

import { useEffect, useState, useRef, useMemo } from "react";
import Link from "next/link";
import { useSearchParams, useRouter } from "next/navigation";
import {
  FileText, Plus, RefreshCw, AlertTriangle, Building, Calendar, Server,
  ChevronRight, GitBranch, Download, Eye, EyeOff, X, Search, Check, FilterX, Pencil,
} from "lucide-react";
import AddContractModal from "@/components/AddContractModal";
import { useAuth } from "@/contexts/AuthContext";
import { useLanguage } from "@/contexts/LanguageContext";
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
interface VendorRef    { id: string; name: string }
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
  if (!endDate) return { key: "no_expiry",      color: "text-slate-500",   dot: "bg-slate-300" };
  const diff = (new Date(endDate).getTime() - Date.now()) / 86400000;
  if (diff < 0)  return { key: "expired",       color: "text-red-600",     dot: "bg-red-500" };
  if (diff < 30) return { key: "expiring_soon", color: "text-orange-600",  dot: "bg-orange-400" };
  return               { key: "active",         color: "text-emerald-600", dot: "bg-emerald-400" };
}
function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("es-ES", { day: "2-digit", month: "short", year: "numeric" });
}

// ─── Row ──────────────────────────────────────────────────────────────────────

function ContractRow({ contract, onExpand, expanded, onContractUpdated }: {
  contract: Contract; onExpand: () => void; expanded: boolean;
  onContractUpdated: (updated: Contract) => void;
}) {
  const status     = getContractStatus(contract.endDate);
  const isAddendum = !!contract.parentContract;
  const { isAdmin }  = useAuth();
  const { t } = useLanguage();
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

  // ── Edit contract state ──────────────────────────────────────────────────────
  const [showEdit, setShowEdit]           = useState(false);
  const [editLoading, setEditLoading]     = useState(false);
  const [editError, setEditError]         = useState<string | null>(null);
  const [editVendors, setEditVendors]     = useState<VendorRef[]>([]);
  const [editVendorsLoading, setEditVendorsLoading] = useState(false);
  const [editFields, setEditFields]       = useState({
    contractNumber: contract.contractNumber,
    startDate:      contract.startDate.slice(0, 10),
    endDate:        contract.endDate ? contract.endDate.slice(0, 10) : "",
    vendorId:       contract.vendor.id,
  });

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
        credentials: "include",
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

  // ── Edit contract ─────────────────────────────────────────────────────────────
  const openEdit = () => {
    setEditFields({
      contractNumber: contract.contractNumber,
      startDate:      contract.startDate.slice(0, 10),
      endDate:        contract.endDate ? contract.endDate.slice(0, 10) : "",
      vendorId:       contract.vendor.id,
    });
    setEditError(null);
    setShowEdit(true);
    if (editVendors.length === 0) {
      setEditVendorsLoading(true);
      apiFetch("/api/vendors")
        .then((r) => (r.ok ? r.json() : Promise.reject()))
        .then((data: VendorRef[]) => setEditVendors(Array.isArray(data) ? data : []))
        .catch(() => {})
        .finally(() => setEditVendorsLoading(false));
    }
  };

  const confirmEdit = async () => {
    if (!editFields.contractNumber.trim() || !editFields.startDate || !editFields.vendorId) return;
    setEditLoading(true);
    setEditError(null);
    try {
      const res = await apiFetch(`/api/contracts/${contract.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contractNumber:   editFields.contractNumber.trim(),
          startDate:        new Date(editFields.startDate).toISOString(),
          endDate:          editFields.endDate ? new Date(editFields.endDate).toISOString() : null,
          vendorId:         editFields.vendorId,
          parentContractId: contract.parentContract?.id ?? null,
        }),
      });
      if (res.ok) {
        const updated: Contract = await res.json();
        onContractUpdated(updated);
        setShowEdit(false);
      } else {
        const body = await res.json().catch(() => ({}));
        setEditError((body as { error?: string }).error ?? t("contracts.edit_error"));
      }
    } catch {
      setEditError(t("contracts.edit_error"));
    } finally {
      setEditLoading(false);
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
        .then((data: unknown) => {
          const list = Array.isArray(data)
            ? (data as AllDocRef[])
            : ((data as { data?: AllDocRef[] })?.data ?? []);
          setAllDocs(list);
        })
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
      <tr className="group cursor-pointer hover:bg-[var(--accent)]/5 transition-colors" onClick={onExpand}>
        <td className="px-6 py-4">
          <div className="flex items-center gap-2">
            {isAddendum && <span title={t("contracts.addendum_badge")}><GitBranch className="h-3.5 w-3.5 flex-shrink-0 text-amber-400" /></span>}
            <div>
              <p className="font-semibold text-slate-800 group-hover:text-[var(--accent)] transition-colors">{contract.contractNumber}</p>
              {isAddendum && <p className="text-[11px] text-amber-600">{t("contracts.addendum_of").replace("{number}", contract.parentContract!.contractNumber)}</p>}
              {contract.addendums.length > 0 && <p className="text-[11px] text-slate-400">{contract.addendums.length > 1 ? t("contracts.addendum_count_plural").replace("{count}", String(contract.addendums.length)) : t("contracts.addendum_count").replace("{count}", String(contract.addendums.length))}</p>}
            </div>
          </div>
        </td>
        <td className="px-6 py-4"><div className="flex items-center gap-2 text-slate-700"><Building className="h-3.5 w-3.5 text-slate-400 flex-shrink-0" /><span className="text-sm font-medium">{contract.vendor.name}</span></div></td>
        <td className="px-6 py-4">
          <div className="flex items-center gap-2">
            <span className={`inline-flex h-2 w-2 rounded-full flex-shrink-0 ${status.dot}`} />
            <div>
              <p className={`text-sm font-medium ${status.color}`}>{status.key === "no_expiry" ? t("contracts.no_expiry") : t(`contracts.status.${status.key}`)}</p>
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
          <div className="flex items-center justify-end gap-2">
            {isAdmin && (
              <button
                onClick={(e) => { e.stopPropagation(); openEdit(); if (!expanded) onExpand(); }}
                className="rounded p-1 text-slate-400 hover:text-[var(--accent)] hover:bg-[var(--accent)]/10 transition-colors"
                title={t("contracts.edit_contract")}
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
            )}
            <ChevronRight className={`h-4 w-4 text-slate-400 transition-transform ${expanded ? "rotate-90" : ""}`} />
          </div>
        </td>
      </tr>

      {expanded && (
        <tr>
          <td colSpan={5} className="px-6 pb-4 bg-[var(--accent)]/5">
            <div className="space-y-3 pt-1">

              {/* ── Edit form ─────────────────────────────────────────────── */}
              {showEdit && (
                <div className="border border-[var(--accent)]/30 bg-[var(--accent)]/5 px-4 py-3" onClick={(e) => e.stopPropagation()}>
                  <p className="text-xs font-semibold uppercase tracking-wider text-[var(--accent)] mb-3">{t("contracts.edit_contract")}</p>
                  <div className="grid grid-cols-2 gap-3 mb-3">
                    <div>
                      <label className="block text-xs font-medium text-slate-600 mb-1">{t("contracts.contract_number_label")}</label>
                      <input
                        type="text"
                        value={editFields.contractNumber}
                        onChange={(e) => setEditFields((p) => ({ ...p, contractNumber: e.target.value }))}
                        className="w-full rounded-none border border-slate-200 bg-white px-2 py-1.5 text-sm outline-none focus:ring-1 focus:ring-[var(--accent)]"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-600 mb-1">{t("contracts.vendor_label")}</label>
                      {editVendorsLoading ? (
                        <div className="flex items-center gap-1 py-1.5 text-xs text-slate-400"><RefreshCw className="h-3 w-3 animate-spin" /></div>
                      ) : (
                        <select
                          value={editFields.vendorId}
                          onChange={(e) => setEditFields((p) => ({ ...p, vendorId: e.target.value }))}
                          className="w-full rounded-none border border-slate-200 bg-white px-2 py-1.5 text-sm outline-none focus:ring-1 focus:ring-[var(--accent)]"
                        >
                          {editVendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                        </select>
                      )}
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-600 mb-1">{t("contracts.start_date_label")}</label>
                      <input
                        type="date"
                        value={editFields.startDate}
                        onChange={(e) => setEditFields((p) => ({ ...p, startDate: e.target.value }))}
                        className="w-full rounded-none border border-slate-200 bg-white px-2 py-1.5 text-sm outline-none focus:ring-1 focus:ring-[var(--accent)]"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-600 mb-1">{t("contracts.end_date_label")}</label>
                      <input
                        type="date"
                        value={editFields.endDate}
                        onChange={(e) => setEditFields((p) => ({ ...p, endDate: e.target.value }))}
                        className="w-full rounded-none border border-slate-200 bg-white px-2 py-1.5 text-sm outline-none focus:ring-1 focus:ring-[var(--accent)]"
                      />
                    </div>
                  </div>
                  {editError && <p className="text-xs text-red-500 mb-2">{editError}</p>}
                  <div className="flex items-center justify-end gap-2">
                    <button onClick={() => setShowEdit(false)} className="text-xs text-slate-500 hover:text-slate-700 px-2 py-1">{t("actions.cancel")}</button>
                    <button
                      onClick={confirmEdit}
                      disabled={editLoading || !editFields.contractNumber.trim() || !editFields.startDate || !editFields.vendorId}
                      className="flex items-center gap-1 rounded-none bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[var(--accent)]/90 disabled:opacity-50 transition-colors"
                    >
                      {editLoading ? <RefreshCw className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                      {t("actions.save")}
                    </button>
                  </div>
                </div>
              )}

              {/* ── CIs cubiertos ─────────────────────────────────────────── */}
              <div className="border border-[var(--accent)]/20 bg-white overflow-hidden">
                <div className="border-b border-slate-100 bg-slate-50 px-4 py-2 flex items-center justify-between">
                  <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">{t("contracts.cis_covered")}</p>
                  {isAdmin && (
                    <button
                      onClick={(e) => { e.stopPropagation(); openCISelector(); }}
                      className="flex items-center gap-1 rounded-none bg-[var(--accent)]/5 px-2 py-1 text-xs font-medium text-[var(--accent)] hover:bg-[var(--accent)]/10 transition-colors"
                    >
                      <Plus className="h-3 w-3" />{t("contracts.associate_cis")}
                    </button>
                  )}
                </div>

                {cis.length === 0 ? (
                  <p className="px-4 py-3 text-sm italic text-slate-400">{t("contracts.no_cis_associated")}</p>
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
                              title={t("contracts.remove_ci")}
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
                  <div className="border-t border-[var(--accent)]/20 px-4 py-3 bg-[var(--accent)]/5" onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center gap-2 mb-2">
                      <Search className="h-3.5 w-3.5 text-slate-400 flex-shrink-0" />
                      <input
                        type="text"
                        placeholder={t("common.search_ci")}
                        value={ciSearch}
                        onChange={(e) => setCiSearch(e.target.value)}
                        className="flex-1 text-sm border border-slate-200 rounded-none px-2 py-1 outline-none focus:ring-1 focus:ring-[var(--accent)] bg-white"
                      />
                      <button onClick={() => setShowCISelector(false)} className="text-slate-400 hover:text-slate-600"><X className="h-4 w-4" /></button>
                    </div>
                    {allCIsLoading ? (
                      <div className="flex items-center gap-2 py-2 text-slate-400 text-xs"><RefreshCw className="h-3.5 w-3.5 animate-spin" />{t("contracts.loading_cis")}</div>
                    ) : (
                      <div className="max-h-48 overflow-y-auto space-y-0.5 rounded-md border border-slate-200 bg-white">
                        {filteredAllCIs.length === 0 ? (
                          <p className="px-3 py-2 text-xs text-slate-400 italic">{t("documents.no_cis_to_add")}</p>
                        ) : filteredAllCIs.map((ci) => {
                          const checked = selectedCiIds.has(ci.id);
                          return (
                            <label key={ci.id} className="flex items-center gap-2 px-3 py-2 hover:bg-[var(--accent)]/10 cursor-pointer text-sm">
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => setSelectedCiIds((prev) => {
                                  const s = new Set(prev);
                                  if (checked) s.delete(ci.id); else s.add(ci.id);
                                  return s;
                                })}
                                className="accent-[var(--accent)]"
                              />
                              <span className="font-medium text-slate-700">{ci.name}</span>
                              <span className="text-xs text-slate-400 truncate">{ci.apiSlug}</span>
                            </label>
                          );
                        })}
                      </div>
                    )}
                    <div className="flex items-center justify-end gap-2 mt-2">
                      <button onClick={() => setShowCISelector(false)} className="text-xs text-slate-500 hover:text-slate-700 px-2 py-1">{t("actions.cancel")}</button>
                      <button
                        onClick={confirmCIAssoc}
                        disabled={selectedCiIds.size === 0 || ciAssocLoading}
                        className="flex items-center gap-1 rounded-none bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[var(--accent)]/90 disabled:opacity-50 transition-colors"
                      >
                        {ciAssocLoading ? <RefreshCw className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                        {t("contracts.confirm_selected").replace("{count}", String(selectedCiIds.size))}
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {/* ── Documentos adjuntos ────────────────────────────────────── */}
              <div className="border border-slate-200 bg-white overflow-hidden">
                <div className="border-b border-slate-100 bg-slate-50 px-4 py-2 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <FileText className="h-3.5 w-3.5 text-slate-400" />
                    <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">{t("contracts.attached_docs")}</p>
                  </div>
                  {isAdmin && docsFetched && (
                    <button
                      onClick={(e) => { e.stopPropagation(); openDocSelector(); }}
                      className="flex items-center gap-1 rounded-none bg-slate-100 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-[var(--accent)]/10 hover:text-[var(--accent)] transition-colors"
                    >
                      <Plus className="h-3 w-3" />{t("contracts.associate_documents")}
                    </button>
                  )}
                </div>

                {docsLoading ? (
                  <div className="flex items-center gap-2 px-4 py-3 text-slate-400 text-sm">
                    <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                    <span>{t("contracts.loading_docs")}</span>
                  </div>
                ) : docs.length === 0 ? (
                  <p className="px-4 py-3 text-sm italic text-slate-400">{t("contracts.no_docs_associated")}</p>
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
                              <FileText className="h-4 w-4 flex-shrink-0 text-[var(--accent)] mt-0.5" />
                              <div className="min-w-0">
                                <Link href={`/documents/${doc.id}`} className="text-sm font-medium text-[var(--accent)] hover:underline truncate block" onClick={(e) => e.stopPropagation()}>
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
                                className="flex items-center gap-1 rounded-none bg-slate-100 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-[var(--accent)]/10 hover:text-[var(--accent)] transition-colors"
                                title={previewOpen ? t("contracts.hide_preview") : t("contracts.show_preview")}
                              >
                                {previewOpen ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                                {previewOpen ? t("contracts.hide_preview") : t("contracts.show_preview")}
                              </button>
                              {/* Download */}
                              <button
                                onClick={(e) => { e.stopPropagation(); handleDownload(doc.id, doc.originalName); }}
                                className="flex items-center gap-1 rounded-none bg-slate-100 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-[var(--accent)]/10 hover:text-[var(--accent)] transition-colors"
                                title={t("documents.download")}
                              >
                                <Download className="h-3.5 w-3.5" />
                                {t("documents.download")}
                              </button>
                            </div>
                          </div>

                          {/* Preview panel */}
                          {previewOpen && (
                            <div className="px-4 pb-3" onClick={(e) => e.stopPropagation()}>
                              {!previewState || previewState.loading ? (
                                <div className="flex items-center gap-2 py-3 text-slate-400 text-xs">
                                  <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                                  <span>{t("contracts.loading_preview")}</span>
                                </div>
                              ) : previewState.error ? (
                                <div className="flex items-center gap-2 py-3 text-red-400 text-xs">
                                  <AlertTriangle className="h-3.5 w-3.5" />
                                  <span>{t("contracts.preview_error")}</span>
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
                                <p className="py-2 text-xs italic text-slate-400">{t("documents.preview_unavailable")}</p>
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
                        placeholder={t("documents.search_documents")}
                        value={docSearch}
                        onChange={(e) => setDocSearch(e.target.value)}
                        className="flex-1 text-sm border border-slate-200 rounded-none px-2 py-1 outline-none focus:ring-1 focus:ring-[var(--accent)] bg-white"
                      />
                      <button onClick={() => setShowDocSelector(false)} className="text-slate-400 hover:text-slate-600"><X className="h-4 w-4" /></button>
                    </div>
                    {allDocsLoading ? (
                      <div className="flex items-center gap-2 py-2 text-slate-400 text-xs"><RefreshCw className="h-3.5 w-3.5 animate-spin" />{t("common.loading")}</div>
                    ) : (
                      <div className="max-h-48 overflow-y-auto space-y-0.5 rounded-md border border-slate-200 bg-white">
                        {filteredAllDocs.length === 0 ? (
                          <p className="px-3 py-2 text-xs text-slate-400 italic">{t("documents.no_documents_to_add")}</p>
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
                                className="accent-[var(--accent)]"
                              />
                              <span className="font-medium text-slate-700 truncate">{d.title}</span>
                              <span className="text-xs text-slate-400 truncate flex-shrink-0">{d.documentTypeName}</span>
                            </label>
                          );
                        })}
                      </div>
                    )}
                    <div className="flex items-center justify-end gap-2 mt-2">
                      <button onClick={() => setShowDocSelector(false)} className="text-xs text-slate-500 hover:text-slate-700 px-2 py-1">{t("actions.cancel")}</button>
                      <button
                        onClick={confirmDocAssoc}
                        disabled={selectedDocIds.size === 0 || docAssocLoading}
                        className="flex items-center gap-1 rounded-none bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[var(--accent)]/90 disabled:opacity-50 transition-colors"
                      >
                        {docAssocLoading ? <RefreshCw className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                        {t("contracts.confirm_selected").replace("{count}", String(selectedDocIds.size))}
                      </button>
                    </div>
                  </div>
                )}

                {docsFetched && (
                  <div className="border-t border-slate-50 px-4 py-2 text-right">
                    <Link href="/documents" className="text-xs text-[var(--accent)] hover:text-[var(--accent)] hover:underline transition-colors">
                      {t("contracts.view_all_docs")}
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
  const { t }                     = useLanguage();
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

  // RAG chat deep-link: ?focus=<contractId> expands the row once contracts are loaded.
  const searchParams = useSearchParams();
  const router       = useRouter();
  useEffect(() => {
    const focusId = searchParams.get("focus");
    if (!focusId || contracts.length === 0) return;
    if (contracts.some((c) => c.id === focusId)) {
      setExpanded(focusId);
      router.replace("/contracts", { scroll: false });
    }
  }, [searchParams, contracts, router]);

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
        if (filters.status === "activo" && st.key !== "active") return false;
        if (filters.status === "vence_pronto" && st.key !== "expiring_soon") return false;
        if (filters.status === "vencido" && st.key !== "expired") return false;
        if (filters.status === "sin_vencimiento" && st.key !== "no_expiry") return false;
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
      [t("contracts.columns.number"), t("contracts.columns.vendor"), t("contracts.principal_badge"), t("contracts.columns.start_date"), t("contracts.columns.end_date"), t("contracts.columns.status"), t("contracts.columns.cis_covered"), t("contracts.addendum_badge")],
      contracts.map((c) => {
        const status = getContractStatus(c.endDate);
        const type   = c.parentContract ? t("contracts.addendum_badge") : t("contracts.principal_badge");
        const statusLabel = status.key === "no_expiry" ? t("contracts.no_expiry") : t(`contracts.status.${status.key}`);
        return [
          c.contractNumber, c.vendor.name, type,
          formatDate(c.startDate),
          c.endDate ? formatDate(c.endDate) : "—",
          statusLabel,
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
              <h1 className="text-xl font-bold text-slate-900">{t("contracts.title")}</h1>
              <p className="text-sm text-slate-500 mt-0.5">{loading ? t("common.loading") : t("contracts.subtitle_stats").replace("{total}", String(total)).replace("{addendums}", String(addendums)).replace("{expired}", String(expiredCount))}</p>
            </div>
            {isAdmin && (
              <button onClick={() => setShowModal(true)} className="flex items-center gap-2 rounded-none bg-[var(--accent)] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[var(--accent)]/90 transition-colors shadow-sm">
                <Plus className="h-4 w-4" />{t("contracts.add_contract")}
              </button>
            )}
          </div>
        </header>

        <div className="px-8 py-8 w-full space-y-6">
          {!loading && !error && (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              {[
                { label: t("contracts.stat_total"),    value: total,        color: "bg-[var(--accent)]/5 text-[var(--accent)]" },
                { label: t("contracts.stat_addendums"),value: addendums,    color: "bg-amber-50 text-amber-700" },
                { label: t("contracts.stat_expired"),  value: expiredCount, color: "bg-red-50 text-red-700" },
                { label: t("contracts.stat_with_cis"), value: contracts.filter((c) => c.cis.length > 0).length, color: "bg-emerald-50 text-emerald-700" },
              ].map(({ label, value, color }) => (
                <div key={label} className={`${color.split(" ")[0]} px-4 py-3 ring-1 ring-inset ring-current/10`}>
                  <p className={`text-2xl font-bold ${color.split(" ")[1]}`}>{value}</p>
                  <p className="text-xs font-medium text-slate-500 mt-0.5">{label}</p>
                </div>
              ))}
            </div>
          )}

          <div className="bg-white shadow-sm ring-1 ring-slate-200 overflow-hidden">
            <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
              <h2 className="text-sm font-semibold text-slate-700 flex items-center gap-2"><FileText className="h-4 w-4 text-slate-400" />{t("contracts.list_title")}</h2>
              <div className="flex items-center gap-2">
                {activeFilterCount > 0 && (
                  <>
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--accent)]/10 px-2.5 py-1 text-xs font-semibold text-[var(--accent)]">
                      <Search className="h-3 w-3" />{activeFilterCount > 1 ? t("contracts.active_filters_plural").replace("{count}", String(activeFilterCount)) : t("contracts.active_filters").replace("{count}", String(activeFilterCount))}
                    </span>
                    <button onClick={clearFilters} className="flex items-center gap-1.5 rounded-none border border-red-200 bg-red-50 px-3 py-2 text-xs font-medium text-red-600 hover:bg-red-100 transition-colors">
                      <FilterX className="h-3.5 w-3.5" />{t("contracts.clear_filters")}
                    </button>
                  </>
                )}
                <button
                  onClick={handleExportCSV}
                  disabled={loading || contracts.length === 0}
                  className="flex items-center gap-1.5 rounded-none border border-slate-300 bg-slate-50 px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-100 transition-colors disabled:opacity-50"
                >
                  <Download className="h-3.5 w-3.5" />CSV
                </button>
                <button onClick={fetchContracts} className="flex items-center justify-center rounded-none border border-slate-300 bg-slate-50 p-2 text-slate-500 hover:bg-slate-100 transition-colors"><RefreshCw className="h-4 w-4" /></button>
              </div>
            </div>

            {loading && <div className="flex items-center justify-center py-20 text-slate-400"><RefreshCw className="mr-2 h-5 w-5 animate-spin" /><span className="text-sm">{t("common.loading")}</span></div>}
            {error && !loading && (
              <div className="flex flex-col items-center justify-center gap-2 py-16 text-red-500">
                <AlertTriangle className="h-8 w-8" /><p className="text-sm font-medium">{t("contracts.load_error")}</p>
                <p className="text-xs text-slate-400">{error}</p>
                <button onClick={fetchContracts} className="mt-2 rounded-lg bg-red-50 px-4 py-1.5 text-xs font-medium text-red-600 hover:bg-red-100">{t("actions.retry")}</button>
              </div>
            )}

            {!loading && !error && (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-100 bg-slate-50 text-left">
                      <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wider text-slate-500">{t("contracts.columns.number")}</th>
                      <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wider text-slate-500">{t("contracts.columns.vendor")}</th>
                      <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wider text-slate-500">
                        <div className="flex items-center gap-1"><Calendar className="h-3.5 w-3.5" />{t("contracts.columns.status_expiry")}</div>
                      </th>
                      <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wider text-slate-500">{t("contracts.columns.cis_covered")}</th>
                      <th className="px-4 py-3" />
                    </tr>
                    <tr className="border-b-2 border-[var(--accent)]/20 bg-[var(--accent)]/5">
                      {/* Nº Contrato */}
                      <td className="px-3 py-2">
                        <div className="relative">
                          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                          <input type="text" placeholder={t("contracts.filter_contract")} value={filters.contractNumber}
                            onChange={(e) => setFilter("contractNumber", e.target.value)}
                            className="w-full rounded-none border border-slate-200 bg-white py-1.5 pl-7 pr-2 text-xs text-slate-700 placeholder:text-slate-300 focus:border-[var(--accent)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]/20" />
                        </div>
                      </td>
                      {/* Proveedor */}
                      <td className="px-3 py-2">
                        <div className="relative">
                          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                          <input type="text" placeholder={t("contracts.filter_vendor")} value={filters.vendor}
                            onChange={(e) => setFilter("vendor", e.target.value)}
                            className="w-full rounded-none border border-slate-200 bg-white py-1.5 pl-7 pr-2 text-xs text-slate-700 placeholder:text-slate-300 focus:border-[var(--accent)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]/20" />
                        </div>
                      </td>
                      {/* Status */}
                      <td className="px-3 py-2">
                        <select value={filters.status} onChange={(e) => setFilter("status", e.target.value)}
                          className={`w-full rounded-none border py-1.5 px-2 text-xs focus:border-[var(--accent)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]/20 ${filters.status ? "border-[var(--accent)] bg-[var(--accent)]/5 text-[var(--accent)] font-medium" : "border-slate-200 bg-white text-slate-600"}`}>
                          <option value="">{t("contracts.filter_all")}</option>
                          <option value="activo">{t("contracts.status.active")}</option>
                          <option value="vence_pronto">{t("contracts.status.expiring_soon")}</option>
                          <option value="vencido">{t("contracts.status.expired")}</option>
                          <option value="sin_vencimiento">{t("contracts.no_expiry")}</option>
                        </select>
                      </td>
                      {/* CIs — type filter */}
                      <td className="px-3 py-2">
                        <select value={filters.type} onChange={(e) => setFilter("type", e.target.value)}
                          className={`w-full rounded-none border py-1.5 px-2 text-xs focus:border-[var(--accent)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]/20 ${filters.type ? "border-[var(--accent)] bg-[var(--accent)]/5 text-[var(--accent)] font-medium" : "border-slate-200 bg-white text-slate-600"}`}>
                          <option value="">{t("contracts.filter_all")}</option>
                          <option value="principal">{t("contracts.principal_badge")}</option>
                          <option value="adenda">{t("contracts.addendum_badge")}</option>
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
                          ? t("contracts.no_results_filtered")
                          : <>{t("contracts.empty_hint")} {isAdmin && <><strong>{t("contracts.add_contract")}</strong></>}</>}
                      </td></tr>
                    ) : (
                      filteredContracts.map((c) => (
                        <ContractRow
                          key={c.id}
                          contract={c}
                          expanded={expanded === c.id}
                          onExpand={() => setExpanded((p) => (p === c.id ? null : c.id))}
                          onContractUpdated={(updated) =>
                            setContracts((prev) => prev.map((x) => (x.id === updated.id ? { ...x, ...updated } : x)))
                          }
                        />
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            )}
            {!loading && !error && (
              <div className="border-t border-slate-100 px-6 py-3 text-xs text-slate-400">
                {filteredContracts.length !== 1 ? t("contracts.footer_count_plural").replace("{count}", String(filteredContracts.length)) : t("contracts.footer_count").replace("{count}", String(filteredContracts.length))}
                {activeFilterCount > 0 ? t("contracts.footer_of_total").replace("{total}", String(total)) : t("contracts.footer_hint")}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

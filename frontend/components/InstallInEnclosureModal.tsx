"use client";

import { useEffect, useRef, useState } from "react";
import { Server, Search, AlertTriangle, RefreshCw, ChevronDown, Trash2 } from "lucide-react";
import { apiFetch, fetchAllCIs } from "@/lib/apiFetch";
import { useLanguage } from "@/contexts/LanguageContext";
import { INSTALLED_IN_TARGET_TYPES } from "@/lib/relationTypes";

// ─── Types ────────────────────────────────────────────────────────────────────

interface EnclosureOption {
  id: string;
  name: string;
  ciType: string | null;
  status: string | null;
}

interface Props {
  ciId: string;
  ciName: string;
  currentRelationId?: string | null;
  currentEnclosureName?: string | null;
  onClose: () => void;
  onDone: () => void;
}

// ─── Searchable enclosure dropdown (adapted from AddRelationModal's CISelect) ──

function EnclosureSelect({
  label, value, onChange, options, placeholder, disabled,
}: {
  label: string;
  value: string;
  onChange: (id: string) => void;
  options: EnclosureOption[];
  placeholder: string;
  disabled?: boolean;
}) {
  const { t } = useLanguage();
  const [search, setSearch] = useState("");
  const [open, setOpen]     = useState(false);
  const ref                 = useRef<HTMLDivElement>(null);

  const selected = options.find((o) => o.id === value) ?? null;
  const filtered = options.filter((o) => o.name.toLowerCase().includes(search.toLowerCase()));

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setSearch("");
      }
    };
    if (open) document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-semibold uppercase tracking-wide text-slate-600">{label}</label>
      <div ref={ref} className="relative">
        <button
          type="button"
          disabled={disabled}
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center justify-between rounded-none border border-slate-300 bg-white px-3 py-2 text-left text-sm transition-colors hover:border-[var(--accent)] focus:outline-none focus:ring-2 focus:ring-indigo-200 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {selected ? (
            <span className="truncate font-medium text-slate-800">{selected.name}</span>
          ) : (
            <span className="text-slate-400">{placeholder}</span>
          )}
          <ChevronDown className={`ml-2 h-4 w-4 flex-shrink-0 text-slate-400 transition-transform ${open ? "rotate-180" : ""}`} />
        </button>

        {open && (
          <div className="absolute z-50 mt-1 w-full rounded-none border border-slate-200 bg-white shadow-xl">
            <div className="border-b border-slate-100 p-2">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                <input
                  autoFocus
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={t("common.search_ci")}
                  className="w-full rounded-none border border-slate-200 bg-slate-50 py-1.5 pl-8 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200"
                />
              </div>
            </div>
            <ul className="max-h-48 overflow-y-auto py-1">
              {filtered.length === 0 ? (
                <li className="px-3 py-2 text-sm italic text-slate-400">{t("common.no_results")}</li>
              ) : (
                filtered.map((o) => (
                  <li key={o.id}>
                    <button
                      type="button"
                      onClick={() => { onChange(o.id); setOpen(false); setSearch(""); }}
                      className={`flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-indigo-50 ${
                        o.id === value ? "bg-indigo-50 text-indigo-700" : "text-slate-700"
                      }`}
                    >
                      <span className="truncate font-medium">{o.name}</span>
                    </button>
                  </li>
                ))
              )}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Modal ────────────────────────────────────────────────────────────────────

export default function InstallInEnclosureModal({
  ciId, ciName, currentRelationId, currentEnclosureName, onClose, onDone,
}: Props) {
  const { t } = useLanguage();
  const [enclosures, setEnclosures]     = useState<EnclosureOption[]>([]);
  const [selected, setSelected]         = useState("");
  const [loadingCIs, setLoadingCIs]     = useState(true);
  const [submitting, setSubmitting]     = useState(false);
  const [uninstalling, setUninstalling] = useState(false);
  const [error, setError]               = useState<string | null>(null);

  useEffect(() => {
    fetchAllCIs<EnclosureOption>()
      .then((data) =>
        setEnclosures(
          data.filter(
            (c) =>
              c.id !== ciId &&
              c.status === "ACTIVO" &&
              c.ciType !== null &&
              INSTALLED_IN_TARGET_TYPES.includes(c.ciType)
          )
        )
      )
      .catch(() => setEnclosures([]))
      .finally(() => setLoadingCIs(false));
  }, [ciId]);

  const handleInstall = async () => {
    if (!selected) return;
    setSubmitting(true);
    setError(null);
    try {
      if (currentRelationId) {
        const delRes = await apiFetch(`/api/relations/${currentRelationId}`, { method: "DELETE" });
        if (!delRes.ok && delRes.status !== 404) {
          const err = await delRes.json().catch(() => ({} as { error?: string }));
          throw new Error(err.error ?? `Error ${delRes.status}`);
        }
      }
      const res = await apiFetch("/api/relations", {
        method: "POST",
        body: JSON.stringify({ sourceCiId: ciId, targetCiId: selected, relationType: "INSTALLED_IN" }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({} as { error?: string }));
        throw new Error(err.error ?? `Error ${res.status}`);
      }
      onDone();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("common.unknown_error"));
    } finally {
      setSubmitting(false);
    }
  };

  const handleUninstall = async () => {
    if (!currentRelationId) return;
    if (!confirm(t("ci_detail.confirm_uninstall"))) return;
    setUninstalling(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/relations/${currentRelationId}`, { method: "DELETE" });
      if (!res.ok && res.status !== 404) {
        const err = await res.json().catch(() => ({} as { error?: string }));
        throw new Error(err.error ?? `Error ${res.status}`);
      }
      onDone();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("common.unknown_error"));
    } finally {
      setUninstalling(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-md rounded-none bg-white shadow-2xl ring-1 ring-slate-200">
        {/* Header */}
        <div className="flex items-center gap-3 border-b border-slate-100 px-6 py-4">
          <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-none bg-indigo-100">
            <Server className="h-5 w-5 text-indigo-600" />
          </div>
          <div className="min-w-0">
            <h2 className="text-base font-bold text-slate-900">{t("ci_detail.install_btn")}</h2>
            <p className="truncate text-xs text-slate-500">{ciName}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto rounded-none p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-colors"
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="space-y-4 px-6 py-5">
          {currentEnclosureName && (
            <p className="text-xs text-slate-500">
              {t("ci_detail.installed_in")}: <span className="font-semibold text-slate-700">{currentEnclosureName}</span>
            </p>
          )}

          {loadingCIs ? (
            <div className="flex items-center justify-center gap-2 py-10 text-slate-400">
              <RefreshCw className="h-4 w-4 animate-spin" />
              <span className="text-sm">{t("relation.loading_cis")}</span>
            </div>
          ) : (
            <EnclosureSelect
              label={t("ci_detail.select_enclosure")}
              value={selected}
              onChange={setSelected}
              options={enclosures}
              placeholder={t("ci_detail.select_enclosure")}
              disabled={submitting || uninstalling}
            />
          )}

          {error && (
            <div className="flex items-center gap-2 rounded-none bg-red-50 px-3 py-2 text-sm text-red-600">
              <AlertTriangle className="h-4 w-4 flex-shrink-0" />
              {error}
            </div>
          )}

          <div className="flex items-center justify-between gap-2 pt-1">
            {currentRelationId ? (
              <button
                type="button"
                onClick={handleUninstall}
                disabled={submitting || uninstalling}
                className="flex items-center gap-1.5 rounded-none border border-red-300 px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 transition-colors"
              >
                {uninstalling ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                {t("ci_detail.uninstall_btn")}
              </button>
            ) : <span />}

            <div className="flex gap-2">
              <button
                type="button"
                onClick={onClose}
                disabled={submitting || uninstalling}
                className="rounded-none border border-slate-300 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50 transition-colors"
              >
                {t("actions.cancel")}
              </button>
              <button
                type="button"
                onClick={handleInstall}
                disabled={submitting || uninstalling || loadingCIs || !selected}
                className="rounded-none bg-[var(--accent)] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[var(--accent)]/90 shadow-sm disabled:opacity-50 transition-colors"
              >
                {submitting ? <RefreshCw className="mx-auto h-4 w-4 animate-spin" /> : t("ci_detail.install_btn")}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

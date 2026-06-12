"use client";

import { useEffect, useRef, useState } from "react";
import { Link2, Search, AlertTriangle, RefreshCw, ChevronDown } from "lucide-react";
import { apiFetch } from "@/lib/apiFetch";
import { useLanguage } from "@/contexts/LanguageContext";
import { RELATION_TYPES, RELATION_CATEGORIES, relationAllowed, type RelationTypeValue } from "@/lib/relationTypes";

// ─── Types ────────────────────────────────────────────────────────────────────

interface CIOption {
  id: string;
  name: string;
  apiSlug: string;
  ciType?: string | null;
}

interface Props {
  onClose: () => void;
  onCreated: () => void;
  preselectedSourceId?: string;
}

// ─── Searchable CI dropdown ───────────────────────────────────────────────────

function CISelect({
  label, value, onChange, options, placeholder, disabled,
}: {
  label: string;
  value: string;
  onChange: (id: string) => void;
  options: CIOption[];
  placeholder: string;
  disabled?: boolean;
}) {
  const { t } = useLanguage();
  const [search, setSearch] = useState("");
  const [open, setOpen]     = useState(false);
  const ref                 = useRef<HTMLDivElement>(null);

  const selected = options.find((o) => o.id === value) ?? null;
  const filtered = options.filter(
    (o) =>
      o.name.toLowerCase().includes(search.toLowerCase()) ||
      o.apiSlug.toLowerCase().includes(search.toLowerCase())
  );

  // Close on outside click
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
      <label className="text-xs font-semibold uppercase tracking-wide text-slate-600">
        {label}
      </label>
      <div ref={ref} className="relative">
        <button
          type="button"
          disabled={disabled}
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center justify-between rounded-lg border border-slate-300 bg-white px-3 py-2 text-left text-sm transition-colors hover:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-200 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {selected ? (
            <span className="flex items-center gap-2 truncate">
              <span className="font-medium text-slate-800 truncate">{selected.name}</span>
              <span className="flex-shrink-0 font-mono text-xs text-slate-400">{selected.apiSlug}</span>
            </span>
          ) : (
            <span className="text-slate-400">{placeholder}</span>
          )}
          <ChevronDown
            className={`ml-2 h-4 w-4 flex-shrink-0 text-slate-400 transition-transform ${open ? "rotate-180" : ""}`}
          />
        </button>

        {open && (
          <div className="absolute z-50 mt-1 w-full rounded-xl border border-slate-200 bg-white shadow-xl">
            <div className="border-b border-slate-100 p-2">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                <input
                  autoFocus
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={t("common.search_ci")}
                  className="w-full rounded-lg border border-slate-200 bg-slate-50 py-1.5 pl-8 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200"
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
                      onClick={() => {
                        onChange(o.id);
                        setOpen(false);
                        setSearch("");
                      }}
                      className={`flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-indigo-50 ${
                        o.id === value ? "bg-indigo-50 text-indigo-700" : "text-slate-700"
                      }`}
                    >
                      <span className="truncate font-medium">{o.name}</span>
                      <span className="ml-2 flex-shrink-0 font-mono text-xs text-slate-400">
                        {o.apiSlug}
                      </span>
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

export default function AddRelationModal({ onClose, onCreated, preselectedSourceId }: Props) {
  const { t } = useLanguage();
  const [cis, setCis]           = useState<CIOption[]>([]);
  const [sourceId, setSourceId] = useState(preselectedSourceId ?? "");
  const [targetId, setTargetId] = useState("");
  const [relType, setRelType]   = useState("DEPENDS_ON");
  const [loadingCIs, setLoadingCIs] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError]           = useState<string | null>(null);

  useEffect(() => {
    apiFetch("/api/cis")
      .then((r) => r.json())
      .then((json: { data: CIOption[] }) => setCis(json.data))
      .catch(() => setCis([]))
      .finally(() => setLoadingCIs(false));
  }, []);

  // T8: filter selectable relation types by the source/target CI type matrix
  const sourceType = cis.find((c) => c.id === sourceId)?.ciType ?? null;
  const targetType = cis.find((c) => c.id === targetId)?.ciType ?? null;
  const availableTypes = RELATION_TYPES.filter((k) =>
    relationAllowed(k as RelationTypeValue, sourceType, targetType)
  );

  // Keep selection valid when endpoints change
  useEffect(() => {
    if (!availableTypes.includes(relType as RelationTypeValue)) {
      setRelType(availableTypes[0] ?? "DEPENDS_ON");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceId, targetId]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!sourceId || !targetId) {
      setError(t("relation.error_required"));
      return;
    }
    if (sourceId === targetId) {
      setError(t("relation.error_same_ci"));
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const res = await apiFetch("/api/relations", {
        method: "POST",
        body: JSON.stringify({ sourceCiId: sourceId, targetCiId: targetId, relationType: relType }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? `Error ${res.status}`);
      }
      onCreated();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("common.unknown_error"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-md rounded-2xl bg-white shadow-2xl ring-1 ring-slate-200">
        {/* Header */}
        <div className="flex items-center gap-3 border-b border-slate-100 px-6 py-4">
          <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-indigo-100">
            <Link2 className="h-5 w-5 text-indigo-600" />
          </div>
          <div>
            <h2 className="text-base font-bold text-slate-900">{t("relation.modal_title")}</h2>
            <p className="text-xs text-slate-500">{t("relation.modal_subtitle")}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-colors"
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <form onSubmit={handleSubmit} className="space-y-4 px-6 py-5">
          {loadingCIs ? (
            <div className="flex items-center justify-center gap-2 py-10 text-slate-400">
              <RefreshCw className="h-4 w-4 animate-spin" />
              <span className="text-sm">{t("relation.loading_cis")}</span>
            </div>
          ) : (
            <>
              <CISelect
                label={t("relation.source_label")}
                value={sourceId}
                onChange={setSourceId}
                options={cis}
                placeholder={t("relation.source_placeholder")}
                disabled={submitting}
              />

              <div className="flex flex-col gap-1">
                <label className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                  {t("relation.type_label")}
                </label>
                <select
                  value={relType}
                  onChange={(e) => setRelType(e.target.value)}
                  disabled={submitting}
                  className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-200 disabled:opacity-50"
                >
                  {(["structural", "network", "power", "logical"] as const).map((cat) => {
                    const opts = availableTypes.filter((k) => RELATION_CATEGORIES[k] === cat);
                    if (opts.length === 0) return null;
                    return (
                      <optgroup key={cat} label={t(`relation.cat_${cat}`)}>
                        {opts.map((key) => (
                          <option key={key} value={key}>
                            {t(`relation.type_${key}`)}
                          </option>
                        ))}
                      </optgroup>
                    );
                  })}
                </select>
                {availableTypes.length < RELATION_TYPES.length && (
                  <p className="text-[11px] text-slate-400">{t("relation.types_filtered_hint")}</p>
                )}
              </div>

              <CISelect
                label={t("relation.target_label")}
                value={targetId}
                onChange={setTargetId}
                options={cis.filter((c) => c.id !== sourceId)}
                placeholder={t("relation.target_placeholder")}
                disabled={submitting}
              />
            </>
          )}

          {error && (
            <div className="flex items-center gap-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">
              <AlertTriangle className="h-4 w-4 flex-shrink-0" />
              {error}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50 transition-colors"
            >
              {t("actions.cancel")}
            </button>
            <button
              type="submit"
              disabled={submitting || loadingCIs || !sourceId || !targetId}
              className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50 transition-colors"
            >
              {submitting ? (
                <RefreshCw className="h-4 w-4 animate-spin" />
              ) : (
                <Link2 className="h-4 w-4" />
              )}
              {t("relation.create_button")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

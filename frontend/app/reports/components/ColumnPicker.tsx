"use client";
import { useState, useRef, useEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import { useLanguage } from "@/contexts/LanguageContext";
import { Columns3, Search, X, ChevronUp, ChevronDown, RotateCcw } from "lucide-react";

// Minimal structural column shape — reusable by reports (ReportColumn) and the
// inventory page (InvColumn). Both expose key/labelKey/group.
export interface PickerColumn {
  key: string;
  labelKey: string;
  group?: string;
}

interface Props {
  allColumns: PickerColumn[];
  visible: string[];      // ordered visible keys
  defaultKeys: string[];  // for "reset to default"
  onChange: (keys: string[]) => void;
}

export default function ColumnPicker({ allColumns, visible, defaultKeys, onChange }: Props) {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const [search, setSearch] = useState("");
  const popRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    function away(e: MouseEvent) {
      const tgt = e.target as Node;
      if (popRef.current && !popRef.current.contains(tgt) && btnRef.current && !btnRef.current.contains(tgt)) setOpen(false);
    }
    function onScroll(e: Event) { if (popRef.current && popRef.current.contains(e.target as Node)) return; setOpen(false); }
    function onResize() { setOpen(false); }
    document.addEventListener("mousedown", away);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("mousedown", away);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  const colByKey = useMemo(() => Object.fromEntries(allColumns.map((c) => [c.key, c])), [allColumns]);
  const isVisible = (k: string) => visible.includes(k);

  function toggle(k: string) {
    onChange(isVisible(k) ? visible.filter((x) => x !== k) : [...visible, k]);
  }
  function move(k: string, dir: -1 | 1) {
    const i = visible.indexOf(k);
    if (i < 0) return;
    const j = i + dir;
    if (j < 0 || j >= visible.length) return;
    const next = [...visible];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  }
  const showAll = () => onChange(allColumns.map((c) => c.key));
  const hideAll = () => onChange(visible.slice(0, 1)); // keep at least one column
  const reset = () => onChange(defaultKeys);

  const groups = useMemo(() => {
    const m = new Map<string, PickerColumn[]>();
    const q = search.trim().toLowerCase();
    for (const c of allColumns) {
      if (q && !t(c.labelKey).toLowerCase().includes(q)) continue;
      const g = c.group ?? "general";
      if (!m.has(g)) m.set(g, []);
      m.get(g)!.push(c);
    }
    return m;
  }, [allColumns, search, t]);

  return (
    <span className="inline-flex">
      <button
        ref={btnRef}
        onClick={(e) => {
          if (open) { setOpen(false); return; }
          setAnchor(e.currentTarget.getBoundingClientRect());
          setOpen(true);
        }}
        className="rounded-none border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50 flex items-center gap-1.5"
      >
        <Columns3 className="w-3.5 h-3.5" /> {t("reports.columnPicker.title")}
        <span className="text-slate-400">({visible.length})</span>
      </button>

      {open && anchor && typeof document !== "undefined" && createPortal(
        <div
          ref={popRef}
          style={{ position: "fixed", top: anchor.bottom + 4, left: Math.max(8, Math.min(anchor.left, window.innerWidth - 340)) }}
          className="z-50 w-80 bg-white ring-1 ring-slate-200 shadow-lg flex flex-col max-h-[70vh]"
        >
          {/* search + actions */}
          <div className="p-2 border-b border-slate-100 space-y-2">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t("reports.columnPicker.search")}
                className="w-full border border-slate-200 pl-7 pr-2 py-1.5 text-xs text-slate-700 focus:outline-none focus:border-[var(--accent)]"
              />
            </div>
            <div className="flex gap-1.5 text-[11px]">
              <button onClick={showAll} className="px-2 py-1 border border-slate-200 hover:bg-slate-50">{t("reports.columnPicker.showAll")}</button>
              <button onClick={hideAll} className="px-2 py-1 border border-slate-200 hover:bg-slate-50">{t("reports.columnPicker.hideAll")}</button>
              <button onClick={reset} className="ml-auto px-2 py-1 border border-slate-200 hover:bg-slate-50 flex items-center gap-1">
                <RotateCcw className="w-3 h-3" /> {t("reports.columnPicker.reset")}
              </button>
            </div>
          </div>

          {/* visible columns — order & remove (hidden while searching) */}
          {!search && (
            <div className="p-2 border-b border-slate-100">
              <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wide mb-1">{t("reports.columnPicker.title")} · {visible.length}</div>
              <div className="space-y-0.5 max-h-40 overflow-y-auto">
                {visible.map((k, idx) => (
                  <div key={k} className="flex items-center gap-1 text-xs px-1 py-0.5 hover:bg-slate-50">
                    <span className="flex-1 truncate text-slate-700">{t(colByKey[k]?.labelKey ?? k)}</span>
                    <button disabled={idx === 0} onClick={() => move(k, -1)} className="p-0.5 text-slate-400 hover:text-slate-700 disabled:opacity-25"><ChevronUp className="w-3 h-3" /></button>
                    <button disabled={idx === visible.length - 1} onClick={() => move(k, 1)} className="p-0.5 text-slate-400 hover:text-slate-700 disabled:opacity-25"><ChevronDown className="w-3 h-3" /></button>
                    <button disabled={visible.length <= 1} onClick={() => toggle(k)} className="p-0.5 text-slate-400 hover:text-rose-600 disabled:opacity-25"><X className="w-3 h-3" /></button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* grouped checklist — add/remove */}
          <div className="overflow-y-auto flex-1 p-2 space-y-2">
            {[...groups.entries()].map(([g, cols]) => (
              <div key={g}>
                <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wide mb-1">{t(`reports.columnPicker.group.${g}`)}</div>
                <div className="space-y-0.5">
                  {cols.map((c) => (
                    <label key={c.key} className="flex items-center gap-2 text-xs px-1 py-0.5 hover:bg-slate-50 cursor-pointer">
                      <input type="checkbox" checked={isVisible(c.key)} onChange={() => toggle(c.key)} />
                      <span className="truncate text-slate-700">{t(c.labelKey)}</span>
                    </label>
                  ))}
                </div>
              </div>
            ))}
            {groups.size === 0 && (
              <div className="text-xs text-slate-400 text-center py-4">{t("reports.list.no_results")}</div>
            )}
          </div>
        </div>,
        document.body,
      )}
    </span>
  );
}

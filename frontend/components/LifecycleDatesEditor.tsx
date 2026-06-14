"use client";

import { useEffect, useState, useCallback } from "react";
import { Plus, Trash2, Pencil, Check, X, Calendar } from "lucide-react";
import { apiFetch } from "@/lib/apiFetch";
import { useLanguage } from "@/contexts/LanguageContext";

type EntityType = "cis" | "operating-systems" | "base-software" | "device-models";
type DTCategory = "HARDWARE" | "SOFTWARE" | "OS" | "GENERAL";

interface DateTypeRow { id: string; code: string; name: string; category: DTCategory; sortOrder: number }
interface EntityDate  { id: string; dateTypeId: string; dateValue: string; notes: string | null; dateType: DateTypeRow }

interface Props {
  entityType     : EntityType;
  entityId       : string;
  categoryFilter?: DTCategory;
  readOnly?      : boolean;
}

function fmtDate(v: string) {
  return v ? new Date(v).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "";
}

function toIso(v: string) {
  return v ? v.slice(0, 10) : "";
}

export function LifecycleDatesEditor({ entityType, entityId, categoryFilter, readOnly }: Props) {
  const { t } = useLanguage();
  const [rows,      setRows]      = useState<EntityDate[]>([]);
  const [dateTypes, setDateTypes] = useState<DateTypeRow[]>([]);
  const [loading,   setLoading]   = useState(false);
  const [editId,    setEditId]    = useState<string | null>(null);
  const [editVal,   setEditVal]   = useState("");
  const [editNotes, setEditNotes] = useState("");

  const [addTypeId, setAddTypeId] = useState("");
  const [addDate,   setAddDate]   = useState("");
  const [addNotes,  setAddNotes]  = useState("");
  const [adding,    setAdding]    = useState(false);

  const base = `/api/catalog/${entityType}/${entityId}/dates`;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [datesRes, dtRes] = await Promise.all([
        apiFetch(base),
        apiFetch(`/api/catalog/date-types${categoryFilter ? `?category=${categoryFilter}` : ""}`),
      ]);
      const datesData = await datesRes.json();
      const dtData    = await dtRes.json();
      setRows(Array.isArray(datesData) ? datesData : []);
      setDateTypes(Array.isArray(dtData) ? dtData : []);
    } catch { /* silent */ }
    finally { setLoading(false); }
  }, [base, categoryFilter]);

  useEffect(() => { load(); }, [load]);

  const usedTypeIds = new Set(rows.map((r) => r.dateTypeId));
  const availableTypes = dateTypes.filter((dt) => !usedTypeIds.has(dt.id));

  const startEdit = (r: EntityDate) => {
    setEditId(r.id);
    setEditVal(toIso(r.dateValue));
    setEditNotes(r.notes ?? "");
  };

  const saveEdit = async () => {
    if (!editId || !editVal) return;
    try {
      await apiFetch(`${base}/${editId}`, {
        method: "PATCH",
        body  : JSON.stringify({ dateValue: editVal, notes: editNotes || null }),
      });
      setEditId(null);
      load();
    } catch (e) { alert(e instanceof Error ? e.message : "Error"); }
  };

  const remove = async (id: string, name: string) => {
    if (!confirm(`${t("lde.confirm_delete")} "${name}"?`)) return;
    try {
      await apiFetch(`${base}/${id}`, { method: "DELETE" });
      load();
    } catch (e) { alert(e instanceof Error ? e.message : "Error"); }
  };

  const add = async () => {
    if (!addTypeId || !addDate) { alert(t("lde.add_required")); return; }
    setAdding(true);
    try {
      const res = await apiFetch(base, {
        method: "POST",
        body  : JSON.stringify({ dateTypeId: addTypeId, dateValue: addDate, notes: addNotes || null }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({})) as { error?: string };
        alert(d.error ?? `Error ${res.status}`);
        return;
      }
      setAddTypeId(""); setAddDate(""); setAddNotes("");
      load();
    } catch (e) { alert(e instanceof Error ? e.message : "Error"); }
    finally { setAdding(false); }
  };

  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="space-y-3">
      {/* Existing dates */}
      {loading && <p className="text-xs text-slate-400">{t("lde.loading")}</p>}
      {!loading && rows.length === 0 && (
        <p className="text-xs text-slate-400 italic">{t("lde.empty")}</p>
      )}
      {rows.map((r) => {
        const isEditing = editId === r.id;
        const dv = new Date(r.dateValue);
        const now = new Date();
        const daysLeft = Math.ceil((dv.getTime() - now.getTime()) / 86400000);
        const badge =
          daysLeft < 0   ? "bg-red-100 text-red-700"
          : daysLeft < 90 ? "bg-amber-100 text-amber-700"
          :                  "bg-emerald-50 text-emerald-700";

        if (isEditing && !readOnly) {
          return (
            <div key={r.id} className="rounded border border-[var(--accent)]/30 bg-[var(--accent)]/5 px-3 py-2 space-y-2">
              <p className="text-xs font-semibold text-slate-600">{r.dateType.name}</p>
              <div className="flex gap-2">
                <input
                  type="date"
                  value={editVal}
                  onChange={(e) => setEditVal(e.target.value)}
                  className="flex-1 rounded-none border border-slate-300 bg-slate-50 px-2 py-1.5 text-sm focus:border-[var(--accent)] focus:outline-none"
                />
                <input
                  type="text"
                  value={editNotes}
                  onChange={(e) => setEditNotes(e.target.value)}
                  placeholder={t("lde.notes_placeholder")}
                  className="flex-1 rounded-none border border-slate-300 bg-slate-50 px-2 py-1.5 text-sm focus:border-[var(--accent)] focus:outline-none"
                />
                <button onClick={saveEdit}   className="rounded-lg p-1.5 text-emerald-600 hover:bg-emerald-50"><Check className="h-4 w-4" /></button>
                <button onClick={() => setEditId(null)} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100"><X className="h-4 w-4" /></button>
              </div>
            </div>
          );
        }

        return (
          <div key={r.id} className="flex items-center justify-between rounded border border-slate-100 bg-white px-3 py-2 group hover:bg-slate-50 transition-colors">
            <div className="flex items-center gap-3 min-w-0">
              <Calendar className="h-3.5 w-3.5 flex-shrink-0 text-slate-400" />
              <div className="min-w-0">
                <p className="text-xs font-medium text-slate-700 truncate">{r.dateType.name}</p>
                {r.notes && <p className="text-[10px] text-slate-400 truncate">{r.notes}</p>}
              </div>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold tabular-nums ${badge}`}>
                {fmtDate(r.dateValue)}
              </span>
              {!readOnly && (
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-all">
                  <button onClick={() => startEdit(r)} className="rounded p-1 text-[var(--accent)] hover:bg-[var(--accent)]/10"><Pencil className="h-3.5 w-3.5" /></button>
                  <button onClick={() => remove(r.id, r.dateType.name)} className="rounded p-1 text-red-400 hover:bg-red-50 hover:text-red-600"><Trash2 className="h-3.5 w-3.5" /></button>
                </div>
              )}
            </div>
          </div>
        );
      })}

      {/* Add form */}
      {!readOnly && availableTypes.length > 0 && (
        <div className="flex gap-2 pt-1">
          <select
            value={addTypeId}
            onChange={(e) => setAddTypeId(e.target.value)}
            className="flex-1 min-w-0 rounded-none border border-slate-300 bg-slate-50 px-2 py-1.5 text-xs focus:border-[var(--accent)] focus:outline-none"
          >
            <option value="">{t("lde.select_type")}</option>
            {availableTypes.map((dt) => <option key={dt.id} value={dt.id}>{dt.name}</option>)}
          </select>
          <input
            type="date"
            value={addDate}
            max={today + "0"}
            onChange={(e) => setAddDate(e.target.value)}
            className="w-36 rounded-none border border-slate-300 bg-slate-50 px-2 py-1.5 text-xs focus:border-[var(--accent)] focus:outline-none"
          />
          <button
            onClick={add}
            disabled={adding || !addTypeId || !addDate}
            className="flex items-center gap-1 rounded-none border border-[var(--accent)] bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50 transition-opacity"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      {!readOnly && availableTypes.length === 0 && rows.length > 0 && (
        <p className="text-[10px] text-slate-400 italic">{t("lde.all_types_set")}</p>
      )}
    </div>
  );
}

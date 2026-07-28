"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/apiFetch";
import type {
  Department,
  DepartmentManagerInfo,
  DepartmentMemberInfo,
  DepartmentScheduleConfig,
  EntryUpdateInput,
  ScheduleView,
  StaffScheduleListItem,
  SummerSchedule,
  WorkerEntryItem,
  WorkerMonthlySummary,
  WorkerSearchResult,
} from "../types";

/** Monday (UTC, ISO yyyy-mm-dd) of the week containing `d`. */
export function mondayOf(d: Date): string {
  const copy = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = copy.getUTCDay(); // 0=Sun..6=Sat
  const diff = day === 0 ? -6 : 1 - day;
  copy.setUTCDate(copy.getUTCDate() + diff);
  return copy.toISOString().slice(0, 10);
}

export function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Monday (UTC, ISO yyyy-mm-dd) of the week containing the given ISO date, computed
 * purely from the ISO string (no local-time getters) so it is timezone-safe. */
function mondayOfIso(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  const day = d.getUTCDay(); // 0=Sun..6=Sat
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

/** First day (UTC, ISO yyyy-mm-dd) of `month` (1-12) in `year`. */
export function monthStartIso(year: number, month: number): string {
  return new Date(Date.UTC(year, month - 1, 1)).toISOString().slice(0, 10);
}

/** Last day (UTC, ISO yyyy-mm-dd) of `month` (1-12) in `year`. */
function monthEndIso(year: number, month: number): string {
  // Day 0 of the following month is the last day of this month (UTC).
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

/**
 * The Monday (ISO) of every week that overlaps the given calendar month —
 * i.e. the sequence of `weekStart` values a stacked monthly view needs to
 * fetch (R6). Typically 4-6 entries depending on where the month starts/ends.
 * All UTC; matches the rest of this module's date convention.
 */
export function weeksOfMonth(year: number, month: number): string[] {
  const firstMonday = mondayOfIso(monthStartIso(year, month));
  const lastMonday = mondayOfIso(monthEndIso(year, month));
  const weeks: string[] = [];
  let cur = firstMonday;
  // ISO yyyy-mm-dd strings compare chronologically, so plain string
  // comparison is safe here.
  while (cur <= lastMonday) {
    weeks.push(cur);
    cur = addDaysIso(cur, 7);
  }
  return weeks;
}

/** Adds `delta` calendar months to (year, month), normalizing month back into 1-12
 * and rolling the year over as needed. Pure, UTC-conceptual (no Date day-clamping
 * pitfalls since it operates on year/month integers, not a day-of-month). */
export function addMonthsIso(year: number, month: number, delta: number): { year: number; month: number } {
  const total = year * 12 + (month - 1) + delta;
  const newYear = Math.floor(total / 12);
  const newMonth = total - newYear * 12 + 1;
  return { year: newYear, month: newMonth };
}

/** ISO 8601 week number (and ISO week-year, which can differ from the
 * calendar year right at year boundaries) of the week containing `dateIso`.
 * Used for the print header's "semana N de AAAA" label. */
export function isoWeekNumber(dateIso: string): { week: number; year: number } {
  const d = new Date(`${dateIso}T00:00:00Z`);
  const dayNum = (d.getUTCDay() + 6) % 7; // Monday=0 .. Sunday=6
  d.setUTCDate(d.getUTCDate() - dayNum + 3); // move to this week's Thursday
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const firstThursdayDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstThursdayDayNum + 3);
  const week = 1 + Math.round((d.getTime() - firstThursday.getTime()) / (7 * 86400000));
  return { week, year: d.getUTCFullYear() };
}

/**
 * Sets the print orientation for the WHOLE document, by rewriting a single
 * `@page` rule in a dedicated <style> in <head>.
 *
 * Why this instead of a CSS named page (`@page foo { size: ... }` +
 * `.something { page: foo }`)? Because Chromium does not re-layout content
 * when a named page changes the page SIZE partway through a document: the
 * content keeps the width of the previous page context and is then clipped
 * onto the differently-sized sheet. That was verified against a real
 * generated PDF — portrait sheets carrying tables still laid out at the
 * landscape width, losing ~224pt off the right edge, plus a stray landscape
 * page holding only the document header.
 *
 * Keeping exactly ONE `@page` rule per print job sidesteps that entirely:
 * every sheet has the same geometry, so layout and paper agree. The rule is
 * kept in sync with the active view (rather than being written at click
 * time) so the browser's native Ctrl+P gets the correct orientation too,
 * with no timing dependency on our own click handler.
 */
export function usePrintPageOrientation(orientation: "portrait" | "landscape") {
  useEffect(() => {
    const STYLE_ID = "staff-schedule-print-page";
    let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
    if (!el) {
      el = document.createElement("style");
      el.id = STYLE_ID;
      document.head.appendChild(el);
    }
    // Narrower margins in portrait: those reports (all-departments, month)
    // are the ones that need to fit in as few sheets as possible.
    el.textContent =
      orientation === "portrait"
        ? "@media print { @page { size: A4 portrait; margin: 6mm; } }"
        : "@media print { @page { size: A4 landscape; margin: 8mm; } }";
    return () => {
      el?.remove();
    };
  }, [orientation]);
}

/** Departments the user can see, for the department filter. */
export function useDepartments() {
  const [departments, setDepartments] = useState<Department[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch("/api/staff-schedule/departments");
      if (!res.ok) throw new Error(`Status ${res.status}`);
      setDepartments(await res.json());
    } catch {
      setError("error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refetch();
  }, [refetch]);

  return { departments, loading, error, refetch };
}

/** The schedule (if any) for a department + week, and its full masked view. */
export function useSchedule(departmentId: string | null, weekStart: string) {
  const [view, setView] = useState<ScheduleView | null>(null);
  const [scheduleId, setScheduleId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  const load = useCallback(async () => {
    if (!departmentId) {
      setView(null);
      setScheduleId(null);
      setNotFound(false);
      return;
    }
    setLoading(true);
    setError(null);
    setNotFound(false);
    try {
      const listRes = await apiFetch(
        `/api/staff-schedule?departmentId=${departmentId}&weekStart=${weekStart}`,
      );
      if (!listRes.ok) throw new Error(`Status ${listRes.status}`);
      const list: StaffScheduleListItem[] = await listRes.json();
      const match = list.find((s) => s.weekStart.slice(0, 10) === weekStart);
      if (!match) {
        setView(null);
        setScheduleId(null);
        setNotFound(true);
        return;
      }
      setScheduleId(match.id);
      const viewRes = await apiFetch(`/api/staff-schedule/${match.id}`);
      if (!viewRes.ok) throw new Error(`Status ${viewRes.status}`);
      setView(await viewRes.json());
    } catch {
      setError("error");
    } finally {
      setLoading(false);
    }
  }, [departmentId, weekStart]);

  useEffect(() => {
    load();
  }, [load]);

  const createSchedule = useCallback(async () => {
    if (!departmentId) return;
    const res = await apiFetch("/api/staff-schedule", {
      method: "POST",
      body: JSON.stringify({ departmentId, weekStart }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ? JSON.stringify(body.error) : `Status ${res.status}`);
    }
    await load();
  }, [departmentId, weekStart, load]);

  const saveEntries = useCallback(
    async (entries: EntryUpdateInput[]) => {
      if (!scheduleId) return;
      const res = await apiFetch(`/api/staff-schedule/${scheduleId}`, {
        method: "PUT",
        body: JSON.stringify({ entries }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ? JSON.stringify(body.error) : `Status ${res.status}`);
      }
      await load();
    },
    [scheduleId, load],
  );

  const validate = useCallback(async () => {
    if (!scheduleId) return;
    const res = await apiFetch(`/api/staff-schedule/${scheduleId}/validate`, { method: "POST" });
    if (!res.ok) throw new Error(`Status ${res.status}`);
    await load();
  }, [scheduleId, load]);

  const publish = useCallback(async () => {
    if (!scheduleId) return;
    const res = await apiFetch(`/api/staff-schedule/${scheduleId}/publish`, { method: "POST" });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? `Status ${res.status}`);
    }
    await load();
  }, [scheduleId, load]);

  const unpublish = useCallback(async () => {
    if (!scheduleId) return;
    const res = await apiFetch(`/api/staff-schedule/${scheduleId}/unpublish`, { method: "POST" });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? `Status ${res.status}`);
    }
    await load();
  }, [scheduleId, load]);

  const clone = useCallback(async (targetWeekStart: string) => {
    if (!scheduleId) return;
    const res = await apiFetch(`/api/staff-schedule/${scheduleId}/clone`, {
      method: "POST",
      body: JSON.stringify({ targetWeekStart }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? `Status ${res.status}`);
    }
  }, [scheduleId]);

  // v3.5.10 refinamiento — añade entradas base para los miembros del
  // departamento que aún no tengan ninguna en este horario. No destructivo.
  const syncMembers = useCallback(async (): Promise<{ added: number }> => {
    if (!scheduleId) return { added: 0 };
    const res = await apiFetch(`/api/staff-schedule/${scheduleId}/sync-members`, { method: "POST" });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? `Status ${res.status}`);
    }
    const result = await res.json();
    await load();
    return result;
  }, [scheduleId, load]);

  // v3.5.10 refinamiento — descarta un horario en DRAFT (permite re-clonar la
  // semana). Un PUBLISHED debe despublicarse primero (D10).
  const deleteSchedule = useCallback(async () => {
    if (!scheduleId) return;
    const res = await apiFetch(`/api/staff-schedule/${scheduleId}`, { method: "DELETE" });
    if (!res.ok && res.status !== 204) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? `Status ${res.status}`);
    }
    await load();
  }, [scheduleId, load]);

  // Import the previous week's schedule (same department) onto the currently
  // viewed, empty week. Looks up the previous week's schedule id, then clones
  // it forward via the same endpoint used by the "Clone to week..." picker.
  const importPreviousWeek = useCallback(async () => {
    if (!departmentId) return;
    const prevWeekStart = addDaysIso(weekStart, -7);
    const listRes = await apiFetch(`/api/staff-schedule?departmentId=${departmentId}&weekStart=${prevWeekStart}`);
    if (!listRes.ok) throw new Error(`Status ${listRes.status}`);
    const list: StaffScheduleListItem[] = await listRes.json();
    const prev = list.find((s) => s.weekStart.slice(0, 10) === prevWeekStart);
    if (!prev) throw new Error("No schedule found for the previous week");
    const res = await apiFetch(`/api/staff-schedule/${prev.id}/clone`, {
      method: "POST",
      body: JSON.stringify({ targetWeekStart: weekStart }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? `Status ${res.status}`);
    }
    await load();
  }, [departmentId, weekStart, load]);

  return {
    view,
    scheduleId,
    loading,
    error,
    notFound,
    refetch: load,
    createSchedule,
    saveEntries,
    validate,
    publish,
    unpublish,
    clone,
    importPreviousWeek,
    syncMembers,
    deleteSchedule,
  };
}

export function useScheduleExport() {
  const exportSchedule = useCallback(async (scheduleId: string, format: "csv" | "xlsx") => {
    const res = await apiFetch(`/api/staff-schedule/${scheduleId}/export?format=${format}`);
    if (!res.ok) throw new Error(`Status ${res.status}`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `schedule-${scheduleId}.${format}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, []);

  return { exportSchedule };
}

export function useDepartmentConfig(departmentId: string | null) {
  const [config, setConfig] = useState<DepartmentScheduleConfig | null>(null);
  const [loading, setLoading] = useState(false);

  const refetch = useCallback(async () => {
    if (!departmentId) {
      setConfig(null);
      return;
    }
    setLoading(true);
    try {
      const res = await apiFetch(`/api/staff-schedule/departments/${departmentId}/config`);
      if (!res.ok) {
        setConfig(null);
        return;
      }
      setConfig(await res.json());
    } finally {
      setLoading(false);
    }
  }, [departmentId]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  const save = useCallback(
    async (data: Partial<DepartmentScheduleConfig>) => {
      if (!departmentId) return;
      const res = await apiFetch(`/api/staff-schedule/departments/${departmentId}/config`, {
        method: "PUT",
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ? JSON.stringify(body.error) : `Status ${res.status}`);
      }
      await refetch();
    },
    [departmentId, refetch],
  );

  return { config, loading, refetch, save };
}

// v3.5.10 refinamiento — antes no había ningún GET para ver quién gestiona un
// departamento ni quién pertenece a él; el panel de configuración solo podía
// añadir/quitar managers a ciegas.
export function useDepartmentManagers(departmentId: string | null) {
  const [managers, setManagers] = useState<DepartmentManagerInfo[]>([]);
  const [loading, setLoading] = useState(false);

  const refetch = useCallback(async () => {
    if (!departmentId) {
      setManagers([]);
      return;
    }
    setLoading(true);
    try {
      const res = await apiFetch(`/api/staff-schedule/departments/${departmentId}/managers`);
      setManagers(res.ok ? await res.json() : []);
    } finally {
      setLoading(false);
    }
  }, [departmentId]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  return { managers, loading, refetch };
}

export function useDepartmentMembers(departmentId: string | null) {
  const [members, setMembers] = useState<DepartmentMemberInfo[]>([]);
  const [loading, setLoading] = useState(false);

  const refetch = useCallback(async () => {
    if (!departmentId) {
      setMembers([]);
      return;
    }
    setLoading(true);
    try {
      const res = await apiFetch(`/api/staff-schedule/departments/${departmentId}/members`);
      setMembers(res.ok ? await res.json() : []);
    } finally {
      setLoading(false);
    }
  }, [departmentId]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  return { members, loading, refetch };
}

export function useSummerSchedule(year: number) {
  const [summer, setSummer] = useState<SummerSchedule | null>(null);
  const [loading, setLoading] = useState(false);

  const refetch = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch(`/api/staff-schedule/summer?year=${year}`);
      if (!res.ok) {
        setSummer(null);
        return;
      }
      setSummer(await res.json());
    } finally {
      setLoading(false);
    }
  }, [year]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  const save = useCallback(
    async (data: { year: number; startDate: string; endDate: string }) => {
      const res = await apiFetch("/api/staff-schedule/summer", {
        method: "POST",
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ? JSON.stringify(body.error) : `Status ${res.status}`);
      }
      await refetch();
    },
    [refetch],
  );

  return { summer, loading, refetch, save };
}

/** Read-only view of every department's schedule for a given week ("Todos los departamentos"). */
export function useAllDepartmentsSchedules(weekStart: string) {
  const [entries, setEntries] = useState<{ department: { id: string; name: string }; view: ScheduleView }[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const listRes = await apiFetch(`/api/staff-schedule?weekStart=${weekStart}`);
      if (!listRes.ok) throw new Error(`Status ${listRes.status}`);
      const list: StaffScheduleListItem[] = await listRes.json();
      const matches = list.filter((s) => s.weekStart.slice(0, 10) === weekStart);
      const results = await Promise.all(
        matches.map(async (s) => {
          const r = await apiFetch(`/api/staff-schedule/${s.id}`);
          if (!r.ok) return null;
          const view: ScheduleView = await r.json();
          return { department: s.department, view };
        }),
      );
      setEntries(results.filter((r): r is { department: { id: string; name: string }; view: ScheduleView } => r !== null));
    } catch {
      setError("error");
    } finally {
      setLoading(false);
    }
  }, [weekStart]);

  useEffect(() => {
    load();
  }, [load]);

  return { entries, loading, error, refetch: load };
}

/** One week's slot in a department's month view — `view: null` means the week
 * genuinely has no schedule (D8: shown explicitly, never a silent gap). */
export interface DepartmentMonthWeek {
  weekStart: string;
  view: ScheduleView | null;
}

const MAX_MONTH_WEEKS = 6; // matches the server-side cap on GET /api/staff-schedule?from=&to=

/**
 * Read-only view of a single department across every week overlapping a
 * calendar month (R6). Same N+1 fetch pattern as useAllDepartmentsSchedules:
 * one list request for the whole range, then one detail request per week
 * that actually has a schedule. Weeks without a schedule are kept in the
 * result with `view: null` rather than omitted (D8).
 */
export function useDepartmentMonth(departmentId: string | null, year: number, month: number) {
  const [weeks, setWeeks] = useState<DepartmentMonthWeek[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!departmentId) {
      setWeeks([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const weekStarts = weeksOfMonth(year, month).slice(0, MAX_MONTH_WEEKS);
      if (weekStarts.length === 0) {
        setWeeks([]);
        return;
      }
      const from = weekStarts[0];
      const to = weekStarts[weekStarts.length - 1];
      const listRes = await apiFetch(
        `/api/staff-schedule?departmentId=${departmentId}&from=${from}&to=${to}`,
      );
      if (!listRes.ok) throw new Error(`Status ${listRes.status}`);
      const list: StaffScheduleListItem[] = await listRes.json();
      const byWeekStart = new Map(list.map((s) => [s.weekStart.slice(0, 10), s]));

      const results = await Promise.all(
        weekStarts.map(async (ws): Promise<DepartmentMonthWeek> => {
          const match = byWeekStart.get(ws);
          if (!match) return { weekStart: ws, view: null };
          const r = await apiFetch(`/api/staff-schedule/${match.id}`);
          if (!r.ok) return { weekStart: ws, view: null };
          const view: ScheduleView = await r.json();
          return { weekStart: ws, view };
        }),
      );
      setWeeks(results);
    } catch {
      setError("error");
    } finally {
      setLoading(false);
    }
  }, [departmentId, year, month]);

  useEffect(() => {
    load();
  }, [load]);

  return { weeks, loading, error, refetch: load };
}

// v3.5.12 (R5/F4) — Debounced (250ms) search for the worker combobox.
// GET /api/staff-schedule/users?q=; server 400s under 2 chars, so this
// never fires the request below that length (also saves a round trip).
export function useWorkerSearch(q: string) {
  const [results, setResults] = useState<WorkerSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setResults([]);
      setError(null);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    const handle = setTimeout(() => {
      apiFetch(`/api/staff-schedule/users?q=${encodeURIComponent(term)}`, { signal: controller.signal })
        .then((res) => {
          if (!res.ok) throw new Error(`Status ${res.status}`);
          return res.json();
        })
        .then((data: WorkerSearchResult[]) => setResults(data))
        .catch((err) => {
          if (err instanceof DOMException && err.name === "AbortError") return;
          setError("error");
        })
        .finally(() => setLoading(false));
    }, 250);
    return () => {
      clearTimeout(handle);
      controller.abort();
    };
  }, [q]);

  return { results, loading, error };
}

// v3.5.12 (R5/F4) — a worker's masked entries in a date range (week or
// month mode). Server caps the range at 62 days (D6) — this hook just
// forwards whatever `from`/`to` its caller computed, it doesn't validate
// the span itself.
export function useWorkerEntries(userId: string | null, from: string, to: string) {
  const [entries, setEntries] = useState<WorkerEntryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!userId) {
      setEntries([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/staff-schedule/user/${userId}/entries?from=${from}&to=${to}`);
      if (!res.ok) throw new Error(`Status ${res.status}`);
      setEntries(await res.json());
    } catch {
      setError("error");
    } finally {
      setLoading(false);
    }
  }, [userId, from, to]);

  useEffect(() => {
    load();
  }, [load]);

  return { entries, loading, error, refetch: load };
}

// v3.5.12 (R5/F4) — thin wrapper over the existing GET /user/:userId/monthly
// endpoint, reused as-is for the worker view's month-mode aggregate figures.
export function useWorkerMonthlySummary(userId: string | null, year: number, month: number) {
  const [summary, setSummary] = useState<WorkerMonthlySummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!userId) {
      setSummary(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/staff-schedule/user/${userId}/monthly?year=${year}&month=${month}`);
      if (!res.ok) throw new Error(`Status ${res.status}`);
      setSummary(await res.json());
    } catch {
      setError("error");
    } finally {
      setLoading(false);
    }
  }, [userId, year, month]);

  useEffect(() => {
    load();
  }, [load]);

  return { summary, loading, error, refetch: load };
}

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

// TODO: replace with shared weeksOfMonth() from F2 once merged — F2 is adding
// an identical helper to this same file in parallel; this local copy exists
// only to avoid blocking F5 on that other task landing first.
function weeksOfMonthLocal(year: number, month: number): string[] {
  const firstOfMonth = new Date(Date.UTC(year, month - 1, 1));
  const lastOfMonth = new Date(Date.UTC(year, month, 0));
  const firstMonday = mondayOf(firstOfMonth);
  const lastMonday = mondayOf(lastOfMonth);
  const weeks: string[] = [];
  let cursor = firstMonday;
  while (cursor <= lastMonday) {
    weeks.push(cursor);
    cursor = addDaysIso(cursor, 7);
  }
  return weeks;
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
      const weekStarts = weeksOfMonthLocal(year, month).slice(0, MAX_MONTH_WEEKS);
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

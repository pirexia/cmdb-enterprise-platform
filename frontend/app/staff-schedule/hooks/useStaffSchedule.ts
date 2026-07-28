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

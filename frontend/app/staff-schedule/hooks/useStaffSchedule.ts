"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/apiFetch";
import type {
  Department,
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

  const clone = useCallback(async () => {
    if (!scheduleId) return;
    const res = await apiFetch(`/api/staff-schedule/${scheduleId}/clone`, { method: "POST" });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? `Status ${res.status}`);
    }
  }, [scheduleId]);

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

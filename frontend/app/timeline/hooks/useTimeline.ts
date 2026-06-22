"use client";
import { useState, useEffect, useRef, useCallback } from "react";
import { apiFetch } from "@/lib/apiFetch";
import { TimelineItem, TimelineFiltersState, TimelineFiltersData, TimelineLegacyDates } from "../types/timeline";

interface TimelineData {
  total: number;
  data: TimelineItem[];
}

export function useTimeline(filters: TimelineFiltersState, enabled: boolean) {
  const [items, setItems] = useState<TimelineItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const fetchItems = useCallback(async () => {
    if (!enabled) return;
    if (abortRef.current) abortRef.current.abort();
    abortRef.current = new AbortController();

    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (filters.types.length) params.set("types", filters.types.join(","));
      if (filters.ciTypeId)      params.set("ciTypeId", filters.ciTypeId);
      if (filters.status.length) params.set("status", filters.status.join(","));
      if (filters.dateTypes.length) params.set("dateTypes", filters.dateTypes.join(","));
      if (filters.search)        params.set("search", filters.search);
      params.set("limit", "500");

      const res = await apiFetch(`/api/timeline/items?${params}`, {
        signal: abortRef.current.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d: TimelineData = await res.json();
      setItems(d.data);
      setTotal(d.total);
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") return;
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [filters, enabled]);

  useEffect(() => { fetchItems(); }, [fetchItems]);

  return { items, total, loading, error, refetch: fetchItems };
}

export function useTimelineFiltersData() {
  const [data, setData] = useState<TimelineFiltersData | null>(null);

  useEffect(() => {
    apiFetch("/api/timeline/filters")
      .then(r => r.json())
      .then(setData)
      .catch(() => {});
  }, []);

  return data;
}

export function useLegacyDates(ciId: string | null) {
  const [legacy, setLegacy] = useState<TimelineLegacyDates | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!ciId) { setLegacy(null); return; }
    setLoading(true);
    apiFetch(`/api/timeline/legacy/${ciId}`)
      .then(r => r.json())
      .then(setLegacy)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [ciId]);

  return { legacy, loading };
}

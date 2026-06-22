"use client";
import { useState, useEffect, useRef, useCallback } from "react";
import { apiFetch } from "@/lib/apiFetch";
import { TimelineItem, TimelineFiltersState, TimelineFiltersData, TimelineLegacyDates, TimelineLegacyChild } from "../types/timeline";

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

/**
 * Fetches and caches the inherited/related dates (children) of every expanded CI.
 * Each ciId is fetched at most once; results are kept in a map keyed by ciId.
 */
export function useLegacyDatesMap(expandedIds: Set<string>) {
  const [legacyMap, setLegacyMap] = useState<Record<string, TimelineLegacyChild[]>>({});
  const [loadingIds, setLoadingIds] = useState<Set<string>>(new Set());
  const inFlight = useRef<Set<string>>(new Set());

  useEffect(() => {
    const toLoad = [...expandedIds].filter(
      id => legacyMap[id] === undefined && !inFlight.current.has(id),
    );
    if (toLoad.length === 0) return;

    toLoad.forEach(id => inFlight.current.add(id));
    setLoadingIds(prev => {
      const next = new Set(prev);
      toLoad.forEach(id => next.add(id));
      return next;
    });

    toLoad.forEach(async id => {
      try {
        const res = await apiFetch(`/api/timeline/legacy/${id}`);
        const data: TimelineLegacyDates = await res.json();
        setLegacyMap(prev => ({ ...prev, [id]: data.children ?? [] }));
      } catch {
        setLegacyMap(prev => ({ ...prev, [id]: [] }));
      } finally {
        inFlight.current.delete(id);
        setLoadingIds(prev => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    });
  }, [expandedIds, legacyMap]);

  return { legacyMap, loadingIds };
}

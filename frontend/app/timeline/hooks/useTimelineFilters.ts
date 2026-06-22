"use client";
import { useState, useCallback, useEffect } from "react";
import { TimelineFiltersState, DEFAULT_FILTERS } from "../types/timeline";

const LS_KEY = "timeline-filters";

function loadSaved(): TimelineFiltersState {
  if (typeof window === "undefined") return DEFAULT_FILTERS;
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return DEFAULT_FILTERS;
    return { ...DEFAULT_FILTERS, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_FILTERS;
  }
}

export function useTimelineFilters() {
  const [filters, setFilters] = useState<TimelineFiltersState>(DEFAULT_FILTERS);
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    setFilters(loadSaved());
    setInitialized(true);
  }, []);

  const updateFilters = useCallback((patch: Partial<TimelineFiltersState>) => {
    setFilters(prev => {
      const next = { ...prev, ...patch };
      try {
        localStorage.setItem(LS_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  }, []);

  const clearFilters = useCallback(() => {
    try { localStorage.removeItem(LS_KEY); } catch {}
    setFilters(DEFAULT_FILTERS);
  }, []);

  return { filters, updateFilters, clearFilters, initialized };
}

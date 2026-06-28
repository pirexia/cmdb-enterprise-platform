"use client";
import { useState, useCallback } from "react";
import { apiFetch } from "@/lib/apiFetch";
import type { ReportDataResponse, ReportFilters } from "../types/report";

export function useReportData(reportId: string) {
  const [data, setData]       = useState<ReportDataResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState<string | null>(null);

  const fetch = useCallback(async (filters: ReportFilters) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      Object.entries(filters).forEach(([k, v]) => {
        if (v !== undefined && v !== null && v !== '') {
          if (Array.isArray(v)) {
            v.forEach((item) => params.append(k, String(item)));
          } else {
            params.set(k, String(v));
          }
        }
      });
      const res = await apiFetch(`/api/reports/${reportId}/data?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json() as ReportDataResponse;
      setData(json);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [reportId]);

  return { data, loading, error, fetch };
}

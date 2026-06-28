"use client";
import { useState, useEffect } from "react";
import { apiFetch } from "@/lib/apiFetch";
import type { ReportMeta } from "../types/report";

export function useReports() {
  const [reports, setReports]   = useState<ReportMeta[]>([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiFetch("/api/reports")
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled) {
          setReports(d.reports ?? []);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError(String(e));
          setLoading(false);
        }
      });
    return () => { cancelled = true; };
  }, []);

  return { reports, loading, error };
}

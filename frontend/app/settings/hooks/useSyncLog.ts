"use client";
import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/apiFetch";
import type { SyncLogEntry } from "../types/vcenter";

export function useSyncLog() {
  const [log,     setLog]     = useState<SyncLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);

  const fetchLog = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    apiFetch("/api/integrations/vcenter/sync-log")
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled) {
          setLog(Array.isArray(d) ? d : []);
          setError(null);
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

  useEffect(() => {
    const cancel = fetchLog();
    return cancel;
  }, [fetchLog]);

  return { log, loading, error, refetch: fetchLog };
}

"use client";
import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/apiFetch";
import type { VCenterStatus } from "../types/vcenter";

export function useVCenterStatus() {
  const [status,  setStatus]  = useState<VCenterStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);

  const fetchStatus = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    apiFetch("/api/integrations/vcenter/status")
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled) {
          setStatus(d ?? null);
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
    const cancel = fetchStatus();
    return cancel;
  }, [fetchStatus]);

  return { status, loading, error, refetch: fetchStatus };
}

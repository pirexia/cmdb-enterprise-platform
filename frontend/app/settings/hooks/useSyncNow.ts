"use client";
import { useState } from "react";
import { apiFetch } from "@/lib/apiFetch";
import type { SyncResult, ApiErrorBody } from "../types/vcenter";

export function useSyncNow() {
  const [syncing, setSyncing] = useState(false);
  const [result,  setResult]  = useState<SyncResult | ApiErrorBody | null>(null);

  const syncNow = async () => {
    setSyncing(true);
    try {
      const r = await apiFetch("/api/integrations/vcenter/sync", { method: "POST" });
      const body = await r.json();
      setResult(body);
    } catch (e) {
      setResult({ error: String(e) });
    } finally {
      setSyncing(false);
    }
  };

  return { syncing, result, syncNow };
}

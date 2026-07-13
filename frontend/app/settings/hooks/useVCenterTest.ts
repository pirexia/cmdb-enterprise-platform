"use client";
import { useState } from "react";
import { apiFetch } from "@/lib/apiFetch";
import type { TestResult, ApiErrorBody } from "../types/vcenter";

export function useVCenterTest() {
  const [testing, setTesting] = useState(false);
  const [result,  setResult]  = useState<TestResult | ApiErrorBody | null>(null);

  const testConnection = async () => {
    setTesting(true);
    try {
      const r = await apiFetch("/api/integrations/vcenter/test", { method: "POST" });
      const body = await r.json();
      setResult(body);
    } catch (e) {
      setResult({ error: String(e) });
    } finally {
      setTesting(false);
    }
  };

  return { testing, result, testConnection };
}

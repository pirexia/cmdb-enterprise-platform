"use client";

import { useEffect, useRef } from "react";
import { Printer } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { apiFetch } from "@/lib/apiFetch";

export type PrintScope = "DEPARTMENT_WEEK" | "DEPARTMENT_MONTH" | "WORKER";

interface Props {
  scope: PrintScope;
  targetId: string;
  from?: string;
  to?: string;
}

/**
 * Print button for the three Staff Schedule print-capable views
 * (department-week, department-month, worker). Renders `.no-print` so the
 * button itself never appears in the printed/PDF output.
 *
 * Audit logging (ISO 27001 A.8.15, spec R7): printing is an export of
 * personal data to a medium outside the system, so every print fires a
 * fire-and-forget POST to /api/staff-schedule/audit/print. Per decision D7,
 * this must never block or delay window.print(), and a failure (network
 * error, or the endpoint not existing yet in an environment where the B4
 * backend task hasn't landed) is only logged to the console — the data is
 * already visible on screen, so refusing to print over a logging failure
 * would protect nothing.
 *
 * Implementation note on `beforeprint` vs. a direct call: `window.print()`
 * synchronously opens the browser's native print dialog, which blocks the
 * JS event loop until the user dismisses it. That means a fetch queued
 * "before" the call in the same tick has already left the network layer by
 * the time the dialog blocks, so a direct call immediately before
 * `window.print()` is observably equivalent to wiring through the
 * `beforeprint` event for THIS button's own click path. We still register
 * `beforeprint` (not just the click handler) because that event also fires
 * for the browser's native Ctrl+P / File > Print — which this button has no
 * other way to intercept — so relying on it is what makes the audit log
 * capture printing regardless of how it was triggered, per the spec's
 * "se invoca en onbeforeprint" wording.
 */
export default function PrintButton({ scope, targetId, from, to }: Props) {
  const { t } = useLanguage();

  // Keep the latest print-request params in a ref so the beforeprint
  // listener (registered once) always reads current props without having
  // to re-subscribe on every prop change.
  const paramsRef = useRef({ scope, targetId, from, to });
  paramsRef.current = { scope, targetId, from, to };

  useEffect(() => {
    const handleBeforePrint = () => {
      const { scope, targetId, from, to } = paramsRef.current;
      // Fire-and-forget: intentionally not awaited, no UI feedback on
      // failure beyond a console warning (D7).
      apiFetch("/api/staff-schedule/audit/print", {
        method: "POST",
        body: JSON.stringify({ scope, targetId, from, to }),
      })
        .then((res) => {
          // A non-2xx (e.g. 404 if the B4 backend endpoint hasn't been
          // deployed yet in this environment) resolves rather than
          // rejects — log it too, but still never block printing on it.
          if (!res.ok) {
            console.warn(`staff-schedule print audit ping returned ${res.status} (non-blocking)`);
          }
        })
        .catch((err) => {
          console.warn("staff-schedule print audit ping failed (non-blocking)", err);
        });
    };

    window.addEventListener("beforeprint", handleBeforePrint);
    return () => window.removeEventListener("beforeprint", handleBeforePrint);
  }, []);

  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="no-print rounded-none border border-slate-300 bg-white px-3 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-50 flex items-center gap-1.5"
    >
      <Printer size={16} />
      {t("staffSchedule.print.button")}
    </button>
  );
}

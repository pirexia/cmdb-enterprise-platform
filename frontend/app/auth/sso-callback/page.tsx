"use client";

/**
 * SSO Callback Page — /auth/sso-callback
 *
 * Receives a one-time exchange `code` from the backend after a successful
 * Microsoft SSO flow. Calls GET /api/auth/sso/exchange?code=<code> to
 * retrieve the real JWT and user object (tokens are never passed in the URL).
 * Stores credentials in localStorage (same keys as regular login) and
 * navigates to the dashboard. On failure, redirects to /login with an error.
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "";

export default function SsoCallbackPage() {
  const router = useRouter();
  const { t } = useLanguage();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");

    // Clear the code from the URL immediately — it's single-use and short-lived
    window.history.replaceState({}, document.title, window.location.pathname);

    if (!code) {
      setError("no_code");
      router.replace("/login?error=sso_failed");
      return;
    }

    // Exchange the one-time code for real credentials
    fetch(`${API_BASE}/api/auth/sso/exchange?code=${encodeURIComponent(code)}`, {
      credentials: "include",
    })
      .then(async (res) => {
        if (!res.ok) throw new Error("Exchange failed");
        return res.json() as Promise<{
          token: string;
          deviceToken: string;
          user: { id: string; username: string; email: string; role: string; mfa_enabled: boolean };
        }>;
      })
      .then(({ token, deviceToken, user }) => {
        // Token is now in an HttpOnly cookie set by the backend exchange endpoint.
        // Only store user JSON (with exp extracted from token) for UI state.
        let exp: number | undefined;
        try {
          const parts = token.split(".");
          if (parts.length === 3) {
            const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"))) as { exp?: number };
            exp = typeof payload.exp === "number" ? payload.exp : undefined;
          }
        } catch { /* ignore */ }
        localStorage.setItem("cmdb_user", JSON.stringify({ ...user, ...(exp ? { exp } : {}) }));
        if (deviceToken) {
          localStorage.setItem("cmdb_device_token", deviceToken);
        }
        router.replace("/");
      })
      .catch(() => {
        setError("exchange_failed");
        router.replace("/login?error=sso_failed");
      });
  }, [router]);

  if (error) return null;

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50">
      <div className="flex flex-col items-center gap-3 text-slate-500">
        <Loader2 className="h-8 w-8 animate-spin text-indigo-600" />
        <p className="text-sm">{t("auth.completing_signin")}</p>
      </div>
    </div>
  );
}

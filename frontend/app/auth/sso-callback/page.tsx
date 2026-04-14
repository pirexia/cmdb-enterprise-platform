"use client";

/**
 * SSO Callback Page — /auth/sso-callback
 *
 * Receives the JWT and device token from the backend after a successful
 * Microsoft SSO flow. Stores credentials in localStorage (same as regular
 * login), clears the token from the URL (security), and navigates to the
 * dashboard. On failure, redirects to /login with an error flag.
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

export default function SsoCallbackPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token       = params.get("token");
    const deviceToken = params.get("deviceToken");
    const userStr     = params.get("user");

    // Clear sensitive data from the URL immediately
    window.history.replaceState({}, document.title, window.location.pathname);

    if (!token || !userStr) {
      setError("no_token");
      router.replace("/login?error=sso_failed");
      return;
    }

    try {
      const user = JSON.parse(decodeURIComponent(userStr));
      localStorage.setItem("token", token);
      localStorage.setItem("user", JSON.stringify(user));
      if (deviceToken) {
        localStorage.setItem("deviceToken", deviceToken);
      }
      // Navigate to dashboard
      router.replace("/");
    } catch {
      router.replace("/login?error=sso_failed");
    }
  }, [router]);

  if (error) return null;

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50">
      <div className="flex flex-col items-center gap-3 text-slate-500">
        <Loader2 className="h-8 w-8 animate-spin text-indigo-600" />
        <p className="text-sm">Completing sign-in…</p>
      </div>
    </div>
  );
}

"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { apiFetch } from "@/lib/apiFetch";

// ─── Types ────────────────────────────────────────────────────────────────────

export type UserRole = "ADMIN" | "AUDITOR" | "VIEWER";

export interface AuthUser {
  id:          string;
  username:    string;
  email:       string;
  role:        UserRole;
  mfa_enabled: boolean;
  exp?:        number; // JWT expiry as Unix timestamp — stored for client-side session management
}

export interface LoginOptions {
  mfaCode?:    string;
  trustDevice?: boolean;
}

interface AuthContextType {
  user:         AuthUser | null;
  loading:      boolean;
  isAdmin:      boolean;
  login:        (email: string, password: string, options?: LoginOptions) => Promise<void>;
  logout:       () => void;
  applySession: (token: string | null, user: AuthUser, deviceToken?: string) => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Returns true when the stored session exp has passed (with 30s buffer). */
function isUserExpired(u: AuthUser): boolean {
  if (typeof u.exp !== "number") return false;
  return Math.floor(Date.now() / 1000) >= u.exp - 30;
}

// ─── Context ──────────────────────────────────────────────────────────────────

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user,    setUser]    = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  /** Clear all session data from state and localStorage. */
  const clearSession = useCallback(() => {
    localStorage.removeItem("cmdb_user");
    // cmdb_device_token intentionally retained (trusted device persists across sessions)
    setUser(null);
  }, []);

  // Rehydrate from localStorage on first mount, validating the session exp.
  useEffect(() => {
    try {
      const storedUser = localStorage.getItem("cmdb_user");
      if (storedUser) {
        const parsed = JSON.parse(storedUser) as AuthUser;
        if (isUserExpired(parsed)) {
          localStorage.removeItem("cmdb_user");
        } else {
          setUser(parsed);
        }
      }
    } catch {
      localStorage.removeItem("cmdb_user");
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Periodic expiry check (every 60 seconds) + visibility-change check.
   */
  useEffect(() => {
    const checkExpiry = () => {
      setUser(prev => {
        if (prev && isUserExpired(prev)) {
          clearSession();
          return null;
        }
        return prev;
      });
    };
    const intervalId = setInterval(checkExpiry, 60_000);
    document.addEventListener("visibilitychange", checkExpiry);
    return () => {
      clearInterval(intervalId);
      document.removeEventListener("visibilitychange", checkExpiry);
    };
  }, [clearSession]);

  /**
   * Apply session: extracts exp from token (for client-side expiry tracking),
   * stores user+exp in localStorage. Token goes to HttpOnly cookie automatically.
   */
  const applySession = useCallback((token: string | null, newUser: AuthUser, deviceToken?: string) => {
    let exp: number | undefined;
    if (token) {
      try {
        const parts = token.split(".");
        if (parts.length === 3) {
          const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"))) as { exp?: number };
          exp = typeof payload.exp === "number" ? payload.exp : undefined;
        }
      } catch { /* ignore */ }
    }
    if (exp && Math.floor(Date.now() / 1000) >= exp - 30) {
      throw new Error("Cannot apply an already-expired session token.");
    }
    const userWithExp: AuthUser = { ...newUser, ...(exp ? { exp } : {}) };
    localStorage.setItem("cmdb_user", JSON.stringify(userWithExp));
    if (deviceToken) localStorage.setItem("cmdb_device_token", deviceToken);
    setUser(userWithExp);
  }, []);

  /**
   * Login: cookie set by backend on successful auth.
   * Throws action strings for MFA flows; throws error strings for failures.
   */
  const login = useCallback(async (email: string, password: string, options: LoginOptions = {}) => {
    const storedDeviceToken = localStorage.getItem("cmdb_device_token");

    const res = await apiFetch("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({
        email,
        password,
        mfaCode:     options.mfaCode,
        trustDevice: options.trustDevice,
        deviceToken: storedDeviceToken ?? undefined,
      }),
    });

    const data = await res.json() as {
      token?: string;
      user?: AuthUser;
      requireAction?: string;
      deviceToken?: string;
      error?: string;
    };

    if (!res.ok) {
      throw new Error(data.error ?? `Login failed (${res.status})`);
    }

    if (!data.user) {
      throw new Error("Respuesta inesperada del servidor");
    }

    // MFA_SETUP_REQUIRED: the backend issued a limited 15-min token (HttpOnly cookie only).
    // Do NOT call applySession — that would mark the admin as fully authenticated in
    // localStorage, causing AppShell to redirect them away from the setup wizard.
    // The cookie alone is enough for the /api/auth/mfa/* endpoints to work.
    if (data.requireAction === 'MFA_SETUP_REQUIRED') {
      throw new Error(data.requireAction);
    }

    // For all other outcomes (full token or MFA_SETUP_SUGGESTED) establish the session.
    applySession(data.token ?? null, data.user, data.deviceToken);

    if (data.requireAction) {
      throw new Error(data.requireAction);
    }
  }, [applySession]);

  const logout = useCallback(() => {
    apiFetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    clearSession();
  }, [clearSession]);

  return (
    <AuthContext.Provider value={{
      user,
      loading,
      isAdmin: user?.role === "ADMIN",
      login,
      logout,
      applySession,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextType {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}

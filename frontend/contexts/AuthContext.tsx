"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { apiFetch } from "@/lib/apiFetch";

// ─── JWT helpers (no external library – pure base64 decode) ──────────────────

/**
 * Decode the payload segment of a JWT without verifying the signature.
 * Signature verification is the server's responsibility; here we only need
 * the `exp` claim so we can avoid sending a visibly-expired token.
 *
 * Returns `null` when the token is malformed.
 */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    // Base64url → Base64 → binary string → JSON
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    // atob is available in every modern browser and in Node 16+
    const jsonStr = atob(base64);
    return JSON.parse(jsonStr) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Returns `true` when the JWT has an `exp` claim whose value is in the past.
 * Tokens without an `exp` claim are treated as non-expired (the server will
 * reject them if they are actually invalid).
 *
 * @param bufferSeconds - Treat the token as expired this many seconds before
 *   the real `exp` to account for clock skew and network latency (default 30 s).
 */
export function isJwtExpired(token: string, bufferSeconds = 30): boolean {
  const payload = decodeJwtPayload(token);
  if (!payload) return true; // malformed → treat as expired

  const exp = payload["exp"];
  if (typeof exp !== "number") return false; // no expiry claim → not expired

  const nowSeconds = Math.floor(Date.now() / 1000);
  return nowSeconds >= exp - bufferSeconds;
}

// ─── Types ────────────────────────────────────────────────────────────────────

export type UserRole = "ADMIN" | "AUDITOR" | "VIEWER";

export interface AuthUser {
  id:          string;
  username:    string;
  email:       string;
  role:        UserRole;
  mfa_enabled: boolean;
}

export interface LoginOptions {
  mfaCode?:    string;
  trustDevice?: boolean;
}

interface AuthContextType {
  user:         AuthUser | null;
  token:        string | null;
  loading:      boolean;
  isAdmin:      boolean;
  login:        (email: string, password: string, options?: LoginOptions) => Promise<void>;
  logout:       () => void;
  applySession: (token: string, user: AuthUser, deviceToken?: string) => void;
}

// ─── Context ──────────────────────────────────────────────────────────────────

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user,    setUser]    = useState<AuthUser | null>(null);
  const [token,   setToken]   = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  /** Clear all session data from state and localStorage. */
  const clearSession = useCallback(() => {
    localStorage.removeItem("cmdb_token");
    localStorage.removeItem("cmdb_user");
    setToken(null);
    setUser(null);
  }, []);

  // Rehydrate from localStorage on first mount, validating the token's expiry.
  useEffect(() => {
    try {
      const storedToken = localStorage.getItem("cmdb_token");
      const storedUser  = localStorage.getItem("cmdb_user");

      if (storedToken && storedUser) {
        if (isJwtExpired(storedToken)) {
          // Expired token – discard immediately so the user is sent to login.
          localStorage.removeItem("cmdb_token");
          localStorage.removeItem("cmdb_user");
        } else {
          setToken(storedToken);
          setUser(JSON.parse(storedUser) as AuthUser);
        }
      }
    } catch {
      localStorage.removeItem("cmdb_token");
      localStorage.removeItem("cmdb_user");
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Periodic expiry check (every 60 seconds) + visibility-change check.
   *
   * This ensures that a long-lived tab whose token expires while the user is
   * idle gets signed out automatically rather than silently sending stale
   * Bearer tokens to the backend.
   */
  useEffect(() => {
    const checkExpiry = () => {
      const storedToken = localStorage.getItem("cmdb_token");
      if (storedToken && isJwtExpired(storedToken)) {
        clearSession();
      }
    };

    const intervalId = setInterval(checkExpiry, 60_000); // every 60 s
    document.addEventListener("visibilitychange", checkExpiry);

    return () => {
      clearInterval(intervalId);
      document.removeEventListener("visibilitychange", checkExpiry);
    };
  }, [clearSession]);

  /**
   * Apply a token + user directly (used after MFA setup flow completes
   * to replace a limited setup-token with a full session token).
   */
  const applySession = useCallback((newToken: string, newUser: AuthUser, deviceToken?: string) => {
    if (isJwtExpired(newToken)) {
      // Guard: reject a token that is already expired before we even store it.
      throw new Error("Cannot apply an already-expired session token.");
    }
    localStorage.setItem("cmdb_token", newToken);
    localStorage.setItem("cmdb_user", JSON.stringify(newUser));
    if (deviceToken) localStorage.setItem("cmdb_device_token", deviceToken);
    setToken(newToken);
    setUser(newUser);
  }, []);

  /**
   * Login:
   *  - On success (no special action): stores token, returns normally.
   *  - Throws "MFA_REQUIRED"        → caller must prompt for TOTP code.
   *  - Throws "MFA_SETUP_REQUIRED"  → admin must complete MFA setup before proceeding.
   *  - Throws "MFA_SETUP_SUGGESTED" → non-admin can optionally set up MFA.
   *  - Throws other error messages  → display as login error.
   *
   * Device token from localStorage is sent automatically so the backend can
   * skip the MFA challenge for trusted devices.
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

    if (!data.token || !data.user) {
      throw new Error("Respuesta inesperada del servidor");
    }

    // Store token and user (may be a limited token for MFA_SETUP_REQUIRED)
    localStorage.setItem("cmdb_token", data.token);
    localStorage.setItem("cmdb_user", JSON.stringify(data.user));
    setToken(data.token);
    setUser(data.user);

    // Persist trusted device token if the backend granted one
    if (data.deviceToken) {
      localStorage.setItem("cmdb_device_token", data.deviceToken);
    }

    // Signal special post-login actions to the caller
    if (data.requireAction) {
      throw new Error(data.requireAction); // "MFA_SETUP_REQUIRED" | "MFA_SETUP_SUGGESTED"
    }
  }, []);

  const logout = useCallback(() => {
    // NOTE: cmdb_device_token is intentionally NOT removed here.
    // Trusted device tokens are bound to the browser, not the session.
    // They persist across logout/login cycles until they expire server-side
    // (TTL controlled by TRUSTED_DEVICE_TTL_DAYS).
    clearSession();
  }, [clearSession]);

  return (
    <AuthContext.Provider value={{
      user,
      token,
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

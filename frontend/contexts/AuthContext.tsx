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

export type UserRole = "ADMIN" | "VIEWER";

export interface AuthUser {
  id:       string;
  username: string;
  email:    string;
  role:     UserRole;
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

  // Rehydrate from localStorage on first mount
  useEffect(() => {
    try {
      const storedToken = localStorage.getItem("cmdb_token");
      const storedUser  = localStorage.getItem("cmdb_user");
      if (storedToken && storedUser) {
        setToken(storedToken);
        setUser(JSON.parse(storedUser) as AuthUser);
      }
    } catch {
      localStorage.removeItem("cmdb_token");
      localStorage.removeItem("cmdb_user");
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Apply a token + user directly (used after MFA setup flow completes
   * to replace a limited setup-token with a full session token).
   */
  const applySession = useCallback((newToken: string, newUser: AuthUser, deviceToken?: string) => {
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
    localStorage.removeItem("cmdb_token");
    localStorage.removeItem("cmdb_user");
    localStorage.removeItem("cmdb_device_token");
    setToken(null);
    setUser(null);
  }, []);

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

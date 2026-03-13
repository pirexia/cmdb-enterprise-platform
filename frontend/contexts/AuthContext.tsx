"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";

// ─── Types ────────────────────────────────────────────────────────────────────

export type UserRole = "ADMIN" | "VIEWER";

export interface AuthUser {
  id:       string;
  username: string;
  email:    string;
  role:     UserRole;
}

interface AuthContextType {
  user:     AuthUser | null;
  token:    string | null;
  loading:  boolean;
  isAdmin:  boolean;
  login:    (email: string, password: string) => Promise<void>;
  logout:   () => void;
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

  const login = useCallback(async (email: string, password: string) => {
    const res = await fetch("http://localhost:3000/api/auth/login", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ email, password }),
    });

    if (!res.ok) {
      const contentType = res.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) {
        const err = await res.json();
        throw new Error(err.error ?? "Login failed");
      }
      throw new Error(`Login failed (${res.status})`);
    }

    const data = await res.json() as { token: string; user: AuthUser };
    localStorage.setItem("cmdb_token", data.token);
    localStorage.setItem("cmdb_user",  JSON.stringify(data.user));
    setToken(data.token);
    setUser(data.user);
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem("cmdb_token");
    localStorage.removeItem("cmdb_user");
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

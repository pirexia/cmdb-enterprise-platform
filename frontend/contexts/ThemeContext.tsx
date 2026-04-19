"use client";

import React, { createContext, useContext, useEffect, useState } from "react";
import { apiFetch } from "@/lib/apiFetch";

interface ThemeData {
  companyName: string;
  logoUrl: string | null;
  loading: boolean;
}

const ThemeContext = createContext<ThemeData | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [companyName, setCompanyName] = useState("CMDB Platform");
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Public endpoint — safe to call before auth is established
    apiFetch("/api/settings/theme")
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { sidebarBg: string; accentColor: string; companyName: string; hasLogo: boolean } | null) => {
        if (!data) return;
        setCompanyName(data.companyName);
        setLogoUrl(data.hasLogo ? "/api/settings/logo" : null);

        // Validate hex colors before CSS injection to prevent CSS injection attacks
        const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
        const safeSidebarBg   = HEX_COLOR_RE.test(data.sidebarBg)   ? data.sidebarBg   : '#0f172a';
        const safeAccentColor = HEX_COLOR_RE.test(data.accentColor) ? data.accentColor : '#3b82f6';

        const style = document.getElementById("theme-vars") ?? (() => {
          const s = document.createElement("style");
          s.id = "theme-vars";
          document.head.appendChild(s);
          return s;
        })();
        style.textContent = `:root { --sidebar-bg: ${safeSidebarBg}; --accent: ${safeAccentColor}; }`;
      })
      .catch(() => { /* silently use CSS defaults */ })
      .finally(() => setLoading(false));
  }, []);

  return (
    <ThemeContext.Provider value={{ companyName, logoUrl, loading }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeData {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used inside <ThemeProvider>");
  return ctx;
}

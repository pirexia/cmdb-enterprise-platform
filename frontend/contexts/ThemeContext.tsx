"use client";

import React, { createContext, useContext, useEffect, useState } from "react";

interface ThemeData {
  companyName: string;
  logoUrl: string | null;
  loading: boolean;
}

const ThemeContext = createContext<ThemeData>({
  companyName: "CMDB Platform",
  logoUrl: null,
  loading: true,
});

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [companyName, setCompanyName] = useState("CMDB Platform");
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/settings/theme")
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { sidebarBg: string; accentColor: string; companyName: string; hasLogo: boolean } | null) => {
        if (!data) return;
        setCompanyName(data.companyName);
        setLogoUrl(data.hasLogo ? "/api/settings/logo" : null);

        const style = document.getElementById("theme-vars") ?? (() => {
          const s = document.createElement("style");
          s.id = "theme-vars";
          document.head.appendChild(s);
          return s;
        })();
        style.textContent = `:root { --sidebar-bg: ${data.sidebarBg}; --accent: ${data.accentColor}; }`;
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

export function useTheme() {
  return useContext(ThemeContext);
}

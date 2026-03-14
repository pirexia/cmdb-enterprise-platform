"use client";

import {
  createContext, useCallback, useContext,
  useEffect, useState,
} from "react";
import esDict from "@/locales/es.json";
import enDict from "@/locales/en.json";

// ─── Types ────────────────────────────────────────────────────────────────────

export type Locale = "es" | "en";

type DeepDict = { [k: string]: string | DeepDict };

const DICTS: Record<Locale, DeepDict> = { es: esDict, en: enDict };

const STORAGE_KEY = "cmdb_locale";

// ─── Context ──────────────────────────────────────────────────────────────────

interface LanguageContextType {
  locale:    Locale;
  setLocale: (l: Locale) => void;
  /** Translate a dot-separated key, e.g. t('sidebar.dashboard') */
  t: (key: string, vars?: Record<string, string | number>) => string;
}

const LanguageContext = createContext<LanguageContextType | null>(null);

// ─── Provider ─────────────────────────────────────────────────────────────────

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>("es");

  // Hydrate from localStorage (or browser language) on mount
  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY) as Locale | null;
    if (stored === "es" || stored === "en") {
      setLocaleState(stored);
    } else {
      // Infer from browser language
      const browser = navigator.language.split("-")[0];
      setLocaleState(browser === "en" ? "en" : "es");
    }
  }, []);

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
    localStorage.setItem(STORAGE_KEY, l);
  }, []);

  const t = useCallback(
    (key: string, vars?: Record<string, string | number>): string => {
      const parts = key.split(".");
      let node: string | DeepDict = DICTS[locale];
      for (const part of parts) {
        if (typeof node !== "object") return key;
        node = node[part];
        if (node === undefined) return key;
      }
      if (typeof node !== "string") return key;
      // Variable interpolation: {year}, {name}, etc.
      if (vars) {
        return Object.entries(vars).reduce(
          (str, [k, v]) => str.replace(`{${k}}`, String(v)),
          node
        );
      }
      return node;
    },
    [locale]
  );

  return (
    <LanguageContext.Provider value={{ locale, setLocale, t }}>
      {children}
    </LanguageContext.Provider>
  );
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useLanguage(): LanguageContextType {
  const ctx = useContext(LanguageContext);
  if (!ctx) throw new Error("useLanguage must be used inside <LanguageProvider>");
  return ctx;
}

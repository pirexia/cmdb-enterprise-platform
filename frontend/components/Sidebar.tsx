"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard, Monitor, FileText, Building2, Settings,
  Server, Network, User, LogOut, Plug, Shield, BarChart,
  ClipboardList, UserCircle,
} from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { useLanguage } from "@/contexts/LanguageContext";
import type { Locale } from "@/contexts/LanguageContext";

// ─── Nav item definitions (keys reference locales/[lang].json) ────────────────

const NAV_ITEMS = [
  { labelKey: "sidebar.dashboard",       href: "/",               icon: LayoutDashboard, adminOnly: false },
  { labelKey: "sidebar.inventory",       href: "/inventory",      icon: Monitor,         adminOnly: false },
  { labelKey: "sidebar.vulnerabilities", href: "/vulnerabilities", icon: Shield,          adminOnly: false },
  { labelKey: "sidebar.map",             href: "/map",            icon: Network,         adminOnly: false },
  { labelKey: "sidebar.integrations",   href: "/integrations",   icon: Plug,            adminOnly: true  },
  { labelKey: "sidebar.reports",        href: "/reports",        icon: BarChart,        adminOnly: false },
  { labelKey: "sidebar.contracts",      href: "/contracts",      icon: FileText,        adminOnly: false },
  { labelKey: "sidebar.entities",       href: "/entities",       icon: Building2,       adminOnly: false },
  { labelKey: "sidebar.profile",        href: "/profile",        icon: UserCircle,      adminOnly: false },
  { labelKey: "sidebar.audit",          href: "/audit",          icon: ClipboardList,   adminOnly: true  },
  { labelKey: "sidebar.settings",       href: "/settings",       icon: Settings,        adminOnly: true  },
];

// ─── Language selector ────────────────────────────────────────────────────────

function LangSelector() {
  const { locale, setLocale } = useLanguage();
  return (
    <div className="flex items-center gap-1">
      {(["es", "en"] as Locale[]).map((l) => (
        <button
          key={l}
          onClick={() => setLocale(l)}
          className={`rounded px-2 py-0.5 text-[11px] font-bold uppercase transition-colors ${
            locale === l
              ? "bg-indigo-600 text-white"
              : "text-slate-400 hover:text-slate-600 hover:bg-slate-100"
          }`}
        >
          {l}
        </button>
      ))}
    </div>
  );
}

// ─── Sidebar ──────────────────────────────────────────────────────────────────

export default function Sidebar() {
  const pathname               = usePathname();
  const { user, logout, isAdmin } = useAuth();
  const { t }                  = useLanguage();

  return (
    <aside className="flex h-screen w-64 flex-shrink-0 flex-col border-r border-slate-200 bg-white">
      {/* Brand */}
      <div className="flex items-center gap-2.5 border-b border-slate-200 px-5 py-4">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600">
          <Server className="h-4 w-4 text-white" />
        </div>
        <div className="leading-tight">
          <p className="text-sm font-bold text-slate-900">{t("brand.name")}</p>
          <p className="text-[10px] text-slate-400 uppercase tracking-wider">
            {t("brand.tagline")}
          </p>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-0.5">
        {NAV_ITEMS.filter(({ adminOnly }) => !adminOnly || isAdmin).map(({ labelKey, href, icon: Icon }) => {
          const isActive = href === "/" ? pathname === "/" : pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
                isActive
                  ? "bg-indigo-50 text-indigo-700"
                  : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
              }`}
            >
              <Icon className={`h-4 w-4 flex-shrink-0 ${isActive ? "text-indigo-600" : "text-slate-400"}`} />
              {t(labelKey)}
            </Link>
          );
        })}
      </nav>

      {/* User info + logout + language */}
      <div className="border-t border-slate-200 px-4 py-3 space-y-2">
        {user && (
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-indigo-100">
              <User className="h-4 w-4 text-indigo-600" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold text-slate-700 truncate">{user.username}</p>
              <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold ${isAdmin ? "bg-red-100 text-red-700" : "bg-slate-100 text-slate-500"}`}>
                {user.role}
              </span>
            </div>
            <button
              onClick={logout}
              title={t("actions.logout")}
              className="flex-shrink-0 rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-colors"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        )}

        {/* Language selector + copyright */}
        <div className="flex items-center justify-between">
          <p className="text-[10px] text-slate-400">
            {t("footer.copyright", { year: new Date().getFullYear() })}
          </p>
          <LangSelector />
        </div>
      </div>
    </aside>
  );
}

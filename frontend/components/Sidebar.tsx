"use client";

import React, { useState, useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard, Monitor, FileText, Building2, Settings,
  Server, Network, User, LogOut, Plug, Shield, BarChart,
  ClipboardList, UserCircle, FolderOpen, Key, Sparkles, Puzzle,
  PowerOff, CalendarClock, CalendarDays,
} from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { useLanguage, LOCALE_NAMES } from "@/contexts/LanguageContext";
import { useTheme } from "@/contexts/ThemeContext";
import type { Locale } from "@/contexts/LanguageContext";

type NavLink = { type: "link"; labelKey: string; href: string; icon: React.ElementType; roles?: string[] };
type NavSeparator = { type: "separator" };
type NavEntry = NavLink | NavSeparator;

const SEP: NavSeparator = { type: "separator" };

const NAV_ITEMS: NavEntry[] = [
  { type: "link", labelKey: "sidebar.profile",         href: "/profile",        icon: UserCircle                                },
  SEP,
  { type: "link", labelKey: "sidebar.dashboard",       href: "/",               icon: LayoutDashboard                           },
  { type: "link", labelKey: "sidebar.inventory",       href: "/inventory",      icon: Monitor                                   },
  { type: "link", labelKey: "sidebar.contracts",       href: "/contracts",      icon: FileText                                  },
  { type: "link", labelKey: "sidebar.licenses",        href: "/licenses",       icon: Key                                       },
  { type: "link", labelKey: "sidebar.map",             href: "/map",            icon: Network                                   },
  { type: "link", labelKey: "sidebar.timeline",        href: "/timeline",       icon: CalendarClock                             },
  { type: "link", labelKey: "sidebar.documents",       href: "/documents",      icon: FolderOpen                                },
  { type: "link", labelKey: "sidebar.assistant",       href: "/chat",           icon: Sparkles                                  },
  { type: "link", labelKey: "sidebar.vulnerabilities", href: "/vulnerabilities", icon: Shield                                   },
  { type: "link", labelKey: "sidebar.reports",         href: "/reports",        icon: BarChart                                  },
  SEP,
  { type: "link", labelKey: "sidebar.staffSchedule",    href: "/staff-schedule", icon: CalendarDays, roles: ["ADMIN","AUDITOR","MANAGER"]  },
  { type: "link", labelKey: "sidebar.dcim",             href: "/dcim",           icon: Server,       roles: ["ADMIN","AUDITOR"]  },
  { type: "link", labelKey: "sidebar.decommission",     href: "/decommission",   icon: PowerOff,     roles: ["ADMIN","AUDITOR"]  },
  { type: "link", labelKey: "sidebar.integrations",    href: "/integrations",   icon: Plug,         roles: ["ADMIN"]            },
  { type: "link", labelKey: "sidebar.masters",         href: "/admin/masters",  icon: Building2,    roles: ["ADMIN"]            },
  { type: "link", labelKey: "sidebar.audit",           href: "/audit",          icon: ClipboardList, roles: ["ADMIN","AUDITOR"] },
  { type: "link", labelKey: "sidebar.settings",        href: "/settings",       icon: Settings,     roles: ["ADMIN"]            },
  { type: "link", labelKey: "sidebar.plugins",         href: "/plugins/admin",  icon: Puzzle,       roles: ["ADMIN"]            },
];

function LangSelector() {
  const { locale, setLocale } = useLanguage();
  return (
    <select
      value={locale}
      onChange={(e) => setLocale(e.target.value as Locale)}
      className="border border-white/10 bg-white/5 px-1.5 py-0.5 text-[11px] text-slate-400 focus:border-[var(--accent)] focus:outline-none cursor-pointer"
    >
      {(Object.entries(LOCALE_NAMES) as [Locale, string][]).map(([code, name]) => (
        <option key={code} value={code} className="bg-slate-900 text-slate-300">{name}</option>
      ))}
    </select>
  );
}

interface SidebarProps {
  onClose?: () => void;
}

export default function Sidebar({ onClose }: SidebarProps) {
  const pathname               = usePathname();
  const { user, logout }       = useAuth();
  const userRole               = user?.role ?? "";
  const { t }                  = useLanguage();
  const { companyName, logoUrl } = useTheme();
  const [appVersion, setAppVersion] = useState<{ version: string; commit?: string } | null>(null);

  useEffect(() => {
    fetch('/version.json')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.version) setAppVersion({ version: d.version, commit: d.commit }); })
      .catch(() => {});
  }, []);

  const visible = NAV_ITEMS.filter(
    (item) => item.type === "separator" || !item.roles || item.roles.includes(userRole)
  );
  const clean = visible.filter((item, i, arr) => {
    if (item.type !== "separator") return true;
    const prev = arr[i - 1];
    const next = arr[i + 1];
    return prev && prev.type !== "separator" && next && next.type !== "separator";
  });

  return (
    <aside
      className="flex h-screen w-64 flex-shrink-0 flex-col"
      style={{ backgroundColor: "var(--sidebar-bg)" }}
    >
      {/* Brand */}
      <div className="flex items-center gap-2.5 border-b border-white/8 px-5 py-4">
        {logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={logoUrl} alt={companyName} className="h-8 w-8 object-contain" />
        ) : (
          <div
            className="flex h-8 w-8 flex-shrink-0 items-center justify-center"
            style={{ backgroundColor: "var(--accent)" }}
          >
            <Server className="h-4 w-4 text-white" />
          </div>
        )}
        <div className="leading-tight min-w-0">
          <p className="text-sm font-bold text-slate-100 truncate">{companyName}</p>
          <p className="text-[10px] text-slate-500 uppercase tracking-wider">
            {t("brand.tagline")}
          </p>
        </div>
        {/* Mobile close button */}
        {onClose && (
          <button
            onClick={onClose}
            className="ml-auto flex-shrink-0 p-1 text-slate-500 hover:text-slate-300 md:hidden"
            aria-label="Cerrar menú"
          >
            ✕
          </button>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-0.5">
        {clean.map((item, i) => {
          if (item.type === "separator") {
            return <hr key={`sep-${i}`} className="my-2 border-white/8" />;
          }
          const { labelKey, href, icon: Icon } = item;
          const isActive = href === "/" ? pathname === "/" : pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              onClick={onClose}
              className={`flex items-center gap-3 px-3 py-2.5 text-sm font-medium transition-colors border-l-2 ${
                isActive
                  ? "border-l-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent)]"
                  : "border-l-transparent text-slate-400 hover:bg-white/5 hover:text-slate-200"
              }`}
            >
              <Icon className="h-5 w-5 flex-shrink-0" strokeWidth={1.5} />
              {t(labelKey)}
            </Link>
          );
        })}
      </nav>

      {/* User info + logout + language */}
      <div className="border-t border-white/8 px-4 py-3 space-y-2">
        {user && (
          <div className="flex items-center gap-2.5">
            <div
              className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full"
              style={{ backgroundColor: "var(--accent)", opacity: 0.2 }}
            >
              <User className="h-4 w-4" style={{ color: "var(--accent)", opacity: 1 }} />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold text-slate-300 truncate">{user.username}</p>
              <span className={`inline-block px-1.5 py-0.5 text-[10px] font-semibold ${
                user.role === "ADMIN"   ? "bg-red-900/60 text-red-300"    :
                user.role === "AUDITOR" ? "bg-amber-900/60 text-amber-300" :
                user.role === "MANAGER"  ? "bg-sky-900/60 text-sky-300"    :
                                          "bg-slate-700 text-slate-400"
              }`}>
                {user.role}
              </span>
            </div>
            <button
              onClick={logout}
              title={t("actions.logout")}
              className="flex-shrink-0 p-1.5 text-slate-500 hover:text-slate-300 transition-colors"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        )}
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[10px] text-slate-500">
              {t("footer.copyright", { year: new Date().getFullYear() })}
            </p>
            {appVersion && (
              <p className="text-[10px] text-slate-400">
                {appVersion.commit && appVersion.commit !== "unknown"
                  ? t("footer.version", { version: appVersion.version, commit: appVersion.commit })
                  : t("footer.version_short", { version: appVersion.version })}
              </p>
            )}
          </div>
          <LangSelector />
        </div>
      </div>
    </aside>
  );
}

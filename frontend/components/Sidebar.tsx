"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Monitor,
  FileText,
  Building2,
  Settings,
  Server,
  Network,
  User,
  LogOut,
  Plug,
  Shield,
  BarChart,
  ClipboardList,
} from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";

const NAV_ITEMS = [
  { label: "Dashboard",              href: "/",               icon: LayoutDashboard, adminOnly: false },
  { label: "Inventario de CIs",      href: "/inventory",      icon: Monitor,         adminOnly: false },
  { label: "Vulnerabilidades",       href: "/vulnerabilities", icon: Shield,          adminOnly: false },
  { label: "Mapa de Dependencias",   href: "/map",            icon: Network,         adminOnly: false },
  { label: "Conectores",             href: "/integrations",   icon: Plug,            adminOnly: true  },
  { label: "📊 Reportes",             href: "/reports",        icon: BarChart,        adminOnly: false },
  { label: "Contratos y Adendas",    href: "/contracts",      icon: FileText,        adminOnly: false },
  { label: "Entidades",              href: "/entities",       icon: Building2,       adminOnly: false },
  { label: "🕵️ Auditoría",            href: "/audit",          icon: ClipboardList,   adminOnly: true  },
  { label: "Configuración",          href: "/settings",       icon: Settings,        adminOnly: true  },
];

export default function Sidebar() {
  const pathname        = usePathname();
  const { user, logout, isAdmin } = useAuth();

  return (
    <aside className="flex h-screen w-64 flex-shrink-0 flex-col border-r border-slate-200 bg-white">
      {/* Brand */}
      <div className="flex items-center gap-2.5 border-b border-slate-200 px-5 py-4">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600">
          <Server className="h-4 w-4 text-white" />
        </div>
        <div className="leading-tight">
          <p className="text-sm font-bold text-slate-900">CMDB</p>
          <p className="text-[10px] text-slate-400 uppercase tracking-wider">
            Enterprise Platform
          </p>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-0.5">
        {NAV_ITEMS.filter(({ adminOnly }) => !adminOnly || isAdmin).map(({ label, href, icon: Icon }) => {
          const isActive =
            href === "/" ? pathname === "/" : pathname.startsWith(href);

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
              <Icon
                className={`h-4 w-4 flex-shrink-0 ${
                  isActive ? "text-indigo-600" : "text-slate-400"
                }`}
              />
              {label}
            </Link>
          );
        })}
      </nav>

      {/* User info + logout */}
      <div className="border-t border-slate-200 px-4 py-3 space-y-2">
        {user && (
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-indigo-100">
              <User className="h-4 w-4 text-indigo-600" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold text-slate-700 truncate">
                {user.username}
              </p>
              <span
                className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                  isAdmin
                    ? "bg-red-100 text-red-700"
                    : "bg-slate-100 text-slate-500"
                }`}
              >
                {user.role}
              </span>
            </div>
            <button
              onClick={logout}
              title="Cerrar sesión"
              className="flex-shrink-0 rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-colors"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        )}
        <p className="text-[10px] text-slate-400">
          © {new Date().getFullYear()} CMDB Platform v1.0
        </p>
      </div>
    </aside>
  );
}

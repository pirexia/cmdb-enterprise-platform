"use client";

import { Menu } from "lucide-react";
import { useTheme } from "@/contexts/ThemeContext";

interface TopBarProps {
  onMenuClick: () => void;
}

export default function TopBar({ onMenuClick }: TopBarProps) {
  const { companyName, logoUrl } = useTheme();

  return (
    <header
      className="flex h-13 flex-shrink-0 items-center gap-3 px-4 md:hidden"
      style={{ backgroundColor: "var(--sidebar-bg)" }}
    >
      <button
        onClick={onMenuClick}
        className="p-1.5 text-slate-400 hover:text-slate-200 transition-colors"
        aria-label="Abrir menú"
      >
        <Menu className="h-5 w-5" />
      </button>
      <div className="flex flex-1 items-center justify-center gap-2">
        {logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={logoUrl} alt={companyName} className="h-6 w-6 object-contain" />
        ) : null}
        <span className="text-sm font-bold text-slate-100 truncate">{companyName}</span>
      </div>
    </header>
  );
}

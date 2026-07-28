"use client";

import { useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
import { useLanguage } from "@/contexts/LanguageContext";
import Sidebar from "@/components/Sidebar";
import TopBar from "@/components/TopBar";

const PUBLIC_PATHS = ["/login", "/privacy"];

export default function AppShell({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const { t }             = useLanguage();
  const router            = useRouter();
  const pathname          = usePathname();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const isPublic = PUBLIC_PATHS.includes(pathname);

  useEffect(() => {
    if (loading) return;
    if (!user && !isPublic) router.replace("/login");
    else if (user && isPublic) router.replace("/");
  }, [user, loading, isPublic, router]);

  // Close sidebar on route change (mobile)
  useEffect(() => { setSidebarOpen(false); }, [pathname]);

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-slate-50">
        <div className="flex items-center gap-3 text-slate-400">
          <div className="h-5 w-5 animate-spin border-2 border-slate-300 border-t-[var(--accent)]" />
          <span className="text-sm">{t("common.loading")}</span>
        </div>
      </div>
    );
  }

  if (isPublic) return <>{children}</>;
  if (!user) return null;

  return (
    <div className="app-shell-root flex h-screen flex-col bg-slate-50 md:flex-row">
      {/* Mobile topbar — no-print: app chrome must never reach a printed
          page, only the content a page itself opts into printing. */}
      <TopBar onMenuClick={() => setSidebarOpen(true)} />

      {/* Mobile sidebar backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/50 md:hidden no-print"
          onClick={() => setSidebarOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Sidebar — fixed overlay on mobile, static on desktop. no-print for
          the same reason as the topbar above. */}
      <div
        className={`no-print fixed inset-y-0 left-0 z-40 transition-transform duration-200 ease-in-out md:relative md:translate-x-0 ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <Sidebar onClose={() => setSidebarOpen(false)} />
      </div>

      <main className="flex-1 overflow-y-auto app-main-scroll">{children}</main>
    </div>
  );
}

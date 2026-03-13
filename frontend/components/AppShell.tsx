"use client";

import { useEffect } from "react";
import { useRouter, usePathname } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
import Sidebar from "@/components/Sidebar";

const PUBLIC_PATHS = ["/login"];

export default function AppShell({ children }: { children: React.ReactNode }) {
  const { token, loading } = useAuth();
  const router   = useRouter();
  const pathname = usePathname();

  const isPublic = PUBLIC_PATHS.includes(pathname);

  useEffect(() => {
    if (loading) return;

    if (!token && !isPublic) {
      router.replace("/login");
    } else if (token && isPublic) {
      router.replace("/");
    }
  }, [token, loading, isPublic, router]);

  // Show loading spinner while hydrating auth state
  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-slate-50">
        <div className="flex items-center gap-3 text-slate-400">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-slate-300 border-t-indigo-500" />
          <span className="text-sm">Cargando…</span>
        </div>
      </div>
    );
  }

  // Login page — no sidebar, no layout wrapper
  if (isPublic) {
    return <>{children}</>;
  }

  // Not authenticated yet — prevent flash of protected content
  if (!token) {
    return null;
  }

  // Authenticated — full shell with sidebar
  return (
    <div className="flex h-screen bg-slate-50">
      <Sidebar />
      <main className="flex-1 overflow-y-auto">{children}</main>
    </div>
  );
}

"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Settings, Users, Plug, RefreshCw, AlertTriangle,
  ShieldCheck, Mail, Server, CheckCircle, XCircle,
} from "lucide-react";
import { apiFetch } from "@/lib/apiFetch";
import { useAuth } from "@/contexts/AuthContext";

// ─── Types ────────────────────────────────────────────────────────────────────

interface User {
  id:               string;
  username:         string;
  email:            string;
  role:             "ADMIN" | "VIEWER";
  active:           boolean;
  sso_external_id:  string | null;
  mfa_enabled:      boolean;
  created_at:       string;
}

type TabId = "users" | "integrations";

// ─── Sub-components ───────────────────────────────────────────────────────────

function Sel(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={`rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs font-medium text-slate-700 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100 ${props.className ?? ""}`}
    />
  );
}

function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-indigo-400 focus:ring-offset-1 disabled:opacity-40 disabled:cursor-not-allowed ${checked ? "bg-indigo-600" : "bg-slate-300"}`}
      aria-checked={checked}
    >
      <span
        className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${checked ? "translate-x-4" : "translate-x-0"}`}
      />
    </button>
  );
}

function StatusPill({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold ${ok ? "bg-green-100 text-green-700" : "bg-red-100 text-red-600"}`}>
      {ok ? <CheckCircle className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
      {label}
    </span>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function SettingsPage() {
  const { user: me } = useAuth();
  const isAdmin = me?.role === "ADMIN";

  const [tab,     setTab]     = useState<TabId>("users");
  const [users,   setUsers]   = useState<User[]>([]);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState<string | null>(null);
  const [saving,  setSaving]  = useState<Record<string, boolean>>({});

  // Test-email state
  const [testingEmail, setTestingEmail] = useState(false);
  const [emailResult,  setEmailResult]  = useState<{ ok: boolean; message: string } | null>(null);

  const loadUsers = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await apiFetch("/api/users");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setUsers(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al cargar usuarios");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadUsers(); }, [loadUsers]);

  // ── Change role ────────────────────────────────────────────────────────────
  const handleRoleChange = async (userId: string, role: "ADMIN" | "VIEWER") => {
    setSaving((p) => ({ ...p, [`role_${userId}`]: true }));
    try {
      const res = await apiFetch(`/api/users/${userId}/role`, {
        method: "PATCH",
        body: JSON.stringify({ role }),
      });
      if (!res.ok) { const d = await res.json(); throw new Error(d.error ?? "Error"); }
      setUsers((prev) => prev.map((u) => u.id === userId ? { ...u, role } : u));
    } catch (e) {
      alert(e instanceof Error ? e.message : "Error al cambiar el rol");
    } finally {
      setSaving((p) => { const n = { ...p }; delete n[`role_${userId}`]; return n; });
    }
  };

  // ── Toggle active ──────────────────────────────────────────────────────────
  const handleActiveToggle = async (userId: string, active: boolean) => {
    setSaving((p) => ({ ...p, [`active_${userId}`]: true }));
    try {
      const res = await apiFetch(`/api/users/${userId}/status`, {
        method: "PATCH",
        body: JSON.stringify({ active }),
      });
      if (!res.ok) { const d = await res.json(); throw new Error(d.error ?? "Error"); }
      setUsers((prev) => prev.map((u) => u.id === userId ? { ...u, active } : u));
    } catch (e) {
      alert(e instanceof Error ? e.message : "Error al cambiar el estado");
    } finally {
      setSaving((p) => { const n = { ...p }; delete n[`active_${userId}`]; return n; });
    }
  };

  // ── Test email ─────────────────────────────────────────────────────────────
  const handleTestEmail = async () => {
    setTestingEmail(true); setEmailResult(null);
    try {
      const res = await apiFetch("/api/admin/test-email", { method: "POST" });
      const d = await res.json();
      setEmailResult({ ok: res.ok && d.sent !== false, message: d.message ?? (res.ok ? "Enviado" : "Error") });
    } catch (e) {
      setEmailResult({ ok: false, message: e instanceof Error ? e.message : "Error de red" });
    } finally {
      setTestingEmail(false);
    }
  };

  // ── Integration status (from env vars — read-only in frontend) ─────────────
  // We show placeholder status; real check comes from the backend health endpoint
  const [healthData, setHealthData] = useState<{ status: string } | null>(null);
  useEffect(() => {
    apiFetch("/health").then((r) => r.json()).then(setHealthData).catch(() => null);
  }, []);

  const tabs: { id: TabId; label: string; icon: React.ReactNode }[] = [
    { id: "users",        label: "👥 Gestión de Usuarios",    icon: <Users   className="h-4 w-4" /> },
    { id: "integrations", label: "🔌 Integraciones y Sistema", icon: <Plug    className="h-4 w-4" /> },
  ];

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header */}
      <header className="border-b border-slate-200 bg-white px-8 py-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Settings className="h-5 w-5 text-slate-400" />
            <div>
              <h1 className="text-xl font-bold text-slate-900">Configuración</h1>
              <p className="text-sm text-slate-500 mt-0.5">Usuarios, roles e integraciones del sistema</p>
            </div>
          </div>
          <button onClick={loadUsers} disabled={loading} className="flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50 transition-colors disabled:opacity-50">
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />Actualizar
          </button>
        </div>
      </header>

      <div className="px-8 py-8 max-w-5xl mx-auto space-y-6">
        {error && (
          <div className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
            <AlertTriangle className="h-4 w-4 flex-shrink-0" />{error}
          </div>
        )}

        {!isAdmin && (
          <div className="flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
            <AlertTriangle className="h-4 w-4 flex-shrink-0" />
            Necesitas rol <strong>ADMIN</strong> para modificar la configuración. Modo de sólo lectura.
          </div>
        )}

        {/* Tab bar */}
        <div className="flex gap-1 rounded-xl bg-white p-1 shadow-sm ring-1 ring-slate-200 overflow-x-auto">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-2 rounded-lg px-5 py-2.5 text-sm font-medium whitespace-nowrap transition-colors flex-1 justify-center ${tab === t.id ? "bg-indigo-600 text-white shadow-sm" : "text-slate-600 hover:bg-slate-100"}`}
            >
              {t.icon}{t.label}
            </button>
          ))}
        </div>

        {/* ── Tab: Users ── */}
        {tab === "users" && (
          <div className="rounded-2xl bg-white shadow-sm ring-1 ring-slate-200 overflow-hidden">
            <div className="border-b border-slate-100 px-6 py-4 bg-slate-50 flex items-center justify-between">
              <div>
                <p className="text-sm font-semibold text-slate-700">Usuarios del sistema</p>
                <p className="text-xs text-slate-500 mt-0.5">{users.length} usuario(s) registrado(s)</p>
              </div>
            </div>

            {loading ? (
              <div className="py-12 text-center text-sm text-slate-400">Cargando usuarios…</div>
            ) : users.length === 0 ? (
              <div className="py-12 text-center text-sm text-slate-400">Sin usuarios registrados.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-100 bg-slate-50">
                      <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">Usuario</th>
                      <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">Email</th>
                      <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">Origen</th>
                      <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">MFA</th>
                      <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">Rol</th>
                      <th className="text-center px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">Activo</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50">
                    {users.map((u) => {
                      const isSelf   = u.id === me?.id;
                      const isLDAP   = !!u.sso_external_id;
                      const roleSaving   = saving[`role_${u.id}`];
                      const activeSaving = saving[`active_${u.id}`];

                      return (
                        <tr key={u.id} className={`transition-colors ${!u.active ? "opacity-50 bg-slate-50" : "hover:bg-slate-50"}`}>
                          {/* Username */}
                          <td className="px-5 py-3">
                            <div className="flex items-center gap-2">
                              <div className="h-7 w-7 rounded-full bg-indigo-100 flex items-center justify-center text-xs font-bold text-indigo-600">
                                {u.username.slice(0, 2).toUpperCase()}
                              </div>
                              <div>
                                <p className="font-medium text-slate-800 text-sm">{u.username}</p>
                                {isSelf && <span className="text-[10px] text-indigo-500 font-medium">(yo)</span>}
                              </div>
                            </div>
                          </td>

                          {/* Email */}
                          <td className="px-5 py-3 text-slate-600 text-xs">{u.email}</td>

                          {/* Origen */}
                          <td className="px-4 py-3">
                            <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${isLDAP ? "bg-blue-100 text-blue-700" : "bg-slate-100 text-slate-600"}`}>
                              {isLDAP ? "🏢 LDAP" : "🔑 Local"}
                            </span>
                          </td>

                          {/* MFA */}
                          <td className="px-4 py-3">
                            <StatusPill ok={u.mfa_enabled} label={u.mfa_enabled ? "Activo" : "Inactivo"} />
                          </td>

                          {/* Role selector */}
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-1.5">
                              <Sel
                                value={u.role}
                                disabled={!isAdmin || isSelf || roleSaving}
                                onChange={(e) => handleRoleChange(u.id, e.target.value as "ADMIN" | "VIEWER")}
                              >
                                <option value="ADMIN">👑 ADMIN</option>
                                <option value="VIEWER">👁️ VIEWER</option>
                              </Sel>
                              {roleSaving && <RefreshCw className="h-3 w-3 animate-spin text-indigo-400" />}
                            </div>
                          </td>

                          {/* Active toggle */}
                          <td className="px-4 py-3 text-center">
                            <div className="flex items-center justify-center gap-1.5">
                              <Toggle
                                checked={u.active}
                                disabled={!isAdmin || isSelf || activeSaving}
                                onChange={(val) => {
                                  if (!confirm(`¿${val ? "Activar" : "Desactivar"} al usuario "${u.username}"?`)) return;
                                  void handleActiveToggle(u.id, val);
                                }}
                              />
                              {activeSaving && <RefreshCw className="h-3 w-3 animate-spin text-indigo-400" />}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* ── Tab: Integrations & System ── */}
        {tab === "integrations" && (
          <div className="space-y-6">

            {/* API Health */}
            <div className="rounded-2xl bg-white shadow-sm ring-1 ring-slate-200 overflow-hidden">
              <div className="border-b border-slate-100 px-6 py-4 bg-slate-50">
                <p className="text-sm font-semibold text-slate-700">Estado del Sistema</p>
              </div>
              <div className="grid grid-cols-1 gap-4 p-6 sm:grid-cols-3">

                {/* API Health */}
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-2">
                  <div className="flex items-center gap-2">
                    <Server className="h-5 w-5 text-indigo-500" />
                    <p className="text-sm font-semibold text-slate-700">Backend API</p>
                  </div>
                  <StatusPill ok={!!healthData} label={healthData ? "Operativo" : "No responde"} />
                  {healthData && (
                    <p className="text-xs text-slate-500">Estado: <strong>{healthData.status}</strong></p>
                  )}
                </div>

                {/* LDAP */}
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-2">
                  <div className="flex items-center gap-2">
                    <ShieldCheck className="h-5 w-5 text-blue-500" />
                    <p className="text-sm font-semibold text-slate-700">LDAP / Active Directory</p>
                  </div>
                  <StatusPill
                    ok={process.env.NEXT_PUBLIC_USE_LDAP === "true"}
                    label={process.env.NEXT_PUBLIC_USE_LDAP === "true" ? "Habilitado" : "Deshabilitado"}
                  />
                  <p className="text-xs text-slate-500">
                    Autenticación corporativa via LDAP/AD.
                    Para habilitar: <code className="bg-slate-200 px-1 rounded">USE_LDAP=true</code> en el backend.
                  </p>
                </div>

                {/* SMTP */}
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-2">
                  <div className="flex items-center gap-2">
                    <Mail className="h-5 w-5 text-green-500" />
                    <p className="text-sm font-semibold text-slate-700">SMTP / Alertas</p>
                  </div>
                  <StatusPill ok={true} label="Configurado" />
                  <p className="text-xs text-slate-500 mb-2">
                    Motor de alertas diarias activo. Horario: 08:30 AM (Europe/Madrid).
                  </p>
                  {isAdmin && (
                    <button
                      onClick={handleTestEmail}
                      disabled={testingEmail}
                      className="w-full flex items-center justify-center gap-2 rounded-lg bg-green-600 px-3 py-2 text-xs font-semibold text-white hover:bg-green-700 transition-colors disabled:opacity-50"
                    >
                      {testingEmail
                        ? <><RefreshCw className="h-3.5 w-3.5 animate-spin" />Enviando…</>
                        : <><Mail className="h-3.5 w-3.5" />📧 Enviar Correo de Prueba</>
                      }
                    </button>
                  )}
                  {emailResult && (
                    <div className={`rounded-lg px-3 py-2 text-xs font-medium mt-1 ${emailResult.ok ? "bg-green-50 text-green-700 border border-green-200" : "bg-red-50 text-red-600 border border-red-200"}`}>
                      {emailResult.ok ? "✅" : "❌"} {emailResult.message}
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* System Info */}
            <div className="rounded-2xl bg-white shadow-sm ring-1 ring-slate-200 overflow-hidden">
              <div className="border-b border-slate-100 px-6 py-4 bg-slate-50">
                <p className="text-sm font-semibold text-slate-700">Información del Sistema</p>
              </div>
              <div className="px-6 py-4">
                <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 text-sm">
                  {[
                    ["Plataforma",        "CMDB Enterprise Platform"],
                    ["Stack Backend",     "Node.js + Express + Prisma ORM"],
                    ["Stack Frontend",    "Next.js 16 + Tailwind CSS 4"],
                    ["Base de datos",     "PostgreSQL 16"],
                    ["Autenticación",     "JWT HS256 (8h) + MFA TOTP"],
                    ["Seguridad",         "Helmet + CORS estricto + HTTPS opcional"],
                    ["Alertas",           "node-cron + nodemailer (SMTP)"],
                    ["Cumplimiento",      "ISO 27001 A.9.2 / A.10.1 / A.12.4"],
                  ].map(([k, v]) => (
                    <div key={k} className="flex justify-between border-b border-slate-50 pb-2">
                      <dt className="text-slate-500 font-medium">{k}</dt>
                      <dd className="text-slate-800 text-right">{v}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

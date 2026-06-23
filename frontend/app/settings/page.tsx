"use client";

import { useCallback, useEffect, useState } from "react";
import { useLanguage } from "@/contexts/LanguageContext";
import {
  Settings, Users, Plug, RefreshCw, AlertTriangle,
  ShieldCheck, Mail, Server, CheckCircle, XCircle,
  Shield, Download, Upload, Loader2, Bell, Workflow,
} from "lucide-react";
import AlertsSettings from "@/components/AlertsSettings";
import N8nResyncCard from "@/components/admin/N8nResyncCard";
import { apiFetch } from "@/lib/apiFetch";
import { useAuth } from "@/contexts/AuthContext";

// ─── Types ────────────────────────────────────────────────────────────────────

interface User {
  id:               string;
  username:         string;
  email:            string;
  role:             "ADMIN" | "AUDITOR" | "VIEWER";
  active:           boolean;
  sso_external_id:  string | null;
  mfa_enabled:      boolean;
  created_at:       string;
}

type TabId = "users" | "integrations" | "certificates" | "branding" | "alerts" | "n8n";

interface StackComponent {
  name:           string;
  category:       string;
  version:        string;
  latestVersion?: string;
  eolDate?:       string | boolean;
  isEol:          boolean;
  daysToEol?:     number;
  license:        string;
  hasEolData:     boolean;
}

interface SystemInfoData {
  components:   StackComponent[];
  generatedAt:  string;
}

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
  const { t } = useLanguage();
  const isAdmin = me?.role === "ADMIN";

  const [tab,     setTab]     = useState<TabId>("users");
  const [users,   setUsers]   = useState<User[]>([]);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState<string | null>(null);
  const [saving,  setSaving]  = useState<Record<string, boolean>>({});

  // Test-email state
  const [testingEmail, setTestingEmail] = useState(false);
  const [emailResult,  setEmailResult]  = useState<{ ok: boolean; message: string } | null>(null);

  // Certificate management state
  const [cn, setCn] = useState("");
  const [organization, setOrganization] = useState("");
  const [organizationalUnit, setOrganizationalUnit] = useState("");
  const [country, setCountry] = useState("ES");
  const [state, setState] = useState("");
  const [generatingCSR, setGeneratingCSR] = useState(false);
  const [csrResult, setCsrResult] = useState<string | null>(null);
  const [certContent, setCertContent] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadSuccess, setUploadSuccess] = useState(false);
  const [uploadMessage, setUploadMessage] = useState("");

  const [sysInfo, setSysInfo]               = useState<SystemInfoData | null>(null);
  const [sysInfoLoading, setSysInfoLoading] = useState(false);
  const [sysInfoError, setSysInfoError]     = useState(false);

  // Branding tab state
  const [sidebarBg,      setSidebarBg]      = useState("#0f172a");
  const [accentColorVal, setAccentColorVal] = useState("#3b82f6");
  const [companyNameVal, setCompanyNameVal] = useState("CMDB Platform");
  const [hasLogo,        setHasLogo]        = useState(false);
  const [logoPreviewUrl, setLogoPreviewUrl] = useState<string | null>(null);
  const [brandingMsg,    setBrandingMsg]    = useState<{ ok: boolean; text: string } | null>(null);
  const [savingBranding, setSavingBranding] = useState(false);
  const [logoFile,       setLogoFile]       = useState<File | null>(null);

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
  const handleRoleChange = async (userId: string, role: "ADMIN" | "AUDITOR" | "VIEWER") => {
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

  // ── Certificate Management ─────────────────────────────────────────────────
  const handleGenerateCSR = async (e: React.FormEvent) => {
    e.preventDefault();
    setGeneratingCSR(true);
    setError(null);
    setCsrResult(null);

    try {
      const response = await apiFetch("/api/admin/certificates/csr", {
        method: "POST",
        body: JSON.stringify({ cn, o: organization, ou: organizationalUnit, c: country, st: state }),
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Failed to generate CSR");

      setCsrResult(data.csr);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error generating CSR");
    } finally {
      setGeneratingCSR(false);
    }
  };

  const handleDownloadCSR = () => {
    if (!csrResult) return;
    const blob = new Blob([csrResult], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "server.csr";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleUploadCertificate = async (e: React.FormEvent) => {
    e.preventDefault();
    setUploading(true);
    setError(null);
    setUploadSuccess(false);
    setUploadMessage("");

    try {
      const response = await apiFetch("/api/admin/certificates/upload", {
        method: "POST",
        body: JSON.stringify({ certificate: certContent }),
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Failed to upload certificate");

      setUploadSuccess(true);
      setUploadMessage(data.message || "Certificate uploaded successfully");
      setCertContent("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error uploading certificate");
    } finally {
      setUploading(false);
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target?.result as string;
      setCertContent(content);
    };
    reader.readAsText(file);
  };

  const handleLogoFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setLogoFile(file);
    const reader = new FileReader();
    reader.onload = (ev) => setLogoPreviewUrl(ev.target?.result as string);
    reader.readAsDataURL(file);
  };

  const handleLogoUpload = async () => {
    if (!logoFile) return;
    setSavingBranding(true); setBrandingMsg(null);
    try {
      const token = typeof window !== "undefined" ? localStorage.getItem("token") : null;
      const fd = new FormData();
      fd.append("logo", logoFile);
      const res = await fetch("/api/settings/logo", {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        credentials: "include",
        body: fd,
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? "Error");
      setHasLogo(true);
      setLogoFile(null);
      setBrandingMsg({ ok: true, text: t("settings.branding.save_success") });
    } catch (e) {
      setBrandingMsg({ ok: false, text: e instanceof Error ? e.message : t("settings.branding.save_error") });
    } finally {
      setSavingBranding(false);
    }
  };

  const handleLogoDelete = async () => {
    setSavingBranding(true); setBrandingMsg(null);
    try {
      const res = await apiFetch("/api/settings/logo", { method: "DELETE" });
      if (!res.ok) throw new Error("Error");
      setHasLogo(false);
      setLogoPreviewUrl(null);
      setLogoFile(null);
      setBrandingMsg({ ok: true, text: t("settings.branding.save_success") });
    } catch {
      setBrandingMsg({ ok: false, text: t("settings.branding.save_error") });
    } finally {
      setSavingBranding(false);
    }
  };

  const handleThemeApply = async () => {
    setSavingBranding(true); setBrandingMsg(null);
    try {
      const res = await apiFetch("/api/settings/theme", {
        method: "PUT",
        body: JSON.stringify({ sidebarBg, accentColor: accentColorVal, companyName: companyNameVal }),
      });
      if (!res.ok) { const d = await res.json(); throw new Error(d.error ?? "Error"); }
      const style = document.getElementById("theme-vars");
      const hexRe = /^#[0-9a-fA-F]{6}$/;
      if (style && hexRe.test(sidebarBg) && hexRe.test(accentColorVal)) {
        style.textContent = `:root { --sidebar-bg: ${sidebarBg}; --accent: ${accentColorVal}; }`;
      }
      setBrandingMsg({ ok: true, text: t("settings.branding.save_success") });
    } catch (e) {
      setBrandingMsg({ ok: false, text: e instanceof Error ? e.message : t("settings.branding.save_error") });
    } finally {
      setSavingBranding(false);
    }
  };

  // ── Integration status (from env vars — read-only in frontend) ─────────────
  // We show placeholder status; real check comes from the backend health endpoint
  const [healthData, setHealthData] = useState<{ status: string } | null>(null);
  useEffect(() => {
    apiFetch("/health").then((r) => r.json()).then(setHealthData).catch(() => null);
  }, []);

  useEffect(() => {
    if (tab !== 'integrations' || sysInfo !== null) return;
    setSysInfoLoading(true);
    setSysInfoError(false);
    apiFetch('/api/system-info')
      .then(r => r.json())
      .then((data: SystemInfoData) => setSysInfo(data))
      .catch(() => setSysInfoError(true))
      .finally(() => setSysInfoLoading(false));
  }, [tab, sysInfo]);

  useEffect(() => {
    if (tab !== "branding") return;
    fetch("/api/settings/theme")
      .then((r) => r.ok ? r.json() : null)
      .then((d: { sidebarBg: string; accentColor: string; companyName: string; hasLogo: boolean } | null) => {
        if (!d) return;
        setSidebarBg(d.sidebarBg);
        setAccentColorVal(d.accentColor);
        setCompanyNameVal(d.companyName);
        setHasLogo(d.hasLogo);
      })
      .catch(() => {});
  }, [tab]);

  const tabs: { id: TabId; label: string; icon: React.ReactNode }[] = [
    { id: "users",        label: t("settings.tabs.users"),        icon: <Users className="h-4 w-4" /> },
    { id: "integrations", label: t("settings.tabs.integrations"), icon: <Plug  className="h-4 w-4" /> },
    { id: "certificates", label: "SSL/TLS Certificates",         icon: <Shield className="h-4 w-4" /> },
    ...(isAdmin ? [{ id: "branding" as TabId, label: t("settings.branding.tab"), icon: <Settings className="h-4 w-4" /> }] : []),
    ...(isAdmin ? [{ id: "alerts"   as TabId, label: t("settings.alerts.tab"),    icon: <Bell     className="h-4 w-4" /> }] : []),
    ...(isAdmin ? [{ id: "n8n"     as TabId, label: t("settings.n8n.tab"),       icon: <Workflow className="h-4 w-4" /> }] : []),
  ];

  function SysStatusBadge({ c }: { c: StackComponent }) {
    if (!c.hasEolData) {
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500">
          <span className="h-1.5 w-1.5 rounded-full bg-slate-400" />
          {t("settings.integrations.sys_status_community")}
        </span>
      );
    }
    if (c.isEol) {
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">
          <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
          {t("settings.integrations.sys_status_eol")}
        </span>
      );
    }
    if (typeof c.daysToEol === 'number' && c.daysToEol <= 90) {
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">
          <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
          {t("settings.integrations.sys_status_eol_soon")}
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700">
        <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
        {t("settings.integrations.sys_status_active")}
      </span>
    );
  }

  return (
    <div className="flex flex-col h-screen bg-slate-50 overflow-hidden">
      {/* Header */}
      <header className="sticky top-0 z-10 flex-shrink-0 border-b border-slate-200 bg-white px-8 py-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Settings className="h-5 w-5 text-slate-400" />
            <div>
              <h1 className="text-xl font-bold text-slate-900">{t('settings.title')}</h1>
              <p className="text-sm text-slate-500 mt-0.5">{t('settings.subtitle')}</p>
            </div>
          </div>
          <button onClick={loadUsers} disabled={loading} className="flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50 transition-colors disabled:opacity-50">
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />Actualizar
          </button>
        </div>
      </header>

      {/* Body: sidebar + content */}
      <div className="flex flex-1 overflow-hidden">

        {/* Sidebar nav */}
        <aside className="w-56 flex-shrink-0 bg-white border-r border-slate-200 overflow-y-auto">
          <nav className="py-3">
            {tabs.map((item) => {
              const active = tab === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => setTab(item.id)}
                  className={`w-full flex items-center gap-3 px-5 py-2.5 text-sm font-medium transition-colors text-left ${
                    active
                      ? "bg-indigo-50 text-indigo-700 border-r-2 border-indigo-600"
                      : "text-slate-600 hover:bg-slate-50 hover:text-slate-900"
                  }`}
                >
                  <span className={active ? "text-indigo-600" : "text-slate-400"}>{item.icon}</span>
                  <span className="flex-1 truncate">{item.label}</span>
                </button>
              );
            })}
          </nav>
        </aside>

        {/* Content area */}
        <main className="flex-1 overflow-y-auto">
          <div className="px-8 py-8 space-y-6">
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
                      <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">{t('settings.users.columns.user')}</th>
                      <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">{t('settings.users.columns.email')}</th>
                      <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">{t('settings.users.columns.origin')}</th>
                      <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">{t('settings.users.columns.mfa')}</th>
                      <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">{t('settings.users.columns.role')}</th>
                      <th className="text-center px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">{t('settings.users.columns.active')}</th>
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
                                {isSelf && <span className="text-[10px] text-indigo-500 font-medium">{t('settings.users.me_label')}</span>}
                              </div>
                            </div>
                          </td>

                          {/* Email */}
                          <td className="px-5 py-3 text-slate-600 text-xs">{u.email}</td>

                          {/* Origen */}
                          <td className="px-4 py-3">
                            <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${isLDAP ? "bg-blue-100 text-blue-700" : "bg-slate-100 text-slate-600"}`}>
                              {isLDAP ? t('settings.users.origin_ldap') : t('settings.users.origin_local')}
                            </span>
                          </td>

                          {/* MFA */}
                          <td className="px-4 py-3">
                            <StatusPill ok={u.mfa_enabled} label={u.mfa_enabled ? t('settings.users.mfa_active') : t('settings.users.mfa_inactive')} />
                          </td>

                          {/* Role selector */}
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-1.5">
                              <Sel
                                value={u.role}
                                disabled={!isAdmin || isSelf || roleSaving}
                                onChange={(e) => handleRoleChange(u.id, e.target.value as "ADMIN" | "AUDITOR" | "VIEWER")}
                              >
                                <option value="ADMIN">{t('settings.users.role_admin')}</option>
                                <option value="AUDITOR">{t('settings.users.role_auditor')}</option>
                                <option value="VIEWER">{t('settings.users.role_viewer')}</option>
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
                  <StatusPill ok={!!healthData} label={healthData ? t('settings.integrations.api_ok') : t('settings.integrations.api_fail')} />
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
                        : <><Mail className="h-3.5 w-3.5" />Enviar Correo de Prueba</>
                      }
                    </button>
                  )}
                  {emailResult && (
                    <div className={`rounded-lg px-3 py-2 text-xs font-medium mt-1 ${emailResult.ok ? "bg-green-50 text-green-700 border border-green-200" : "bg-red-50 text-red-600 border border-red-200"}`}>
                      {emailResult.ok ? "OK" : "Error"} {emailResult.message}
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* System Info — dynamic table */}
            <div className="rounded-2xl bg-white shadow-sm ring-1 ring-slate-200 overflow-hidden">
              <div className="border-b border-slate-100 px-6 py-4 bg-slate-50 flex items-center justify-between">
                <p className="text-sm font-semibold text-slate-700">{t("settings.integrations.system_info")}</p>
                {sysInfo && (
                  <span className="text-xs text-slate-400">
                    {new Date(sysInfo.generatedAt).toLocaleString()}
                  </span>
                )}
              </div>

              {sysInfoLoading && (
                <div className="flex items-center justify-center gap-2 py-8 text-sm text-slate-400">
                  <RefreshCw className="h-4 w-4 animate-spin" />
                  {t("settings.integrations.sys_loading")}
                </div>
              )}

              {sysInfoError && (
                <div className="flex items-center justify-between px-6 py-4">
                  <p className="text-sm text-red-600">{t("settings.integrations.sys_error")}</p>
                  <button
                    onClick={() => {
                      setSysInfoError(false);
                      setSysInfo(null);
                    }}
                    className="text-xs font-medium text-indigo-600 hover:underline"
                  >
                    {t("settings.integrations.sys_retry")}
                  </button>
                </div>
              )}

              {sysInfo && !sysInfoLoading && (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-slate-100 bg-slate-50">
                        <th className="px-4 py-2 text-left font-semibold text-slate-500">{t("settings.integrations.sys_col_component")}</th>
                        <th className="px-4 py-2 text-left font-semibold text-slate-500">{t("settings.integrations.sys_col_version")}</th>
                        <th className="px-4 py-2 text-left font-semibold text-slate-500">{t("settings.integrations.sys_col_eol")}</th>
                        <th className="px-4 py-2 text-left font-semibold text-slate-500">{t("settings.integrations.sys_col_license")}</th>
                        <th className="px-4 py-2 text-left font-semibold text-slate-500">{t("settings.integrations.sys_col_status")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sysInfo.components.map((c) => (
                        <tr key={c.name} className="border-b border-slate-50 hover:bg-slate-50 transition-colors">
                          <td className="px-4 py-2.5 font-medium text-slate-800">
                            {c.name}
                            <span className="ml-1.5 text-slate-400 font-normal">{c.category}</span>
                          </td>
                          <td className="px-4 py-2.5 font-mono text-slate-700">{c.version}</td>
                          <td className="px-4 py-2.5 text-slate-600">
                            {typeof c.eolDate === 'string'
                              ? c.eolDate
                              : t("settings.integrations.sys_eol_unknown")}
                          </td>
                          <td className="px-4 py-2.5 text-slate-600">{c.license}</td>
                          <td className="px-4 py-2.5">
                            <SysStatusBadge c={c} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── Tab: Certificates ── */}
        {tab === "certificates" && (
          <div className="space-y-6">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* CSR Generation */}
              <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
                <div className="border-b border-slate-200 bg-slate-50 px-6 py-4">
                  <h2 className="text-lg font-semibold text-slate-800 flex items-center gap-2">
                    <Download className="h-5 w-5 text-indigo-600" />
                    1. Generate CSR
                  </h2>
                  <p className="text-xs text-slate-500 mt-1">Create a Certificate Signing Request for your CA</p>
                </div>

                <form onSubmit={handleGenerateCSR} className="p-6 space-y-4">
                  <div>
                    <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1.5">
                      Common Name (CN) *
                    </label>
                    <input
                      type="text"
                      required
                      placeholder="cmdb.yourdomain.com"
                      value={cn}
                      onChange={(e) => setCn(e.target.value)}
                      className="w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-800 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                    />
                    <p className="text-xs text-slate-400 mt-1">Server FQDN or IP address</p>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1.5">
                      Organization (O)
                    </label>
                    <input
                      type="text"
                      placeholder="Your Company Name"
                      value={organization}
                      onChange={(e) => setOrganization(e.target.value)}
                      className="w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-800 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1.5">
                        Country (C)
                      </label>
                      <input
                        type="text"
                        maxLength={2}
                        placeholder="ES"
                        value={country}
                        onChange={(e) => setCountry(e.target.value.toUpperCase())}
                        className="w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-800 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1.5">
                        State/Province (ST)
                      </label>
                      <input
                        type="text"
                        placeholder="Madrid"
                        value={state}
                        onChange={(e) => setState(e.target.value)}
                        className="w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-800 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1.5">
                      Organizational Unit (OU)
                    </label>
                    <input
                      type="text"
                      placeholder="IT Department"
                      value={organizationalUnit}
                      onChange={(e) => setOrganizationalUnit(e.target.value)}
                      className="w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-800 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                    />
                  </div>

                  <button
                    type="submit"
                    disabled={generatingCSR || !cn}
                    className="w-full flex items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
                  >
                    {generatingCSR ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                    {generatingCSR ? "Generating..." : "Generate CSR"}
                  </button>
                </form>

                {csrResult && (
                  <div className="px-6 pb-6">
                    <div className="rounded-lg border border-green-200 bg-green-50 p-4">
                      <div className="flex items-center gap-2 mb-3">
                        <CheckCircle className="h-4 w-4 text-green-600" />
                        <p className="text-sm font-semibold text-green-700">CSR Generated Successfully</p>
                      </div>
                      <textarea
                        readOnly
                        value={csrResult}
                        className="w-full rounded border border-green-300 bg-white px-3 py-2 font-mono text-xs text-slate-700 h-32 resize-none"
                      />
                      <button
                        onClick={handleDownloadCSR}
                        className="mt-3 flex items-center gap-2 rounded-lg bg-green-600 px-4 py-2 text-sm font-semibold text-white hover:bg-green-700 transition-colors"
                      >
                        <Download className="h-4 w-4" />
                        Download server.csr
                      </button>
                      <p className="text-xs text-green-600 mt-2">
                        Send this CSR to your Certificate Authority for signing.
                      </p>
                    </div>
                  </div>
                )}
              </div>

              {/* Certificate Upload */}
              <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
                <div className="border-b border-slate-200 bg-slate-50 px-6 py-4">
                  <h2 className="text-lg font-semibold text-slate-800 flex items-center gap-2">
                    <Upload className="h-5 w-5 text-indigo-600" />
                    2. Upload Signed Certificate
                  </h2>
                  <p className="text-xs text-slate-500 mt-1">Install the certificate signed by your CA</p>
                </div>

                <form onSubmit={handleUploadCertificate} className="p-6 space-y-4">
                  <div>
                    <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1.5">
                      Certificate File (.crt / .pem)
                    </label>
                    <input
                      type="file"
                      accept=".crt,.pem,.cer"
                      onChange={handleFileUpload}
                      className="w-full text-sm text-slate-600 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-semibold file:bg-indigo-50 file:text-indigo-700 hover:file:bg-indigo-100"
                    />
                    <p className="text-xs text-slate-400 mt-1">Or paste the PEM content below</p>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1.5">
                      Certificate Content (PEM format)
                    </label>
                    <textarea
                      placeholder="-----BEGIN CERTIFICATE-----&#10;MIIDXTCCAkWgAwIBAgIJAKZ...&#10;-----END CERTIFICATE-----"
                      value={certContent}
                      onChange={(e) => setCertContent(e.target.value)}
                      className="w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 font-mono text-xs text-slate-800 h-40 resize-none focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                    />
                  </div>

                  <button
                    type="submit"
                    disabled={uploading || !certContent}
                    className="w-full flex items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
                  >
                    {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                    {uploading ? "Uploading..." : "Upload Certificate"}
                  </button>
                </form>

                {uploadSuccess && uploadMessage && (
                  <div className="px-6 pb-6">
                    <div className="rounded-lg border border-green-200 bg-green-50 p-4">
                      <div className="flex items-center gap-2 mb-2">
                        <CheckCircle className="h-4 w-4 text-green-600" />
                        <p className="text-sm font-semibold text-green-700">Certificate Uploaded</p>
                      </div>
                      <p className="text-sm text-green-600 mb-3">{uploadMessage}</p>
                      <div className="rounded bg-green-100 border border-green-300 px-3 py-2 font-mono text-xs text-green-800">
                        docker compose -f docker-compose.prod.yml restart backend
                      </div>
                      <p className="text-xs text-green-600 mt-2">
                        Run this command to apply the new certificate.
                      </p>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Instructions */}
            <div className="rounded-xl border border-blue-200 bg-blue-50 px-6 py-5">
              <h3 className="text-sm font-semibold text-blue-800 mb-3">Certificate Management Workflow</h3>
              <ol className="text-sm text-blue-700 space-y-2 list-decimal list-inside">
                <li>Fill in the CSR form with your server details and click &quot;Generate CSR&quot;</li>
                <li>Download the generated CSR file and send it to your Certificate Authority (CA)</li>
                <li>When you receive the signed certificate from your CA, upload it using the form above</li>
                <li>Restart the backend container to apply the new certificate</li>
                <li>Verify the certificate is active: <code className="bg-blue-100 px-1.5 py-0.5 rounded font-mono text-xs">openssl s_client -connect localhost:3000</code></li>
              </ol>
            </div>
          </div>
        )}

            {tab === "branding" && isAdmin && (
              <div className="space-y-8">
                {/* Feedback message */}
                {brandingMsg && (
                  <div className={`flex items-center gap-2 px-4 py-3 text-sm border ${
                    brandingMsg.ok
                      ? "border-green-200 bg-green-50 text-green-700"
                      : "border-red-200 bg-red-50 text-red-600"
                  }`}>
                    {brandingMsg.text}
                  </div>
                )}

                {/* Logo block */}
                <section>
                  <h3 className="text-sm font-semibold text-slate-700 mb-4">{t("settings.branding.logo_title")}</h3>
                  <div className="flex items-start gap-6">
                    <div className="flex h-20 w-20 flex-shrink-0 items-center justify-center border border-slate-200 bg-slate-50">
                      {logoPreviewUrl
                        // eslint-disable-next-line @next/next/no-img-element
                        ? <img src={logoPreviewUrl} alt="preview" className="h-16 w-16 object-contain" />
                        : hasLogo
                        // eslint-disable-next-line @next/next/no-img-element
                        ? <img src="/api/settings/logo" alt="logo" className="h-16 w-16 object-contain" />
                        : <span className="text-xs text-slate-400">{t("settings.branding.logo_preview")}</span>
                      }
                    </div>
                    <div className="space-y-2">
                      <label className="block">
                        <span className="text-xs text-slate-500 block mb-1">{t("settings.branding.logo_hint")}</span>
                        <input
                          type="file"
                          accept="image/png,image/jpeg,image/webp"
                          onChange={handleLogoFileChange}
                          className="block text-xs text-slate-600 file:mr-3 file:border-0 file:bg-slate-800 file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-white hover:file:bg-slate-700 cursor-pointer"
                        />
                      </label>
                      {logoFile && (
                        <button
                          onClick={handleLogoUpload}
                          disabled={savingBranding}
                          className="px-4 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
                          style={{ backgroundColor: "var(--accent)" }}
                        >
                          {t("settings.branding.logo_upload_btn")}
                        </button>
                      )}
                      {hasLogo && !logoFile && (
                        <button
                          onClick={handleLogoDelete}
                          disabled={savingBranding}
                          className="px-4 py-1.5 text-xs font-semibold text-red-600 border border-red-200 hover:bg-red-50 disabled:opacity-50"
                        >
                          {t("settings.branding.logo_remove_btn")}
                        </button>
                      )}
                    </div>
                  </div>
                </section>

                {/* Company name block */}
                <section>
                  <h3 className="text-sm font-semibold text-slate-700 mb-3">{t("settings.branding.company_name_title")}</h3>
                  <input
                    type="text"
                    value={companyNameVal}
                    onChange={(e) => setCompanyNameVal(e.target.value)}
                    maxLength={100}
                    className="w-full max-w-xs border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 focus:border-[var(--accent)] focus:outline-none"
                  />
                </section>

                {/* Colors block */}
                <section>
                  <h3 className="text-sm font-semibold text-slate-700 mb-4">{t("settings.branding.colors_title")}</h3>
                  <div className="flex flex-wrap gap-6 items-start">
                    <div className="space-y-1.5">
                      <label className="block text-xs font-medium text-slate-600">{t("settings.branding.sidebar_color")}</label>
                      <div className="flex items-center gap-2">
                        <input
                          type="color"
                          value={sidebarBg}
                          onChange={(e) => setSidebarBg(e.target.value)}
                          className="h-8 w-14 cursor-pointer border border-slate-300 p-0.5 bg-white"
                        />
                        <code className="text-xs text-slate-500 font-mono">{sidebarBg}</code>
                      </div>
                    </div>
                    <div className="space-y-1.5">
                      <label className="block text-xs font-medium text-slate-600">{t("settings.branding.accent_color")}</label>
                      <div className="flex items-center gap-2">
                        <input
                          type="color"
                          value={accentColorVal}
                          onChange={(e) => setAccentColorVal(e.target.value)}
                          className="h-8 w-14 cursor-pointer border border-slate-300 p-0.5 bg-white"
                        />
                        <code className="text-xs text-slate-500 font-mono">{accentColorVal}</code>
                      </div>
                    </div>

                    {/* Live mini-preview */}
                    <div className="flex flex-col gap-1">
                      <span className="text-xs font-medium text-slate-600">{t("settings.branding.preview_title")}</span>
                      <div
                        className="flex h-28 w-36 flex-col overflow-hidden border border-slate-200"
                        style={{ backgroundColor: sidebarBg }}
                      >
                        <div className="flex items-center gap-1.5 border-b border-white/10 px-2 py-1.5">
                          <div className="h-3.5 w-3.5 flex-shrink-0" style={{ backgroundColor: accentColorVal }} />
                          <span className="text-[9px] font-bold text-slate-200 truncate">{companyNameVal || "CMDB"}</span>
                        </div>
                        <div className="flex-1 px-2 py-1.5 space-y-1">
                          {["Dashboard","Inventario","Contratos"].map((label, i) => (
                            <div
                              key={label}
                              className="flex items-center gap-1 px-1 py-0.5 text-[8px] border-l-2"
                              style={i === 1
                                ? { borderLeftColor: accentColorVal, backgroundColor: `${accentColorVal}20`, color: accentColorVal }
                                : { borderLeftColor: "transparent", color: "#94a3b8" }
                              }
                            >
                              <div className="h-1.5 w-1.5 rounded-sm bg-current opacity-60" />
                              {label}
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                </section>

                <button
                  onClick={handleThemeApply}
                  disabled={savingBranding}
                  className="px-6 py-2 text-sm font-semibold text-white disabled:opacity-50 transition-colors"
                  style={{ backgroundColor: "var(--accent)" }}
                >
                  {savingBranding ? "..." : t("settings.branding.apply_btn")}
                </button>
              </div>
            )}

            {tab === "alerts" && (
              <AlertsSettings isAdmin={isAdmin} />
            )}

            {tab === "n8n" && isAdmin && (
              <N8nResyncCard />
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

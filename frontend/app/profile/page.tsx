"use client";

import { useState, useMemo } from "react";
import {
  User, ShieldCheck, ShieldOff, QrCode, Loader2, AlertTriangle,
  CheckCircle2, KeyRound, Lock, Eye, EyeOff, Check, X,
} from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import type { AuthUser } from "@/contexts/AuthContext";
import { apiFetch } from "@/lib/apiFetch";
import { useLanguage, LOCALE_NAMES } from "@/contexts/LanguageContext";
import type { Locale } from "@/contexts/LanguageContext";

// ─── Password strength helpers ────────────────────────────────────────────────

const MIN_LEN_ADMIN  = parseInt(process.env.NEXT_PUBLIC_PASSWORD_MIN_LENGTH_ADMIN  ?? "16", 10);
const MIN_LEN_VIEWER = parseInt(process.env.NEXT_PUBLIC_PASSWORD_MIN_LENGTH_VIEWER ?? "12", 10);

interface StrengthRule { label: string; ok: boolean }

function usePasswordStrength(
  password: string,
  role: string,
  t: (key: string, vars?: Record<string, string | number>) => string,
): StrengthRule[] {
  const minLen = role === "ADMIN" ? MIN_LEN_ADMIN : MIN_LEN_VIEWER;
  return useMemo(() => [
    { label: t("profile.password_rule_min_len", { n: minLen }), ok: password.length >= minLen },
    { label: t("profile.password_rule_uppercase"),               ok: /[A-Z]/.test(password) },
    { label: t("profile.password_rule_lowercase"),               ok: /[a-z]/.test(password) },
    { label: t("profile.password_rule_number"),                  ok: /[0-9]/.test(password) },
    { label: t("profile.password_rule_special"),                 ok: /[^A-Za-z0-9]/.test(password) },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [password, minLen, t]);
}

function StrengthBar({ rules }: { rules: StrengthRule[] }) {
  const passed = rules.filter((r) => r.ok).length;
  const pct = (passed / rules.length) * 100;
  const color =
    pct <= 20 ? "bg-red-500" :
    pct <= 40 ? "bg-orange-500" :
    pct <= 60 ? "bg-yellow-500" :
    pct <= 80 ? "bg-blue-500" :
                "bg-emerald-500";
  return (
    <div className="space-y-2">
      <div className="h-1.5 w-full rounded-full bg-slate-200 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-300 ${color}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <ul className="space-y-1">
        {rules.map((r) => (
          <li key={r.label} className={`flex items-center gap-1.5 text-xs ${r.ok ? "text-emerald-600" : "text-slate-400"}`}>
            {r.ok
              ? <Check className="h-3 w-3 flex-shrink-0" />
              : <X    className="h-3 w-3 flex-shrink-0" />}
            {r.label}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ─── Profile page ─────────────────────────────────────────────────────────────

export default function ProfilePage() {
  const { user, applySession } = useAuth();
  const { locale, setLocale, t } = useLanguage();
  const [langSaved, setLangSaved] = useState(false);

  // ── MFA state ──
  const [qrDataUrl,  setQrDataUrl]  = useState<string | null>(null);
  const [mfaSecret,  setMfaSecret]  = useState<string | null>(null);
  const [mfaCode,    setMfaCode]    = useState("");
  const [mfaLoading, setMfaLoading] = useState(false);
  const [mfaEnabling,setMfaEnabling]= useState(false);
  const [mfaJustEnabled, setMfaJustEnabled] = useState(false); // activated in THIS session
  const [mfaError,   setMfaError]   = useState<string | null>(null);

  // MFA is considered active if the backend says so OR if we just enabled it
  const mfaActive = (user?.mfa_enabled ?? false) || mfaJustEnabled;

  // ── Password change state ──
  const [currentPwd,  setCurrentPwd]  = useState("");
  const [newPwd,      setNewPwd]      = useState("");
  const [confirmPwd,  setConfirmPwd]  = useState("");
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNew,     setShowNew]     = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [pwdSaving,   setPwdSaving]   = useState(false);
  const [pwdSuccess,  setPwdSuccess]  = useState(false);
  const [pwdErrors,   setPwdErrors]   = useState<string[]>([]);

  const rules = usePasswordStrength(newPwd, user?.role ?? "VIEWER", t);
  const allRulesPassed = rules.every((r) => r.ok);
  const passwordsMatch = newPwd === confirmPwd && confirmPwd.length > 0;

  // ── Language handler ──
  const handleLanguageChange = (l: Locale) => {
    setLocale(l);
    setLangSaved(true);
    setTimeout(() => setLangSaved(false), 2000);
  };

  // ── MFA handlers ──
  const handleSetup = async () => {
    setMfaLoading(true); setMfaError(null);
    try {
      const res = await apiFetch("/api/auth/mfa/setup", { method: "POST" });
      if (!res.ok) throw new Error(`Error ${res.status}`);
      const data: { secret: string; qrDataUrl: string } = await res.json();
      setQrDataUrl(data.qrDataUrl);
      setMfaSecret(data.secret);
    } catch (err) {
      setMfaError(err instanceof Error ? err.message : t("profile.mfa_qr_error"));
    } finally {
      setMfaLoading(false);
    }
  };

  const handleEnable = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!mfaSecret) return;
    setMfaEnabling(true); setMfaError(null);
    try {
      const res = await apiFetch("/api/auth/mfa/enable", {
        method: "POST",
        body: JSON.stringify({ code: mfaCode, secret: mfaSecret }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error ?? `Error ${res.status}`);
      }
      // Update the session so user.mfa_enabled = true is reflected immediately
      if (data.token && data.user && user) {
        applySession(data.token, data.user as AuthUser, data.deviceToken);
      }
      setMfaJustEnabled(true);
      setQrDataUrl(null); setMfaSecret(null); setMfaCode("");
    } catch (err) {
      setMfaError(err instanceof Error ? err.message : t("profile.mfa_enable_error"));
    } finally {
      setMfaEnabling(false);
    }
  };

  // ── Password change handler ──
  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPwdErrors([]);
    if (!passwordsMatch) {
      setPwdErrors([t("profile.passwords_no_match")]);
      return;
    }
    if (!allRulesPassed) {
      setPwdErrors([t("profile.password_policy_error")]);
      return;
    }
    setPwdSaving(true);
    try {
      const res = await apiFetch("/api/profile/change-password", {
        method: "POST",
        body: JSON.stringify({ currentPassword: currentPwd, newPassword: newPwd }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (data.details) { setPwdErrors(data.details); return; }
        setPwdErrors([data.message ?? data.error ?? t("profile.password_change_error")]);
        return;
      }
      setPwdSuccess(true);
      setCurrentPwd(""); setNewPwd(""); setConfirmPwd("");
      setTimeout(() => setPwdSuccess(false), 5000);
    } catch {
      setPwdErrors([t("profile.connection_error")]);
    } finally {
      setPwdSaving(false);
    }
  };

  // ── Role badge ──
  const roleBadgeClass =
    user?.role === "ADMIN"   ? "bg-red-100 text-red-700"    :
    user?.role === "AUDITOR" ? "bg-amber-100 text-amber-700" :
                               "bg-slate-100 text-slate-500";

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white px-8 py-5">
        <div className="flex items-center gap-3">
          <User className="h-5 w-5 text-indigo-500" />
          <div>
            <h1 className="text-xl font-bold text-slate-900">{t("profile.title")}</h1>
            <p className="text-sm text-slate-500 mt-0.5">{t("profile.subtitle")}</p>
          </div>
        </div>
      </header>

      <div className="px-8 py-8 max-w-2xl mx-auto space-y-6">

        {/* ── User info ── */}
        <div className="rounded-2xl bg-white shadow-sm ring-1 ring-slate-200 p-6">
          <div className="flex items-center gap-4">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-indigo-100">
              <User className="h-7 w-7 text-indigo-600" />
            </div>
            <div>
              <p className="text-lg font-bold text-slate-900">{user?.username ?? "—"}</p>
              <p className="text-sm text-slate-500">{user?.email ?? "—"}</p>
              <span className={`mt-1 inline-block rounded px-2 py-0.5 text-xs font-semibold ${roleBadgeClass}`}>
                {user?.role}
              </span>
            </div>
          </div>
        </div>

        {/* ── Change password ── */}
        <div className="rounded-2xl bg-white shadow-sm ring-1 ring-slate-200 overflow-hidden">
          <div className="border-b border-slate-200 px-6 py-4 flex items-center gap-2">
            <Lock className="h-4 w-4 text-slate-400" />
            <h2 className="text-sm font-semibold text-slate-700">{t("profile.change_password_section")}</h2>
            <span className="ml-auto text-xs text-slate-400">{t("profile.local_users_only")}</span>
          </div>
          <div className="p-6">
            {pwdSuccess ? (
              <div className="flex items-center gap-3 rounded-xl bg-emerald-50 border border-emerald-200 px-4 py-4">
                <CheckCircle2 className="h-6 w-6 text-emerald-600 flex-shrink-0" />
                <div>
                  <p className="text-sm font-semibold text-emerald-800">{t("profile.password_updated")}</p>
                  <p className="text-xs text-emerald-600 mt-0.5">{t("profile.password_updated_hint")}</p>
                </div>
              </div>
            ) : (
              <form onSubmit={handleChangePassword} className="space-y-4">

                {/* Current password */}
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1.5">
                    {t("profile.current_password")}
                  </label>
                  <div className="relative">
                    <input
                      type={showCurrent ? "text" : "password"}
                      required autoComplete="current-password"
                      value={currentPwd} onChange={(e) => setCurrentPwd(e.target.value)}
                      className="w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2.5 pr-10 text-sm focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                      placeholder="••••••••••••"
                    />
                    <button type="button" onClick={() => setShowCurrent((v) => !v)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
                      {showCurrent ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </div>

                {/* New password */}
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1.5">
                    {t("profile.new_password")}
                  </label>
                  <div className="relative">
                    <input
                      type={showNew ? "text" : "password"}
                      required autoComplete="new-password"
                      value={newPwd} onChange={(e) => setNewPwd(e.target.value)}
                      className="w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2.5 pr-10 text-sm focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                      placeholder="••••••••••••"
                    />
                    <button type="button" onClick={() => setShowNew((v) => !v)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
                      {showNew ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                  {/* Strength indicator */}
                  {newPwd.length > 0 && (
                    <div className="mt-3">
                      <StrengthBar rules={rules} />
                    </div>
                  )}
                </div>

                {/* Confirm password */}
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1.5">
                    {t("profile.confirm_password")}
                  </label>
                  <div className="relative">
                    <input
                      type={showConfirm ? "text" : "password"}
                      required autoComplete="new-password"
                      value={confirmPwd} onChange={(e) => setConfirmPwd(e.target.value)}
                      className={`w-full rounded-lg border bg-slate-50 px-3 py-2.5 pr-10 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-100 ${
                        confirmPwd.length > 0
                          ? passwordsMatch
                            ? "border-emerald-400 focus:border-emerald-400"
                            : "border-red-400 focus:border-red-400"
                          : "border-slate-300 focus:border-indigo-400"
                      }`}
                      placeholder="••••••••••••"
                    />
                    <button type="button" onClick={() => setShowConfirm((v) => !v)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
                      {showConfirm ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                  {confirmPwd.length > 0 && (
                    <p className={`mt-1 text-xs ${passwordsMatch ? "text-emerald-600" : "text-red-500"}`}>
                      {passwordsMatch ? t("profile.passwords_match") : t("profile.passwords_no_match")}
                    </p>
                  )}
                </div>

                {/* Errors */}
                {pwdErrors.length > 0 && (
                  <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 space-y-1">
                    {pwdErrors.map((e, i) => (
                      <div key={i} className="flex items-start gap-2 text-sm text-red-600">
                        <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" />{e}
                      </div>
                    ))}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={pwdSaving || !currentPwd || !allRulesPassed || !passwordsMatch}
                  className="flex items-center gap-2 rounded-lg bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50 transition-colors"
                >
                  {pwdSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Lock className="h-4 w-4" />}
                  {pwdSaving ? t("profile.password_saving") : t("profile.change_password_button")}
                </button>
              </form>
            )}
          </div>
        </div>

        {/* ── MFA card ── */}
        <div className="rounded-2xl bg-white shadow-sm ring-1 ring-slate-200 overflow-hidden">
          <div className="border-b border-slate-200 px-6 py-4 flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-slate-400" />
            <h2 className="text-sm font-semibold text-slate-700">{t("profile.mfa_section")}</h2>
          </div>
          <div className="p-6 space-y-4">

            {mfaActive ? (
              <div className="flex items-center gap-3 rounded-xl bg-emerald-50 border border-emerald-200 px-4 py-4">
                <CheckCircle2 className="h-6 w-6 text-emerald-600 flex-shrink-0" />
                <div>
                  <p className="text-sm font-semibold text-emerald-800">
                    {mfaJustEnabled ? t("profile.mfa_just_enabled") : t("profile.mfa_enabled_ok")}
                  </p>
                  <p className="text-xs text-emerald-600 mt-0.5">
                    {mfaJustEnabled
                      ? t("profile.mfa_just_enabled_hint")
                      : t("profile.mfa_already_enabled_hint")}
                  </p>
                </div>
              </div>
            ) : !qrDataUrl ? (
              <>
                <div className="flex items-start gap-3 rounded-xl bg-slate-50 border border-slate-200 px-4 py-3">
                  <ShieldOff className="h-5 w-5 text-slate-400 flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="text-sm font-medium text-slate-700">{t("profile.mfa_not_configured")}</p>
                    <p className="text-xs text-slate-500 mt-0.5">{t("profile.mfa_not_configured_hint")}</p>
                  </div>
                </div>
                {mfaError && (
                  <div className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
                    <AlertTriangle className="h-4 w-4 flex-shrink-0" />{mfaError}
                  </div>
                )}
                <button onClick={handleSetup} disabled={mfaLoading}
                  className="flex items-center gap-2 rounded-lg bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-60 transition-colors">
                  {mfaLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <QrCode className="h-4 w-4" />}
                  {mfaLoading ? t("profile.mfa_generating_qr") : t("profile.mfa_configure")}
                </button>
              </>
            ) : (
              <>
                <div className="flex items-start gap-3 rounded-xl bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-800">
                  <ShieldCheck className="h-5 w-5 text-amber-500 flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="font-semibold">{t("profile.mfa_scan_instruction")}</p>
                    <p className="text-xs mt-0.5">{t("profile.mfa_scan_hint")}</p>
                  </div>
                </div>
                <div className="flex flex-col items-center gap-3">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={qrDataUrl} alt="QR Code MFA" className="h-48 w-48 rounded-xl border border-slate-200" />
                  <div className="text-center">
                    <p className="text-xs text-slate-500">{t("profile.mfa_secret_label")}</p>
                    <code className="text-xs font-mono text-indigo-700 bg-indigo-50 rounded px-2 py-0.5 break-all">
                      {mfaSecret}
                    </code>
                  </div>
                </div>
                {mfaError && (
                  <div className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
                    <AlertTriangle className="h-4 w-4 flex-shrink-0" />{mfaError}
                  </div>
                )}
                <form onSubmit={handleEnable} className="flex gap-3 items-end">
                  <div className="flex-1">
                    <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1.5">
                      {t("profile.mfa_totp_label")}
                    </label>
                    <input
                      type="text" inputMode="numeric" pattern="[0-9]{6}" maxLength={6}
                      required autoFocus placeholder="123456"
                      value={mfaCode} onChange={(e) => setMfaCode(e.target.value.replace(/\D/g, ""))}
                      className="w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2.5 text-center text-xl font-mono tracking-widest focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                    />
                  </div>
                  <button type="submit" disabled={mfaEnabling || mfaCode.length !== 6}
                    className="flex items-center gap-2 rounded-lg bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-60 transition-colors">
                    {mfaEnabling ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                    {mfaEnabling ? t("profile.mfa_activating") : t("profile.mfa_activate")}
                  </button>
                </form>
              </>
            )}
          </div>
        </div>

        {/* ── Language Preference ──────────────────────────────────────── */}
        <section className="rounded-2xl border border-slate-200 bg-white p-6 space-y-4">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-50">
              <svg className="h-4 w-4 text-indigo-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 21l5.25-11.25L21 21m-9-3h7.5M3 5.621a48.474 48.474 0 016-.371m0 0c1.12 0 2.233.038 3.334.114M9 5.25V3m3.334 2.364C11.176 10.658 7.69 15.08 3 17.502m9.334-12.138c.896.061 1.785.147 2.666.257m-4.589 8.495a18.023 18.023 0 01-3.827-5.802" />
              </svg>
            </div>
            <h2 className="text-sm font-semibold text-slate-700">{t("profile.language_section")}</h2>
          </div>
          <div className="space-y-2">
            <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
              {t("profile.language_label")}
            </label>
            <select
              value={locale}
              onChange={(e) => handleLanguageChange(e.target.value as Locale)}
              className="w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2.5 text-sm text-slate-800 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
            >
              {(Object.entries(LOCALE_NAMES) as [Locale, string][]).map(([code, name]) => (
                <option key={code} value={code}>{name}</option>
              ))}
            </select>
            {langSaved && (
              <p className="text-xs text-emerald-600">{t("profile.language_saved")}</p>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/contexts/AuthContext";
import { apiFetch } from "@/lib/apiFetch";
import { useLanguage, LOCALE_NAMES } from "@/contexts/LanguageContext";
import type { Locale } from "@/contexts/LanguageContext";
import {
  Server, Loader2, AlertTriangle, Eye, EyeOff,
  ShieldCheck, ShieldAlert, QrCode, CheckCircle2,
} from "lucide-react";

// Microsoft logo SVG (inline — no external dep)
function MicrosoftLogo() {
  return (
    <svg width="18" height="18" viewBox="0 0 21 21" xmlns="http://www.w3.org/2000/svg" aria-hidden>
      <rect x="1" y="1" width="9" height="9" fill="#f25022"/>
      <rect x="11" y="1" width="9" height="9" fill="#7fba00"/>
      <rect x="1" y="11" width="9" height="9" fill="#00a4ef"/>
      <rect x="11" y="11" width="9" height="9" fill="#ffb900"/>
    </svg>
  );
}

// ─── Types ────────────────────────────────────────────────────────────────────

type LoginStep =
  | "credentials"       // Email + password form
  | "mfa_verify"        // Enter TOTP code (MFA already enabled)
  | "mfa_suggest"       // Non-admin: suggest setting up MFA (skippable)
  | "mfa_setup_qr"      // Show QR code to scan (admin: mandatory / non-admin: voluntary)
  | "mfa_setup_verify"; // Enter TOTP code to confirm MFA setup

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function LoginPage() {
  const { login, applySession } = useAuth();
  const { locale, setLocale, t } = useLanguage();
  const router = useRouter();

  const ttlDays = process.env.NEXT_PUBLIC_TRUSTED_DEVICE_TTL_DAYS || "30";

  const [themeColor,  setThemeColor]  = useState("#0f172a");
  const [accentColor, setAccentColor] = useState("#3b82f6");
  const [companyName, setCompanyName] = useState("CMDB Platform");
  const [hasLogo,     setHasLogo]     = useState(false);

  // ── SSO status ────────────────────────────────────────────────────────────
  const [ssoEnabled,   setSsoEnabled]   = useState(false);
  const [ssoLoading,   setSsoLoading]   = useState(false);

  // ── State ──
  const [step,        setStep]        = useState<LoginStep>("credentials");
  const [email,       setEmail]       = useState("");
  const [password,    setPassword]    = useState("");
  const [showPwd,     setShowPwd]     = useState(false);
  const [loading,     setLoading]     = useState(false);
  const [error,       setError]       = useState<string | null>(null);

  // MFA verify (existing TOTP)
  const [mfaCode,     setMfaCode]     = useState("");
  const [trustDevice, setTrustDevice] = useState(false);

  // MFA setup wizard
  const [isAdminSetup,    setIsAdminSetup]    = useState(false); // admin = mandatory (no skip)
  const [qrLoading,       setQrLoading]       = useState(false);
  const [qrDataUrl,       setQrDataUrl]       = useState("");
  const [mfaSecret,       setMfaSecret]       = useState("");
  const [setupCode,       setSetupCode]       = useState("");
  const [setupTrustDevice,setSetupTrustDevice]= useState(false);
  const [showSecret,      setShowSecret]      = useState(false);

  // ── Load SSO status + handle error from URL ────────────────────────────────
  useEffect(() => {
    // Check if SSO is enabled on this instance
    fetch(`${process.env.NEXT_PUBLIC_API_URL ?? ""}/api/auth/sso/status`)
      .then((r) => r.ok ? r.json() : null)
      .then((data: { enabled: boolean } | null) => { if (data?.enabled) setSsoEnabled(true); })
      .catch(() => {/* SSO disabled or unreachable — ignore */});

    // Read SSO error from URL (backend redirects with ?error=sso_*)
    const params = new URLSearchParams(window.location.search);
    const urlError = params.get("error");
    if (urlError === "sso_failed") {
      setError(t("login.sso_error"));
    } else if (urlError === "sso_not_provisioned") {
      setError(t("login.sso_not_provisioned"));
    } else if (urlError === "sso_account_disabled") {
      setError(t("login.sso_disabled"));
    }
    if (urlError) {
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Load theme settings from API ───────────────────────────────────────
  useEffect(() => {
    fetch(`${process.env.NEXT_PUBLIC_API_URL ?? ""}/api/settings/theme`)
      .then((r) => r.ok ? r.json() : null)
      .then((d: { sidebarBg: string; accentColor: string; companyName: string; hasLogo: boolean } | null) => {
        if (!d) return;
        setThemeColor(d.sidebarBg);
        setAccentColor(d.accentColor);
        setCompanyName(d.companyName);
        setHasLogo(d.hasLogo);
      })
      .catch(() => { /* use defaults */ });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Load QR when entering setup screen ────────────────────────────────────
  useEffect(() => {
    if (step !== "mfa_setup_qr") return;
    setQrLoading(true);
    setError(null);
    apiFetch("/api/auth/mfa/setup", { method: "POST" })
      .then((r) => r.json())
      .then(({ secret, qrDataUrl: url }: { secret: string; qrDataUrl: string }) => {
        setMfaSecret(secret);
        setQrDataUrl(url);
      })
      .catch(() => setError(t("login.error_qr_failed")))
      .finally(() => setQrLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  // ── Credential submit ─────────────────────────────────────────────────────
  const handleCredentials = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await login(email, password);
      router.replace("/");
    } catch (err) {
      const msg = err instanceof Error ? err.message : t("login.error_invalid");
      if (msg === "MFA_REQUIRED") {
        setStep("mfa_verify");
      } else if (msg === "MFA_SETUP_REQUIRED") {
        setIsAdminSetup(true);
        setStep("mfa_setup_qr");
      } else if (msg === "MFA_SETUP_SUGGESTED") {
        setIsAdminSetup(false);
        setStep("mfa_suggest");
      } else {
        setError(msg);
      }
    } finally {
      setLoading(false);
    }
  };

  // ── MFA verify submit (existing TOTP) ─────────────────────────────────────
  const handleMfaVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await login(email, password, { mfaCode, trustDevice });
      router.replace("/");
    } catch (err) {
      const msg = err instanceof Error ? err.message : t("login.error_mfa");
      if (msg === "INVALID_MFA_CODE") {
        setError(t("login.error_mfa_code"));
      } else {
        setError(msg);
      }
    } finally {
      setLoading(false);
    }
  };

  // ── MFA setup verify submit ───────────────────────────────────────────────
  const handleSetupVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch("/api/auth/mfa/enable", {
        method: "POST",
        body:   JSON.stringify({ code: setupCode, secret: mfaSecret, trustDevice: setupTrustDevice }),
      });
      const data = await res.json() as { token?: string; user?: Parameters<typeof applySession>[1]; deviceToken?: string; error?: string };
      if (!res.ok) {
        setError(data.error ?? t("login.error_mfa"));
        return;
      }
      if (!data.token || !data.user) {
        setError(t("login.error_invalid"));
        return;
      }
      applySession(data.token ?? null, data.user, data.deviceToken);
      router.replace("/");
    } catch {
      setError(t("login.error_qr_failed"));
    } finally {
      setLoading(false);
    }
  };

  // ── Skip MFA suggestion (non-admin already has token stored) ─────────────
  const handleSkipSuggestion = () => {
    router.replace("/");
  };

  // ── Reset to credentials ──────────────────────────────────────────────────
  const resetToCredentials = () => {
    setStep("credentials");
    setMfaCode("");
    setTrustDevice(false);
    setError(null);
  };

  // ── Header metadata per step ──────────────────────────────────────────────
  const headerMeta: Record<LoginStep, { icon: React.ReactNode; subtitle: string }> = {
    credentials: {
      icon:     <Server className="h-7 w-7 text-white" />,
      subtitle: "Configuration Management Database",
    },
    mfa_verify: {
      icon:     <ShieldCheck className="h-7 w-7 text-white" />,
      subtitle: t("login.mfa_verify_header"),
    },
    mfa_suggest: {
      icon:     <ShieldAlert className="h-7 w-7 text-white" />,
      subtitle: t("login.protect_account"),
    },
    mfa_setup_qr: {
      icon:     <QrCode className="h-7 w-7 text-white" />,
      subtitle: isAdminSetup ? t("login.setup_subtitle_admin") : t("login.setup_subtitle_user"),
    },
    mfa_setup_verify: {
      icon:     <ShieldCheck className="h-7 w-7 text-white" />,
      subtitle: t("login.verify_totp_header"),
    },
  };

  const meta = headerMeta[step];

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-sm">
        {/* Card */}
        <div className="rounded-2xl bg-white shadow-xl ring-1 ring-slate-200 overflow-hidden">

          {/* Header band */}
          <div className="px-8 py-7 text-center" style={{ backgroundColor: themeColor }}>
            <div className="inline-flex h-14 w-14 items-center justify-center bg-white/20 mb-3 mx-auto">
              {hasLogo
                // eslint-disable-next-line @next/next/no-img-element
                ? <img src={`${process.env.NEXT_PUBLIC_API_URL ?? ""}/api/settings/logo`} alt={companyName} className="h-10 w-10 object-contain" />
                : meta.icon
              }
            </div>
            <h1 className="text-xl font-bold text-white">{companyName}</h1>
            <p className="text-xs text-white/70 mt-1">{meta.subtitle}</p>
            {step === "credentials" && (
              <p className="text-xs text-white/50 mt-1">{t("login.ldap_hint")}</p>
            )}
          </div>

          {/* Language selector */}
          <div className="flex justify-end px-4 pt-2 pb-0">
            <select
              value={locale}
              onChange={(e) => setLocale(e.target.value as Locale)}
              className="rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[11px] text-slate-500 focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-200 cursor-pointer"
            >
              {(Object.entries(LOCALE_NAMES) as [Locale, string][]).map(([code, name]) => (
                <option key={code} value={code}>{name}</option>
              ))}
            </select>
          </div>

          {/* Body */}
          <div className="px-8 py-8">

            {/* ── Error banner ─────────────────────────────────────────────── */}
            {error && (
              <div className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600 mb-5">
                <AlertTriangle className="h-4 w-4 flex-shrink-0" />
                {error}
              </div>
            )}

            {/* ── Step: credentials ─────────────────────────────────────────── */}
            {step === "credentials" && (
              <form onSubmit={handleCredentials} className="space-y-5">
                <p className="text-sm font-semibold text-slate-700 mb-5 text-center">
                  {t("login.credentials_prompt")}
                </p>
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1.5">{t("login.email_label")}</label>
                  <input
                    type="email" required autoComplete="email" placeholder={t("login.email_placeholder")}
                    value={email} onChange={(e) => setEmail(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2.5 text-sm text-slate-800 placeholder:text-slate-400 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1.5">{t("login.password_label")}</label>
                  <div className="relative">
                    <input
                      type={showPwd ? "text" : "password"} required autoComplete="current-password" placeholder={t("login.password_placeholder")}
                      value={password} onChange={(e) => setPassword(e.target.value)}
                      className="w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2.5 pr-10 text-sm text-slate-800 placeholder:text-slate-400 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                    />
                    <button type="button" onClick={() => setShowPwd((v) => !v)}
                      title={showPwd ? t("login.hide_password") : t("login.show_password")}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
                      {showPwd ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </div>
                <button type="submit" disabled={loading}
                  className="flex w-full items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
                  style={{ backgroundColor: accentColor }}>
                  {loading && <Loader2 className="h-4 w-4 animate-spin" />}
                  {loading ? t("login.verifying") : t("login.submit")}
                </button>

                {/* ── Microsoft SSO button ────────────────────────────────── */}
                {ssoEnabled && (
                  <>
                    <div className="relative flex items-center gap-3 py-1">
                      <div className="flex-1 border-t border-slate-200" />
                      <span className="text-xs text-slate-400 uppercase tracking-wide">{t("login.sso_divider")}</span>
                      <div className="flex-1 border-t border-slate-200" />
                    </div>
                    <button
                      type="button"
                      disabled={ssoLoading}
                      onClick={() => {
                        setSsoLoading(true);
                        window.location.href = `${process.env.NEXT_PUBLIC_API_URL ?? ""}/api/auth/sso/microsoft`;
                      }}
                      className="flex w-full items-center justify-center gap-2.5 rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60 disabled:cursor-not-allowed transition-colors shadow-sm"
                    >
                      {ssoLoading
                        ? <><Loader2 className="h-4 w-4 animate-spin" />{t("login.sso_loading")}</>
                        : <><MicrosoftLogo />{t("login.sso_button")}</>
                      }
                    </button>
                  </>
                )}
              </form>
            )}

            {/* ── Step: mfa_verify ──────────────────────────────────────────── */}
            {step === "mfa_verify" && (
              <form onSubmit={handleMfaVerify} className="space-y-5">
                <p className="text-sm font-semibold text-slate-700 text-center">
                  {t("login.mfa_verify_subtitle")}
                </p>
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1.5">
                    {t("login.mfa_label")}
                  </label>
                  <input
                    type="text" inputMode="numeric" pattern="[0-9]{6}" maxLength={6}
                    required autoFocus placeholder="123456"
                    value={mfaCode} onChange={(e) => setMfaCode(e.target.value.replace(/\D/g, ""))}
                    className="w-full rounded-lg border border-indigo-300 bg-indigo-50 px-3 py-3 text-center text-2xl font-mono tracking-[0.5em] text-indigo-800 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                  />
                </div>
                {/* Trust device */}
                <label className="flex items-start gap-3 cursor-pointer group">
                  <input
                    type="checkbox" checked={trustDevice}
                    onChange={(e) => setTrustDevice(e.target.checked)}
                    className="mt-0.5 h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                  />
                  <span className="text-xs text-slate-600 group-hover:text-slate-800 leading-relaxed">
                    {t("login.trust_device", { days: ttlDays })}
                    <span className="block text-slate-400 mt-0.5">{t("login.trust_device_hint")}</span>
                  </span>
                </label>
                <button type="submit" disabled={loading || mfaCode.length !== 6}
                  className="flex w-full items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
                  style={{ backgroundColor: accentColor }}>
                  {loading && <Loader2 className="h-4 w-4 animate-spin" />}
                  {loading ? t("login.verifying") : t("login.verify_code")}
                </button>
                <button type="button" onClick={resetToCredentials}
                  className="w-full text-xs text-slate-400 hover:text-slate-600 underline text-center mt-1">
                  {t("login.back_to_login")}
                </button>
              </form>
            )}

            {/* ── Step: mfa_suggest ─────────────────────────────────────────── */}
            {step === "mfa_suggest" && (
              <div className="space-y-5">
                <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
                  <p className="font-semibold mb-1">{t("login.mfa_suggest_recommend")}</p>
                  <p className="text-amber-700 text-xs leading-relaxed">
                    {t("login.mfa_suggest_body")}
                  </p>
                </div>
                <button
                  onClick={() => { setIsAdminSetup(false); setStep("mfa_setup_qr"); }}
                  className="flex w-full items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold text-white transition-colors"
                  style={{ backgroundColor: accentColor }}>
                  <ShieldCheck className="h-4 w-4" /> {t("login.setup_mfa_now")}
                </button>
                <button
                  onClick={handleSkipSuggestion}
                  className="w-full rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-50 transition-colors">
                  {t("login.skip_for_now")}
                </button>
              </div>
            )}

            {/* ── Step: mfa_setup_qr ────────────────────────────────────────── */}
            {step === "mfa_setup_qr" && (
              <div className="space-y-4">
                {isAdminSetup && (
                  <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-700 leading-relaxed">
                    <span className="font-semibold block mb-0.5">{t("login.mandatory_mfa_title")}</span>
                    {t("login.mandatory_mfa_body")}
                  </div>
                )}
                <p className="text-sm text-slate-600 text-center">
                  {t("login.scan_qr_prompt")}
                  <span className="block text-xs text-slate-400 mt-0.5">(Google Authenticator, Authy, Microsoft Authenticator…)</span>
                </p>

                {/* QR code */}
                <div className="flex justify-center">
                  {qrLoading ? (
                    <div className="flex h-40 w-40 items-center justify-center rounded-xl border border-slate-200">
                      <Loader2 className="h-8 w-8 animate-spin text-slate-400" />
                    </div>
                  ) : qrDataUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={qrDataUrl} alt="TOTP QR code" className="h-44 w-44 rounded-xl border border-slate-200 p-1" />
                  ) : null}
                </div>

                {/* Manual secret entry */}
                {mfaSecret && (
                  <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400 mb-1">
                      {t("login.manual_key_label")}
                    </p>
                    <div className="flex items-center gap-2">
                      <code className={`flex-1 text-xs font-mono text-slate-700 break-all ${showSecret ? "" : "blur-sm select-none"}`}>
                        {mfaSecret}
                      </code>
                      <button type="button" onClick={() => setShowSecret((v) => !v)}
                        className="text-slate-400 hover:text-slate-600 flex-shrink-0">
                        {showSecret ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                      </button>
                    </div>
                  </div>
                )}

                <button
                  onClick={() => setStep("mfa_setup_verify")}
                  disabled={!qrDataUrl || qrLoading}
                  className="flex w-full items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  style={{ backgroundColor: accentColor }}>
                  {t("login.scanned_continue")}
                </button>
                {!isAdminSetup && (
                  <button type="button" onClick={handleSkipSuggestion}
                    className="w-full text-xs text-slate-400 hover:text-slate-600 underline text-center">
                    {t("login.skip_for_now")}
                  </button>
                )}
              </div>
            )}

            {/* ── Step: mfa_setup_verify ────────────────────────────────────── */}
            {step === "mfa_setup_verify" && (
              <form onSubmit={handleSetupVerify} className="space-y-5">
                <div className="flex items-center justify-center gap-2 text-sm text-slate-600">
                  <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                  {t("login.app_configured")}
                </div>
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1.5">
                    {t("login.mfa_label")}
                  </label>
                  <input
                    type="text" inputMode="numeric" pattern="[0-9]{6}" maxLength={6}
                    required autoFocus placeholder="123456"
                    value={setupCode} onChange={(e) => setSetupCode(e.target.value.replace(/\D/g, ""))}
                    className="w-full rounded-lg border border-indigo-300 bg-indigo-50 px-3 py-3 text-center text-2xl font-mono tracking-[0.5em] text-indigo-800 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                  />
                </div>
                {/* Trust device */}
                <label className="flex items-start gap-3 cursor-pointer group">
                  <input
                    type="checkbox" checked={setupTrustDevice}
                    onChange={(e) => setSetupTrustDevice(e.target.checked)}
                    className="mt-0.5 h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                  />
                  <span className="text-xs text-slate-600 group-hover:text-slate-800 leading-relaxed">
                    {t("login.trust_device", { days: ttlDays })}
                    <span className="block text-slate-400 mt-0.5">{t("login.trust_device_hint")}</span>
                  </span>
                </label>
                <button type="submit" disabled={loading || setupCode.length !== 6}
                  className="flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-60 disabled:cursor-not-allowed transition-colors">
                  {loading && <Loader2 className="h-4 w-4 animate-spin" />}
                  {loading ? t("login.activating") : t("login.enable_mfa_btn")}
                </button>
                <button type="button" onClick={() => setStep("mfa_setup_qr")}
                  className="w-full text-xs text-slate-400 hover:text-slate-600 underline text-center">
                  {t("login.back_to_qr")}
                </button>
                {!isAdminSetup && (
                  <button type="button" onClick={handleSkipSuggestion}
                    className="w-full text-xs text-slate-400 hover:text-slate-600 underline text-center">
                    {t("login.skip_for_now")}
                  </button>
                )}
              </form>
            )}

          </div>
        </div>

        <div className="text-center mt-4">
          <Link href="/privacy" className="text-xs text-slate-400 hover:text-slate-600 transition-colors">
            {t("login.privacy_link")}
          </Link>
        </div>
      </div>
    </div>
  );
}

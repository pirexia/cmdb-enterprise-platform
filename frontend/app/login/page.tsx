"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
import { apiFetch } from "@/lib/apiFetch";
import { useLanguage, LOCALE_NAMES } from "@/contexts/LanguageContext";
import type { Locale } from "@/contexts/LanguageContext";
import {
  Server, Loader2, AlertTriangle, Eye, EyeOff,
  ShieldCheck, ShieldAlert, QrCode, CheckCircle2,
} from "lucide-react";

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
  const { locale, setLocale } = useLanguage();
  const router = useRouter();

  const companyName = process.env.NEXT_PUBLIC_COMPANY_NAME || "CMDB Platform";
  const themeColor  = process.env.NEXT_PUBLIC_THEME_COLOR  || "#4f46e5";
  const ttlDays     = process.env.NEXT_PUBLIC_TRUSTED_DEVICE_TTL_DAYS || "30";

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
      .catch(() => setError("No se pudo cargar el código QR. Intenta de nuevo."))
      .finally(() => setQrLoading(false));
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
      const msg = err instanceof Error ? err.message : "Error al iniciar sesión";
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
      const msg = err instanceof Error ? err.message : "Código incorrecto";
      if (msg === "INVALID_MFA_CODE") {
        setError("Código incorrecto. Verifica tu aplicación TOTP.");
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
        setError(data.error ?? "Error al activar MFA");
        return;
      }
      if (!data.token || !data.user) {
        setError("Respuesta inesperada del servidor");
        return;
      }
      applySession(data.token, data.user, data.deviceToken);
      router.replace("/");
    } catch {
      setError("Error de conexión. Intenta de nuevo.");
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
      subtitle: "Verificación en dos pasos (MFA)",
    },
    mfa_suggest: {
      icon:     <ShieldAlert className="h-7 w-7 text-white" />,
      subtitle: "Protege tu cuenta",
    },
    mfa_setup_qr: {
      icon:     <QrCode className="h-7 w-7 text-white" />,
      subtitle: isAdminSetup ? "Configuración obligatoria de MFA" : "Configurar autenticación MFA",
    },
    mfa_setup_verify: {
      icon:     <ShieldCheck className="h-7 w-7 text-white" />,
      subtitle: "Verifica tu aplicación TOTP",
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
            <div className="inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-white/20 backdrop-blur-sm mb-3">
              {meta.icon}
            </div>
            <h1 className="text-xl font-bold text-white">{companyName}</h1>
            <p className="text-xs text-white/70 mt-1">{meta.subtitle}</p>
            {step === "credentials" && (
              <p className="text-xs text-white/50 mt-1">Soporta credenciales corporativas</p>
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
                  Accede con tus credenciales
                </p>
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1.5">Email</label>
                  <input
                    type="email" required autoComplete="email" placeholder="usuario@empresa.com"
                    value={email} onChange={(e) => setEmail(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2.5 text-sm text-slate-800 placeholder:text-slate-400 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1.5">Contraseña</label>
                  <div className="relative">
                    <input
                      type={showPwd ? "text" : "password"} required autoComplete="current-password" placeholder="••••••••"
                      value={password} onChange={(e) => setPassword(e.target.value)}
                      className="w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2.5 pr-10 text-sm text-slate-800 placeholder:text-slate-400 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                    />
                    <button type="button" onClick={() => setShowPwd((v) => !v)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
                      {showPwd ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </div>
                <button type="submit" disabled={loading}
                  className="flex w-full items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-60 disabled:cursor-not-allowed transition-colors">
                  {loading && <Loader2 className="h-4 w-4 animate-spin" />}
                  {loading ? "Verificando…" : "Iniciar sesión"}
                </button>
              </form>
            )}

            {/* ── Step: mfa_verify ──────────────────────────────────────────── */}
            {step === "mfa_verify" && (
              <form onSubmit={handleMfaVerify} className="space-y-5">
                <p className="text-sm font-semibold text-slate-700 text-center">
                  Introduce el código de tu aplicación TOTP
                </p>
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1.5">
                    Código TOTP (6 dígitos)
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
                    Confiar en este dispositivo durante <span className="font-semibold">{ttlDays} días</span>
                    <span className="block text-slate-400 mt-0.5">No se pedirá el código MFA en este equipo</span>
                  </span>
                </label>
                <button type="submit" disabled={loading || mfaCode.length !== 6}
                  className="flex w-full items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-60 disabled:cursor-not-allowed transition-colors">
                  {loading && <Loader2 className="h-4 w-4 animate-spin" />}
                  {loading ? "Verificando…" : "Verificar código"}
                </button>
                <button type="button" onClick={resetToCredentials}
                  className="w-full text-xs text-slate-400 hover:text-slate-600 underline text-center mt-1">
                  ← Volver al inicio de sesión
                </button>
              </form>
            )}

            {/* ── Step: mfa_suggest ─────────────────────────────────────────── */}
            {step === "mfa_suggest" && (
              <div className="space-y-5">
                <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
                  <p className="font-semibold mb-1">Recomendamos activar MFA</p>
                  <p className="text-amber-700 text-xs leading-relaxed">
                    La autenticación en dos pasos protege tu cuenta aunque tu contraseña sea comprometida.
                    Solo se te solicitará esta vez.
                  </p>
                </div>
                <button
                  onClick={() => { setIsAdminSetup(false); setStep("mfa_setup_qr"); }}
                  className="flex w-full items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700 transition-colors">
                  <ShieldCheck className="h-4 w-4" /> Configurar MFA ahora
                </button>
                <button
                  onClick={handleSkipSuggestion}
                  className="w-full rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-50 transition-colors">
                  Omitir por ahora
                </button>
              </div>
            )}

            {/* ── Step: mfa_setup_qr ────────────────────────────────────────── */}
            {step === "mfa_setup_qr" && (
              <div className="space-y-4">
                {isAdminSetup && (
                  <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-700 leading-relaxed">
                    <span className="font-semibold block mb-0.5">MFA obligatorio para administradores</span>
                    Debes configurar la verificación en dos pasos antes de acceder a la aplicación.
                  </div>
                )}
                <p className="text-sm text-slate-600 text-center">
                  Escanea este código QR con tu aplicación autenticadora
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
                      Clave manual
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
                  className="flex w-full items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
                  Ya lo escaneé → Continuar
                </button>
                {!isAdminSetup && (
                  <button type="button" onClick={handleSkipSuggestion}
                    className="w-full text-xs text-slate-400 hover:text-slate-600 underline text-center">
                    Omitir por ahora
                  </button>
                )}
              </div>
            )}

            {/* ── Step: mfa_setup_verify ────────────────────────────────────── */}
            {step === "mfa_setup_verify" && (
              <form onSubmit={handleSetupVerify} className="space-y-5">
                <div className="flex items-center justify-center gap-2 text-sm text-slate-600">
                  <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                  Aplicación configurada. Introduce el código para confirmar.
                </div>
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1.5">
                    Código de verificación (6 dígitos)
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
                    Confiar en este dispositivo durante <span className="font-semibold">{ttlDays} días</span>
                    <span className="block text-slate-400 mt-0.5">No se pedirá el código MFA en este equipo</span>
                  </span>
                </label>
                <button type="submit" disabled={loading || setupCode.length !== 6}
                  className="flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-60 disabled:cursor-not-allowed transition-colors">
                  {loading && <Loader2 className="h-4 w-4 animate-spin" />}
                  {loading ? "Activando…" : "Activar MFA y entrar"}
                </button>
                <button type="button" onClick={() => setStep("mfa_setup_qr")}
                  className="w-full text-xs text-slate-400 hover:text-slate-600 underline text-center">
                  ← Volver al código QR
                </button>
                {!isAdminSetup && (
                  <button type="button" onClick={handleSkipSuggestion}
                    className="w-full text-xs text-slate-400 hover:text-slate-600 underline text-center">
                    Omitir por ahora
                  </button>
                )}
              </form>
            )}

          </div>
        </div>

      </div>
    </div>
  );
}

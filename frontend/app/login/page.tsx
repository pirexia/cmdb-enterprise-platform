"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
import { Server, Loader2, AlertTriangle, Eye, EyeOff, ShieldCheck } from "lucide-react";

export default function LoginPage() {
  const { login } = useAuth();
  const router    = useRouter();

  const [email,       setEmail]       = useState("");
  const [password,    setPassword]    = useState("");
  const [showPwd,     setShowPwd]     = useState(false);
  const [loading,     setLoading]     = useState(false);
  const [error,       setError]       = useState<string | null>(null);
  // MFA second step
  const [mfaRequired, setMfaRequired] = useState(false);
  const [mfaCode,     setMfaCode]     = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await login(email, password, mfaRequired ? mfaCode : undefined);
      router.replace("/");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Error al iniciar sesión";
      if (msg === "MFA_REQUIRED") {
        setMfaRequired(true);
        setError(null);
      } else {
        setError(msg);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-sm">
        {/* Card */}
        <div className="rounded-2xl bg-white shadow-xl ring-1 ring-slate-200 overflow-hidden">
          {/* Header band */}
          <div className="bg-indigo-600 px-8 py-7 text-center">
            <div className="inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-white/20 backdrop-blur-sm mb-3">
              {mfaRequired
                ? <ShieldCheck className="h-7 w-7 text-white" />
                : <Server className="h-7 w-7 text-white" />}
            </div>
            <h1 className="text-xl font-bold text-white">CMDB Platform</h1>
            <p className="text-xs text-indigo-200 mt-1">
              {mfaRequired ? "Verificación en dos pasos (MFA)" : "Configuration Management Database"}
            </p>
          </div>

          {/* Form */}
          <form onSubmit={handleSubmit} className="px-8 py-8 space-y-5">
            <div>
              <p className="text-sm font-semibold text-slate-700 mb-5 text-center">
                {mfaRequired ? "Introduce el código de tu aplicación TOTP" : "Accede con tus credenciales"}
              </p>
            </div>

            {/* Error */}
            {error && (
              <div className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
                <AlertTriangle className="h-4 w-4 flex-shrink-0" />
                {error}
              </div>
            )}

            {!mfaRequired ? (
              <>
                {/* Email */}
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1.5">Email</label>
                  <input
                    type="email" required autoComplete="email" placeholder="admin@cmdb.local"
                    value={email} onChange={(e) => setEmail(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2.5 text-sm text-slate-800 placeholder:text-slate-400 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                  />
                </div>

                {/* Password */}
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
              </>
            ) : (
              /* MFA code input */
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
                <button type="button" onClick={() => { setMfaRequired(false); setMfaCode(""); setError(null); }}
                  className="mt-2 text-xs text-slate-400 hover:text-slate-600 underline">
                  ← Volver al inicio de sesión
                </button>
              </div>
            )}

            {/* Submit */}
            <button type="submit" disabled={loading}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-60 disabled:cursor-not-allowed transition-colors">
              {loading && <Loader2 className="h-4 w-4 animate-spin" />}
              {loading ? "Verificando…" : mfaRequired ? "Verificar código" : "Iniciar sesión"}
            </button>
          </form>
        </div>

        {/* Hint */}
        {!mfaRequired && (
          <div className="mt-4 rounded-xl border border-slate-200 bg-white px-5 py-4 text-xs text-slate-500">
            <p className="font-semibold text-slate-600 mb-2">Cuentas de prueba</p>
            <div className="space-y-1 font-mono">
              <p><span className="text-indigo-600">admin@cmdb.local</span> · admin123 <span className="text-red-500 font-sans font-medium">[ADMIN]</span></p>
              <p><span className="text-indigo-600">auditor@cmdb.local</span> · audit123 <span className="text-slate-500 font-sans">[VIEWER]</span></p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

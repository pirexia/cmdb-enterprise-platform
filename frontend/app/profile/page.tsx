"use client";

import { useState } from "react";
import { User, ShieldCheck, ShieldOff, QrCode, Loader2, AlertTriangle, CheckCircle2, KeyRound } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { apiFetch } from "@/lib/apiFetch";

export default function ProfilePage() {
  const { user } = useAuth();

  // MFA setup state
  const [qrDataUrl,  setQrDataUrl]  = useState<string | null>(null);
  const [mfaSecret,  setMfaSecret]  = useState<string | null>(null);
  const [mfaCode,    setMfaCode]    = useState("");
  const [loading,    setLoading]    = useState(false);
  const [enabling,   setEnabling]   = useState(false);
  const [success,    setSuccess]    = useState(false);
  const [error,      setError]      = useState<string | null>(null);

  const handleSetup = async () => {
    setLoading(true); setError(null);
    try {
      const res = await apiFetch("/api/auth/mfa/setup", { method: "POST" });
      if (!res.ok) throw new Error(`Error ${res.status}`);
      const data: { secret: string; qrDataUrl: string } = await res.json();
      setQrDataUrl(data.qrDataUrl);
      setMfaSecret(data.secret);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al generar el QR");
    } finally {
      setLoading(false);
    }
  };

  const handleEnable = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!mfaSecret) return;
    setEnabling(true); setError(null);
    try {
      const res = await apiFetch("/api/auth/mfa/enable", {
        method: "POST",
        body: JSON.stringify({ code: mfaCode, secret: mfaSecret }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? `Error ${res.status}`);
      }
      setSuccess(true);
      setQrDataUrl(null);
      setMfaSecret(null);
      setMfaCode("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al activar MFA");
    } finally {
      setEnabling(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white px-8 py-5">
        <div className="flex items-center gap-3">
          <User className="h-5 w-5 text-indigo-500" />
          <div>
            <h1 className="text-xl font-bold text-slate-900">Mi Perfil</h1>
            <p className="text-sm text-slate-500 mt-0.5">Configuración de cuenta y seguridad</p>
          </div>
        </div>
      </header>

      <div className="px-8 py-8 max-w-2xl mx-auto space-y-6">

        {/* User info card */}
        <div className="rounded-2xl bg-white shadow-sm ring-1 ring-slate-200 p-6">
          <div className="flex items-center gap-4">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-indigo-100">
              <User className="h-7 w-7 text-indigo-600" />
            </div>
            <div>
              <p className="text-lg font-bold text-slate-900">{user?.username ?? "—"}</p>
              <p className="text-sm text-slate-500">{user?.email ?? "—"}</p>
              <span className={`mt-1 inline-block rounded px-2 py-0.5 text-xs font-semibold ${user?.role === "ADMIN" ? "bg-red-100 text-red-700" : "bg-slate-100 text-slate-500"}`}>
                {user?.role}
              </span>
            </div>
          </div>
        </div>

        {/* MFA card */}
        <div className="rounded-2xl bg-white shadow-sm ring-1 ring-slate-200 overflow-hidden">
          <div className="border-b border-slate-200 px-6 py-4 flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-slate-400" />
            <h2 className="text-sm font-semibold text-slate-700">Autenticación de Dos Factores (TOTP / MFA)</h2>
          </div>
          <div className="p-6 space-y-4">

            {success ? (
              <div className="flex items-center gap-3 rounded-xl bg-emerald-50 border border-emerald-200 px-4 py-4">
                <CheckCircle2 className="h-6 w-6 text-emerald-600 flex-shrink-0" />
                <div>
                  <p className="text-sm font-semibold text-emerald-800">MFA activado correctamente</p>
                  <p className="text-xs text-emerald-600 mt-0.5">
                    A partir de ahora se pedirá tu código TOTP al iniciar sesión.
                  </p>
                </div>
              </div>
            ) : !qrDataUrl ? (
              <>
                <div className="flex items-start gap-3 rounded-xl bg-slate-50 border border-slate-200 px-4 py-3">
                  <ShieldOff className="h-5 w-5 text-slate-400 flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="text-sm font-medium text-slate-700">MFA no configurado</p>
                    <p className="text-xs text-slate-500 mt-0.5">
                      Añade una capa extra de seguridad usando una aplicación TOTP
                      (Google Authenticator, Authy, Bitwarden…).
                    </p>
                  </div>
                </div>

                {error && (
                  <div className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
                    <AlertTriangle className="h-4 w-4 flex-shrink-0" />{error}
                  </div>
                )}

                <button onClick={handleSetup} disabled={loading}
                  className="flex items-center gap-2 rounded-lg bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-60 transition-colors">
                  {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <QrCode className="h-4 w-4" />}
                  {loading ? "Generando QR…" : "Configurar MFA"}
                </button>
              </>
            ) : (
              <>
                <div className="flex items-start gap-3 rounded-xl bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-800">
                  <ShieldCheck className="h-5 w-5 text-amber-500 flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="font-semibold">Escanea el código QR con tu app TOTP</p>
                    <p className="text-xs mt-0.5">Luego introduce el código de 6 dígitos para confirmar la activación.</p>
                  </div>
                </div>

                {/* QR Code */}
                <div className="flex flex-col items-center gap-3">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={qrDataUrl} alt="QR Code MFA" className="h-48 w-48 rounded-xl border border-slate-200" />
                  <div className="text-center">
                    <p className="text-xs text-slate-500">Clave secreta (introducción manual):</p>
                    <code className="text-xs font-mono text-indigo-700 bg-indigo-50 rounded px-2 py-0.5 break-all">
                      {mfaSecret}
                    </code>
                  </div>
                </div>

                {error && (
                  <div className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
                    <AlertTriangle className="h-4 w-4 flex-shrink-0" />{error}
                  </div>
                )}

                {/* Verification form */}
                <form onSubmit={handleEnable} className="flex gap-3 items-end">
                  <div className="flex-1">
                    <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1.5">
                      Código TOTP de verificación
                    </label>
                    <input
                      type="text" inputMode="numeric" pattern="[0-9]{6}" maxLength={6}
                      required autoFocus placeholder="123456"
                      value={mfaCode} onChange={(e) => setMfaCode(e.target.value.replace(/\D/g, ""))}
                      className="w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2.5 text-center text-xl font-mono tracking-widest focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                    />
                  </div>
                  <button type="submit" disabled={enabling || mfaCode.length !== 6}
                    className="flex items-center gap-2 rounded-lg bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-60 transition-colors">
                    {enabling ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                    {enabling ? "Activando…" : "Activar MFA"}
                  </button>
                </form>
              </>
            )}
          </div>
        </div>

      </div>
    </div>
  );
}

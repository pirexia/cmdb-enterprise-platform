"use client";

import { useEffect, useState } from "react";
import { ClipboardList, RefreshCw, AlertTriangle, Search, Shield, Server, ShieldAlert } from "lucide-react";
import { apiFetch } from "@/lib/apiFetch";

// ─── Types ────────────────────────────────────────────────────────────────────

interface AuditLog {
  id:         string;
  action:     string;
  entity:     string;
  entity_id:  string;
  user_email: string;
  created_at: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("es-ES", {
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

function ActionBadge({ action }: { action: string }) {
  if (action.startsWith("CREATE_CI")) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-semibold text-emerald-700">
        <Server className="h-3 w-3" />CI Creado
      </span>
    );
  }
  if (action.startsWith("UPDATE_VULN_STATUS")) {
    const newStatus = action.split(":")[1] ?? "";
    const colors: Record<string, string> = {
      RESUELTO: "bg-emerald-100 text-emerald-700",
      EN_CURSO: "bg-yellow-100 text-yellow-700",
      ASIGNADO: "bg-purple-100 text-purple-700",
      PARADO:   "bg-orange-100 text-orange-700",
      NUEVO:    "bg-blue-100 text-blue-700",
    };
    return (
      <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ${colors[newStatus] ?? "bg-slate-100 text-slate-600"}`}>
        <ShieldAlert className="h-3 w-3" />Vuln → {newStatus}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-semibold text-slate-600">
      {action}
    </span>
  );
}

function EntityBadge({ entity }: { entity: string }) {
  const styles: Record<string, string> = {
    CI:            "bg-indigo-50 text-indigo-700",
    VULNERABILITY: "bg-red-50 text-red-700",
  };
  return (
    <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-semibold ${styles[entity] ?? "bg-slate-100 text-slate-600"}`}>
      {entity}
    </span>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function AuditPage() {
  const [logs, setLogs]       = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);
  const [search, setSearch]   = useState("");

  const fetchLogs = async () => {
    setLoading(true); setError(null);
    try {
      const res = await apiFetch("/api/audit-logs");
      if (!res.ok) throw new Error(`Status ${res.status}`);
      const json: { total: number; data: AuditLog[] } = await res.json();
      setLogs(json.data ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error desconocido");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchLogs(); }, []);

  const filtered = logs.filter((l) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      l.action.toLowerCase().includes(q) ||
      l.entity.toLowerCase().includes(q) ||
      l.entity_id.toLowerCase().includes(q) ||
      l.user_email.toLowerCase().includes(q)
    );
  });

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header */}
      <header className="border-b border-slate-200 bg-white px-8 py-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Shield className="h-5 w-5 text-indigo-500" />
            <div>
              <h1 className="text-xl font-bold text-slate-900">Log de Auditoría</h1>
              <p className="text-sm text-slate-500 mt-0.5">
                {loading ? "Cargando…" : `Últimos ${logs.length} eventos · visible solo para ADMIN`}
              </p>
            </div>
          </div>
          <button
            onClick={fetchLogs}
            className="flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50 transition-colors"
          >
            <RefreshCw className="h-3.5 w-3.5" />Actualizar
          </button>
        </div>
      </header>

      <div className="px-8 py-8 max-w-7xl mx-auto">
        <div className="rounded-2xl bg-white shadow-sm ring-1 ring-slate-200 overflow-hidden">
          {/* Toolbar */}
          <div className="flex items-center gap-3 border-b border-slate-200 px-6 py-4">
            <ClipboardList className="h-4 w-4 text-slate-400 flex-shrink-0" />
            <h2 className="text-sm font-semibold text-slate-700 flex-1">Registro de eventos</h2>
            <div className="relative w-64">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                placeholder="Buscar por usuario, acción…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full rounded-lg border border-slate-300 bg-slate-50 py-2 pl-9 pr-3 text-sm focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
              />
            </div>
          </div>

          {/* Loading */}
          {loading && (
            <div className="flex items-center justify-center py-20 text-slate-400">
              <RefreshCw className="mr-2 h-5 w-5 animate-spin" />
              <span className="text-sm">Cargando registros…</span>
            </div>
          )}

          {/* Error */}
          {error && !loading && (
            <div className="flex flex-col items-center justify-center gap-2 py-16 text-red-500">
              <AlertTriangle className="h-8 w-8" />
              <p className="text-sm font-medium">Error al cargar los logs</p>
              <p className="text-xs text-slate-400">{error}</p>
              <button onClick={fetchLogs} className="mt-2 rounded-lg bg-red-50 px-4 py-1.5 text-xs font-medium text-red-600 hover:bg-red-100">
                Reintentar
              </button>
            </div>
          )}

          {/* Table */}
          {!loading && !error && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-100 bg-slate-50 text-left">
                    <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wider text-slate-500">Fecha / Hora</th>
                    <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wider text-slate-500">Usuario</th>
                    <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wider text-slate-500">Acción</th>
                    <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wider text-slate-500">Entidad</th>
                    <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wider text-slate-500">ID Afectado</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filtered.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="py-16 text-center text-slate-400 text-sm">
                        {logs.length === 0
                          ? "No hay eventos de auditoría registrados aún."
                          : "No hay resultados para la búsqueda."}
                      </td>
                    </tr>
                  ) : (
                    filtered.map((log) => (
                      <tr key={log.id} className="hover:bg-indigo-50/30 transition-colors">
                        {/* Date */}
                        <td className="px-6 py-3 text-xs text-slate-500 whitespace-nowrap font-mono">
                          {formatDateTime(log.created_at)}
                        </td>
                        {/* User */}
                        <td className="px-6 py-3">
                          <span className="text-sm font-medium text-slate-700">{log.user_email}</span>
                        </td>
                        {/* Action */}
                        <td className="px-6 py-3">
                          <ActionBadge action={log.action} />
                        </td>
                        {/* Entity */}
                        <td className="px-6 py-3">
                          <EntityBadge entity={log.entity} />
                        </td>
                        {/* Entity ID */}
                        <td className="px-6 py-3">
                          <code className="text-xs font-mono text-slate-500 bg-slate-100 rounded px-1.5 py-0.5 break-all">
                            {log.entity_id}
                          </code>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          )}

          {/* Footer */}
          {!loading && !error && (
            <div className="border-t border-slate-100 px-6 py-3 text-xs text-slate-400">
              Mostrando {filtered.length} de {logs.length} eventos · máximo 50 más recientes
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

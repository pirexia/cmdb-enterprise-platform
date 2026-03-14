"use client";

import { useEffect, useState } from "react";
import { FileText, Plus, RefreshCw, AlertTriangle, Building, Calendar, Server, ChevronRight, GitBranch, Download } from "lucide-react";
import AddContractModal from "@/components/AddContractModal";
import { useAuth } from "@/contexts/AuthContext";
import { apiFetch } from "@/lib/apiFetch";
import { exportToCSV } from "@/lib/csvExport";

// ─── Types ────────────────────────────────────────────────────────────────────

interface CIRef       { id: string; name: string; apiSlug: string; environment: string; criticality: string }
interface ContractRef { id: string; contractNumber: string }
interface Contract {
  id: string; contractNumber: string; startDate: string; endDate: string | null;
  vendor: { id: string; name: string }; cis: CIRef[];
  parentContract: ContractRef | null; addendums: ContractRef[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getContractStatus(endDate: string | null) {
  if (!endDate) return { label: "Sin vencimiento", color: "text-slate-500", dot: "bg-slate-300" };
  const diff = (new Date(endDate).getTime() - Date.now()) / 86400000;
  if (diff < 0)  return { label: "Vencido",      color: "text-red-600",    dot: "bg-red-500" };
  if (diff < 30) return { label: "Vence pronto", color: "text-orange-600", dot: "bg-orange-400" };
  return            { label: "Activo",       color: "text-emerald-600",dot: "bg-emerald-400" };
}
function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("es-ES", { day: "2-digit", month: "short", year: "numeric" });
}

// ─── Row ──────────────────────────────────────────────────────────────────────

function ContractRow({ contract, onExpand, expanded }: { contract: Contract; onExpand: () => void; expanded: boolean }) {
  const status     = getContractStatus(contract.endDate);
  const isAddendum = !!contract.parentContract;

  return (
    <>
      <tr className="group cursor-pointer hover:bg-indigo-50/40 transition-colors" onClick={onExpand}>
        <td className="px-6 py-4">
          <div className="flex items-center gap-2">
            {isAddendum && <span title="Adenda"><GitBranch className="h-3.5 w-3.5 flex-shrink-0 text-amber-400" /></span>}
            <div>
              <p className="font-semibold text-slate-800 group-hover:text-indigo-700 transition-colors">{contract.contractNumber}</p>
              {isAddendum && <p className="text-[11px] text-amber-600">Adenda de {contract.parentContract!.contractNumber}</p>}
              {contract.addendums.length > 0 && <p className="text-[11px] text-slate-400">{contract.addendums.length} adenda{contract.addendums.length > 1 ? "s" : ""}</p>}
            </div>
          </div>
        </td>
        <td className="px-6 py-4"><div className="flex items-center gap-2 text-slate-700"><Building className="h-3.5 w-3.5 text-slate-400 flex-shrink-0" /><span className="text-sm font-medium">{contract.vendor.name}</span></div></td>
        <td className="px-6 py-4">
          <div className="flex items-center gap-2">
            <span className={`inline-flex h-2 w-2 rounded-full flex-shrink-0 ${status.dot}`} />
            <div>
              <p className={`text-sm font-medium ${status.color}`}>{status.label}</p>
              {contract.endDate && <p className="text-xs text-slate-400">{formatDate(contract.endDate)}</p>}
            </div>
          </div>
        </td>
        <td className="px-6 py-4">
          <div className="flex items-center gap-1.5 text-slate-600">
            <Server className="h-3.5 w-3.5 text-slate-400 flex-shrink-0" />
            <span className="text-sm font-medium">{contract.cis.length}</span>
            <span className="text-xs text-slate-400">CI{contract.cis.length !== 1 ? "s" : ""}</span>
          </div>
        </td>
        <td className="px-4 py-4 text-right">
          <ChevronRight className={`h-4 w-4 text-slate-400 transition-transform inline-block ${expanded ? "rotate-90" : ""}`} />
        </td>
      </tr>
      {expanded && contract.cis.length > 0 && (
        <tr><td colSpan={5} className="px-6 pb-4 bg-indigo-50/30">
          <div className="rounded-xl border border-indigo-100 bg-white overflow-hidden">
            <div className="border-b border-slate-100 bg-slate-50 px-4 py-2"><p className="text-xs font-semibold uppercase tracking-wider text-slate-500">CIs cubiertos</p></div>
            <div className="divide-y divide-slate-50">
              {contract.cis.map((ci) => (
                <div key={ci.id} className="flex items-center justify-between px-4 py-2.5">
                  <div><p className="text-sm font-medium text-slate-700">{ci.name}</p><p className="text-xs text-slate-400">{ci.apiSlug}</p></div>
                  <div className="flex items-center gap-2"><span className="text-xs text-slate-500">{ci.environment}</span><span className="text-xs text-slate-400">·</span><span className="text-xs text-slate-500">{ci.criticality}</span></div>
                </div>
              ))}
            </div>
          </div>
        </td></tr>
      )}
      {expanded && contract.cis.length === 0 && (
        <tr><td colSpan={5} className="px-6 pb-4 bg-indigo-50/30"><p className="text-sm text-slate-400 italic py-2">Este contrato no tiene CIs asociados.</p></td></tr>
      )}
    </>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ContractsPage() {
  const { isAdmin }               = useAuth();
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [expanded, setExpanded]   = useState<string | null>(null);

  const fetchContracts = async () => {
    setLoading(true); setError(null);
    try {
      const res = await apiFetch("/api/contracts");
      if (!res.ok) throw new Error(`Status ${res.status}`);
      const json: { total: number; data: Contract[] } = await res.json();
      setContracts(json.data);
    } catch (err) { setError(err instanceof Error ? err.message : "Unknown error"); }
    finally { setLoading(false); }
  };

  useEffect(() => { fetchContracts(); }, []);

  const total    = contracts.length;
  const addendums = contracts.filter((c) => c.parentContract !== null).length;
  const expiredCount = contracts.filter((c) => c.endDate && new Date(c.endDate) < new Date()).length;

  const handleExportCSV = () => {
    exportToCSV(
      `contratos-${new Date().toISOString().slice(0, 10)}.csv`,
      ["Nº Contrato", "Proveedor", "Tipo", "Fecha Inicio", "Fecha Fin", "Estado", "CIs Cubiertos", "Adendas"],
      contracts.map((c) => {
        const status = getContractStatus(c.endDate);
        const type   = c.parentContract ? "Adenda" : "Principal";
        return [
          c.contractNumber, c.vendor.name, type,
          formatDate(c.startDate),
          c.endDate ? formatDate(c.endDate) : "—",
          status.label,
          c.cis.length,
          c.addendums.length,
        ];
      })
    );
  };

  return (
    <>
      {showModal && <AddContractModal onClose={() => setShowModal(false)} onCreated={fetchContracts} />}
      <div className="min-h-screen bg-slate-50">
        <header className="border-b border-slate-200 bg-white px-8 py-5">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-xl font-bold text-slate-900">Contratos y Adendas</h1>
              <p className="text-sm text-slate-500 mt-0.5">{loading ? "Cargando…" : `${total} contratos · ${addendums} adendas · ${expiredCount} vencidos`}</p>
            </div>
            {isAdmin && (
              <button onClick={() => setShowModal(true)} className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700 transition-colors shadow-sm">
                <Plus className="h-4 w-4" />Nuevo Contrato
              </button>
            )}
          </div>
        </header>

        <div className="px-8 py-8 max-w-7xl mx-auto space-y-6">
          {!loading && !error && (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              {[
                { label: "Total",     value: total,     color: "bg-indigo-50 text-indigo-700" },
                { label: "Adendas",   value: addendums, color: "bg-amber-50 text-amber-700" },
                { label: "Vencidos",  value: expiredCount, color: "bg-red-50 text-red-700" },
                { label: "Con CIs",   value: contracts.filter((c) => c.cis.length > 0).length, color: "bg-emerald-50 text-emerald-700" },
              ].map(({ label, value, color }) => (
                <div key={label} className={`rounded-xl ${color.split(" ")[0]} px-4 py-3 ring-1 ring-inset ring-current/10`}>
                  <p className={`text-2xl font-bold ${color.split(" ")[1]}`}>{value}</p>
                  <p className="text-xs font-medium text-slate-500 mt-0.5">{label}</p>
                </div>
              ))}
            </div>
          )}

          <div className="rounded-2xl bg-white shadow-sm ring-1 ring-slate-200 overflow-hidden">
            <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
              <h2 className="text-sm font-semibold text-slate-700 flex items-center gap-2"><FileText className="h-4 w-4 text-slate-400" />Listado de contratos</h2>
              <div className="flex items-center gap-2">
                <button
                  onClick={handleExportCSV}
                  disabled={loading || contracts.length === 0}
                  className="flex items-center gap-1.5 rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-100 transition-colors disabled:opacity-50"
                >
                  <Download className="h-3.5 w-3.5" />📥 CSV
                </button>
                <button onClick={fetchContracts} className="flex items-center justify-center rounded-lg border border-slate-300 bg-slate-50 p-2 text-slate-500 hover:bg-slate-100 transition-colors"><RefreshCw className="h-4 w-4" /></button>
              </div>
            </div>

            {loading && <div className="flex items-center justify-center py-20 text-slate-400"><RefreshCw className="mr-2 h-5 w-5 animate-spin" /><span className="text-sm">Cargando contratos…</span></div>}
            {error && !loading && (
              <div className="flex flex-col items-center justify-center gap-2 py-16 text-red-500">
                <AlertTriangle className="h-8 w-8" /><p className="text-sm font-medium">Error al cargar los contratos</p>
                <p className="text-xs text-slate-400">{error}</p>
                <button onClick={fetchContracts} className="mt-2 rounded-lg bg-red-50 px-4 py-1.5 text-xs font-medium text-red-600 hover:bg-red-100">Reintentar</button>
              </div>
            )}

            {!loading && !error && (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-100 bg-slate-50 text-left">
                      <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wider text-slate-500">Nº Contrato</th>
                      <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wider text-slate-500">Proveedor</th>
                      <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wider text-slate-500">
                        <div className="flex items-center gap-1"><Calendar className="h-3.5 w-3.5" />Estado / Vencimiento</div>
                      </th>
                      <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wider text-slate-500">CIs Cubiertos</th>
                      <th className="px-4 py-3" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {contracts.length === 0 ? (
                      <tr><td colSpan={5} className="py-16 text-center text-slate-400 text-sm">No hay contratos. {isAdmin && <><strong>Nuevo Contrato</strong> para empezar.</>}</td></tr>
                    ) : (
                      contracts.map((c) => (
                        <ContractRow key={c.id} contract={c} expanded={expanded === c.id} onExpand={() => setExpanded((p) => (p === c.id ? null : c.id))} />
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            )}
            {!loading && !error && (
              <div className="border-t border-slate-100 px-6 py-3 text-xs text-slate-400">
                {total} contrato{total !== 1 ? "s" : ""} · Haz clic en una fila para ver los CIs
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  MarkerType,
  useNodesState,
  useEdgesState,
  Node,
  Edge,
  Handle,
  Position,
  NodeProps,
  BackgroundVariant,
} from "reactflow";
import "reactflow/dist/style.css";
import { AlertTriangle, RefreshCw, Network, Clock } from "lucide-react";
import { apiFetch } from "@/lib/apiFetch";

// ─── Types ────────────────────────────────────────────────────────────────────

type CIType         = "HARDWARE" | "SOFTWARE" | "OTHER";
type ContractStatus = "EXPIRED" | "EXPIRING_SOON" | "ACTIVE" | "NONE";
type VulnSeverity   = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

interface CIRef { id: string; name: string; apiSlug: string }

interface ContractInfo {
  id:             string;
  contractNumber: string;
  endDate:        string | null;
  vendor:         { id: string; name: string };
}

interface Vulnerability {
  cve:         string;
  severity:    VulnSeverity;
  description: string;
}

interface CI {
  id:              string;
  name:            string;
  apiSlug:         string;
  criticality:     string;
  environment:     string;
  hardware:        unknown | null;
  software:        unknown | null;
  parentCI:        CIRef | null;
  childCIs:        CIRef[];
  contracts:       ContractInfo[];
  vulnerabilities: Vulnerability[] | null;
}

interface CINodeData {
  label:           string;
  apiSlug:         string;
  ciType:          CIType;
  environment:     string;
  criticality:     string;
  contractStatus:  ContractStatus;
  daysRemaining:   number | null;
  nearestContract: ContractInfo | null;
  hasHighVuln:     boolean;   // CRITICAL or HIGH
  vulnCount:       number;
  topSeverity:     VulnSeverity | null;
}

// ─── Contract Status Logic ────────────────────────────────────────────────────

const EXPIRING_THRESHOLD = 60;

function calcContractStatus(contracts: ContractInfo[]): {
  status:          ContractStatus;
  daysRemaining:   number | null;
  nearestContract: ContractInfo | null;
} {
  if (contracts.length === 0) return { status: "NONE", daysRemaining: null, nearestContract: null };
  const withDates = contracts.filter((c) => c.endDate !== null);
  if (withDates.length === 0) return { status: "ACTIVE", daysRemaining: null, nearestContract: null };

  let minDays = Infinity;
  let nearest: ContractInfo | null = null;
  for (const c of withDates) {
    const days = Math.ceil((new Date(c.endDate!).getTime() - Date.now()) / 86_400_000);
    if (days < minDays) { minDays = days; nearest = c; }
  }
  const status: ContractStatus =
    minDays < 0                   ? "EXPIRED"       :
    minDays <= EXPIRING_THRESHOLD ? "EXPIRING_SOON" : "ACTIVE";
  return { status, daysRemaining: minDays, nearestContract: nearest };
}

function formatDays(days: number) {
  if (days < 0)  return `Vencido hace ${Math.abs(days)}d`;
  if (days === 0) return "Vence hoy";
  return `Vence en ${days}d`;
}

// ─── Vulnerability helpers ────────────────────────────────────────────────────

const SEVERITY_ORDER: VulnSeverity[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];

function topSeverity(vulns: Vulnerability[]): VulnSeverity | null {
  for (const s of SEVERITY_ORDER) {
    if (vulns.some((v) => v.severity === s)) return s;
  }
  return null;
}

// ─── Node Visual Styles ───────────────────────────────────────────────────────

const TYPE_STYLES: Record<CIType, { bg: string; border: string; badge: string; badgeText: string }> = {
  HARDWARE: { bg: "bg-blue-50",    border: "border-blue-300",    badge: "bg-blue-100 text-blue-700",    badgeText: "Hardware" },
  SOFTWARE: { bg: "bg-emerald-50", border: "border-emerald-300", badge: "bg-emerald-100 text-emerald-700", badgeText: "Software" },
  OTHER:    { bg: "bg-slate-50",   border: "border-slate-300",   badge: "bg-slate-100 text-slate-600",  badgeText: "Otro" },
};

const CONTRACT_OVERLAY: Record<ContractStatus, { border?: string; bg?: string; animClass?: string; textColor?: string }> = {
  EXPIRED:       { border: "border-red-500",    bg: "bg-red-50",    animClass: "contract-expired",  textColor: "text-red-600" },
  EXPIRING_SOON: { border: "border-orange-400", bg: "bg-orange-50", animClass: "contract-expiring", textColor: "text-orange-600" },
  ACTIVE: {},
  NONE:   {},
};

const CRIT_DOT: Record<string, string> = {
  MISSION_CRITICAL: "bg-red-500",
  HIGH:             "bg-orange-400",
  MEDIUM:           "bg-yellow-400",
  LOW:              "bg-slate-300",
};

const VULN_SEVERITY_COLORS: Record<VulnSeverity, string> = {
  CRITICAL: "text-red-600",
  HIGH:     "text-orange-500",
  MEDIUM:   "text-yellow-600",
  LOW:      "text-slate-500",
};

// ─── Custom CI Node ───────────────────────────────────────────────────────────

function CINode({ data }: NodeProps<CINodeData>) {
  const [hovered, setHovered] = useState(false);

  const typeStyle     = TYPE_STYLES[data.ciType];
  const contractStyle = CONTRACT_OVERLAY[data.contractStatus];
  const border        = contractStyle.border ?? typeStyle.border;
  const bg            = contractStyle.bg     ?? typeStyle.bg;
  const anim          = contractStyle.animClass ?? "";

  const showContractLine =
    data.contractStatus === "EXPIRED" || data.contractStatus === "EXPIRING_SOON";

  return (
    <div
      className={`relative w-52 rounded-xl border-2 shadow-md ${bg} ${border} ${anim}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Criticality dot */}
      <span className={`absolute -top-1.5 -right-1.5 h-3 w-3 rounded-full border-2 border-white ${CRIT_DOT[data.criticality] ?? "bg-slate-300"}`} />

      {/* Vulnerability alert badge — blinking */}
      {data.hasHighVuln && (
        <span className="vuln-alert absolute -top-3 -left-3 flex h-6 w-6 items-center justify-center rounded-full bg-red-600 text-white text-[10px] font-bold shadow-lg border-2 border-white">
          ⚠
        </span>
      )}

      {/* Contract hover tooltip */}
      {hovered && data.daysRemaining !== null && data.nearestContract && (
        <div className="absolute -top-12 left-1/2 z-50 -translate-x-1/2 pointer-events-none">
          <div className={`whitespace-nowrap rounded-lg px-3 py-1.5 text-xs font-medium text-white shadow-lg
            ${data.contractStatus === "EXPIRED" ? "bg-red-600" : "bg-orange-500"}`}>
            {data.nearestContract.contractNumber} — {formatDays(data.daysRemaining)}
            <div className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent"
              style={{ borderTopColor: data.contractStatus === "EXPIRED" ? "#dc2626" : "#f97316" }}
            />
          </div>
        </div>
      )}

      {/* Vulnerability hover tooltip */}
      {hovered && data.hasHighVuln && (
        <div className="absolute -bottom-10 left-1/2 z-50 -translate-x-1/2 pointer-events-none">
          <div className="whitespace-nowrap rounded-lg bg-red-700 px-3 py-1.5 text-xs font-medium text-white shadow-lg">
            {data.vulnCount} vulnerabilidad{data.vulnCount !== 1 ? "es" : ""} · top: {data.topSeverity}
            <div className="absolute bottom-full left-1/2 -translate-x-1/2 border-4 border-transparent border-b-red-700" />
          </div>
        </div>
      )}

      <div className="px-3 py-2.5">
        {/* Badge row */}
        <div className="flex items-center justify-between mb-1.5">
          <span className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold ${typeStyle.badge}`}>
            {typeStyle.badgeText}
          </span>
          <div className="flex items-center gap-1">
            {data.hasHighVuln && (
              <span className={`text-[10px] font-semibold ${data.topSeverity ? VULN_SEVERITY_COLORS[data.topSeverity] : ""}`}>
                {data.topSeverity}
              </span>
            )}
            {showContractLine && (
              <Clock className={`h-3.5 w-3.5 flex-shrink-0 ${contractStyle.textColor}`} />
            )}
          </div>
        </div>

        {/* Name */}
        <p className="text-sm font-bold text-slate-800 leading-tight truncate" title={data.label}>
          {data.label}
        </p>
        {/* Slug */}
        <p className="text-[11px] text-slate-400 font-mono mt-0.5 truncate">{data.apiSlug}</p>
        {/* Env */}
        <p className="mt-1 text-[10px] uppercase tracking-wider text-slate-500">
          {data.environment.toLowerCase()}
        </p>
        {/* Contract line */}
        {showContractLine && data.daysRemaining !== null && (
          <p className={`mt-1 text-[10px] font-semibold truncate ${contractStyle.textColor}`}>
            {formatDays(data.daysRemaining)}
          </p>
        )}
      </div>

      <Handle type="target" position={Position.Top}    style={{ opacity: 0, pointerEvents: "none" }} />
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0, pointerEvents: "none" }} />
    </div>
  );
}

const NODE_TYPES = { ciNode: CINode };

// ─── Layout ───────────────────────────────────────────────────────────────────

const NODE_W = 208, NODE_H = 140, H_GAP = 80, V_GAP = 120;

function buildGraphElements(cis: CI[]): { nodes: Node<CINodeData>[]; edges: Edge[] } {
  if (cis.length === 0) return { nodes: [], edges: [] };
  const ciById = new Map(cis.map((ci) => [ci.id, ci]));

  const childrenOf: Record<string, string[]> = {};
  for (const ci of cis) {
    if (ci.parentCI && ciById.has(ci.parentCI.id)) {
      const pid = ci.parentCI.id;
      childrenOf[pid] = childrenOf[pid] ?? [];
      childrenOf[pid].push(ci.id);
    }
  }

  const depth: Record<string, number> = {};
  const roots = cis.filter((ci) => !ci.parentCI || !ciById.has(ci.parentCI.id));
  const queue: [string, number][] = roots.map((ci) => [ci.id, 0]);
  const visited = new Set<string>();
  while (queue.length > 0) {
    const [id, d] = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    depth[id] = d;
    (childrenOf[id] ?? []).forEach((cid) => queue.push([cid, d + 1]));
  }
  for (const ci of cis) if (depth[ci.id] === undefined) depth[ci.id] = 0;

  const byDepth: Record<number, string[]> = {};
  for (const [id, d] of Object.entries(depth)) {
    byDepth[d] = byDepth[d] ?? [];
    byDepth[d].push(id);
  }
  const maxDepth = Math.max(...Object.keys(byDepth).map(Number));
  const positions: Record<string, { x: number; y: number }> = {};
  for (let d = 0; d <= maxDepth; d++) {
    const ids  = byDepth[d] ?? [];
    const span = ids.length * (NODE_W + H_GAP) - H_GAP;
    ids.forEach((id, i) => { positions[id] = { x: -span / 2 + i * (NODE_W + H_GAP), y: d * (NODE_H + V_GAP) }; });
  }

  const nodes: Node<CINodeData>[] = cis.map((ci) => {
    const { status, daysRemaining, nearestContract } = calcContractStatus(ci.contracts);
    const vulns    = ci.vulnerabilities ?? [];
    const highVuln = vulns.some((v) => v.severity === "CRITICAL" || v.severity === "HIGH");
    return {
      id:       ci.id,
      type:     "ciNode",
      position: positions[ci.id] ?? { x: 0, y: (NODE_H + V_GAP) * (maxDepth + 1) },
      data: {
        label:           ci.name,
        apiSlug:         ci.apiSlug,
        ciType:          ci.hardware ? "HARDWARE" : ci.software ? "SOFTWARE" : "OTHER",
        environment:     ci.environment,
        criticality:     ci.criticality,
        contractStatus:  status,
        daysRemaining,
        nearestContract,
        hasHighVuln:     highVuln,
        vulnCount:       vulns.length,
        topSeverity:     vulns.length > 0 ? topSeverity(vulns) : null,
      },
    };
  });

  const edges: Edge[] = cis
    .filter((ci) => ci.parentCI && ciById.has(ci.parentCI.id))
    .map((ci) => ({
      id:        `${ci.id}__${ci.parentCI!.id}`,
      source:    ci.id,
      target:    ci.parentCI!.id,
      style:     { stroke: "#6366f1", strokeWidth: 2 },
      markerEnd: { type: MarkerType.ArrowClosed, color: "#6366f1" },
    }));

  return { nodes, edges };
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function MapPage() {
  const [cis, setCis]         = useState<CI[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<CINodeData>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);

  const fetchAndLayout = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await apiFetch("/api/cis");
      if (!res.ok) throw new Error(`Status ${res.status}`);
      const json: { total: number; data: CI[] } = await res.json();
      setCis(json.data);
      const { nodes: n, edges: e } = buildGraphElements(json.data);
      setNodes(n); setEdges(e);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [setNodes, setEdges]);

  useEffect(() => { fetchAndLayout(); }, [fetchAndLayout]);

  const hw       = useMemo(() => cis.filter((c) => c.hardware).length, [cis]);
  const sw       = useMemo(() => cis.filter((c) => c.software).length, [cis]);
  const oth      = useMemo(() => cis.filter((c) => !c.hardware && !c.software).length, [cis]);
  const expired  = useMemo(() => cis.filter((c) => calcContractStatus(c.contracts).status === "EXPIRED").length, [cis]);
  const expiring = useMemo(() => cis.filter((c) => calcContractStatus(c.contracts).status === "EXPIRING_SOON").length, [cis]);
  const vulnCrit = useMemo(() => cis.filter((c) => (c.vulnerabilities ?? []).some((v) => v.severity === "CRITICAL" || v.severity === "HIGH")).length, [cis]);

  return (
    <div className="flex flex-col h-full bg-slate-50">
      <header className="flex-shrink-0 border-b border-slate-200 bg-white px-8 py-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Network className="h-5 w-5 text-indigo-500" />
            <div>
              <h1 className="text-xl font-bold text-slate-900">Mapa de Dependencias</h1>
              <p className="text-sm text-slate-500 mt-0.5">
                {loading ? "Construyendo grafo…" : `${cis.length} nodos · ${edges.length} relaciones`}
              </p>
            </div>
          </div>

          {!loading && !error && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-slate-500">
              <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded border-2 border-blue-300 bg-blue-50" />Hardware ({hw})</span>
              <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded border-2 border-emerald-300 bg-emerald-50" />Software ({sw})</span>
              {oth > 0 && <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded border-2 border-slate-300 bg-slate-50" />Otro ({oth})</span>}
              <span className="text-slate-200">|</span>
              <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded border-2 border-red-500 bg-red-50 contract-expired" /><span className="text-red-600 font-medium">Contrato vencido ({expired})</span></span>
              <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded border-2 border-orange-400 bg-orange-50 contract-expiring" /><span className="text-orange-600 font-medium">Vence ≤60d ({expiring})</span></span>
              <span className="text-slate-200">|</span>
              <span className="flex items-center gap-1.5">
                <span className="vuln-alert inline-flex h-4 w-4 items-center justify-center rounded-full bg-red-600 text-white text-[9px]">⚠</span>
                <span className="text-red-600 font-medium">Vuln CRIT/HIGH ({vulnCrit})</span>
              </span>
              <span className="text-slate-200">|</span>
              <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-red-500" />MC</span>
              <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-orange-400" />High</span>
              <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-yellow-400" />Med</span>
              <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-slate-300" />Low</span>
              <button onClick={fetchAndLayout} className="ml-2 flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 hover:bg-slate-50 transition-colors">
                <RefreshCw className="h-3 w-3" />Actualizar
              </button>
            </div>
          )}
        </div>
      </header>

      <div className="flex-1 relative">
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-slate-50 z-10">
            <RefreshCw className="mr-2 h-6 w-6 animate-spin text-slate-400" />
            <span className="text-sm text-slate-400">Construyendo grafo…</span>
          </div>
        )}
        {error && !loading && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-slate-50 z-10">
            <AlertTriangle className="h-10 w-10 text-red-400" />
            <p className="text-sm font-medium text-red-600">{error}</p>
            <button onClick={fetchAndLayout} className="rounded-lg bg-indigo-600 px-4 py-2 text-sm text-white hover:bg-indigo-700">Reintentar</button>
          </div>
        )}

        <ReactFlow nodes={nodes} edges={edges} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
          nodeTypes={NODE_TYPES} fitView fitViewOptions={{ padding: 0.2 }} minZoom={0.1} maxZoom={2}
          proOptions={{ hideAttribution: true }}>
          <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="#cbd5e1" />
          <Controls position="bottom-right" />
          <MiniMap
            position="bottom-left"
            nodeColor={(node) => {
              const d = node.data as CINodeData;
              if (d?.hasHighVuln)                          return "#fca5a5"; // red-300 — vuln priority
              if (d?.contractStatus === "EXPIRED")          return "#fca5a5";
              if (d?.contractStatus === "EXPIRING_SOON")    return "#fdba74";
              return d?.ciType === "HARDWARE" ? "#bfdbfe" : d?.ciType === "SOFTWARE" ? "#a7f3d0" : "#e2e8f0";
            }}
            nodeStrokeWidth={2}
            maskColor="rgba(248,250,252,0.85)"
          />
        </ReactFlow>
      </div>
    </div>
  );
}

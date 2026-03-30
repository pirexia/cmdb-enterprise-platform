"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import ReactFlow, {
  Background,
  Controls,
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
import {
  Network, Search, Link2, RefreshCw, AlertTriangle, ArrowLeft, ChevronDown,
} from "lucide-react";
import { apiFetch } from "@/lib/apiFetch";
import AddRelationModal from "@/components/AddRelationModal";

// ─── Types ────────────────────────────────────────────────────────────────────

interface CIOption {
  id: string;
  name: string;
  apiSlug: string;
  ciType: string | null;
  criticality: string;
  environment: string;
}

interface RelationRow {
  id: string;
  source_ci_id: string;
  target_ci_id: string;
  relation_type: string;
  source_ci_name: string;
  source_ci_slug: string;
  target_ci_name: string;
  target_ci_slug: string;
}

interface Relations {
  outgoing: RelationRow[];
  incoming: RelationRow[];
  total: number;
}

interface CINodeData {
  label: string;
  apiSlug: string;
  ciType: string;
  environment: string;
  criticality: string;
  isCenter: boolean;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const RELATION_COLORS: Record<string, { stroke: string; label: string; bg: string }> = {
  HOSTS:            { stroke: "#6366f1", label: "HOSTS",            bg: "#eef2ff" },
  DEPENDS_ON:       { stroke: "#f97316", label: "DEPENDS_ON",       bg: "#fff7ed" },
  CONNECTED_TO:     { stroke: "#0d9488", label: "CONNECTED_TO",     bg: "#f0fdfa" },
  PROVIDES_SERVICE: { stroke: "#10b981", label: "PROVIDES_SERVICE", bg: "#f0fdf4" },
  BACKED_UP_BY:     { stroke: "#8b5cf6", label: "BACKED_UP_BY",     bg: "#faf5ff" },
};

const CRIT_DOT: Record<string, string> = {
  MISSION_CRITICAL: "bg-red-500",
  HIGH:             "bg-orange-400",
  MEDIUM:           "bg-yellow-400",
  LOW:              "bg-slate-300",
};

const TYPE_BADGE: Record<string, { bg: string; text: string; label: string }> = {
  PHYSICAL_SERVER:  { bg: "bg-emerald-100", text: "text-emerald-700", label: "Servidor Físico" },
  VIRTUAL_SERVER:   { bg: "bg-teal-100",    text: "text-teal-700",    label: "Servidor Virtual" },
  DATABASE:         { bg: "bg-blue-100",    text: "text-blue-700",    label: "Base de Datos" },
  NETWORK_EQUIPMENT:{ bg: "bg-cyan-100",    text: "text-cyan-700",    label: "Red" },
  STORAGE:          { bg: "bg-amber-100",   text: "text-amber-700",   label: "Almacenamiento" },
  BACKUP:           { bg: "bg-purple-100",  text: "text-purple-700",  label: "Backup" },
  BASE_SOFTWARE:    { bg: "bg-indigo-100",  text: "text-indigo-700",  label: "Software Base" },
  SOFTWARE:         { bg: "bg-violet-100",  text: "text-violet-700",  label: "Software" },
  OTHER:            { bg: "bg-slate-100",   text: "text-slate-600",   label: "Otro" },
};

// ─── CI Node ──────────────────────────────────────────────────────────────────

function CINode({ data }: NodeProps<CINodeData>) {
  const badge = TYPE_BADGE[data.ciType] ?? TYPE_BADGE["OTHER"];
  const dot   = CRIT_DOT[data.criticality] ?? "bg-slate-300";

  return (
    <div className={`relative w-52 rounded-xl border-2 shadow-md bg-white transition-all ${
      data.isCenter
        ? "border-indigo-500 ring-4 ring-indigo-100 shadow-indigo-100"
        : "border-slate-200 hover:border-slate-300"
    }`}>
      <span className={`absolute -top-1.5 -right-1.5 h-3 w-3 rounded-full border-2 border-white ${dot}`} />

      <div className="px-3 py-2.5">
        <div className="flex items-center justify-between mb-1.5">
          <span className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold ${badge.bg} ${badge.text}`}>
            {badge.label}
          </span>
          {data.isCenter && (
            <span className="inline-block rounded-full bg-indigo-600 px-2 py-0.5 text-[10px] font-semibold text-white">
              origen
            </span>
          )}
        </div>
        <p className="text-sm font-bold text-slate-800 leading-tight truncate" title={data.label}>
          {data.label}
        </p>
        <p className="text-[11px] text-slate-400 font-mono mt-0.5 truncate">{data.apiSlug}</p>
        <p className="mt-1 text-[10px] uppercase tracking-wider text-slate-500">
          {data.environment.toLowerCase()}
        </p>
      </div>

      <Handle type="target" position={Position.Left}   style={{ opacity: 0 }} />
      <Handle type="source" position={Position.Right}  style={{ opacity: 0 }} />
      <Handle type="target" position={Position.Top}    style={{ opacity: 0 }} />
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
    </div>
  );
}

const NODE_TYPES = { ciNode: CINode };

// ─── Graph builder ────────────────────────────────────────────────────────────

const NODE_W = 208, NODE_H = 100, V_GAP = 40, H_GAP = 320;

function buildFocusedGraph(
  center: CIOption,
  relations: Relations,
  allCIs: Map<string, CIOption>
): { nodes: Node<CINodeData>[]; edges: Edge[] } {
  const nodes: Node<CINodeData>[] = [];
  const edges: Edge[]             = [];

  // Deduplicate: a CI might appear in both incoming and outgoing
  const seen = new Set<string>();

  const makeNodeData = (ci: CIOption, isCenter: boolean): CINodeData => ({
    label:       ci.name,
    apiSlug:     ci.apiSlug,
    ciType:      ci.ciType ?? "OTHER",
    environment: ci.environment,
    criticality: ci.criticality,
    isCenter,
  });

  // Center node
  const totalLeft  = relations.incoming.length;
  const totalRight = relations.outgoing.length;
  const maxSide    = Math.max(totalLeft, totalRight, 1);
  const centerY    = ((maxSide - 1) * (NODE_H + V_GAP)) / 2;

  nodes.push({
    id: center.id, type: "ciNode",
    position: { x: H_GAP, y: centerY },
    data: makeNodeData(center, true),
  });
  seen.add(center.id);

  // Incoming: source → center
  relations.incoming.forEach((rel, i) => {
    const sourceId = rel.source_ci_id;
    const y = i * (NODE_H + V_GAP);
    const ci = allCIs.get(sourceId) ?? {
      id: sourceId, name: rel.source_ci_name, apiSlug: rel.source_ci_slug,
      ciType: null, criticality: "MEDIUM", environment: "PRODUCTION",
    };

    if (!seen.has(sourceId)) {
      nodes.push({
        id: sourceId, type: "ciNode",
        position: { x: 0, y },
        data: makeNodeData(ci, false),
      });
      seen.add(sourceId);
    }

    const color = RELATION_COLORS[rel.relation_type] ?? RELATION_COLORS["CONNECTED_TO"];
    edges.push({
      id: `in-${rel.id}`,
      source: sourceId,
      target: center.id,
      label: rel.relation_type,
      labelStyle: { fill: color.stroke, fontWeight: 600, fontSize: 10 },
      labelBgStyle: { fill: color.bg, rx: 4 },
      labelBgPadding: [4, 6] as [number, number],
      style: { stroke: color.stroke, strokeWidth: 2 },
      markerEnd: { type: MarkerType.ArrowClosed, color: color.stroke },
    });
  });

  // Outgoing: center → target
  relations.outgoing.forEach((rel, i) => {
    const targetId = rel.target_ci_id;
    const y = i * (NODE_H + V_GAP);
    const ci = allCIs.get(targetId) ?? {
      id: targetId, name: rel.target_ci_name, apiSlug: rel.target_ci_slug,
      ciType: null, criticality: "MEDIUM", environment: "PRODUCTION",
    };

    if (!seen.has(targetId)) {
      nodes.push({
        id: targetId, type: "ciNode",
        position: { x: H_GAP * 2, y },
        data: makeNodeData(ci, false),
      });
      seen.add(targetId);
    }

    const color = RELATION_COLORS[rel.relation_type] ?? RELATION_COLORS["CONNECTED_TO"];
    edges.push({
      id: `out-${rel.id}`,
      source: center.id,
      target: targetId,
      label: rel.relation_type,
      labelStyle: { fill: color.stroke, fontWeight: 600, fontSize: 10 },
      labelBgStyle: { fill: color.bg, rx: 4 },
      labelBgPadding: [4, 6] as [number, number],
      style: { stroke: color.stroke, strokeWidth: 2 },
      markerEnd: { type: MarkerType.ArrowClosed, color: color.stroke },
    });
  });

  return { nodes, edges };
}

// ─── CI Selector ─────────────────────────────────────────────────────────────

function CISelector({
  cis, onSelect,
}: {
  cis: CIOption[];
  onSelect: (ci: CIOption) => void;
}) {
  const [search, setSearch] = useState("");
  const [open, setOpen]     = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const filtered = cis.filter(
    (c) =>
      c.name.toLowerCase().includes(search.toLowerCase()) ||
      c.apiSlug.toLowerCase().includes(search.toLowerCase())
  );

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && e.target instanceof Element && !ref.current.contains(e.target)) setOpen(false);
    };
    if (open) document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50">
      <div className="w-full max-w-lg rounded-2xl bg-white p-8 shadow-xl ring-1 ring-slate-200">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-100">
            <Network className="h-5 w-5 text-indigo-600" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-slate-900">Mapa de Dependencias</h1>
            <p className="text-sm text-slate-500">Selecciona un CI para explorar sus relaciones</p>
          </div>
        </div>

        <div ref={ref} className="relative">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="flex w-full items-center justify-between rounded-xl border border-slate-300 bg-slate-50 px-4 py-3 text-left text-sm hover:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-200 transition-colors"
          >
            <span className="text-slate-400">Buscar CI por nombre o slug…</span>
            <ChevronDown className={`h-4 w-4 text-slate-400 transition-transform ${open ? "rotate-180" : ""}`} />
          </button>

          {open && (
            <div className="absolute z-50 mt-2 w-full rounded-xl border border-slate-200 bg-white shadow-2xl">
              <div className="border-b border-slate-100 p-3">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <input
                    autoFocus
                    type="text"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Escriba para filtrar…"
                    className="w-full rounded-lg border border-slate-200 bg-slate-50 py-2 pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200"
                  />
                </div>
              </div>
              <ul className="max-h-64 overflow-y-auto py-1">
                {filtered.length === 0 ? (
                  <li className="px-4 py-3 text-sm italic text-slate-400">Sin resultados</li>
                ) : (
                  filtered.map((ci) => {
                    const badge = TYPE_BADGE[ci.ciType ?? "OTHER"] ?? TYPE_BADGE["OTHER"];
                    return (
                      <li key={ci.id}>
                        <button
                          type="button"
                          onClick={() => { onSelect(ci); setOpen(false); }}
                          className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-indigo-50 transition-colors"
                        >
                          <span className={`flex-shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${badge.bg} ${badge.text}`}>
                            {badge.label}
                          </span>
                          <span className="flex-1 min-w-0">
                            <span className="font-medium text-slate-800 truncate block">{ci.name}</span>
                            <span className="font-mono text-xs text-slate-400">{ci.apiSlug}</span>
                          </span>
                        </button>
                      </li>
                    );
                  })
                )}
              </ul>
            </div>
          )}
        </div>

        <p className="mt-4 text-center text-xs text-slate-400">
          {cis.length} CIs disponibles
        </p>
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function MapPage() {
  const [allCIs, setAllCIs]             = useState<CIOption[]>([]);
  const [allCIsMap, setAllCIsMap]       = useState<Map<string, CIOption>>(new Map());
  const [loadingCIs, setLoadingCIs]     = useState(true);
  const [selectedCI, setSelectedCI]     = useState<CIOption | null>(null);
  const [relations, setRelations]       = useState<Relations | null>(null);
  const [loadingRels, setLoadingRels]   = useState(false);
  const [error, setError]               = useState<string | null>(null);
  const [showRelModal, setShowRelModal] = useState(false);

  const [nodes, setNodes, onNodesChange] = useNodesState<CINodeData>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);

  // Load all CIs once (for selector + node lookup)
  useEffect(() => {
    apiFetch("/api/cis")
      .then((r) => r.json())
      .then((json: { data: CIOption[] }) => {
        setAllCIs(json.data);
        setAllCIsMap(new Map(json.data.map((c) => [c.id, c])));
      })
      .catch(() => setError("No se pudo cargar la lista de CIs"))
      .finally(() => setLoadingCIs(false));
  }, []);

  const loadRelations = useCallback(async (ci: CIOption) => {
    setLoadingRels(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/cis/${ci.id}/relations`);
      if (!res.ok) throw new Error(`Status ${res.status}`);
      const data: Relations = await res.json();
      setRelations(data);
      const { nodes: n, edges: e } = buildFocusedGraph(ci, data, allCIsMap);
      setNodes(n);
      setEdges(e);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error desconocido");
    } finally {
      setLoadingRels(false);
    }
  }, [allCIsMap, setNodes, setEdges]);

  const handleSelectCI = (ci: CIOption) => {
    setSelectedCI(ci);
    loadRelations(ci);
  };

  const handleBack = () => {
    setSelectedCI(null);
    setRelations(null);
    setNodes([]);
    setEdges([]);
    setError(null);
  };

  const handleRelationCreated = () => {
    setShowRelModal(false);
    if (selectedCI) loadRelations(selectedCI);
  };

  // ── Render: loading CIs ──
  if (loadingCIs) {
    return (
      <div className="flex h-full items-center justify-center bg-slate-50">
        <RefreshCw className="mr-2 h-5 w-5 animate-spin text-slate-400" />
        <span className="text-sm text-slate-400">Cargando CIs…</span>
      </div>
    );
  }

  // ── Render: CI selector ──
  if (!selectedCI) {
    return <CISelector cis={allCIs} onSelect={handleSelectCI} />;
  }

  // ── Render: focused graph ──
  const badge = TYPE_BADGE[selectedCI.ciType ?? "OTHER"] ?? TYPE_BADGE["OTHER"];

  return (
    <div className="flex h-full flex-col bg-slate-50">
      {showRelModal && (
        <AddRelationModal
          preselectedSourceId={selectedCI.id}
          onClose={() => setShowRelModal(false)}
          onCreated={handleRelationCreated}
        />
      )}

      {/* Header */}
      <header className="flex-shrink-0 border-b border-slate-200 bg-white px-6 py-3">
        <div className="flex items-center gap-4">
          <button
            onClick={handleBack}
            className="flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50 transition-colors"
          >
            <ArrowLeft className="h-4 w-4" /> Cambiar CI
          </button>

          <div className="flex items-center gap-2 min-w-0">
            <span className={`flex-shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${badge.bg} ${badge.text}`}>
              {badge.label}
            </span>
            <span className="font-bold text-slate-900 truncate">{selectedCI.name}</span>
            <span className="font-mono text-xs text-slate-400 hidden sm:block">{selectedCI.apiSlug}</span>
          </div>

          {relations && !loadingRels && (
            <span className="ml-1 text-xs text-slate-400 hidden md:block">
              {relations.incoming.length} entrantes · {relations.outgoing.length} salientes
            </span>
          )}

          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={() => selectedCI && loadRelations(selectedCI)}
              disabled={loadingRels}
              className="flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-500 hover:bg-slate-50 disabled:opacity-50 transition-colors"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loadingRels ? "animate-spin" : ""}`} />
            </button>
            <button
              onClick={() => setShowRelModal(true)}
              className="flex items-center gap-2 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-indigo-700 transition-colors"
            >
              <Link2 className="h-4 w-4" /> Nueva Relación
            </button>
          </div>
        </div>
      </header>

      {/* Graph area */}
      <div className="relative flex-1">
        {loadingRels && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-slate-50">
            <RefreshCw className="mr-2 h-6 w-6 animate-spin text-slate-400" />
            <span className="text-sm text-slate-400">Cargando relaciones…</span>
          </div>
        )}

        {error && !loadingRels && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-slate-50">
            <AlertTriangle className="h-10 w-10 text-red-400" />
            <p className="text-sm font-medium text-red-600">{error}</p>
            <button
              onClick={() => selectedCI && loadRelations(selectedCI)}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm text-white hover:bg-indigo-700"
            >
              Reintentar
            </button>
          </div>
        )}

        {!loadingRels && !error && relations && relations.total === 0 && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-slate-50">
            <Network className="h-12 w-12 text-slate-300" />
            <p className="text-sm font-medium text-slate-500">Este CI no tiene relaciones</p>
            <button
              onClick={() => setShowRelModal(true)}
              className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700"
            >
              <Link2 className="h-4 w-4" /> Crear primera relación
            </button>
          </div>
        )}

        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          nodeTypes={NODE_TYPES}
          fitView
          fitViewOptions={{ padding: 0.25 }}
          minZoom={0.2}
          maxZoom={2}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="#cbd5e1" />
          <Controls position="bottom-right" />
        </ReactFlow>
      </div>
    </div>
  );
}

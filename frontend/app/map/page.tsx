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
  Network, Search, Link2, RefreshCw, AlertTriangle, ArrowLeft,
  ChevronDown, LayoutList, Download, Trash2,
} from "lucide-react";
import { apiFetch } from "@/lib/apiFetch";
import AddRelationModal from "@/components/AddRelationModal";
import { useAuth } from "@/contexts/AuthContext";

// ─── Types ────────────────────────────────────────────────────────────────────

interface CIOption {
  id: string;
  name: string;
  apiSlug: string;
  ciType: string | null;
  criticality: string;
  environment: string;
  spofRisk?: boolean;
}

interface RelationRow {
  id: string;
  source_ci_id: string;
  target_ci_id: string;
  relation_type: string;
  source_name: string;
  source_slug: string;
  target_name: string;
  target_slug: string;
  depth: number;
}

interface Relations {
  outgoing: RelationRow[];
  incoming: RelationRow[];
  all: RelationRow[];
  total: number;
}

interface CINodeData {
  label: string;
  apiSlug: string;
  ciType: string;
  environment: string;
  criticality: string;
  isCenter: boolean;
  spofRisk: boolean;
}

type ViewMode = "graph" | "table";

// ─── Constants ────────────────────────────────────────────────────────────────

const RELATION_COLORS: Record<string, { stroke: string; label: string; bg: string; text: string }> = {
  HOSTS:            { stroke: "#6366f1", label: "HOSTS",            bg: "#eef2ff", text: "text-indigo-700" },
  DEPENDS_ON:       { stroke: "#f97316", label: "DEPENDS_ON",       bg: "#fff7ed", text: "text-orange-700" },
  CONNECTED_TO:     { stroke: "#0d9488", label: "CONNECTED_TO",     bg: "#f0fdfa", text: "text-teal-700"   },
  PROVIDES_SERVICE: { stroke: "#10b981", label: "PROVIDES_SERVICE", bg: "#f0fdf4", text: "text-emerald-700"},
  BACKED_UP_BY:     { stroke: "#8b5cf6", label: "BACKED_UP_BY",     bg: "#faf5ff", text: "text-violet-700" },
};

const CRIT_DOT: Record<string, string> = {
  MISSION_CRITICAL: "bg-red-500",
  HIGH:             "bg-orange-400",
  MEDIUM:           "bg-yellow-400",
  LOW:              "bg-slate-300",
};

const TYPE_BADGE: Record<string, { bg: string; text: string; label: string }> = {
  PHYSICAL_SERVER:   { bg: "bg-emerald-100", text: "text-emerald-700", label: "Servidor Físico"  },
  VIRTUAL_SERVER:    { bg: "bg-teal-100",    text: "text-teal-700",    label: "Servidor Virtual" },
  DATABASE:          { bg: "bg-blue-100",    text: "text-blue-700",    label: "Base de Datos"    },
  NETWORK_EQUIPMENT: { bg: "bg-cyan-100",    text: "text-cyan-700",    label: "Red"              },
  STORAGE:           { bg: "bg-amber-100",   text: "text-amber-700",   label: "Almacenamiento"   },
  BACKUP:            { bg: "bg-purple-100",  text: "text-purple-700",  label: "Backup"           },
  BASE_SOFTWARE:     { bg: "bg-indigo-100",  text: "text-indigo-700",  label: "Software Base"    },
  OTHER:             { bg: "bg-slate-100",   text: "text-slate-600",   label: "Otro"             },
};

const DEPTH_OPTIONS = [
  { value: 1, label: "1 nivel",   desc: "Solo directas" },
  { value: 2, label: "2 niveles", desc: "Hasta 2 saltos" },
  { value: 3, label: "3 niveles", desc: "Hasta 3 saltos" },
];

// ─── CI Node (ReactFlow) ──────────────────────────────────────────────────────

function CINode({ data }: NodeProps<CINodeData>) {
  const badge = TYPE_BADGE[data.ciType] ?? TYPE_BADGE["OTHER"];
  const dot   = CRIT_DOT[data.criticality] ?? "bg-slate-300";

  return (
    <div className={`relative w-52 rounded-xl border-2 shadow-md bg-white ${
      data.spofRisk
        ? "border-red-400 ring-2 ring-red-100"
        : data.isCenter
          ? "border-indigo-500 ring-4 ring-indigo-100 shadow-indigo-100"
          : "border-slate-200 hover:border-slate-300"
    }`}>
      <span className={`absolute -top-1.5 -right-1.5 h-3 w-3 rounded-full border-2 border-white ${dot}`} />
      <div className="px-3 py-2.5">
        <div className="flex items-center justify-between mb-1.5">
          <span className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold ${badge.bg} ${badge.text}`}>
            {badge.label}
          </span>
          <div className="flex gap-1">
            {data.spofRisk && (
              <span className="inline-block rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-semibold text-red-700" title="Punto Único de Fallo">
                SPOF
              </span>
            )}
            {data.isCenter && (
              <span className="inline-block rounded-full bg-indigo-600 px-2 py-0.5 text-[10px] font-semibold text-white">
                origen
              </span>
            )}
          </div>
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
void NODE_W;

function buildGraph(
  center: CIOption,
  allRelations: RelationRow[],
  allCIsMap: Map<string, CIOption>
): { nodes: Node<CINodeData>[]; edges: Edge[] } {
  const nodes: Node<CINodeData>[] = [];
  const edges: Edge[]             = [];

  const makeNodeData = (ci: CIOption, isCenter: boolean): CINodeData => ({
    label:       ci.name,
    apiSlug:     ci.apiSlug,
    ciType:      ci.ciType ?? "OTHER",
    environment: ci.environment,
    criticality: ci.criticality,
    isCenter,
    spofRisk:    ci.spofRisk ?? false,
  });

  // BFS from root to assign column (positive = outgoing, negative = incoming)
  const ciToCol = new Map<string, number>();
  const queue: { ciId: string; col: number }[] = [{ ciId: center.id, col: 0 }];
  ciToCol.set(center.id, 0);

  while (queue.length > 0) {
    const { ciId, col } = queue.shift()!;
    for (const rel of allRelations) {
      let nextId: string | null = null;
      let nextCol = 0;
      if (rel.source_ci_id === ciId && !ciToCol.has(rel.target_ci_id)) {
        nextId  = rel.target_ci_id;
        nextCol = col + 1;
      } else if (rel.target_ci_id === ciId && !ciToCol.has(rel.source_ci_id)) {
        nextId  = rel.source_ci_id;
        nextCol = col - 1;
      }
      if (nextId) {
        ciToCol.set(nextId, nextCol);
        queue.push({ ciId: nextId, col: nextCol });
      }
    }
  }

  // Group CIs by column
  const colToCIs = new Map<number, string[]>();
  for (const [ciId, col] of ciToCol.entries()) {
    if (!colToCIs.has(col)) colToCIs.set(col, []);
    colToCIs.get(col)!.push(ciId);
  }

  const minCol     = Math.min(...Array.from(colToCIs.keys()));
  const maxRowCount= Math.max(...Array.from(colToCIs.values()).map((a) => a.length));
  const totalH     = (maxRowCount - 1) * (NODE_H + V_GAP);

  for (const [col, ciIds] of colToCIs.entries()) {
    const x       = (col - minCol) * H_GAP;
    const colH    = (ciIds.length - 1) * (NODE_H + V_GAP);
    const yOffset = (totalH - colH) / 2;

    ciIds.forEach((ciId, idx) => {
      const ci = ciId === center.id
        ? center
        : allCIsMap.get(ciId) ?? {
            id: ciId, name: ciId.slice(0, 8), apiSlug: ciId.slice(0, 8),
            ciType: null, criticality: "MEDIUM", environment: "PRODUCTION", spofRisk: false,
          };
      nodes.push({
        id: ciId, type: "ciNode",
        position: { x, y: yOffset + idx * (NODE_H + V_GAP) },
        data: makeNodeData(ci, ciId === center.id),
      });
    });
  }

  // Edges — deduplicate by relation id
  const seen = new Set<string>();
  for (const rel of allRelations) {
    if (seen.has(rel.id)) continue;
    seen.add(rel.id);
    const color = RELATION_COLORS[rel.relation_type] ?? RELATION_COLORS["CONNECTED_TO"];
    edges.push({
      id:    `rel-${rel.id}`,
      source: rel.source_ci_id,
      target: rel.target_ci_id,
      label:  rel.relation_type,
      labelStyle:   { fill: color.stroke, fontWeight: 600, fontSize: 10 },
      labelBgStyle: { fill: color.bg, rx: 4 },
      labelBgPadding: [4, 6] as [number, number],
      style: { stroke: color.stroke, strokeWidth: 2 },
      markerEnd: { type: MarkerType.ArrowClosed, color: color.stroke },
    });
  }

  return { nodes, edges };
}

// ─── Excel export ─────────────────────────────────────────────────────────────

async function exportToExcel(rows: RelationRow[], center: CIOption) {
  const XLSX = await import("xlsx");
  const data = rows.map((r) => ({
    "Dirección":        r.source_ci_id === center.id ? "Saliente →" : "← Entrante",
    "CI Origen":        r.source_name,
    "Slug Origen":      r.source_slug,
    "Tipo de Relación": r.relation_type,
    "CI Destino":       r.target_name,
    "Slug Destino":     r.target_slug,
    "Profundidad":      r.depth ?? 1,
  }));
  const ws = XLSX.utils.json_to_sheet(data);
  // Auto-fit column widths
  const colWidths = Object.keys(data[0] ?? {}).map((key) => ({
    wch: Math.max(key.length, ...data.map((row) => String(row[key as keyof typeof row]).length)) + 2,
  }));
  ws["!cols"] = colWidths;

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Dependencias");
  XLSX.writeFile(wb, `dependencias-${center.apiSlug}.xlsx`);
}

// ─── Table view ───────────────────────────────────────────────────────────────

function TableView({
  relations,
  center,
  depth,
  onDelete,
  isAdmin,
}: {
  relations: Relations;
  center: CIOption;
  depth: number;
  onDelete: (id: string) => void;
  isAdmin: boolean;
}) {
  const allRows = relations.all ?? [...relations.outgoing, ...relations.incoming];
  // Deduplicate
  const seen = new Set<string>();
  const rows = allRows.filter((r) => {
    if (seen.has(r.id)) return false;
    seen.add(r.id);
    return true;
  });

  // Sort by depth then relation type
  rows.sort((a, b) => (a.depth ?? 1) - (b.depth ?? 1) || a.relation_type.localeCompare(b.relation_type));

  if (rows.length === 0) return null;

  return (
    <div className="flex flex-col h-full">
      {/* Table header bar */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-slate-100 bg-white flex-shrink-0">
        <p className="text-sm text-slate-500">
          <span className="font-semibold text-slate-700">{rows.length}</span> relación{rows.length !== 1 ? "es" : ""}
          {depth > 1 && <span className="ml-1 text-slate-400">(hasta {depth} niveles)</span>}
        </p>
        <button
          onClick={() => exportToExcel(rows, center)}
          className="flex items-center gap-2 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-sm font-medium text-emerald-700 hover:bg-emerald-100 transition-colors"
        >
          <Download className="h-4 w-4" /> Exportar Excel
        </button>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-200">
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500 w-24">Dir.</th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">CI Origen</th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">Tipo de Relación</th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">CI Destino</th>
              {depth > 1 && (
                <th className="px-4 py-3 text-center text-xs font-semibold uppercase tracking-wide text-slate-500 w-20">Nivel</th>
              )}
              {isAdmin && (
                <th className="px-4 py-3 text-center text-xs font-semibold uppercase tracking-wide text-slate-500 w-20">Acciones</th>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const isSaliente = r.source_ci_id === center.id;
              const color      = RELATION_COLORS[r.relation_type] ?? RELATION_COLORS["CONNECTED_TO"];
              const rowDepth   = r.depth ?? 1;
              return (
                <tr key={r.id} className={`border-b border-slate-100 hover:bg-slate-50 transition-colors ${i % 2 === 0 ? "" : "bg-slate-50/40"}`}>
                  {/* Direction */}
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${
                      isSaliente ? "bg-indigo-50 text-indigo-700" : "bg-slate-100 text-slate-600"
                    }`}>
                      {isSaliente ? "↗ Sal." : "↙ Ent."}
                    </span>
                  </td>
                  {/* Source CI */}
                  <td className="px-4 py-3">
                    <span className={`font-medium ${r.source_ci_id === center.id ? "text-indigo-700" : "text-slate-800"}`}>
                      {r.source_name}
                    </span>
                    <span className="ml-1.5 font-mono text-xs text-slate-400">{r.source_slug}</span>
                  </td>
                  {/* Relation type */}
                  <td className="px-4 py-3">
                    <span
                      className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold ${color.text}`}
                      style={{ backgroundColor: color.bg }}
                    >
                      {r.relation_type}
                    </span>
                  </td>
                  {/* Target CI */}
                  <td className="px-4 py-3">
                    <span className={`font-medium ${r.target_ci_id === center.id ? "text-indigo-700" : "text-slate-800"}`}>
                      {r.target_name}
                    </span>
                    <span className="ml-1.5 font-mono text-xs text-slate-400">{r.target_slug}</span>
                  </td>
                  {/* Depth level */}
                  {depth > 1 && (
                    <td className="px-4 py-3 text-center">
                      <span className={`inline-flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-bold ${
                        rowDepth === 1 ? "bg-indigo-600 text-white" : "bg-slate-200 text-slate-600"
                      }`}>
                        {rowDepth}
                      </span>
                    </td>
                  )}
                  {/* Delete */}
                  {isAdmin && (
                    <td className="px-4 py-3 text-center">
                      <button
                        onClick={() => onDelete(r.id)}
                        title="Eliminar relación"
                        className="inline-flex items-center justify-center rounded-lg p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600 transition-colors"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── CI Selector ─────────────────────────────────────────────────────────────

function CISelector({
  cis,
  onSelect,
}: {
  cis: CIOption[];
  onSelect: (ci: CIOption, depth: number) => void;
}) {
  const [search,      setSearch]      = useState("");
  const [open,        setOpen]        = useState(false);
  const [selected,    setSelected]    = useState<CIOption | null>(null);
  const [depthChoice, setDepthChoice] = useState(1);
  const ref = useRef<HTMLDivElement>(null);

  const filtered = cis.filter(
    (c) =>
      c.name.toLowerCase().includes(search.toLowerCase()) ||
      c.apiSlug.toLowerCase().includes(search.toLowerCase())
  );

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && e.target instanceof Element && !ref.current.contains(e.target))
        setOpen(false);
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

        {/* CI picker */}
        <div ref={ref} className="relative mb-5">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="flex w-full items-center justify-between rounded-xl border border-slate-300 bg-slate-50 px-4 py-3 text-left text-sm hover:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-200 transition-colors"
          >
            {selected ? (
              <span className="flex items-center gap-2 min-w-0">
                <span className={`flex-shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${(TYPE_BADGE[selected.ciType ?? "OTHER"] ?? TYPE_BADGE["OTHER"]).bg} ${(TYPE_BADGE[selected.ciType ?? "OTHER"] ?? TYPE_BADGE["OTHER"]).text}`}>
                  {(TYPE_BADGE[selected.ciType ?? "OTHER"] ?? TYPE_BADGE["OTHER"]).label}
                </span>
                <span className="font-medium text-slate-800 truncate">{selected.name}</span>
                <span className="font-mono text-xs text-slate-400 hidden sm:block">{selected.apiSlug}</span>
              </span>
            ) : (
              <span className="text-slate-400">Buscar CI por nombre o slug…</span>
            )}
            <ChevronDown className={`ml-2 h-4 w-4 flex-shrink-0 text-slate-400 transition-transform ${open ? "rotate-180" : ""}`} />
          </button>

          {open && (
            <div className="absolute z-50 mt-2 w-full rounded-xl border border-slate-200 bg-white shadow-2xl">
              <div className="border-b border-slate-100 p-3">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <input
                    autoFocus type="text" value={search}
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
                          onClick={() => { setSelected(ci); setOpen(false); setSearch(""); }}
                          className={`flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-indigo-50 transition-colors ${selected?.id === ci.id ? "bg-indigo-50" : ""}`}
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

        {/* Depth selector */}
        <div className="mb-6">
          <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">
            Profundidad de dependencia
          </label>
          <div className="flex gap-2">
            {DEPTH_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => setDepthChoice(opt.value)}
                className={`flex-1 rounded-xl border-2 px-3 py-2.5 text-center transition-all ${
                  depthChoice === opt.value
                    ? "border-indigo-500 bg-indigo-50"
                    : "border-slate-200 bg-white hover:border-slate-300"
                }`}
              >
                <p className={`text-sm font-bold ${depthChoice === opt.value ? "text-indigo-700" : "text-slate-700"}`}>
                  {opt.label}
                </p>
                <p className="text-[11px] text-slate-400 mt-0.5">{opt.desc}</p>
              </button>
            ))}
          </div>
        </div>

        <button
          type="button"
          disabled={!selected}
          onClick={() => selected && onSelect(selected, depthChoice)}
          className="w-full rounded-xl bg-indigo-600 px-4 py-3 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {selected ? `Ver dependencias de "${selected.name}"` : "Selecciona un CI para continuar"}
        </button>

        <p className="mt-3 text-center text-xs text-slate-400">
          {cis.length} CIs disponibles
        </p>
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function MapPage() {
  const { isAdmin } = useAuth();

  const [allCIs,      setAllCIs]      = useState<CIOption[]>([]);
  const [allCIsMap,   setAllCIsMap]   = useState<Map<string, CIOption>>(new Map());
  const [loadingCIs,  setLoadingCIs]  = useState(true);
  const [selectedCI,  setSelectedCI]  = useState<CIOption | null>(null);
  const [depth,       setDepth]       = useState(1);
  const [relations,   setRelations]   = useState<Relations | null>(null);
  const [loadingRels, setLoadingRels] = useState(false);
  const [error,       setError]       = useState<string | null>(null);
  const [viewMode,    setViewMode]    = useState<ViewMode>("graph");
  const [showModal,   setShowModal]   = useState(false);

  const [nodes, setNodes, onNodesChange] = useNodesState<CINodeData>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);

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

  const loadRelations = useCallback(async (ci: CIOption, d: number) => {
    setLoadingRels(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/cis/${ci.id}/relations?depth=${d}`);
      if (!res.ok) throw new Error(`Status ${res.status}`);
      const data: Relations = await res.json();
      setRelations(data);
      const allRels = data.all ?? [...data.outgoing, ...data.incoming];
      const { nodes: n, edges: e } = buildGraph(ci, allRels, allCIsMap);
      setNodes(n);
      setEdges(e);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error desconocido");
    } finally {
      setLoadingRels(false);
    }
  }, [allCIsMap, setNodes, setEdges]);

  const handleSelectCI = (ci: CIOption, d: number) => {
    setSelectedCI(ci);
    setDepth(d);
    setViewMode("graph");
    loadRelations(ci, d);
  };

  const handleBack = () => {
    setSelectedCI(null);
    setRelations(null);
    setNodes([]);
    setEdges([]);
    setError(null);
  };

  const handleRelationCreated = () => {
    setShowModal(false);
    if (selectedCI) loadRelations(selectedCI, depth);
  };

  const handleDeleteRelation = async (id: string) => {
    if (!confirm("¿Eliminar esta dependencia?")) return;
    const res = await apiFetch(`/api/relations/${id}`, { method: "DELETE" });
    if (!res.ok) { alert("Error al eliminar la relación"); return; }
    if (selectedCI) loadRelations(selectedCI, depth);
  };

  // ── Loading CIs ──
  if (loadingCIs) {
    return (
      <div className="flex h-full items-center justify-center bg-slate-50">
        <RefreshCw className="mr-2 h-5 w-5 animate-spin text-slate-400" />
        <span className="text-sm text-slate-400">Cargando CIs…</span>
      </div>
    );
  }

  // ── CI Selector ──
  if (!selectedCI) {
    return <CISelector cis={allCIs} onSelect={handleSelectCI} />;
  }

  // ── Graph / Table ──
  const badge = TYPE_BADGE[selectedCI.ciType ?? "OTHER"] ?? TYPE_BADGE["OTHER"];

  return (
    <div className="flex h-full flex-col bg-slate-50">
      {showModal && (
        <AddRelationModal
          preselectedSourceId={selectedCI.id}
          onClose={() => setShowModal(false)}
          onCreated={handleRelationCreated}
        />
      )}

      {/* Header */}
      <header className="sticky top-0 z-10 flex-shrink-0 border-b border-slate-200 bg-white px-6 py-3">
        <div className="flex items-center gap-3 flex-wrap">
          {/* Back */}
          <button
            onClick={handleBack}
            className="flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50 transition-colors"
          >
            <ArrowLeft className="h-4 w-4" /> Cambiar CI
          </button>

          {/* CI info */}
          <div className="flex items-center gap-2 min-w-0">
            <span className={`flex-shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${badge.bg} ${badge.text}`}>
              {badge.label}
            </span>
            <span className="font-bold text-slate-900 truncate">{selectedCI.name}</span>
            <span className="font-mono text-xs text-slate-400 hidden sm:block">{selectedCI.apiSlug}</span>
          </div>

          {/* Depth badge */}
          <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-600 hidden md:inline">
            {depth} nivel{depth !== 1 ? "es" : ""}
          </span>

          {/* Stats */}
          {relations && !loadingRels && (
            <span className="text-xs text-slate-400 hidden lg:block">
              {relations.incoming.length} entrantes · {relations.outgoing.length} salientes
              {depth > 1 && ` · ${relations.total} total`}
            </span>
          )}

          <div className="ml-auto flex items-center gap-2">
            {/* View toggle */}
            <div className="flex rounded-lg border border-slate-200 overflow-hidden">
              <button
                onClick={() => setViewMode("graph")}
                title="Vista de grafo"
                className={`flex items-center gap-1.5 px-3 py-1.5 text-sm transition-colors ${
                  viewMode === "graph"
                    ? "bg-indigo-600 text-white"
                    : "bg-white text-slate-500 hover:bg-slate-50"
                }`}
              >
                <Network className="h-4 w-4" />
                <span className="hidden sm:inline">Grafo</span>
              </button>
              <button
                onClick={() => setViewMode("table")}
                title="Vista de tabla"
                className={`flex items-center gap-1.5 px-3 py-1.5 text-sm transition-colors border-l border-slate-200 ${
                  viewMode === "table"
                    ? "bg-indigo-600 text-white"
                    : "bg-white text-slate-500 hover:bg-slate-50"
                }`}
              >
                <LayoutList className="h-4 w-4" />
                <span className="hidden sm:inline">Tabla</span>
              </button>
            </div>

            {/* Refresh */}
            <button
              onClick={() => loadRelations(selectedCI, depth)}
              disabled={loadingRels}
              className="flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-500 hover:bg-slate-50 disabled:opacity-50 transition-colors"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loadingRels ? "animate-spin" : ""}`} />
            </button>

            {/* New relation */}
            <button
              onClick={() => setShowModal(true)}
              className="flex items-center gap-2 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-indigo-700 transition-colors"
            >
              <Link2 className="h-4 w-4" />
              <span className="hidden sm:inline">Nueva Relación</span>
            </button>
          </div>
        </div>
      </header>

      {/* Content area */}
      <div className="relative flex-1 overflow-hidden">
        {/* Loading overlay */}
        {loadingRels && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-slate-50">
            <RefreshCw className="mr-2 h-6 w-6 animate-spin text-slate-400" />
            <span className="text-sm text-slate-400">Cargando relaciones…</span>
          </div>
        )}

        {/* Error */}
        {error && !loadingRels && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-slate-50">
            <AlertTriangle className="h-10 w-10 text-red-400" />
            <p className="text-sm font-medium text-red-600">{error}</p>
            <button
              onClick={() => loadRelations(selectedCI, depth)}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm text-white hover:bg-indigo-700"
            >
              Reintentar
            </button>
          </div>
        )}

        {/* Empty state */}
        {!loadingRels && !error && relations && relations.total === 0 && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-slate-50">
            <Network className="h-12 w-12 text-slate-300" />
            <p className="text-sm font-medium text-slate-500">Este CI no tiene relaciones</p>
            <button
              onClick={() => setShowModal(true)}
              className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700"
            >
              <Link2 className="h-4 w-4" /> Crear primera relación
            </button>
          </div>
        )}

        {/* Graph view */}
        {viewMode === "graph" && !loadingRels && !error && (
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
            onEdgeClick={isAdmin ? (_, edge) => handleDeleteRelation(edge.id.replace("rel-", "")) : undefined}
          >
            <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="#cbd5e1" />
            <Controls position="bottom-right" />
          </ReactFlow>
        )}

        {/* Table view */}
        {viewMode === "table" && !loadingRels && !error && relations && relations.total > 0 && (
          <div className="absolute inset-0 flex flex-col bg-white">
            <TableView relations={relations} center={selectedCI} depth={depth} onDelete={handleDeleteRelation} isAdmin={isAdmin} />
          </div>
        )}
      </div>
    </div>
  );
}

"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { apiFetch } from "@/lib/apiFetch";

// ─── Types ────────────────────────────────────────────────────────────────────

export type PluginSlot =
  | "DashboardWidget"
  | "CIDetailTab"
  | "ContractDetailTab"
  | "TopBarMenu"
  | "SettingsPanel"
  | "InventoryColumn"
  | "MapOverlay";

export const ALL_PLUGIN_SLOTS: PluginSlot[] = [
  "DashboardWidget",
  "CIDetailTab",
  "ContractDetailTab",
  "TopBarMenu",
  "SettingsPanel",
  "InventoryColumn",
  "MapOverlay",
];

export interface Plugin {
  id: string;
  pluginId: string;
  name: string;
  version: string;
  author: string;
  description?: string;
  status: string;
  checksum: string;
  installedAt: string | null;
  activatedAt: string | null;
  lastError: string | null;
  manifest?: {
    uiSlots?: PluginSlot[];
    [key: string]: unknown;
  };
}

export interface PluginSlotDefinition {
  pluginId: string;     // the UUID primary key (id field in PluginRegistry)
  pluginName: string;
  slotName: PluginSlot;
}

interface PluginContextValue {
  activePlugins: Plugin[];
  slotsByName: Record<PluginSlot, PluginSlotDefinition[]>;
  loading: boolean;
  refresh: () => Promise<void>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildSlotsByName(plugins: Plugin[]): Record<PluginSlot, PluginSlotDefinition[]> {
  const result = {} as Record<PluginSlot, PluginSlotDefinition[]>;
  for (const slot of ALL_PLUGIN_SLOTS) {
    result[slot] = [];
  }
  for (const plugin of plugins) {
    const slots: PluginSlot[] = plugin.manifest?.uiSlots ?? [];
    for (const slot of slots) {
      if (slot in result) {
        result[slot].push({
          pluginId: plugin.id,
          pluginName: plugin.name,
          slotName: slot,
        });
      }
    }
  }
  return result;
}

// ─── Context ──────────────────────────────────────────────────────────────────

const PluginContext = createContext<PluginContextValue | null>(null);

export function PluginProvider({ children }: { children: React.ReactNode }) {
  const [activePlugins, setActivePlugins] = useState<Plugin[]>([]);
  const [slotsByName, setSlotsByName] = useState<Record<PluginSlot, PluginSlotDefinition[]>>(
    () => buildSlotsByName([])
  );
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch("/api/plugins");
      if (!res.ok) return;
      const data = await res.json() as { plugins?: Plugin[] } | Plugin[];
      // Handle both `{ plugins: [...] }` (current backend shape) and bare array (legacy)
      const all: Plugin[] = Array.isArray(data) ? data : (data as { plugins?: Plugin[] }).plugins ?? [];
      const active = all.filter((p) => p.status === "ACTIVE");
      setActivePlugins(active);
      setSlotsByName(buildSlotsByName(active));
    } catch {
      // Non-blocking: plugin slot system degrades silently if unavailable
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <PluginContext.Provider value={{ activePlugins, slotsByName, loading, refresh }}>
      {children}
    </PluginContext.Provider>
  );
}

export function usePlugins(): PluginContextValue {
  const ctx = useContext(PluginContext);
  if (!ctx) throw new Error("usePlugins must be used inside <PluginProvider>");
  return ctx;
}

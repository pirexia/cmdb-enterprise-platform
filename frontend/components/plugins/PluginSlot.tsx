"use client";

import { usePlugins, type PluginSlot as PluginSlotName } from "@/contexts/PluginContext";
import PluginIframe from "./PluginIframe";

// ─── Types ────────────────────────────────────────────────────────────────────

interface PluginSlotProps {
  slotName: PluginSlotName;
  context?: Record<string, unknown>;
  className?: string;
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * PluginSlot renders all active plugin iframes registered for a given slot.
 * Zero-cost when no plugins are active for the slot (renders null).
 * Safe to place anywhere in the tree — it will simply be invisible when empty.
 */
export default function PluginSlot({ slotName, context, className }: PluginSlotProps) {
  const { slotsByName, loading } = usePlugins();

  // While loading, render nothing to avoid layout shift
  if (loading) return null;

  const definitions = slotsByName[slotName] ?? [];

  // No plugins registered for this slot — completely invisible
  if (definitions.length === 0) return null;

  return (
    <div className={`w-full space-y-3 ${className ?? ""}`}>
      {definitions.map((def) => (
        <PluginIframe
          key={`${def.pluginId}-${slotName}`}
          pluginId={def.pluginId}
          slotName={slotName}
          context={context}
        />
      ))}
    </div>
  );
}

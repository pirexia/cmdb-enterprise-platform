import { z } from 'zod';

// ── Manifest schema ──────────────────────────────────────────────────────────

export const PluginManifestSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/, 'plugin id must be kebab-case'),
  name: z.string().min(1).max(100),
  version: z.string().regex(/^\d+\.\d+\.\d+$/, 'version must be semver'),
  author: z.string().min(1).max(200),
  license: z.string().min(1).max(50),
  description: z.string().max(500).optional(),
  engineMin: z.string().regex(/^\d+\.\d+\.\d+$/).optional(),
  permissions: z.array(z.enum([
    'db:read',
    'db:write',
    'db:schema',    // DDL — requiere write_access explícito + 4-eyes
    'http:fetch',   // requiere allowedHosts no vacío
    'cron:register',
    'hooks:register',
    'routes:register',
    'ui:iframe',
  ])).default([]),
  allowedHosts: z.array(z.string().url()).default([]),
  hooks: z.array(z.string()).default([]),
  routes: z.array(z.object({
    method: z.enum(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']),
    path: z.string().startsWith('/'),
    requiresAuth: z.boolean().default(true),
    requiredRole: z.enum(['ADMIN', 'AUDITOR', 'VIEWER']).optional(),
  })).default([]),
  cronJobs: z.array(z.object({
    name: z.string(),
    schedule: z.string(),
  })).default([]),
  uiSlots: z.array(z.enum([
    'DashboardWidget',
    'CIDetailTab',
    'ContractDetailTab',
    'TopBarMenu',
    'SettingsPanel',
    'InventoryColumn',
    'MapOverlay',
  ])).default([]),
  signature: z.string().optional(), // Ed25519 base64
});

export type PluginManifest = z.infer<typeof PluginManifestSchema>;

// ── Config update ─────────────────────────────────────────────────────────────

export const PluginConfigUpdateSchema = z.object({
  config: z.record(z.unknown()),
});

// ── Activation (4-eyes in production) ────────────────────────────────────────

export const PluginActivateSchema = z.object({
  approvalToken: z.string().optional(), // required in production
});

// ── Plugin status enum ────────────────────────────────────────────────────────

export const PLUGIN_STATUSES = [
  'UPLOADED',
  'VALIDATED',
  'INSTALLED',
  'ACTIVE',
  'INACTIVE',
  'ERROR',
  'UNINSTALLING',
] as const;

export type PluginStatus = typeof PLUGIN_STATUSES[number];

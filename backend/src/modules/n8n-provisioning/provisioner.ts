/**
 * n8n-provisioning · orquestador idempotente.
 *
 * `provisionAll` aplica credenciales + workflows desde la config (env) a n8n de forma
 * idempotente:
 *   - Credenciales: existencia verificada leyendo `n8n_data.credentials_entity` por Postgres
 *     (la API pública no expone list/get de credenciales para el rol disponible, confirmado
 *     en Task 0 del spike — ver docs/n8n/PROVISIONING.md). Si existe → delete+create
 *     (recreate). Si no → create.
 *   - Workflows: match por nombre vía `listWorkflows()`. Si existe → update. Si no → create.
 *   - Activación: según política `activateWhen` del workflow + presencia de config.
 *
 * Errores por item se capturan sin abortar el resto (fail-soft) → ProvisionReport.errors.
 */
import type { PrismaClient } from '@prisma/client';
import type { N8nApiClient } from './apiClient.js';
import type { N8nProvisioningConfig } from './config.js';
import { buildHeaderAuthCredential, buildSmtpCredential, buildLdapCredential, CRED_NAMES } from './credentials.js';
import { renderWorkflows } from './workflows.js';
import type { ActivateWhen } from './workflows.js';

export interface ProvisionReport {
  credentials: { name: string; action: 'created' | 'recreated' | 'skipped' }[];
  workflows:   { name: string; action: 'created' | 'updated'; active: boolean }[];
  errors:      string[];
}

function shouldActivate(policy: ActivateWhen, cfg: N8nProvisioningConfig): boolean {
  if (policy === 'always') return true;
  if (policy === 'smtp')   return cfg.smtp !== null;
  if (policy === 'ldap')   return cfg.ldap?.useLdap === true;
  return false;
}

/** Rellena los `id` vacíos de los bindings de credencial en los nodos con los ids reales. */
function injectCredentialIds(
  nodes: Record<string, unknown>[],
  credIdMap: Map<string, string>,
): void {
  for (const node of nodes) {
    const n = node as any;
    if (!n.credentials || typeof n.credentials !== 'object') continue;
    for (const credType of Object.keys(n.credentials)) {
      const binding = n.credentials[credType];
      if (binding && typeof binding === 'object' && 'name' in binding) {
        const realId = credIdMap.get(binding.name as string);
        if (realId) {
          n.credentials[credType] = { ...binding, id: realId };
        }
      }
    }
  }
}

export async function provisionAll(
  client: N8nApiClient,
  cfg: N8nProvisioningConfig,
  prisma: PrismaClient,
): Promise<ProvisionReport> {
  const report: ProvisionReport = { credentials: [], workflows: [], errors: [] };
  const credIdMap = new Map<string, string>();

  // ── 1. Credenciales ────────────────────────────────────────────────────────
  // La API de n8n no lista credenciales → leer directamente de la BD compartida.
  type CredRow = { id: string; name: string };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const existingCreds: CredRow[] = (await (prisma.$queryRaw<CredRow[]>`
    SELECT id, name FROM n8n_data.credentials_entity
  ` as any)) as CredRow[];
  const existingCredMap = new Map(existingCreds.map((r) => [r.name as string, r.id as string]));

  const credProviders = [
    { name: CRED_NAMES.headerAuth, build: () => buildHeaderAuthCredential(cfg) },
    { name: CRED_NAMES.smtp,       build: () => buildSmtpCredential(cfg) },
    { name: CRED_NAMES.ldap,       build: () => buildLdapCredential(cfg) },
  ] as const;

  for (const { name, build } of credProviders) {
    try {
      const payload = build();
      if (!payload) {
        report.credentials.push({ name, action: 'skipped' });
        continue;
      }
      const existingId = existingCredMap.get(name);
      if (existingId) {
        await client.deleteCredential(existingId);
        const { id } = await client.createCredential(payload);
        credIdMap.set(name, id);
        report.credentials.push({ name, action: 'recreated' });
      } else {
        const { id } = await client.createCredential(payload);
        credIdMap.set(name, id);
        report.credentials.push({ name, action: 'created' });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      report.errors.push(`credential:${name}: ${msg}`);
    }
  }

  // ── 2. Workflows ───────────────────────────────────────────────────────────
  const existingWfs = await client.listWorkflows();
  const existingWfMap = new Map(existingWfs.map((w) => [w.name, { id: w.id, active: w.active }]));
  const rendered = renderWorkflows(cfg);

  for (const wf of rendered) {
    try {
      // Inyectar ids reales de credencial (sustituye '' de los placeholders de T4)
      injectCredentialIds(wf.nodes, credIdMap);

      const body = {
        name:        wf.name,
        nodes:       wf.nodes,
        connections: wf.connections,
        settings:    wf.settings,
      };

      let wfId: string;
      let action: 'created' | 'updated';

      const existing = existingWfMap.get(wf.name);
      if (existing) {
        await client.updateWorkflow(existing.id, body);
        wfId   = existing.id;
        action = 'updated';
      } else {
        const created = await client.createWorkflow(body);
        wfId   = created.id;
        action = 'created';
      }

      const active = shouldActivate(wf.activateWhen, cfg);
      if (active) {
        await client.activateWorkflow(wfId);
      }

      report.workflows.push({ name: wf.name, action, active });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      report.errors.push(`workflow:${wf.name}: ${msg}`);
    }
  }

  return report;
}

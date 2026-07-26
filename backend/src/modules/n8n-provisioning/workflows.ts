/**
 * n8n-provisioning · renderizado de workflows desde plantillas + config (env).
 *
 * - Sustituye placeholders `{{ENV:VAR}}` (con escape JSON correcto para DNs, etc.).
 * - Inyecta los bindings de credencial POR NOMBRE (id vacío → lo rellena el provisioner
 *   tras crear la credencial, ya que el id solo se conoce en tiempo de aprovisionamiento).
 * - Marca `activateWhen` para que el provisioner decida la activación según la config.
 */
import { TEMPLATES } from './templates/index.js';
import { CRED_NAMES } from './credentials.js';
import type { N8nProvisioningConfig } from './config.js';

export type ActivateWhen = 'smtp' | 'ldap' | 'always' | 'vcenter';

export interface RenderedWorkflow {
  name: string;
  nodes: Record<string, unknown>[];
  connections: Record<string, unknown>;
  settings: Record<string, unknown>;
  activateWhen: ActivateWhen;
}

const ACTIVATE_POLICY: Record<string, ActivateWhen> = {
  'Alertas CMDB': 'smtp',
  'LDAP Group Sync': 'ldap',
  'vCenter Sync': 'vcenter',
};

/** Inyecta el binding de credencial (por nombre, id vacío) según el tipo de nodo. */
function injectCredentials(nodes: Record<string, unknown>[]): void {
  for (const node of nodes) {
    const n = node as any;
    const params = n.parameters ?? {};
    if (params.authentication === 'genericCredentialType' && params.genericAuthType === 'httpHeaderAuth') {
      n.credentials = { ...n.credentials, httpHeaderAuth: { id: '', name: CRED_NAMES.headerAuth } };
    }
    if (n.type === 'n8n-nodes-base.emailSend') {
      n.credentials = { ...n.credentials, smtp: { id: '', name: CRED_NAMES.smtp } };
    }
    if (n.type === 'n8n-nodes-base.ldap') {
      n.credentials = { ...n.credentials, ldap: { id: '', name: CRED_NAMES.ldap } };
    }
  }
}

export function renderWorkflows(cfg: N8nProvisioningConfig): RenderedWorkflow[] {
  const env: Record<string, string> = {
    ALERT_FROM_EMAIL:   cfg.smtp?.from ?? '',
    LDAP_SYNC_CRON:     cfg.ldap?.syncCron ?? '0 3 * * *',
    VCENTER_SYNC_CRON:  cfg.vcenter?.cron ?? '0 */6 * * *',
  };

  return TEMPLATES.map((tpl) => {
    // Sustitución sobre el JSON serializado; el valor se escapa para JSON (DNs con comas/quotes).
    const rendered = JSON.stringify(tpl).replace(/\{\{ENV:(\w+)\}\}/g, (_m, key: string) => {
      const val = env[key] ?? '';
      return JSON.stringify(val).slice(1, -1); // escape JSON sin las comillas envolventes
    });
    const clone = JSON.parse(rendered) as {
      name: string; nodes: Record<string, unknown>[]; connections: Record<string, unknown>; settings: Record<string, unknown>;
    };
    injectCredentials(clone.nodes);
    return {
      name: clone.name,
      nodes: clone.nodes,
      connections: clone.connections,
      settings: clone.settings ?? {},
      activateWhen: ACTIVATE_POLICY[clone.name] ?? 'always',
    };
  });
}

/**
 * n8n-provisioning · cliente fino de la API REST pública de n8n (`/api/v1`).
 *
 * Una sola responsabilidad: HTTP + auth por `X-N8N-API-KEY`. No conoce credenciales
 * ni workflows concretos. Errores: lanza `Error` con el status (sin volcar el body
 * completo en logs — A09). La API pública de n8n NO expone list/get de credenciales
 * para el rol disponible (ver docs/n8n/PROVISIONING.md); por eso no hay `listCredentials`.
 */
import type { N8nProvisioningConfig } from './config.js';

export interface N8nWorkflowSummary { id: string; name: string; active: boolean }

export interface N8nApiClient {
  listWorkflows(): Promise<N8nWorkflowSummary[]>;
  createWorkflow(body: unknown): Promise<{ id: string }>;
  updateWorkflow(id: string, body: unknown): Promise<void>;
  activateWorkflow(id: string): Promise<void>;
  createCredential(body: unknown): Promise<{ id: string }>;
  deleteCredential(id: string): Promise<void>;
}

export function makeN8nApiClient(cfg: N8nProvisioningConfig): N8nApiClient {
  const base = cfg.apiBaseUrl.replace(/\/+$/, '');
  const headers = { 'Content-Type': 'application/json', 'X-N8N-API-KEY': cfg.apiKey ?? '' };

  async function call(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`n8n API ${method} ${path} -> ${res.status}`);
    }
    // DELETE / activate pueden devolver cuerpo vacío
    try { return await res.json(); } catch { return undefined; }
  }

  return {
    async listWorkflows() {
      const j = (await call('GET', '/api/v1/workflows?limit=250')) as { data?: N8nWorkflowSummary[] };
      return (j?.data ?? []).map((w) => ({ id: w.id, name: w.name, active: w.active }));
    },
    async createWorkflow(body) {
      const j = (await call('POST', '/api/v1/workflows', body)) as { id: string };
      return { id: j.id };
    },
    async updateWorkflow(id, body) {
      await call('PUT', `/api/v1/workflows/${encodeURIComponent(id)}`, body);
    },
    async activateWorkflow(id) {
      await call('POST', `/api/v1/workflows/${encodeURIComponent(id)}/activate`);
    },
    async createCredential(body) {
      const j = (await call('POST', '/api/v1/credentials', body)) as { id: string };
      return { id: j.id };
    },
    async deleteCredential(id) {
      await call('DELETE', `/api/v1/credentials/${encodeURIComponent(id)}`);
    },
  };
}

/**
 * n8n-provisioning · apiClient — tests (global.fetch mockeado).
 */
import { makeN8nApiClient } from '../apiClient.js';
import type { N8nProvisioningConfig } from '../config.js';

const CFG: N8nProvisioningConfig = {
  apiBaseUrl: 'http://n8n-main:5678',
  apiKey: 'test-key',
  serviceToken: 'tok',
  smtp: null,
  ldap: null,
};

function mockFetchOnce(status: number, body: unknown) {
  (global.fetch as jest.Mock).mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
}

beforeEach(() => { global.fetch = jest.fn(); });
afterEach(() => { jest.restoreAllMocks(); });

describe('N8nApiClient', () => {
  it('listWorkflows: GET /api/v1/workflows con header X-N8N-API-KEY y parsea data[]', async () => {
    mockFetchOnce(200, { data: [{ id: 'w1', name: 'A', active: true }, { id: 'w2', name: 'B', active: false }] });
    const out = await makeN8nApiClient(CFG).listWorkflows();
    expect(out).toEqual([{ id: 'w1', name: 'A', active: true }, { id: 'w2', name: 'B', active: false }]);
    const [url, opts] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toContain('http://n8n-main:5678/api/v1/workflows');
    expect(opts.method).toBe('GET');
    expect(opts.headers['X-N8N-API-KEY']).toBe('test-key');
  });

  it('createWorkflow: POST /api/v1/workflows y devuelve { id }', async () => {
    mockFetchOnce(200, { id: 'new-id', name: 'X' });
    const r = await makeN8nApiClient(CFG).createWorkflow({ name: 'X', nodes: [], connections: {} });
    expect(r).toEqual({ id: 'new-id' });
    const [url, opts] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('http://n8n-main:5678/api/v1/workflows');
    expect(opts.method).toBe('POST');
  });

  it('updateWorkflow: PUT /api/v1/workflows/:id', async () => {
    mockFetchOnce(200, { id: 'w1' });
    await makeN8nApiClient(CFG).updateWorkflow('w1', { name: 'X', nodes: [], connections: {} });
    const [url, opts] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('http://n8n-main:5678/api/v1/workflows/w1');
    expect(opts.method).toBe('PUT');
  });

  it('activateWorkflow: POST /api/v1/workflows/:id/activate', async () => {
    mockFetchOnce(200, { id: 'w1', active: true });
    await makeN8nApiClient(CFG).activateWorkflow('w1');
    const [url, opts] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('http://n8n-main:5678/api/v1/workflows/w1/activate');
    expect(opts.method).toBe('POST');
  });

  it('createCredential: POST /api/v1/credentials y devuelve { id }', async () => {
    mockFetchOnce(200, { id: 'c1', name: 'CMDB SMTP' });
    const r = await makeN8nApiClient(CFG).createCredential({ name: 'CMDB SMTP', type: 'smtp', data: {} });
    expect(r).toEqual({ id: 'c1' });
    const [url, opts] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('http://n8n-main:5678/api/v1/credentials');
    expect(opts.method).toBe('POST');
  });

  it('deleteCredential: DELETE /api/v1/credentials/:id', async () => {
    mockFetchOnce(200, {});
    await makeN8nApiClient(CFG).deleteCredential('c1');
    const [url, opts] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('http://n8n-main:5678/api/v1/credentials/c1');
    expect(opts.method).toBe('DELETE');
  });

  it('lanza Error con el status cuando la respuesta no es ok', async () => {
    mockFetchOnce(401, { message: 'unauthorized' });
    await expect(makeN8nApiClient(CFG).listWorkflows()).rejects.toThrow('401');
  });
});

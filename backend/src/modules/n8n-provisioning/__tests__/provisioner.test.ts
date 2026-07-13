/**
 * n8n-provisioning · provisionAll — tests (orquestador idempotente).
 */
import { provisionAll } from '../provisioner.js';
import type { N8nApiClient } from '../apiClient.js';
import type { N8nProvisioningConfig } from '../config.js';
import { CRED_NAMES } from '../credentials.js';

// Plantillas mockeadas: 2 workflows simples para controlar el comportamiento
jest.mock('../workflows.js', () => ({
  renderWorkflows: jest.fn(() => [
    {
      name: 'Alertas CMDB',
      nodes: [
        {
          name: 'Scan alerts',
          type: 'n8n-nodes-base.httpRequest',
          parameters: { authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth' },
          credentials: { httpHeaderAuth: { id: '', name: 'CMDB Service Token' } },
        },
        {
          name: 'Send Email',
          type: 'n8n-nodes-base.emailSend',
          parameters: { fromEmail: 'alerts@test.com' },
          credentials: { smtp: { id: '', name: 'CMDB SMTP' } },
        },
      ],
      connections: {},
      settings: {},
      activateWhen: 'smtp',
    },
    {
      name: 'RAG Indexing',
      nodes: [
        {
          name: 'Fetch',
          type: 'n8n-nodes-base.httpRequest',
          parameters: { authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth' },
          credentials: { httpHeaderAuth: { id: '', name: 'CMDB Service Token' } },
        },
      ],
      connections: {},
      settings: {},
      activateWhen: 'always',
    },
  ]),
}));

// ── helpers ──────────────────────────────────────────────────────────────────

function makeClient(overrides: Record<string, jest.Mock> = {}): N8nApiClient & Record<string, jest.Mock> {
  return {
    listWorkflows:    jest.fn().mockResolvedValue([]),
    createWorkflow:   jest.fn().mockResolvedValue({ id: 'wf-new' }),
    updateWorkflow:   jest.fn().mockResolvedValue(undefined),
    activateWorkflow: jest.fn().mockResolvedValue(undefined),
    createCredential: jest.fn().mockResolvedValue({ id: 'cred-new' }),
    deleteCredential: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as N8nApiClient & Record<string, jest.Mock>;
}

function makePrisma(existingCreds: { id: string; name: string }[] = []) {
  return { $queryRaw: jest.fn().mockResolvedValue(existingCreds) } as any;
}

function cfg(over: Partial<N8nProvisioningConfig> = {}): N8nProvisioningConfig {
  return {
    apiBaseUrl:   'http://n8n:5678',
    apiKey:       'test-key',
    serviceToken: 'svc-tok',
    smtp: { host: 'smtp.test', port: 25, secure: false, from: 'alerts@test.com' },
    ldap: null,
    vcenter: null,
    ...over,
  };
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('provisionAll', () => {
  it('crea credenciales nuevas cuando no existen en BD', async () => {
    const client = makeClient();
    const report = await provisionAll(client, cfg(), makePrisma([]));

    // headerAuth + smtp (ldap=null → skipped)
    expect(client.createCredential).toHaveBeenCalledTimes(2);
    expect(report.credentials.find((c) => c.name === CRED_NAMES.headerAuth)?.action).toBe('created');
    expect(report.credentials.find((c) => c.name === CRED_NAMES.smtp)?.action).toBe('created');
    expect(report.credentials.find((c) => c.name === CRED_NAMES.ldap)?.action).toBe('skipped');
    expect(report.errors).toHaveLength(0);
  });

  it('recreate (delete+create) cuando la credencial ya existe en BD', async () => {
    const client = makeClient();
    const prisma = makePrisma([{ id: 'old-id', name: CRED_NAMES.headerAuth }]);
    const report = await provisionAll(client, cfg(), prisma);

    expect(client.deleteCredential).toHaveBeenCalledWith('old-id');
    expect(report.credentials.find((c) => c.name === CRED_NAMES.headerAuth)?.action).toBe('recreated');
  });

  it('inyecta el id real de credencial en los nodos del workflow', async () => {
    const client = makeClient({
      createCredential: jest.fn()
        .mockResolvedValueOnce({ id: 'hdr-id' })   // headerAuth
        .mockResolvedValueOnce({ id: 'smtp-id' }), // smtp
    });
    await provisionAll(client, cfg(), makePrisma([]));

    const wfBody = (client.createWorkflow as jest.Mock).mock.calls[0][0] as any;
    const httpNode = wfBody.nodes.find((n: any) => n.credentials?.httpHeaderAuth);
    expect(httpNode.credentials.httpHeaderAuth.id).toBe('hdr-id');
    const emailNode = wfBody.nodes.find((n: any) => n.credentials?.smtp);
    expect(emailNode.credentials.smtp.id).toBe('smtp-id');
  });

  it('actualiza workflow existente en vez de crear uno nuevo', async () => {
    const client = makeClient({
      listWorkflows: jest.fn().mockResolvedValue([
        { id: 'existing-wf', name: 'Alertas CMDB', active: false },
      ]),
    });
    const report = await provisionAll(client, cfg(), makePrisma([]));

    expect(client.updateWorkflow).toHaveBeenCalledWith('existing-wf', expect.any(Object));
    expect(client.createWorkflow).toHaveBeenCalledTimes(1); // solo RAG Indexing
    expect(report.workflows.find((w) => w.name === 'Alertas CMDB')?.action).toBe('updated');
  });

  it('activa Alertas CMDB si smtp configurado y RAG Indexing (always)', async () => {
    const client = makeClient();
    const report = await provisionAll(client, cfg(), makePrisma([]));

    expect(client.activateWorkflow).toHaveBeenCalledTimes(2);
    expect(report.workflows.find((w) => w.name === 'Alertas CMDB')?.active).toBe(true);
    expect(report.workflows.find((w) => w.name === 'RAG Indexing')?.active).toBe(true);
  });

  it('no activa Alertas CMDB si smtp no configurado', async () => {
    const client = makeClient();
    const report = await provisionAll(client, cfg({ smtp: null }), makePrisma([]));

    expect(report.workflows.find((w) => w.name === 'Alertas CMDB')?.active).toBe(false);
    expect(report.workflows.find((w) => w.name === 'RAG Indexing')?.active).toBe(true);
    // solo 1 activate (RAG), no Alertas
    expect(client.activateWorkflow).toHaveBeenCalledTimes(1);
  });

  it('captura errores por item sin abortar el resto', async () => {
    const client = makeClient({
      createCredential: jest.fn()
        .mockRejectedValueOnce(new Error('n8n down')) // headerAuth falla
        .mockResolvedValue({ id: 'ok' }),              // smtp ok
    });
    const report = await provisionAll(client, cfg(), makePrisma([]));

    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toContain(CRED_NAMES.headerAuth);
    // smtp igualmente intentado
    expect(client.createCredential).toHaveBeenCalledTimes(2);
  });

  it('captura errores de workflow sin abortar el resto', async () => {
    const client = makeClient({
      createWorkflow: jest.fn()
        .mockRejectedValueOnce(new Error('workflow fail')) // Alertas falla
        .mockResolvedValue({ id: 'ok' }),                  // RAG ok
    });
    const report = await provisionAll(client, cfg(), makePrisma([]));

    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toContain('Alertas CMDB');
    expect(report.workflows).toHaveLength(1); // solo RAG
  });
});

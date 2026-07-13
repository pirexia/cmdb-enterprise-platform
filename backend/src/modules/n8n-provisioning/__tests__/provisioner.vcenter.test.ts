/**
 * n8n-provisioning · provisionAll — activación de la política 'vcenter' (Task D).
 *
 * Aislado en su propio archivo (mock independiente de workflows.js) para no alterar
 * los recuentos de llamadas que ya verifica provisioner.test.ts.
 */
import { provisionAll } from '../provisioner.js';
import type { N8nApiClient } from '../apiClient.js';
import type { N8nProvisioningConfig } from '../config.js';

jest.mock('../workflows.js', () => ({
  renderWorkflows: jest.fn(() => [
    {
      name: 'vCenter Sync',
      nodes: [
        {
          name: 'Trigger vCenter sync',
          type: 'n8n-nodes-base.httpRequest',
          parameters: { authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth' },
          credentials: { httpHeaderAuth: { id: '', name: 'CMDB Service Token' } },
        },
      ],
      connections: {},
      settings: {},
      activateWhen: 'vcenter',
    },
  ]),
}));

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
    smtp: null,
    ldap: null,
    vcenter: null,
    ...over,
  };
}

describe('provisionAll — política vcenter', () => {
  it('activa "vCenter Sync" cuando cfg.vcenter.enabled === true', async () => {
    const client = makeClient();
    const report = await provisionAll(
      client,
      cfg({ vcenter: { enabled: true, cron: '0 */6 * * *' } }),
      makePrisma([]),
    );

    expect(client.activateWorkflow).toHaveBeenCalledTimes(1);
    expect(report.workflows.find((w) => w.name === 'vCenter Sync')?.active).toBe(true);
  });

  it('no activa "vCenter Sync" cuando cfg.vcenter es null', async () => {
    const client = makeClient();
    const report = await provisionAll(client, cfg({ vcenter: null }), makePrisma([]));

    expect(client.activateWorkflow).not.toHaveBeenCalled();
    expect(report.workflows.find((w) => w.name === 'vCenter Sync')?.active).toBe(false);
  });
});

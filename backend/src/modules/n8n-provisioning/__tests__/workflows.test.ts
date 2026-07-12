/**
 * n8n-provisioning · renderWorkflows — tests.
 */
import { renderWorkflows } from '../workflows.js';
import { CRED_NAMES } from '../credentials.js';
import type { N8nProvisioningConfig } from '../config.js';

function cfg(over: Partial<N8nProvisioningConfig> = {}): N8nProvisioningConfig {
  return {
    apiBaseUrl: 'http://n8n-main:5678', apiKey: 'k', serviceToken: 'tok',
    smtp: { host: 's', port: 25, secure: false, from: 'cmdb-alerts@acme.com' },
    ldap: { useLdap: true, url: 'ldap://dc.acme.com:389', baseDN: 'DC=acme,DC=com',
            groupDN: 'CN=CMDB-Users,DC=acme,DC=com', syncDomain: 'acme.com' },
    vcenter: null,
    ...over,
  };
}

function findWf(wfs: ReturnType<typeof renderWorkflows>, name: string) {
  return wfs.find((w) => w.name === name)!;
}

describe('renderWorkflows', () => {
  it('devuelve las 8 plantillas con nombres estables', () => {
    const names = renderWorkflows(cfg()).map((w) => w.name).sort();
    expect(names).toEqual([
      'Alertas CMDB', 'Backup CMDB', 'Bulk Import CIs', 'LDAP/AD Sync',
      'Mantenimiento CMDB', 'Notificaciones CMDB', 'RAG Indexing', 'vCenter Sync',
    ]);
  });

  it('sustituye ALERT_FROM_EMAIL en el nodo Send Email', () => {
    const alertas = findWf(renderWorkflows(cfg()), 'Alertas CMDB');
    const send = alertas.nodes.find((n: any) => n.type === 'n8n-nodes-base.emailSend') as any;
    expect(send.parameters.fromEmail).toBe('cmdb-alerts@acme.com');
  });

  it('sustituye LDAP_BASE_DN y mete el grupo en el filtro del nodo LDAP', () => {
    const ldap = findWf(renderWorkflows(cfg()), 'LDAP/AD Sync');
    const node = ldap.nodes.find((n: any) => n.type === 'n8n-nodes-base.ldap') as any;
    expect(node.parameters.baseDN).toBe('DC=acme,DC=com');
    expect(node.parameters.filter).toContain('memberOf=CN=CMDB-Users,DC=acme,DC=com');
  });

  it('activateWhen por workflow (smtp / ldap / always / vcenter)', () => {
    const wfs = renderWorkflows(cfg());
    expect(findWf(wfs, 'Alertas CMDB').activateWhen).toBe('smtp');
    expect(findWf(wfs, 'LDAP/AD Sync').activateWhen).toBe('ldap');
    expect(findWf(wfs, 'RAG Indexing').activateWhen).toBe('always');
    expect(findWf(wfs, 'vCenter Sync').activateWhen).toBe('vcenter');
  });

  it('sustituye VCENTER_SYNC_CRON en el nodo Schedule de vCenter Sync', () => {
    const vcenter = findWf(
      renderWorkflows(cfg({ vcenter: { enabled: true, cron: '0 2 * * *' } })),
      'vCenter Sync',
    );
    const schedule = vcenter.nodes.find((n: any) => n.type === 'n8n-nodes-base.scheduleTrigger') as any;
    expect(schedule.parameters.rule.interval[0].expression).toBe('0 2 * * *');
  });

  it('inyecta el binding httpHeaderAuth en el nodo HTTP de vCenter Sync', () => {
    const vcenter = findWf(renderWorkflows(cfg()), 'vCenter Sync');
    const http = vcenter.nodes.find((n: any) => n.name === 'Trigger vCenter sync') as any;
    expect(http.credentials.httpHeaderAuth.name).toBe(CRED_NAMES.headerAuth);
  });

  it('el nodo "Notify sync failure" de vCenter Sync incluye channel:"both" para que IF Teams? / IF Slack? disparen', () => {
    const vcenter = findWf(renderWorkflows(cfg()), 'vCenter Sync');
    const notify = vcenter.nodes.find((n: any) => n.name === 'Notify sync failure') as any;
    expect(notify.parameters.jsonBody).toContain('"channel":"both"');
  });

  it('inyecta el binding httpHeaderAuth (por nombre) en los nodos HTTP', () => {
    const alertas = findWf(renderWorkflows(cfg()), 'Alertas CMDB');
    const http = alertas.nodes.find((n: any) => n.name === 'Scan alerts') as any;
    expect(http.credentials.httpHeaderAuth.name).toBe(CRED_NAMES.headerAuth);
  });

  it('inyecta binding smtp en Send Email y ldap en el nodo LDAP', () => {
    const alertas = findWf(renderWorkflows(cfg()), 'Alertas CMDB');
    const send = alertas.nodes.find((n: any) => n.type === 'n8n-nodes-base.emailSend') as any;
    expect(send.credentials.smtp.name).toBe(CRED_NAMES.smtp);

    const ldap = findWf(renderWorkflows(cfg()), 'LDAP/AD Sync');
    const node = ldap.nodes.find((n: any) => n.type === 'n8n-nodes-base.ldap') as any;
    expect(node.credentials.ldap.name).toBe(CRED_NAMES.ldap);
  });
});

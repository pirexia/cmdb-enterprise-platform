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
    ...over,
  };
}

function findWf(wfs: ReturnType<typeof renderWorkflows>, name: string) {
  return wfs.find((w) => w.name === name)!;
}

describe('renderWorkflows', () => {
  it('devuelve las 7 plantillas con nombres estables', () => {
    const names = renderWorkflows(cfg()).map((w) => w.name).sort();
    expect(names).toEqual([
      'Alertas CMDB', 'Backup CMDB', 'Bulk Import CIs', 'LDAP/AD Sync',
      'Mantenimiento CMDB', 'Notificaciones CMDB', 'RAG Indexing',
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

  it('activateWhen por workflow (smtp / ldap / always)', () => {
    const wfs = renderWorkflows(cfg());
    expect(findWf(wfs, 'Alertas CMDB').activateWhen).toBe('smtp');
    expect(findWf(wfs, 'LDAP/AD Sync').activateWhen).toBe('ldap');
    expect(findWf(wfs, 'RAG Indexing').activateWhen).toBe('always');
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

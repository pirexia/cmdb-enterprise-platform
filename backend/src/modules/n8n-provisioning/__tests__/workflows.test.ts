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
            requiredGroup: 'GS-CMDB-Iberia-Access', syncCron: '0 3 * * *' },
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
      'Alertas CMDB', 'Backup CMDB', 'Bulk Import CIs', 'LDAP Group Sync',
      'Mantenimiento CMDB', 'Notificaciones CMDB', 'RAG Indexing', 'vCenter Sync',
    ]);
  });

  it('sustituye ALERT_FROM_EMAIL en el nodo Send Email', () => {
    const alertas = findWf(renderWorkflows(cfg()), 'Alertas CMDB');
    const send = alertas.nodes.find((n: any) => n.type === 'n8n-nodes-base.emailSend') as any;
    expect(send.parameters.fromEmail).toBe('cmdb-alerts@acme.com');
  });

  // v3.5.10 — El workflow ya no consulta el directorio: solo dispara el
  // endpoint interno, que es quien posee la regla completa (D8).
  it('dispara el endpoint interno de sincronización, sin nodo LDAP', () => {
    const ldap = findWf(renderWorkflows(cfg()), 'LDAP Group Sync');
    expect(ldap.nodes.find((n: any) => n.type === 'n8n-nodes-base.ldap')).toBeUndefined();
    const http = ldap.nodes.find((n: any) => n.name === 'Trigger LDAP sync') as any;
    expect(http.parameters.url).toBe('http://backend:3000/api/internal/ldap/sync');
    expect(http.parameters.method).toBe('POST');
  });

  it('sustituye LDAP_SYNC_CRON en el disparador programado', () => {
    const ldap = findWf(renderWorkflows(cfg()), 'LDAP Group Sync');
    const trigger = ldap.nodes.find((n: any) => n.type === 'n8n-nodes-base.scheduleTrigger') as any;
    expect(trigger.parameters.rule.interval[0].expression).toBe('0 3 * * *');
  });

  it('activateWhen por workflow (smtp / ldap / always / vcenter)', () => {
    const wfs = renderWorkflows(cfg());
    expect(findWf(wfs, 'Alertas CMDB').activateWhen).toBe('smtp');
    expect(findWf(wfs, 'LDAP Group Sync').activateWhen).toBe('ldap');
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

  it('inyecta binding smtp en Send Email', () => {
    const alertas = findWf(renderWorkflows(cfg()), 'Alertas CMDB');
    const send = alertas.nodes.find((n: any) => n.type === 'n8n-nodes-base.emailSend') as any;
    expect(send.credentials.smtp.name).toBe(CRED_NAMES.smtp);
  });

  // v3.5.10 — Ninguna plantilla usa ya el nodo LDAP: el backend consulta el
  // directorio. La credencial LDAP se sigue aprovisionando (queda disponible
  // para workflows que el administrador cree a mano), pero el binding
  // automático ya no tiene destino en las plantillas que enviamos.
  it('ninguna plantilla contiene un nodo LDAP', () => {
    const withLdapNode = renderWorkflows(cfg())
      .filter((w) => w.nodes.some((n: any) => n.type === 'n8n-nodes-base.ldap'));
    expect(withLdapNode).toEqual([]);
  });
});

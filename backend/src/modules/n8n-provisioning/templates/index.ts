/**
 * Índice de plantillas de workflow n8n (auto-generadas desde docs/n8n/json/).
 * Se importan como módulos TS para que compilen a `dist` sin IO de ficheros ni
 * pasos de copia en el Dockerfile.
 */
import alertas        from './alertas-cmdb.js';
import backup         from './backup-cmdb.js';
import bulk           from './bulk-import-cis.js';
import ldap           from './ldap-group-sync.js';
import mantenimiento  from './mantenimiento-cmdb.js';
import notificaciones from './notificaciones-cmdb.js';
import rag            from './rag-indexing.js';
import vcenterSync    from './vcenter-sync.js';

export interface WorkflowTemplate {
  name: string;
  nodes: Record<string, unknown>[];
  connections: Record<string, unknown>;
  settings: Record<string, unknown>;
}

export const TEMPLATES: WorkflowTemplate[] = [
  alertas, backup, bulk, ldap, mantenimiento, notificaciones, rag, vcenterSync,
] as unknown as WorkflowTemplate[];

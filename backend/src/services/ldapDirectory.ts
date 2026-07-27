/**
 * Consultas al directorio LDAP / Active Directory con la cuenta de servicio
 * (v3.5.10).
 *
 * Frontera de responsabilidades, deliberada: `services/ldap.ts` prueba
 * credenciales (bind de usuario); este servicio lee metadatos del directorio
 * (grupos, miembros). No se mezclan — uno responde "¿es quien dice ser?", el
 * otro "¿tiene derecho a entrar?".
 *
 * Variables de entorno:
 *   LDAP_REQUIRED_GROUP    - CN o DN del grupo de acceso. Vacío ⇒ puerta
 *                            desactivada y login LDAP como antes de v3.5.10 (D6)
 *   LDAP_GROUP_NESTED      - 'false' ⇒ memberOf directo; por defecto se resuelve
 *                            la pertenencia anidada vía LDAP_MATCHING_RULE_IN_CHAIN (D4)
 *   LDAP_GROUP_SEARCH_BASE - base DN donde buscar el objeto de grupo;
 *                            por defecto cae a LDAP_SEARCH_BASE
 *   LDAP_SYNC_MAX_MEMBERS  - tope duro de miembros por pasada (default 5000)
 *
 * Reutiliza LDAP_URL, LDAP_BIND_DN, LDAP_BIND_PASSWORD, LDAP_SEARCH_BASE y
 * LDAP_TLS_REJECT_UNAUTHORIZED, ya existentes.
 */
import { Client } from 'ldapts';

const LDAP_TIMEOUT_MS = 5_000;
const PAGE_SIZE = 500;
const GROUP_DN_TTL_MS = 5 * 60_000;

/** Bit ACCOUNTDISABLE de userAccountControl en AD. */
export const ACCOUNT_DISABLE_BIT = 0x2;

export type LdapDirectoryErrorCode = 'NOT_CONFIGURED' | 'NO_BIND_DN' | 'UNAVAILABLE';

export class LdapDirectoryError extends Error {
  constructor(public readonly code: LdapDirectoryErrorCode, message: string) {
    super(message);
    this.name = 'LdapDirectoryError';
  }
}

export interface AdGroupMember {
  sAMAccountName: string;
  mail?: string;
  displayName?: string;
  userAccountControl?: number;
}

const env = {
  url:            () => process.env.LDAP_URL ?? 'ldap://localhost:389',
  bindDn:         () => process.env.LDAP_BIND_DN ?? '',
  bindPassword:   () => process.env.LDAP_BIND_PASSWORD ?? '',
  searchBase:     () => process.env.LDAP_SEARCH_BASE ?? process.env.LDAP_BASE_DN ?? '',
  groupBase:      () => process.env.LDAP_GROUP_SEARCH_BASE || process.env.LDAP_SEARCH_BASE || process.env.LDAP_BASE_DN || '',
  requiredGroup:  () => (process.env.LDAP_REQUIRED_GROUP ?? '').trim(),
  nested:         () => process.env.LDAP_GROUP_NESTED !== 'false',
  maxMembers:     () => {
    const n = parseInt(process.env.LDAP_SYNC_MAX_MEMBERS ?? '5000', 10);
    return Number.isFinite(n) && n > 0 ? n : 5000;
  },
  rejectUnauthorized: () => process.env.LDAP_TLS_REJECT_UNAUTHORIZED !== '0',
};

/**
 * Escapado RFC 4515 para filtros de búsqueda. La barra invertida va PRIMERO:
 * escaparla después convertiría las secuencias ya escapadas en literales.
 */
function escapeFilter(value: string): string {
  return value
    .replace(/\\/g, '\\5c')
    .replace(/\*/g, '\\2a')
    .replace(/\(/g, '\\28')
    .replace(/\)/g, '\\29')
    .replace(/\0/g, '\\00')
    .replace(/\//g, '\\2f');
}

/** ¿Está activa la puerta de grupo? Vacío = desactivada (D6). */
export function isGroupGateEnabled(): boolean {
  return env.requiredGroup().length > 0;
}

/**
 * Cláusula de pertenencia. Anidada usa LDAP_MATCHING_RULE_IN_CHAIN, que en AD
 * recorre también los grupos contenidos en el grupo.
 */
export function buildMemberOfClause(groupDn: string, nested: boolean): string {
  return nested
    ? `(memberOf:1.2.840.113556.1.4.1941:=${groupDn})`
    : `(memberOf=${groupDn})`;
}

/** Filtro de pertenencia de UN usuario. Exportado para poder probarlo sin directorio. */
export function buildMembershipFilter(sam: string, groupDn: string, nested: boolean): string {
  return `(&(objectClass=user)(sAMAccountName=${escapeFilter(sam)})${buildMemberOfClause(groupDn, nested)})`;
}

/**
 * Opciones del `Client` de ldapts. `ldapts` (y por debajo `ldap-authentication`,
 * que usa la misma librería) solo acepta `tlsOptions` en el constructor para
 * `ldaps://`. Pasarlo también en `ldap://` hace que este AD corte la conexión
 * (ECONNRESET) — confirmado aislando el fallo contra un AD real: el bind
 * funciona sin `tlsOptions` y falla en cuanto se incluye, incluso con valores
 * no-op (`rejectUnauthorized: true`). Mismo criterio que `services/ldap.ts`
 * (función `_ldapBind` en `ldap-authentication/index.js`).
 */
export function buildClientOptions(url: string, rejectUnauthorized: boolean) {
  const isLdaps = url.startsWith('ldaps://');
  return {
    url,
    timeout: LDAP_TIMEOUT_MS,
    connectTimeout: LDAP_TIMEOUT_MS,
    ...(isLdaps ? { tlsOptions: { rejectUnauthorized } } : {}),
  };
}

async function withClient<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const bindDn = env.bindDn();
  if (!bindDn) {
    // Sin cuenta de servicio no hay forma de consultar el directorio. Se
    // distingue de una caída porque la acción correctiva es distinta.
    throw new LdapDirectoryError(
      'NO_BIND_DN',
      'LDAP_REQUIRED_GROUP está configurado pero falta LDAP_BIND_DN: no se puede verificar la pertenencia al grupo',
    );
  }

  const client = new Client(buildClientOptions(env.url(), env.rejectUnauthorized()));

  try {
    await client.bind(bindDn, env.bindPassword());
    return await fn(client);
  } catch (err) {
    if (err instanceof LdapDirectoryError) throw err;
    const detail = err instanceof Error ? err.message : String(err);
    // El detalle del directorio se queda aquí: nunca llega al cliente HTTP (A09).
    throw new LdapDirectoryError('UNAVAILABLE', `Consulta al directorio fallida: ${detail}`);
  } finally {
    await client.unbind().catch(() => { /* cierre best-effort */ });
  }
}

let groupDnCache: { key: string; dn: string; at: number } | null = null;

/** Solo para tests: limpia la caché del DN del grupo. */
export function __resetGroupDnCache(): void { groupDnCache = null; }

/**
 * Resuelve el DN del grupo. Acepta un CN corto ("GS-CMDB-Iberia-Access") o un
 * DN completo. Cachea 5 min: se consulta en cada login y el DN de un grupo no
 * cambia en caliente.
 *
 * Una coincidencia ambigua es un error, no una elección: elegir "el primero"
 * podría conceder acceso mediante un grupo homónimo de otra OU.
 */
export async function resolveGroupDn(group: string): Promise<string> {
  const raw = group.trim();
  if (!raw) throw new LdapDirectoryError('NOT_CONFIGURED', 'LDAP_REQUIRED_GROUP no está configurado');
  if (raw.includes('=')) return raw; // ya es un DN

  if (groupDnCache && groupDnCache.key === raw && Date.now() - groupDnCache.at < GROUP_DN_TTL_MS) {
    return groupDnCache.dn;
  }

  const dn = await withClient(async (c) => {
    const { searchEntries } = await c.search(env.groupBase(), {
      scope: 'sub',
      filter: `(&(objectClass=group)(cn=${escapeFilter(raw)}))`,
      attributes: ['dn'],
      sizeLimit: 2,
    });
    if (searchEntries.length === 0) {
      throw new LdapDirectoryError('NOT_CONFIGURED', `Grupo "${raw}" no encontrado en el directorio`);
    }
    if (searchEntries.length > 1) {
      throw new LdapDirectoryError('NOT_CONFIGURED', `Grupo "${raw}" ambiguo: ${searchEntries.length} coincidencias`);
    }
    return String(searchEntries[0].dn);
  });

  groupDnCache = { key: raw, dn, at: Date.now() };
  return dn;
}

/**
 * ¿Pertenece el usuario al grupo requerido?
 *
 * Lanza LdapDirectoryError si la pregunta no se puede responder. El llamante
 * DEBE tratar esa excepción como denegación (ver decideGroupGate): devolver
 * `false` en lugar de lanzar sería indistinguible de "no pertenece" y borraría
 * la diferencia entre una política aplicada y una política no comprobada.
 */
export async function isUserInRequiredGroup(sAMAccountName: string): Promise<boolean> {
  const groupDn = await resolveGroupDn(env.requiredGroup());
  return withClient(async (c) => {
    const { searchEntries } = await c.search(env.searchBase(), {
      scope: 'sub',
      filter: buildMembershipFilter(sAMAccountName, groupDn, env.nested()),
      attributes: ['sAMAccountName'],
      sizeLimit: 1,
    });
    return searchEntries.length > 0;
  });
}

/** ldapts devuelve string, string[] o Buffer según el atributo. */
function first(v: unknown): string | undefined {
  if (Array.isArray(v)) {
    const head = v[0];
    if (typeof head === 'string') return head;
    return Buffer.isBuffer(head) ? head.toString('utf8') : undefined;
  }
  if (Buffer.isBuffer(v)) return v.toString('utf8');
  return typeof v === 'string' ? v : undefined;
}

/**
 * Lista los miembros del grupo requerido, paginando. El tope duro evita que un
 * grupo mal configurado (p.ej. anidando el dominio entero) consuma memoria sin
 * límite — NIS2, disponibilidad.
 */
export async function listGroupMembers(): Promise<AdGroupMember[]> {
  const groupDn = await resolveGroupDn(env.requiredGroup());
  const max = env.maxMembers();

  return withClient(async (c) => {
    const { searchEntries } = await c.search(env.searchBase(), {
      scope: 'sub',
      filter: `(&(objectClass=user)(!(objectClass=computer))${buildMemberOfClause(groupDn, env.nested())})`,
      attributes: ['sAMAccountName', 'mail', 'displayName', 'userAccountControl'],
      paged: { pageSize: PAGE_SIZE },
      sizeLimit: max,
    });

    const out: AdGroupMember[] = [];
    for (const e of searchEntries) {
      const sam = first(e.sAMAccountName);
      // Sin sAMAccountName no hay identidad estable con la que keyar la fila
      // local: se descarta en lugar de inventar una.
      if (!sam) continue;

      const uac = first(e.userAccountControl);
      const parsed = uac !== undefined ? parseInt(uac, 10) : NaN;

      out.push({
        sAMAccountName: sam,
        mail: first(e.mail),
        displayName: first(e.displayName),
        userAccountControl: Number.isFinite(parsed) ? parsed : undefined,
      });

      if (out.length >= max) break;
    }
    return out;
  });
}

export type GroupGateDecision = 'ALLOW' | 'DENY_AND_DEACTIVATE' | 'DENY_UNAVAILABLE';

/**
 * Decisión pura de la puerta de grupo, aislada del handler de login para poder
 * probarla (index.ts no es importable en tests: llama a app.listen() de forma
 * incondicional).
 *
 * Invariante: un error de verificación NUNCA produce ALLOW. El orden de las
 * comprobaciones importa — `error` se mira antes que `member` precisamente para
 * que un `member` residual no pueda colarse (D7).
 */
export function decideGroupGate(input: {
  enabled: boolean;
  member: boolean | null;
  error: LdapDirectoryErrorCode | null;
}): GroupGateDecision {
  if (!input.enabled) return 'ALLOW';
  if (input.error) return 'DENY_UNAVAILABLE';
  return input.member === true ? 'ALLOW' : 'DENY_AND_DEACTIVATE';
}

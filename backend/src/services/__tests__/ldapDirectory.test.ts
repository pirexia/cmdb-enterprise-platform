import {
  buildMembershipFilter,
  buildMemberOfClause,
  buildClientOptions,
  isGroupGateEnabled,
  decideGroupGate,
  resolveSearchBase,
  LdapDirectoryError,
} from '../ldapDirectory';

const DN = 'CN=GS-CMDB-Iberia-Access,OU=Groups,DC=corp,DC=local';

describe('buildMemberOfClause', () => {
  it('usa la regla en cadena de AD cuando nested=true', () => {
    expect(buildMemberOfClause(DN, true)).toBe(`(memberOf:1.2.840.113556.1.4.1941:=${DN})`);
  });

  it('usa memberOf directo cuando nested=false', () => {
    expect(buildMemberOfClause(DN, false)).toBe(`(memberOf=${DN})`);
  });
});

describe('buildMembershipFilter', () => {
  it('combina objectClass, sAMAccountName y la pertenencia anidada', () => {
    expect(buildMembershipFilter('andres.matias', DN, true)).toBe(
      `(&(objectClass=user)(sAMAccountName=andres.matias)(memberOf:1.2.840.113556.1.4.1941:=${DN}))`,
    );
  });

  it('usa memberOf directo cuando nested=false', () => {
    expect(buildMembershipFilter('andres.matias', DN, false)).toBe(
      `(&(objectClass=user)(sAMAccountName=andres.matias)(memberOf=${DN}))`,
    );
  });

  // A03 — sin escapado, un sAMAccountName malicioso podría cerrar el filtro y
  // añadir cláusulas propias, convirtiendo la comprobación en un siempre-cierto.
  it('escapa los metacaracteres del sAMAccountName', () => {
    const f = buildMembershipFilter('a*)(objectClass=*', DN, true);
    expect(f).toContain('\\2a'); // *
    expect(f).toContain('\\29'); // )
    expect(f).toContain('\\28'); // (
    // El filtro no debe contener un paréntesis de cierre seguido de apertura
    // procedente de la entrada del usuario.
    expect(f).not.toContain('*)(objectClass=*');
  });

  it('escapa la barra invertida antes que el resto', () => {
    expect(buildMembershipFilter('dom\\user', DN, true)).toContain('\\5c');
  });
});

describe('isGroupGateEnabled', () => {
  const original = process.env.LDAP_REQUIRED_GROUP;
  afterEach(() => {
    if (original === undefined) delete process.env.LDAP_REQUIRED_GROUP;
    else process.env.LDAP_REQUIRED_GROUP = original;
  });

  it('falso cuando la variable no está definida', () => {
    delete process.env.LDAP_REQUIRED_GROUP;
    expect(isGroupGateEnabled()).toBe(false);
  });

  it('falso cuando la variable está vacía o en blanco', () => {
    process.env.LDAP_REQUIRED_GROUP = '';
    expect(isGroupGateEnabled()).toBe(false);
    process.env.LDAP_REQUIRED_GROUP = '   ';
    expect(isGroupGateEnabled()).toBe(false);
  });

  it('cierto cuando hay un grupo configurado', () => {
    process.env.LDAP_REQUIRED_GROUP = 'GS-CMDB-Iberia-Access';
    expect(isGroupGateEnabled()).toBe(true);
  });
});

describe('resolveSearchBase', () => {
  it('usa LDAP_SEARCH_BASE cuando trae valor', () => {
    expect(resolveSearchBase('OU=Users,DC=corp,DC=local', 'DC=corp,DC=local')).toBe(
      'OU=Users,DC=corp,DC=local',
    );
  });

  it('cae a LDAP_BASE_DN cuando no está definida', () => {
    expect(resolveSearchBase(undefined, 'DC=corp,DC=local')).toBe('DC=corp,DC=local');
  });

  // Regresión: con `??` en lugar de `||`, una variable declarada y vacía en el
  // compose se propagaba como base de búsqueda vacía. Efecto: la puerta de
  // grupo deniega TODOS los logins LDAP y la sincronización desactiva a la
  // plantilla entera.
  it('cae a LDAP_BASE_DN cuando está declarada pero vacía', () => {
    expect(resolveSearchBase('', 'DC=corp,DC=local')).toBe('DC=corp,DC=local');
  });

  it('nunca devuelve undefined si no hay ninguna de las dos', () => {
    expect(resolveSearchBase(undefined, undefined)).toBe('');
  });
});

describe('decideGroupGate', () => {
  it('permite cuando la puerta está desactivada', () => {
    expect(decideGroupGate({ enabled: false, member: null, error: null })).toBe('ALLOW');
  });

  it('permite cuando el usuario pertenece al grupo', () => {
    expect(decideGroupGate({ enabled: true, member: true, error: null })).toBe('ALLOW');
  });

  it('deniega y desactiva cuando el usuario no pertenece', () => {
    expect(decideGroupGate({ enabled: true, member: false, error: null })).toBe('DENY_AND_DEACTIVATE');
  });

  // D7 — si la política no se puede comprobar, no se entra. Este es el
  // invariante que impide que una caída del directorio la vuelva opcional.
  it('deniega sin tocar la fila cuando no se puede verificar', () => {
    expect(decideGroupGate({ enabled: true, member: null, error: 'UNAVAILABLE' })).toBe('DENY_UNAVAILABLE');
    expect(decideGroupGate({ enabled: true, member: null, error: 'NO_BIND_DN' })).toBe('DENY_UNAVAILABLE');
    expect(decideGroupGate({ enabled: true, member: null, error: 'NOT_CONFIGURED' })).toBe('DENY_UNAVAILABLE');
  });

  it('un error nunca produce ALLOW, ni siquiera si member viniera a true', () => {
    expect(decideGroupGate({ enabled: true, member: true, error: 'UNAVAILABLE' })).toBe('DENY_UNAVAILABLE');
  });
});

describe('buildClientOptions', () => {
  // Regresión encontrada en la verificación en vivo contra un AD real:
  // pasar tlsOptions al Client de ldapts sobre ldap:// (no ldaps://) provoca
  // ECONNRESET al bind, incluso con valores no-op. ldap-authentication ya
  // evita esto para el bind de usuario; este servicio debe hacer lo mismo
  // para la cuenta de servicio.
  it('NO incluye tlsOptions para ldap:// (texto plano)', () => {
    const opts = buildClientOptions('ldap://dc.corp.local:389', true);
    expect(opts).not.toHaveProperty('tlsOptions');
    expect(opts.url).toBe('ldap://dc.corp.local:389');
  });

  it('SÍ incluye tlsOptions para ldaps://', () => {
    const opts = buildClientOptions('ldaps://dc.corp.local:636', false);
    expect(opts).toHaveProperty('tlsOptions', { rejectUnauthorized: false });
  });

  it('siempre incluye timeout y connectTimeout', () => {
    const opts = buildClientOptions('ldap://dc.corp.local:389', true);
    expect(opts.timeout).toBeGreaterThan(0);
    expect(opts.connectTimeout).toBeGreaterThan(0);
  });
});

describe('LdapDirectoryError', () => {
  it('lleva un código legible por el llamante', () => {
    const e = new LdapDirectoryError('UNAVAILABLE', 'directorio caído');
    expect(e.code).toBe('UNAVAILABLE');
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('LdapDirectoryError');
  });
});

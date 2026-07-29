import { externalInitials, maskIdentityForViewer } from '../service';

describe('externalInitials (v3.5.13)', () => {
  it('toma la inicial de cada palabra del displayName', () => {
    expect(externalInitials('Jorge Espinosa Male', 'jorge.espinosam')).toBe('JEM');
  });

  it('se queda en tres iniciales aunque el nombre tenga mas palabras', () => {
    expect(externalInitials('Maria del Carmen Lopez Ruiz', 'maria.lopez')).toBe('MDC');
  });

  it('ignora espacios sobrantes', () => {
    expect(externalInitials('  Ana   Gil  ', 'ana.gil')).toBe('AG');
  });

  it('cae al username cuando no hay displayName, sin exponerlo entero', () => {
    // Sin nombre real no hay iniciales que dar; se usa la inicial del username
    // para no devolver una cadena vacia que rompa la etiqueta.
    expect(externalInitials(null, 'jorge.espinosam')).toBe('J');
  });
});

describe('maskIdentityForViewer (v3.5.13, D3)', () => {
  const ext = { username: 'jorge.espinosam', displayName: 'Jorge Espinosa Male', isExternal: true };
  const internal = { username: 'ana.gil', displayName: 'Ana Gil', isExternal: false };

  it('un VIEWER nunca recibe el nombre real de un externo', () => {
    const masked = maskIdentityForViewer(ext, { id: 'v1', role: 'VIEWER' });
    expect(masked.displayName).toBe('Externo (JEM)');
    expect(masked.username).toBe('Externo (JEM)');
    expect(JSON.stringify(masked)).not.toContain('Jorge');
    expect(JSON.stringify(masked)).not.toContain('espinosam');
  });

  it('un ADMIN ve el nombre real', () => {
    expect(maskIdentityForViewer(ext, { id: 'a1', role: 'ADMIN' }).displayName).toBe('Jorge Espinosa Male');
  });

  it('un MANAGER ve el nombre real (planifica el departamento)', () => {
    expect(maskIdentityForViewer(ext, { id: 'm1', role: 'MANAGER' }).displayName).toBe('Jorge Espinosa Male');
  });

  it('un AUDITOR no ve el nombre real', () => {
    expect(maskIdentityForViewer(ext, { id: 'aud1', role: 'AUDITOR' }).displayName).toBe('Externo (JEM)');
  });

  it('un trabajador interno no se enmascara para nadie', () => {
    expect(maskIdentityForViewer(internal, { id: 'v1', role: 'VIEWER' }).displayName).toBe('Ana Gil');
  });

  it('un externo se ve a si mismo con su nombre', () => {
    const self = maskIdentityForViewer({ ...ext }, { id: 'self', role: 'VIEWER' }, 'self');
    expect(self.displayName).toBe('Jorge Espinosa Male');
  });

  it('un rol desconocido se enmascara (fail-closed)', () => {
    expect(maskIdentityForViewer(ext, { id: 'x', role: 'ROBOT' }).displayName).toBe('Externo (JEM)');
  });
});

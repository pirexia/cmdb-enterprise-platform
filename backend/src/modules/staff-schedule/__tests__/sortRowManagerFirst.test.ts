import { sortRowManagerFirst } from '../service';

// v3.5.10 refinamiento — el responsable del departamento aparece primero en
// el calendario; el resto se ordena alfabéticamente por nombre para mostrar.

const row = (userId: string, displayName: string | null, username: string) => ({ userId, displayName, username });

describe('sortRowManagerFirst', () => {
  it('el manager va antes que un no-manager', () => {
    const managers = new Set(['u2']);
    const rows = [row('u1', 'Zulema', 'zulema'), row('u2', 'Ana', 'ana')];
    rows.sort((a, b) => sortRowManagerFirst(a, b, managers));
    expect(rows.map((r) => r.userId)).toEqual(['u2', 'u1']);
  });

  it('sin managers, ordena alfabéticamente por displayName', () => {
    const managers = new Set<string>();
    const rows = [row('u1', 'Zulema', 'zulema'), row('u2', 'Ana', 'ana'), row('u3', 'Miguel', 'miguel')];
    rows.sort((a, b) => sortRowManagerFirst(a, b, managers));
    expect(rows.map((r) => r.userId)).toEqual(['u2', 'u3', 'u1']);
  });

  it('varios managers: entre ellos también se ordena alfabéticamente', () => {
    const managers = new Set(['u1', 'u2']);
    const rows = [row('u1', 'Zulema', 'zulema'), row('u2', 'Ana', 'ana'), row('u3', 'Bruno', 'bruno')];
    rows.sort((a, b) => sortRowManagerFirst(a, b, managers));
    expect(rows.map((r) => r.userId)).toEqual(['u2', 'u1', 'u3']);
  });

  it('sin displayName, cae al username', () => {
    const managers = new Set<string>();
    const rows = [row('u1', null, 'zzz'), row('u2', null, 'aaa')];
    rows.sort((a, b) => sortRowManagerFirst(a, b, managers));
    expect(rows.map((r) => r.userId)).toEqual(['u2', 'u1']);
  });
});

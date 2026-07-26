import { buildScheduleVisibilityFilter } from '../queries';

// v3.5.10 — La visibilidad de horarios se decide en la cláusula WHERE de
// Prisma, nunca por post-filtrado en memoria (A01). Estos tests fijan la
// tabla de verdad de esa decisión.
describe('buildScheduleVisibilityFilter', () => {
  it('ADMIN ve todo: filtro vacío', () => {
    expect(buildScheduleVisibilityFilter('ADMIN', [])).toEqual({});
  });

  it('ADMIN ve todo aunque gestione departamentos concretos', () => {
    expect(buildScheduleVisibilityFilter('ADMIN', ['d1'])).toEqual({});
  });

  it('VIEWER solo ve publicados', () => {
    expect(buildScheduleVisibilityFilter('VIEWER', [])).toEqual({ status: 'PUBLISHED' });
  });

  it('AUDITOR solo ve publicados', () => {
    expect(buildScheduleVisibilityFilter('AUDITOR', [])).toEqual({ status: 'PUBLISHED' });
  });

  it('VIEWER sigue viendo solo publicados aunque se le pasen departamentos', () => {
    expect(buildScheduleVisibilityFilter('VIEWER', ['d1', 'd2'])).toEqual({ status: 'PUBLISHED' });
  });

  it('MANAGER sin departamentos gestionados solo ve publicados', () => {
    expect(buildScheduleVisibilityFilter('MANAGER', [])).toEqual({ status: 'PUBLISHED' });
  });

  it('MANAGER ve publicados o cualquier estado de sus departamentos', () => {
    expect(buildScheduleVisibilityFilter('MANAGER', ['d1', 'd2'])).toEqual({
      OR: [{ status: 'PUBLISHED' }, { departmentId: { in: ['d1', 'd2'] } }],
    });
  });

  it('un rol desconocido cae al filtro más restrictivo (fail-closed)', () => {
    expect(buildScheduleVisibilityFilter('UNKNOWN' as never, ['d1'])).toEqual({ status: 'PUBLISHED' });
  });

  it('nunca devuelve filtro vacío para un no-ADMIN', () => {
    for (const role of ['VIEWER', 'AUDITOR', 'MANAGER', '']) {
      expect(buildScheduleVisibilityFilter(role, ['d1'])).not.toEqual({});
    }
  });
});

import express from 'express';
import request from 'supertest';
import { createStaffScheduleRouter } from '../router';

// v3.5.10 refinamiento — GET /departments/:id/managers y GET /departments/:id/members.
// Antes no existía ningún GET para ninguna de las dos cosas: el panel de
// configuración solo podía añadir/quitar managers a ciegas, sin ver quién
// gestionaba el departamento ni quién pertenecía a él.

const DEPT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

function makeMockPrisma() {
  return {
    departmentManager: {
      findMany: async ({ where }: { where: { departmentId: string } }) => {
        if (where.departmentId !== DEPT_ID) return [];
        return [
          { user: { id: 'u1', username: 'andres.matias', displayName: 'Andrés Matías López', email: 'a@corp.local' } },
        ];
      },
    },
    user: {
      findMany: async ({ where }: { where: { departmentId: string; active: boolean } }) => {
        if (where.departmentId !== DEPT_ID || !where.active) return [];
        return [
          { id: 'u1', username: 'andres.matias', displayName: 'Andrés Matías López', email: 'a@corp.local', weeklyTargetHours: null },
          { id: 'u2', username: 'roberto.cerezo', displayName: 'Roberto Cerezo Ruiz', email: 'r@corp.local', weeklyTargetHours: 37.5 },
        ];
      },
    },
  };
}

function buildApp(prisma: unknown) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user: { id: string; role: string; email: string } }).user =
      { id: 'admin-1', role: 'ADMIN', email: 'admin@cmdb.local' };
    next();
  });
  app.use('/api/staff-schedule', createStaffScheduleRouter(prisma as never));
  return app;
}

describe('GET /departments/:id/managers', () => {
  it('devuelve los managers del departamento', async () => {
    const app = buildApp(makeMockPrisma());
    const res = await request(app).get(`/api/staff-schedule/departments/${DEPT_ID}/managers`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { id: 'u1', username: 'andres.matias', displayName: 'Andrés Matías López', email: 'a@corp.local' },
    ]);
  });

  it('devuelve un array vacío si el departamento no tiene managers', async () => {
    const app = buildApp(makeMockPrisma());
    const res = await request(app).get('/api/staff-schedule/departments/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/managers');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('rechaza un id que no es UUID', async () => {
    const app = buildApp(makeMockPrisma());
    const res = await request(app).get('/api/staff-schedule/departments/not-a-uuid/managers');
    expect(res.status).toBe(400);
  });
});

describe('GET /departments/:id/members', () => {
  it('devuelve los miembros activos con su override de horas', async () => {
    const app = buildApp(makeMockPrisma());
    const res = await request(app).get(`/api/staff-schedule/departments/${DEPT_ID}/members`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[1]).toEqual({
      id: 'u2', username: 'roberto.cerezo', displayName: 'Roberto Cerezo Ruiz', email: 'r@corp.local', weeklyTargetHours: 37.5,
    });
  });
});

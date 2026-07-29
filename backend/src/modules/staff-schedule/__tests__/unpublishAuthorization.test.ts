import express from 'express';
import request from 'supertest';
import { createStaffScheduleRouter } from '../router';

// v3.5.13 (D2) — unpublish era ADMIN-only y dejaba al responsable de un
// departamento sin salida: podía publicar pero no revertir, y la edición
// exige DRAFT (PUT /:id). Pasa al mismo control de fila que ya usa /publish
// (requireDeptEditAccess), acotado a los departamentos que el MANAGER
// gestiona — un MANAGER de OTRO departamento, o cualquier rol de solo
// lectura, sigue sin poder despublicar nada.

const DEPT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OTHER_DEPT_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const SCHEDULE_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const MANAGER_ID = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const OTHER_MANAGER_ID = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

function makeMockPrisma() {
  const prisma = {
    departmentManager: {
      findFirst: async ({ where }: { where: { departmentId: string; userId: string } }) => {
        if (where.departmentId === DEPT_ID && where.userId === MANAGER_ID) return { id: 'mgr-row' };
        return null;
      },
    },
    staffSchedule: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        if (where.id !== SCHEDULE_ID) return null;
        return { id: SCHEDULE_ID, departmentId: DEPT_ID, status: 'PUBLISHED' };
      },
      update: async ({ where, data }: { where: { id: string }; data: { status: string } }) => ({
        id: where.id, departmentId: DEPT_ID, status: data.status,
      }),
    },
    $executeRaw: async () => undefined,
    $transaction: async (fn: (tx: unknown) => unknown) => fn(prisma),
  };
  return prisma;
}

function buildApp(prisma: unknown, viewer: { id: string; role: string }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user: { id: string; role: string; email: string } }).user =
      { ...viewer, email: `${viewer.id}@corp.local` };
    next();
  });
  app.use('/api/staff-schedule', createStaffScheduleRouter(prisma as never));
  return app;
}

describe('POST /:id/unpublish authorization (v3.5.13 — D2)', () => {
  it('un MANAGER responsable del departamento puede despublicar', async () => {
    const app = buildApp(makeMockPrisma(), { id: MANAGER_ID, role: 'MANAGER' });
    const res = await request(app).post(`/api/staff-schedule/${SCHEDULE_ID}/unpublish`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('DRAFT');
  });

  it('un MANAGER que NO gestiona ese departamento recibe 403', async () => {
    const app = buildApp(makeMockPrisma(), { id: OTHER_MANAGER_ID, role: 'MANAGER' });
    const res = await request(app).post(`/api/staff-schedule/${SCHEDULE_ID}/unpublish`);
    expect(res.status).toBe(403);
  });

  it('un MANAGER de otro departamento (con OTHER_DEPT_ID como propio) sigue en 403 sobre este horario', async () => {
    const prisma = makeMockPrisma();
    // OTHER_MANAGER_ID gestiona OTHER_DEPT_ID, no DEPT_ID (donde vive el horario).
    prisma.departmentManager.findFirst = async ({ where }) => {
      if (where.departmentId === OTHER_DEPT_ID && where.userId === OTHER_MANAGER_ID) return { id: 'mgr-row-2' };
      return null;
    };
    const app = buildApp(prisma, { id: OTHER_MANAGER_ID, role: 'MANAGER' });
    const res = await request(app).post(`/api/staff-schedule/${SCHEDULE_ID}/unpublish`);
    expect(res.status).toBe(403);
  });

  it('un AUDITOR nunca puede despublicar', async () => {
    const app = buildApp(makeMockPrisma(), { id: 'aud-1', role: 'AUDITOR' });
    const res = await request(app).post(`/api/staff-schedule/${SCHEDULE_ID}/unpublish`);
    expect(res.status).toBe(403);
  });

  it('un VIEWER nunca puede despublicar', async () => {
    const app = buildApp(makeMockPrisma(), { id: 'view-1', role: 'VIEWER' });
    const res = await request(app).post(`/api/staff-schedule/${SCHEDULE_ID}/unpublish`);
    expect(res.status).toBe(403);
  });

  it('un ADMIN siempre puede despublicar, sea cual sea el departamento', async () => {
    const app = buildApp(makeMockPrisma(), { id: 'admin-1', role: 'ADMIN' });
    const res = await request(app).post(`/api/staff-schedule/${SCHEDULE_ID}/unpublish`);
    expect(res.status).toBe(200);
  });

  it('un id que no es UUID se rechaza con 400 antes de consultar la BD', async () => {
    const app = buildApp(makeMockPrisma(), { id: MANAGER_ID, role: 'MANAGER' });
    const res = await request(app).post('/api/staff-schedule/not-a-uuid/unpublish');
    expect(res.status).toBe(400);
  });
});

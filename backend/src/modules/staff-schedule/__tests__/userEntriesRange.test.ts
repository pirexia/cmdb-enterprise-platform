import express from 'express';
import request from 'supertest';
import { createStaffScheduleRouter } from '../router';

// v3.5.12 (R5/D6) — GET /api/staff-schedule/user/:userId/entries?from=&to=
// Range capped at 62 days; visibility resolved in the WHERE clause (empty
// array, not 403, for out-of-scope data); every entry masked (GDPR Art. 9).

const WORKER_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const DEPT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

function makeMockPrisma(opts: {
  scheduleEntries: Array<{
    id: string; date: Date; status: string; onGuard: boolean; startTime: string | null; endTime: string | null;
    notes: string | null; userId: string; departmentId: string;
  }>;
  // Simulates the visibility filter's effect: schedules considered "out of
  // scope" for the caller's role are dropped, exactly as Prisma would when
  // `schedule: visibility` is applied in the WHERE clause.
  visibleWhenNotAdmin: boolean;
}) {
  return {
    departmentManager: {
      findMany: async () => [],
      findFirst: async () => null, // no one manages DEPT_ID in this mock => canViewSummary=false unless ADMIN
    },
    scheduleEntry: {
      findMany: async ({ where }: { where: { schedule: unknown } }) => {
        // `where.schedule` is the visibility filter object built by
        // buildScheduleVisibilityFilter. ADMIN => {} (truthy empty object,
        // no OR/status keys); non-ADMIN with no managed depts => {status:'PUBLISHED'}.
        const isAdminFilter = Object.keys(where.schedule as Record<string, unknown>).length === 0;
        if (!isAdminFilter && !opts.visibleWhenNotAdmin) return [];
        return opts.scheduleEntries.map((e) => ({
          ...e,
          department: { id: e.departmentId, name: 'Test Dept' },
        }));
      },
    },
    department: { findUnique: async () => ({ id: DEPT_ID, presenceStart: '10:00', presenceEnd: '14:00', minPresencePct: 50 }) },
    departmentScheduleConfig: { findUnique: async () => null },
    user: { findMany: async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.map((id: string) => ({ id, weeklyTargetHours: null })) },
  };
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

describe('GET /user/:userId/entries', () => {
  it('rechaza un rango mayor de 62 días con 400', async () => {
    const app = buildApp(makeMockPrisma({ scheduleEntries: [], visibleWhenNotAdmin: true }), { id: 'admin-1', role: 'ADMIN' });
    const res = await request(app).get(`/api/staff-schedule/user/${WORKER_ID}/entries?from=2026-01-01&to=2026-04-01`);
    expect(res.status).toBe(400);
  });

  it('acepta un rango de 62 días exactos', async () => {
    const app = buildApp(makeMockPrisma({ scheduleEntries: [], visibleWhenNotAdmin: true }), { id: 'admin-1', role: 'ADMIN' });
    const res = await request(app).get(`/api/staff-schedule/user/${WORKER_ID}/entries?from=2026-01-01&to=2026-03-04`);
    expect(res.status).toBe(200);
  });

  it('VIEWER consultando un horario DRAFT fuera de alcance recibe un array vacío, no 403', async () => {
    const entries = [
      { id: 'e1', date: new Date('2026-08-03T00:00:00.000Z'), status: 'PRESENCIAL', onGuard: false, startTime: null, endTime: null, notes: null, userId: WORKER_ID, departmentId: DEPT_ID },
    ];
    const app = buildApp(makeMockPrisma({ scheduleEntries: entries, visibleWhenNotAdmin: false }), { id: 'view-1', role: 'VIEWER' });
    const res = await request(app).get(`/api/staff-schedule/user/${WORKER_ID}/entries?from=2026-08-01&to=2026-08-07`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('una entrada BAJA_MEDICA llega enmascarada a un visor no propietario/no ADMIN', async () => {
    const entries = [
      { id: 'e1', date: new Date('2026-08-03T00:00:00.000Z'), status: 'BAJA_MEDICA', onGuard: true, startTime: null, endTime: null, notes: 'confidencial', userId: WORKER_ID, departmentId: DEPT_ID },
    ];
    const app = buildApp(makeMockPrisma({ scheduleEntries: entries, visibleWhenNotAdmin: true }), { id: 'aud-1', role: 'AUDITOR' });
    const res = await request(app).get(`/api/staff-schedule/user/${WORKER_ID}/entries?from=2026-08-01&to=2026-08-07`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ status: 'AUSENTE', onGuard: false, healthMasked: true });
    expect(res.body[0].notes).toBeNull();
  });

  it('el propio titular ve su entrada BAJA_MEDICA sin enmascarar', async () => {
    const entries = [
      { id: 'e1', date: new Date('2026-08-03T00:00:00.000Z'), status: 'BAJA_MEDICA', onGuard: false, startTime: null, endTime: null, notes: 'confidencial', userId: WORKER_ID, departmentId: DEPT_ID },
    ];
    const app = buildApp(makeMockPrisma({ scheduleEntries: entries, visibleWhenNotAdmin: true }), { id: WORKER_ID, role: 'VIEWER' });
    const res = await request(app).get(`/api/staff-schedule/user/${WORKER_ID}/entries?from=2026-08-01&to=2026-08-07`);
    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({ status: 'BAJA_MEDICA', notes: 'confidencial', healthMasked: false });
  });

  it('ADMIN ve la entrada sin enmascarar', async () => {
    const entries = [
      { id: 'e1', date: new Date('2026-08-03T00:00:00.000Z'), status: 'BAJA_MEDICA', onGuard: false, startTime: null, endTime: null, notes: 'confidencial', userId: WORKER_ID, departmentId: DEPT_ID },
    ];
    const app = buildApp(makeMockPrisma({ scheduleEntries: entries, visibleWhenNotAdmin: true }), { id: 'admin-1', role: 'ADMIN' });
    const res = await request(app).get(`/api/staff-schedule/user/${WORKER_ID}/entries?from=2026-08-01&to=2026-08-07`);
    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({ status: 'BAJA_MEDICA', healthMasked: false });
  });

  it('incluye weeklyTargetHours solo si el visor está autorizado por canViewSummary', async () => {
    const entries = [
      { id: 'e1', date: new Date('2026-08-03T00:00:00.000Z'), status: 'PRESENCIAL', onGuard: false, startTime: null, endTime: null, notes: null, userId: WORKER_ID, departmentId: DEPT_ID },
    ];
    const app = buildApp(makeMockPrisma({ scheduleEntries: entries, visibleWhenNotAdmin: true }), { id: 'admin-1', role: 'ADMIN' });
    const res = await request(app).get(`/api/staff-schedule/user/${WORKER_ID}/entries?from=2026-08-01&to=2026-08-07`);
    expect(res.status).toBe(200);
    expect(res.body[0].weeklyTargetHours).toBeDefined();

    const appViewer = buildApp(makeMockPrisma({ scheduleEntries: entries, visibleWhenNotAdmin: true }), { id: 'view-1', role: 'VIEWER' });
    const resViewer = await request(appViewer).get(`/api/staff-schedule/user/${WORKER_ID}/entries?from=2026-08-01&to=2026-08-07`);
    expect(resViewer.status).toBe(200);
    expect(resViewer.body[0].weeklyTargetHours).toBeUndefined();
  });

  it('incluye el nombre del departamento por entrada', async () => {
    const entries = [
      { id: 'e1', date: new Date('2026-08-03T00:00:00.000Z'), status: 'PRESENCIAL', onGuard: false, startTime: null, endTime: null, notes: null, userId: WORKER_ID, departmentId: DEPT_ID },
    ];
    const app = buildApp(makeMockPrisma({ scheduleEntries: entries, visibleWhenNotAdmin: true }), { id: 'admin-1', role: 'ADMIN' });
    const res = await request(app).get(`/api/staff-schedule/user/${WORKER_ID}/entries?from=2026-08-01&to=2026-08-07`);
    expect(res.body[0]).toMatchObject({ departmentId: DEPT_ID, departmentName: 'Test Dept' });
  });
});

import express from 'express';
import request from 'supertest';
import { createStaffScheduleRouter } from '../router';

// v3.5.12 (R6/R7/D7) — GET / gains an optional from/to range (in addition to
// the pre-existing exact weekStart param) and POST /audit/print records that
// a schedule/worker view was printed, after re-verifying server-side that the
// target is actually visible to the caller.

const DEPT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OTHER_DEPT_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const WORKER_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

describe('GET / — from/to range (R6)', () => {
  function makeMockPrisma() {
    const calls: unknown[] = [];
    return {
      calls,
      departmentManager: { findMany: async () => [] },
      staffSchedule: {
        findMany: async ({ where }: { where: unknown }) => {
          calls.push(where);
          return [];
        },
      },
    };
  }

  function buildApp(prisma: unknown) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { user: { id: string; role: string; email: string } }).user =
        { id: 'admin-1', role: 'ADMIN', email: 'admin@corp.local' };
      next();
    });
    app.use('/api/staff-schedule', createStaffScheduleRouter(prisma as never));
    return app;
  }

  it('rechaza un rango mayor de 6 semanas con 400', async () => {
    const app = buildApp(makeMockPrisma());
    const res = await request(app).get('/api/staff-schedule?from=2026-01-01&to=2026-03-01');
    expect(res.status).toBe(400);
  });

  it('acepta un rango de 6 semanas exactas (42 días)', async () => {
    const app = buildApp(makeMockPrisma());
    const res = await request(app).get('/api/staff-schedule?from=2026-01-01&to=2026-02-12');
    expect(res.status).toBe(200);
  });

  it('el weekStart exacto sigue funcionando sin from/to', async () => {
    const mock = makeMockPrisma();
    const app = buildApp(mock);
    const res = await request(app).get('/api/staff-schedule?weekStart=2026-08-03');
    expect(res.status).toBe(200);
    const where = mock.calls[0] as { weekStart: Date };
    expect(where.weekStart).toEqual(new Date('2026-08-03'));
  });

  it('weekStart exacto tiene prioridad si se envía junto con from/to', async () => {
    const mock = makeMockPrisma();
    const app = buildApp(mock);
    const res = await request(app).get('/api/staff-schedule?weekStart=2026-08-03&from=2026-01-01&to=2026-01-15');
    expect(res.status).toBe(200);
    const where = mock.calls[0] as { weekStart: Date };
    expect(where.weekStart).toEqual(new Date('2026-08-03'));
  });
});

describe('POST /audit/print (R7/D7)', () => {
  function makeMockPrisma(opts: { departmentVisible: boolean }) {
    const audits: Array<{ action: string; entity: string; entityId: string; userEmail: string }> = [];
    const prisma = {
      audits,
      departmentManager: { findMany: async () => [] },
      staffSchedule: {
        count: async () => (opts.departmentVisible ? 1 : 0),
      },
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
            // auditStaffSchedule() calls db.$executeRaw`... ${action} ... ${entity} ... ${entityId} ... ${userEmail} ...`
            const [action, entity, entityId, userEmail] = values as string[];
            audits.push({ action, entity, entityId, userEmail });
            return 1;
          },
        };
        return fn(tx);
      },
    };
    return prisma;
  }

  function buildApp(prisma: unknown, userEmail = 'auditor@corp.local') {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { user: { id: string; role: string; email: string } }).user =
        { id: 'aud-1', role: 'AUDITOR', email: userEmail };
      next();
    });
    app.use('/api/staff-schedule', createStaffScheduleRouter(prisma as never));
    return app;
  }

  it('registra PRINT_STAFF_SCHEDULE cuando el departamento es visible', async () => {
    const prisma = makeMockPrisma({ departmentVisible: true });
    const app = buildApp(prisma);
    const res = await request(app).post('/api/staff-schedule/audit/print').send({
      scope: 'DEPARTMENT_WEEK', targetId: DEPT_ID,
    });
    expect(res.status).toBe(204);
    expect(prisma.audits).toHaveLength(1);
    expect(prisma.audits[0]).toMatchObject({ action: 'PRINT_STAFF_SCHEDULE', entityId: DEPT_ID });
  });

  it('devuelve 404 y NO inserta AuditLog para un departamento no visible', async () => {
    const prisma = makeMockPrisma({ departmentVisible: false });
    const app = buildApp(prisma);
    const res = await request(app).post('/api/staff-schedule/audit/print').send({
      scope: 'DEPARTMENT_MONTH', targetId: OTHER_DEPT_ID,
    });
    expect(res.status).toBe(404);
    expect(prisma.audits).toHaveLength(0);
  });

  it('un userEmail espurio en el body es ignorado; siempre se usa el email de sesión', async () => {
    const prisma = makeMockPrisma({ departmentVisible: true });
    const app = buildApp(prisma, 'real-session-user@corp.local');
    const res = await request(app).post('/api/staff-schedule/audit/print').send({
      scope: 'WORKER', targetId: WORKER_ID, userEmail: 'attacker@evil.example',
    });
    expect(res.status).toBe(204);
    expect(prisma.audits[0].userEmail).toBe('real-session-user@corp.local');
  });

  it('scope WORKER no requiere comprobación de departamento (solo acceso al módulo)', async () => {
    const prisma = makeMockPrisma({ departmentVisible: false }); // even if "false", WORKER path ignores it
    const app = buildApp(prisma);
    const res = await request(app).post('/api/staff-schedule/audit/print').send({
      scope: 'WORKER', targetId: WORKER_ID,
    });
    expect(res.status).toBe(204);
    expect(prisma.audits).toHaveLength(1);
  });

  it('rechaza un scope desconocido con 400', async () => {
    const prisma = makeMockPrisma({ departmentVisible: true });
    const app = buildApp(prisma);
    const res = await request(app).post('/api/staff-schedule/audit/print').send({
      scope: 'BOGUS', targetId: DEPT_ID,
    });
    expect(res.status).toBe(400);
    expect(prisma.audits).toHaveLength(0);
  });
});

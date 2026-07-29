import express from 'express';
import request from 'supertest';
import { createStaffScheduleRouter } from '../router';
import { canViewSummary } from '../service';
import { exportScheduleCsv, exportScheduleXlsx } from '../export';
import type { ScheduleView } from '../service';

// v3.5.12 (R2/D1/D2) — the weekly-hours `summary` block is a real access
// control, not a cosmetic one: the server omits the key from the JSON
// entirely for a viewer who is neither ADMIN nor manager of THIS ROW's
// department. canViewSummary() deliberately delegates to
// canUserEditDepartment() (same as `canEdit`) so the two checks can never
// diverge — these tests exercise both the unit-level delegation and the
// end-to-end GET /:id shape.

const DEPT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OTHER_DEPT_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const SCHEDULE_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const WORKER_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const MANAGER_ID = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const OTHER_MANAGER_ID = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

describe('canViewSummary', () => {
  function mockPrisma() {
    return {
      departmentManager: {
        findFirst: async ({ where }: { where: { departmentId: string; userId: string } }) => {
          if (where.departmentId === DEPT_ID && where.userId === MANAGER_ID) return { id: 'mgr-row' };
          return null;
        },
      },
    } as unknown as Parameters<typeof canViewSummary>[0];
  }

  it('ADMIN siempre autorizado, sea cual sea el departamento', async () => {
    expect(await canViewSummary(mockPrisma(), 'admin-1', 'ADMIN', DEPT_ID)).toBe(true);
    expect(await canViewSummary(mockPrisma(), 'admin-1', 'ADMIN', OTHER_DEPT_ID)).toBe(true);
  });

  it('MANAGER autorizado solo para el departamento que gestiona', async () => {
    expect(await canViewSummary(mockPrisma(), MANAGER_ID, 'MANAGER', DEPT_ID)).toBe(true);
    expect(await canViewSummary(mockPrisma(), MANAGER_ID, 'MANAGER', OTHER_DEPT_ID)).toBe(false);
  });

  it('MANAGER de otro departamento no autorizado', async () => {
    expect(await canViewSummary(mockPrisma(), OTHER_MANAGER_ID, 'MANAGER', DEPT_ID)).toBe(false);
  });

  it('AUDITOR/VIEWER nunca autorizados', async () => {
    expect(await canViewSummary(mockPrisma(), 'x', 'AUDITOR', DEPT_ID)).toBe(false);
    expect(await canViewSummary(mockPrisma(), 'x', 'VIEWER', DEPT_ID)).toBe(false);
  });

  it('sin departmentId nunca autorizado (salvo ADMIN)', async () => {
    expect(await canViewSummary(mockPrisma(), MANAGER_ID, 'MANAGER', null)).toBe(false);
  });
});

describe('GET /:id — summary omitido según autorización', () => {
  function makeMockPrisma() {
    return {
      departmentManager: {
        findMany: async ({ where }: { where: { userId?: string; departmentId?: string } }) => {
          if (where.userId === MANAGER_ID) return [{ departmentId: DEPT_ID }];
          if (where.userId === OTHER_MANAGER_ID) return [{ departmentId: OTHER_DEPT_ID }];
          if (where.departmentId === DEPT_ID) return [{ userId: MANAGER_ID }];
          return [];
        },
        findFirst: async ({ where }: { where: { departmentId: string; userId: string } }) => {
          if (where.departmentId === DEPT_ID && where.userId === MANAGER_ID) return { id: 'mgr-row' };
          return null;
        },
      },
      staffSchedule: {
        findFirst: async ({ where }: { where: { AND: [{ id: string }, unknown] } }) => {
          if (where.AND[0].id !== SCHEDULE_ID) return null;
          return {
            id: SCHEDULE_ID,
            departmentId: DEPT_ID,
            weekStart: new Date('2026-08-03T00:00:00.000Z'),
            weekEnd: new Date('2026-08-07T00:00:00.000Z'),
            status: 'PUBLISHED',
            year: 2026,
            isSummerWeek: false,
            entries: [
              {
                id: 'e1', userId: WORKER_ID, date: new Date('2026-08-03T00:00:00.000Z'),
                status: 'PRESENCIAL', onGuard: false, startTime: null, endTime: null, notes: null,
                user: { id: WORKER_ID, username: 'worker1', displayName: 'Worker One' },
              },
            ],
            alerts: [],
          };
        },
      },
      department: {
        findUnique: async () => ({ id: DEPT_ID, presenceStart: '10:00', presenceEnd: '14:00', minPresencePct: 50 }),
      },
      departmentScheduleConfig: { findUnique: async () => null },
      user: {
        findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
          where.id.in.map((id: string) => ({ id, weeklyTargetHours: null })),
      },
      scheduleEntry: { count: async () => 0 },
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

  it('ADMIN ve el resumen', async () => {
    const app = buildApp(makeMockPrisma(), { id: 'admin-1', role: 'ADMIN' });
    const res = await request(app).get(`/api/staff-schedule/${SCHEDULE_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.rows[0].summary).toBeDefined();
  });

  it('MANAGER del departamento ve el resumen', async () => {
    const app = buildApp(makeMockPrisma(), { id: MANAGER_ID, role: 'MANAGER' });
    const res = await request(app).get(`/api/staff-schedule/${SCHEDULE_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.rows[0].summary).toBeDefined();
  });

  it('MANAGER de OTRO departamento no ve el resumen', async () => {
    const app = buildApp(makeMockPrisma(), { id: OTHER_MANAGER_ID, role: 'MANAGER' });
    const res = await request(app).get(`/api/staff-schedule/${SCHEDULE_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.rows[0].summary).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(res.body.rows[0], 'summary')).toBe(false);
  });

  it('AUDITOR no ve el resumen', async () => {
    const app = buildApp(makeMockPrisma(), { id: 'aud-1', role: 'AUDITOR' });
    const res = await request(app).get(`/api/staff-schedule/${SCHEDULE_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.rows[0].summary).toBeUndefined();
  });

  it('VIEWER no ve el resumen', async () => {
    const app = buildApp(makeMockPrisma(), { id: 'view-1', role: 'VIEWER' });
    const res = await request(app).get(`/api/staff-schedule/${SCHEDULE_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.rows[0].summary).toBeUndefined();
  });
});

describe('export tolera summary ausente', () => {
  function buildView(withSummary: boolean): ScheduleView {
    return {
      schedule: {
        id: SCHEDULE_ID, departmentId: DEPT_ID, weekStart: '2026-08-03', weekEnd: '2026-08-07',
        status: 'PUBLISHED', year: 2026, isSummerWeek: false,
      },
      days: ['2026-08-03', '2026-08-04'],
      rows: [
        {
          userId: WORKER_ID,
          username: 'worker1',
          displayName: 'Worker One',
          entries: {
            '2026-08-03': { status: 'PRESENCIAL', onGuard: false, startTime: null, endTime: null, notes: null },
          },
          ...(withSummary
            ? { summary: { weeklyNetHours: 40, teleworkDaysWeek: 0, teleworkDaysMonth: 0, travelDays: 0, guardDays: 0, weeklyTargetHours: 40, dailyTargetHours: 8 } }
            : {}),
        },
      ],
      alerts: [],
      canEdit: false,
    };
  }

  // header: Username, day1, day2, WeeklyNetHours, TeleworkDaysWeek, TeleworkDaysMonth, TravelDays, GuardDays
  function parseCsvRow(line: string): string[] {
    return line.split('","').map((s) => s.replace(/^"|"$/g, ''));
  }

  it('CSV no lanza y deja las celdas de resumen vacías cuando falta', () => {
    const csv = exportScheduleCsv(buildView(false));
    const [, dataLine] = csv.split('\r\n');
    const fields = parseCsvRow(dataLine);
    expect(fields).toEqual(['worker1', 'PRESENCIAL', '', '', '', '', '', '']);
  });

  it('CSV rellena las celdas de resumen cuando está presente', () => {
    const csv = exportScheduleCsv(buildView(true));
    const [, dataLine] = csv.split('\r\n');
    const fields = parseCsvRow(dataLine);
    expect(fields).toEqual(['worker1', 'PRESENCIAL', '', '40', '0', '0', '0', '0']);
  });

  it('XLSX no lanza cuando falta summary', async () => {
    await expect(exportScheduleXlsx(buildView(false))).resolves.toBeInstanceOf(Buffer);
  });

  it('XLSX no lanza cuando summary está presente', async () => {
    await expect(exportScheduleXlsx(buildView(true))).resolves.toBeInstanceOf(Buffer);
  });
});

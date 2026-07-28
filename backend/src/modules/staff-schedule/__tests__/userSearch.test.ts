import express from 'express';
import request from 'supertest';
import { createStaffScheduleRouter } from '../router';

// v3.5.12 (R5/D4) — GET /api/staff-schedule/users?q= worker search selector.
// Must never expose email (GDPR Art. 5.1.c minimisation) and must be
// registered ahead of `/:id` so it isn't swallowed as an invalid UUID id.

function buildApp(users: Array<{ id: string; username: string; displayName: string | null; active: boolean; departmentId: string | null }>) {
  const prisma = {
    user: {
      findMany: async ({ where, select, take }: { where: { active: boolean; departmentId: { not: null }; OR: Array<Record<string, unknown>> }; select: Record<string, boolean>; take: number }) => {
        const q = (where.OR[0] as { username: { contains: string } }).username.contains.toLowerCase();
        const matches = users.filter((u) =>
          u.active &&
          u.departmentId !== null &&
          (u.username.toLowerCase().includes(q) || (u.displayName ?? '').toLowerCase().includes(q)),
        );
        return matches.slice(0, take).map((u) => {
          const row: Record<string, unknown> = {};
          for (const key of Object.keys(select)) row[key] = (u as Record<string, unknown>)[key];
          return row;
        });
      },
    },
  };

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user: { id: string; role: string; email: string } }).user =
      { id: 'viewer-1', role: 'VIEWER', email: 'viewer@corp.local' };
    next();
  });
  app.use('/api/staff-schedule', createStaffScheduleRouter(prisma as never));
  return app;
}

const USERS = [
  { id: 'u1', username: 'andres.matias', displayName: 'Andrés Matías López', active: true, departmentId: 'd1' },
  { id: 'u2', username: 'roberto.cerezo', displayName: null, active: true, departmentId: 'd1' },
  { id: 'u3', username: 'inactive.user', displayName: 'Inactive User', active: false, departmentId: 'd1' },
  { id: 'u4', username: 'no.department', displayName: 'No Department', active: true, departmentId: null },
];

describe('GET /api/staff-schedule/users', () => {
  it('rechaza q de 1 carácter con 400', async () => {
    const res = await request(buildApp(USERS)).get('/api/staff-schedule/users?q=a');
    expect(res.status).toBe(400);
  });

  it('acepta q de 2 caracteres y devuelve resultados sin email', async () => {
    const res = await request(buildApp(USERS)).get('/api/staff-schedule/users?q=andres');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: 'u1', username: 'andres.matias', displayName: 'Andrés Matías López' }]);
    expect(res.body[0]).not.toHaveProperty('email');
  });

  it('excluye usuarios inactivos', async () => {
    const res = await request(buildApp(USERS)).get('/api/staff-schedule/users?q=inactive');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('excluye usuarios sin departmentId', async () => {
    const res = await request(buildApp(USERS)).get('/api/staff-schedule/users?q=department');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('no explota con un q de 1 carácter enviado a /:id (registro de ruta correcto)', async () => {
    // Regression guard: /users must be matched before /:id, or this would
    // 400 with "Invalid id: must be a UUID" from the wrong handler instead
    // of the q-length validation from UserSearchSchema.
    const res = await request(buildApp(USERS)).get('/api/staff-schedule/users?q=x');
    expect(res.status).toBe(400);
    expect(res.body.error).not.toEqual('Invalid id: must be a UUID');
  });

  it('limita los resultados a 20', async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      id: `u${i}`, username: `match${i}`, displayName: null, active: true, departmentId: 'd1',
    }));
    const res = await request(buildApp(many)).get('/api/staff-schedule/users?q=match');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(20);
  });
});

import { syncScheduleMembers, ScheduleServiceError } from '../service';

// v3.5.10 refinamiento — resincronizar miembros del departamento en un
// horario borrador. No destructivo: solo añade entradas base PRESENCIAL para
// miembros que aún no tengan ninguna en el horario. Cubre tanto un horario
// vacío (creado antes de la membresía final del departamento) como un
// trabajador nuevo incorporado a un departamento con horarios ya planificados.

const WEEK_START = new Date('2026-08-03T00:00:00.000Z'); // Monday

function mockTx(opts: {
  schedule: { status: string; departmentId: string } | null;
  members: { id: string }[];
  presentUserIds: string[];
}) {
  const created: { userId: string; date: Date }[] = [];
  let deletedWhere: { scheduleId: string; userId: { in: string[] } } | null = null;
  const tx = {
    staffSchedule: {
      findUnique: async () => (opts.schedule ? { ...opts.schedule, weekStart: WEEK_START } : null),
    },
    user: {
      findMany: async () => opts.members.map((m) => ({ ...m, username: m.id, displayName: null, email: `${m.id}@corp.local`, weeklyTargetHours: null })),
    },
    scheduleEntry: {
      findMany: async () => opts.presentUserIds.map((userId) => ({ userId })),
      createMany: async ({ data }: { data: { userId: string; date: Date }[] }) => {
        created.push(...data.map((d) => ({ userId: d.userId, date: d.date })));
        return { count: data.length };
      },
      deleteMany: async ({ where }: { where: { scheduleId: string; userId: { in: string[] } } }) => {
        deletedWhere = where;
        return { count: where.userId.in.length };
      },
    },
  } as unknown as Parameters<typeof syncScheduleMembers>[0];
  return { tx, created, getDeletedWhere: () => deletedWhere };
}

describe('syncScheduleMembers', () => {
  it('añade entradas base para todos los miembros cuando el horario está vacío', async () => {
    const { tx, created } = mockTx({
      schedule: { status: 'DRAFT', departmentId: 'dept-1' },
      members: [{ id: 'u1' }, { id: 'u2' }],
      presentUserIds: [],
    });
    const result = await syncScheduleMembers(tx, 'sched-1');
    expect(result).toEqual({ added: 2, removed: 0 });
    expect(created).toHaveLength(10); // 2 miembros x 5 días
  });

  it('solo añade a los miembros que faltan, no toca a los ya presentes', async () => {
    const { tx, created } = mockTx({
      schedule: { status: 'DRAFT', departmentId: 'dept-1' },
      members: [{ id: 'u1' }, { id: 'u2' }, { id: 'u3' }],
      presentUserIds: ['u1', 'u2'],
    });
    const result = await syncScheduleMembers(tx, 'sched-1');
    expect(result).toEqual({ added: 1, removed: 0 });
    expect(created.every((c) => c.userId === 'u3')).toBe(true);
    expect(created).toHaveLength(5);
  });

  it('no hace nada si todos los miembros ya tienen entradas', async () => {
    const { tx, created } = mockTx({
      schedule: { status: 'DRAFT', departmentId: 'dept-1' },
      members: [{ id: 'u1' }],
      presentUserIds: ['u1'],
    });
    const result = await syncScheduleMembers(tx, 'sched-1');
    expect(result).toEqual({ added: 0, removed: 0 });
    expect(created).toHaveLength(0);
  });

  it('rechaza con 409 un horario PUBLISHED', async () => {
    const { tx } = mockTx({
      schedule: { status: 'PUBLISHED', departmentId: 'dept-1' },
      members: [{ id: 'u1' }],
      presentUserIds: [],
    });
    await expect(syncScheduleMembers(tx, 'sched-1')).rejects.toMatchObject(
      new ScheduleServiceError(409, 'Cannot sync members on a published schedule; unpublish first'),
    );
  });

  it('devuelve 404 si el horario no existe', async () => {
    const { tx } = mockTx({ schedule: null, members: [], presentUserIds: [] });
    await expect(syncScheduleMembers(tx, 'no-existe')).rejects.toMatchObject(
      new ScheduleServiceError(404, 'Schedule not found'),
    );
  });
});

describe('syncScheduleMembers — retirada de miembros (v3.5.13, D5)', () => {
  it('borra las entradas de quien ya no pertenece al departamento', async () => {
    // Solo u1 sigue en el departamento; u2 fue retirado.
    const { tx, getDeletedWhere } = mockTx({
      schedule: { status: 'DRAFT', departmentId: 'dept-1' },
      members: [{ id: 'u1' }],
      presentUserIds: ['u1', 'u2'],
    });
    const result = await syncScheduleMembers(tx, 'sched-1');
    expect(result).toEqual({ added: 0, removed: 1 });
    expect(getDeletedWhere()).toEqual({ scheduleId: 'sched-1', userId: { in: ['u2'] } });
  });

  it('no borra nada cuando todos los presentes siguen siendo miembros', async () => {
    const { tx, getDeletedWhere } = mockTx({
      schedule: { status: 'DRAFT', departmentId: 'dept-1' },
      members: [{ id: 'u1' }],
      presentUserIds: ['u1'],
    });
    const result = await syncScheduleMembers(tx, 'sched-1');
    expect(result).toEqual({ added: 0, removed: 0 });
    expect(getDeletedWhere()).toBeNull();
  });

  it('añade y retira a la vez cuando el horario tiene de ambos', async () => {
    const { tx, created, getDeletedWhere } = mockTx({
      schedule: { status: 'DRAFT', departmentId: 'dept-1' },
      members: [{ id: 'u1' }, { id: 'u3' }],
      presentUserIds: ['u1', 'u2'],
    });
    const result = await syncScheduleMembers(tx, 'sched-1');
    expect(result).toEqual({ added: 1, removed: 1 });
    expect(created.every((c) => c.userId === 'u3')).toBe(true);
    expect(getDeletedWhere()).toEqual({ scheduleId: 'sched-1', userId: { in: ['u2'] } });
  });

  it('sigue rechazando un horario publicado (los PUBLISHED no se tocan nunca)', async () => {
    const { tx, getDeletedWhere } = mockTx({
      schedule: { status: 'PUBLISHED', departmentId: 'dept-1' },
      members: [{ id: 'u1' }],
      presentUserIds: ['u1', 'u2'],
    });
    await expect(syncScheduleMembers(tx, 'sched-1')).rejects.toMatchObject({ statusCode: 409 });
    expect(getDeletedWhere()).toBeNull();
  });
});

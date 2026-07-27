import { deleteSchedule } from '../service';
import { ScheduleServiceError } from '../service';

// v3.5.10 refinamiento — DELETE de un horario en borrador. Un horario
// creado/clonado antes de que el departamento tuviera su membresía final no
// tenía forma de descartarse para poder re-clonar la semana desde cero.

function mockTx(schedule: { status: string } | null) {
  const deleted: string[] = [];
  return {
    tx: {
      staffSchedule: {
        findUnique: async () => (schedule ? { status: schedule.status } : null),
        delete: async ({ where }: { where: { id: string } }) => { deleted.push(where.id); return { id: where.id }; },
      },
    } as unknown as Parameters<typeof deleteSchedule>[0],
    deleted,
  };
}

describe('deleteSchedule', () => {
  it('borra un horario en DRAFT', async () => {
    const { tx, deleted } = mockTx({ status: 'DRAFT' });
    await deleteSchedule(tx, 'sched-1');
    expect(deleted).toEqual(['sched-1']);
  });

  it('rechaza con 409 un horario PUBLISHED (D10 — inmutable)', async () => {
    const { tx, deleted } = mockTx({ status: 'PUBLISHED' });
    await expect(deleteSchedule(tx, 'sched-1')).rejects.toMatchObject(
      new ScheduleServiceError(409, 'Cannot delete a published schedule; unpublish first'),
    );
    expect(deleted).toEqual([]);
  });

  it('devuelve 404 si el horario no existe', async () => {
    const { tx } = mockTx(null);
    await expect(deleteSchedule(tx, 'no-existe')).rejects.toMatchObject(
      new ScheduleServiceError(404, 'Schedule not found'),
    );
  });
});

import { resolveSummerForDepartment } from '../queries';

// v3.5.13 — horario de verano configurable por departamento (D-summer). Tres
// ramas, en este orden: desactivado explícitamente -> null; fechas propias
// fijadas -> las suyas; activado sin fechas (o sin fila de config) -> el
// periodo global del año. La rama por defecto reproduce exactamente el
// comportamiento anterior a v3.5.13 para toda fila ya existente en producción.

function mockPrisma(opts: {
  config: { summerEnabled: boolean; summerStartDate: Date | null; summerEndDate: Date | null } | null;
  global: { year: number; startDate: Date; endDate: Date } | null;
}) {
  return {
    departmentScheduleConfig: {
      findUnique: async () => opts.config,
    },
    summerSchedule: {
      findUnique: async () => opts.global,
    },
  } as unknown as Parameters<typeof resolveSummerForDepartment>[0];
}

describe('resolveSummerForDepartment (v3.5.13)', () => {
  it('devuelve null cuando el departamento tiene el verano desactivado', async () => {
    const prisma = mockPrisma({
      config: { summerEnabled: false, summerStartDate: null, summerEndDate: null },
      global: { year: 2026, startDate: new Date('2026-07-13T00:00:00Z'), endDate: new Date('2026-09-13T00:00:00Z') },
    });
    await expect(resolveSummerForDepartment(prisma, 'dept-1', 2026)).resolves.toBeNull();
  });

  it('usa el periodo propio del departamento cuando lo tiene', async () => {
    const prisma = mockPrisma({
      config: {
        summerEnabled: true,
        summerStartDate: new Date('2026-08-01T00:00:00Z'),
        summerEndDate: new Date('2026-08-15T00:00:00Z'),
      },
      global: { year: 2026, startDate: new Date('2026-07-13T00:00:00Z'), endDate: new Date('2026-09-13T00:00:00Z') },
    });
    await expect(resolveSummerForDepartment(prisma, 'dept-1', 2026)).resolves.toEqual({
      year: 2026, startDate: '2026-08-01', endDate: '2026-08-15',
    });
  });

  it('cae al periodo global cuando el departamento lo tiene activado sin fechas propias', async () => {
    const prisma = mockPrisma({
      config: { summerEnabled: true, summerStartDate: null, summerEndDate: null },
      global: { year: 2026, startDate: new Date('2026-07-13T00:00:00Z'), endDate: new Date('2026-09-13T00:00:00Z') },
    });
    await expect(resolveSummerForDepartment(prisma, 'dept-1', 2026)).resolves.toEqual({
      year: 2026, startDate: '2026-07-13', endDate: '2026-09-13',
    });
  });

  it('un departamento sin fila de configuracion cae al periodo global', async () => {
    const prisma = mockPrisma({
      config: null,
      global: { year: 2026, startDate: new Date('2026-07-13T00:00:00Z'), endDate: new Date('2026-09-13T00:00:00Z') },
    });
    await expect(resolveSummerForDepartment(prisma, 'dept-1', 2026)).resolves.not.toBeNull();
  });

  it('sin periodo global ni propio, devuelve null', async () => {
    const prisma = mockPrisma({ config: null, global: null });
    await expect(resolveSummerForDepartment(prisma, 'dept-1', 2026)).resolves.toBeNull();
  });
});

import {
  validate, ValidationConfig, EntryLike, ScheduleLike, computeNetHours,
  resolveTeleworkCap, workingDaysInMonth, computeEffectiveWeeklyTarget,
  computeDailyTargetHours,
} from '../validationEngine';
import { maskEntryForViewer } from '../service';

const cfg: ValidationConfig = {
  winterDailyNetHours: 8.0,
  winterMaxDailyNetHours: 9.0,
  winterBreakMinutes: 60,
  winterFridayNetHours: 6.0,
  summerDailyNetHours: 8.0,
  summerMaxDailyNetHours: 9.0,
  summerBreakMinutes: 30,
  summerFridayNetHours: 6.0,
  weeklyTargetNetHours: 40.0,
  monthlyTeleworkCap: 10,
  flexEntryStart: '07:00',
  flexEntryEnd: '10:30',
  flexExitStart: '16:00',
  flexExitEnd: '19:00',
  presenceStart: '10:00',
  presenceEnd: '14:00',
  minPresencePct: 50,
};

const schedule: ScheduleLike = { id: 'sched-1', weekStart: '2026-07-06', year: 2026 }; // Monday 2026-07-06

function alertsOfType(alerts: ReturnType<typeof validate>, type: string) {
  return alerts.filter((a) => a.type === type);
}

describe('validationEngine.validate', () => {
  it('(a) 2x9h + 2x8h + intensive Friday 6h = 40h -> no WEEKLY_HOURS', () => {
    const entries: EntryLike[] = [
      { userId: 'u1', date: '2026-07-06', status: 'PRESENCIAL', startTime: '08:00', endTime: '18:00' }, // Mon net 9h
      { userId: 'u1', date: '2026-07-07', status: 'PRESENCIAL', startTime: '08:00', endTime: '18:00' }, // Tue net 9h
      { userId: 'u1', date: '2026-07-08', status: 'PRESENCIAL', startTime: '08:00', endTime: '17:00' }, // Wed net 8h
      { userId: 'u1', date: '2026-07-09', status: 'PRESENCIAL', startTime: '08:00', endTime: '17:00' }, // Thu net 8h
      { userId: 'u1', date: '2026-07-10', status: 'INTENSIVO', startTime: '08:00', endTime: '14:00' },  // Fri net 6h
    ];
    const alerts = validate(schedule, entries, cfg, null, {});
    expect(alertsOfType(alerts, 'WEEKLY_HOURS')).toHaveLength(0);
    expect(alertsOfType(alerts, 'DAILY_HOURS')).toHaveLength(0);
  });

  it('(b) intensive Friday but week total 37h, below the 38h target of 4x8+6 -> WEEKLY_HOURS ERROR', () => {
    // v3.5.13 — el objetivo ya no es un 40h plano: es la suma de los días
    // realmente planificados (4x8 + viernes 6 = 38h). Este caso deja el total
    // en 37h, un punto por debajo, para seguir disparando la alerta.
    const entries: EntryLike[] = [
      { userId: 'u1', date: '2026-07-06', status: 'PRESENCIAL', startTime: '08:00', endTime: '18:00' }, // Mon 9h
      { userId: 'u1', date: '2026-07-07', status: 'PRESENCIAL', startTime: '08:00', endTime: '18:00' }, // Tue 9h
      { userId: 'u1', date: '2026-07-08', status: 'PRESENCIAL', startTime: '08:00', endTime: '17:00' }, // Wed 8h
      { userId: 'u1', date: '2026-07-09', status: 'PRESENCIAL', startTime: '07:00', endTime: '13:00' }, // Thu net 5h
      { userId: 'u1', date: '2026-07-10', status: 'INTENSIVO', startTime: '08:00', endTime: '14:00' },  // Fri 6h
    ];
    const alerts = validate(schedule, entries, cfg, null, {});
    const weekly = alertsOfType(alerts, 'WEEKLY_HOURS');
    expect(weekly).toHaveLength(1);
    expect(weekly[0].severity).toBe('ERROR');
    expect(weekly[0].userId).toBe('u1');
  });

  it('(c) Mon-Thu day with 10h net (> 9h max) -> DAILY_HOURS ERROR', () => {
    const entries: EntryLike[] = [
      { userId: 'u1', date: '2026-07-06', status: 'PRESENCIAL', startTime: '07:00', endTime: '18:00' }, // Mon gross11h-1h=10h net
    ];
    const alerts = validate(schedule, entries, cfg, null, {});
    const daily = alertsOfType(alerts, 'DAILY_HOURS');
    expect(daily).toHaveLength(1);
    expect(daily[0].severity).toBe('ERROR');
    expect(daily[0].userId).toBe('u1');
    expect(daily[0].date).toBe('2026-07-06');
  });

  it('(d) 11 telework days in the month -> TELEWORK_QUOTA ERROR', () => {
    const entries: EntryLike[] = [
      { userId: 'u1', date: '2026-07-06', status: 'TELETRABAJO', startTime: '08:00', endTime: '17:00' },
    ];
    const alerts = validate(schedule, entries, cfg, null, { u1: 11 });
    const quota = alertsOfType(alerts, 'TELEWORK_QUOTA');
    expect(quota).toHaveLength(1);
    expect(quota[0].severity).toBe('ERROR');
  });

  it('(e) 30% presence in the core band with 50% minimum -> PRESENCE_PCT WARNING', () => {
    const entries: EntryLike[] = [];
    for (let i = 0; i < 10; i++) {
      const userId = `u${i}`;
      if (i < 3) {
        entries.push({ userId, date: '2026-07-06', status: 'PRESENCIAL', startTime: '09:00', endTime: '15:00' });
      } else {
        entries.push({ userId, date: '2026-07-06', status: 'TELETRABAJO', startTime: '08:00', endTime: '17:00' });
      }
    }
    const alerts = validate(schedule, entries, cfg, null, {});
    const presence = alertsOfType(alerts, 'PRESENCE_PCT');
    expect(presence).toHaveLength(1);
    expect(presence[0].severity).toBe('WARNING');
  });

  it('(f) Friday PRESENCIAL applies the same break as other days (bug #195 regression)', () => {
    // 07:30-16:00 gross 8.5h, summer break 30min -> net 8.0h, same as Mon-Thu.
    const fri: EntryLike = { userId: 'u1', date: '2026-07-10', status: 'PRESENCIAL', startTime: '07:30', endTime: '16:00' };
    expect(computeNetHours(fri, cfg, true)).toBeCloseTo(8.0, 5);
  });

  it('(g) 5x 07:30-16:00 summer week nets exactly 40h, not 40.5h', () => {
    const entries: EntryLike[] = ['2026-07-06', '2026-07-07', '2026-07-08', '2026-07-09', '2026-07-10'].map((date) => ({
      userId: 'u1', date, status: 'PRESENCIAL', startTime: '07:30', endTime: '16:00',
    }));
    const total = entries.reduce((sum, e) => sum + computeNetHours(e, cfg, true), 0);
    expect(total).toBeCloseTo(40.0, 5);
  });

  it('does not raise GUARDIA_COVERAGE / BAJA_CONFLICT when there is no week-level conflict', () => {
    const entries: EntryLike[] = [
      { userId: 'u1', date: '2026-07-06', status: 'PRESENCIAL', onGuard: true, startTime: '08:00', endTime: '17:00' },
      { userId: 'u1', date: '2026-07-07', status: 'PRESENCIAL', startTime: '08:00', endTime: '17:00' },
    ];
    const alerts = validate(schedule, entries, cfg, null, {});
    expect(alertsOfType(alerts, 'GUARDIA_COVERAGE')).toHaveLength(0);
    expect(alertsOfType(alerts, 'BAJA_CONFLICT')).toHaveLength(0);
  });

  it('raises GUARDIA_COVERAGE when on-guard and VIAJE/VACACIONES fall in the same week', () => {
    const entries: EntryLike[] = [
      { userId: 'u1', date: '2026-07-06', status: 'PRESENCIAL', onGuard: true, startTime: '08:00', endTime: '17:00' },
      { userId: 'u1', date: '2026-07-07', status: 'VACACIONES' },
    ];
    const alerts = validate(schedule, entries, cfg, null, {});
    const coverage = alertsOfType(alerts, 'GUARDIA_COVERAGE');
    expect(coverage).toHaveLength(1);
    expect(coverage[0].severity).toBe('ERROR');
  });

  it('a worker can be TELETRABAJO and on guard on the same day, with no conflict alert', () => {
    const entries: EntryLike[] = [
      { userId: 'u1', date: '2026-07-06', status: 'TELETRABAJO', onGuard: true, startTime: '08:00', endTime: '17:00' },
    ];
    const alerts = validate(schedule, entries, cfg, null, {});
    expect(alertsOfType(alerts, 'GUARDIA_COVERAGE')).toHaveLength(0);
    expect(alertsOfType(alerts, 'GUARDIA_UNIQUE')).toHaveLength(0);
  });

  it('raises GUARDIA_UNIQUE when two workers are on guard the same day', () => {
    const entries: EntryLike[] = [
      { userId: 'u1', date: '2026-07-06', status: 'PRESENCIAL', onGuard: true, startTime: '08:00', endTime: '17:00' },
      { userId: 'u2', date: '2026-07-06', status: 'TELETRABAJO', onGuard: true, startTime: '08:00', endTime: '17:00' },
    ];
    const alerts = validate(schedule, entries, cfg, null, {});
    const unique = alertsOfType(alerts, 'GUARDIA_UNIQUE');
    expect(unique).toHaveLength(2);
    expect(unique.map((a) => a.userId).sort()).toEqual(['u1', 'u2']);
    expect(unique[0].severity).toBe('ERROR');
  });

  it('raises BAJA_CONFLICT when a health-leave day and a working day fall in the same week', () => {
    const entries: EntryLike[] = [
      { userId: 'u1', date: '2026-07-06', status: 'BAJA_MEDICA' },
      { userId: 'u1', date: '2026-07-07', status: 'PRESENCIAL', startTime: '08:00', endTime: '17:00' },
    ];
    const alerts = validate(schedule, entries, cfg, null, {});
    const conflict = alertsOfType(alerts, 'BAJA_CONFLICT');
    expect(conflict).toHaveLength(1);
    expect(conflict[0].severity).toBe('WARNING');
  });

  // v3.5.10 refinamiento — FLEX_RANGE no debe aplicar a INTENSIVO (jornada
  // continua con horario propio, sin ventana flexible de entrada/salida).
  it('INTENSIVO fuera de la ventana flexible NO genera FLEX_RANGE', () => {
    const entries: EntryLike[] = [
      { userId: 'u1', date: '2026-07-06', status: 'INTENSIVO', startTime: '06:00', endTime: '14:00' }, // fuera de 07:00-10:30/16:00-19:00
    ];
    const alerts = validate(schedule, entries, cfg, null, {});
    expect(alertsOfType(alerts, 'FLEX_RANGE')).toHaveLength(0);
  });

  it('PRESENCIAL fuera de la ventana flexible SÍ genera FLEX_RANGE (WARNING)', () => {
    const entries: EntryLike[] = [
      { userId: 'u1', date: '2026-07-06', status: 'PRESENCIAL', startTime: '06:00', endTime: '14:00' },
    ];
    const alerts = validate(schedule, entries, cfg, null, {});
    const flex = alertsOfType(alerts, 'FLEX_RANGE');
    expect(flex).toHaveLength(1);
    expect(flex[0].severity).toBe('WARNING');
  });

  it('TELETRABAJO fuera de la ventana flexible SÍ genera FLEX_RANGE', () => {
    const entries: EntryLike[] = [
      { userId: 'u1', date: '2026-07-06', status: 'TELETRABAJO', startTime: '06:00', endTime: '14:00' },
    ];
    const alerts = validate(schedule, entries, cfg, null, {});
    expect(alertsOfType(alerts, 'FLEX_RANGE')).toHaveLength(1);
  });
});

// ─── v3.5.11 ───────────────────────────────────────────────────────────────

describe('INTENSIVO_TELETRABAJO (v3.5.11)', () => {
  it('no deduce descanso, igual que INTENSIVO', () => {
    const e: EntryLike = { userId: 'u1', date: '2026-07-10', status: 'INTENSIVO_TELETRABAJO', startTime: '08:00', endTime: '14:00' };
    expect(computeNetHours(e, cfg, false)).toBeCloseTo(6.0, 5);
    // El mismo tramo como PRESENCIAL sí descuenta la hora de descanso.
    expect(computeNetHours({ ...e, status: 'PRESENCIAL' }, cfg, false)).toBeCloseTo(5.0, 5);
  });

  it('no genera FLEX_RANGE (jornada continua con horario propio)', () => {
    const entries: EntryLike[] = [
      { userId: 'u1', date: '2026-07-06', status: 'INTENSIVO_TELETRABAJO', startTime: '06:00', endTime: '14:00' },
    ];
    expect(alertsOfType(validate(schedule, entries, cfg, null, {}), 'FLEX_RANGE')).toHaveLength(0);
  });

  it('cuenta como viernes intensivo para WEEKLY_HOURS', () => {
    // v3.5.13 — con el objetivo calculado como suma de días planificados, una
    // semana que solo tiene el viernes planificado vale su propio objetivo (6h)
    // y no dispara nada por sí sola; se añaden Lun-Jue por debajo de su jornada
    // contratada para que la semana sí quede corta y demostrar que
    // INTENSIVO_TELETRABAJO cuenta como "viernes intensivo" (sin lo cual la
    // alerta WEEKLY_HOURS ni siquiera se evalúa).
    const entries: EntryLike[] = [
      { userId: 'u1', date: '2026-07-06', status: 'PRESENCIAL', startTime: '08:00', endTime: '14:00' }, // Mon net 5h
      { userId: 'u1', date: '2026-07-07', status: 'PRESENCIAL', startTime: '08:00', endTime: '14:00' }, // Tue net 5h
      { userId: 'u1', date: '2026-07-08', status: 'PRESENCIAL', startTime: '08:00', endTime: '14:00' }, // Wed net 5h
      { userId: 'u1', date: '2026-07-09', status: 'PRESENCIAL', startTime: '08:00', endTime: '14:00' }, // Thu net 5h
      { userId: 'u1', date: '2026-07-10', status: 'INTENSIVO_TELETRABAJO', startTime: '08:00', endTime: '14:00' }, // Fri 6h
    ];
    const weekly = alertsOfType(validate(schedule, entries, cfg, null, {}), 'WEEKLY_HOURS');
    expect(weekly).toHaveLength(1); // 26h < 38h de objetivo (4x8+6)
  });
});

describe('resolveTeleworkCap (v3.5.11)', () => {
  it('sin override -> tope del departamento', () => {
    expect(resolveTeleworkCap(undefined, 10, 2026, 7)).toBe(10);
    expect(resolveTeleworkCap({ teleworkFull: false, teleworkQuotaDays: null, teleworkQuotaPct: null }, 10, 2026, 7)).toBe(10);
  });

  it('teleworkFull -> exento (null), aunque haya días/porcentaje fijados', () => {
    expect(resolveTeleworkCap({ teleworkFull: true, teleworkQuotaDays: 3, teleworkQuotaPct: 20 }, 10, 2026, 7)).toBeNull();
  });

  it('días manda sobre porcentaje', () => {
    expect(resolveTeleworkCap({ teleworkFull: false, teleworkQuotaDays: 4, teleworkQuotaPct: 90 }, 10, 2026, 7)).toBe(4);
  });

  it('porcentaje se calcula sobre los días L-V del mes natural', () => {
    // Julio 2026 tiene 23 días laborables -> 50% = 11.5 -> redondea a 12.
    expect(workingDaysInMonth(2026, 7)).toBe(23);
    expect(resolveTeleworkCap({ teleworkFull: false, teleworkQuotaDays: null, teleworkQuotaPct: 50 }, 10, 2026, 7)).toBe(12);
  });
});

describe('TELEWORK_QUOTA con cuota por usuario (v3.5.11)', () => {
  const entries: EntryLike[] = [
    { userId: 'u1', date: '2026-07-06', status: 'TELETRABAJO', startTime: '08:00', endTime: '17:00' },
  ];

  it('el trabajador 100% teletrabajo nunca dispara la alerta', () => {
    const alerts = validate(schedule, entries, cfg, null, { u1: 22 }, {}, {
      u1: { teleworkFull: true, teleworkQuotaDays: null, teleworkQuotaPct: null },
    });
    expect(alertsOfType(alerts, 'TELEWORK_QUOTA')).toHaveLength(0);
  });

  it('un tope propio en días sustituye al del departamento', () => {
    const quota = { u1: { teleworkFull: false, teleworkQuotaDays: 2, teleworkQuotaPct: null } };
    // 3 días > tope propio de 2, aunque el tope del departamento (10) no se supere.
    const alerts = validate(schedule, entries, cfg, null, { u1: 3 }, {}, quota);
    const fired = alertsOfType(alerts, 'TELEWORK_QUOTA');
    expect(fired).toHaveLength(1);
    expect(fired[0].message).toContain('(2)');
  });
});

describe('PRESENCE_PCT — cobertura por solape (v3.5.11)', () => {
  // Configuración real de producción que provocaba el fallo: franja núcleo de
  // 9h que ninguna jornada de ~8.5h puede contener por completo.
  const wideCfg: ValidationConfig = { ...cfg, presenceStart: '09:00', presenceEnd: '18:00' };

  it('una jornada que solapa la franja cuenta como presente (antes: siempre 0.0%)', () => {
    const entries: EntryLike[] = [
      { userId: 'u1', date: '2026-07-06', status: 'PRESENCIAL', startTime: '07:30', endTime: '16:00' },
      { userId: 'u2', date: '2026-07-06', status: 'PRESENCIAL', startTime: '09:00', endTime: '17:30' },
    ];
    expect(alertsOfType(validate(schedule, entries, wideCfg, null, {}), 'PRESENCE_PCT')).toHaveLength(0);
  });

  it('los ausentes salen del denominador: 1 presente + 3 de vacaciones = 100%', () => {
    const entries: EntryLike[] = [
      { userId: 'u1', date: '2026-07-06', status: 'PRESENCIAL', startTime: '08:00', endTime: '16:30' },
      { userId: 'u2', date: '2026-07-06', status: 'VACACIONES' },
      { userId: 'u3', date: '2026-07-06', status: 'BAJA_MEDICA' },
      { userId: 'u4', date: '2026-07-06', status: 'VIAJE' },
    ];
    expect(alertsOfType(validate(schedule, entries, wideCfg, null, {}), 'PRESENCE_PCT')).toHaveLength(0);
  });

  it('una semana recién creada (PRESENCIAL sin horas) no reporta 0%', () => {
    const entries: EntryLike[] = [
      { userId: 'u1', date: '2026-07-06', status: 'PRESENCIAL' },
      { userId: 'u2', date: '2026-07-06', status: 'PRESENCIAL' },
    ];
    expect(alertsOfType(validate(schedule, entries, wideCfg, null, {}), 'PRESENCE_PCT')).toHaveLength(0);
  });

  it('sigue avisando cuando la presencialidad real es insuficiente', () => {
    const entries: EntryLike[] = [
      { userId: 'u1', date: '2026-07-06', status: 'PRESENCIAL', startTime: '08:00', endTime: '16:30' },
      { userId: 'u2', date: '2026-07-06', status: 'TELETRABAJO', startTime: '08:00', endTime: '16:30' },
      { userId: 'u3', date: '2026-07-06', status: 'TELETRABAJO', startTime: '08:00', endTime: '16:30' },
    ];
    const fired = alertsOfType(validate(schedule, entries, wideCfg, null, {}), 'PRESENCE_PCT');
    expect(fired).toHaveLength(1);
    expect(fired[0].message).toContain('33.3%');
  });

  it('un día enteramente de vacaciones no genera alerta (denominador 0)', () => {
    const entries: EntryLike[] = [
      { userId: 'u1', date: '2026-07-06', status: 'VACACIONES' },
      { userId: 'u2', date: '2026-07-06', status: 'VACACIONES' },
    ];
    expect(alertsOfType(validate(schedule, entries, wideCfg, null, {}), 'PRESENCE_PCT')).toHaveLength(0);
  });
});

// ─── v3.5.12 — FESTIVO/FESTIVO_LOCAL + effective weekly target ─────────────

describe('FESTIVO/FESTIVO_LOCAL (v3.5.12)', () => {
  it('no cuentan como horas trabajadas, igual que VACACIONES', () => {
    const festivo: EntryLike = { userId: 'u1', date: '2026-07-06', status: 'FESTIVO' };
    const festivoLocal: EntryLike = { userId: 'u1', date: '2026-07-07', status: 'FESTIVO_LOCAL' };
    expect(computeNetHours(festivo, cfg, false)).toBe(0);
    expect(computeNetHours(festivoLocal, cfg, false)).toBe(0);
  });

  it('un día entero de FESTIVO no genera PRESENCE_PCT (fuera del denominador)', () => {
    const entries: EntryLike[] = [
      { userId: 'u1', date: '2026-07-06', status: 'FESTIVO' },
      { userId: 'u2', date: '2026-07-06', status: 'FESTIVO_LOCAL' },
    ];
    expect(alertsOfType(validate(schedule, entries, cfg, null, {}), 'PRESENCE_PCT')).toHaveLength(0);
  });
});

describe('computeEffectiveWeeklyTarget (v3.5.13 — suma de días planificados)', () => {
  // Configuración real del departamento Security en producción: 8h L-J, 6h
  // viernes, objetivo semanal declarado 40h. La suma de días contratados es 38,
  // y ese descuadre de 2h es exactamente el defecto que esto corrige: una
  // semana entera de vacaciones mostraba "0.0h / 2.0h" en vez de "0.0h / 0.0h".
  const week = (statuses: string[]) =>
    statuses.map((status, i) => ({
      userId: 'u1',
      date: `2026-08-${String(24 + i).padStart(2, '0')}`, // lunes 24 → viernes 28 de agosto de 2026
      status,
    }));

  it('semana entera de vacaciones da exactamente 0, no el residuo de 2h', () => {
    const entries = week(['VACACIONES', 'VACACIONES', 'VACACIONES', 'VACACIONES', 'VACACIONES']);
    expect(computeEffectiveWeeklyTarget(entries, cfg, false, null)).toBe(0);
  });

  it('semana normal completa vale la suma de días contratados (38), no el objetivo plano (40)', () => {
    const entries = week(['PRESENCIAL', 'PRESENCIAL', 'PRESENCIAL', 'PRESENCIAL', 'PRESENCIAL']);
    expect(computeEffectiveWeeklyTarget(entries, cfg, false, null)).toBe(38);
  });

  it('un viernes FESTIVO descuenta las horas del viernes, no las de un día cualquiera', () => {
    const entries = week(['PRESENCIAL', 'PRESENCIAL', 'PRESENCIAL', 'PRESENCIAL', 'FESTIVO']);
    expect(computeEffectiveWeeklyTarget(entries, cfg, false, null)).toBe(32);
  });

  it('un lunes de VACACIONES descuenta un día normal de invierno', () => {
    const entries = week(['VACACIONES', 'PRESENCIAL', 'PRESENCIAL', 'PRESENCIAL', 'PRESENCIAL']);
    expect(computeEffectiveWeeklyTarget(entries, cfg, false, null)).toBe(30); // 38 - 8
  });

  it('BAJA_MEDICA sigue contando como déficit contra el objetivo (no lo reduce)', () => {
    const entries = week(['BAJA_MEDICA', 'PRESENCIAL', 'PRESENCIAL', 'PRESENCIAL', 'PRESENCIAL']);
    expect(computeEffectiveWeeklyTarget(entries, cfg, false, null)).toBe(38);
  });

  it('un override por trabajador se escala en proporción a los días planificados', () => {
    // Media jornada pactada: 19h semanales sobre una semana nominal de 38h.
    const full = week(['PRESENCIAL', 'PRESENCIAL', 'PRESENCIAL', 'PRESENCIAL', 'PRESENCIAL']);
    expect(computeEffectiveWeeklyTarget(full, cfg, false, 19)).toBe(19);
    const fridayOff = week(['PRESENCIAL', 'PRESENCIAL', 'PRESENCIAL', 'PRESENCIAL', 'VACACIONES']);
    // 19 * (32/38) = 16
    expect(computeEffectiveWeeklyTarget(fridayOff, cfg, false, 19)).toBe(16);
  });

  it('una semana sin ninguna entrada planificada vale 0 (no hay override)', () => {
    expect(computeEffectiveWeeklyTarget([], cfg, false, null)).toBe(0);
  });

  it('usa las horas de verano cuando isSummer=true', () => {
    const summerCfg: ValidationConfig = { ...cfg, summerDailyNetHours: 7.5 };
    const entries = week(['PRESENCIAL', 'PRESENCIAL', 'PRESENCIAL', 'PRESENCIAL', 'FESTIVO']);
    expect(computeEffectiveWeeklyTarget(entries, summerCfg, true, null)).toBeCloseTo(4 * 7.5, 5);
  });
});

describe('computeDailyTargetHours (v3.5.13)', () => {
  const week = (statuses: string[]) =>
    statuses.map((status, i) => ({ userId: 'u1', date: `2026-08-${String(24 + i).padStart(2, '0')}`, status }));

  it('reparte el objetivo entre los días efectivamente planificados, no siempre entre 5', () => {
    // 4 días de vacaciones + 1 presencial: el único día que se trabaja son 8h,
    // no 8/5 = 1.6h (que es lo que hacía el autorrelleno anterior).
    const entries = week(['VACACIONES', 'VACACIONES', 'VACACIONES', 'VACACIONES', 'PRESENCIAL']);
    expect(computeDailyTargetHours(entries, cfg, false, null)).toBe(6); // viernes
  });

  it('sin días planificados cae a la jornada diaria de invierno', () => {
    expect(computeDailyTargetHours([], cfg, false, null)).toBe(8);
  });
});

describe('WEEKLY_HOURS con el objetivo de v3.5.13 (regresión)', () => {
  it('un FESTIVO en lunes evita el WEEKLY_HOURS que antes disparaba con el objetivo plano (regresión)', () => {
    // Semana con lunes festivo + viernes intensivo: antes de v3.5.12 el
    // objetivo era siempre 40h planas, así que esta semana (32h trabajadas)
    // disparaba WEEKLY_HOURS por debajo del objetivo aunque el festivo la
    // justifique por completo. Con el objetivo efectivo (40 - 8 = 32), no.
    const entries: EntryLike[] = [
      { userId: 'u1', date: '2026-07-06', status: 'FESTIVO' }, // Mon, 0h
      { userId: 'u1', date: '2026-07-07', status: 'PRESENCIAL', startTime: '08:00', endTime: '18:00' }, // Tue 9h
      { userId: 'u1', date: '2026-07-08', status: 'PRESENCIAL', startTime: '08:00', endTime: '18:00' }, // Wed 9h
      { userId: 'u1', date: '2026-07-09', status: 'PRESENCIAL', startTime: '08:00', endTime: '17:00' }, // Thu 8h
      { userId: 'u1', date: '2026-07-10', status: 'INTENSIVO', startTime: '08:00', endTime: '14:00' },  // Fri 6h
    ];
    const alerts = validate(schedule, entries, cfg, null, {});
    expect(alertsOfType(alerts, 'WEEKLY_HOURS')).toHaveLength(0);
  });

  it('el mismo caso con BAJA_MEDICA en vez de FESTIVO sigue disparando WEEKLY_HOURS', () => {
    const entries: EntryLike[] = [
      { userId: 'u1', date: '2026-07-06', status: 'BAJA_MEDICA' }, // no reduce el objetivo
      { userId: 'u1', date: '2026-07-07', status: 'PRESENCIAL', startTime: '08:00', endTime: '18:00' },
      { userId: 'u1', date: '2026-07-08', status: 'PRESENCIAL', startTime: '08:00', endTime: '18:00' },
      { userId: 'u1', date: '2026-07-09', status: 'PRESENCIAL', startTime: '08:00', endTime: '17:00' },
      { userId: 'u1', date: '2026-07-10', status: 'INTENSIVO', startTime: '08:00', endTime: '14:00' },
    ];
    const alerts = validate(schedule, entries, cfg, null, {});
    expect(alertsOfType(alerts, 'WEEKLY_HOURS')).toHaveLength(1);
  });
});

describe('service.maskEntryForViewer (GDPR Art. 9)', () => {
  const bajaEntry = { userId: 'owner-1', status: 'BAJA_MEDICA', startTime: null, endTime: null, notes: 'confidential note' };

  it('masks BAJA_MEDICA for an unrelated AUDITOR viewer', () => {
    const result = maskEntryForViewer(bajaEntry, { id: 'viewer-2', role: 'AUDITOR' });
    expect(result.status).toBe('AUSENTE');
    expect(result.healthMasked).toBe(true);
    expect(result.notes).toBeNull();
  });

  it('does NOT mask BAJA_MEDICA for the entry owner', () => {
    const result = maskEntryForViewer(bajaEntry, { id: 'owner-1', role: 'AUDITOR' });
    expect(result.status).toBe('BAJA_MEDICA');
    expect(result.healthMasked).toBe(false);
  });

  it('does NOT mask BAJA_MEDICA for ADMIN', () => {
    const result = maskEntryForViewer(bajaEntry, { id: 'admin-1', role: 'ADMIN' });
    expect(result.status).toBe('BAJA_MEDICA');
    expect(result.healthMasked).toBe(false);
  });

  it('passes non-health statuses through unchanged for any viewer', () => {
    const entry = { userId: 'owner-1', status: 'TELETRABAJO', startTime: '08:00', endTime: '17:00', notes: null };
    const result = maskEntryForViewer(entry, { id: 'viewer-2', role: 'AUDITOR' });
    expect(result.status).toBe('TELETRABAJO');
    expect(result.healthMasked).toBe(false);
  });
});

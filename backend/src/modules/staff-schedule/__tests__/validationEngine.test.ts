import { validate, ValidationConfig, EntryLike, ScheduleLike, computeNetHours } from '../validationEngine';
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

  it('(b) intensive Friday but week total 38h -> WEEKLY_HOURS ERROR', () => {
    const entries: EntryLike[] = [
      { userId: 'u1', date: '2026-07-06', status: 'PRESENCIAL', startTime: '08:00', endTime: '18:00' }, // Mon 9h
      { userId: 'u1', date: '2026-07-07', status: 'PRESENCIAL', startTime: '08:00', endTime: '18:00' }, // Tue 9h
      { userId: 'u1', date: '2026-07-08', status: 'PRESENCIAL', startTime: '08:00', endTime: '17:00' }, // Wed 8h
      { userId: 'u1', date: '2026-07-09', status: 'PRESENCIAL', startTime: '07:00', endTime: '14:00' }, // Thu net 6h
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

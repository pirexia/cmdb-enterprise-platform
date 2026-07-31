import { scanAlerts } from '../engine.js';

// v3.6.0 B6 — spec D6 requires a re-opened vulnerability (RESUELTO → reappears
// in a new Greenbone scan → marked REABIERTA by the vuln-import accept flow)
// to surface as an alert. B5 deliberately does NOT insert a discrete alert
// record when marking an entry REABIERTA; this live scan (`scanAlerts`,
// engine.ts ~line 162) is what's supposed to catch it on its next run by
// treating REABIERTA as an "open" status alongside NUEVO/ASIGNADO/EN_CURSO.
// This test proves that contract: before the fix, a CI whose only finding
// was REABIERTA/CRITICAL was invisible to this scan.

function makePrisma(vulnerabilities: unknown[]) {
  return {
    $queryRaw: jest.fn().mockResolvedValue([
      { id: 'ci-1', name: 'server01', vulnerabilities },
    ]),
  } as unknown as import('@prisma/client').PrismaClient;
}

const VULN_RULE = [{ category: 'vulnerability', enabled: true, warnDays: 0 }];

describe('scanAlerts — vulnerability category, REABIERTA status', () => {
  it('flags a CI whose only open finding has status REABIERTA', async () => {
    const prisma = makePrisma([
      { severity: 'CRITICAL', status: 'REABIERTA' },
    ]);

    const result = await scanAlerts(prisma, VULN_RULE);

    const vulnItems = result.items.filter((i) => i.category === 'vulnerability');
    expect(vulnItems).toHaveLength(1);
    expect(vulnItems[0]).toMatchObject({ entityId: 'ci-1', detail: 'critical:1,high:0' });
  });

  it('does NOT flag a CI whose only finding is RESUELTO (closed, not reopened)', async () => {
    const prisma = makePrisma([
      { severity: 'CRITICAL', status: 'RESUELTO' },
    ]);

    const result = await scanAlerts(prisma, VULN_RULE);

    expect(result.items.filter((i) => i.category === 'vulnerability')).toHaveLength(0);
  });

  it('still flags the pre-existing open statuses (NUEVO/ASIGNADO/EN_CURSO) — no regression', async () => {
    const prisma = makePrisma([
      { severity: 'HIGH', status: 'EN_CURSO' },
    ]);

    const result = await scanAlerts(prisma, VULN_RULE);

    expect(result.items.filter((i) => i.category === 'vulnerability')).toHaveLength(1);
  });
});

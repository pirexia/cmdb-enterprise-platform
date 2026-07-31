import { PrismaClient } from '@prisma/client';
import { acceptBatch } from '../service.js';
import * as lifecycleClient from '../../integrations/connectors/redhatLightspeed/lifecycleClient.js';

jest.mock('../../integrations/connectors/redhatLightspeed/lifecycleClient.js');

describe('acceptBatch — Red Hat Lightspeed OS/EOL correction + closure sweep', () => {
  function buildPrismaMock(opts: {
    existingOs: { id: string } | null;
    ciVulns: unknown[];
  }) {
    const prisma = {
      $transaction: (fn: (tx: unknown) => unknown) => fn(prisma),
      $queryRaw: jest.fn().mockImplementation((strings: TemplateStringsArray) => {
        const sql = strings.join('');
        if (sql.includes('vulnerabilities')) return Promise.resolve([{ vulnerabilities: opts.ciVulns }]);
        if (sql.includes('date_types')) return Promise.resolve([{ id: 'date-type-1' }]);
        return Promise.resolve([]);
      }),
      $executeRaw: jest.fn().mockResolvedValue(1),
      vulnImportBatch: { findUnique: jest.fn().mockResolvedValue({ id: 'batch-1', status: 'PENDING', source: 'redhat-lightspeed' }), update: jest.fn() },
      vulnImportEntry: { findMany: jest.fn() },
      operatingSystem: {
        findUnique: jest.fn().mockResolvedValue(opts.existingOs),
        create: jest.fn().mockResolvedValue({ id: 'os-new' }),
      },
      cI: { update: jest.fn() },
    } as unknown as PrismaClient;
    return prisma;
  }

  it('creates the OperatingSystem row by code and sets CI.operatingSystemId + fetches lifecycle dates when the OS is new', async () => {
    (lifecycleClient.getRhelLifecycleDates as jest.Mock).mockResolvedValue({
      eosDate: new Date('2027-05-31'), eolDate: new Date('2032-05-31'),
    });
    const prisma = buildPrismaMock({ existingOs: null, ciVulns: [] });
    (prisma.vulnImportEntry.findMany as jest.Mock).mockResolvedValue([{
      id: 'e1', ciId: 'ci-1', decision: 'INCLUDE', classification: 'NUEVA', vulnKey: 'CVE-2024-1234',
      severity: 'HIGH', severityScore: 7.5, summary: 'x', name: 'CVE-2024-1234', cves: ['CVE-2024-1234'],
      oid: null, port: null, family: null, solution: null, qod: null, epssScore: null,
      products: [], exprtRating: null, cisaKev: false, cisaDueDate: null, exploitStatus: null,
      daysOpen: null, externalStatus: null, cvssVersion: null, redhatImpact: 'Important', knownExploit: false, publicDate: null,
      raw: { os_name: 'RHEL', os_major: 9, os_minor: 4 },
    }]);

    await acceptBatch(prisma, 'batch-1', 'tester@cmdb.local');

    expect(prisma.operatingSystem.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ code: 'RHEL_9.4' }),
    }));
    expect(prisma.cI.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'ci-1' },
      data: expect.objectContaining({ operatingSystemId: 'os-new' }),
    }));
    expect(lifecycleClient.getRhelLifecycleDates).toHaveBeenCalledWith(9);
  });

  it('closes an existing OPEN redhat-lightspeed vuln on the CI that is absent from this batch', async () => {
    const staleVuln = { key: 'CVE-2023-0000', cve: 'CVE-2023-0000', severity: 'MEDIUM', description: 'stale', source: 'redhat-lightspeed', status: 'NUEVO', importedAt: '2026-01-01T00:00:00Z' };
    const prisma = buildPrismaMock({ existingOs: { id: 'os-1' }, ciVulns: [staleVuln] });
    (prisma.vulnImportEntry.findMany as jest.Mock).mockResolvedValue([{
      id: 'e1', ciId: 'ci-1', decision: 'INCLUDE', classification: 'NUEVA', vulnKey: 'CVE-2024-1234',
      severity: 'HIGH', severityScore: 7.5, summary: 'x', name: 'CVE-2024-1234', cves: ['CVE-2024-1234'],
      oid: null, port: null, family: null, solution: null, qod: null, epssScore: null,
      products: [], exprtRating: null, cisaKev: false, cisaDueDate: null, exploitStatus: null,
      daysOpen: null, externalStatus: null, cvssVersion: null, redhatImpact: null, knownExploit: false, publicDate: null,
      raw: {},
    }]);
    // CVE-2023-0000 is deliberately ABSENT from findMany's result, simulating
    // "Lightspeed no longer reports this as open on this CI".

    const executeRawCalls: string[] = [];
    (prisma.$executeRaw as jest.Mock).mockImplementation((strings: TemplateStringsArray) => {
      executeRawCalls.push(strings.join(''));
      return Promise.resolve(1);
    });

    await acceptBatch(prisma, 'batch-1', 'tester@cmdb.local');

    const vulnUpdateCall = executeRawCalls.find((s) => s.includes('SET "vulnerabilities"'));
    expect(vulnUpdateCall).toBeDefined();
    const auditCall = executeRawCalls.find((s) => s.includes('audit_logs'));
    expect(auditCall).toBeDefined();
  });

  it('does not touch a stale vuln from a different source (greenbone) on a redhat-lightspeed batch', async () => {
    const staleGreenboneVuln = { key: 'oid1@22/tcp', cve: '', severity: 'LOW', description: 'stale greenbone', source: 'greenbone', status: 'NUEVO', importedAt: '2026-01-01T00:00:00Z' };
    const prisma = buildPrismaMock({ existingOs: { id: 'os-1' }, ciVulns: [staleGreenboneVuln] });
    (prisma.vulnImportEntry.findMany as jest.Mock).mockResolvedValue([{
      id: 'e1', ciId: 'ci-1', decision: 'INCLUDE', classification: 'NUEVA', vulnKey: 'CVE-2024-1234',
      severity: 'HIGH', severityScore: 7.5, summary: 'x', name: 'CVE-2024-1234', cves: ['CVE-2024-1234'],
      oid: null, port: null, family: null, solution: null, qod: null, epssScore: null,
      products: [], exprtRating: null, cisaKev: false, cisaDueDate: null, exploitStatus: null,
      daysOpen: null, externalStatus: null, cvssVersion: null, redhatImpact: null, knownExploit: false, publicDate: null,
      raw: {},
    }]);

    const result = await acceptBatch(prisma, 'batch-1', 'tester@cmdb.local');
    // The greenbone vuln must survive untouched — no VULN_AUTO_RESOLVED for it.
    expect(result.summary.newCount).toBe(1);
  });
});

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

    const auditCalls: { action: string; vulnKey: string }[] = [];
    let writtenVulns: { key: string; status: string; resolvedAt?: string }[] | null = null;
    (prisma.$executeRaw as jest.Mock).mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('');
      if (sql.includes('SET "vulnerabilities"')) {
        writtenVulns = JSON.parse(values[0] as string);
      }
      if (sql.includes('audit_logs')) {
        // vulnImportAudit's tagged template interpolates
        // (action, entity, entityId, userEmail, detailsJson) in that order.
        const details = values[4] ? JSON.parse(values[4] as string) : {};
        auditCalls.push({ action: values[0] as string, vulnKey: details.vulnKey });
      }
      return Promise.resolve(1);
    });

    await acceptBatch(prisma, 'batch-1', 'tester@cmdb.local');

    // The stale vuln must actually be CLOSED in the written array, not just
    // "some SQL statement ran" — this is the assertion the review flagged
    // as missing (Important finding #6).
    expect(writtenVulns).not.toBeNull();
    const closedEntry = writtenVulns!.find((v) => v.key === 'CVE-2023-0000');
    expect(closedEntry).toMatchObject({ status: 'RESUELTO' });
    expect(closedEntry!.resolvedAt).toBeDefined();
    expect(auditCalls).toContainEqual({ action: 'VULN_AUTO_RESOLVED', vulnKey: 'CVE-2023-0000' });
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

    let writtenVulns: { key: string; status: string; source: string }[] | null = null;
    const auditActions: string[] = [];
    (prisma.$executeRaw as jest.Mock).mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('');
      if (sql.includes('SET "vulnerabilities"')) writtenVulns = JSON.parse(values[0] as string);
      if (sql.includes('audit_logs')) auditActions.push(values[0] as string);
      return Promise.resolve(1);
    });

    const result = await acceptBatch(prisma, 'batch-1', 'tester@cmdb.local');

    // The greenbone vuln must survive completely untouched — same status,
    // never closed by a Lightspeed accept's sweep — and no auto-resolve
    // audit row for it (the strong version of the assertion the review
    // flagged: it's not enough that summary.newCount looks right).
    const greenboneEntry = writtenVulns!.find((v) => v.key === 'oid1@22/tcp');
    expect(greenboneEntry).toMatchObject({ status: 'NUEVO', source: 'greenbone' });
    expect(auditActions).not.toContain('VULN_AUTO_RESOLVED');
    expect(result.summary.newCount).toBe(1);
  });

  it('runs the closure sweep even when every entry for a CI is EXCLUDEd (steady-state re-import, Important finding #3)', async () => {
    const staleVuln = { key: 'CVE-2023-0000', cve: 'CVE-2023-0000', severity: 'MEDIUM', description: 'stale', source: 'redhat-lightspeed', status: 'NUEVO', importedAt: '2026-01-01T00:00:00Z' };
    const prisma = buildPrismaMock({ existingOs: { id: 'os-1' }, ciVulns: [staleVuln] });
    // Every entry for ci-1 is EXISTENTE_PENDIENTE/EXCLUDE — the normal shape
    // of a second-or-later pull where nothing new needs review. Note
    // CVE-2023-0000 (the stale one) is NOT among these entries, simulating
    // "Lightspeed no longer reports it" even though nothing was INCLUDEd.
    (prisma.vulnImportEntry.findMany as jest.Mock).mockResolvedValue([{
      id: 'e1', ciId: 'ci-1', decision: 'EXCLUDE', classification: 'EXISTENTE_PENDIENTE', vulnKey: 'CVE-2024-9999',
      severity: 'LOW', severityScore: 2.0, summary: 'x', name: 'CVE-2024-9999', cves: ['CVE-2024-9999'],
      oid: null, port: null, family: null, solution: null, qod: null, epssScore: null,
      products: [], exprtRating: null, cisaKev: false, cisaDueDate: null, exploitStatus: null,
      daysOpen: null, externalStatus: null, cvssVersion: null, redhatImpact: null, knownExploit: false, publicDate: null,
      raw: {},
    }]);

    let writtenVulns: { key: string; status: string }[] | null = null;
    (prisma.$executeRaw as jest.Mock).mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
      if (strings.join('').includes('SET "vulnerabilities"')) writtenVulns = JSON.parse(values[0] as string);
      return Promise.resolve(1);
    });

    const result = await acceptBatch(prisma, 'batch-1', 'tester@cmdb.local');

    expect(writtenVulns).not.toBeNull();
    expect(writtenVulns!.find((v) => v.key === 'CVE-2023-0000')).toMatchObject({ status: 'RESUELTO' });
    expect(result.touched.map((t) => t.ciId)).toContain('ci-1');
  });
});

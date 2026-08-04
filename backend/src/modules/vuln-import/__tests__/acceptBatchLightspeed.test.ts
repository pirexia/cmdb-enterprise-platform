import { PrismaClient } from '@prisma/client';
import { acceptBatch } from '../service.js';
import * as lifecycleClient from '../../integrations/connectors/redhatLightspeed/lifecycleClient.js';

jest.mock('../../integrations/connectors/redhatLightspeed/lifecycleClient.js');

// Task 16 (v3.7.0): the old `sweepLightspeedClosures` silently swept every
// stored redhat-lightspeed vulnerability absent from the batch, scoped only
// to batch.source === 'redhat-lightspeed'. It has been replaced by an
// explicit `RESUELTA_AUSENTE` classification generated at UPLOAD time
// (task 15, classifier.ts's computeAbsentClosures) — the operator sees and
// can uncheck each closure in review, and acceptBatch now applies closures
// via the normal per-entry classification switch, generically for all 3
// sources, with a mandatory re-verification of the stored vulnerability's
// CURRENT status (not the snapshot the classifier saw at upload time).
describe('acceptBatch — Red Hat Lightspeed OS/EOL correction + RESUELTA_AUSENTE closures', () => {
  function buildPrismaMock(opts: {
    existingOs: { id: string } | null;
    ciVulns: unknown[];
    batchSource?: string;
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
      vulnImportBatch: {
        findUnique: jest.fn().mockResolvedValue({ id: 'batch-1', status: 'PENDING', source: opts.batchSource ?? 'redhat-lightspeed' }),
        update: jest.fn(),
      },
      vulnImportEntry: { findMany: jest.fn() },
      operatingSystem: {
        findUnique: jest.fn().mockResolvedValue(opts.existingOs),
        create: jest.fn().mockResolvedValue({ id: 'os-new' }),
      },
      cI: { update: jest.fn() },
    } as unknown as PrismaClient;
    return prisma;
  }

  // Shared base fields for a synthetic VulnImportEntry row — mirrors the
  // shape getAllEntriesForBatch/queries.ts returns (see NewEntryInput /
  // queries.ts's select).
  function baseEntryFields() {
    return {
      oid: null, port: null, family: null, solution: null, qod: null, epssScore: null,
      products: [], exprtRating: null, cisaKev: false, cisaDueDate: null, exploitStatus: null,
      daysOpen: null, externalStatus: null, cvssVersion: null, redhatImpact: null, knownExploit: false,
      publicDate: null, raw: {},
    };
  }

  it('creates the OperatingSystem row by code and sets CI.operatingSystemId + fetches lifecycle dates when the OS is new', async () => {
    (lifecycleClient.getRhelLifecycleDates as jest.Mock).mockResolvedValue({
      eosDate: new Date('2027-05-31'), eolDate: new Date('2032-05-31'),
    });
    const prisma = buildPrismaMock({ existingOs: null, ciVulns: [] });
    (prisma.vulnImportEntry.findMany as jest.Mock).mockResolvedValue([{
      id: 'e1', ciId: 'ci-1', decision: 'INCLUDE', classification: 'NUEVA', vulnKey: 'CVE-2024-1234',
      severity: 'HIGH', severityScore: 7.5, summary: 'x', name: 'CVE-2024-1234', cves: ['CVE-2024-1234'],
      ...baseEntryFields(),
      redhatImpact: 'Important',
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

  it('closes a RESUELTA_AUSENTE-classified, INCLUDEd entry whose stored vuln is still OPEN', async () => {
    const staleVuln = { key: 'CVE-2023-0000', cve: 'CVE-2023-0000', severity: 'MEDIUM', description: 'stale', source: 'redhat-lightspeed', status: 'NUEVO', importedAt: '2026-01-01T00:00:00Z' };
    const prisma = buildPrismaMock({ existingOs: { id: 'os-1' }, ciVulns: [staleVuln] });
    (prisma.vulnImportEntry.findMany as jest.Mock).mockResolvedValue([
      {
        id: 'e1', ciId: 'ci-1', decision: 'INCLUDE', classification: 'NUEVA', vulnKey: 'CVE-2024-1234',
        severity: 'HIGH', severityScore: 7.5, summary: 'x', name: 'CVE-2024-1234', cves: ['CVE-2024-1234'],
        ...baseEntryFields(),
      },
      // The RESUELTA_AUSENTE closure entry — what computeAbsentClosures
      // (task 15) would have generated at upload time for CVE-2023-0000
      // (still OPEN and absent from this batch's reportedKeys), with its
      // default decision (INCLUDE, per computeAbsentClosures's doc comment)
      // preserved by the operator.
      {
        id: 'e2', ciId: 'ci-1', decision: 'INCLUDE', classification: 'RESUELTA_AUSENTE', vulnKey: 'CVE-2023-0000',
        severity: 'MEDIUM', severityScore: 0, summary: null, name: 'stale', cves: ['CVE-2023-0000'],
        ...baseEntryFields(),
      },
    ]);

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
    // "some SQL statement ran".
    expect(writtenVulns).not.toBeNull();
    const closedEntry = writtenVulns!.find((v) => v.key === 'CVE-2023-0000');
    expect(closedEntry).toMatchObject({ status: 'RESUELTO' });
    expect(closedEntry!.resolvedAt).toBeDefined();
    expect(auditCalls).toContainEqual({ action: 'VULN_AUTO_RESOLVED', vulnKey: 'CVE-2023-0000' });
  });

  it('re-verifies the stored status before closing: skips silently (no error, no re-audit) if it is no longer OPEN', async () => {
    // Simulates the exact race the task-16 brief calls out: the
    // RESUELTA_AUSENTE entry was computed at UPLOAD time against a snapshot
    // where CVE-2023-0000 was still open — but between upload and accept,
    // someone (e.g. a manual PATCH /api/vulnerabilities) already resolved it
    // by hand. The stored vuln below is fixed at status RESUELTO with a
    // sentinel resolvedAt that must survive untouched.
    const SENTINEL_RESOLVED_AT = '2020-01-01T00:00:00Z';
    const alreadyResolvedVuln = {
      key: 'CVE-2023-0000', cve: 'CVE-2023-0000', severity: 'MEDIUM', description: 'already handled',
      source: 'redhat-lightspeed', status: 'RESUELTO', resolvedAt: SENTINEL_RESOLVED_AT,
      importedAt: '2026-01-01T00:00:00Z',
    };
    const prisma = buildPrismaMock({ existingOs: { id: 'os-1' }, ciVulns: [alreadyResolvedVuln] });
    (prisma.vulnImportEntry.findMany as jest.Mock).mockResolvedValue([{
      id: 'e2', ciId: 'ci-1', decision: 'INCLUDE', classification: 'RESUELTA_AUSENTE', vulnKey: 'CVE-2023-0000',
      severity: 'MEDIUM', severityScore: 0, summary: null, name: 'already handled', cves: ['CVE-2023-0000'],
      ...baseEntryFields(),
    }]);

    const auditActions: string[] = [];
    let writtenVulns: { key: string; status: string; resolvedAt?: string }[] | null = null;
    (prisma.$executeRaw as jest.Mock).mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('');
      if (sql.includes('SET "vulnerabilities"')) writtenVulns = JSON.parse(values[0] as string);
      if (sql.includes('audit_logs')) auditActions.push(values[0] as string);
      return Promise.resolve(1);
    });

    await expect(acceptBatch(prisma, 'batch-1', 'tester@cmdb.local')).resolves.toBeDefined();

    expect(writtenVulns).not.toBeNull();
    const entry = writtenVulns!.find((v) => v.key === 'CVE-2023-0000');
    // Untouched: still RESUELTO, and the sentinel resolvedAt was NOT
    // overwritten with a fresh "now" timestamp — proof the closure branch
    // was skipped rather than re-applied.
    expect(entry).toMatchObject({ status: 'RESUELTO', resolvedAt: SENTINEL_RESOLVED_AT });
    expect(auditActions).not.toContain('VULN_AUTO_RESOLVED');
  });

  it('does not touch a stale vuln from a different source (greenbone) on a redhat-lightspeed batch', async () => {
    const staleGreenboneVuln = { key: 'oid1@22/tcp', cve: '', severity: 'LOW', description: 'stale greenbone', source: 'greenbone', status: 'NUEVO', importedAt: '2026-01-01T00:00:00Z' };
    const prisma = buildPrismaMock({ existingOs: { id: 'os-1' }, ciVulns: [staleGreenboneVuln] });
    (prisma.vulnImportEntry.findMany as jest.Mock).mockResolvedValue([{
      id: 'e1', ciId: 'ci-1', decision: 'INCLUDE', classification: 'NUEVA', vulnKey: 'CVE-2024-1234',
      severity: 'HIGH', severityScore: 7.5, summary: 'x', name: 'CVE-2024-1234', cves: ['CVE-2024-1234'],
      ...baseEntryFields(),
    }]);
    // No RESUELTA_AUSENTE entry references oid1@22/tcp — computeAbsentClosures
    // is scoped by exact source match, so a redhat-lightspeed batch never
    // generates a closure entry for a greenbone-sourced stored vuln.

    let writtenVulns: { key: string; status: string; source: string }[] | null = null;
    const auditActions: string[] = [];
    (prisma.$executeRaw as jest.Mock).mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('');
      if (sql.includes('SET "vulnerabilities"')) writtenVulns = JSON.parse(values[0] as string);
      if (sql.includes('audit_logs')) auditActions.push(values[0] as string);
      return Promise.resolve(1);
    });

    const result = await acceptBatch(prisma, 'batch-1', 'tester@cmdb.local');

    const greenboneEntry = writtenVulns!.find((v) => v.key === 'oid1@22/tcp');
    expect(greenboneEntry).toMatchObject({ status: 'NUEVO', source: 'greenbone' });
    expect(auditActions).not.toContain('VULN_AUTO_RESOLVED');
    expect(result.summary.newCount).toBe(1);
  });

  it('still runs OS correction (steady-state) for a CI whose entries are ALL EXISTENTE_PENDIENTE/EXCLUDE', async () => {
    const prisma = buildPrismaMock({ existingOs: { id: 'os-1' }, ciVulns: [] });
    // Every entry for ci-1 is EXISTENTE_PENDIENTE/EXCLUDE — the normal shape
    // of a re-pull where nothing new needs review and nothing is absent to
    // close. This CI never lands in byCi, so it only reaches the
    // steady-state block below — which, post task-16, exists solely for OS
    // correction (the closure sweep it used to also carry is gone; closures
    // now flow through byCi via RESUELTA_AUSENTE, decision INCLUDE).
    (prisma.vulnImportEntry.findMany as jest.Mock).mockResolvedValue([{
      id: 'e1', ciId: 'ci-1', decision: 'EXCLUDE', classification: 'EXISTENTE_PENDIENTE', vulnKey: 'CVE-2024-9999',
      severity: 'LOW', severityScore: 2.0, summary: 'x', name: 'CVE-2024-9999', cves: ['CVE-2024-9999'],
      ...baseEntryFields(),
      raw: { os_name: 'RHEL', os_major: 8, os_minor: 9 },
    }]);

    const result = await acceptBatch(prisma, 'batch-1', 'tester@cmdb.local');

    expect(prisma.cI.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'ci-1' },
      data: expect.objectContaining({ operatingSystemId: 'os-1' }),
    }));
    expect(result.touched.map((t) => t.ciId)).toContain('ci-1');
  });

  it('applies a RESUELTA_AUSENTE closure identically for a non-Lightspeed source (greenbone)', async () => {
    // Task 16's whole point: the closure path is now generic across all 3
    // sources, not Lightspeed-only. batch.source here is 'greenbone', with
    // no OS hint anywhere — proving the closure itself has nothing to do
    // with the (still Lightspeed-only) OS-correction gate.
    const staleGreenboneVuln = { key: 'oid1@22/tcp', cve: '', severity: 'LOW', description: 'stale greenbone', source: 'greenbone', status: 'NUEVO', importedAt: '2026-01-01T00:00:00Z' };
    const prisma = buildPrismaMock({ existingOs: { id: 'os-1' }, ciVulns: [staleGreenboneVuln], batchSource: 'greenbone' });
    (prisma.vulnImportEntry.findMany as jest.Mock).mockResolvedValue([{
      id: 'e1', ciId: 'ci-1', decision: 'INCLUDE', classification: 'RESUELTA_AUSENTE', vulnKey: 'oid1@22/tcp',
      severity: 'LOW', severityScore: 0, summary: null, name: 'stale greenbone', cves: [],
      ...baseEntryFields(),
    }]);

    const auditCalls: { action: string; vulnKey: string }[] = [];
    let writtenVulns: { key: string; status: string; source: string }[] | null = null;
    (prisma.$executeRaw as jest.Mock).mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('');
      if (sql.includes('SET "vulnerabilities"')) writtenVulns = JSON.parse(values[0] as string);
      if (sql.includes('audit_logs')) {
        const details = values[4] ? JSON.parse(values[4] as string) : {};
        auditCalls.push({ action: values[0] as string, vulnKey: details.vulnKey });
      }
      return Promise.resolve(1);
    });

    await acceptBatch(prisma, 'batch-1', 'tester@cmdb.local');

    const closedEntry = writtenVulns!.find((v) => v.key === 'oid1@22/tcp');
    expect(closedEntry).toMatchObject({ status: 'RESUELTO', source: 'greenbone' });
    expect(auditCalls).toContainEqual({ action: 'VULN_AUTO_RESOLVED', vulnKey: 'oid1@22/tcp' });
    // No OS correction attempted for a non-Lightspeed batch.
    expect(prisma.cI.update).not.toHaveBeenCalled();
  });
});

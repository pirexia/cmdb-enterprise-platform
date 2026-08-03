import { PrismaClient } from '@prisma/client';
import { runRedHatLightspeedImport, RedHatLightspeedSyncInProgressError } from '../service.js';
import * as tokenClient from '../tokenClient.js';
import * as vulnClient from '../vulnClient.js';
import * as inventoryClient from '../inventoryClient.js';

jest.mock('../tokenClient.js');
jest.mock('../vulnClient.js');
jest.mock('../inventoryClient.js');
jest.mock('../../../vuln-import/matcher.js', () => ({
  matchHost: jest.fn().mockResolvedValue({ confidence: 'UNMATCHED' }),
}));

describe('runRedHatLightspeedImport', () => {
  const prisma = {
    $transaction: jest.fn((fn) => fn(prisma)),
    $queryRaw: jest.fn().mockResolvedValue([]),
    $executeRaw: jest.fn().mockResolvedValue(1),
    vulnImportBatch: {
      create: jest.fn().mockResolvedValue({ id: 'batch-1', uploadedBy: 'tester@cmdb.local' }),
      update: jest.fn().mockResolvedValue({ id: 'batch-1', uploadedBy: 'tester@cmdb.local' }),
    },
    vulnImportEntry: { createMany: jest.fn().mockResolvedValue({ count: 0 }) },
  } as unknown as PrismaClient;

  beforeEach(() => {
    // Background work (Task 4) means `waitForBackgroundWork` below polls the
    // shared `prisma` mock's call history looking for a terminal status
    // update — clear recorded calls (not implementations) between tests so a
    // previous test's finalizeBatch call can't be mistaken for this test's.
    jest.clearAllMocks();
    (prisma.vulnImportBatch.create as jest.Mock).mockResolvedValue({ id: 'batch-1', uploadedBy: 'tester@cmdb.local' });
    (prisma.vulnImportBatch.update as jest.Mock).mockResolvedValue({ id: 'batch-1', uploadedBy: 'tester@cmdb.local' });
    (prisma.vulnImportEntry.createMany as jest.Mock).mockResolvedValue({ count: 0 });
    (prisma.$queryRaw as jest.Mock).mockResolvedValue([]);
    (prisma.$executeRaw as jest.Mock).mockResolvedValue(1);
    process.env.REDHAT_LIGHTSPEED_CLIENT_ID = 'id';
    process.env.REDHAT_LIGHTSPEED_CLIENT_SECRET = 'secret';
    (tokenClient.fetchAccessToken as jest.Mock).mockResolvedValue('tok');
    (vulnClient.listSystems as jest.Mock).mockResolvedValue([
      { inventory_id: 'inv-1', display_name: 'srv-a', os: 'RHEL 9.4', cve_count: 1 },
    ]);
    (vulnClient.listSystemCves as jest.Mock).mockResolvedValue([
      { synopsis: 'CVE-2024-1234', cvss3_score: '7.5', impact: 'Important', known_exploit: false },
    ]);
    (inventoryClient.getHostIdentity as jest.Mock).mockResolvedValue({
      ip: '10.1.2.3', hostname: 'srv-a.example.com', displayName: 'srv-a', osName: 'RHEL', osMajor: 9, osMinor: 4,
    });
  });

  afterEach(() => {
    delete process.env.REDHAT_LIGHTSPEED_CLIENT_ID;
    delete process.env.REDHAT_LIGHTSPEED_CLIENT_SECRET;
  });

  /** Waits for the fire-and-forget background work triggered by
   *  runRedHatLightspeedImport to settle, by polling the mocked
   *  vulnImportBatch.update calls for a terminal status write
   *  (finalizeBatch always ends with a status: 'PENDING' | 'FAILED'
   *  update). Background work here is a handful of resolved-mock promise
   *  hops, so a handful of microtask flushes is enough — no real timers
   *  or sleeps involved. */
  async function waitForBackgroundWork(): Promise<void> {
    const isTerminal = () =>
      (prisma.vulnImportBatch.update as jest.Mock).mock.calls.some(
        ([arg]) => arg.data?.status === 'PENDING' || arg.data?.status === 'FAILED',
      );
    for (let i = 0; i < 50 && !isTerminal(); i++) {
      await Promise.resolve();
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  it('returns {batchId} immediately, without waiting for the background pull to resolve', async () => {
    let releaseListSystems: (() => void) | undefined;
    (vulnClient.listSystems as jest.Mock).mockReturnValue(
      new Promise((resolve) => {
        releaseListSystems = () => resolve([{ inventory_id: 'inv-1', display_name: 'srv-a', os: 'RHEL 9.4', cve_count: 1 }]);
      }),
    );

    const result = await runRedHatLightspeedImport(prisma, 'tester@cmdb.local');
    expect(result).toEqual({ batchId: 'batch-1' });
    expect((result as { summary?: unknown }).summary).toBeUndefined();

    // The background work is still pending — listSystems' mock hasn't
    // resolved yet — so the batch must not have reached a terminal status.
    expect(
      (prisma.vulnImportBatch.update as jest.Mock).mock.calls.some(
        ([arg]) => arg.data?.status === 'PENDING' || arg.data?.status === 'FAILED',
      ),
    ).toBe(false);

    releaseListSystems!();
    await waitForBackgroundWork();
  });

  it('reaches PENDING once the background pull completes, with the unmatched entry written', async () => {
    await runRedHatLightspeedImport(prisma, 'tester@cmdb.local');
    await waitForBackgroundWork();

    const finalizeCall = (prisma.vulnImportBatch.update as jest.Mock).mock.calls.find(
      ([arg]) => arg.data?.status === 'PENDING',
    );
    expect(finalizeCall).toBeDefined();
    expect(prisma.vulnImportEntry.createMany).toHaveBeenCalledTimes(1);
  });

  it('leaves the batch FAILED with errorMessage when the background pull throws', async () => {
    (vulnClient.listSystems as jest.Mock).mockRejectedValue(new Error('lightspeed API unreachable'));

    await runRedHatLightspeedImport(prisma, 'tester@cmdb.local');
    await waitForBackgroundWork();

    const finalizeCall = (prisma.vulnImportBatch.update as jest.Mock).mock.calls.find(
      ([arg]) => arg.data?.status === 'FAILED',
    );
    expect(finalizeCall).toBeDefined();
    expect(finalizeCall![0].data.errorMessage).toBe('lightspeed API unreachable');
  });

  it('rejects a concurrent run with RedHatLightspeedSyncInProgressError, and releases the lock only once the first run\'s background work finishes', async () => {
    let releaseListSystems: (() => void) | undefined;
    (vulnClient.listSystems as jest.Mock).mockReturnValue(
      new Promise((resolve) => {
        releaseListSystems = () => resolve([]);
      }),
    );

    await runRedHatLightspeedImport(prisma, 'tester@cmdb.local');
    await expect(runRedHatLightspeedImport(prisma, 'tester@cmdb.local')).rejects.toThrow(RedHatLightspeedSyncInProgressError);

    releaseListSystems!();
    await waitForBackgroundWork();

    // Lock released — a third call should succeed in creating a new batch.
    (vulnClient.listSystems as jest.Mock).mockResolvedValue([]);
    await expect(runRedHatLightspeedImport(prisma, 'tester@cmdb.local')).resolves.toEqual({ batchId: 'batch-1' });
    await waitForBackgroundWork();
  });

  it('refreshes the access token before each system, not just once at the start (live verification: a real 105-system pull outlived a single token\'s lifetime)', async () => {
    (vulnClient.listSystems as jest.Mock).mockResolvedValue([
      { inventory_id: 'inv-1', display_name: 'srv-a', os: 'RHEL 9.4', cve_count: 1 },
      { inventory_id: 'inv-2', display_name: 'srv-b', os: 'RHEL 8.10', cve_count: 1 },
    ]);
    (tokenClient.fetchAccessToken as jest.Mock).mockClear();
    await runRedHatLightspeedImport(prisma, 'tester@cmdb.local');
    await waitForBackgroundWork();
    // One fetch for listSystems + one per system in the loop = 3 total.
    expect(tokenClient.fetchAccessToken).toHaveBeenCalledTimes(3);
  });

  it('carries the inventory identity OS facts + hostname into each entry\'s raw payload, so acceptBatch\'s OS correction has data to read', async () => {
    await runRedHatLightspeedImport(prisma, 'tester@cmdb.local');
    await waitForBackgroundWork();
    const entriesCall = (prisma.vulnImportEntry.createMany as jest.Mock).mock.calls[0][0];
    const entry = entriesCall.data[0];
    expect(entry.raw).toMatchObject({
      synopsis: 'CVE-2024-1234',
      os_name: 'RHEL', os_major: 9, os_minor: 4,
      hostname: 'srv-a.example.com',
    });
  });

  it('releases the lock and propagates the error unchanged when batch-shell creation itself fails (critical fix: no try/catch previously meant the lock leaked forever)', async () => {
    (prisma.vulnImportBatch.create as jest.Mock).mockRejectedValue(new Error('connection pool exhausted'));

    await expect(runRedHatLightspeedImport(prisma, 'tester@cmdb.local')).rejects.toThrow('connection pool exhausted');

    // No background work was ever started (there is no batch to attach it
    // to), so the lock must already be released — a following call must not
    // see RedHatLightspeedSyncInProgressError.
    (prisma.vulnImportBatch.create as jest.Mock).mockResolvedValue({ id: 'batch-1', uploadedBy: 'tester@cmdb.local' });
    (vulnClient.listSystems as jest.Mock).mockResolvedValue([]);
    await expect(runRedHatLightspeedImport(prisma, 'tester@cmdb.local')).resolves.toEqual({ batchId: 'batch-1' });
    await waitForBackgroundWork();
  });

  it('never rejects the background promise, and still releases the lock, when finalizeBatch(FAILED) also fails after the background pull itself already failed (critical fix: previously this was an uncaught rejection able to crash the whole process)', async () => {
    (vulnClient.listSystems as jest.Mock).mockRejectedValue(new Error('lightspeed API unreachable'));
    // Every vulnImportBatch.update call fails — including the finalizeBatch(...,
    // 'FAILED', ...) call inside the catch block of runImportBackground.
    (prisma.vulnImportBatch.update as jest.Mock).mockRejectedValue(new Error('db down during error handling'));
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const result = await runRedHatLightspeedImport(prisma, 'tester@cmdb.local');
    expect(result).toEqual({ batchId: 'batch-1' });

    // Flush microtasks/timers long enough for the background work (which
    // rejects internally) to settle without throwing an unhandled rejection
    // out of the test process.
    for (let i = 0; i < 50; i++) {
      await Promise.resolve();
      await new Promise((resolve) => setImmediate(resolve));
    }

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining(`failed to record FAILED status for batch ${result.batchId}`),
      expect.any(Error),
    );

    // Lock released despite both failures — a following call must succeed.
    (prisma.vulnImportBatch.update as jest.Mock).mockResolvedValue({ id: 'batch-1', uploadedBy: 'tester@cmdb.local' });
    (vulnClient.listSystems as jest.Mock).mockResolvedValue([]);
    await expect(runRedHatLightspeedImport(prisma, 'tester@cmdb.local')).resolves.toEqual({ batchId: 'batch-1' });
    await waitForBackgroundWork();

    consoleErrorSpy.mockRestore();
  });
});

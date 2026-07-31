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
    vulnImportBatch: { create: jest.fn().mockResolvedValue({ id: 'batch-1' }) },
  } as unknown as PrismaClient;

  beforeEach(() => {
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

  it('creates one batch with source redhat-lightspeed and the summary reflects the unmatched entry', async () => {
    const result = await runRedHatLightspeedImport(prisma, 'tester@cmdb.local');
    expect(result.summary.totalEntries).toBe(1);
    expect(result.summary.unmatched).toBe(1);
  });

  it('rejects a concurrent run with RedHatLightspeedSyncInProgressError', async () => {
    const first = runRedHatLightspeedImport(prisma, 'tester@cmdb.local');
    await expect(runRedHatLightspeedImport(prisma, 'tester@cmdb.local')).rejects.toThrow(RedHatLightspeedSyncInProgressError);
    await first;
  });
});

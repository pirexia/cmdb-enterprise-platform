/**
 * T7 documents module — integration tests (mocked Prisma + fs, no real DB/disk).
 * Covers: 401/403 RBAC, CRUD happy-paths, file upload, bulk batches, notes, audit.
 */

const mockQueryRaw    = jest.fn();
const mockExecuteRaw  = jest.fn();
const mockTransaction = jest.fn();
const mockContractCreate = jest.fn();
const mockLicenseCreate  = jest.fn();
const mockEmitHook    = jest.fn().mockResolvedValue(null);
const mockGetContractRoot = jest.fn().mockResolvedValue('root-contract-id-aaaa-000000000000');
const mockGetLicenseRoot  = jest.fn().mockResolvedValue('root-license-id-aaaa-000000000000');
const mockDocVisibilitySqlCol = jest.fn().mockReturnValue('read_admin');
const mockWriteFileSync = jest.fn();
const mockExistsSync    = jest.fn().mockReturnValue(true);
const mockMkdirSync     = jest.fn();
const mockUnlinkSync    = jest.fn();
const mockCopyFileSync  = jest.fn();
const mockOpenSync      = jest.fn().mockReturnValue(3);
const mockReadSync      = jest.fn();
const mockCloseSync     = jest.fn();

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    $queryRaw:   mockQueryRaw,
    $executeRaw: mockExecuteRaw,
    $transaction: mockTransaction,
    contract: { create: mockContractCreate },
    license:  { create: mockLicenseCreate },
  })),
  Prisma: {
    raw:  (v: string) => ({ sql: v, values: [] }),
    sql:  (s: TemplateStringsArray, ...vals: unknown[]) => ({ sql: s[0], values: vals }),
    join: (parts: unknown[]) => parts[0],
  },
}));

jest.mock('../../../shared/utils/docVisibility', () => ({
  docVisibilitySqlCol: mockDocVisibilitySqlCol,
}));

jest.mock('../../../modules/plugins/index', () => ({
  emitHook: mockEmitHook,
}));

jest.mock('../../../services/entitySerializer', () => ({
  getContractRoot: mockGetContractRoot,
  getLicenseRoot:  mockGetLicenseRoot,
}));

jest.mock('../../../services/ragService', () => ({
  isOllamaHealthy:          jest.fn().mockResolvedValue(false),
  analyzeDocumentForImport: jest.fn().mockResolvedValue({}),
}));

jest.mock('../../../services/docParser', () => ({
  parseDocument: jest.fn().mockResolvedValue({ sections: [], ocrUsed: false }),
}));

jest.mock('fs', () => {
  const actual = jest.requireActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync:    mockExistsSync,
    mkdirSync:     mockMkdirSync,
    writeFileSync: mockWriteFileSync,
    unlinkSync:    mockUnlinkSync,
    copyFileSync:  mockCopyFileSync,
    openSync:      mockOpenSync,
    readSync:      mockReadSync,
    closeSync:     mockCloseSync,
  };
});

process.env.JWT_SECRET  = 'test-secret-32-chars-minimum-len!!';
process.env.RAG_ENABLED = 'false';

import express          from 'express';
import supertest        from 'supertest';
import jwt              from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import { createDocumentsRouter } from '../router.js';

const TEST_SECRET = 'test-secret-32-chars-minimum-len!!';
const prisma      = new PrismaClient() as any;
const mockQueue   = jest.fn();

const DOC_ID     = 'aaaaaaaa-1111-2222-3333-444444444444';
const DTYPE_ID   = 'bbbbbbbb-1111-2222-3333-444444444444';
const VENDOR_ID  = 'cccccccc-1111-2222-3333-444444444444';
const BATCH_ID   = 'dddddddd-1111-2222-3333-444444444444';
const ITEM_ID    = 'eeeeeeee-1111-2222-3333-444444444444';
const USER_ID    = 'ffffffff-1111-2222-3333-444444444444';

function makeToken(role: 'ADMIN' | 'AUDITOR' | 'VIEWER'): string {
  return jwt.sign(
    { id: USER_ID, username: 'tester', email: `${role.toLowerCase()}@test.local`, role },
    TEST_SECRET,
    { expiresIn: '1h' },
  );
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/documents', createDocumentsRouter(prisma, mockQueue));
  return supertest(app);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockQueryRaw.mockResolvedValue([{ active: true }]);
  mockExecuteRaw.mockResolvedValue(1n);
  mockDocVisibilitySqlCol.mockReturnValue('read_admin');
  mockEmitHook.mockResolvedValue(null);
  mockExistsSync.mockReturnValue(true);
});

// ── GET /api/documents ────────────────────────────────────────────────────────

describe('GET /api/documents', () => {
  it('401 without token', async () => {
    const res = await buildApp().get('/api/documents');
    expect(res.status).toBe(401);
  });

  it('200 with valid token — returns paginated list', async () => {
    mockQueryRaw
      .mockResolvedValueOnce([{ active: true }])         // auth check
      .mockResolvedValueOnce([{ c: BigInt(2) }])         // count
      .mockResolvedValueOnce([
        { id: DOC_ID, title: 'Doc A', description: null, documentTypeId: DTYPE_ID,
          documentTypeName: 'Contract', documentTypeCode: 'CONTRACT',
          versionNumber: 1, originalName: 'a.pdf', mimeType: 'application/pdf',
          fileSize: 1024, uploadedBy: 'admin@test.local', createdAt: new Date(),
          latestVersionId: DOC_ID },
      ]);
    const res = await buildApp()
      .get('/api/documents')
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.data).toHaveLength(1);
  });
});

// ── GET /api/documents/:id ────────────────────────────────────────────────────

describe('GET /api/documents/:id', () => {
  it('401 without token', async () => {
    const res = await buildApp().get(`/api/documents/${DOC_ID}`);
    expect(res.status).toBe(401);
  });

  it('404 when document not found', async () => {
    mockQueryRaw
      .mockResolvedValueOnce([{ active: true }])  // auth check
      .mockResolvedValueOnce([]);                 // doc fetch — not found
    const res = await buildApp()
      .get(`/api/documents/${DOC_ID}`)
      .set('Authorization', `Bearer ${makeToken('AUDITOR')}`);
    expect(res.status).toBe(404);
  });

  it('200 with detail', async () => {
    mockQueryRaw
      .mockResolvedValueOnce([{ active: true }])  // auth check
      .mockResolvedValueOnce([{
        id: DOC_ID, title: 'Doc A', description: null,
        documentTypeId: DTYPE_ID, documentTypeName: 'Contract', documentTypeCode: 'CONTRACT',
        rootId: null, versionNumber: 1, isLatest: true,
        fileName: 'uuid.pdf', originalName: 'a.pdf', mimeType: 'application/pdf',
        fileSize: 1024, uploadedBy: 'admin@test.local', createdAt: new Date(),
      }])
      .mockResolvedValue([]);  // versions, relations, cis, contracts, notes (parallel)

    const res = await buildApp()
      .get(`/api/documents/${DOC_ID}`)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(DOC_ID);
  });
});

// ── POST /api/documents ───────────────────────────────────────────────────────

describe('POST /api/documents', () => {
  it('401 without token', async () => {
    const res = await buildApp().post('/api/documents');
    expect(res.status).toBe(401);
  });

  it('403 for non-admin', async () => {
    const res = await buildApp()
      .post('/api/documents')
      .set('Authorization', `Bearer ${makeToken('AUDITOR')}`);
    expect(res.status).toBe(403);
  });

  it('400 when no file attached', async () => {
    const res = await buildApp()
      .post('/api/documents')
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .field('title', 'Test')
      .field('documentTypeId', DTYPE_ID);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/file/i);
  });

  it('201 on successful upload', async () => {
    mockQueryRaw
      .mockResolvedValueOnce([{ active: true }])  // auth check
      .mockResolvedValueOnce([{ id: DOC_ID }]);   // INSERT ... RETURNING id

    const pdfHeader = Buffer.from('25504446', 'hex'); // %PDF magic bytes
    const res = await buildApp()
      .post('/api/documents')
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .attach('file', pdfHeader, { filename: 'test.pdf', contentType: 'application/pdf' })
      .field('title', 'Test Document')
      .field('documentTypeId', DTYPE_ID);
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(DOC_ID);
    expect(mockWriteFileSync).toHaveBeenCalled();
    expect(mockExecuteRaw).toHaveBeenCalled(); // audit log
  });

  it('409 when plugin pre-hook cancels', async () => {
    mockEmitHook.mockResolvedValueOnce({ cancel: true, reason: 'Blocked' });
    const pdfHeader = Buffer.from('25504446', 'hex');
    const res = await buildApp()
      .post('/api/documents')
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .attach('file', pdfHeader, { filename: 'test.pdf', contentType: 'application/pdf' })
      .field('title', 'Test Document')
      .field('documentTypeId', DTYPE_ID);
    expect(res.status).toBe(409);
  });
});

// ── PATCH /api/documents/:id ──────────────────────────────────────────────────

describe('PATCH /api/documents/:id', () => {
  it('401 without token', async () => {
    const res = await buildApp().patch(`/api/documents/${DOC_ID}`);
    expect(res.status).toBe(401);
  });

  it('403 for auditor', async () => {
    const res = await buildApp()
      .patch(`/api/documents/${DOC_ID}`)
      .set('Authorization', `Bearer ${makeToken('AUDITOR')}`)
      .send({ title: 'New' });
    expect(res.status).toBe(403);
  });

  it('400 when title missing', async () => {
    const res = await buildApp()
      .patch(`/api/documents/${DOC_ID}`)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it('200 on update', async () => {
    mockQueryRaw
      .mockResolvedValueOnce([{ active: true }])  // auth check
      .mockResolvedValueOnce([{ id: DOC_ID }]);   // doc lookup
    const res = await buildApp()
      .patch(`/api/documents/${DOC_ID}`)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send({ title: 'Updated Title' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(mockExecuteRaw).toHaveBeenCalled();
  });
});

// ── PATCH /api/documents/:id/acl ─────────────────────────────────────────────

describe('PATCH /api/documents/:id/acl', () => {
  it('401 without token', async () => {
    const res = await buildApp().patch(`/api/documents/${DOC_ID}/acl`);
    expect(res.status).toBe(401);
  });

  it('403 for non-admin', async () => {
    const res = await buildApp()
      .patch(`/api/documents/${DOC_ID}/acl`)
      .set('Authorization', `Bearer ${makeToken('VIEWER')}`)
      .send({ readViewer: true });
    expect(res.status).toBe(403);
  });

  it('400 when no ACL fields', async () => {
    const res = await buildApp()
      .patch(`/api/documents/${DOC_ID}/acl`)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it('200 on ACL update', async () => {
    mockQueryRaw
      .mockResolvedValueOnce([{ active: true }])  // auth check
      .mockResolvedValueOnce([{ id: DOC_ID }]);   // doc lookup
    const res = await buildApp()
      .patch(`/api/documents/${DOC_ID}/acl`)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send({ readAuditor: true });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(DOC_ID);
  });
});

// ── DELETE /api/documents/:id ─────────────────────────────────────────────────

describe('DELETE /api/documents/:id', () => {
  it('401 without token', async () => {
    const res = await buildApp().delete(`/api/documents/${DOC_ID}`);
    expect(res.status).toBe(401);
  });

  it('403 for auditor', async () => {
    const res = await buildApp()
      .delete(`/api/documents/${DOC_ID}`)
      .set('Authorization', `Bearer ${makeToken('AUDITOR')}`);
    expect(res.status).toBe(403);
  });

  it('404 when not found', async () => {
    mockQueryRaw
      .mockResolvedValueOnce([{ active: true }])  // auth check
      .mockResolvedValueOnce([]);                 // doc lookup — not found
    const res = await buildApp()
      .delete(`/api/documents/${DOC_ID}`)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`);
    expect(res.status).toBe(404);
  });

  it('200 on delete — removes file', async () => {
    mockQueryRaw
      .mockResolvedValueOnce([{ active: true }])                           // auth check
      .mockResolvedValueOnce([{ file_name: 'uuid.pdf', root_id: null }]); // doc lookup
    const res = await buildApp()
      .delete(`/api/documents/${DOC_ID}`)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(mockUnlinkSync).toHaveBeenCalled();
    expect(mockExecuteRaw).toHaveBeenCalled(); // audit log
  });
});

// ── POST /api/documents/:id/reindex ───────────────────────────────────────────

describe('POST /api/documents/:id/reindex', () => {
  it('401 without token', async () => {
    const res = await buildApp().post(`/api/documents/${DOC_ID}/reindex`);
    expect(res.status).toBe(401);
  });

  it('403 for non-admin', async () => {
    const res = await buildApp()
      .post(`/api/documents/${DOC_ID}/reindex`)
      .set('Authorization', `Bearer ${makeToken('VIEWER')}`);
    expect(res.status).toBe(403);
  });

  it('200 and queues document', async () => {
    mockQueryRaw
      .mockResolvedValueOnce([{ active: true }])                   // auth check
      .mockResolvedValueOnce([{ id: DOC_ID, version_number: 1 }]); // doc lookup
    const res = await buildApp()
      .post(`/api/documents/${DOC_ID}/reindex`)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

// ── Bulk batches ──────────────────────────────────────────────────────────────

describe('POST /api/documents/bulk/batches', () => {
  it('401 without token', async () => {
    const res = await buildApp().post('/api/documents/bulk/batches');
    expect(res.status).toBe(401);
  });

  it('403 for non-admin', async () => {
    const res = await buildApp()
      .post('/api/documents/bulk/batches')
      .set('Authorization', `Bearer ${makeToken('AUDITOR')}`);
    expect(res.status).toBe(403);
  });

  it('400 when no files', async () => {
    const res = await buildApp()
      .post('/api/documents/bulk/batches')
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/fichero/i);
  });

  it('201 on batch upload', async () => {
    mockQueryRaw
      .mockResolvedValueOnce([{ active: true }])        // auth check
      .mockResolvedValueOnce([{ c: BigInt(0) }])        // open batches check
      .mockResolvedValueOnce([{ used: BigInt(0) }])     // user staging bytes check
      .mockResolvedValueOnce([{ id: BATCH_ID }]);       // batch insert

    const pdfHeader = Buffer.from('25504446ffffffff', 'hex');
    const res = await buildApp()
      .post('/api/documents/bulk/batches')
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .attach('files', pdfHeader, { filename: 'doc.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(201);
    expect(res.body.batchId).toBe(BATCH_ID);
  });
});

describe('GET /api/documents/bulk/batches', () => {
  it('401 without token', async () => {
    const res = await buildApp().get('/api/documents/bulk/batches');
    expect(res.status).toBe(401);
  });

  it('200 with list', async () => {
    mockQueryRaw
      .mockResolvedValueOnce([{ active: true }])                       // auth check
      .mockResolvedValueOnce([{ c: BigInt(1) }])                       // count (Promise.all[0])
      .mockResolvedValueOnce([{                                        // rows  (Promise.all[1])
        id: BATCH_ID, status: 'UPLOADED', fileCount: 2, totalBytes: '0',
        createdAt: new Date(), committed: BigInt(0), pending: BigInt(0),
        errors: BigInt(0), warnings: BigInt(0),
      }]);
    const res = await buildApp()
      .get('/api/documents/bulk/batches')
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.batches)).toBe(true);
  });
});

describe('GET /api/documents/bulk/batches/:id', () => {
  it('401 without token', async () => {
    const res = await buildApp().get(`/api/documents/bulk/batches/${BATCH_ID}`);
    expect(res.status).toBe(401);
  });

  it('404 when batch not found', async () => {
    mockQueryRaw
      .mockResolvedValueOnce([{ active: true }])  // auth check
      .mockResolvedValueOnce([]);                 // batch lookup — not found
    const res = await buildApp()
      .get(`/api/documents/bulk/batches/${BATCH_ID}`)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`);
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/documents/bulk/batches/:id', () => {
  it('401 without token', async () => {
    const res = await buildApp().delete(`/api/documents/bulk/batches/${BATCH_ID}`);
    expect(res.status).toBe(401);
  });

  it('403 for non-admin', async () => {
    const res = await buildApp()
      .delete(`/api/documents/bulk/batches/${BATCH_ID}`)
      .set('Authorization', `Bearer ${makeToken('AUDITOR')}`);
    expect(res.status).toBe(403);
  });
});

// ── Notes ─────────────────────────────────────────────────────────────────────

describe('GET /api/documents/:id/notes', () => {
  it('401 without token', async () => {
    const res = await buildApp().get(`/api/documents/${DOC_ID}/notes`);
    expect(res.status).toBe(401);
  });

  it('200 with notes', async () => {
    mockQueryRaw
      .mockResolvedValueOnce([{ active: true }])  // auth check
      .mockResolvedValueOnce([
        { id: 'note-1', content: 'Hello', createdBy: 'admin@test.local', createdAt: new Date() },
      ]);
    const res = await buildApp()
      .get(`/api/documents/${DOC_ID}/notes`)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

describe('POST /api/documents/:id/notes', () => {
  it('401 without token', async () => {
    const res = await buildApp().post(`/api/documents/${DOC_ID}/notes`);
    expect(res.status).toBe(401);
  });

  it('400 when content missing', async () => {
    const res = await buildApp()
      .post(`/api/documents/${DOC_ID}/notes`)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it('201 on note create', async () => {
    mockQueryRaw
      .mockResolvedValueOnce([{ active: true }])             // auth check
      .mockResolvedValueOnce([{ id: DOC_ID, root_id: null }]) // doc lookup
      .mockResolvedValueOnce([{ id: 'new-note-id' }]);        // note insert
    const res = await buildApp()
      .post(`/api/documents/${DOC_ID}/notes`)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send({ content: 'New note' });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe('new-note-id');
  });
});

// ── POST /api/documents/:id/cis (bulk associate) ─────────────────────────────

describe('POST /api/documents/:id/cis', () => {
  it('401 without token', async () => {
    const res = await buildApp().post(`/api/documents/${DOC_ID}/cis`);
    expect(res.status).toBe(401);
  });

  it('400 when ciIds missing', async () => {
    const res = await buildApp()
      .post(`/api/documents/${DOC_ID}/cis`)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it('200 on associate', async () => {
    const res = await buildApp()
      .post(`/api/documents/${DOC_ID}/cis`)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send({ ciIds: ['aaaaaaaa-cccc-cccc-cccc-cccccccccccc'] });
    expect(res.status).toBe(200);
    expect(res.body.associated).toBe(1);
  });
});

// ── POST /api/documents/:id/contracts (bulk associate) ───────────────────────

describe('POST /api/documents/:id/contracts', () => {
  it('401 without token', async () => {
    const res = await buildApp().post(`/api/documents/${DOC_ID}/contracts`);
    expect(res.status).toBe(401);
  });

  it('400 when contractIds missing', async () => {
    const res = await buildApp()
      .post(`/api/documents/${DOC_ID}/contracts`)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it('200 on associate', async () => {
    const res = await buildApp()
      .post(`/api/documents/${DOC_ID}/contracts`)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send({ contractIds: ['aaaaaaaa-cccc-cccc-cccc-cccccccccccc'] });
    expect(res.status).toBe(200);
    expect(res.body.associated).toBe(1);
  });
});

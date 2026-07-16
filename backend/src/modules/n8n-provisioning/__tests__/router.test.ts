/**
 * n8n-provisioning · router — tests (POST /api/admin/n8n/resync).
 *
 * supertest + mocks de prisma/config/provisionAll.
 */
import express from 'express';
import request from 'supertest';
import { N8nApiError } from '../errors.js';

const mockProvisionAll  = jest.fn();
const mockLoadConfig    = jest.fn();
const mockMakeApiClient = jest.fn();
const mockExecuteRaw    = jest.fn().mockResolvedValue(1);

jest.mock('../config.js',      () => ({ loadN8nProvisioningConfig: mockLoadConfig }));
jest.mock('../apiClient.js',   () => ({ makeN8nApiClient: mockMakeApiClient }));
jest.mock('../provisioner.js', () => ({ provisionAll: mockProvisionAll }));

import { createN8nProvisioningRouter } from '../router.js';

// ── helpers ──────────────────────────────────────────────────────────────────

function makeApp(role: 'ADMIN' | 'AUDITOR' | null) {
  const prisma = { $executeRaw: mockExecuteRaw } as any;
  const app    = express();
  app.use(express.json());

  // Inyecta usuario simulado (sin JWT real) e imita la cadena real de
  // authenticateToken + requireAdmin que index.ts aplica en el mount
  // (el router en sí no hace RBAC — ver router.ts). Sin esto, un role=null
  // hace explotar req.user.email dentro del handler (500 en vez de 401) y
  // un AUDITOR pasa sin bloqueo (200 en vez de 403).
  app.use((req: any, res: any, next: any) => {
    if (!role) {
      res.status(401).json({ error: 'Authentication required. Please login.' });
      return;
    }
    req.user = { email: 'test@test.com', role, id: 'uid-1' };
    next();
  });
  app.use((req: any, res: any, next: any) => {
    if (req.user.role !== 'ADMIN') {
      res.status(403).json({ error: 'Admin role required for this operation.' });
      return;
    }
    next();
  });

  app.use('/api/admin/n8n', createN8nProvisioningRouter(prisma));
  return app;
}

const GOOD_REPORT = {
  credentials: [{ name: 'CMDB Service Token', action: 'created' }],
  workflows:   [{ name: 'RAG Indexing', action: 'created', active: true }],
  errors:      [],
};

beforeEach(() => {
  jest.clearAllMocks();
  mockProvisionAll.mockResolvedValue(GOOD_REPORT);
  mockMakeApiClient.mockReturnValue({});
  mockLoadConfig.mockReturnValue({
    apiBaseUrl: 'http://n8n:5678', apiKey: 'key', serviceToken: 'tok',
    smtp: null, ldap: null,
  });
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe('POST /api/admin/n8n/resync', () => {
  it('devuelve 401 si no hay usuario autenticado', async () => {
    const res = await request(makeApp(null)).post('/api/admin/n8n/resync');
    expect(res.status).toBe(401);
  });

  it('devuelve 403 si el rol es AUDITOR', async () => {
    const res = await request(makeApp('AUDITOR')).post('/api/admin/n8n/resync');
    expect(res.status).toBe(403);
  });

  it('devuelve 503 si N8N_API_KEY no está configurada', async () => {
    mockLoadConfig.mockReturnValue({ apiKey: null, apiBaseUrl: '', serviceToken: '', smtp: null, ldap: null });
    const res = await request(makeApp('ADMIN')).post('/api/admin/n8n/resync');
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/N8N_API_KEY/);
  });

  it('devuelve 200 con ProvisionReport y registra AuditLog en ADMIN OK', async () => {
    const res = await request(makeApp('ADMIN')).post('/api/admin/n8n/resync');
    expect(res.status).toBe(200);
    expect(res.body.report).toEqual(GOOD_REPORT);
    expect(mockExecuteRaw).toHaveBeenCalledTimes(1);
    // El primer argumento es el TemplateStringsArray (array de literales SQL)
    const sqlParts: string[] = Array.from(mockExecuteRaw.mock.calls[0][0] as string[]);
    const sql = sqlParts.join('');
    expect(sql).toContain('N8N_RESYNC');
    expect(sql).toContain('N8nProvisioning');
  });

  it('devuelve 200 aunque provisionAll tenga errors (fail-soft)', async () => {
    mockProvisionAll.mockResolvedValue({ ...GOOD_REPORT, errors: ['cred fail'] });
    const res = await request(makeApp('ADMIN')).post('/api/admin/n8n/resync');
    expect(res.status).toBe(200);
    expect(res.body.report.errors).toEqual(['cred fail']);
  });

  it('devuelve 502 accionable si provisionAll falla por 401', async () => {
    // Arrange: provisionAll rechaza con credencial inválida.
    mockProvisionAll.mockRejectedValue(new N8nApiError(401, 'GET', '/api/v1/workflows'));

    const res = await request(makeApp('ADMIN')).post('/api/admin/n8n/resync');

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/API key|credencial/i);
  });
});

/**
 * n8n-provisioning · provisionOnBoot — tests.
 *
 * Fire-and-forget: nunca lanza, no bloquea el arranque.
 * Reintentos hasta n8n responde (listWorkflows ok) antes de llamar provisionAll.
 */

// Mockeamos los módulos que provisionOnBoot consume
const mockListWorkflows   = jest.fn();
const mockProvisionAll    = jest.fn();
const mockLoadConfig      = jest.fn();
const mockMakeApiClient   = jest.fn();

jest.mock('../config.js',       () => ({ loadN8nProvisioningConfig: mockLoadConfig }));
jest.mock('../apiClient.js',    () => ({ makeN8nApiClient: mockMakeApiClient }));
jest.mock('../provisioner.js',  () => ({ provisionAll: mockProvisionAll }));

// prisma mock global (onBoot usa el prisma compartido del módulo)
jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({ $queryRaw: jest.fn().mockResolvedValue([]) })),
}));

import { provisionOnBoot } from '../onBoot.js';
import type { N8nProvisioningConfig } from '../config.js';

function makeCfg(over: Partial<N8nProvisioningConfig> = {}): N8nProvisioningConfig {
  return {
    apiBaseUrl: 'http://n8n:5678', apiKey: 'key', serviceToken: 'tok',
    smtp: null, ldap: null, ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  // Por defecto: config con key, n8n responde al primer intento
  mockLoadConfig.mockReturnValue(makeCfg());
  mockListWorkflows.mockResolvedValue([]);
  mockMakeApiClient.mockReturnValue({ listWorkflows: mockListWorkflows });
  mockProvisionAll.mockResolvedValue({ credentials: [], workflows: [], errors: [] });
});

// Espera a que el fire-and-forget termine (drena la micro-task queue)
async function drainAsync(ms = 100): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe('provisionOnBoot', () => {
  it('no lanza ni llama provisionAll si apiKey es null', async () => {
    mockLoadConfig.mockReturnValue(makeCfg({ apiKey: null }));
    expect(() => provisionOnBoot()).not.toThrow();
    await drainAsync();
    expect(mockProvisionAll).not.toHaveBeenCalled();
  });

  it('llama provisionAll cuando n8n responde al primer intento', async () => {
    provisionOnBoot();
    await drainAsync();
    expect(mockProvisionAll).toHaveBeenCalledTimes(1);
  });

  it('reintenta si n8n no responde y llama provisionAll cuando esté listo', async () => {
    mockListWorkflows
      .mockRejectedValueOnce(new Error('n8n not ready'))
      .mockRejectedValueOnce(new Error('n8n not ready'))
      .mockResolvedValue([]);

    provisionOnBoot(/* retryDelayMs= */ 10);
    await drainAsync(200);

    expect(mockListWorkflows).toHaveBeenCalledTimes(3);
    expect(mockProvisionAll).toHaveBeenCalledTimes(1);
  });

  it('no lanza si provisionAll falla', async () => {
    mockProvisionAll.mockRejectedValue(new Error('boom'));
    expect(() => provisionOnBoot()).not.toThrow();
    await drainAsync();
    // El error queda capturado internamente
  });

  it('se detiene si supera el máximo de reintentos sin conectar a n8n', async () => {
    mockListWorkflows.mockRejectedValue(new Error('always fail'));
    provisionOnBoot(/* retryDelayMs= */ 5, /* maxRetries= */ 3);
    await drainAsync(200);
    expect(mockListWorkflows).toHaveBeenCalledTimes(3);
    expect(mockProvisionAll).not.toHaveBeenCalled();
  });
});

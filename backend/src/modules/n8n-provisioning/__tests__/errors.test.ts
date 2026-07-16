import { N8nApiError } from '../errors.js';

describe('N8nApiError', () => {
  it('captura status/method/path y compone el mensaje', () => {
    const e = new N8nApiError(401, 'GET', '/api/v1/workflows');
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('N8nApiError');
    expect(e.status).toBe(401);
    expect(e.message).toBe('n8n API GET /api/v1/workflows -> 401');
  });

  it('isAuthError es true solo para 401/403', () => {
    expect(new N8nApiError(401, 'GET', '/x').isAuthError).toBe(true);
    expect(new N8nApiError(403, 'GET', '/x').isAuthError).toBe(true);
    expect(new N8nApiError(500, 'GET', '/x').isAuthError).toBe(false);
    expect(new N8nApiError(503, 'GET', '/x').isAuthError).toBe(false);
  });
});

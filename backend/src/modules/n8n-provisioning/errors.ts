/**
 * n8n-provisioning · error tipado del cliente HTTP de la API de n8n.
 *
 * Lleva el `status` HTTP para que las capas superiores (onBoot, router) puedan
 * distinguir una credencial inválida (401/403 — no reintentable) de un fallo de
 * conectividad (n8n aún no listo — reintentable). Vive en su propio módulo para
 * que `instanceof` funcione en tests donde `apiClient.js` está mockeado.
 */
export class N8nApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly method: string,
    public readonly path: string,
  ) {
    super(`n8n API ${method} ${path} -> ${status}`);
    this.name = 'N8nApiError';
  }

  /** true si el fallo es de autenticación/autorización (credencial inválida). */
  get isAuthError(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

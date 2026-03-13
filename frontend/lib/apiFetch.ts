// Resolved at build time for Docker (NEXT_PUBLIC_* vars are baked in).
// Falls back to localhost:3000 for local development.
const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";

/**
 * Authenticated fetch wrapper.
 * Reads the JWT from localStorage and injects it as a Bearer token.
 * Use this for all API calls to the backend.
 */
export function apiFetch(path: string, options?: RequestInit): Promise<Response> {
  const token =
    typeof window !== "undefined" ? localStorage.getItem("cmdb_token") : null;

  return fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options?.headers,
    },
  });
}

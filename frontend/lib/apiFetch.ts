// Resolved at build time for Docker (NEXT_PUBLIC_* vars are baked in).
// Falls back to localhost:3000 for local development.
const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";

/**
 * Decode the payload segment of a JWT without verifying the signature.
 * Returns `null` for malformed tokens.
 */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(base64)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Returns `true` when the JWT `exp` claim is in the past (with a 30-second
 * buffer).  Tokens without an `exp` are treated as non-expired.
 */
function isJwtExpired(token: string, bufferSeconds = 30): boolean {
  const payload = decodeJwtPayload(token);
  if (!payload) return true;
  const exp = payload["exp"];
  if (typeof exp !== "number") return false;
  return Math.floor(Date.now() / 1000) >= exp - bufferSeconds;
}

/**
 * Authenticated fetch wrapper.
 * Reads the JWT from localStorage and injects it as a Bearer token.
 * Expired tokens are discarded before the request is made so the backend
 * receives either a valid Bearer token or no token at all.
 * Use this for all API calls to the backend.
 */
export function apiFetch(path: string, options?: RequestInit): Promise<Response> {
  let token =
    typeof window !== "undefined" ? localStorage.getItem("cmdb_token") : null;

  // Do not forward a token that has already expired client-side.
  if (token && isJwtExpired(token)) {
    localStorage.removeItem("cmdb_token");
    localStorage.removeItem("cmdb_user");
    token = null;
  }

  return fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options?.headers,
    },
  });
}

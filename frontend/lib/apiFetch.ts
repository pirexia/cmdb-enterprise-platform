const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";

/**
 * Returns true when the session stored in cmdb_user has expired (30s buffer).
 * The JWT itself is in an HttpOnly cookie — we check exp from the stored user JSON.
 */
function isSessionExpired(): boolean {
  try {
    if (typeof window === "undefined") return false;
    const stored = localStorage.getItem("cmdb_user");
    if (!stored) return true;
    const user = JSON.parse(stored) as { exp?: number };
    if (typeof user.exp !== "number") return false;
    return Math.floor(Date.now() / 1000) >= user.exp - 30;
  } catch {
    return true;
  }
}

/**
 * Authenticated fetch wrapper.
 * The JWT is sent automatically via HttpOnly cookie (credentials: 'include').
 * Clears local user state if the session has visibly expired client-side.
 */
export function apiFetch(path: string, options?: RequestInit): Promise<Response> {
  if (typeof window !== "undefined" && isSessionExpired()) {
    localStorage.removeItem("cmdb_user");
  }

  return fetch(`${API_BASE}${path}`, {
    ...options,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });
}

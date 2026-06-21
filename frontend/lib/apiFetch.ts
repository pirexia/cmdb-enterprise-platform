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

  // Don't set Content-Type when body is FormData — the browser sets it
  // automatically with the correct multipart boundary.
  const isFormData = options?.body instanceof FormData;

  return fetch(`${API_BASE}${path}`, {
    ...options,
    credentials: "include",
    headers: isFormData ? { ...options?.headers } : {
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });
}

/**
 * Fetches the complete CI inventory across every page.
 *
 * GET /api/cis is server-paginated: it returns { total, page, limit, data } and
 * caps each page at CI_MAX_PAGE_SIZE (250) rows. List and aggregation views need
 * every CI, so this loops pages until it has collected `total`. Returns the
 * flattened CI array (same shape as a single page's `data`).
 */
export async function fetchAllCIs<T = unknown>(): Promise<T[]> {
  const PAGE_SIZE = 250; // mirrors backend CI_MAX_PAGE_SIZE
  const all: T[] = [];
  let page = 1;
  // Safety bound: stops a runaway loop if `total` and `data` ever disagree.
  for (let guard = 0; guard < 1000; guard++) {
    const res = await apiFetch(`/api/cis?limit=${PAGE_SIZE}&page=${page}`);
    if (!res.ok) throw new Error(`Status ${res.status}`);
    const json = (await res.json()) as { total: number; data: T[] };
    all.push(...json.data);
    if (json.data.length === 0 || all.length >= json.total) break;
    page++;
  }
  return all;
}

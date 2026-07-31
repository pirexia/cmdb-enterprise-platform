// Red Hat Insights Vulnerability API client. Read-only — no write-back to
// Red Hat (no opt_out/business_risk/status PATCH calls; out of scope, spec §2).
//
// Response envelope confirmed against a real service account (live
// verification, not the public docs this was originally inferred from):
// both /systems and /systems/{id}/cves wrap each record in a JSON:API-style
// `{id, type, attributes: {...}}` object — the fields this module cares
// about live under `attributes`, not at the top level.

export interface LightspeedSystem {
  inventory_id: string;
  display_name: string;
  os: string;
  cve_count: number;
}

export interface LightspeedCve {
  synopsis: string;          // the CVE id itself — identity key (spec §identity)
  cvss3_score?: string;
  cvss2_score?: string;
  impact: string;            // Red Hat's own severity: Low/Moderate/Important/Critical
  known_exploit: boolean;
  public_date?: string;
  description?: string;
}

interface JsonApiRecord<T> { id: string; type: string; attributes: T }
interface PagedResponse<T> { data: JsonApiRecord<T>[]; links?: { next: string | null } }

// Every outbound Red Hat call gets a hard timeout (see redhatLightspeed
// tokenClient.ts's FETCH_TIMEOUT_MS comment for the reasoning).
const FETCH_TIMEOUT_MS = 15_000;

// Defensive upper bound so a misbehaving API can never spin this loop
// forever. A single RHEL system's open-CVE backlog was observed at 4600
// during live verification (46 pages at limit=100) — 500 pages covers a
// system with 10x that before truncating.
const MAX_PAGES = 500;

async function getPaged<T>(url: string, token: string): Promise<T[]> {
  const results: T[] = [];
  let offset = 0;
  const limit = 100;
  for (let page = 0; page < MAX_PAGES; page++) {
    const pageUrl = `${url}${url.includes('?') ? '&' : '?'}limit=${limit}&offset=${offset}`;
    const res = await fetch(pageUrl, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`Red Hat Insights Vulnerability API request failed: ${res.status} ${pageUrl}`);
    }
    const body = (await res.json()) as PagedResponse<T>;
    if (!Array.isArray(body?.data)) {
      throw new Error(`Red Hat Insights Vulnerability API returned an unexpected response shape (no "data" array) for ${pageUrl}`);
    }
    results.push(...body.data.map((r) => r.attributes));

    // `links.next` is the authoritative stop signal (confirmed against the
    // real API during live verification): when the total item count is an
    // exact multiple of `limit`, a length-based "was this page short?"
    // check never fires, and requesting the next offset past the end
    // returns 400, not an empty page. Fall back to the length check only
    // if a response happens not to carry `links` at all.
    const hasNext = body.links ? body.links.next !== null : body.data.length === limit;
    if (!hasNext) break;
    if (page === MAX_PAGES - 1) {
      console.warn(`[vulnClient] Hit the ${MAX_PAGES}-page pagination cap for ${url} — results may be truncated.`);
    }
    offset += limit;
  }
  return results;
}

export async function listSystems(baseUrl: string, token: string): Promise<LightspeedSystem[]> {
  return getPaged<LightspeedSystem>(`${baseUrl}/api/vulnerability/v1/systems`, token);
}

export async function listSystemCves(baseUrl: string, token: string, inventoryId: string): Promise<LightspeedCve[]> {
  return getPaged<LightspeedCve>(`${baseUrl}/api/vulnerability/v1/systems/${encodeURIComponent(inventoryId)}/cves`, token);
}

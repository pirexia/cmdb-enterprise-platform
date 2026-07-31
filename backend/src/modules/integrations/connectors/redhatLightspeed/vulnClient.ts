// Red Hat Insights Vulnerability API client. Read-only — no write-back to
// Red Hat (no opt_out/business_risk/status PATCH calls; out of scope, spec §2).

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

interface PagedResponse<T> { data: T[]; meta?: { count?: number } }

// Every outbound Red Hat call gets a hard timeout (see redhatLightspeed
// tokenClient.ts's FETCH_TIMEOUT_MS comment for the reasoning).
const FETCH_TIMEOUT_MS = 15_000;

async function getPaged<T>(url: string, token: string): Promise<T[]> {
  const results: T[] = [];
  let offset = 0;
  const limit = 100;
  // Defensive upper bound so a misbehaving API can never spin this loop
  // forever — 50 pages * 100 = 5000 systems/CVEs is far beyond any
  // realistic single-org inventory.
  for (let page = 0; page < 50; page++) {
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
    results.push(...body.data);
    if (body.data.length < limit) break;
    if (page === 49) {
      console.warn(`[vulnClient] Hit the 50-page pagination cap for ${url} — results may be truncated.`);
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

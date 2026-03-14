/**
 * endoflife.date integration service.
 * Queries https://endoflife.date/api/{product}.json to auto-fill
 * eolDate (End of Life) and eosDate (End of Support / Security patches).
 *
 * Uses Node's built-in `https` module — no extra dependencies.
 */

import https from 'https';

const EOL_API_BASE = 'https://endoflife.date/api';
const TIMEOUT_MS   = 6_000;

interface EolCycle {
  cycle:   string;
  eol:     string | boolean | null;
  support?: string | boolean | null;
  lts?:    string | boolean | null;
  latest?: string;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function httpsGet(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: TIMEOUT_MS }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => {
        if ((res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300) {
          resolve(data);
        } else {
          reject(new Error(`HTTP ${res.statusCode}`));
        }
      });
    });
    req.on('error',   reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function toProductSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9.-]/g, '')
    .replace(/-+/g, '-')
    .slice(0, 60);
}

function parseEolDate(value: string | boolean | null | undefined): Date | null {
  if (!value || typeof value === 'boolean') return null;
  try {
    const d = new Date(value);
    return isNaN(d.getTime()) ? null : d;
  } catch { return null; }
}

function matchCycle(cycles: EolCycle[], version?: string): EolCycle | undefined {
  if (!version) return cycles[0];
  // Try progressively shorter version prefixes: "14.2.1" → "14.2" → "14"
  const parts = version.split('.');
  for (let i = parts.length; i > 0; i--) {
    const prefix = parts.slice(0, i).join('.');
    const found  = cycles.find((c) => c.cycle === prefix || c.latest?.startsWith(prefix));
    if (found) return found;
  }
  return cycles[0];
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface EolResult {
  eolDate:     Date | null;
  supportDate: Date | null;
}

/**
 * Looks up End-of-Life / End-of-Support dates for a product.
 *
 * @param productName - The product name (will be slugified for the API)
 * @param version     - Optional version string to match the right release cycle
 * @returns EolResult on success, null if the product is not found or the API fails
 */
export async function lookupEolDates(
  productName: string,
  version?: string
): Promise<EolResult | null> {
  if (!productName?.trim()) return null;

  const slug = toProductSlug(productName);
  if (!slug) return null;

  try {
    const raw    = await httpsGet(`${EOL_API_BASE}/${slug}.json`);
    const cycles = JSON.parse(raw) as EolCycle[];
    if (!Array.isArray(cycles) || cycles.length === 0) return null;

    const cycle = matchCycle(cycles, version);
    if (!cycle) return null;

    return {
      eolDate:     parseEolDate(cycle.eol),
      supportDate: parseEolDate(cycle.support ?? cycle.lts),
    };
  } catch {
    // API not found / network error — silently return null
    return null;
  }
}

/**
 * Returns the full list of product slugs tracked by endoflife.date.
 * Example: ["ubuntu", "debian", "windows", "rhel", ...]
 */
export async function fetchAllProducts(): Promise<string[]> {
  try {
    const raw  = await httpsGet(`${EOL_API_BASE}/all.json`);
    const list = JSON.parse(raw) as unknown;
    return Array.isArray(list) ? (list as string[]) : [];
  } catch { return []; }
}

/**
 * Returns all release cycles for a product slug.
 * Returns null if the product does not exist on endoflife.date.
 */
export async function fetchProductCycles(slug: string): Promise<EolCycle[] | null> {
  try {
    const raw    = await httpsGet(`${EOL_API_BASE}/${slug}.json`);
    const cycles = JSON.parse(raw) as unknown;
    return Array.isArray(cycles) ? (cycles as EolCycle[]) : null;
  } catch { return null; }
}

/**
 * Tries multiple slugs (product aliases) in sequence and returns the first hit.
 * Useful when the CI name might differ from the API slug.
 */
export async function lookupEolWithFallbacks(
  names: string[],
  version?: string
): Promise<EolResult | null> {
  for (const name of names) {
    const result = await lookupEolDates(name, version);
    if (result?.eolDate || result?.supportDate) return result;
  }
  return null;
}

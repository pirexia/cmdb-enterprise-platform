// Red Hat's public, UNAUTHENTICATED Product Life Cycle Data API — no
// service-account token needed for this one. Confirmed reachable during
// design research (spec §3.4). Only ever called with 'Red Hat Enterprise
// Linux' as the product name — never a caller-supplied value (A10).

const LIFECYCLE_API_URL = 'https://access.redhat.com/product-life-cycles/api/v1/products?name=Red%20Hat%20Enterprise%20Linux';

interface LifecyclePhase { name: string; start_date: string; end_date: string }
interface LifecycleVersion { name: string; phases: LifecyclePhase[] }
interface LifecycleProduct { name: string; versions: LifecycleVersion[] }
interface LifecycleResponse { data: LifecycleProduct[] }

function parsePhaseDate(value: string | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export interface RhelLifecycleDates {
  /** End of "Full support" — operational support ends. */
  eosDate: Date | null;
  /** End of "Maintenance support" — all support ends. */
  eolDate: Date | null;
}

export async function getRhelLifecycleDates(majorVersion: number): Promise<RhelLifecycleDates> {
  const res = await fetch(LIFECYCLE_API_URL);
  if (!res.ok) {
    throw new Error(`Red Hat Product Life Cycle API request failed: ${res.status}`);
  }
  const body = (await res.json()) as LifecycleResponse;
  const product = body.data.find((p) => p.name === 'Red Hat Enterprise Linux');
  const version = product?.versions.find((v) => v.name === String(majorVersion));
  if (!version) return { eosDate: null, eolDate: null };

  const fullSupport = version.phases.find((p) => p.name === 'Full support');
  const maintenance = version.phases.find((p) => p.name === 'Maintenance support');

  return {
    eosDate: parsePhaseDate(fullSupport?.end_date),
    eolDate: parsePhaseDate(maintenance?.end_date),
  };
}

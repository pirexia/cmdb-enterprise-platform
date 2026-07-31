export interface HostIdentity {
  ip: string | null;
  hostname: string | null;
  displayName: string;
  osName: string | null;
  osMajor: number | null;
  osMinor: number | null;
}

interface InventoryHostResult { fqdn: string; ip_addresses: string[]; display_name: string }
interface SystemProfileResult { system_profile: { operating_system?: { name: string; major: number; minor: number } } }

async function getOne<T>(url: string, token: string, context: string): Promise<T> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Red Hat Insights Inventory API request failed (${context}): ${res.status}`);
  const body = (await res.json()) as { results: T[] };
  if (body.results.length === 0) throw new Error(`Red Hat Insights Inventory API returned no results for ${context}`);
  return body.results[0];
}

/** Fetches a host's identity (IP/hostname, for the existing `matcher.ts`
 *  cascade) and its exact RHEL version (for OS correction on accept). */
export async function getHostIdentity(baseUrl: string, token: string, inventoryId: string): Promise<HostIdentity> {
  const host = await getOne<InventoryHostResult>(
    `${baseUrl}/api/inventory/v1/hosts/${inventoryId}`, token, `hosts/${inventoryId}`,
  );
  const profile = await getOne<SystemProfileResult>(
    `${baseUrl}/api/inventory/v1/hosts/${inventoryId}/system_profile?fields[system_profile]=operating_system`,
    token, `hosts/${inventoryId}/system_profile`,
  );

  const os = profile.system_profile.operating_system;

  return {
    ip: host.ip_addresses?.[0] ?? null,
    hostname: host.fqdn || null,
    displayName: host.display_name,
    osName: os?.name ?? null,
    osMajor: os?.major ?? null,
    osMinor: os?.minor ?? null,
  };
}

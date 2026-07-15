// Thin HTTP client for the vSphere REST API (session, VM listing, guest identity,
// VM detail). Uses Node's built-in `https` module directly (not `fetch`) so we can
// hand it a custom TLS Agent (self-signed / private-CA vCenter certs) without adding
// the `undici` dependency, which is not present in this project.
//
// SECURITY: never log the configured password or the session token. Do not log the
// full config object anywhere in this file.

import https from 'node:https';
import fs from 'node:fs';
import { URL } from 'node:url';

export interface VCenterClientConfig {
  url: string; // e.g. "https://vcenter.local"
  username: string;
  password: string;
  rejectUnauthorized: boolean;
  caCertPath?: string; // optional PEM path
}

export interface VCenterVmSummary {
  vm: string;
  name: string;
  power_state: string;
  cpu_count?: number;
  memory_size_MiB?: number;
  // MoRef of the ESXi host running this VM (e.g. "host-21"), per the vSphere
  // Automation API's documented VM.Summary schema. NOT independently verified
  // against a live vCenter in this session — optional, and every consumer of
  // this field must degrade gracefully if it's absent or wrong. See
  // VCenterConnector.discover() for the defensive handling.
  host?: string;
}

// Per the vSphere Automation API's documented Host.Info schema, returned by
// GET /api/vcenter/host/{host}. NOT independently verified against a live
// vCenter in this session — treat `name` as possibly absent or the whole
// endpoint as possibly shaped differently; callers must fail safe (see
// VCenterClient.hostSummary() and VCenterConnector.discover()).
export interface VCenterHostSummary {
  name?: string; // ESXi host's display name/hostname, e.g. "esxi01.midominio.local"
}

export interface VCenterGuestIdentity {
  ip_address?: string;
  host_name?: string;
  family?: string;
}

export interface VCenterVmDetail {
  guest_OS?: string;
  hardware?: {
    cpu?: { count?: number };
    memory?: { size_MiB?: number };
  };
}

interface RequestOptions {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  headers?: Record<string, string>;
  basicAuth?: { username: string; password: string };
}

interface RawResponse {
  statusCode: number;
  body: string;
}

export class VCenterClient {
  private readonly cfg: VCenterClientConfig;
  private readonly agent: https.Agent;
  private sessionToken: string | null = null;

  constructor(cfg: VCenterClientConfig) {
    this.cfg = cfg;

    const agentOptions: https.AgentOptions = {
      rejectUnauthorized: cfg.rejectUnauthorized,
    };
    if (cfg.caCertPath) {
      agentOptions.ca = fs.readFileSync(cfg.caCertPath);
    }
    this.agent = new https.Agent(agentOptions);
  }

  private request(opts: RequestOptions): Promise<RawResponse> {
    const target = new URL(opts.path, this.cfg.url);

    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = { ...(opts.headers || {}) };

      if (opts.basicAuth) {
        const encoded = Buffer.from(
          `${opts.basicAuth.username}:${opts.basicAuth.password}`,
        ).toString('base64');
        headers['Authorization'] = `Basic ${encoded}`;
      } else if (this.sessionToken) {
        headers['vmware-api-session-id'] = this.sessionToken;
      }

      const req = https.request(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port || 443,
          path: `${target.pathname}${target.search}`,
          method: opts.method,
          headers,
          agent: this.agent,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            resolve({
              statusCode: res.statusCode || 0,
              body: Buffer.concat(chunks).toString('utf8'),
            });
          });
        },
      );

      req.on('error', reject);
      req.end();
    });
  }

  private parseJson<T>(raw: RawResponse): T {
    if (!raw.body) return undefined as unknown as T;
    try {
      return JSON.parse(raw.body) as T;
    } catch {
      // Non-JSON body from an unexpected response shape — surface as a generic parse
      // failure rather than leaking raw body content (could contain sensitive detail).
      throw new Error('vCenter API returned a non-JSON response');
    }
  }

  async session(): Promise<void> {
    const res = await this.request({
      method: 'POST',
      path: '/api/session',
      basicAuth: { username: this.cfg.username, password: this.cfg.password },
    });

    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw new Error(`vCenter session request failed with status ${res.statusCode}`);
    }

    const token = this.parseJson<string>(res);
    if (!token || typeof token !== 'string') {
      throw new Error('vCenter session response did not include a session token');
    }
    this.sessionToken = token;
  }

  async listVMs(): Promise<VCenterVmSummary[]> {
    const res = await this.request({ method: 'GET', path: '/api/vcenter/vm' });
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw new Error(`vCenter listVMs failed with status ${res.statusCode}`);
    }
    return this.parseJson<VCenterVmSummary[]>(res) || [];
  }

  async vmGuestIdentity(vmId: string): Promise<VCenterGuestIdentity | null> {
    const res = await this.request({
      method: 'GET',
      path: `/api/vcenter/vm/${encodeURIComponent(vmId)}/guest/identity`,
    });

    // 404 and 503 are both normal "no guest info for this VM" cases, not errors:
    // vSphere returns 404 (no guest identity) or 503 (ServiceUnavailable — VMware
    // Tools not running / guest not ready yet) for a VM whose guest can't be read.
    // Guest identity (ip/hostname/family) is optional enrichment; degrade to null
    // for this VM rather than failing — a single tools-less VM must never abort the
    // whole sync.
    if (res.statusCode === 404 || res.statusCode === 503) return null;
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw new Error(`vCenter vmGuestIdentity failed with status ${res.statusCode}`);
    }
    return this.parseJson<VCenterGuestIdentity>(res);
  }

  async vmDetail(vmId: string): Promise<VCenterVmDetail> {
    const res = await this.request({
      method: 'GET',
      path: `/api/vcenter/vm/${encodeURIComponent(vmId)}`,
    });
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw new Error(`vCenter vmDetail failed with status ${res.statusCode}`);
    }
    // Guard against an empty 2xx body (parseJson returns `undefined` in that case),
    // mirroring listVMs()'s `|| []` pattern — callers can always safely optional-chain
    // into `.hardware` without checking for a missing detail object first.
    return this.parseJson<VCenterVmDetail>(res) || {};
  }

  async hostSummary(hostId: string): Promise<VCenterHostSummary | null> {
    const res = await this.request({
      method: 'GET',
      path: `/api/vcenter/host/${encodeURIComponent(hostId)}`,
    });
    // 404 (host removed/renamed since the VM summary was fetched) is a normal case, not an error.
    if (res.statusCode === 404) return null;
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw new Error(`vCenter hostSummary failed with status ${res.statusCode}`);
    }
    return this.parseJson<VCenterHostSummary>(res) ?? null;
  }

  async logout(): Promise<void> {
    // Best-effort: swallow any error, never let a logout failure surface upward.
    try {
      await this.request({ method: 'DELETE', path: '/api/session' });
    } catch {
      // intentionally ignored
    } finally {
      this.sessionToken = null;
    }
  }
}

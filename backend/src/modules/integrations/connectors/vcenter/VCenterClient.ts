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

    // 404 is a normal case: VM without VMware Tools running. Not an error.
    if (res.statusCode === 404) return null;
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

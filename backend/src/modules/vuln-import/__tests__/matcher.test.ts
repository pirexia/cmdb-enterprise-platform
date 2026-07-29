/**
 * B3 — CI matcher unit tests (mocked Prisma, no real DB).
 *
 * Covers the 5-level cascade from spec §3 D3: EXACT_IP, EXACT_NAME,
 * EXACT_HOSTNAME (incl. domain-suffix stripping), EXACT_DNS, FUZZY, plus
 * the two hard rules: AMBIGUOUS on 2+ distinct CIs at a level (no
 * fallback, no "pick one"), and UNMATCHED when nothing matches at all.
 */

const mockQueryRaw = jest.fn();

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    $queryRaw: mockQueryRaw,
  })),
}));

import { PrismaClient } from '@prisma/client';
import { matchHost, isValidIPv4, escapeLike } from '../matcher.js';

const prisma = new PrismaClient() as any;

beforeEach(() => {
  jest.clearAllMocks();
});

// ── isValidIPv4 ──────────────────────────────────────────────────────────

describe('isValidIPv4', () => {
  it('accepts valid dotted-quad IPv4', () => {
    expect(isValidIPv4('10.100.12.61')).toBe(true);
    expect(isValidIPv4('0.0.0.0')).toBe(true);
    expect(isValidIPv4('255.255.255.255')).toBe(true);
  });

  it('rejects out-of-range octets, malformed strings, and IPv6', () => {
    expect(isValidIPv4('256.1.1.1')).toBe(false);
    expect(isValidIPv4('10.100.12')).toBe(false);
    expect(isValidIPv4('not-an-ip')).toBe(false);
    expect(isValidIPv4('::1')).toBe(false);
    expect(isValidIPv4('2001:db8::1')).toBe(false);
    expect(isValidIPv4('')).toBe(false);
  });
});

// ── escapeLike ───────────────────────────────────────────────────────────

describe('escapeLike', () => {
  it('escapes backslash, percent, and underscore, backslash first', () => {
    expect(escapeLike('100%_done\\path')).toBe('100\\%\\_done\\\\path');
  });
});

// ── EXACT_IP ─────────────────────────────────────────────────────────────

describe('matchHost — EXACT_IP', () => {
  it('matches a single CI by IP with EXACT_IP confidence', async () => {
    mockQueryRaw.mockResolvedValueOnce([
      { level: 1, id: 'ci-1', name: 'SRV-MYGESTR01D' },
    ]);

    const result = await matchHost(prisma, { ip: '10.100.12.61' });

    expect(result).toEqual({
      confidence: 'EXACT_IP',
      ci: { id: 'ci-1', name: 'SRV-MYGESTR01D' },
    });
    expect(mockQueryRaw).toHaveBeenCalledTimes(1);
  });

  it('does not query the DB at all for an input with neither a valid IP nor a hostname', async () => {
    const result = await matchHost(prisma, { ip: 'not-an-ip' });

    expect(result).toEqual({ confidence: 'UNMATCHED' });
    expect(mockQueryRaw).not.toHaveBeenCalled();
  });
});

// ── UNMATCHED ────────────────────────────────────────────────────────────

describe('matchHost — UNMATCHED', () => {
  it('returns UNMATCHED when the IP exists on no CI and there is no other identity to fall back on', async () => {
    mockQueryRaw.mockResolvedValueOnce([]);

    const result = await matchHost(prisma, { ip: '10.100.12.99' });

    expect(result).toEqual({ confidence: 'UNMATCHED' });
  });
});

// ── AMBIGUOUS ────────────────────────────────────────────────────────────

describe('matchHost — AMBIGUOUS', () => {
  it('returns AMBIGUOUS with both candidates when two CIs share the same IP, without falling back to a lower level', async () => {
    // Same level (1 = EXACT_IP) for both rows — this is what the SQL
    // would return if two CIs both have admin_ip = the scanned IP.
    mockQueryRaw.mockResolvedValueOnce([
      { level: 1, id: 'ci-1', name: 'SRV-A' },
      { level: 1, id: 'ci-2', name: 'SRV-B' },
    ]);

    const result = await matchHost(prisma, { ip: '10.100.12.61' });

    expect(result).toEqual({
      confidence: 'AMBIGUOUS',
      candidates: [
        { id: 'ci-1', name: 'SRV-A' },
        { id: 'ci-2', name: 'SRV-B' },
      ],
    });
    // A single query call — the cascade never issues a second, lower-level
    // query after finding ambiguity (it's all one UNION ALL statement).
    expect(mockQueryRaw).toHaveBeenCalledTimes(1);
  });

  it('does not collapse ambiguity by picking the CI with the shortest name (the anti-pattern this module replaces)', async () => {
    mockQueryRaw.mockResolvedValueOnce([
      { level: 1, id: 'ci-long', name: 'SRV-LONG-NAME-01' },
      { level: 1, id: 'ci-short', name: 'SRV' },
    ]);

    const result = await matchHost(prisma, { ip: '10.100.12.61' });

    expect(result.confidence).toBe('AMBIGUOUS');
    if (result.confidence === 'AMBIGUOUS') {
      expect(result.candidates).toHaveLength(2);
      expect(result.candidates.map((c) => c.id).sort()).toEqual(['ci-long', 'ci-short']);
    }
  });

  it('only considers rows at the minimum level present when deciding ambiguity (a single CI at level 1 plus other CIs at level 5 is not ambiguous)', async () => {
    mockQueryRaw.mockResolvedValueOnce([
      { level: 1, id: 'ci-1', name: 'SRV-MYGESTR01D' },
      { level: 5, id: 'ci-2', name: 'SRV-MYGESTR01D-OLD' },
      { level: 5, id: 'ci-3', name: 'SRV-MYGESTR01D-DR' },
    ]);

    const result = await matchHost(prisma, { ip: '10.100.12.61', hostname: 'SRV-MYGESTR01D' });

    expect(result).toEqual({
      confidence: 'EXACT_IP',
      ci: { id: 'ci-1', name: 'SRV-MYGESTR01D' },
    });
  });
});

// ── EXACT_NAME / EXACT_HOSTNAME / EXACT_DNS / FUZZY levels ─────────────────

describe('matchHost — cascade levels below EXACT_IP', () => {
  it('reports EXACT_NAME when the lowest level present is 2', async () => {
    mockQueryRaw.mockResolvedValueOnce([{ level: 2, id: 'ci-1', name: 'SRV-MYGESTR01D' }]);

    const result = await matchHost(prisma, { hostname: 'SRV-MYGESTR01D' });

    expect(result).toEqual({
      confidence: 'EXACT_NAME',
      ci: { id: 'ci-1', name: 'SRV-MYGESTR01D' },
    });
  });

  it('reports EXACT_HOSTNAME when the lowest level present is 3 (domain-suffix-stripped host_name match)', async () => {
    mockQueryRaw.mockResolvedValueOnce([{ level: 3, id: 'ci-1', name: 'SRV-MYGESTR01D' }]);

    const result = await matchHost(prisma, { hostname: 'SRV-MYGESTR01D' });

    expect(result).toEqual({
      confidence: 'EXACT_HOSTNAME',
      ci: { id: 'ci-1', name: 'SRV-MYGESTR01D' },
    });

    // Assert the stripped hostname was actually passed as a bind param for
    // the level-3 branch (see param-order test below for the precise slot);
    // here we just confirm the raw call happened with the hostname value
    // present somewhere in the bind params.
    const values = mockQueryRaw.mock.calls[0].slice(1);
    expect(values).toContain('SRV-MYGESTR01D');
  });

  it('reports EXACT_DNS when the lowest level present is 4', async () => {
    mockQueryRaw.mockResolvedValueOnce([{ level: 4, id: 'ci-1', name: 'SRV-MYGESTR01D' }]);

    const result = await matchHost(prisma, { hostname: 'srv-mygestr01d.internal.example' });

    expect(result).toEqual({
      confidence: 'EXACT_DNS',
      ci: { id: 'ci-1', name: 'SRV-MYGESTR01D' },
    });
  });

  it('reports FUZZY when the lowest level present is 5', async () => {
    mockQueryRaw.mockResolvedValueOnce([{ level: 5, id: 'ci-1', name: 'SRV-MYGESTR01D-BACKUP' }]);

    const result = await matchHost(prisma, { hostname: 'MYGESTR01D' });

    expect(result).toEqual({
      confidence: 'FUZZY',
      ci: { id: 'ci-1', name: 'SRV-MYGESTR01D-BACKUP' },
    });
  });
});

// ── Hostname domain-suffix stripping (param-level proof) ───────────────────

describe('matchHost — hostname domain-suffix normalization', () => {
  it('passes both the raw hostname and the domain-stripped hostname as bind params', async () => {
    mockQueryRaw.mockResolvedValueOnce([{ level: 3, id: 'ci-1', name: 'SRV-MYGESTR01D' }]);

    await matchHost(prisma, { hostname: 'SRV-MYGESTR01D' });

    const [strings, ...values] = mockQueryRaw.mock.calls[0];
    // sanity: tagged-template call shape (strings array + interpolated values)
    expect(Array.isArray(strings)).toBe(true);
    // hostname has no dot, so raw === stripped; both bind slots carry the
    // same value here — the important thing is neither is undefined/null.
    expect(values).toContain('SRV-MYGESTR01D');
  });

  it('derives the stripped hostname by cutting at the first dot for a fully-qualified input', async () => {
    mockQueryRaw.mockResolvedValueOnce([]);

    await matchHost(prisma, { hostname: 'SRV-MYGESTR01D.azkar.com' });

    const values = mockQueryRaw.mock.calls[0].slice(1);
    // full hostname used for levels 2/3(exact)/4
    expect(values).toContain('SRV-MYGESTR01D.azkar.com');
    // domain-stripped hostname used for level 3's split_part comparison
    expect(values).toContain('SRV-MYGESTR01D');
  });
});

// ── FUZZY level LIKE-escaping (param-level proof) ───────────────────────────

describe('matchHost — FUZZY level LIKE escaping', () => {
  it('escapes %, _, and \\ in the hostname before building the LIKE pattern, and wraps it in wildcards', async () => {
    mockQueryRaw.mockResolvedValueOnce([]);

    await matchHost(prisma, { hostname: '100%_done\\srv' });

    const values = mockQueryRaw.mock.calls[0].slice(1);
    const likeParam = values[values.length - 1];

    expect(likeParam).toBe('%100\\%\\_done\\\\srv%');
    // Prove none of the raw special characters leak through unescaped
    // adjacent to a wildcard in a way that would let them act as wildcards.
    expect(likeParam).not.toContain('%_done');
    expect(likeParam).not.toContain('%done\\srv%'.replace('\\\\', '\\'));
  });

  it('never falls back to $queryRawUnsafe or string-concatenated SQL (the mocked $queryRaw is the only DB call)', async () => {
    mockQueryRaw.mockResolvedValueOnce([]);

    await matchHost(prisma, { hostname: "'; DROP TABLE configuration_items; --" });

    expect(mockQueryRaw).toHaveBeenCalledTimes(1);
    const values = mockQueryRaw.mock.calls[0].slice(1);
    // The dangerous string travels only as a bound parameter value, never
    // spliced into the SQL text (the first element of the call args is the
    // fixed strings array from the tagged template, unaffected by input).
    const [strings] = mockQueryRaw.mock.calls[0];
    expect(strings.join('')).not.toContain('DROP TABLE');
    expect(values).toContain("'; DROP TABLE configuration_items; --");
  });
});

// backend/src/services/systemInfoService.ts
//
// Builds a live snapshot of the platform's tech stack:
//  - Versions detected at runtime from process + node_modules
//  - EOL dates fetched from endoflife.date (cached 24h)
//  - License types are static (update manually when adding new deps)
//
// Frontend-only packages (Next.js, React, Tailwind CSS) are hardcoded here
// because they are not installed in the backend container.
// ⚠️  UPDATE FRONTEND_VERSIONS whenever you bump frontend/package.json.

import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

// ── Types ──────────────────────────────────────────────────────────────────────

interface EolApiResponse {
  cycle:              string;
  releaseDate:        string;
  eol:                string | boolean;
  latest:             string;
  latestReleaseDate:  string;
  lts?:               string | boolean;
  support?:           string | boolean;
}

export interface StackComponent {
  name:           string;
  category:       string;
  version:        string;
  latestVersion?: string;
  eolDate?:       string | boolean;   // ISO date | false (no EOL) | undefined (no data)
  isEol:          boolean;
  daysToEol?:     number;             // negative = already past EOL
  license:        string;
  hasEolData:     boolean;
}

export interface SystemInfoResponse {
  components:   StackComponent[];
  generatedAt:  string;
}

// ── Static maps ────────────────────────────────────────────────────────────────

// Products with pages on endoflife.date → product slug
const EOL_PRODUCTS: Record<string, string> = {
  'Node.js':    'nodejs',
  'PostgreSQL': 'postgresql',
  'nginx':      'nginx',
  'Next.js':    'nextjs',
};

const LICENSE_MAP: Record<string, string> = {
  'Node.js':      'MIT',
  'Express':      'MIT',
  'Next.js':      'MIT',
  'React':        'MIT',
  'PostgreSQL':   'PostgreSQL License',
  'nginx':        'BSD-2-Clause',
  'Prisma':       'Apache 2.0',
  'TypeScript':   'Apache 2.0',
  'Tailwind CSS': 'MIT',
  'Zod':          'MIT',
  'Helmet':       'MIT',
  'jsonwebtoken': 'MIT',
  'bcrypt':       'MIT',
  'node-cron':    'MIT',
  'nodemailer':   'MIT',
  'multer':       'MIT',
  'ExcelJS':      'MIT',
};

// ⚠️  Keep in sync with frontend/package.json
const FRONTEND_VERSIONS: Record<string, string> = {
  'Next.js':      '16.2.4',
  'React':        '19.2.3',
  'Tailwind CSS': '4.2.1',  // resolved from frontend/package-lock.json
  'ExcelJS':      '4.4.0',
};

// ── Cache ──────────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
let systemInfoCache: { data: SystemInfoResponse; fetchedAt: number } | null = null;

export function clearSystemInfoCache(): void {
  systemInfoCache = null;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function readPkgVersion(pkgName: string): string {
  try {
    const pkgPath = path.join(process.cwd(), 'node_modules', pkgName, 'package.json');
    const raw = fs.readFileSync(pkgPath, 'utf-8');
    return (JSON.parse(raw) as { version?: string }).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

async function fetchEolCycle(product: string, cycle: string): Promise<EolApiResponse | null> {
  try {
    const res = await fetch(`https://endoflife.date/api/${product}/${cycle}.json`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return await res.json() as EolApiResponse;
  } catch {
    return null;
  }
}

function extractCycle(name: string, version: string): string {
  if (!version || version === 'unknown') return 'unknown';
  const v = version.replace(/^v/, '');
  const parts = v.split('.');
  // nginx uses major.minor as cycle (e.g. "1.27")
  if (name === 'nginx') return `${parts[0]}.${parts[1]}`;
  // All others use major only (e.g. "22", "16")
  return parts[0];
}

function daysUntil(dateStr: string): number {
  return Math.floor((new Date(dateStr).getTime() - Date.now()) / 86_400_000);
}

async function getPostgresVersion(prisma: PrismaClient): Promise<string> {
  try {
    const rows = await prisma.$queryRaw<Array<{ version: string }>>`SELECT version()`;
    // "PostgreSQL 16.2 on x86_64-pc-linux-gnu..." → "16.2"
    const match = rows[0]?.version.match(/PostgreSQL (\d+\.\d+)/);
    return match ? match[1] : 'unknown';
  } catch {
    return 'unknown';
  }
}

// ── Main export ────────────────────────────────────────────────────────────────

export async function getSystemInfo(prisma: PrismaClient): Promise<SystemInfoResponse> {
  // Return cached data if still fresh
  if (systemInfoCache && Date.now() - systemInfoCache.fetchedAt < CACHE_TTL_MS) {
    return systemInfoCache.data;
  }

  const postgresVersion = await getPostgresVersion(prisma);

  const defs: Array<{ name: string; category: string; version: string }> = [
    { name: 'Node.js',      category: 'Runtime',   version: process.version.replace(/^v/, '') },
    { name: 'PostgreSQL',   category: 'Database',  version: postgresVersion },
    { name: 'nginx',        category: 'Gateway',   version: process.env.NGINX_VERSION ?? 'unknown' },
    { name: 'Express',      category: 'Framework', version: readPkgVersion('express') },
    { name: 'Prisma',       category: 'ORM',       version: readPkgVersion('@prisma/client') },
    { name: 'Next.js',      category: 'Framework', version: FRONTEND_VERSIONS['Next.js'] },
    { name: 'React',        category: 'Framework', version: FRONTEND_VERSIONS['React'] },
    { name: 'TypeScript',   category: 'Language',  version: readPkgVersion('typescript') },
    { name: 'Tailwind CSS', category: 'Library',   version: FRONTEND_VERSIONS['Tailwind CSS'] },
    { name: 'Zod',          category: 'Library',   version: readPkgVersion('zod') },
    { name: 'Helmet',       category: 'Library',   version: readPkgVersion('helmet') },
    { name: 'jsonwebtoken', category: 'Library',   version: readPkgVersion('jsonwebtoken') },
    { name: 'bcrypt',       category: 'Library',   version: readPkgVersion('bcrypt') },
    { name: 'node-cron',    category: 'Library',   version: readPkgVersion('node-cron') },
    { name: 'nodemailer',   category: 'Library',   version: readPkgVersion('nodemailer') },
    { name: 'multer',       category: 'Library',   version: readPkgVersion('multer') },
    { name: 'ExcelJS',      category: 'Library',   version: FRONTEND_VERSIONS['ExcelJS'] },
  ];

  const components: StackComponent[] = await Promise.all(
    defs.map(async (def): Promise<StackComponent> => {
      const license   = LICENSE_MAP[def.name] ?? 'MIT';
      const eolSlug   = EOL_PRODUCTS[def.name];

      // No endoflife.date page for this component
      if (!eolSlug || def.version === 'unknown') {
        return { ...def, license, hasEolData: false, isEol: false };
      }

      const cycle = extractCycle(def.name, def.version);
      if (cycle === 'unknown') {
        return { ...def, license, hasEolData: false, isEol: false };
      }

      const eolData = await fetchEolCycle(eolSlug, cycle);
      if (!eolData) {
        return { ...def, license, hasEolData: false, isEol: false };
      }

      const eolDate  = eolData.eol;
      let isEol      = false;
      let daysToEol: number | undefined;

      if (typeof eolDate === 'string') {
        daysToEol = daysUntil(eolDate);
        isEol     = daysToEol < 0;
      } else if (eolDate === true) {
        isEol = true;
      }

      return {
        ...def,
        latestVersion: eolData.latest,
        eolDate,
        isEol,
        daysToEol,
        license,
        hasEolData: true,
      };
    })
  );

  const result: SystemInfoResponse = { components, generatedAt: new Date().toISOString() };
  systemInfoCache = { data: result, fetchedAt: Date.now() };
  return result;
}

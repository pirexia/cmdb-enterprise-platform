# UI Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refresh the CMDB Platform UI to a Corporate Dark aesthetic with CSS-variable-based theming (sidebar color + accent color), company logo upload, and hamburger responsive navigation — all configurable by admins via the Settings panel without redeployment.

**Architecture:** A new `AppSettings` key-value table stores theme config. Five new backend endpoints (two public, three admin-only) expose and mutate these settings. A `ThemeContext` on the frontend fetches the theme at startup and injects CSS custom properties into `<head>`, which all refactored components consume via `bg-[var(--sidebar-bg)]` / `bg-[var(--accent)]` Tailwind classes.

**Tech Stack:** Next.js 16 App Router (Client Components), Tailwind CSS v4, Express 5, Prisma 6, PostgreSQL 15, multer (already installed).

---

## File Map

| Status | File | Change |
|--------|------|--------|
| CREATE | `backend/prisma/migrations/20260419000000_add_app_settings/migration.sql` | AppSettings table + seed |
| MODIFY | `backend/prisma/schema.prisma` | Add AppSettings model |
| MODIFY | `backend/src/index.ts` | 5 new endpoints (insert before cron section ~L3694) |
| MODIFY | `frontend/app/globals.css` | Add CSS custom property defaults |
| CREATE | `frontend/contexts/ThemeContext.tsx` | Theme fetch + CSS var injection |
| MODIFY | `frontend/app/layout.tsx` | Wrap with ThemeProvider |
| MODIFY | `frontend/components/Sidebar.tsx` | CSS vars, sharp corners, onClose prop |
| MODIFY | `frontend/components/AppShell.tsx` | Hamburger state, mobile layout |
| CREATE | `frontend/components/TopBar.tsx` | Mobile-only topbar with hamburger |
| MODIFY | `frontend/app/login/page.tsx` | Fetch theme, apply to header + button |
| MODIFY | `frontend/app/settings/page.tsx` | Add Branding tab |
| MODIFY | `frontend/locales/es.json` | New keys under `settings.branding` |
| MODIFY | `frontend/locales/en.json` | Same keys in English |
| MODIFY | `frontend/locales/de.json` | Same keys in German |
| MODIFY | `frontend/locales/pt.json` | Same keys in Portuguese |
| MODIFY | `frontend/locales/fr.json` | Same keys in French |
| MODIFY | `frontend/locales/it.json` | Same keys in Italian |
| MODIFY | `docs/USER_MANUAL.md` + `.en.md` | New Branding section in Settings chapter |
| MODIFY | `docs/SYSADMIN_MANUAL.md` + `.en.md` | Replace env-var theming with DB theming |
| MODIFY | `docs/ARCHITECTURE.md` + `.en.md` | AppSettings table, ThemeContext, new endpoints |

---

## Task 1: DB Migration — AppSettings table

**Files:**
- Create: `backend/prisma/migrations/20260419000000_add_app_settings/migration.sql`

- [ ] **Step 1: Create migration directory and SQL file**

```bash
mkdir -p backend/prisma/migrations/20260419000000_add_app_settings
```

Write `backend/prisma/migrations/20260419000000_add_app_settings/migration.sql`:

```sql
CREATE TABLE IF NOT EXISTS "AppSettings" (
  "key"        TEXT PRIMARY KEY,
  "value"      TEXT NOT NULL DEFAULT '',
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO "AppSettings" ("key", "value") VALUES
  ('sidebar_bg',    '#0f172a'),
  ('accent_color',  '#3b82f6'),
  ('company_name',  'CMDB Platform'),
  ('logo_data',     ''),
  ('logo_mime',     '')
ON CONFLICT ("key") DO NOTHING;
```

- [ ] **Step 2: Apply migration**

```bash
sg docker -c "docker exec cmdb-backend npx prisma migrate deploy"
```

Expected output: `1 migration applied` (or similar count).

- [ ] **Step 3: Verify table exists**

```bash
sg docker -c "docker exec cmdb-postgres psql -U admin -d cmdb_db -c \"SELECT key, value FROM \\\"AppSettings\\\" ORDER BY key;\""
```

Expected: 5 rows (sidebar_bg, accent_color, company_name, logo_data, logo_mime).

---

## Task 2: Prisma Schema — AppSettings model

**Files:**
- Modify: `backend/prisma/schema.prisma`

- [ ] **Step 1: Add AppSettings model at end of schema.prisma**

Open `backend/prisma/schema.prisma` and append before the final newline:

```prisma
model AppSettings {
  key       String   @id
  value     String   @default("")
  updatedAt DateTime @updatedAt @map("updated_at")

  @@map("AppSettings")
}
```

- [ ] **Step 2: Regenerate Prisma client**

```bash
sg docker -c "docker exec cmdb-backend npx prisma generate"
```

Expected: `Generated Prisma Client`.

- [ ] **Step 3: TypeScript check (no new errors)**

```bash
cd backend && npx tsc --noEmit 2>&1 | grep -v "license\|licenseUser" | grep "error TS" | head -20
```

Expected: no output (zero new errors).

- [ ] **Step 4: Commit**

```bash
git add backend/prisma/migrations/20260419000000_add_app_settings/migration.sql backend/prisma/schema.prisma
git commit -m "feat(db): add AppSettings table for theme/branding configuration"
```

---

## Task 3: Backend — Theme and Logo endpoints

**Files:**
- Modify: `backend/src/index.ts` (insert block after line ~3692, before the cron section)

- [ ] **Step 1: Insert the new routes block**

Find the line in `backend/src/index.ts` that reads:
```
// ─── Daily Alert Cron (08:30 AM every day) ───
```
Insert the following block **immediately before** that line:

```typescript
// ─── App Settings — Theme & Branding ─────────────────────────────────────────

const logoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 }, // 2 MB
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/png', 'image/jpeg', 'image/webp'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Tipo de imagen no permitido. Use PNG, JPEG o WebP.'));
    }
  },
});

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

const ThemeUpdateSchema = z.object({
  sidebarBg:   z.string().regex(HEX_COLOR_RE).optional(),
  accentColor: z.string().regex(HEX_COLOR_RE).optional(),
  companyName: z.string().min(1).max(100).trim().optional(),
});

async function getSettingsMap(): Promise<Record<string, string>> {
  const rows = await prisma.appSettings.findMany();
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

/**
 * GET /api/settings/theme — public (needed for login page before auth)
 */
app.get('/api/settings/theme', async (_req: Request, res: Response) => {
  try {
    const s = await getSettingsMap();
    res.json({
      sidebarBg:   s['sidebar_bg']   ?? '#0f172a',
      accentColor: s['accent_color'] ?? '#3b82f6',
      companyName: s['company_name'] ?? 'CMDB Platform',
      hasLogo:     !!(s['logo_data'] && s['logo_data'].length > 0),
    });
  } catch (error) {
    log.error('[GET /api/settings/theme] Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/settings/logo — public, returns binary image
 */
app.get('/api/settings/logo', async (_req: Request, res: Response) => {
  try {
    const s = await getSettingsMap();
    if (!s['logo_data'] || s['logo_data'].length === 0) {
      res.status(404).json({ error: 'No logo configured' });
      return;
    }
    const buf = Buffer.from(s['logo_data'], 'base64');
    res.setHeader('Content-Type', s['logo_mime'] || 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(buf);
  } catch (error) {
    log.error('[GET /api/settings/logo] Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PUT /api/settings/theme — ADMIN only
 */
app.put('/api/settings/theme', authenticateToken, requireAdmin, async (req: Request, res: Response) => {
  const parsed = ThemeUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() });
    return;
  }
  const { sidebarBg, accentColor, companyName } = parsed.data;
  const updates: { key: string; value: string }[] = [];
  if (sidebarBg)   updates.push({ key: 'sidebar_bg',   value: sidebarBg });
  if (accentColor) updates.push({ key: 'accent_color', value: accentColor });
  if (companyName !== undefined) updates.push({ key: 'company_name', value: companyName });
  if (updates.length === 0) {
    res.status(400).json({ error: 'No fields to update' });
    return;
  }
  try {
    await Promise.all(
      updates.map((u) =>
        prisma.appSettings.upsert({
          where:  { key: u.key },
          update: { value: u.value },
          create: { key: u.key, value: u.value },
        })
      )
    );
    await prisma.$executeRaw`
      INSERT INTO "audit_logs"(id, action, entity, entity_id, user_email, created_at)
      VALUES (gen_random_uuid(), 'UPDATE_THEME', 'AppSettings', 'theme', ${req.user!.email}, now())
    `;
    res.json({ ok: true });
  } catch (error) {
    log.error('[PUT /api/settings/theme] Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/settings/logo — ADMIN only, multipart/form-data field "logo"
 */
app.post('/api/settings/logo', authenticateToken, requireAdmin, logoUpload.single('logo'), async (req: Request, res: Response) => {
  if (!req.file) {
    res.status(400).json({ error: 'No se adjuntó ningún archivo' });
    return;
  }
  const buf = req.file.buffer;
  const isPng  = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  const isJpeg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  const isWebP = buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46;
  if (!isPng && !isJpeg && !isWebP) {
    res.status(400).json({ error: 'El archivo no es una imagen válida (PNG, JPEG o WebP)' });
    return;
  }
  try {
    const b64 = buf.toString('base64');
    await prisma.appSettings.upsert({
      where:  { key: 'logo_data' },
      update: { value: b64 },
      create: { key: 'logo_data', value: b64 },
    });
    await prisma.appSettings.upsert({
      where:  { key: 'logo_mime' },
      update: { value: req.file.mimetype },
      create: { key: 'logo_mime', value: req.file.mimetype },
    });
    await prisma.$executeRaw`
      INSERT INTO "audit_logs"(id, action, entity, entity_id, user_email, created_at)
      VALUES (gen_random_uuid(), 'UPDATE_LOGO', 'AppSettings', 'logo', ${req.user!.email}, now())
    `;
    res.json({ ok: true });
  } catch (error) {
    log.error('[POST /api/settings/logo] Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * DELETE /api/settings/logo — ADMIN only
 */
app.delete('/api/settings/logo', authenticateToken, requireAdmin, async (req: Request, res: Response) => {
  try {
    for (const key of ['logo_data', 'logo_mime']) {
      await prisma.appSettings.upsert({
        where:  { key },
        update: { value: '' },
        create: { key, value: '' },
      });
    }
    await prisma.$executeRaw`
      INSERT INTO "audit_logs"(id, action, entity, entity_id, user_email, created_at)
      VALUES (gen_random_uuid(), 'DELETE_LOGO', 'AppSettings', 'logo', ${req.user!.email}, now())
    `;
    res.json({ ok: true });
  } catch (error) {
    log.error('[DELETE /api/settings/logo] Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});
```

- [ ] **Step 2: TypeScript check**

```bash
cd backend && npx tsc --noEmit 2>&1 | grep -v "license\|licenseUser" | grep "error TS" | head -20
```

Expected: no output.

- [ ] **Step 3: Rebuild backend and smoke-test endpoints**

```bash
sg docker -c "docker compose up -d --build backend"
```

Then obtain a token and test:

```bash
# Public endpoints (no auth required)
curl -sk https://localhost/api/settings/theme | python3 -m json.tool
# Expected: {"sidebarBg":"#0f172a","accentColor":"#3b82f6","companyName":"CMDB Platform","hasLogo":false}

curl -sk -o /dev/null -w "%{http_code}" https://localhost/api/settings/logo
# Expected: 404

# Admin token
TOKEN=$(curl -sk -X POST https://localhost/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"claude@cmdb.local","password":"Claude@Test24!"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")

# Update theme
curl -sk -X PUT https://localhost/api/settings/theme \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"sidebarBg":"#0f172a","accentColor":"#3b82f6","companyName":"Test Corp"}' | python3 -m json.tool
# Expected: {"ok":true}

# Restore defaults
curl -sk -X PUT https://localhost/api/settings/theme \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"companyName":"CMDB Platform"}'
```

- [ ] **Step 4: Commit**

```bash
git add backend/src/index.ts
git commit -m "feat(api): add AppSettings theme/logo endpoints (GET public, PUT/POST/DELETE admin)"
```

---

## Task 4: ThemeContext + globals.css

**Files:**
- Modify: `frontend/app/globals.css`
- Create: `frontend/contexts/ThemeContext.tsx`

- [ ] **Step 1: Add CSS custom property defaults to globals.css**

In `frontend/app/globals.css`, add inside the existing `:root` block:

```css
:root {
  --background: #ffffff;
  --foreground: #171717;
  --sidebar-bg: #0f172a;
  --accent:     #3b82f6;
}
```

- [ ] **Step 2: Create ThemeContext.tsx**

Create `frontend/contexts/ThemeContext.tsx`:

```tsx
"use client";

import React, { createContext, useContext, useEffect, useState } from "react";

interface ThemeData {
  companyName: string;
  logoUrl: string | null;
  loading: boolean;
}

const ThemeContext = createContext<ThemeData>({
  companyName: "CMDB Platform",
  logoUrl: null,
  loading: true,
});

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [companyName, setCompanyName] = useState("CMDB Platform");
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/settings/theme")
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { sidebarBg: string; accentColor: string; companyName: string; hasLogo: boolean } | null) => {
        if (!data) return;
        setCompanyName(data.companyName);
        setLogoUrl(data.hasLogo ? "/api/settings/logo" : null);

        const style = document.getElementById("theme-vars") ?? (() => {
          const s = document.createElement("style");
          s.id = "theme-vars";
          document.head.appendChild(s);
          return s;
        })();
        style.textContent = `:root { --sidebar-bg: ${data.sidebarBg}; --accent: ${data.accentColor}; }`;
      })
      .catch(() => { /* silently use CSS defaults */ })
      .finally(() => setLoading(false));
  }, []);

  return (
    <ThemeContext.Provider value={{ companyName, logoUrl, loading }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}

```

- [ ] **Step 3: Commit**

```bash
git add frontend/app/globals.css frontend/contexts/ThemeContext.tsx
git commit -m "feat(theme): add ThemeContext with CSS var injection and globals.css defaults"
```

---

## Task 5: layout.tsx — Wrap with ThemeProvider

**Files:**
- Modify: `frontend/app/layout.tsx`

- [ ] **Step 1: Update layout.tsx**

Replace the content of `frontend/app/layout.tsx` with:

```tsx
import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { AuthProvider } from "@/contexts/AuthContext";
import { LanguageProvider } from "@/contexts/LanguageContext";
import { ThemeProvider } from "@/contexts/ThemeContext";
import AppShell from "@/components/AppShell";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "CMDB Enterprise Platform",
  description: "Configuration Management Database — Inventory Dashboard",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
        <ThemeProvider>
          <LanguageProvider>
            <AuthProvider>
              <AppShell>{children}</AppShell>
            </AuthProvider>
          </LanguageProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/app/layout.tsx
git commit -m "feat(theme): wrap app with ThemeProvider in layout.tsx"
```

---

## Task 6: Sidebar.tsx — CSS vars + sharp corners

**Files:**
- Modify: `frontend/components/Sidebar.tsx`

- [ ] **Step 1: Replace Sidebar.tsx entirely**

Replace `frontend/components/Sidebar.tsx` with:

```tsx
"use client";

import React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard, Monitor, FileText, Building2, Settings,
  Server, Network, User, LogOut, Plug, Shield, BarChart,
  ClipboardList, UserCircle, FolderOpen, Key,
} from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { useLanguage, LOCALE_NAMES } from "@/contexts/LanguageContext";
import { useTheme } from "@/contexts/ThemeContext";
import type { Locale } from "@/contexts/LanguageContext";

type NavLink = { type: "link"; labelKey: string; href: string; icon: React.ElementType; roles?: string[] };
type NavSeparator = { type: "separator" };
type NavEntry = NavLink | NavSeparator;

const SEP: NavSeparator = { type: "separator" };

const NAV_ITEMS: NavEntry[] = [
  { type: "link", labelKey: "sidebar.profile",         href: "/profile",        icon: UserCircle                                },
  SEP,
  { type: "link", labelKey: "sidebar.dashboard",       href: "/",               icon: LayoutDashboard                           },
  { type: "link", labelKey: "sidebar.inventory",       href: "/inventory",      icon: Monitor                                   },
  { type: "link", labelKey: "sidebar.contracts",       href: "/contracts",      icon: FileText                                  },
  { type: "link", labelKey: "sidebar.licenses",        href: "/licenses",       icon: Key                                       },
  { type: "link", labelKey: "sidebar.map",             href: "/map",            icon: Network                                   },
  { type: "link", labelKey: "sidebar.documents",       href: "/documents",      icon: FolderOpen                                },
  { type: "link", labelKey: "sidebar.vulnerabilities", href: "/vulnerabilities", icon: Shield                                   },
  { type: "link", labelKey: "sidebar.reports",         href: "/reports",        icon: BarChart                                  },
  SEP,
  { type: "link", labelKey: "sidebar.integrations",    href: "/integrations",   icon: Plug,         roles: ["ADMIN"]            },
  { type: "link", labelKey: "sidebar.masters",         href: "/admin/masters",  icon: Building2,    roles: ["ADMIN"]            },
  { type: "link", labelKey: "sidebar.audit",           href: "/audit",          icon: ClipboardList, roles: ["ADMIN","AUDITOR"] },
  { type: "link", labelKey: "sidebar.settings",        href: "/settings",       icon: Settings,     roles: ["ADMIN"]            },
];

function LangSelector() {
  const { locale, setLocale } = useLanguage();
  return (
    <select
      value={locale}
      onChange={(e) => setLocale(e.target.value as Locale)}
      className="border border-white/10 bg-white/5 px-1.5 py-0.5 text-[11px] text-slate-400 focus:border-[var(--accent)] focus:outline-none cursor-pointer"
    >
      {(Object.entries(LOCALE_NAMES) as [Locale, string][]).map(([code, name]) => (
        <option key={code} value={code} className="bg-slate-900 text-slate-300">{name}</option>
      ))}
    </select>
  );
}

interface SidebarProps {
  onClose?: () => void;
}

export default function Sidebar({ onClose }: SidebarProps) {
  const pathname               = usePathname();
  const { user, logout }       = useAuth();
  const userRole               = user?.role ?? "";
  const { t }                  = useLanguage();
  const { companyName, logoUrl } = useTheme();

  const visible = NAV_ITEMS.filter(
    (item) => item.type === "separator" || !item.roles || item.roles.includes(userRole)
  );
  const clean = visible.filter((item, i, arr) => {
    if (item.type !== "separator") return true;
    const prev = arr[i - 1];
    const next = arr[i + 1];
    return prev && prev.type !== "separator" && next && next.type !== "separator";
  });

  return (
    <aside
      className="flex h-screen w-64 flex-shrink-0 flex-col"
      style={{ backgroundColor: "var(--sidebar-bg)" }}
    >
      {/* Brand */}
      <div className="flex items-center gap-2.5 border-b border-white/8 px-5 py-4">
        {logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={logoUrl} alt={companyName} className="h-8 w-8 object-contain" />
        ) : (
          <div
            className="flex h-8 w-8 flex-shrink-0 items-center justify-center"
            style={{ backgroundColor: "var(--accent)" }}
          >
            <Server className="h-4 w-4 text-white" />
          </div>
        )}
        <div className="leading-tight min-w-0">
          <p className="text-sm font-bold text-slate-100 truncate">{companyName}</p>
          <p className="text-[10px] text-slate-500 uppercase tracking-wider">
            {t("brand.tagline")}
          </p>
        </div>
        {/* Mobile close button */}
        {onClose && (
          <button
            onClick={onClose}
            className="ml-auto flex-shrink-0 p-1 text-slate-500 hover:text-slate-300 md:hidden"
            aria-label="Cerrar menú"
          >
            ✕
          </button>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-0.5">
        {clean.map((item, i) => {
          if (item.type === "separator") {
            return <hr key={`sep-${i}`} className="my-2 border-white/8" />;
          }
          const { labelKey, href, icon: Icon } = item;
          const isActive = href === "/" ? pathname === "/" : pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              onClick={onClose}
              className={`flex items-center gap-3 px-3 py-2.5 text-sm font-medium transition-colors border-l-2 ${
                isActive
                  ? "border-l-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent)]"
                  : "border-l-transparent text-slate-400 hover:bg-white/5 hover:text-slate-200"
              }`}
            >
              <Icon className="h-5 w-5 flex-shrink-0" strokeWidth={1.5} />
              {t(labelKey)}
            </Link>
          );
        })}
      </nav>

      {/* User info + logout + language */}
      <div className="border-t border-white/8 px-4 py-3 space-y-2">
        {user && (
          <div className="flex items-center gap-2.5">
            <div
              className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full"
              style={{ backgroundColor: "var(--accent)", opacity: 0.2 }}
            >
              <User className="h-4 w-4" style={{ color: "var(--accent)", opacity: 1 }} />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold text-slate-300 truncate">{user.username}</p>
              <span className={`inline-block px-1.5 py-0.5 text-[10px] font-semibold ${
                user.role === "ADMIN"   ? "bg-red-900/60 text-red-300"    :
                user.role === "AUDITOR" ? "bg-amber-900/60 text-amber-300" :
                                          "bg-slate-700 text-slate-400"
              }`}>
                {user.role}
              </span>
            </div>
            <button
              onClick={logout}
              title={t("actions.logout")}
              className="flex-shrink-0 p-1.5 text-slate-500 hover:text-slate-300 transition-colors"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        )}
        <div className="flex items-center justify-between">
          <p className="text-[10px] text-slate-600">
            {t("footer.copyright", { year: new Date().getFullYear() })}
          </p>
          <LangSelector />
        </div>
      </div>
    </aside>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/components/Sidebar.tsx
git commit -m "feat(ui): refactor Sidebar to CSS vars, sharp corners, onClose prop"
```

---

## Task 7: TopBar.tsx + AppShell.tsx — Hamburger responsive

**Files:**
- Create: `frontend/components/TopBar.tsx`
- Modify: `frontend/components/AppShell.tsx`

- [ ] **Step 1: Create TopBar.tsx**

Create `frontend/components/TopBar.tsx`:

```tsx
"use client";

import { Menu } from "lucide-react";
import { useTheme } from "@/contexts/ThemeContext";

interface TopBarProps {
  onMenuClick: () => void;
}

export default function TopBar({ onMenuClick }: TopBarProps) {
  const { companyName, logoUrl } = useTheme();

  return (
    <header
      className="flex h-13 flex-shrink-0 items-center gap-3 px-4 md:hidden"
      style={{ backgroundColor: "var(--sidebar-bg)" }}
    >
      <button
        onClick={onMenuClick}
        className="p-1.5 text-slate-400 hover:text-slate-200 transition-colors"
        aria-label="Abrir menú"
      >
        <Menu className="h-5 w-5" />
      </button>
      <div className="flex flex-1 items-center justify-center gap-2">
        {logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={logoUrl} alt={companyName} className="h-6 w-6 object-contain" />
        ) : null}
        <span className="text-sm font-bold text-slate-100 truncate">{companyName}</span>
      </div>
    </header>
  );
}
```

- [ ] **Step 2: Update AppShell.tsx**

Replace `frontend/components/AppShell.tsx` with:

```tsx
"use client";

import { useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
import { useLanguage } from "@/contexts/LanguageContext";
import Sidebar from "@/components/Sidebar";
import TopBar from "@/components/TopBar";

const PUBLIC_PATHS = ["/login", "/privacy"];

export default function AppShell({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const { t }             = useLanguage();
  const router            = useRouter();
  const pathname          = usePathname();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const isPublic = PUBLIC_PATHS.includes(pathname);

  useEffect(() => {
    if (loading) return;
    if (!user && !isPublic) router.replace("/login");
    else if (user && isPublic) router.replace("/");
  }, [user, loading, isPublic, router]);

  // Close sidebar on route change (mobile)
  useEffect(() => { setSidebarOpen(false); }, [pathname]);

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-slate-50">
        <div className="flex items-center gap-3 text-slate-400">
          <div className="h-5 w-5 animate-spin border-2 border-slate-300 border-t-[var(--accent)]" />
          <span className="text-sm">{t("common.loading")}</span>
        </div>
      </div>
    );
  }

  if (isPublic) return <>{children}</>;
  if (!user) return null;

  return (
    <div className="flex h-screen flex-col bg-slate-50 md:flex-row">
      {/* Mobile topbar */}
      <TopBar onMenuClick={() => setSidebarOpen(true)} />

      {/* Mobile sidebar backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/50 md:hidden"
          onClick={() => setSidebarOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Sidebar — fixed overlay on mobile, static on desktop */}
      <div
        className={`fixed inset-y-0 left-0 z-40 transition-transform duration-200 ease-in-out md:relative md:translate-x-0 ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <Sidebar onClose={() => setSidebarOpen(false)} />
      </div>

      <main className="flex-1 overflow-y-auto">{children}</main>
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add frontend/components/TopBar.tsx frontend/components/AppShell.tsx
git commit -m "feat(ui): add hamburger responsive layout — TopBar + AppShell mobile support"
```

---

## Task 8: login/page.tsx — Apply theme

**Files:**
- Modify: `frontend/app/login/page.tsx`

- [ ] **Step 1: Add theme state and fetch to login page**

In `frontend/app/login/page.tsx`, inside the `LoginPage` component, replace the existing env-var reads with a `useEffect` fetch. Find this block near the top of the component:

```tsx
  const companyName = process.env.NEXT_PUBLIC_COMPANY_NAME || "CMDB Platform";
  const themeColor  = process.env.NEXT_PUBLIC_THEME_COLOR  || "#4f46e5";
  const ttlDays     = process.env.NEXT_PUBLIC_TRUSTED_DEVICE_TTL_DAYS || "30";
```

Replace it with:

```tsx
  const ttlDays = process.env.NEXT_PUBLIC_TRUSTED_DEVICE_TTL_DAYS || "30";

  const [themeColor,  setThemeColor]  = useState("#0f172a");
  const [accentColor, setAccentColor] = useState("#3b82f6");
  const [companyName, setCompanyName] = useState("CMDB Platform");
  const [hasLogo,     setHasLogo]     = useState(false);

  useEffect(() => {
    fetch(`${process.env.NEXT_PUBLIC_API_URL ?? ""}/api/settings/theme`)
      .then((r) => r.ok ? r.json() : null)
      .then((d: { sidebarBg: string; accentColor: string; companyName: string; hasLogo: boolean } | null) => {
        if (!d) return;
        setThemeColor(d.sidebarBg);
        setAccentColor(d.accentColor);
        setCompanyName(d.companyName);
        setHasLogo(d.hasLogo);
      })
      .catch(() => { /* use defaults */ });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
```

- [ ] **Step 2: Update logo rendering in login page header band**

Find the header band div in the login page (around line ~232):

```tsx
          <div className="px-8 py-7 text-center" style={{ backgroundColor: themeColor }}>
            <div className="inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-white/20 backdrop-blur-sm mb-3">
              {meta.icon}
            </div>
```

Replace the inner icon div with a conditional that shows the logo when available:

```tsx
          <div className="px-8 py-7 text-center" style={{ backgroundColor: themeColor }}>
            <div className="inline-flex h-14 w-14 items-center justify-center bg-white/20 mb-3 mx-auto">
              {hasLogo
                // eslint-disable-next-line @next/next/no-img-element
                ? <img src={`${process.env.NEXT_PUBLIC_API_URL ?? ""}/api/settings/logo`} alt={companyName} className="h-10 w-10 object-contain" />
                : meta.icon
              }
            </div>
```

- [ ] **Step 3: Update submit button to use accentColor**

Find the submit button in the credentials step:

```tsx
                <button type="submit" disabled={loading}
                  className="flex w-full items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-60 disabled:cursor-not-allowed transition-colors">
```

Replace with:

```tsx
                <button type="submit" disabled={loading}
                  className="flex w-full items-center justify-center gap-2 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
                  style={{ backgroundColor: accentColor }}>
```

Also update the MFA verify button (same pattern — `bg-indigo-600 hover:bg-indigo-700` → `style={{ backgroundColor: accentColor }}`). There are two: one in `mfa_verify` step and one in `mfa_suggest` step.

- [ ] **Step 4: TypeScript check**

```bash
cd backend && npx tsc --noEmit 2>&1 | grep -v "license\|licenseUser" | grep "error TS" | head -20
```

Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/login/page.tsx
git commit -m "feat(ui): apply dynamic theme to login page header and buttons"
```

---

## Task 9: Settings — Branding tab + locale keys

**Files:**
- Modify: `frontend/app/settings/page.tsx`
- Modify: `frontend/locales/es.json` (and en, de, pt, fr, it)

- [ ] **Step 1: Add locale keys to all 6 locale files**

In each locale file, find the `"settings"` object and add a `"branding"` sub-object. Add **after** the existing `"tabs"` object:

**es.json** — add inside `"settings"`:
```json
"branding": {
  "tab": "Apariencia",
  "logo_title": "Logo de la empresa",
  "logo_hint": "PNG, JPEG o WebP · Máx. 2 MB",
  "logo_upload_btn": "Subir logo",
  "logo_remove_btn": "Eliminar logo",
  "logo_preview": "Vista previa",
  "colors_title": "Colores",
  "sidebar_color": "Color de sidebar",
  "accent_color": "Color de acento",
  "preview_title": "Vista previa en vivo",
  "company_name_title": "Nombre de la empresa",
  "apply_btn": "Aplicar cambios",
  "save_success": "Configuración guardada",
  "save_error": "Error al guardar"
}
```

**en.json**:
```json
"branding": {
  "tab": "Appearance",
  "logo_title": "Company logo",
  "logo_hint": "PNG, JPEG or WebP · Max 2 MB",
  "logo_upload_btn": "Upload logo",
  "logo_remove_btn": "Remove logo",
  "logo_preview": "Preview",
  "colors_title": "Colors",
  "sidebar_color": "Sidebar color",
  "accent_color": "Accent color",
  "preview_title": "Live preview",
  "company_name_title": "Company name",
  "apply_btn": "Apply changes",
  "save_success": "Settings saved",
  "save_error": "Error saving settings"
}
```

**de.json**:
```json
"branding": {
  "tab": "Erscheinungsbild",
  "logo_title": "Firmenlogo",
  "logo_hint": "PNG, JPEG oder WebP · Max. 2 MB",
  "logo_upload_btn": "Logo hochladen",
  "logo_remove_btn": "Logo entfernen",
  "logo_preview": "Vorschau",
  "colors_title": "Farben",
  "sidebar_color": "Seitenleistenfarbe",
  "accent_color": "Akzentfarbe",
  "preview_title": "Live-Vorschau",
  "company_name_title": "Firmenname",
  "apply_btn": "Änderungen übernehmen",
  "save_success": "Einstellungen gespeichert",
  "save_error": "Fehler beim Speichern"
}
```

**pt.json**:
```json
"branding": {
  "tab": "Aparência",
  "logo_title": "Logotipo da empresa",
  "logo_hint": "PNG, JPEG ou WebP · Máx. 2 MB",
  "logo_upload_btn": "Enviar logotipo",
  "logo_remove_btn": "Remover logotipo",
  "logo_preview": "Pré-visualização",
  "colors_title": "Cores",
  "sidebar_color": "Cor da barra lateral",
  "accent_color": "Cor de destaque",
  "preview_title": "Pré-visualização em tempo real",
  "company_name_title": "Nome da empresa",
  "apply_btn": "Aplicar alterações",
  "save_success": "Configurações guardadas",
  "save_error": "Erro ao guardar"
}
```

**fr.json**:
```json
"branding": {
  "tab": "Apparence",
  "logo_title": "Logo de l'entreprise",
  "logo_hint": "PNG, JPEG ou WebP · Max 2 Mo",
  "logo_upload_btn": "Télécharger le logo",
  "logo_remove_btn": "Supprimer le logo",
  "logo_preview": "Aperçu",
  "colors_title": "Couleurs",
  "sidebar_color": "Couleur de la barre latérale",
  "accent_color": "Couleur d'accentuation",
  "preview_title": "Aperçu en direct",
  "company_name_title": "Nom de l'entreprise",
  "apply_btn": "Appliquer les modifications",
  "save_success": "Paramètres enregistrés",
  "save_error": "Erreur lors de l'enregistrement"
}
```

**it.json**:
```json
"branding": {
  "tab": "Aspetto",
  "logo_title": "Logo aziendale",
  "logo_hint": "PNG, JPEG o WebP · Max 2 MB",
  "logo_upload_btn": "Carica logo",
  "logo_remove_btn": "Rimuovi logo",
  "logo_preview": "Anteprima",
  "colors_title": "Colori",
  "sidebar_color": "Colore barra laterale",
  "accent_color": "Colore accento",
  "preview_title": "Anteprima in tempo reale",
  "company_name_title": "Nome dell'azienda",
  "apply_btn": "Applica modifiche",
  "save_success": "Impostazioni salvate",
  "save_error": "Errore durante il salvataggio"
}
```

- [ ] **Step 2: Add Branding tab to Settings page — type and tab list**

In `frontend/app/settings/page.tsx`, update the `TabId` type (find `type TabId = "users" | "integrations" | "certificates";`) and replace with:

```tsx
type TabId = "users" | "integrations" | "certificates" | "branding";
```

Find the `tabs` array definition and add the Branding entry (ADMIN only — add after the certificates tab in the JSX, conditionally rendered):

```tsx
  const tabs: { id: TabId; label: string; icon: React.ReactNode }[] = [
    { id: "users",        label: t("settings.tabs.users"),              icon: <Users className="h-4 w-4" /> },
    { id: "integrations", label: t("settings.tabs.integrations"),       icon: <Plug  className="h-4 w-4" /> },
    { id: "certificates", label: "SSL/TLS Certificates",               icon: <Shield className="h-4 w-4" /> },
    ...(isAdmin ? [{ id: "branding" as TabId, label: t("settings.branding.tab"), icon: <Settings className="h-4 w-4" /> }] : []),
  ];
```

- [ ] **Step 3: Add Branding tab state**

Add the following state variables to the `SettingsPage` component, after the existing state declarations:

```tsx
  // Branding tab state
  const [sidebarBg,       setSidebarBg]       = useState("#0f172a");
  const [accentColorVal,  setAccentColorVal]  = useState("#3b82f6");
  const [companyNameVal,  setCompanyNameVal]  = useState("CMDB Platform");
  const [hasLogo,         setHasLogo]         = useState(false);
  const [logoPreviewUrl,  setLogoPreviewUrl]  = useState<string | null>(null);
  const [brandingMsg,     setBrandingMsg]     = useState<{ ok: boolean; text: string } | null>(null);
  const [savingBranding,  setSavingBranding]  = useState(false);
  const [logoFile,        setLogoFile]        = useState<File | null>(null);
```

Add a `useEffect` to load current theme when the branding tab is selected (add after the existing `useEffect` for `sysInfo`):

```tsx
  useEffect(() => {
    if (tab !== "branding") return;
    fetch("/api/settings/theme")
      .then((r) => r.ok ? r.json() : null)
      .then((d: { sidebarBg: string; accentColor: string; companyName: string; hasLogo: boolean } | null) => {
        if (!d) return;
        setSidebarBg(d.sidebarBg);
        setAccentColorVal(d.accentColor);
        setCompanyNameVal(d.companyName);
        setHasLogo(d.hasLogo);
      })
      .catch(() => {});
  }, [tab]);
```

- [ ] **Step 4: Add branding handler functions**

Add the following handler functions after the `handleUploadCertificate` function:

```tsx
  const handleLogoFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setLogoFile(file);
    const reader = new FileReader();
    reader.onload = (ev) => setLogoPreviewUrl(ev.target?.result as string);
    reader.readAsDataURL(file);
  };

  const handleLogoUpload = async () => {
    if (!logoFile) return;
    setSavingBranding(true); setBrandingMsg(null);
    try {
      const fd = new FormData();
      fd.append("logo", logoFile);
      const res = await apiFetch("/api/settings/logo", { method: "POST", body: fd });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? "Error");
      setHasLogo(true);
      setLogoFile(null);
      setBrandingMsg({ ok: true, text: t("settings.branding.save_success") });
    } catch (e) {
      setBrandingMsg({ ok: false, text: e instanceof Error ? e.message : t("settings.branding.save_error") });
    } finally {
      setSavingBranding(false);
    }
  };

  const handleLogoDelete = async () => {
    setSavingBranding(true); setBrandingMsg(null);
    try {
      const res = await apiFetch("/api/settings/logo", { method: "DELETE" });
      if (!res.ok) throw new Error("Error");
      setHasLogo(false);
      setLogoPreviewUrl(null);
      setLogoFile(null);
      setBrandingMsg({ ok: true, text: t("settings.branding.save_success") });
    } catch {
      setBrandingMsg({ ok: false, text: t("settings.branding.save_error") });
    } finally {
      setSavingBranding(false);
    }
  };

  const handleThemeApply = async () => {
    setSavingBranding(true); setBrandingMsg(null);
    try {
      const res = await apiFetch("/api/settings/theme", {
        method: "PUT",
        body: JSON.stringify({ sidebarBg, accentColor: accentColorVal, companyName: companyNameVal }),
      });
      if (!res.ok) { const d = await res.json(); throw new Error(d.error ?? "Error"); }
      // Apply CSS vars immediately
      const style = document.getElementById("theme-vars");
      if (style) style.textContent = `:root { --sidebar-bg: ${sidebarBg}; --accent: ${accentColorVal}; }`;
      setBrandingMsg({ ok: true, text: t("settings.branding.save_success") });
    } catch (e) {
      setBrandingMsg({ ok: false, text: e instanceof Error ? e.message : t("settings.branding.save_error") });
    } finally {
      setSavingBranding(false);
    }
  };
```

Note: `apiFetch` does not support `FormData` body with a `Content-Type: application/json` header override, so when calling with `FormData`, do NOT pass `Content-Type` — let the browser set it automatically with the boundary. The existing `apiFetch` wrapper passes `Content-Type: application/json` by default. For the logo upload, use `fetch` directly with credentials:

Replace `handleLogoUpload` with this version that avoids the apiFetch header override:

```tsx
  const handleLogoUpload = async () => {
    if (!logoFile) return;
    setSavingBranding(true); setBrandingMsg(null);
    try {
      const token = typeof window !== "undefined" ? localStorage.getItem("token") : null;
      const fd = new FormData();
      fd.append("logo", logoFile);
      const res = await fetch("/api/settings/logo", {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        credentials: "include",
        body: fd,
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? "Error");
      setHasLogo(true);
      setLogoFile(null);
      setBrandingMsg({ ok: true, text: t("settings.branding.save_success") });
    } catch (e) {
      setBrandingMsg({ ok: false, text: e instanceof Error ? e.message : t("settings.branding.save_error") });
    } finally {
      setSavingBranding(false);
    }
  };
```

- [ ] **Step 5: Add Branding tab JSX panel**

Find the section in the settings page JSX where tabs are rendered (look for `{tab === "certificates" && (` or similar). After the last tab panel closing `)}`, add:

```tsx
            {tab === "branding" && isAdmin && (
              <div className="space-y-8">
                {/* Feedback message */}
                {brandingMsg && (
                  <div className={`flex items-center gap-2 px-4 py-3 text-sm border ${
                    brandingMsg.ok
                      ? "border-green-200 bg-green-50 text-green-700"
                      : "border-red-200 bg-red-50 text-red-600"
                  }`}>
                    {brandingMsg.text}
                  </div>
                )}

                {/* Logo block */}
                <section>
                  <h3 className="text-sm font-semibold text-slate-700 mb-4">{t("settings.branding.logo_title")}</h3>
                  <div className="flex items-start gap-6">
                    <div className="flex h-20 w-20 flex-shrink-0 items-center justify-center border border-slate-200 bg-slate-50">
                      {logoPreviewUrl
                        // eslint-disable-next-line @next/next/no-img-element
                        ? <img src={logoPreviewUrl} alt="preview" className="h-16 w-16 object-contain" />
                        : hasLogo
                        // eslint-disable-next-line @next/next/no-img-element
                        ? <img src="/api/settings/logo" alt="logo" className="h-16 w-16 object-contain" />
                        : <span className="text-xs text-slate-400">{t("settings.branding.logo_preview")}</span>
                      }
                    </div>
                    <div className="space-y-2">
                      <label className="block">
                        <span className="text-xs text-slate-500 block mb-1">{t("settings.branding.logo_hint")}</span>
                        <input
                          type="file"
                          accept="image/png,image/jpeg,image/webp"
                          onChange={handleLogoFileChange}
                          className="block text-xs text-slate-600 file:mr-3 file:border-0 file:bg-slate-800 file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-white hover:file:bg-slate-700 cursor-pointer"
                        />
                      </label>
                      {logoFile && (
                        <button
                          onClick={handleLogoUpload}
                          disabled={savingBranding}
                          className="px-4 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
                          style={{ backgroundColor: "var(--accent)" }}
                        >
                          {t("settings.branding.logo_upload_btn")}
                        </button>
                      )}
                      {hasLogo && !logoFile && (
                        <button
                          onClick={handleLogoDelete}
                          disabled={savingBranding}
                          className="px-4 py-1.5 text-xs font-semibold text-red-600 border border-red-200 hover:bg-red-50 disabled:opacity-50"
                        >
                          {t("settings.branding.logo_remove_btn")}
                        </button>
                      )}
                    </div>
                  </div>
                </section>

                {/* Company name block */}
                <section>
                  <h3 className="text-sm font-semibold text-slate-700 mb-3">{t("settings.branding.company_name_title")}</h3>
                  <input
                    type="text"
                    value={companyNameVal}
                    onChange={(e) => setCompanyNameVal(e.target.value)}
                    maxLength={100}
                    className="w-full max-w-xs border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 focus:border-[var(--accent)] focus:outline-none"
                  />
                </section>

                {/* Colors block */}
                <section>
                  <h3 className="text-sm font-semibold text-slate-700 mb-4">{t("settings.branding.colors_title")}</h3>
                  <div className="flex flex-wrap gap-6 items-start">
                    <div className="space-y-1.5">
                      <label className="block text-xs font-medium text-slate-600">{t("settings.branding.sidebar_color")}</label>
                      <div className="flex items-center gap-2">
                        <input
                          type="color"
                          value={sidebarBg}
                          onChange={(e) => setSidebarBg(e.target.value)}
                          className="h-8 w-14 cursor-pointer border border-slate-300 p-0.5 bg-white"
                        />
                        <code className="text-xs text-slate-500 font-mono">{sidebarBg}</code>
                      </div>
                    </div>
                    <div className="space-y-1.5">
                      <label className="block text-xs font-medium text-slate-600">{t("settings.branding.accent_color")}</label>
                      <div className="flex items-center gap-2">
                        <input
                          type="color"
                          value={accentColorVal}
                          onChange={(e) => setAccentColorVal(e.target.value)}
                          className="h-8 w-14 cursor-pointer border border-slate-300 p-0.5 bg-white"
                        />
                        <code className="text-xs text-slate-500 font-mono">{accentColorVal}</code>
                      </div>
                    </div>

                    {/* Live mini-preview */}
                    <div className="flex flex-col gap-1">
                      <span className="text-xs font-medium text-slate-600">{t("settings.branding.preview_title")}</span>
                      <div
                        className="flex h-28 w-36 flex-col overflow-hidden border border-slate-200"
                        style={{ backgroundColor: sidebarBg }}
                      >
                        <div className="flex items-center gap-1.5 border-b border-white/10 px-2 py-1.5">
                          <div className="h-3.5 w-3.5 flex-shrink-0" style={{ backgroundColor: accentColorVal }} />
                          <span className="text-[9px] font-bold text-slate-200 truncate">{companyNameVal || "CMDB"}</span>
                        </div>
                        <div className="flex-1 px-2 py-1.5 space-y-1">
                          {["Dashboard","Inventario","Contratos"].map((label, i) => (
                            <div
                              key={label}
                              className="flex items-center gap-1 px-1 py-0.5 text-[8px] border-l-2"
                              style={i === 1
                                ? { borderLeftColor: accentColorVal, backgroundColor: `${accentColorVal}20`, color: accentColorVal }
                                : { borderLeftColor: "transparent", color: "#94a3b8" }
                              }
                            >
                              <div className="h-1.5 w-1.5 rounded-sm bg-current opacity-60" />
                              {label}
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                </section>

                <button
                  onClick={handleThemeApply}
                  disabled={savingBranding}
                  className="px-6 py-2 text-sm font-semibold text-white disabled:opacity-50 transition-colors"
                  style={{ backgroundColor: "var(--accent)" }}
                >
                  {savingBranding ? "..." : t("settings.branding.apply_btn")}
                </button>
              </div>
            )}
```

- [ ] **Step 6: TypeScript check**

```bash
cd backend && npx tsc --noEmit 2>&1 | grep -v "license\|licenseUser" | grep "error TS" | head -20
```

Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add frontend/app/settings/page.tsx frontend/locales/
git commit -m "feat(ui): add Branding tab to Settings — logo upload, color pickers, live preview"
```

---

## Task 10: Full rebuild and smoke test

- [ ] **Step 1: Rebuild all containers**

```bash
sg docker -c "docker compose down && docker compose up -d --build"
```

- [ ] **Step 2: Health check**

```bash
curl -sk https://localhost/api/health | python3 -m json.tool
```

Expected: `{"status":"ok"}` (or similar).

- [ ] **Step 3: Theme endpoint**

```bash
curl -sk https://localhost/api/settings/theme | python3 -m json.tool
```

Expected:
```json
{
  "sidebarBg": "#0f172a",
  "accentColor": "#3b82f6",
  "companyName": "CMDB Platform",
  "hasLogo": false
}
```

- [ ] **Step 4: Visual check in browser**

Open `https://localhost` in the browser:
- Sidebar is dark navy (`#0f172a`), active item has blue left border
- No rounded corners on nav items or sidebar
- Mobile: resize window below 768px → TopBar appears with hamburger ≡
- Mobile: tap ≡ → sidebar slides in, backdrop darkens content
- Login page: header band is dark navy, submit button is blue

- [ ] **Step 5: Admin branding test**

1. Log in as admin (`admin@cmdb.local` — note: MFA setup required, use the TOTP setup flow)
2. Go to Settings → Apariencia tab
3. Change accent color to `#10b981` (green) → Apply
4. Sidebar active item turns green immediately without page reload
5. Change back to `#3b82f6` (blue) → Apply

---

## Task 11: Documentation updates

**Files:**
- Modify: `docs/USER_MANUAL.md` + `docs/USER_MANUAL.en.md`
- Modify: `docs/SYSADMIN_MANUAL.md` + `docs/SYSADMIN_MANUAL.en.md`
- Modify: `docs/ARCHITECTURE.md` + `docs/ARCHITECTURE.en.md`

- [ ] **Step 1: USER_MANUAL.md — add Branding section**

Find the Settings chapter in `docs/USER_MANUAL.md` and add a new section:

```markdown
### Apariencia (solo ADMIN)

La pestaña **Apariencia** permite personalizar el aspecto de la plataforma sin necesidad de reiniciar la aplicación.

**Logo de empresa**
- Formatos admitidos: PNG, JPEG, WebP (máx. 2 MB)
- Haz clic en "Subir logo" para seleccionar el archivo; aparecerá una vista previa
- Haz clic en "Guardar logo" para aplicarlo
- El logo aparece en la barra lateral y en la pantalla de inicio de sesión

**Colores**
- **Color de sidebar**: fondo de la barra de navegación lateral
- **Color de acento**: color de los elementos activos, botones primarios y bordes de enfoque
- Los cambios se aplican en tiempo real al hacer clic en "Aplicar cambios"
- Una mini vista previa muestra el resultado antes de guardar

**Nombre de empresa**
- El nombre aparece en la parte superior de la barra lateral y en la pantalla de inicio de sesión

Todos los cambios quedan registrados en el Registro de Auditoría.
```

Apply equivalent changes in English to `docs/USER_MANUAL.en.md`.

- [ ] **Step 2: SYSADMIN_MANUAL.md — update theming instructions**

Find any references to `NEXT_PUBLIC_THEME_COLOR`, `NEXT_PUBLIC_LOGO_URL`, `NEXT_PUBLIC_COMPANY_NAME` and add a note:

```markdown
> **Nota:** A partir de la versión v2.2.0, el tema visual (colores, logo, nombre de empresa) se configura desde el panel de administración en **Ajustes → Apariencia**. Las variables de entorno `NEXT_PUBLIC_THEME_COLOR`, `NEXT_PUBLIC_LOGO_URL` y `NEXT_PUBLIC_COMPANY_NAME` siguen funcionando como fallback pero ya no son necesarias para la personalización de marca.
```

Apply equivalent in English to `docs/SYSADMIN_MANUAL.en.md`.

- [ ] **Step 3: ARCHITECTURE.md — add AppSettings + ThemeContext**

Find the Database section and add `AppSettings` to the model list:

```markdown
- `AppSettings` — key-value store for runtime configuration (theme colors, company name, logo). Insert-or-update via upsert. Keys: `sidebar_bg`, `accent_color`, `company_name`, `logo_data`, `logo_mime`.
```

Find the Frontend section and add:

```markdown
- `contexts/ThemeContext.tsx` — fetches `GET /api/settings/theme` on mount, injects CSS custom properties (`--sidebar-bg`, `--accent`) into `<head>` via a `<style id="theme-vars">` tag. Exposes `companyName` and `logoUrl` to all components.
- `components/TopBar.tsx` — mobile-only topbar (hidden at `md+`) with hamburger button. Renders company logo/name with the themed background.
```

Find the Backend section and add the new public endpoints to the API list:
```markdown
- `GET /api/settings/theme` — public, returns theme variables
- `GET /api/settings/logo` — public, returns binary logo image
- `PUT /api/settings/theme` — ADMIN, updates theme vars
- `POST /api/settings/logo` — ADMIN, uploads logo (PNG/JPEG/WebP, 2MB max, magic bytes validated)
- `DELETE /api/settings/logo` — ADMIN, removes logo
```

Apply equivalent changes to `docs/ARCHITECTURE.en.md`.

- [ ] **Step 4: Commit documentation**

```bash
git add docs/
git commit -m "docs: update USER_MANUAL, SYSADMIN_MANUAL, ARCHITECTURE for v2.2.0 branding/theme feature"
```

---

## Definition of Done

- [ ] `npx tsc --noEmit` passes with zero new errors
- [ ] `docker compose up -d --build` succeeds cleanly
- [ ] `GET /api/settings/theme` returns defaults without auth
- [ ] Admin can upload logo (PNG ≤2MB) via Settings → Apariencia
- [ ] Admin can change sidebar color and accent color; changes apply immediately
- [ ] Login page reflects theme colors and logo
- [ ] Mobile hamburger opens/closes sidebar with overlay and backdrop
- [ ] All 6 documentation files updated
- [ ] All changes committed with descriptive messages

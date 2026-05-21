# UI Redesign — Design Spec
**Date:** 2026-04-19  
**Status:** Approved by user  

---

## Summary

Full aesthetic refresh of the CMDB Enterprise Platform frontend. Direction: **Corporate Dark** — dark sidebar, clean content area, minimal border-radius, maximalist contrast. All brand colors (sidebar, accent) become CSS custom properties configurable by an admin via the Settings UI. Company logo uploadable through the same panel. Hamburger navigation for mobile.

---

## 1. Visual Direction

**Selected style:** Corporate Dark / Navy (option A from mockups)

| Element | Value |
|---------|-------|
| Sidebar background | `var(--sidebar-bg)` — default `#0f172a` |
| Active nav accent | `var(--accent)` — default `#3b82f6` |
| Content background | `#f8fafc` (unchanged) |
| Card/panel background | `#ffffff` (unchanged) |
| Border radius — sidebar/topbar/stats | `0` (sharp) |
| Border radius — inner cards/inputs | `4px` max |
| Primary font | Geist Sans (unchanged) |

Semantic data colors (criticality red, EOL amber, status green) are **not** theme variables — they remain hardcoded as they convey meaning, not brand.

---

## 2. Database

### New table: `AppSettings`

Migration: `backend/prisma/migrations/<timestamp>_app_settings/migration.sql`

```sql
CREATE TABLE IF NOT EXISTS "AppSettings" (
  "key"        TEXT PRIMARY KEY,
  "value"      TEXT NOT NULL,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Default seed rows
INSERT INTO "AppSettings" ("key", "value") VALUES
  ('sidebar_bg',    '#0f172a'),
  ('accent_color',  '#3b82f6'),
  ('company_name',  'CMDB Platform'),
  ('logo_data',     ''),
  ('logo_mime',     '')
ON CONFLICT ("key") DO NOTHING;
```

Prisma model addition to `schema.prisma`:
```prisma
model AppSettings {
  key        String   @id
  value      String
  updatedAt  DateTime @updatedAt @map("updated_at")

  @@map("AppSettings")
}
```

---

## 3. Backend API

### Public endpoints (no auth)

| Method | Route | Response |
|--------|-------|----------|
| `GET` | `/api/settings/theme` | `{ sidebarBg, accentColor, companyName, hasLogo }` |
| `GET` | `/api/settings/logo` | Binary image with `Content-Type` header |

### Admin endpoints (`requireAdmin`)

| Method | Route | Body | Description |
|--------|-------|------|-------------|
| `PUT` | `/api/settings/theme` | `{ sidebarBg?, accentColor?, companyName? }` | Update theme vars |
| `POST` | `/api/settings/logo` | `multipart/form-data` (field: `logo`) | Upload logo image |
| `DELETE` | `/api/settings/logo` | — | Remove logo, revert to default icon |

### Logo upload constraints
- `multer` fileFilter: `image/png`, `image/jpeg`, `image/webp` only (SVG rejected — XSS risk)
- Max size: 2 MB
- Magic bytes validation after fileFilter: PNG (`89 50 4E 47`), JPEG (`FF D8 FF`), WebP (`52 49 46 46`)
- Stored as base64 in `AppSettings.logo_data`, MIME in `AppSettings.logo_mime`

### Audit logging
Every write to theme/logo inserts an `AuditLog` record:
```
action: "UPDATE_THEME" | "UPDATE_LOGO" | "DELETE_LOGO"
entity: "AppSettings"
entity_id: "theme" | "logo"
user_email: req.user.email
```

### Color validation (backend)
`sidebarBg` and `accentColor` must match `/^#[0-9a-fA-F]{6}$/`. Reject with 400 otherwise.

---

## 4. Frontend — Theme System

### `globals.css` additions
```css
:root {
  --sidebar-bg: #0f172a;
  --accent:     #3b82f6;
}
```

### New: `contexts/ThemeContext.tsx`

- On mount: `GET /api/settings/theme`
- On success: injects `<style id="theme-vars">` into `<head>` with the received values
- Exposes: `{ companyName: string, logoUrl: string | null, loading: boolean }`
- `logoUrl`: `/api/settings/logo` if `hasLogo`, else `null`
- On error: silently uses CSS defaults — app still works

### `layout.tsx`

Wrap `<AuthProvider>` with `<ThemeProvider>`.

### CSS class migration (Tailwind)

| Component | Old class | New class |
|-----------|-----------|-----------|
| Sidebar bg | (hardcoded `bg-[#...]`) | `bg-[var(--sidebar-bg)]` |
| Primary button | `bg-indigo-600 hover:bg-indigo-700` | `bg-[var(--accent)] hover:bg-[var(--accent)]/90` |
| Active nav item bg | `bg-indigo-50` | `bg-[var(--accent)]/10` |
| Active nav text | `text-indigo-700` | `text-[var(--accent)]` |
| Active nav border | `border-l-indigo-500` | `border-l-[var(--accent)]` |
| Focus rings | `focus:ring-indigo-*` | `focus:ring-[var(--accent)]/30` |
| Spinner border | `border-t-indigo-500` | `border-t-[var(--accent)]` |
| User avatar bg | `bg-indigo-100` | `bg-[var(--accent)]/15` |
| MFA code input | `bg-indigo-50 border-indigo-300` | `bg-[var(--accent)]/5 border-[var(--accent)]/40` |

---

## 5. Component Changes

### `Sidebar.tsx`
- Read `companyName`, `logoUrl` from `ThemeContext` (remove `process.env` reads)
- Replace all `indigo-*` classes per migration table above
- Remove `rounded-lg` from nav items → `rounded-none` (sharp lines)
- Accept `onClose?: () => void` prop for mobile overlay close
- Sidebar itself: `rounded-none`, no shadow on desktop

### `AppShell.tsx`
- Add `sidebarOpen: boolean` state (default `false`)
- Desktop (`md+`): sidebar always visible, no changes to content layout
- Mobile (`< md`):
  - Sidebar: `fixed inset-y-0 left-0 z-40 -translate-x-full data-[open=true]:translate-x-0 transition-transform duration-200`
  - Backdrop: `fixed inset-0 z-30 bg-black/50` visible when `sidebarOpen`, click closes sidebar
  - Render `<TopBar>` above `<main>` only on mobile

### New: `components/TopBar.tsx`
- Mobile-only (`md:hidden`)
- Height: `h-13` (52px)
- Background: `bg-[var(--sidebar-bg)]`
- Left: hamburger button (≡) → sets `sidebarOpen = true`
- Center: company logo or company name in white
- Sharp corners, no border-radius

### `login/page.tsx`
- `useEffect` fetches `GET /api/settings/theme` directly (no context available pre-auth)
- Stores `{ sidebarBg, accentColor, companyName, hasLogo }` in local state
- Header band uses `sidebarBg` as background color
- Submit button uses `accentColor`
- Logo: `<img src="/api/settings/logo">` if `hasLogo`, else `<Server>` icon

---

## 6. Settings UI — Branding Tab

**Location:** `/settings` page, new tab `"Apariencia"` (ADMIN only)

### Logo block
- `<input type="file" accept="image/png,image/jpeg,image/webp">` with image preview (FileReader API)
- "Guardar logo" button → `POST /api/settings/logo`
- "Eliminar logo" button (visible if logo exists) → `DELETE /api/settings/logo`
- Error states: file too large, invalid type

### Colors block
- `<input type="color">` labeled "Color de sidebar" (bound to `sidebarBg`)
- `<input type="color">` labeled "Color de acento" (bound to `accentColor`)
- Live mini-preview: a 200×300px mini-sidebar mockup rendered in the page that updates as the user drags the color picker
- "Aplicar colores" → `PUT /api/settings/theme` → ThemeContext re-fetches and updates CSS vars

### Company name block
- Text input for company name
- Saved with the same `PUT /api/settings/theme` call

### Permissions
- Tab hidden for `AUDITOR` and `VIEWER`
- API enforces `requireAdmin` — UI hiding is cosmetic only

---

## 7. Responsive

**Breakpoint:** `md` = 768px

| Viewport | Layout |
|----------|--------|
| `≥ 768px` | Sidebar fixed left, no topbar, content fills remaining width |
| `< 768px` | TopBar sticky top, sidebar hidden (hamburger opens as overlay) |

Transition: `transition-transform duration-200 ease-in-out` on sidebar.
No changes required in any page component — `AppShell` absorbs all responsive logic.

---

## 8. Documentation Updates (post-implementation)

- `docs/USER_MANUAL.md` + `docs/USER_MANUAL.en.md` — new "Apariencia / Branding" section in Settings chapter
- `docs/SYSADMIN_MANUAL.md` + `docs/SYSADMIN_MANUAL.en.md` — remove env var theming instructions, add DB-based theming note
- `docs/ARCHITECTURE.md` + `docs/ARCHITECTURE.en.md` — add `AppSettings` table, ThemeContext, new public endpoints

---

## 9. Definition of Done

- [ ] `npx tsc --noEmit` passes (no new errors beyond known pre-existing ones)
- [ ] `docker compose up -d --build` succeeds
- [ ] `curl -sk https://localhost/api/health` returns 200
- [ ] `GET /api/settings/theme` returns default values without auth
- [ ] Admin can upload logo, change colors, change company name via `/settings`
- [ ] Theme applies immediately after save (no page reload required)
- [ ] Login page reflects theme colors and logo
- [ ] Mobile hamburger opens/closes sidebar with overlay
- [ ] All 6 documentation files updated

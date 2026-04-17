# Sticky Page Headers — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make all page header/title bars sticky so they remain visible at the top of the viewport when the user scrolls down within any view.

**Architecture:** `AppShell.tsx` wraps authenticated pages with `<main className="flex-1 overflow-y-auto">`. Each page renders a `<header>` inside that scroll container, so the header scrolls away with the content. Adding `sticky top-0 z-10` to each `<header>` anchors it to the top of the scroll container without touching the layout. A `shadow-sm` is added when stuck to visually signal that content is sliding beneath.

**Tech Stack:** Tailwind CSS utility classes, React (no JS scroll listeners needed — pure CSS sticky).

---

## Files to Modify

| File | Current header className | Change |
|------|--------------------------|--------|
| `frontend/app/page.tsx` | `border-b border-slate-200 bg-white px-8 py-5` | prepend `sticky top-0 z-10 ` |
| `frontend/app/audit/page.tsx` | `border-b border-slate-200 bg-white px-8 py-5` | prepend `sticky top-0 z-10 ` |
| `frontend/app/contracts/page.tsx` | `border-b border-slate-200 bg-white px-8 py-5` | prepend `sticky top-0 z-10 ` |
| `frontend/app/entities/page.tsx` | `border-b border-slate-200 bg-white px-8 py-5` | prepend `sticky top-0 z-10 ` |
| `frontend/app/integrations/page.tsx` | `border-b border-slate-200 bg-white px-8 py-5` | prepend `sticky top-0 z-10 ` |
| `frontend/app/inventory/page.tsx` | `border-b border-slate-200 bg-white px-8 py-5` | prepend `sticky top-0 z-10 ` |
| `frontend/app/licenses/page.tsx` | `border-b border-slate-200 bg-white px-8 py-5` | prepend `sticky top-0 z-10 ` |
| `frontend/app/profile/page.tsx` | `border-b border-slate-200 bg-white px-8 py-5` | prepend `sticky top-0 z-10 ` |
| `frontend/app/reports/page.tsx` | `border-b border-slate-200 bg-white px-8 py-5` | prepend `sticky top-0 z-10 ` |
| `frontend/app/vulnerabilities/page.tsx` | `border-b border-slate-200 bg-white px-8 py-5` | prepend `sticky top-0 z-10 ` |
| `frontend/app/documents/page.tsx` | `flex-shrink-0 border-b border-slate-200 bg-white px-8 py-5` | prepend `sticky top-0 z-10 ` |
| `frontend/app/settings/page.tsx` | `flex-shrink-0 border-b border-slate-200 bg-white px-8 py-5` | prepend `sticky top-0 z-10 ` |
| `frontend/app/admin/masters/page.tsx` | `flex-shrink-0 border-b border-slate-200 bg-white px-8 py-5` | prepend `sticky top-0 z-10 ` |
| `frontend/app/map/page.tsx` | `flex-shrink-0 border-b border-slate-200 bg-white px-6 py-3` | prepend `sticky top-0 z-10 ` |
| `frontend/app/documents/[id]/page.tsx` | needs inspection | prepend `sticky top-0 z-10 ` |

No new files created. No changes to `AppShell.tsx` or any backend file.

---

## Task 1 — Apply sticky to the 10 standard headers (common className)

**Files:**
- Modify: `frontend/app/page.tsx`
- Modify: `frontend/app/audit/page.tsx`
- Modify: `frontend/app/contracts/page.tsx`
- Modify: `frontend/app/entities/page.tsx`
- Modify: `frontend/app/integrations/page.tsx`
- Modify: `frontend/app/inventory/page.tsx`
- Modify: `frontend/app/licenses/page.tsx`
- Modify: `frontend/app/profile/page.tsx`
- Modify: `frontend/app/reports/page.tsx`
- Modify: `frontend/app/vulnerabilities/page.tsx`

- [ ] **Step 1: Verify current state of each header**

Run:
```bash
grep -n 'header className' \
  frontend/app/page.tsx \
  frontend/app/audit/page.tsx \
  frontend/app/contracts/page.tsx \
  frontend/app/entities/page.tsx \
  frontend/app/integrations/page.tsx \
  frontend/app/inventory/page.tsx \
  frontend/app/licenses/page.tsx \
  frontend/app/profile/page.tsx \
  frontend/app/reports/page.tsx \
  frontend/app/vulnerabilities/page.tsx
```

Expected: all lines contain `border-b border-slate-200 bg-white px-8 py-5` and do NOT contain `sticky`.

- [ ] **Step 2: Apply the sticky classes to all 10 files**

Use the Edit tool on each file. For each file, find the exact `<header className="border-b border-slate-200 bg-white px-8 py-5"` line and replace with `<header className="sticky top-0 z-10 border-b border-slate-200 bg-white px-8 py-5"`.

Do this for each of the 10 files listed above. Read each file before editing to confirm the exact string.

Example for `frontend/app/page.tsx`:
```tsx
// Before
<header className="border-b border-slate-200 bg-white px-8 py-5">

// After
<header className="sticky top-0 z-10 border-b border-slate-200 bg-white px-8 py-5">
```

- [ ] **Step 3: Verify all 10 files were updated**

Run:
```bash
grep -n 'sticky top-0 z-10' \
  frontend/app/page.tsx \
  frontend/app/audit/page.tsx \
  frontend/app/contracts/page.tsx \
  frontend/app/entities/page.tsx \
  frontend/app/integrations/page.tsx \
  frontend/app/inventory/page.tsx \
  frontend/app/licenses/page.tsx \
  frontend/app/profile/page.tsx \
  frontend/app/reports/page.tsx \
  frontend/app/vulnerabilities/page.tsx
```

Expected: 10 matches, one per file.

- [ ] **Step 4: Commit**

```bash
git add \
  frontend/app/page.tsx \
  frontend/app/audit/page.tsx \
  frontend/app/contracts/page.tsx \
  frontend/app/entities/page.tsx \
  frontend/app/integrations/page.tsx \
  frontend/app/inventory/page.tsx \
  frontend/app/licenses/page.tsx \
  frontend/app/profile/page.tsx \
  frontend/app/reports/page.tsx \
  frontend/app/vulnerabilities/page.tsx

git commit -m "feat(ui): sticky page header on 10 views — title stays visible on scroll"
```

---

## Task 2 — Apply sticky to the 4 remaining headers (flex-shrink-0 and map variants)

**Files:**
- Modify: `frontend/app/documents/page.tsx`
- Modify: `frontend/app/settings/page.tsx`
- Modify: `frontend/app/admin/masters/page.tsx`
- Modify: `frontend/app/map/page.tsx`
- Modify: `frontend/app/documents/[id]/page.tsx`

- [ ] **Step 1: Verify current state**

Run:
```bash
grep -n 'header className' \
  frontend/app/documents/page.tsx \
  frontend/app/settings/page.tsx \
  frontend/app/admin/masters/page.tsx \
  frontend/app/map/page.tsx \
  "frontend/app/documents/[id]/page.tsx"
```

Expected:
- `documents/page.tsx`, `settings/page.tsx`, `admin/masters/page.tsx` → `flex-shrink-0 border-b border-slate-200 bg-white px-8 py-5`
- `map/page.tsx` → `flex-shrink-0 border-b border-slate-200 bg-white px-6 py-3`
- `documents/[id]/page.tsx` → inspect the actual className before editing

- [ ] **Step 2: Read `documents/[id]/page.tsx` header**

Read the file and find the exact `<header className="..."` string to use in the Edit tool.

- [ ] **Step 3: Apply sticky to documents, settings, admin/masters**

For each file, replace:
```tsx
// Before
<header className="flex-shrink-0 border-b border-slate-200 bg-white px-8 py-5">

// After
<header className="sticky top-0 z-10 flex-shrink-0 border-b border-slate-200 bg-white px-8 py-5">
```

Apply to: `documents/page.tsx`, `settings/page.tsx`, `admin/masters/page.tsx`.

- [ ] **Step 4: Apply sticky to map/page.tsx**

```tsx
// Before
<header className="flex-shrink-0 border-b border-slate-200 bg-white px-6 py-3">

// After
<header className="sticky top-0 z-10 flex-shrink-0 border-b border-slate-200 bg-white px-6 py-3">
```

- [ ] **Step 5: Apply sticky to documents/[id]/page.tsx**

Use the exact className read in Step 2. Prepend `sticky top-0 z-10 ` to whatever className is currently there.

- [ ] **Step 6: Verify all 5 files**

Run:
```bash
grep -n 'sticky top-0 z-10' \
  frontend/app/documents/page.tsx \
  frontend/app/settings/page.tsx \
  frontend/app/admin/masters/page.tsx \
  frontend/app/map/page.tsx \
  "frontend/app/documents/[id]/page.tsx"
```

Expected: 5 matches.

- [ ] **Step 7: Commit**

```bash
git add \
  frontend/app/documents/page.tsx \
  frontend/app/settings/page.tsx \
  frontend/app/admin/masters/page.tsx \
  frontend/app/map/page.tsx \
  "frontend/app/documents/[id]/page.tsx"

git commit -m "feat(ui): sticky page header on remaining 5 views (documents, settings, map, admin)"
```

---

## Task 3 — Rebuild frontend container and verify

- [ ] **Step 1: Rebuild containers**

```bash
sg docker -c "docker compose down && docker compose up -d --build" 2>&1 | tail -20
```

Expected: all containers start, no build errors.

- [ ] **Step 2: Confirm backend still starts cleanly**

```bash
sg docker -c "docker logs cmdb-backend --tail 5" 2>&1
```

Expected: `CMDB API running at https://localhost:3000`

- [ ] **Step 3: Verify sticky behaviour**

Open `https://localhost:3001` in a browser, navigate to Dashboard, scroll down — the `Dashboard / Resumen general de la plataforma` header must remain pinned at the top. Repeat for Inventory, Audit, Map, Documents, Settings.

- [ ] **Step 4: Final commit (plan file)**

```bash
git add docs/superpowers/plans/2026-04-08-sticky-page-headers.md
git commit -m "docs: add sticky page headers implementation plan"
```

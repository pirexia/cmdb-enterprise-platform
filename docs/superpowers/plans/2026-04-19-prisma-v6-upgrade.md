# Prisma v6 Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade `@prisma/client` and `prisma` from `^5.10.2` to `^6` inside the Docker build, verify no TypeScript regressions, and close issue #82.

**Architecture:** The backend is a single Express file built inside a multi-stage Docker image. Prisma is used both as ORM and as raw-SQL helper (`$queryRaw` / `$executeRaw` tagged template literals + `Prisma.sql` / `Prisma.join` / `Prisma.empty`). The upgrade is a dependency bump — no schema changes, no migrations, no API changes.

**Tech Stack:** Node 22 Alpine, Prisma 6.x (PostgreSQL driver), TypeScript 5.3, Docker multi-stage build.

---

## File Map

| File | Action | Why |
|------|--------|-----|
| `backend/package.json` | Modify — bump `prisma` + `@prisma/client` to `^6` | Entry point for npm install |
| `backend/package-lock.json` | Auto-updated by npm inside container | Lockfile sync |

No other files need changes unless `npx tsc --noEmit` reports new errors from the Prisma 6 type definitions (handled in Task 3).

---

### Task 1: Bump versions in package.json

**Files:**
- Modify: `backend/package.json`

- [ ] **Step 1: Edit package.json**

In `backend/package.json`, change both `prisma` (devDependencies) and `@prisma/client` (dependencies):

```json
"devDependencies": {
  ...
  "prisma": "^6",
  ...
},
"dependencies": {
  ...
  "@prisma/client": "^6",
  ...
}
```

Exact diff (the only two lines that change):

```diff
-    "prisma": "^5.10.2",
+    "prisma": "^6",
```

```diff
-    "@prisma/client": "^5.10.2",
+    "@prisma/client": "^6",
```

- [ ] **Step 2: Commit the bump**

```bash
git add backend/package.json
git commit -m "chore(deps): bump prisma + @prisma/client to ^6 — closes #82"
```

---

### Task 2: Rebuild containers

**Files:** (none — Docker build resolves deps from package.json)

- [ ] **Step 1: Rebuild all containers**

```bash
sg docker -c "docker compose down && docker compose up -d --build"
```

Expected output ends with:
```
✔ Container cmdb-postgres  Started
✔ Container cmdb-backend   Started
✔ Container cmdb-frontend  Started
```

The builder stage runs `npm ci` (which resolves `^6` to the latest Prisma 6 release) and then `npx prisma generate` — these must both succeed.

- [ ] **Step 2: Verify health endpoint**

```bash
curl -sk https://localhost/api/health
```

Expected:
```json
{"status":"ok"}
```

If the container fails to start, check logs:
```bash
sg docker -c "docker logs cmdb-backend --tail 50"
```

---

### Task 3: TypeScript check and fix any regressions

**Files:**
- Modify: `backend/src/index.ts` (only if tsc reports new errors)

- [ ] **Step 1: Run TypeScript check**

```bash
cd backend && npx tsc --noEmit 2>&1 | grep -v "Property 'license' does not exist" | grep -v "Property 'licenseUser' does not exist"
```

Expected: **no output** (the two pre-existing errors are filtered out; anything else is a regression).

- [ ] **Step 2: Handle known Prisma 6 type changes (if errors appear)**

Prisma 6 renames some internal types. The most common regressions and their fixes:

**`Prisma.Sql` type in condition arrays (line 1756):**

If the error is `Type 'PrismaPromise<...>' is not assignable to type 'Sql'`, the fix is:

```typescript
// Before (may error in Prisma 6 strict mode)
const conditions: Prisma.Sql[] = [];

// After (explicit import from internal — only if needed)
const conditions: ReturnType<typeof Prisma.sql>[] = [];
```

**`BigInt` in raw query results:**

Prisma 6 adds stricter generic constraints on `$queryRaw`. If you see errors like `Type 'unknown' is not assignable to type 'UserRow[]'`, ensure the generic is explicit (it already is in this codebase — no change needed unless tsc flags it).

**`Prisma.empty` removed:**

In Prisma 6.x, `Prisma.empty` is still available. If it is not, the replacement is:

```typescript
// Replace Prisma.empty with:
Prisma.sql``
```

- [ ] **Step 3: If no errors — skip to Task 4**

If `tsc --noEmit` output is empty after filtering the two known pre-existing errors, no code changes are needed.

- [ ] **Step 4: Commit any fixes**

Only commit if code changes were made in Step 2:

```bash
git add backend/src/index.ts
git commit -m "fix(types): update Prisma type references for v6 compatibility"
```

---

### Task 4: Smoke-test critical paths

**Files:** (none — runtime verification only)

- [ ] **Step 1: Verify login endpoint accepts credentials**

```bash
curl -sk -c /tmp/cookies.txt -X POST https://localhost/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@example.com","password":"Admin1234!"}' | jq .
```

Expected: `{"user": {...}}` with an HttpOnly `cmdb_token` cookie set.

- [ ] **Step 2: Verify a Prisma ORM query works (CI list)**

```bash
curl -sk -b /tmp/cookies.txt https://localhost/api/ci | jq 'length'
```

Expected: a number (0 or more) — confirms Prisma ORM queries function.

- [ ] **Step 3: Verify a raw SQL query works (audit log)**

```bash
curl -sk -b /tmp/cookies.txt "https://localhost/api/audit?limit=5" | jq 'length'
```

Expected: a number — confirms `$queryRaw` with `Prisma.sql` / `Prisma.join` / `Prisma.empty` functions.

- [ ] **Step 4: Commit smoke-test is done (no file change needed — just proceed)**

---

### Task 5: Push to develop and close issue

- [ ] **Step 1: Push branch to origin**

```bash
git push origin develop
```

- [ ] **Step 2: Close issue #82**

```bash
gh issue close 82 --comment "Resolved by upgrading \`@prisma/client\` and \`prisma\` to \`^6\` (commit \`$(git rev-parse --short HEAD)\`). TypeScript check passes with 0 new errors; health, ORM, and raw-SQL paths verified."
```

---

## Self-Review

**Spec coverage:**
- ✅ Bump `@prisma/client` → `^6` (Task 1)
- ✅ Bump `prisma` → `^6` (Task 1)
- ✅ Run in dev environment / test (Task 2 + 4)
- ✅ TypeScript check (Task 3)
- ✅ Verify `$queryRaw` / `$executeRaw` patterns (Task 3 + 4)
- ✅ Close issue (Task 5)

**Placeholder scan:** No TBD, TODO, or vague steps — all commands and code blocks are complete.

**Type consistency:** `Prisma.Sql`, `Prisma.sql`, `Prisma.join`, `Prisma.empty` referenced consistently with the names already in `index.ts:1756-1761`.

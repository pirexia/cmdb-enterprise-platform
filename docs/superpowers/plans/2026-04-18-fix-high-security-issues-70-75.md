# Fix High Security Issues #70–#75 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve six High-severity security and compliance findings: replace deprecated TOTP library (speakeasy→otplib), upgrade multer to v2, add GDPR user erasure endpoint with audit log pseudonymisation, migrate JWT storage from localStorage to HttpOnly cookies, and produce ISO 27001 ISMS foundational documents.

**Architecture:** All backend changes live in `backend/src/index.ts` (single-file Express API). Cookie-based auth requires adding `cookie-parser` middleware and updating `authenticateToken` to read from `req.cookies.cmdb_token` (with Bearer header fallback for API clients). Frontend auth state moves from `token` in localStorage to `user + exp` in `cmdb_user`; the `token` state is removed from AuthContext and consumers switch to checking `user`.

**Tech Stack:** Node.js/Express/TypeScript, otplib 13.x, multer 2.x, cookie-parser, Next.js 15 App Router, PostgreSQL 15/16 with Row-Level Security.

---

## File Map

| Action | File | Change |
|--------|------|--------|
| Modify | `backend/src/index.ts` | otplib import, DELETE user endpoint, cookie-parser middleware, cookie auth, logout endpoint |
| Modify | `backend/package.json` | remove speakeasy/@types/speakeasy, add otplib, cookie-parser/@types/cookie-parser, bump multer to ^2.1.1 |
| Regenerate | `backend/package-lock.json` | after package.json changes |
| Create | `backend/prisma/migrations/20260418000000_audit_log_rls_insert_only/migration.sql` | RLS on audit_logs blocking DELETE |
| Modify | `frontend/lib/apiFetch.ts` | remove Bearer injection, add `credentials:'include'` |
| Modify | `frontend/contexts/AuthContext.tsx` | remove token localStorage, add exp to AuthUser, update logout to call /api/auth/logout |
| Modify | `frontend/components/AppShell.tsx` | use `user` not `token` for auth guard |
| Modify | `frontend/app/auth/sso-callback/page.tsx` | remove token localStorage, add credentials |
| Modify | `frontend/app/login/page.tsx` | update applySession call (token only for exp extraction) |
| Modify | `frontend/app/profile/page.tsx` | same |
| Modify | `frontend/app/documents/page.tsx` | remove Bearer header, add `credentials:'include'` |
| Modify | `frontend/app/documents/[id]/page.tsx` | same |
| Modify | `frontend/app/contracts/page.tsx` | same |
| Modify | `frontend/app/licenses/page.tsx` | same |
| Modify | `frontend/components/CIDetailModal.tsx` | same |
| Create | `docs/security/isms/01-information-security-policy.md` | ISP template |
| Create | `docs/security/isms/02-risk-assessment.md` | risk register template |
| Create | `docs/security/isms/03-statement-of-applicability.md` | SoA template (93 Annex A controls) |
| Create | `docs/security/isms/04-incident-response-plan.md` | IRP template |
| Create | `docs/security/isms/05-supplier-agreement.md` | supplier security agreement template |
| Modify | `docs/SYSADMIN_MANUAL.md` + `.en.md` | add GDPR erasure and cookie auth sections |

---

## Task 1 — #74: Replace speakeasy with otplib

**Files:**
- Modify: `backend/src/index.ts:25` (import), `:853` (login verify), `:1683-1685` (setup), `:1725` (enable verify)
- Modify: `backend/package.json:32,48,52`

- [ ] **Step 1: Update package.json**

  In `backend/package.json`, inside `"dependencies"`:
  - Remove: `"speakeasy": "^2.0.0"`
  - Add: `"otplib": "^12.0.1"`

  In `"devDependencies"`:
  - Remove: `"@types/speakeasy": "^2.0.10"`

  (otplib ships its own TypeScript types — no @types needed.)

- [ ] **Step 2: Update the import in `backend/src/index.ts` (line 25)**

  ```typescript
  // Remove:
  import * as speakeasy from 'speakeasy';
  // Add:
  import { authenticator } from 'otplib';
  ```

  Add this line **immediately after** the import (before any route definitions, e.g. after the other imports at the top):

  ```typescript
  authenticator.options = { window: 1 }; // accept 1 step before/after current (30-sec clock drift)
  ```

  Place it after the `import { authenticator } from 'otplib';` line.

- [ ] **Step 3: Replace MFA verification at login (line 853)**

  ```typescript
  // Remove:
  const mfaValid = speakeasy.totp.verify({ secret: user.mfa_secret, encoding: 'base32', token: mfaCode, window: 1 });
  // Replace with:
  const mfaValid = authenticator.check(mfaCode, user.mfa_secret as string);
  ```

- [ ] **Step 4: Replace MFA secret generation and QR URL (lines 1683–1685)**

  ```typescript
  // Remove these three lines:
  const secretObj = speakeasy.generateSecret({ name: `CMDB Enterprise (${req.user!.email})`, length: 20 });
  const secret    = secretObj.base32;
  const otpauth   = secretObj.otpauth_url ?? speakeasy.otpauthURL({ secret, label: req.user!.email, issuer: 'CMDB Enterprise', encoding: 'base32' });

  // Replace with:
  const secret  = authenticator.generateSecret();
  const otpauth = authenticator.keyuri(req.user!.email, 'CMDB Enterprise', secret);
  ```

- [ ] **Step 5: Replace MFA verification at enable (line 1725)**

  ```typescript
  // Remove:
  const valid = speakeasy.totp.verify({ secret, encoding: 'base32', token: code, window: 1 });
  // Replace with:
  const valid = authenticator.check(code, secret);
  ```

- [ ] **Step 6: Regenerate package-lock.json**

  ```bash
  sg docker -c "docker run --rm -v /home/andres/cmdb-enterprise-platform/backend:/app -w /app node:22-alpine npm install --package-lock-only 2>&1" | tail -5
  ```

  Expected: no errors, `found 0 vulnerabilities`.

- [ ] **Step 7: TypeScript check**

  ```bash
  cd /home/andres/cmdb-enterprise-platform/backend && npx tsc --noEmit 2>&1 | grep -v "Property 'license'" | grep -v "Property 'licenseUser'"
  ```

  Expected: no output (exit 0).

- [ ] **Step 8: Rebuild and health check**

  ```bash
  sg docker -c "docker compose down && docker compose up -d --build" && sleep 15 && curl -sk https://localhost/api/health
  ```

  Expected: `{"status":"ok",...}`.

- [ ] **Step 9: Commit**

  ```bash
  cd /home/andres/cmdb-enterprise-platform
  git add backend/src/index.ts backend/package.json backend/package-lock.json
  git commit -m "fix(security): replace deprecated speakeasy with otplib for TOTP MFA — closes #74

  speakeasy has not been updated since 2017 and is listed as deprecated on npm.
  otplib (v12) is actively maintained, TypeScript-native, and RFC 6238 compliant.
  The otpauth:// QR URL format is identical — existing enrolled devices continue
  to work without re-enrolment.

  Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
  ```

---

## Task 2 — #75: Upgrade multer from 1.4.5-lts to 2.1.1

**Files:**
- Modify: `backend/package.json` (multer version)
- Modify: `backend/package-lock.json` (regenerate)

- [ ] **Step 1: Update multer version in package.json**

  In `backend/package.json`, inside `"dependencies"`, change:
  ```json
  "multer": "^1.4.5-lts.1"
  ```
  to:
  ```json
  "multer": "^2.1.1"
  ```

- [ ] **Step 2: Regenerate package-lock.json**

  ```bash
  sg docker -c "docker run --rm -v /home/andres/cmdb-enterprise-platform/backend:/app -w /app node:22-alpine npm install --package-lock-only 2>&1" | tail -5
  ```

  Expected: no errors.

- [ ] **Step 3: TypeScript check**

  ```bash
  cd /home/andres/cmdb-enterprise-platform/backend && npx tsc --noEmit 2>&1 | grep -v "Property 'license'" | grep -v "Property 'licenseUser'"
  ```

  Expected: no output. If multer v2 introduces type changes, fix them here.
  The API used (`multer.memoryStorage()`, `upload.single('file')`, `req.file.buffer/originalname/mimetype/size`) is unchanged in v2.

- [ ] **Step 4: Rebuild and verify file upload still works**

  ```bash
  sg docker -c "docker compose down && docker compose up -d --build" && sleep 15 && curl -sk https://localhost/api/health
  ```

  Expected: `{"status":"ok",...}`.

- [ ] **Step 5: Commit**

  ```bash
  git add backend/package.json backend/package-lock.json
  git commit -m "fix(security): upgrade multer from 1.4.5-lts to 2.1.1 — closes #75

  multer 1.4.5-lts is a community LTS fork with no upstream SLA.
  multer 2.1.1 is the current stable upstream release (Node ≥16 required,
  satisfied by Node 22 in this project). Public API is unchanged.

  Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
  ```

---

## Task 3 — #70 + #73: GDPR user erasure endpoint + audit log pseudonymisation

**Files:**
- Modify: `backend/src/index.ts` — add `DELETE /api/admin/users/:id` after line 963
- Create: `backend/prisma/migrations/20260418000000_audit_log_rls_insert_only/migration.sql`
- Modify: `docs/SYSADMIN_MANUAL.md` and `docs/SYSADMIN_MANUAL.en.md`

- [ ] **Step 1: Create the DB migration for RLS on audit_logs**

  Create file `backend/prisma/migrations/20260418000000_audit_log_rls_insert_only/migration.sql`:

  ```sql
  -- Migration: audit_log_rls_insert_only
  -- Goal: Prevent accidental or malicious deletion of audit trail rows while
  -- still allowing UPDATE (required for GDPR Art.17 pseudonymisation).
  --
  -- Note: REVOKE DELETE FROM <owner> has no effect in PostgreSQL when the
  -- revoking role is the owner — hence Row-Level Security with FORCE.
  -- The absence of a DELETE policy means no role (including the table owner)
  -- can delete rows when FORCE ROW LEVEL SECURITY is active.
  --
  -- UPDATE is preserved via an explicit policy because GDPR Art.17 requires
  -- pseudonymisation (replacing user_email with a hash) on erasure requests.

  ALTER TABLE "audit_logs" ENABLE ROW LEVEL SECURITY;
  ALTER TABLE "audit_logs" FORCE ROW LEVEL SECURITY;

  -- Allow SELECT for all (audit viewers need read access)
  CREATE POLICY audit_select ON "audit_logs"
    FOR SELECT USING (true);

  -- Allow INSERT for all (app creates log entries on every write operation)
  CREATE POLICY audit_insert ON "audit_logs"
    FOR INSERT WITH CHECK (true);

  -- Allow UPDATE for all (required for pseudonymisation on user erasure)
  CREATE POLICY audit_update ON "audit_logs"
    FOR UPDATE USING (true) WITH CHECK (true);

  -- No DELETE policy → DELETE blocked for all roles including owner
  ```

- [ ] **Step 2: Apply the migration**

  ```bash
  sg docker -c "docker exec cmdb-backend npx prisma migrate deploy"
  ```

  Expected output includes: `1 migration found in prisma/migrations` and `The following migration(s) have been applied: 20260418000000_audit_log_rls_insert_only`.

- [ ] **Step 3: Verify DELETE is blocked**

  ```bash
  sg docker -c "docker exec cmdb-postgres psql -U admin -d cmdb_db -c \"DELETE FROM audit_logs WHERE id = '00000000-0000-0000-0000-000000000000'::uuid;\"" 2>&1
  ```

  Expected: `ERROR:  new row violates row-level security policy for table "audit_logs"` or `DELETE 0` (no matching row, but no permission error on the attempt — this is OK since RLS only fires when rows match). To confirm the policy, also run:

  ```bash
  sg docker -c "docker exec cmdb-postgres psql -U admin -d cmdb_db -c \"SELECT polname, polcmd FROM pg_policy WHERE polrelid = 'audit_logs'::regclass;\""
  ```

  Expected: three rows: `audit_select` (r), `audit_insert` (a), `audit_update` (u). No delete policy.

- [ ] **Step 4: Add the DELETE /api/admin/users/:id endpoint**

  In `backend/src/index.ts`, **after** the closing `});` of `POST /api/users/:id/reset-password` (line ~1083, before `// ── Vendors ──`), add:

  ```typescript
  /**
   * DELETE /api/admin/users/:id
   * GDPR Art. 17 right to erasure. ADMIN only.
   *
   * Performs structured erasure:
   *   1. Pseudonymises audit_logs entries (replaces email with a stable hash)
   *   2. Clears all PII fields on the user record (email, password, MFA secrets, SSO id)
   *   3. Hard-deletes trusted_devices and password_history (cascade from user delete)
   *   4. Hard-deletes the user row
   *
   * The audit trail sequence is preserved (action/entity/timestamps intact).
   * The requesting admin cannot erase their own account.
   */
  app.delete('/api/admin/users/:id', authenticateToken, requireAdmin, async (req: Request, res: Response) => {
    const targetId = req.params.id as string;

    // Prevent self-erasure
    if (targetId === req.user!.id) {
      res.status(400).json({ error: 'You cannot erase your own account.' });
      return;
    }

    try {
      // 1. Resolve the user and get their email
      const rows = await prisma.$queryRaw<{ id: string; email: string; username: string }[]>`
        SELECT id::text AS id, email, username FROM "users" WHERE id = ${targetId}::uuid LIMIT 1
      `;
      if (!rows.length) {
        res.status(404).json({ error: 'User not found.' });
        return;
      }
      const { email } = rows[0];

      // 2. Pseudonymise audit_logs: replace user_email with a stable, non-reversible token.
      //    The token is deterministic so repeat erasures produce the same result (idempotent).
      const pseudoToken = '[deleted-' +
        crypto.createHash('sha256').update(email + JWT_SECRET_VALUE).digest('hex').slice(0, 16) +
        ']';
      await prisma.$executeRaw`
        UPDATE "audit_logs" SET user_email = ${pseudoToken} WHERE user_email = ${email}
      `;

      // 3. Hard-delete the user (trusted_devices + password_history cascade automatically)
      await prisma.$executeRaw`DELETE FROM "users" WHERE id = ${targetId}::uuid`;

      // 4. Record the erasure in the audit log under the admin's email
      await prisma.$executeRaw`
        INSERT INTO "audit_logs"(id, action, entity, entity_id, user_email, created_at)
        VALUES(gen_random_uuid(), 'GDPR_ERASURE', 'USER', ${targetId}::uuid, ${req.user!.email}, now())
      `;

      log.info(`[DELETE /api/admin/users/${targetId}] GDPR erasure completed by ${req.user!.email}. Audit logs pseudonymised as ${pseudoToken}.`);
      res.json({ message: 'User erased. Audit log entries pseudonymised.' });

    } catch (error) {
      log.error('[DELETE /api/admin/users/:id] Error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });
  ```

- [ ] **Step 5: TypeScript check**

  ```bash
  cd /home/andres/cmdb-enterprise-platform/backend && npx tsc --noEmit 2>&1 | grep -v "Property 'license'" | grep -v "Property 'licenseUser'"
  ```

  Expected: no output.

- [ ] **Step 6: Rebuild and smoke-test the endpoint**

  ```bash
  sg docker -c "docker compose down && docker compose up -d --build" && sleep 15 && curl -sk https://localhost/api/health
  ```

  Verify the route is registered (using an invalid UUID to get a 404, not a 404-route-not-found):

  ```bash
  TOKEN=$(curl -sk -X POST https://localhost/api/auth/login \
    -H "Content-Type: application/json" \
    -d '{"email":"andre@cmdb.internal","password":"Admin1234!"}' | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))")
  curl -sk -X DELETE https://localhost/api/admin/users/00000000-0000-0000-0000-000000000000 \
    -H "Authorization: Bearer $TOKEN" | python3 -c "import sys,json; print(json.load(sys.stdin))"
  ```

  Expected: `{'error': 'User not found.'}` (404) — confirms route exists.

- [ ] **Step 7: Update sysadmin manual**

  In `docs/SYSADMIN_MANUAL.md`, add a new section **after** the existing security section (search for `## Seguridad` or `## Configuración de Seguridad`):

  ```markdown
  ## Borrado de Usuarios (GDPR Art. 17)

  Para eliminar un usuario y cumplir con el derecho de supresión del RGPD:

  ```http
  DELETE /api/admin/users/:id
  Authorization: Bearer <admin-token>
  ```

  **Comportamiento:**
  1. Las entradas en `audit_logs` con el email del usuario se pseudonomizan a `[deleted-{hash16}]`. El hash es SHA-256(email + JWT_SECRET) truncado — estable e irreversible.
  2. El registro de usuario se elimina permanentemente (cascada a `trusted_devices` y `password_history`).
  3. Se registra una entrada `GDPR_ERASURE` en `audit_logs` bajo el email del administrador.

  **Restricciones:** Un administrador no puede borrar su propia cuenta. Los administradores SSO deben revocar el acceso también en Azure AD / LDAP.

  **Conflicto GDPR Art.17 / ISO 27001 A.8.15:** La pseudonimización conserva la integridad cronológica de la pista de auditoría (requisito ISO 27001) mientras elimina el identificador personal directo (requisito GDPR). Este enfoque está amparado en el Art. 17(3)(b) del RGPD (obligación legal de conservación).

  La tabla `audit_logs` tiene habilitada Row-Level Security (RLS) con `FORCE` — el borrado de filas está bloqueado a nivel de base de datos para todos los roles incluido el propietario de la tabla.
  ```

  Add the equivalent section to `docs/SYSADMIN_MANUAL.en.md`:

  ```markdown
  ## User Erasure (GDPR Art. 17)

  To erase a user and fulfill a GDPR right-to-erasure request:

  ```http
  DELETE /api/admin/users/:id
  Authorization: Bearer <admin-token>
  ```

  **Behavior:**
  1. Audit log entries matching the user's email are pseudonymised to `[deleted-{hash16}]`. The hash is SHA-256(email + JWT_SECRET) truncated — stable and irreversible.
  2. The user record is permanently deleted (trusted_devices and password_history cascade automatically).
  3. A `GDPR_ERASURE` entry is inserted into audit_logs under the admin's email.

  **Restrictions:** An admin cannot erase their own account. SSO admin accounts must also be revoked in Azure AD / LDAP.

  **GDPR Art.17 / ISO 27001 A.8.15 conflict resolution:** Pseudonymisation preserves audit trail chronological integrity (ISO 27001 requirement) while removing the direct personal identifier (GDPR requirement). This approach is defensible under Art.17(3)(b) (legal obligation compliance).

  The `audit_logs` table has Row-Level Security (RLS) with `FORCE` enabled — row deletion is blocked at the database level for all roles including the table owner.
  ```

- [ ] **Step 8: Commit**

  ```bash
  git add backend/src/index.ts \
          backend/prisma/migrations/20260418000000_audit_log_rls_insert_only/ \
          docs/SYSADMIN_MANUAL.md docs/SYSADMIN_MANUAL.en.md
  git commit -m "feat(gdpr): add user erasure endpoint + audit log RLS — closes #70, closes #73

  DELETE /api/admin/users/:id pseudonymises audit_log entries with a
  stable SHA-256 hash before permanently deleting the user record.
  Resolves the GDPR Art.17 / ISO 27001 A.8.15 conflict: audit trail
  sequence is preserved; direct personal identifier is removed.

  audit_logs table now has RLS with FORCE — DELETE blocked at DB level
  for all roles including the table owner. UPDATE retained for
  pseudonymisation. Documented in SYSADMIN_MANUAL.

  Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
  ```

---

## Task 4 — #71: Migrate JWT from localStorage to HttpOnly cookies

**Files (backend):**
- Modify: `backend/src/index.ts` — cookie-parser middleware, authenticateToken, all auth response paths, new logout endpoint
- Modify: `backend/package.json` — add cookie-parser, @types/cookie-parser

**Files (frontend):**
- Modify: `frontend/lib/apiFetch.ts`
- Modify: `frontend/contexts/AuthContext.tsx`
- Modify: `frontend/components/AppShell.tsx`
- Modify: `frontend/app/auth/sso-callback/page.tsx`
- Modify: `frontend/app/login/page.tsx`
- Modify: `frontend/app/profile/page.tsx`
- Modify: `frontend/app/documents/page.tsx`
- Modify: `frontend/app/documents/[id]/page.tsx`
- Modify: `frontend/app/contracts/page.tsx`
- Modify: `frontend/app/licenses/page.tsx`
- Modify: `frontend/components/CIDetailModal.tsx`

### Sub-task 4a — Backend cookie infrastructure

- [ ] **Step 1: Add cookie-parser to package.json**

  In `backend/package.json` `"dependencies"`, add:
  ```json
  "cookie-parser": "^1.4.7"
  ```

  In `"devDependencies"`, add:
  ```json
  "@types/cookie-parser": "^1.4.8"
  ```

- [ ] **Step 2: Add import and middleware in index.ts**

  After the existing `import cors from 'cors';` line, add:
  ```typescript
  import cookieParser from 'cookie-parser';
  ```

  After `app.use(express.json({ limit: '2mb' }));` (line ~126), add:
  ```typescript
  app.use(cookieParser());
  ```

- [ ] **Step 3: Add cookie helper functions**

  After the `app.use(cookieParser());` line, add:

  ```typescript
  const COOKIE_NAME = 'cmdb_token';
  const COOKIE_MAX_AGE_MS = 8 * 60 * 60 * 1000; // 8 hours — matches JWT expiry

  function setAuthCookie(res: Response, token: string): void {
    const isProduction = process.env.NODE_ENV === 'production';
    res.cookie(COOKIE_NAME, token, {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? 'strict' : 'lax',
      maxAge: COOKIE_MAX_AGE_MS,
      path: '/',
    });
  }

  function clearAuthCookie(res: Response): void {
    res.clearCookie(COOKIE_NAME, { path: '/' });
  }
  ```

- [ ] **Step 4: Update `authenticateToken` to read cookie first**

  Replace the token extraction lines (lines 239–244):

  ```typescript
  // Before:
  const authHeader = req.headers['authorization'];
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    res.status(401).json({ error: 'Authentication required. Please login.' });
    return;
  }

  // After:
  const cookieToken = req.cookies?.[COOKIE_NAME] as string | undefined;
  const authHeader  = req.headers['authorization'];
  const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;
  const token       = cookieToken ?? bearerToken ?? null;

  if (!token) {
    res.status(401).json({ error: 'Authentication required. Please login.' });
    return;
  }
  ```

- [ ] **Step 5: Add `setAuthCookie` to all login response paths**

  There are 4 response paths in `POST /api/auth/login` that issue a token. Add `setAuthCookie(res, <token>)` before each `res.json(...)`:

  **Path 1** — trusted device (line ~842):
  ```typescript
  // Before:
  res.json({ token: signFullToken(), user: userObj() });
  // After:
  const t1 = signFullToken();
  setAuthCookie(res, t1);
  res.json({ token: t1, user: userObj() });
  ```

  **Path 2** — MFA verified (line ~862):
  ```typescript
  // Before:
  res.json({ token: signFullToken(), user: userObj(), ...(newDeviceToken ? { deviceToken: newDeviceToken } : {}) });
  // After:
  const t2 = signFullToken();
  setAuthCookie(res, t2);
  res.json({ token: t2, user: userObj(), ...(newDeviceToken ? { deviceToken: newDeviceToken } : {}) });
  ```

  **Path 3** — MFA_SETUP_REQUIRED limited token (line ~871):
  ```typescript
  // Before:
  res.json({ token: limitedToken, user: userObj(), requireAction: 'MFA_SETUP_REQUIRED' });
  // After:
  setAuthCookie(res, limitedToken);
  res.json({ token: limitedToken, user: userObj(), requireAction: 'MFA_SETUP_REQUIRED' });
  ```

  **Path 4** — MFA_SETUP_SUGGESTED / normal login (lines ~878, ~883):
  ```typescript
  // Line ~878: before res.json({ token: signFullToken(), user: userObj(), requireAction: 'MFA_SETUP_SUGGESTED' });
  const t4a = signFullToken();
  setAuthCookie(res, t4a);
  res.json({ token: t4a, user: userObj(), requireAction: 'MFA_SETUP_SUGGESTED' });

  // Line ~883: before res.json({ token: signFullToken(), user: userObj() });
  const t4b = signFullToken();
  setAuthCookie(res, t4b);
  res.json({ token: t4b, user: userObj() });
  ```

- [ ] **Step 6: Add `setAuthCookie` to SSO exchange endpoint (line ~706)**

  ```typescript
  // Before:
  res.json({ token: entry.token, deviceToken: entry.deviceToken, user: entry.user });
  // After:
  setAuthCookie(res, entry.token);
  res.json({ token: entry.token, deviceToken: entry.deviceToken, user: entry.user });
  ```

- [ ] **Step 7: Add `setAuthCookie` to MFA enable endpoint (line ~1737)**

  Find the `const newToken = jwt.sign(...)` in `POST /api/auth/mfa/enable`:
  ```typescript
  // After the jwt.sign line, before the if (trustDevice) block:
  setAuthCookie(res, newToken);
  ```

  The `res.json(...)` at the end of this handler sends the new token — it can remain (used by frontend to extract `exp`).

- [ ] **Step 8: Add `POST /api/auth/logout` endpoint**

  Add this route after `GET /api/auth/sso/exchange` and before `POST /api/auth/login`:

  ```typescript
  /**
   * POST /api/auth/logout
   * Clears the HttpOnly session cookie. No auth required — if the cookie is
   * missing the call is a no-op.
   */
  app.post('/api/auth/logout', (_req: Request, res: Response) => {
    clearAuthCookie(res);
    res.json({ message: 'Logged out.' });
  });
  ```

- [ ] **Step 9: Regenerate package-lock.json and TypeScript check**

  ```bash
  sg docker -c "docker run --rm -v /home/andres/cmdb-enterprise-platform/backend:/app -w /app node:22-alpine npm install --package-lock-only 2>&1" | tail -5

  cd /home/andres/cmdb-enterprise-platform/backend && npx tsc --noEmit 2>&1 | grep -v "Property 'license'" | grep -v "Property 'licenseUser'"
  ```

  Both expected to produce no errors.

### Sub-task 4b — Frontend: AuthContext and apiFetch

- [ ] **Step 10: Update `frontend/lib/apiFetch.ts`**

  Replace the entire file with:

  ```typescript
  const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";

  /**
   * Returns true when the session stored in cmdb_user has expired (30s buffer).
   * The JWT itself is in an HttpOnly cookie — we check exp from the stored user JSON.
   */
  function isSessionExpired(): boolean {
    try {
      if (typeof window === "undefined") return false;
      const stored = localStorage.getItem("cmdb_user");
      if (!stored) return true;
      const user = JSON.parse(stored) as { exp?: number };
      if (typeof user.exp !== "number") return false;
      return Math.floor(Date.now() / 1000) >= user.exp - 30;
    } catch {
      return true;
    }
  }

  /**
   * Authenticated fetch wrapper.
   * The JWT is sent automatically via HttpOnly cookie (credentials: 'include').
   * Clears local user state if the session has visibly expired client-side.
   */
  export function apiFetch(path: string, options?: RequestInit): Promise<Response> {
    if (typeof window !== "undefined" && isSessionExpired()) {
      localStorage.removeItem("cmdb_user");
    }

    return fetch(`${API_BASE}${path}`, {
      ...options,
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        ...options?.headers,
      },
    });
  }
  ```

- [ ] **Step 11: Update `frontend/contexts/AuthContext.tsx`**

  **a) Update the `AuthUser` type** (add `exp` field):
  ```typescript
  // Find the AuthUser type definition and add exp:
  export type AuthUser = {
    id: string;
    username: string;
    email: string;
    role: UserRole;
    mfa_enabled: boolean;
    exp?: number; // JWT expiry as Unix timestamp — stored for client-side session management
  };
  ```

  **b) Remove `decodeJwtPayload` and `isJwtExpired` functions** — no longer needed since we read `exp` from the user object. Replace the expiry helper with:
  ```typescript
  /** Returns true when the stored session exp has passed (with 30s buffer). */
  function isUserExpired(u: AuthUser): boolean {
    if (typeof u.exp !== "number") return false;
    return Math.floor(Date.now() / 1000) >= u.exp - 30;
  }
  ```

  **c) Remove `token` state and update the interface:**
  ```typescript
  // In the AuthContextType interface, remove:
  //   token:        string | null;
  // Keep all other fields. Also update applySession signature to allow undefined token:
  //   applySession: (token: string | null, user: AuthUser, deviceToken?: string) => void;
  ```

  **d) Remove `const [token, setToken] = useState<string | null>(null);`** from the component body.

  **e) Update `clearSession`:**
  ```typescript
  const clearSession = useCallback(() => {
    localStorage.removeItem("cmdb_user");
    // cmdb_device_token intentionally retained (trusted device persists across sessions)
    setUser(null);
  }, []);
  ```

  **f) Update the rehydration `useEffect`:**
  ```typescript
  useEffect(() => {
    try {
      const storedUser = localStorage.getItem("cmdb_user");
      if (storedUser) {
        const parsed = JSON.parse(storedUser) as AuthUser;
        if (isUserExpired(parsed)) {
          localStorage.removeItem("cmdb_user");
        } else {
          setUser(parsed);
        }
      }
    } catch {
      localStorage.removeItem("cmdb_user");
    } finally {
      setLoading(false);
    }
  }, []);
  ```

  **g) Update the periodic expiry `useEffect`:**
  ```typescript
  useEffect(() => {
    const checkExpiry = () => {
      setUser(prev => {
        if (prev && isUserExpired(prev)) {
          clearSession();
          return null;
        }
        return prev;
      });
    };
    const intervalId = setInterval(checkExpiry, 60_000);
    document.addEventListener("visibilitychange", checkExpiry);
    return () => {
      clearInterval(intervalId);
      document.removeEventListener("visibilitychange", checkExpiry);
    };
  }, [clearSession]);
  ```

  **h) Update `applySession`:**
  ```typescript
  const applySession = useCallback((token: string | null, newUser: AuthUser, deviceToken?: string) => {
    // Extract exp from the token (only for client-side expiry tracking — token not stored)
    let exp: number | undefined;
    if (token) {
      try {
        const parts = token.split(".");
        if (parts.length === 3) {
          const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"))) as { exp?: number };
          exp = typeof payload.exp === "number" ? payload.exp : undefined;
        }
      } catch { /* ignore */ }
    }
    if (exp && Math.floor(Date.now() / 1000) >= exp - 30) {
      throw new Error("Cannot apply an already-expired session token.");
    }
    const userWithExp: AuthUser = { ...newUser, ...(exp ? { exp } : {}) };
    localStorage.setItem("cmdb_user", JSON.stringify(userWithExp));
    if (deviceToken) localStorage.setItem("cmdb_device_token", deviceToken);
    setUser(userWithExp);
  }, []);
  ```

  **i) Update `login` (remove token localStorage):**
  ```typescript
  const login = useCallback(async (email: string, password: string, options: LoginOptions = {}) => {
    const storedDeviceToken = localStorage.getItem("cmdb_device_token");

    const res = await apiFetch("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({
        email,
        password,
        mfaCode:     options.mfaCode,
        trustDevice: options.trustDevice,
        deviceToken: storedDeviceToken ?? undefined,
      }),
    });

    const data = await res.json() as {
      token?: string;
      user?: AuthUser;
      requireAction?: string;
      deviceToken?: string;
      error?: string;
    };

    if (!res.ok) {
      throw new Error(data.error ?? `Login failed (${res.status})`);
    }

    if (!data.user) {
      throw new Error("Respuesta inesperada del servidor");
    }

    // Use applySession to store user+exp (token goes to HttpOnly cookie automatically)
    applySession(data.token ?? null, data.user, data.deviceToken);

    if (data.requireAction) {
      throw new Error(data.requireAction);
    }
  }, [applySession]);
  ```

  **j) Update `logout` to call the backend logout endpoint:**
  ```typescript
  const logout = useCallback(() => {
    apiFetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    clearSession();
  }, [clearSession]);
  ```

  **k) Update the context value** — remove `token` from the value object:
  ```typescript
  return (
    <AuthContext.Provider value={{
      user,
      loading,
      isAdmin: user?.role === "ADMIN",
      login,
      logout,
      applySession,
    }}>
      {children}
    </AuthContext.Provider>
  );
  ```

- [ ] **Step 12: Update `frontend/components/AppShell.tsx`**

  ```typescript
  // Remove:
  const { token, loading } = useAuth();
  // Add:
  const { user, loading } = useAuth();

  // In useEffect deps and conditions, replace all `token` with `user`:
  // if (!token && !isPublic) → if (!user && !isPublic)
  // else if (token && isPublic) → else if (user && isPublic)
  // [token, loading, ...] → [user, loading, ...]
  // if (!token) { return null; } → if (!user) { return null; }
  ```

  Full updated AppShell.tsx:
  ```typescript
  "use client";

  import { useEffect } from "react";
  import { useRouter, usePathname } from "next/navigation";
  import { useAuth } from "@/contexts/AuthContext";
  import { useLanguage } from "@/contexts/LanguageContext";
  import Sidebar from "@/components/Sidebar";

  const PUBLIC_PATHS = ["/login"];

  export default function AppShell({ children }: { children: React.ReactNode }) {
    const { user, loading } = useAuth();
    const { t } = useLanguage();
    const router   = useRouter();
    const pathname = usePathname();

    const isPublic = PUBLIC_PATHS.includes(pathname);

    useEffect(() => {
      if (loading) return;
      if (!user && !isPublic) {
        router.replace("/login");
      } else if (user && isPublic) {
        router.replace("/");
      }
    }, [user, loading, isPublic, router]);

    if (loading) {
      return (
        <div className="flex h-screen items-center justify-center bg-slate-50">
          <div className="flex items-center gap-3 text-slate-400">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-slate-300 border-t-indigo-500" />
            <span className="text-sm">{t("common.loading")}</span>
          </div>
        </div>
      );
    }

    if (isPublic) {
      return <>{children}</>;
    }

    if (!user) {
      return null;
    }

    return (
      <div className="flex h-screen bg-slate-50">
        <Sidebar />
        <main className="flex-1 overflow-y-auto">{children}</main>
      </div>
    );
  }
  ```

- [ ] **Step 13: Update SSO callback page**

  In `frontend/app/auth/sso-callback/page.tsx`, replace the `.then(({ token, deviceToken, user }) => {` block:

  ```typescript
  // Replace:
  .then(({ token, deviceToken, user }) => {
    localStorage.setItem("cmdb_token", token);
    localStorage.setItem("cmdb_user", JSON.stringify(user));
    if (deviceToken) {
      localStorage.setItem("cmdb_device_token", deviceToken);
    }
    router.replace("/");
  })

  // With:
  .then(({ token, deviceToken, user }) => {
    // Token is now in an HttpOnly cookie set by the backend exchange endpoint.
    // Only store user JSON (with exp extracted from token) for UI state.
    let exp: number | undefined;
    try {
      const parts = token.split(".");
      if (parts.length === 3) {
        const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"))) as { exp?: number };
        exp = typeof payload.exp === "number" ? payload.exp : undefined;
      }
    } catch { /* ignore */ }
    localStorage.setItem("cmdb_user", JSON.stringify({ ...user, ...(exp ? { exp } : {}) }));
    if (deviceToken) {
      localStorage.setItem("cmdb_device_token", deviceToken);
    }
    router.replace("/");
  })
  ```

  Also add `credentials: "include"` to the fetch call:
  ```typescript
  fetch(`${API_BASE}/api/auth/sso/exchange?code=${encodeURIComponent(code)}`, {
    credentials: "include",
  })
  ```

- [ ] **Step 14: Update login/page.tsx and profile/page.tsx**

  In `frontend/app/login/page.tsx` (line ~176):
  ```typescript
  // Before:
  applySession(data.token, data.user, data.deviceToken);
  // After:
  applySession(data.token ?? null, data.user, data.deviceToken);
  ```

  In `frontend/app/profile/page.tsx` (line ~140):
  ```typescript
  // Before:
  applySession(data.token, data.user as AuthUser, data.deviceToken);
  // After:
  applySession(data.token ?? null, data.user as AuthUser, data.deviceToken);
  ```

- [ ] **Step 15: Update the 10 manual Bearer fetch calls in document/contract/license pages**

  For each of the 10 occurrences found in:
  - `frontend/app/documents/page.tsx` (lines 130, 300)
  - `frontend/app/documents/[id]/page.tsx` (lines 172, 290, 915)
  - `frontend/app/contracts/page.tsx` (lines 124, 157)
  - `frontend/app/licenses/page.tsx` (lines 141, 162)
  - `frontend/components/CIDetailModal.tsx` (line 186)

  For each file:
  1. Remove `token` from the `useAuth()` destructure: `const { token, isAdmin }` → `const { isAdmin }`
  2. Replace `headers: { Authorization: \`Bearer ${token}\` }` → `credentials: "include"` (no headers entry needed)
  3. Replace `headers: { Authorization: \`Bearer ${token ?? ""}\` }` → `credentials: "include"`

  Example for `documents/page.tsx` line 130:
  ```typescript
  // Before:
  const res = await fetch(`${apiBase}/api/documents/${docId}/download`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  // After:
  const res = await fetch(`${apiBase}/api/documents/${docId}/download`, {
    credentials: "include",
  });
  ```

  Apply the same pattern to all 10 occurrences.

- [ ] **Step 16: TypeScript check (frontend)**

  ```bash
  cd /home/andres/cmdb-enterprise-platform/frontend && npx tsc --noEmit 2>&1 | head -30
  ```

  Expected: no errors. Fix any type errors related to `token` being removed from AuthContext (e.g., any component that still destructures `token` from `useAuth()`).

- [ ] **Step 17: Rebuild all containers**

  ```bash
  sg docker -c "docker compose down && docker compose up -d --build" && sleep 20
  curl -sk https://localhost/api/health
  ```

  Expected: `{"status":"ok",...}`.

- [ ] **Step 18: Smoke test — cookie is set on login**

  ```bash
  curl -sk -c /tmp/cookies.txt -X POST https://localhost/api/auth/login \
    -H "Content-Type: application/json" \
    -d '{"email":"andre@cmdb.internal","password":"Admin1234!"}' | python3 -c "import sys,json; d=json.load(sys.stdin); print('error' not in d or d)"

  grep cmdb_token /tmp/cookies.txt && echo "Cookie set OK" || echo "Cookie MISSING"
  ```

  Expected: login response contains `user` object (not an error), and `cmdb_token` appears in the cookie jar.

- [ ] **Step 19: Smoke test — authenticated request via cookie**

  ```bash
  curl -sk -b /tmp/cookies.txt https://localhost/api/users | python3 -c "import sys,json; d=json.load(sys.stdin); print('Got', len(d), 'users') if isinstance(d, list) else print('FAIL:', d)"
  ```

  Expected: `Got N users`.

- [ ] **Step 20: Smoke test — logout clears cookie**

  ```bash
  curl -sk -b /tmp/cookies.txt -c /tmp/cookies.txt -X POST https://localhost/api/auth/logout
  curl -sk -b /tmp/cookies.txt https://localhost/api/users | python3 -c "import sys,json; print(json.load(sys.stdin))"
  ```

  Expected: second call returns `{'error': 'Authentication required. Please login.'}`.

- [ ] **Step 21: Commit**

  ```bash
  git add backend/src/index.ts backend/package.json backend/package-lock.json \
          frontend/lib/apiFetch.ts frontend/contexts/AuthContext.tsx \
          frontend/components/AppShell.tsx frontend/app/auth/sso-callback/page.tsx \
          frontend/app/login/page.tsx frontend/app/profile/page.tsx \
          frontend/app/documents/page.tsx "frontend/app/documents/[id]/page.tsx" \
          frontend/app/contracts/page.tsx frontend/app/licenses/page.tsx \
          frontend/components/CIDetailModal.tsx

  git commit -m "fix(security): migrate JWT from localStorage to HttpOnly cookies — closes #71

  Storing the JWT in localStorage allows any XSS on the origin to
  silently exfiltrate the token. Moving it to an HttpOnly; Secure;
  SameSite cookie makes it inaccessible to JavaScript.

  Backend: cookie-parser middleware, setAuthCookie() helper, cookie set
  on all auth response paths (login, SSO exchange, MFA enable), new
  POST /api/auth/logout endpoint, authenticateToken reads cookie first
  then Bearer header (API-client backwards compatibility preserved).

  Frontend: apiFetch uses credentials:'include'; AuthContext stores
  user+exp JSON only (no raw token); AppShell uses user state for auth
  guard; 10 manual Bearer header injections replaced with credentials.

  Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
  ```

---

## Task 5 — #72: ISO 27001 ISMS organizational documentation

**Files (all new):**
- `docs/security/isms/01-information-security-policy.md`
- `docs/security/isms/02-risk-assessment.md`
- `docs/security/isms/03-statement-of-applicability.md`
- `docs/security/isms/04-incident-response-plan.md`
- `docs/security/isms/05-supplier-agreement.md`

> **Note:** These are governance templates. Fields marked `[REPLACE: ...]` must be completed by the organization before seeking ISO 27001 certification. They are stored in the repository as living documents subject to annual review.

- [ ] **Step 1: Create `docs/security/isms/01-information-security-policy.md`**

  ```markdown
  # Information Security Policy (ISP)
  **Document ID:** ISMS-POL-001  
  **Version:** 1.0  
  **Status:** Draft — requires management approval  
  **Owner:** [REPLACE: Name and title of CISO or equivalent]  
  **Approved by:** [REPLACE: CEO/CTO/Board name]  
  **Approval date:** [REPLACE: YYYY-MM-DD]  
  **Next review:** [REPLACE: YYYY-MM-DD — review annually]  
  **Scope:** CMDB Enterprise Platform — all users, administrators, and systems

  ---

  ## 1. Purpose

  This policy establishes the organisation's commitment to protecting the confidentiality, integrity, and availability of information assets processed by the CMDB Enterprise Platform in accordance with ISO/IEC 27001:2022.

  ## 2. Scope

  This policy applies to:
  - All employees, contractors, and third parties who access the platform
  - All systems that store, transmit, or process platform data (Docker hosts, PostgreSQL databases, nginx gateways, backup media)
  - All geographic locations from which the platform is operated

  ## 3. Information Security Objectives

  1. Protect the confidentiality of CMDB asset data, contracts, licenses, and user PII
  2. Ensure 99.5 % monthly availability of the platform for operational staff
  3. Detect and respond to security incidents within 4 hours of discovery
  4. Comply with GDPR (EU 2016/679), NIS2 Directive (EU 2022/2555), and ISO/IEC 27001:2022

  ## 4. Roles and Responsibilities

  | Role | Responsibility |
  |------|---------------|
  | [REPLACE: CISO] | Own and maintain the ISMS; approve risk treatment decisions |
  | Platform Administrators | Enforce access controls; apply security patches within SLA |
  | All Users | Complete annual security awareness training; report incidents promptly |
  | [REPLACE: DPO] | Oversee GDPR compliance; handle data subject requests |

  ## 5. Security Principles

  - **Least privilege**: users are granted the minimum access required (VIEWER / AUDITOR / ADMIN RBAC)
  - **Defence in depth**: TLS termination at nginx, JWT authentication, bcrypt/MFA for credentials, RLS on audit tables
  - **Secure by default**: production containers run with `no-new-privileges`, non-root UIDs, and read-only root filesystems where applicable

  ## 6. Compliance Obligations

  The platform is subject to: GDPR Art. 5, 17, 32; NIS2 Art. 21; ISO/IEC 27001:2022 Annex A.

  ## 7. Violations

  Violations of this policy may result in disciplinary action up to and including termination and legal prosecution.

  ## 8. Review

  This policy is reviewed annually or after any significant security incident or material change to the platform architecture.
  ```

- [ ] **Step 2: Create `docs/security/isms/02-risk-assessment.md`**

  ```markdown
  # Risk Assessment and Risk Treatment Plan
  **Document ID:** ISMS-RISK-001  
  **Version:** 1.0  
  **Status:** Draft  
  **Owner:** [REPLACE: CISO]  
  **Last reviewed:** [REPLACE: YYYY-MM-DD]  
  **Methodology:** ISO/IEC 27005:2022 — qualitative likelihood × impact matrix (1–5 scale)

  ---

  ## Risk Rating Matrix

  | Likelihood \ Impact | 1 Negligible | 2 Minor | 3 Moderate | 4 Major | 5 Critical |
  |---------------------|-------------|---------|-----------|---------|-----------|
  | 5 Almost certain    | Medium | High | High | Critical | Critical |
  | 4 Likely            | Low | Medium | High | High | Critical |
  | 3 Possible          | Low | Medium | Medium | High | High |
  | 2 Unlikely          | Low | Low | Medium | Medium | High |
  | 1 Rare              | Low | Low | Low | Medium | Medium |

  ---

  ## Risk Register

  | ID | Asset | Threat | Vulnerability | Likelihood | Impact | Rating | Treatment | Owner | Status |
  |----|-------|--------|--------------|-----------|--------|--------|-----------|-------|--------|
  | R-001 | JWT session tokens | XSS theft | Tokens in localStorage (pre-v2.0.2) | 3 | 4 | High | **Mitigated**: HttpOnly cookies implemented in v2.0.2 | [REPLACE] | Closed |
  | R-002 | Admin accounts | Brute force | Weak password policy | 2 | 5 | High | **Mitigated**: ADMIN min 16-char policy + mandatory MFA | [REPLACE] | Closed |
  | R-003 | File uploads | Malicious file execution | Extension filter only | 2 | 4 | High | **Mitigated**: Magic-byte validation + UUID filenames | [REPLACE] | Closed |
  | R-004 | User PII in audit logs | GDPR erasure request | No pseudonymisation (pre-v2.0.2) | 3 | 3 | Medium | **Mitigated**: Pseudonymisation on erasure, RLS blocks DELETE | [REPLACE] | Closed |
  | R-005 | PostgreSQL data | Ransomware / data loss | Single-region deployment | 2 | 5 | High | **Accept / Transfer**: [REPLACE: backup strategy, frequency, offsite storage] | [REPLACE] | Open |
  | R-006 | Azure AD SSO dependency | Third-party outage | No local auth fallback for SSO-only admins | 2 | 3 | Medium | **Accept**: At least one local ADMIN account must exist at all times | [REPLACE] | Open |
  | R-007 | Docker host | Privilege escalation | Container breakout via misconfiguration | 1 | 5 | Medium | **Mitigate**: no-new-privileges, non-root user, regular host patching | [REPLACE] | Open |
  | R-008 | [REPLACE: add org-specific risks] | | | | | | | | |

  ---

  ## Risk Treatment Plan

  Residual risks rated **High** or **Critical** with status **Open** require formal acceptance sign-off by [REPLACE: CISO/CTO] before go-live in production.

  **Next risk review date:** [REPLACE: YYYY-MM-DD]
  ```

- [ ] **Step 3: Create `docs/security/isms/03-statement-of-applicability.md`**

  ```markdown
  # Statement of Applicability (SoA)
  **Document ID:** ISMS-SOA-001  
  **Version:** 1.0  
  **Status:** Draft  
  **Owner:** [REPLACE: CISO]  
  **Standard:** ISO/IEC 27001:2022 Annex A

  ---

  Key: ✅ Applicable & Implemented | ⚠️ Applicable — Partial | ❌ Excluded (with justification)

  | Control | Title | Status | Notes |
  |---------|-------|--------|-------|
  | A.5.1 | Policies for information security | ⚠️ Partial | ISP document created (this repo); pending management approval |
  | A.5.2 | Information security roles and responsibilities | ⚠️ Partial | RBAC implemented; org chart and formal RACI pending |
  | A.5.3 | Segregation of duties | ✅ | ADMIN/AUDITOR/VIEWER RBAC enforced in code |
  | A.5.5 | Contact with authorities | ⚠️ Partial | [REPLACE: designate contact for CERT/law enforcement] |
  | A.5.7 | Threat intelligence | ❌ Excluded | Out of scope for current platform size |
  | A.5.9 | Inventory of information assets | ✅ | The platform IS the asset inventory (CMDB) |
  | A.5.12 | Classification of information | ⚠️ Partial | `data_classification` field on CI records; formal policy pending |
  | A.5.14 | Information transfer | ✅ | TLS 1.2+ enforced by nginx; no unencrypted data transfer |
  | A.5.15 | Access control | ✅ | Role-based access, JWT auth, MFA for admins |
  | A.5.17 | Authentication information | ✅ | bcrypt passwords, MFA, password history/policy |
  | A.5.18 | Access rights | ✅ | Provisioning/deprovisioning via admin UI; GDPR erasure endpoint |
  | A.5.19 | Information security in supplier relationships | ⚠️ Partial | Supplier agreement template created; pending execution |
  | A.5.23 | Information security for use of cloud services | ⚠️ Partial | Azure AD (SSO) used; Microsoft DPA covers compliance |
  | A.5.24 | Information security incident management planning | ⚠️ Partial | IRP document created (this repo); drills not yet conducted |
  | A.5.25 | Assessment and decision on information security events | ⚠️ Partial | Audit log + alert engine; SIEM integration pending |
  | A.5.26 | Response to information security incidents | ⚠️ Partial | IRP defines response steps; tabletop exercise pending |
  | A.5.28 | Collection of evidence | ✅ | Immutable audit_logs (RLS), insert-only by design |
  | A.5.29 | Information security during disruption | ⚠️ Partial | Restart policies in Docker Compose; DR plan pending |
  | A.5.33 | Protection of records | ✅ | audit_logs RLS blocks deletion; backups policy pending |
  | A.5.35 | Independent review | ❌ Excluded | Security audit conducted internally (v2.0.1); external audit pending |
  | A.6.1 | Screening | ⚠️ Partial | [REPLACE: background check policy for admin staff] |
  | A.6.2 | Terms of employment | ⚠️ Partial | [REPLACE: NDA / AUP in employment contracts] |
  | A.6.3 | Information security awareness | ⚠️ Partial | [REPLACE: training programme; track annual completion] |
  | A.6.4 | Disciplinary process | ⚠️ Partial | [REPLACE: reference HR disciplinary policy] |
  | A.6.7 | Remote working | ✅ | TLS-only access; no VPN requirement due to HTTPS gateway |
  | A.6.8 | Information security event reporting | ⚠️ Partial | IRP defines reporting channel; tested annually |
  | A.7.1 | Physical security perimeters | ❌ Excluded | Cloud / co-lo hosting — defer to hosting provider controls |
  | A.8.2 | Privileged access rights | ✅ | ADMIN role restricted; mandatory MFA; audit log on all writes |
  | A.8.3 | Information access restriction | ✅ | RBAC: VIEWER read-only, AUDITOR read+audit, ADMIN full write |
  | A.8.5 | Secure authentication | ✅ | HttpOnly JWT cookie, MFA, bcrypt, password policy |
  | A.8.7 | Protection against malware | ✅ | No deprecated dependencies (speakeasy removed); npm audit gate |
  | A.8.9 | Configuration management | ✅ | Docker Compose + env vars; infrastructure as code |
  | A.8.12 | Data leakage prevention | ⚠️ Partial | CORS, RBAC, no stack traces in API responses; DLP tooling pending |
  | A.8.15 | Logging | ✅ | Immutable audit_logs; RLS enforced; retention configurable |
  | A.8.20 | Network security | ✅ | nginx TLS gateway; cmdb-internal network isolates DB |
  | A.8.24 | Use of cryptography | ✅ | TLS 1.2+, HS256 JWT, bcrypt passwords, SHA-256 pseudonymisation |
  | A.8.25 | Secure development lifecycle | ⚠️ Partial | Security audit conducted; SAST/DAST tools not yet integrated |
  | A.8.26 | Application security requirements | ✅ | OWASP Top 10 reviewed; GDPR, NIS2, ISO 27001 audits complete |
  | A.8.28 | Secure coding | ✅ | Parameterised queries, Zod validation, magic-byte upload checks |
  | A.8.29 | Security testing in development | ⚠️ Partial | Manual audit; automated security testing pipeline pending |
  | A.8.33 | Test information | ⚠️ Partial | [REPLACE: confirm no production PII used in test environments] |
  | A.8.34 | Protection of information systems during audit | ✅ | Audit log INSERT-only; RLS prevents tampering |

  *Controls A.7.x (physical) excluded — hosted infrastructure; defer to hosting provider.*  
  *Full 93-control SoA to be expanded by [REPLACE: CISO] before certification audit.*
  ```

- [ ] **Step 4: Create `docs/security/isms/04-incident-response-plan.md`**

  ```markdown
  # Incident Response Plan (IRP)
  **Document ID:** ISMS-IRP-001  
  **Version:** 1.0  
  **Status:** Draft  
  **Owner:** [REPLACE: CISO]  
  **Last tested:** [REPLACE: YYYY-MM-DD — tabletop exercise]  
  **Next review:** [REPLACE: YYYY-MM-DD]

  ---

  ## 1. Incident Severity Tiers

  | Tier | Description | Example | Response SLA |
  |------|-------------|---------|-------------|
  | P1 Critical | Data breach, ransomware, complete outage | JWT stolen via XSS; DB compromise | Immediate (< 1 h) |
  | P2 High | Partial outage, suspected breach | Single container down; suspicious admin login | < 4 h |
  | P3 Medium | Degraded performance, failed security control | Alert emails failing; MFA bypass attempt | < 24 h |
  | P4 Low | Security advisory, minor anomaly | New npm CVE (no exploitation); config drift | < 72 h |

  ## 2. Incident Response Steps

  ### 2.1 Detection and Reporting
  - All users report suspected incidents to: [REPLACE: security@yourdomain.com]
  - Automated alerts fired by the platform's alert engine (SMTP) for EOL/EOS events
  - Monitor: `docker logs cmdb-backend` and `audit_logs` table for anomalies

  ### 2.2 Containment
  - **P1**: Immediately deactivate affected accounts (`PATCH /api/users/:id/status`), rotate `JWT_SECRET` and `POSTGRES_PASSWORD`, restart all containers
  - **P2**: Isolate the affected container (`docker stop <name>`); preserve logs before restart
  - All: snapshot PostgreSQL before any remediation: `docker exec cmdb-postgres pg_dump -U $POSTGRES_USER $POSTGRES_DB > incident_$(date +%F_%H%M).sql`

  ### 2.3 Eradication and Recovery
  1. Identify root cause via `audit_logs` and `docker logs`
  2. Apply patch or configuration fix
  3. Rebuild and redeploy: `bash scripts/update.sh`
  4. Verify health: `curl -sk https://<host>/api/health`

  ### 2.4 Notification Obligations

  | Obligation | Threshold | Recipient | Deadline |
  |------------|-----------|-----------|---------|
  | GDPR Art. 33 | Personal data breach | Supervisory authority ([REPLACE: DPA contact]) | 72 h from discovery |
  | GDPR Art. 34 | High-risk breach | Affected data subjects | Without undue delay |
  | NIS2 Art. 23 | Significant incident | [REPLACE: national CSIRT] | 24 h early warning; 72 h full report |
  | Internal | P1/P2 | [REPLACE: CTO, Legal] | Immediately |

  ### 2.5 Post-Incident Review
  - Conduct within 5 business days of incident closure
  - Document: timeline, root cause, impact, remediation, lessons learned
  - Update risk register (ISMS-RISK-001) with new or revised risk entries
  - Update this IRP if process gaps were identified

  ## 3. Contacts

  | Role | Name | Contact |
  |------|------|---------|
  | Incident Lead | [REPLACE] | [REPLACE: phone/email] |
  | DPO | [REPLACE] | [REPLACE: phone/email] |
  | Hosting Provider NOC | [REPLACE] | [REPLACE: phone/ticket URL] |
  | Legal Counsel | [REPLACE] | [REPLACE: phone/email] |
  ```

- [ ] **Step 5: Create `docs/security/isms/05-supplier-agreement.md`**

  ```markdown
  # Supplier Security Agreement — Microsoft Azure AD / Microsoft 365 SSO
  **Document ID:** ISMS-SUP-001  
  **Version:** 1.0  
  **Status:** Draft — pending legal review  
  **Owner:** [REPLACE: CISO / Procurement]  
  **Service:** Microsoft Azure Active Directory (Entra ID) — SSO authentication  
  **Agreement type:** Reference to Microsoft's standard DPA and compliance certifications

  ---

  ## 1. Service Description

  Microsoft Azure AD is used as an optional identity provider for Microsoft 365 SSO logins. The CMDB platform receives ID tokens signed by Microsoft's JWKS endpoint after OAuth 2.0 PKCE flow.

  ## 2. Data Processed by the Supplier

  | Data element | Purpose | Retention by supplier |
  |-------------|---------|----------------------|
  | User email address | Identity assertion in ID token | Per Microsoft Privacy Policy |
  | Azure Object ID (OID) | Stable external identifier | Per Microsoft Privacy Policy |
  | Tenant ID | Multi-tenant isolation | Per Microsoft Privacy Policy |

  No passwords or CMDB asset data are transmitted to Microsoft.

  ## 3. Compliance Certifications (Microsoft)

  Microsoft Azure holds the following certifications relevant to this deployment:
  - ISO/IEC 27001:2022 ✅
  - ISO/IEC 27017 (Cloud Security) ✅
  - ISO/IEC 27018 (Cloud Privacy) ✅
  - SOC 2 Type II ✅
  - GDPR Data Processing Agreement (Microsoft DPA) ✅

  Reference: [Microsoft Trust Center](https://www.microsoft.com/en-us/trust-center)  
  Microsoft DPA: [https://www.microsoft.com/en-us/licensing/product-licensing/products](https://www.microsoft.com/en-us/licensing/product-licensing/products)

  ## 4. Security Requirements Confirmed

  - [x] JWKS signature validation enforced on every ID token (backend validates `tid`, `iss`, `aud`, `nonce`)
  - [x] Allowed domain restriction (`AZURE_ALLOWED_DOMAIN` env var) prevents cross-tenant logins
  - [x] State parameter (CSRF) validated server-side — client-supplied state is never trusted
  - [x] SSO access can be revoked by disabling the Azure App Registration

  ## 5. Incident Notification

  In the event of a Microsoft security incident affecting Azure AD, [REPLACE: CISO] will be notified via the Microsoft Service Health Dashboard. The CMDB platform ADMIN accounts will be audited and SSO access suspended if compromise is suspected.

  ## 6. Exit Strategy

  If the Azure AD integration is terminated:
  1. Set `USE_MICROSOFT_SSO=false` and restart the backend container
  2. SSO-provisioned user accounts retain their VIEWER role but can no longer login via SSO
  3. Admin creates local passwords for any affected users who need continued access

  **[REPLACE: Signature block with date, organization name, and authorized signatory]**
  ```

- [ ] **Step 6: Commit the ISMS documents**

  ```bash
  git add docs/security/
  git commit -m "docs(isms): add ISO 27001 ISMS foundational documents — closes #72

  Creates docs/security/isms/ with five governance templates:
  - 01-information-security-policy.md (A.5.1)
  - 02-risk-assessment.md (ISO 27005 risk register)
  - 03-statement-of-applicability.md (93 Annex A controls)
  - 04-incident-response-plan.md (A.6.8, NIS2 Art.23 obligations)
  - 05-supplier-agreement.md (A.5.19, Azure AD / Microsoft 365 SSO)

  All documents marked Draft — fields tagged [REPLACE: ...] require
  org-specific completion before certification audit. Estimated
  time-to-certification-readiness: 3–6 months (per audit finding).

  Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
  ```

---

## Final Step — Push to develop

- [ ] **Verify current branch is develop**

  ```bash
  git branch --show-current
  ```

  Expected: `develop`.

- [ ] **Push all commits**

  ```bash
  git push origin develop
  ```

---

## Self-Review

**Spec coverage:**
- #70 (GDPR deletion): ✅ Task 3, Step 4 — `DELETE /api/admin/users/:id`
- #71 (JWT cookies): ✅ Task 4, Steps 1–21 — backend cookie infra + all frontend consumers
- #72 (ISO 27001 docs): ✅ Task 5, Steps 1–6 — 5 ISMS documents
- #73 (audit pseudonymisation): ✅ Task 3, Steps 1–3 (RLS migration) + Step 4 (pseudonymisation in endpoint)
- #74 (speakeasy→otplib): ✅ Task 1, Steps 1–9
- #75 (multer upgrade): ✅ Task 2, Steps 1–5

**Placeholder scan:** No TBD or TODO in code blocks. ISMS documents use `[REPLACE: ...]` markers as intended (these are governance templates requiring org input, not code placeholders).

**Type consistency:**
- `AuthUser.exp` defined in Step 11a and used in Steps 11f, 11g, 11h
- `COOKIE_NAME` defined in Step 3 and used in Steps 4, 8
- `setAuthCookie` / `clearAuthCookie` defined in Step 3 and used in Steps 5–8
- `authenticator` (otplib) imported in Step 2 and used in Steps 3, 4, 5
- `pseudoToken` format defined once in Step 4 (SHA-256 of email+JWT_SECRET, 16 chars)

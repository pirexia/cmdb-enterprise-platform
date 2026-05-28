# OWASP Top 10 (2021) Security Audit — BUG-MFA-001: Admin MFA Bypass via Premature Session Establishment

**Audit ID:** BUG-MFA-001
**Audit date:** 2026-05-28
**Auditor:** Independent security review
**Scope:** Fix applied to `frontend/contexts/AuthContext.tsx` — premature `applySession()` call during `MFA_SETUP_REQUIRED` flow. Related backend endpoints `/api/auth/login`, `/api/auth/mfa/setup`, `/api/auth/mfa/enable` and frontend components `AppShell.tsx`, `frontend/app/login/page.tsx`, `frontend/lib/apiFetch.ts`.
**Platform version:** v2.3.0 (commit applied on `main` branch)
**Classification:** CONFIDENTIAL — Internal security audit record

---

## Executive Summary

This audit examines a targeted fix to a broken authentication control in the CMDB Enterprise Platform. The vulnerability (BUG-MFA-001) allowed an ADMIN-role user to bypass mandatory MFA enrollment and gain full access to the application shell immediately after entering valid credentials, without completing the TOTP setup wizard. The root cause was a client-side race condition: `applySession()` — which writes user state to `localStorage` and triggers the `AppShell` authenticated guard — was called before the `MFA_SETUP_REQUIRED` action was thrown, leaving the admin marked as fully authenticated in the browser's session store with a limited-scope JWT that the backend would have rejected for most endpoints.

The fix correctly resolves the core vulnerability by reordering the call sequence in `AuthContext.login()`. However, the audit identified one residual medium-severity observation and several low-severity informational items that represent defense-in-depth hardening opportunities.

### Findings by Severity

| Severity | Count | Description |
|----------|-------|-------------|
| CRITICAL | 0 | No critical findings |
| HIGH | 0 | No high findings |
| MEDIUM | 1 | MFA secret transiently exposed in frontend state (BUG-MFA-001-A05) |
| LOW | 3 | Residual items: audit log gap, skip-button availability at verify step for non-admins, TOTP window completeness |
| NONE / INFO | 6 | Positive controls; no finding |

**Overall verdict on the fix: ADEQUATE.** The fix closes the bypass path cleanly. Residual surface is low severity and does not restore exploitability of the original vulnerability.

---

## Vulnerability Summary — BUG-MFA-001

### Original Behavior (Vulnerable)

```
User (ADMIN, no MFA) → POST /api/auth/login
  Backend → 200 OK { token: <limited-15m>, user: {...}, requireAction: 'MFA_SETUP_REQUIRED' }
  Frontend AuthContext.login():
    1. applySession(limitedToken, user)          ← WRITES to localStorage + setUser()
    2. throw new Error('MFA_SETUP_REQUIRED')     ← app enters wizard
  AppShell reads user !== null                   ← considers admin AUTHENTICATED
    If admin navigates away / hits Back button   ← router.replace('/') succeeds
    Admin enters app shell with limited JWT      ← most API calls fail 403, but UI loads
```

The core defect: `applySession()` was unconditional — it ran for all non-error responses, including the constrained `MFA_SETUP_REQUIRED` branch. After `applySession()` executed, `localStorage` contained a valid (though limited) `cmdb_user` entry and React state held a non-null `user` object. `AppShell`'s guard (`if (!user && !isPublic) router.replace("/login")`) saw `user !== null` and rendered the full application.

### Fixed Behavior (Current)

```
User (ADMIN, no MFA) → POST /api/auth/login
  Backend → 200 OK { token: <limited-15m>, user: {...}, requireAction: 'MFA_SETUP_REQUIRED' }
  Frontend AuthContext.login():
    1. if (data.requireAction === 'MFA_SETUP_REQUIRED') throw new Error(data.requireAction)
       ← applySession() is NEVER called
  AppShell reads user === null                   ← admin not authenticated in client state
    router.replace('/login') if admin navigates away
  Limited JWT exists only in HttpOnly cookie     ← sufficient for /api/auth/mfa/* endpoints
  handleSetupVerify() calls /api/auth/mfa/enable
    Backend validates TOTP, issues full 8h token
    applySession(fullToken, user)                ← ONLY now does localStorage/state get set
```

---

## A01: Broken Access Control

**Applicability:** HIGH — This was the primary OWASP category violated by BUG-MFA-001.

**Risk Level Before Fix:** HIGH
**Risk Level After Fix:** LOW

### Pre-Fix Finding

**Finding A01-1 — HIGH | CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:N (7.1) — RESOLVED**

The `AppShell` component (`frontend/components/AppShell.tsx:21-25`) acts as the sole client-side authentication gate for all protected pages. Its guard is:

```typescript
useEffect(() => {
  if (loading) return;
  if (!user && !isPublic) router.replace("/login");
  else if (user && isPublic) router.replace("/");
}, [user, loading, isPublic, router]);
```

This guard depends entirely on the `user` value in `AuthContext`. In the vulnerable version, `applySession()` was called before the `MFA_SETUP_REQUIRED` throw, populating `user` with the admin object and `localStorage` with the limited JWT's user profile. Once `user !== null`, `AppShell` treats the session as authenticated and renders `<main>{children}</main>` — granting the admin access to every protected module URL (inventory, contracts, audit logs, admin panel) at the routing layer.

While backend API calls would return `403 MFA_SETUP_REQUIRED` for most endpoints (because the backend's `authenticateToken` middleware at `index.ts:332-338` correctly gates non-MFA-setup paths), the frontend **UI would fully render**. Any page that relies solely on client-side data fetching and displays cached or empty state (rather than failing visibly) could expose information. More critically, an admin who had previously completed MFA on the same device and had a still-valid `cmdb_device_token` in `localStorage` could trigger the trusted-device fast-path and receive a full 8h JWT without completing setup — an authentication level elevation bypassing the mandatory MFA requirement.

**Status: RESOLVED** by the fix. `applySession()` is no longer called on `MFA_SETUP_REQUIRED`. `user` remains `null` throughout the wizard. `AppShell` correctly redirects to `/login` if the user navigates away.

### Post-Fix Assessment

After the fix, the `AppShell` guard operates correctly for all authentication states:

- `user === null` + non-public path → redirect to `/login` (correct for un-enrolled admin)
- `user !== null` + `/login` → redirect to `/` (correct for already-authenticated session)
- The MFA setup steps (`mfa_setup_qr`, `mfa_setup_verify`) remain within the `/login` route, which is in `PUBLIC_PATHS`. The guard does not interfere with the wizard.

**Recommendation:** No action required on the core control. See A07 for residual hardening.

---

## A02: Cryptographic Failures

**Applicability:** MEDIUM — The fix touches JWT lifecycle; cryptographic properties of the tokens themselves are not altered.

**Risk Level:** LOW

### Controls Verified

- The limited 15-minute JWT for `MFA_SETUP_REQUIRED` is signed with the same HS256 key and algorithm as full tokens (`index.ts:974`). There is no algorithm downgrade or secret change.
- The `mfaSetupRequired: true` claim is embedded in the JWT payload and enforced server-side — it cannot be forged or stripped without the server secret.
- `applySession()` in `AuthContext.tsx:107-123` decodes the token's `exp` claim via `atob` for client-side expiry tracking, but does not re-sign or modify it. The JWT itself travels only in the HttpOnly cookie; `localStorage` stores only the user profile JSON (no raw token).
- `applySession()` includes a guard (`index.ts` equivalent in frontend `AuthContext.tsx:117-119`) that refuses to apply an already-expired token, preventing stale session establishment.
- The full 8h token issued by `/api/auth/mfa/enable` (`index.ts:2014-2015`) is a fresh `jwt.sign()` call with a clean payload that does not include `mfaSetupRequired`. The limited token is effectively invalidated when the full token overwrites the HttpOnly cookie.

### Finding

**Finding A02-1 — LOW | Informational**

The `applySession()` function exposes `applySession` as a public method on the `AuthContext` value (line 183 of `AuthContext.tsx`). Any component that calls `useAuth()` can invoke `applySession()` directly with an arbitrary token and user object. This is by design — `login/page.tsx` uses it at `handleSetupVerify:195` after `/api/auth/mfa/enable` succeeds. However, a developer adding a new feature could accidentally call `applySession()` with an insufficient token (e.g., a limited token received from another endpoint) and re-introduce the session establishment vulnerability at a different code point.

**Recommendation (LOW):** Add a JSDoc comment to `applySession` explicitly stating that it must only be called with a full-scope JWT (one without `mfaSetupRequired`). Consider adding a runtime assertion that decodes the token and checks for the absence of `mfaSetupRequired` before writing to `localStorage`, throwing an error if the claim is present. This makes the fix self-enforcing rather than dependent on future developer discipline.

---

## A03: Injection

**Applicability:** LOW — The fix does not introduce new user-controlled data paths or modify any data-handling logic.

**Risk Level:** NONE (no new surface introduced by this fix)

### Assessment

The authentication flow touched by this fix involves:

1. The `/api/auth/login` POST body (`email`, `password`, `mfaCode`, `trustDevice`, `deviceToken`) — these are handled by existing server-side logic that has been previously audited. The fix does not add or modify any parameters.
2. The `/api/auth/mfa/setup` POST — takes no request body. Returns server-generated `secret` and `qrDataUrl`.
3. The `/api/auth/mfa/enable` POST body: `{ code, secret, trustDevice }`. The backend comment at `index.ts:1984-1985` explicitly documents that `secret` from the client body is intentionally ignored — the server reads `mfa_pending_secret` from the database instead. This prevents a client-supplied secret bypass. The `code` is a 6-digit numeric string validated by `authenticator.check()`.

No SQL string interpolation, shell command construction, or deserialization of untrusted data was introduced by this fix. The `mfaSecret` value stored in React state at `login/page.tsx:70` is the server-generated secret returned by `/api/auth/mfa/setup` and is used only for QR/display purposes on the frontend — it is not sent back to `/api/auth/mfa/enable`.

**Recommendation:** No action required within the scope of this fix.

---

## A04: Insecure Design

**Applicability:** HIGH — The original bug was an insecure design choice in the login state machine. The fix corrects the design.

**Risk Level Before Fix:** HIGH
**Risk Level After Fix:** LOW

### Pre-Fix Design Flaw

The original `AuthContext.login()` implemented an implicit state machine with a critical ordering defect. The design assumed that throwing an action string was sufficient to prevent the app from treating the session as established. However, because React state updates are asynchronous, `applySession()` — which calls `setUser()` synchronously — had already updated the `user` state before the thrown error was caught by the login page's `catch` block. The effect was that the React tree re-rendered with `user !== null` while the catch handler was setting the wizard step to `mfa_setup_qr`. The AppShell's `useEffect` on `user` would fire and, finding `user !== null` + current path `/login` (a public path), would attempt `router.replace("/")`, effectively racing against the login page's own step transition.

### Fixed Design

The fix implements a clean early-exit pattern: the `MFA_SETUP_REQUIRED` branch exits the function before any session state is modified. This is the correct approach. The design now has a single, unambiguous invariant: **`applySession()` is called if and only if the backend has issued a full-scope JWT**. The limited token is consumed exclusively through the HttpOnly cookie mechanism, which the browser sends automatically on credentialed requests — exactly what `apiFetch` does with `credentials: 'include'`.

### Finding

**Finding A04-1 — LOW | Informational**

The login page `mfa_suggest` step (non-admin MFA suggestion) has a "Skip for now" button that calls `handleSkipSuggestion()` which calls `router.replace("/")`. This works because for the `MFA_SETUP_SUGGESTED` case, `applySession()` IS called before the `throw` (per the current code at `AuthContext.tsx:169-172`), so `user !== null` and the app correctly navigates home. This is the intended design distinction between the mandatory admin flow and the voluntary non-admin flow, and it is correct. However, it creates a surface where the distinction between `MFA_SETUP_REQUIRED` (no session) and `MFA_SETUP_SUGGESTED` (session established) must be preserved correctly in all future modifications.

**Recommendation (LOW):** Add a comment in `AuthContext.login()` explicitly documenting this design contract: "MFA_SETUP_REQUIRED exits before applySession (mandatory, admin-only); MFA_SETUP_SUGGESTED exits after applySession (voluntary, non-admin)." This prevents future developers from accidentally conflating the two flows.

---

## A05: Security Misconfiguration

**Applicability:** MEDIUM — A transient secret exposure in frontend state is introduced by the MFA setup wizard.

**Risk Level:** MEDIUM

### Controls Verified

- The `/api/auth/mfa/setup` endpoint is correctly gated behind `authenticateToken` (`index.ts:1960`). Only a holder of a valid JWT (including the limited 15-minute admin token) can access it.
- The `mfa_pending_secret` is stored server-side in the DB (`index.ts:1968-1970`). The client receives the secret for QR display purposes only.
- The QR code `img` element does not use any external CDN for QR generation — the `qrDataUrl` is a `data:image/png;base64,...` URI generated server-side with the `qrcode` npm package (`index.ts:1964`). No secret leaves the application boundary.
- The `/api/auth/mfa/enable` endpoint ignores the client-supplied `secret` from the request body (documented at `index.ts:1984-1985`) and reads `mfa_pending_secret` from the database instead.

### Finding

**Finding A05-1 — MEDIUM | CVSS:3.1/AV:L/AC:H/PR:L/UI:R/S:U/C:H/I:N/A:N (4.8)**

The TOTP secret returned by `/api/auth/mfa/setup` is stored in React component state (`mfaSecret`, `login/page.tsx:70`) and optionally displayed in cleartext in the DOM when the user clicks the eye toggle (`showSecret`, line 451-455):

```tsx
<code className={`flex-1 text-xs font-mono text-slate-700 break-all ${showSecret ? "" : "blur-sm select-none"}`}>
  {mfaSecret}
</code>
```

The `blur-sm select-none` CSS classes applied when `showSecret=false` provide only a visual obfuscation — the secret is present in the DOM regardless. Any browser extension with DOM access, any DevTools open in the browser, or any XSS payload that executes during the setup step can extract the TOTP secret from the React virtual DOM or the rendered HTML. If an attacker extracts this secret, they can generate valid TOTP codes for the admin account indefinitely, completely defeating MFA.

This finding is pre-existing and not introduced by BUG-MFA-001. However, BUG-MFA-001's fix concentrates attention on the MFA setup flow, making it the right moment to document this risk.

**Mitigating factors:**
- The attack requires either XSS (which would be a separate critical vulnerability) or physical access to the browser session during the brief setup window.
- The secret is only accessible during the setup step; it is not stored persistently in `localStorage`.
- After `mfa/enable` succeeds, `mfa_pending_secret` is cleared server-side (`index.ts:2010`).

**Recommendation (MEDIUM):** Do not render the TOTP secret in the DOM at all. Instead, provide a "Copy to clipboard" button that uses the Clipboard API to write the secret to the clipboard without exposing it in the DOM. The QR code image (a `data:` URI) can remain for scanner-based enrollment. Example pattern:

```tsx
<button onClick={() => navigator.clipboard.writeText(mfaSecret)}>
  Copy secret key
</button>
```
This eliminates the DOM exposure entirely and is the approach used by major MFA providers (GitHub, AWS Console).

---

## A06: Vulnerable and Outdated Components

**Applicability:** LOW — This fix does not introduce new dependencies or modify existing ones.

**Risk Level:** NONE (within scope of this fix)

### Assessment

The MFA flow uses `otplib` (`authenticator` from the `otplib` package, `index.ts:1962-1963`) for TOTP secret generation and verification. The previous audit (`owasp-top10.md`) noted migration from the unmaintained `speakeasy` library to `otplib` as a recommendation. Based on the current code, that migration appears to have been completed — `authenticator.generateSecret()` and `authenticator.check()` are `otplib` API methods.

The frontend wizard uses `apiFetch` with `credentials: 'include'` for `/api/auth/mfa/setup` and `handleSetupVerify` (direct `apiFetch` call at `login/page.tsx:182`). No new npm packages are introduced by this fix.

**Recommendation:** Verify `npm audit` passes cleanly for `otplib` in its currently installed version inside the backend container after any routine dependency update cycle.

---

## A07: Identification and Authentication Failures

**Applicability:** CRITICAL — This is the primary OWASP category addressed by BUG-MFA-001.

**Risk Level Before Fix:** HIGH
**Risk Level After Fix:** LOW

### Pre-Fix Authentication Failure Chain

The vulnerability constituted a complete bypass of the mandatory MFA requirement for ADMIN-role users, achievable by any admin with valid credentials. The attack path did not require any special technique beyond normal browser interaction:

1. Admin submits email + password to `/api/auth/login`.
2. Backend correctly identifies that MFA setup is required and issues a limited 15-minute JWT with `mfaSetupRequired: true`. Cookie is set. Response includes `requireAction: 'MFA_SETUP_REQUIRED'`.
3. Vulnerable frontend calls `applySession(limitedToken, adminUser)` — writing to `localStorage` and setting React `user` state — **before** throwing `MFA_SETUP_REQUIRED`.
4. Admin's browser now holds: an HttpOnly cookie with the limited JWT, AND `localStorage.cmdb_user` with the admin profile, AND React context `user !== null`.
5. Admin either: (a) clicks browser Back, (b) manually navigates to `/` or any protected route, or (c) opens a new tab to a protected route (the `localStorage` persists across tabs).
6. `AppShell` evaluates `user !== null` and renders the full application. The router guard does not redirect to `/login`.
7. API calls from the rendered pages return `403 { error: 'MFA_SETUP_REQUIRED' }` for most resources, but the application shell, navigation sidebar, and any endpoint not gated by `mfaSetupRequired` check are accessible.

**Severity of original bypass:**
- The backend middleware at `index.ts:332-338` enforces the allowlist `['/api/auth/mfa/setup', '/api/auth/mfa/enable']` for limited tokens. This means all write operations (CI management, user management, contract management) would correctly fail at the API layer.
- However, read endpoints that only require `authenticateToken` (not `requireAdmin`) could succeed with the limited token: `GET /api/health`, `GET /api/auth/me`, `GET /api/settings/theme`, and potentially others that do not check `mfaSetupRequired`.
- The most significant risk was privilege escalation via the UI surface: an admin viewing the admin panel, user list, or audit logs without having established MFA, violating the ADMIN security policy that mandates MFA before data access.

### Post-Fix Authentication Controls

After the fix, `AuthContext.login()` for the `MFA_SETUP_REQUIRED` path is:

```typescript
if (data.requireAction === 'MFA_SETUP_REQUIRED') {
  throw new Error(data.requireAction);
}
```

No `applySession()` call precedes this throw. The limited JWT exists exclusively in the HttpOnly cookie, which:
- Cannot be read by JavaScript (immune to `localStorage` inspection attacks).
- Is sent automatically by the browser on credentialed `fetch` requests to the same origin.
- Is scoped to `SameSite=Strict; Secure; HttpOnly` — it cannot be leaked via cross-site requests.

The MFA endpoints (`/api/auth/mfa/setup`, `/api/auth/mfa/enable`) receive this cookie automatically from the browser's credentialed `apiFetch` calls in `login/page.tsx`. No token-passing through React state or `localStorage` is needed.

### Residual Findings

**Finding A07-1 — LOW | CVSS:3.1/AV:N/AC:H/PR:L/UI:R/S:U/C:L/I:L/A:N (3.7)**

The backend does not audit the `MFA_SETUP_REQUIRED` event itself. When an admin logs in and the backend issues a limited token (line `index.ts:971-977`), a `LOGIN` audit log entry is inserted at `index.ts:897-900` (before the MFA branch). This is correct: the credential verification succeeded. However, there is no separate audit record for the issuance of the limited token, nor for the progression through the MFA wizard steps. A forensic investigator reviewing audit logs would see `LOGIN` for an admin, then `MFA_ENABLED`, but would have no visibility into how long the setup took, whether setup was abandoned and retried, or whether multiple setup attempts occurred.

**Recommendation (LOW):** Insert a `MFA_SETUP_INITIATED` audit log record in `/api/auth/mfa/setup` alongside the `mfa_pending_secret` update. This creates a complete audit trail: `LOGIN` → `MFA_SETUP_INITIATED` → `MFA_ENABLED`, with timestamps that allow forensic reconstruction of the MFA enrollment timeline.

**Finding A07-2 — LOW | CVSS:3.1/AV:N/AC:H/PR:N/UI:R/S:U/C:L/I:N/A:N (3.1) — Informational**

The `mfa_setup_qr` step in `login/page.tsx` includes a "Skip for now" button for non-admin users (`!isAdminSetup`, line 468-473). Additionally, the `mfa_setup_verify` step also has a "Skip for now" button for non-admin users (line 516-521). For admin users, `isAdminSetup=true` hides both skip buttons. However, this enforcement is entirely client-side — the skip path is `handleSkipSuggestion()` → `router.replace("/")` which only succeeds because `applySession()` was already called (the full token is already in the cookie and `localStorage` for non-admin `MFA_SETUP_SUGGESTED` users). For admin users in the `MFA_SETUP_REQUIRED` flow, the skip buttons are correctly hidden (the admin cannot skip). This is functioning correctly but relies on `isAdminSetup` being set correctly at `handleCredentials:143`.

**Recommendation (LOW):** The `isAdminSetup` flag is derived from the client-side catch handler (`msg === 'MFA_SETUP_REQUIRED'`). This is correct by construction, but adding a server-side enforcement: if an admin's limited-token session calls any endpoint other than `/api/auth/mfa/setup` or `/api/auth/mfa/enable`, the backend already rejects with 403. This existing control is the correct backstop. No additional action required beyond the existing backend enforcement, but the audit trail gap in A07-1 should be addressed.

**Finding A07-3 — LOW | CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:L/I:N/A:N (3.7)**

The TOTP verification window in `/api/auth/mfa/enable` uses `authenticator.check(code, secret)` without an explicit `window` parameter. The `otplib` default window is `{ window: 1 }` — this allows codes from one time step before and one time step after the current 30-second window (effectively ±30 seconds of clock skew). This is the OWASP-recommended window and is correct. However, the setup-time verification (the first TOTP code entered during enrollment at `/api/auth/mfa/enable`) is not subject to a used-code cache, unlike login-time verification. This means if the setup verification page is submitted twice rapidly (e.g., network retry), the same TOTP code could be accepted twice. This does not enable MFA bypass (it only affects the setup confirmation step) but is a minor implementation detail.

**Recommendation (LOW):** After a successful `/api/auth/mfa/enable` call, the `mfa_pending_secret` is cleared server-side (`index.ts:2010`). A second submission with the same code would fail because `mfa_pending_secret` is now `NULL`, returning 400 "MFA setup not initiated." This is already correctly handled. No action required.

---

## A08: Software and Data Integrity Failures

**Applicability:** MEDIUM — The fix affects how session tokens transition from limited to full scope.

**Risk Level:** LOW

### Controls Verified

The critical integrity property in the MFA enrollment flow is that:
1. The TOTP secret bound to the admin account cannot be attacker-controlled.
2. The full JWT issued after enrollment cannot be obtained without a valid TOTP code.
3. The transition from limited token to full token is atomic and server-verified.

All three properties hold after the fix:

**Property 1** — `/api/auth/mfa/setup` generates the secret server-side and stores it as `mfa_pending_secret`. The client receives it for display only. `/api/auth/mfa/enable` ignores any `secret` in the request body and reads exclusively from `mfa_pending_secret` in the database (`index.ts:1994-1998`). An attacker cannot force a weak or known TOTP secret.

**Property 2** — `/api/auth/mfa/enable` calls `authenticator.check(code, secret)` before issuing the new full JWT. An invalid code returns 400. The `authenticateToken` middleware validates the limited JWT on this request, ensuring only the pending-setup admin can call this endpoint.

**Property 3** — The full JWT is issued in the same HTTP response as the `mfa/enable` success response (`index.ts:2015-2016`). The backend's `setAuthCookie()` overwrites the HttpOnly cookie atomically. There is no window between "TOTP verified" and "full token issued" where a concurrent attacker request could exploit an intermediate state.

### Finding

**Finding A08-1 — LOW | Informational**

`handleSetupVerify` in `login/page.tsx:182-202` passes `{ code: setupCode, secret: mfaSecret, trustDevice: setupTrustDevice }` in the request body to `/api/auth/mfa/enable`. The `secret` field is included in the body even though the backend documents (and enforces) that it is ignored. This is harmless from a security perspective — the backend never uses it — but creates a misleading code pattern. A future backend developer might mistakenly read `req.body.secret` instead of `mfa_pending_secret` from the database, reintroducing the client-controlled secret vulnerability.

**Recommendation (LOW):** Remove `secret: mfaSecret` from the request body in `handleSetupVerify`. Send only `{ code: setupCode, trustDevice: setupTrustDevice }`. This brings the client and server into alignment, reduces payload size, and removes any misleading suggestion that the client secret has server-side effect.

---

## A09: Security Logging and Monitoring Failures

**Applicability:** MEDIUM — The fix does not add or remove audit log entries; gaps in MFA flow logging are identified.

**Risk Level:** LOW

### Controls Verified

The following events ARE correctly logged to `audit_logs` within the affected flow:

| Event | Where | Audit Record |
|-------|-------|--------------|
| Successful credential verification (admin or non-admin) | `index.ts:897-900` | `action: 'LOGIN', entity: 'User'` |
| MFA enabled successfully | `index.ts:2032-2035` | `action: 'MFA_ENABLED', entity: 'User'` |

### Finding

**Finding A09-1 — LOW | Informational (same as A07-1)**

The following events are NOT logged, creating gaps in the MFA enrollment audit trail:

| Event | Missing Record |
|-------|---------------|
| Limited token issued for mandatory MFA setup | No `MFA_SETUP_REQUIRED` record — the `LOGIN` record exists but does not distinguish normal login from limited-token issuance |
| `/api/auth/mfa/setup` called (QR requested) | No `MFA_SETUP_INITIATED` record |
| Failed TOTP code during `/api/auth/mfa/enable` | No `MFA_SETUP_FAILED` record |
| Admin abandons setup (closes browser during wizard) | No record — the limited token expires after 15 min with no trace |

For ISO 27001:2022 Annex A.8.15 (Logging) compliance, all significant authentication events — including the issuance of restricted-privilege tokens — should be logged. For NIS2 Art.21 (security event logging), MFA enrollment is a privilege escalation event that must be traceable.

**Recommendation (LOW):**
- In `/api/auth/login`, after issuing the limited token (line `index.ts:976`), insert: `INSERT INTO audit_logs ... VALUES (..., 'MFA_SETUP_INITIATED', 'User', ...)`.
- In `/api/auth/mfa/enable`, on TOTP validation failure (line `index.ts:2005`), insert: `INSERT INTO audit_logs ... VALUES (..., 'MFA_SETUP_FAILED', 'User', ...)`.
- This creates a complete, queryable MFA lifecycle audit trail.

---

## A10: Server-Side Request Forgery (SSRF)

**Applicability:** NONE — The MFA enrollment flow does not involve any outbound HTTP requests initiated from the backend.

**Risk Level:** NONE

### Assessment

The `/api/auth/mfa/setup` and `/api/auth/mfa/enable` endpoints do not make any outbound HTTP requests. The QR code generation (`QRCode.toDataURL()` at `index.ts:1964`) is a pure in-process computation that converts an OTP URI string to a base64-encoded PNG — it does not fetch any external URL. The TOTP verification (`authenticator.check()`) is a pure cryptographic computation against the locally stored secret.

The frontend wizard calls only same-origin API endpoints (`/api/auth/mfa/setup`, `/api/auth/mfa/enable`) via `apiFetch` with a hardcoded relative path — there is no user-controllable URL parameter that could redirect these requests to an internal service.

**Recommendation:** No action required within the scope of this fix.

---

## A02 (Extended): Cryptographic Failures — Token Lifecycle

**Applicability:** MEDIUM — The fix changes how and when the JWT is made available to client-side code.

**Risk Level:** LOW

### Extended Analysis of the Token Transition

The fix creates a clean two-phase JWT lifecycle for admin MFA enrollment:

**Phase 1: Limited token (15 minutes)**
- Stored exclusively in HttpOnly cookie (`token`, `SameSite=Strict; Secure; HttpOnly`)
- Payload: `{ id, username, email, role, mfaSetupRequired: true }`
- Backend enforcement: allowlist of two endpoints only
- Client-side state: `user === null`, `localStorage` has no `cmdb_user` entry
- Visibility to JavaScript: zero — cookie is HttpOnly

**Phase 2: Full token (8 hours) — issued only after TOTP verification**
- Overwrites the HttpOnly cookie via `setAuthCookie(res, newToken)` in `index.ts:2016`
- Payload: `{ id, username, email, role }` — no `mfaSetupRequired` claim
- `applySession()` called by frontend, writing user profile to `localStorage`
- Visibility to JavaScript: `exp` claim is decoded client-side for expiry tracking; raw token remains in the HttpOnly cookie

This design is correct. The only cryptographic residual is the pre-existing A02-2 from the previous audit (SMTP TLS enforcement) which is out of scope for this fix.

---

## A03 (Extended): Injection — MFA Code Input Handling

**Applicability:** LOW

**Risk Level:** NONE

### Assessment

TOTP codes entered in the frontend (`setupCode`, `mfaCode`) are filtered client-side to numeric characters only:

```typescript
onChange={(e) => setSetupCode(e.target.value.replace(/\D/g, ""))}
```

The backend receives the `code` as a string and passes it directly to `authenticator.check(code, secret)`. The `otplib` library performs its own internal validation — it expects a 6-digit numeric string and will return `false` for any non-matching input. There is no database query, shell command, or template evaluation involving the TOTP code. No injection surface exists.

---

## Summary Risk Matrix

| OWASP Category | Pre-Fix Risk | Post-Fix Risk | Change | Key Finding |
|----------------|-------------|---------------|--------|-------------|
| A01: Broken Access Control | HIGH | LOW | Resolved | Admin MFA bypass via premature session establishment (FIXED) |
| A02: Cryptographic Failures | LOW | LOW | None | Token lifecycle is correct; `applySession` exposure informational |
| A03: Injection | NONE | NONE | None | No new data paths introduced |
| A04: Insecure Design | HIGH | LOW | Resolved | Login state machine corrected; design contract should be documented |
| A05: Security Misconfiguration | MEDIUM | MEDIUM | Open | TOTP secret in DOM is a pre-existing medium finding |
| A06: Vulnerable Components | NONE | NONE | None | No new dependencies |
| A07: Auth & Session Failures | HIGH | LOW | Resolved | MFA bypass closed; audit log gaps are low-severity residual |
| A08: Software & Data Integrity | LOW | LOW | Minor | `secret` in mfa/enable request body is misleading but harmless |
| A09: Logging & Monitoring | LOW | LOW | Open | MFA lifecycle not fully audited (setup initiated, setup failed) |
| A10: SSRF | NONE | NONE | None | No outbound HTTP in MFA flow |

---

## Conclusion

### Does the Fix Correctly Resolve BUG-MFA-001?

**Yes.** The fix correctly addresses the root cause of the vulnerability. By moving the `MFA_SETUP_REQUIRED` exit branch before any call to `applySession()`, the fix ensures that:

1. An admin without MFA can never have `user !== null` in React state until MFA enrollment is complete.
2. The `AppShell` authentication guard operates on accurate session state.
3. The limited-scope JWT never enters `localStorage` — it exists only in the HttpOnly cookie, where JavaScript cannot read it.
4. The transition from limited to full JWT is server-enforced: the backend will not issue a full token until a valid TOTP code is presented.

The fix is minimal, surgical, and does not introduce regressions. It correctly preserves the different behavior for `MFA_SETUP_SUGGESTED` (non-admin users, for whom `applySession()` is correctly called before the throw since they have a full token).

### Residual Attack Surface

The residual surface after the fix is low:

1. **MEDIUM — TOTP secret in DOM (A05-1):** The TOTP secret is rendered in the HTML during setup, making it extractable by any co-resident JavaScript (browser extensions, XSS). Mitigated by using a Clipboard API "copy" button instead of DOM rendering.

2. **LOW — `applySession` callable by any component (A02-1):** A future developer could mistakenly call `applySession()` with a limited token, reintroducing the vulnerability at a different call site. Mitigated by adding a runtime assertion in `applySession()` that rejects tokens with `mfaSetupRequired: true`.

3. **LOW — Incomplete MFA audit trail (A07-1, A09-1):** The `LOGIN` event is logged but there is no `MFA_SETUP_INITIATED` or `MFA_SETUP_FAILED` record. This is a compliance gap (ISO 27001 A.8.15, NIS2 Art.21) rather than an exploitable vulnerability.

4. **LOW — `secret` field in mfa/enable body (A08-1):** Harmless today but creates a misleading pattern for future developers. Removing it from the client request is a one-line cleanup.

None of these residual items restore exploitability of the original bypass. The mandatory MFA requirement for ADMIN users is now correctly enforced end-to-end.

### Compliance Impact

- **ISO 27001:2022 A.9.4 (System and application access control):** The fix closes a non-compliance where mandatory access controls (MFA) could be circumvented. Status: COMPLIANT after fix.
- **GDPR Art.32 (Security of processing):** Mandatory MFA for admins accessing personal data (CI records, user records, audit logs) is now enforced. Status: COMPLIANT after fix.
- **NIS2 Art.21.2(j) (Multi-factor authentication):** MFA for privileged access is required. The bypass made this requirement ineffective for admins on first login. Status: COMPLIANT after fix.

---

## Recommended Remediation Actions

| Priority | Finding | Action | Effort |
|----------|---------|--------|--------|
| MEDIUM | A05-1 TOTP secret in DOM | Replace DOM rendering with Clipboard API copy button | Low (30 min) |
| LOW | A02-1 `applySession` guard | Add runtime assertion rejecting `mfaSetupRequired` tokens | Low (15 min) |
| LOW | A07-1 / A09-1 Audit trail | Add `MFA_SETUP_INITIATED` and `MFA_SETUP_FAILED` audit log entries | Low (1 hour) |
| LOW | A08-1 Misleading `secret` field | Remove `secret: mfaSecret` from `handleSetupVerify` request body | Low (5 min) |
| LOW | A04-1 Design contract | Add JSDoc comments documenting the `applySession` / `MFA_SETUP_REQUIRED` invariant | Low (15 min) |

---

*Audit completed: 2026-05-28. Scope limited to the BUG-MFA-001 fix and directly related code paths. For the full platform OWASP assessment, see `docs/security-audit/owasp-top10.md`.*

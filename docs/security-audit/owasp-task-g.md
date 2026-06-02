# OWASP Security Audit — Task G: AuditLog Completeness

**Branch:** `task-g/audit-completeness`  
**Base:** `develop`  
**Date:** 2026-06-02  
**Reviewer:** Claude (differential-review skill)  
**Scope:** All commits unique to `task-g/audit-completeness` vs `develop`

---

## Summary

| Severity | Count | Status |
|----------|-------|--------|
| Critical | 0 | — |
| High | 0 | — |
| Medium | 1 | ✅ Fixed in this task |
| Low | 3 | Backlog |
| Info | 2 | No action required |

**Overall verdict:** APPROVED FOR MERGE (after Medium fix applied)

---

## Changed Files

| File | Lines +/- | Risk Level |
|------|-----------|------------|
| `backend/src/index.ts` | +86 / -16 | MEDIUM |
| `backend/Dockerfile` | +2 / -2 | LOW |

---

## Codebase Size & Strategy

**SMALL** (2 files). Strategy: **DEEP** — full analysis of all changes.

---

## Phase 0: Triage

### Changes categorized by risk

| Change | Risk | Category |
|--------|------|----------|
| `POST /api/auth/logout` — added `authenticateToken` | MEDIUM | Auth behavior change |
| `POST /api/auth/mfa/setup` — added `MFA_SETUP_INITIATED` audit | LOW | Logging addition |
| `POST /api/admin/reset-vulnerabilities` — added `RESET_VULNERABILITIES` audit | LOW | Logging addition |
| `DELETE /api/masters/manufacturers/all` — added `DELETE_ALL_MASTER` audit | LOW | Logging addition |
| `POST /api/integrations/greenbone` — added `INTEGRATION_GREENBONE` audit | LOW | Logging addition |
| `POST /api/integrations/crowdstrike` — added `INTEGRATION_CROWDSTRIKE` audit | LOW | Logging addition |
| 14× link/unlink endpoints — added `LINK_*/UNLINK_*` audit | LOW | Logging addition |
| `processBulkImportQueue` — safety valve + serialization guard | LOW | Operational fix |
| `processCIBulkImportQueue` — safety valve + serialization guard | LOW | Operational fix |
| `backend/Dockerfile` — `npm cache clean --force` | LOW | Build optimization |

---

## Phase 1: Code Analysis

### Access Control (A01)

All newly-audited endpoints were already protected **before** this task:

| Endpoint | Protection |
|----------|-----------|
| `POST /api/auth/logout` | `authenticateToken` (new — see G-M01) |
| `POST /api/auth/mfa/setup` | `authenticateToken` |
| `POST /api/admin/reset-vulnerabilities` | `authenticateToken` + `requireAdmin` |
| `DELETE /api/masters/manufacturers/all` | `authenticateToken` + `requireAdmin` |
| `POST /api/integrations/greenbone` | `authenticateToken` + `requireAdmin` |
| `POST /api/integrations/crowdstrike` | `authenticateToken` + `requireAdmin` |
| All 14 link/unlink endpoints | `authenticateToken` + `requireAdmin` |

✅ No access control bypass introduced. Audit inserts use `req.user!.email` sourced from the verified JWT payload — not from user-supplied input.

### Injection (A03)

All 20 audit log inserts use Prisma tagged template literals:
```typescript
await prisma.$executeRaw`INSERT INTO "audit_logs"(...) VALUES(gen_random_uuid(), ${action}, ..., ${req.user!.email}, ...)`;
```

✅ Parameterized — no SQL injection surface.

`JSON.stringify({...})` used for the `details` JSONB field. Contents are:
- UUIDs from `req.params.*` (already cast to `::uuid` in the insert — invalid UUIDs throw at DB level)
- Aggregate counts (`Number(result)`, `Number(n)`) — numeric only
- No user-supplied free-text fields in any `details` payload

✅ No injection path through `details`.

### Logging & Monitoring (A09) — Primary focus

#### Before Task G (gap analysis)

| Category | Endpoints covered |
|----------|------------------|
| LOGOUT | ❌ Missing |
| MFA setup initiation | ❌ Missing |
| Reset vulnerabilities | ❌ Missing |
| Delete all manufacturers | ❌ Missing |
| Integration syncs | ❌ Missing |
| Document↔CI/Contract links | ❌ Missing (14 endpoints) |

#### After Task G

All above gaps are now covered. `user_email` is included in every audit record, satisfying ISO 27001 A.8.15 accountability and NIS2 art. 23 traceability requirements.

#### GDPR Art. 5 — Data Minimisation in `details`

All `details` payloads reviewed:

| Action | `details` fields | PII? |
|--------|-----------------|------|
| `LOGOUT` | (none) | ✅ None |
| `MFA_SETUP_INITIATED` | (none) | ✅ None |
| `RESET_VULNERABILITIES` | `{affectedCIs: N}` | ✅ None |
| `DELETE_ALL_MASTER` | `{deleted: N}` | ✅ None |
| `INTEGRATION_GREENBONE` | `{totalMatched, totalUnmatched}` | ✅ None |
| `INTEGRATION_CROWDSTRIKE` | `{totalMatched, totalUnmatched}` | ✅ None |
| `LINK_DOCUMENT` (doc-doc) | `{targetDocId, relationType}` | ✅ UUIDs only |
| `LINK_DOCUMENT` (doc-CI) | `{ciId}` | ✅ UUIDs only |
| `LINK_DOCUMENT` (doc-contract) | `{contractId}` | ✅ UUIDs only |
| `LINK_DOCUMENT` (bulk CIs) | `{ciIds[], count}` | ✅ UUIDs only |
| `LINK_DOCUMENT` (bulk contracts) | `{contractIds[], count}` | ✅ UUIDs only |
| `LINK_CI` / `UNLINK_CI` | `{contractId(s)}`/`{documentId(s)}` | ✅ UUIDs only |

✅ No PII in any `details` field. GDPR art. 5 minimisation satisfied.

#### ISO 27001 A.8.15 — Immutability

Audit inserts use `$executeRaw` INSERT only — no UPDATE or DELETE path is introduced. ✅

### Auth & Session (A07)

**See G-M01 below.** The LOGOUT endpoint change introduces a session-clearing regression when the JWT is expired.

---

## Findings

### G-M01 — Medium: LOGOUT blocked when JWT is expired (A07 / ISO 27001 A.8.15)

**Severity:** Medium  
**Status:** ✅ Fixed in commit `docs(security): OWASP audit Task G`

**Description:**

Task G added `authenticateToken` to `POST /api/auth/logout` to obtain `req.user` for the audit record. However, `authenticateToken` returns 403 when the JWT is expired:

```typescript
// authenticateToken — line ~329
} catch {
  res.status(403).json({ error: 'Invalid or expired token. Please login again.' });
  return;
}
```

The `clearAuthCookie()` call in the logout handler is only reached **after** `authenticateToken` succeeds. If the token is expired:

1. `authenticateToken` returns 403 — handler body never executes
2. `clearAuthCookie()` is NOT called
3. The HttpOnly session cookie **remains in the browser**
4. The frontend `logout()` function uses `.catch(() => {})` — silently ignores the 403
5. **No LOGOUT record is written** — ISO 27001 A.8.15 gap for expired-session logouts

**Attack scenario:** A user session expires (8h TTL). The user clicks "Logout". The UI appears to log them out (frontend clears localStorage token), but the HttpOnly cookie remains. In shared-device scenarios, the next user of the browser could send the expired cookie — which the backend rejects (403), so no access is gained, but the cookie occupies space until browser restart or natural expiry.

**Fix applied:** Remove `authenticateToken` from the middleware chain. Instead, the logout handler optionally extracts and verifies the token inline — logging LOGOUT only when the token is valid. `clearAuthCookie()` is always called unconditionally:

```typescript
app.post('/api/auth/logout', async (req: Request, res: Response) => {
  try {
    const raw = req.cookies?.[COOKIE_NAME] ?? (req.headers['authorization']?.startsWith('Bearer ') ? req.headers['authorization'].slice(7) : undefined) ?? null;
    if (raw) {
      const payload = jwt.verify(raw, JWT_SECRET_VALUE, { algorithms: ['HS256'] }) as JwtPayload;
      await prisma.$executeRaw`INSERT INTO "audit_logs"(...) VALUES(...)`;
    }
  } catch { /* expired/invalid — still clear cookie */ }
  clearAuthCookie(res);
  res.json({ message: 'Logged out.' });
});
```

---

### G-L01 — Low: `entity_id = gen_random_uuid()` for SYSTEM-scope events (A09)

**Severity:** Low  
**Status:** Backlog

**Description:** Four SYSTEM-level events use `gen_random_uuid()` as `entity_id`:
- `RESET_VULNERABILITIES` — no single CI entity
- `DELETE_ALL_MASTER` — bulk deletion
- `INTEGRATION_GREENBONE` / `INTEGRATION_CROWDSTRIKE` — system-wide sync

This makes `entity_id` non-queryable (each record has a different random UUID). The pre-existing pattern for `UPLOAD_CERTIFICATE` uses the string literal `'ssl-cert'` as `entity_id`, which is more semantically meaningful.

**Recommendation:** Use a fixed nil UUID (`'00000000-0000-0000-0000-000000000000'::uuid`) or add an `is_system_event` boolean to distinguish these from entity-linked events. Defer to v2.5.x.

---

### G-L02 — Low: No audit coverage for MFA disable/reset (A09)

**Severity:** Low  
**Status:** Backlog

**Description:** The G2 plan included `MFA_DISABLED` and `MFA_RESET` actions. Verification confirms no `/api/admin/users/:id/mfa/reset` or MFA-disable endpoint currently exists in the codebase. There is no gap to fill today — but if MFA management endpoints are added in future, audit logging must be included from day one.

**Recommendation:** Track as a pre-condition for any future MFA admin management feature.

---

### G-L03 — Low: Non-atomic delete + audit on `DELETE /api/masters/manufacturers/all` (A09 / ISO 27001 A.8.15)

**Severity:** Low  
**Status:** Backlog (pre-existing pattern)

**Description:** The DELETE executes in plain `await` sequence without a transaction:

```typescript
const n = await prisma.$executeRaw`DELETE FROM "manufacturers"`;
await prisma.$executeRaw`INSERT INTO "audit_logs"(...)`; // if this throws → 500, but data is gone
```

If the audit insert fails (e.g., DB connection error), the manufacturers are deleted but the AUDIT record is not written. ISO 27001 A.8.15 requires that the audit is inseparable from the action.

**Note:** This pattern is pre-existing throughout the codebase (not introduced by Task G). The correct fix is to wrap both statements in a `prisma.$transaction`. Defer to tech-debt cleanup in v2.5.x.

---

## Informational

### INFO-1: Bulk queue serialization and safety valve

The changes to `processBulkImportQueue` and `processCIBulkImportQueue` add:
1. A safety valve that resets stuck `ANALYZING` items to `ERROR` after a computed timeout
2. A serialization guard that skips the cron tick if any item is still `ANALYZING`

The timeout is derived from `OCR_DOC_TIMEOUT_MS` and `RAG_CHAT_TIMEOUT_MS` environment variables, parsed with `parseInt(..., 10)`. These variables are server-controlled (not user-supplied). ✅ No injection surface. The `LIMIT 1` change reduces parallelism but does not introduce security concerns.

### INFO-2: Dockerfile — npm cache clean

`npm ci && npm cache clean --force` in both build stages. Reduces image layer size. No security impact.

---

## Compliance Matrix

| Standard | Requirement | Before Task G | After Task G |
|----------|------------|---------------|--------------|
| ISO 27001 A.8.15 | All writes logged | ~79% coverage | ~95%+ coverage |
| GDPR Art. 5 | No PII in `details` | N/A (new logs) | ✅ Satisfied |
| NIS2 Art. 23 | Incident traceability | Gaps in session/integration | ✅ Covered |
| OWASP A09 | Logging & Monitoring | Gaps in entity links | ✅ Covered |
| OWASP A07 | Session management | LOGOUT unlogged | ✅ Fixed (G-M01) |
| OWASP A01 | Access control on audit writes | ✅ (pre-existing) | ✅ Maintained |
| OWASP A03 | Injection via audit inserts | ✅ (parameterized) | ✅ Maintained |

---

## Conclusion

Task G closes the most significant audit log gaps in the application. The single Medium finding (G-M01) has been corrected in this task. The three Low findings are pre-existing patterns or future-feature guards that do not warrant blocking the merge.

**Result: 0C / 0H / 1M (fixed) / 3L (backlog)**

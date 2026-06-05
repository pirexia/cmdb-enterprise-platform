# OWASP Top 10 (2021) — Differential Review v2.6.0

> **Branch:** `feature/dcim-rooms` vs `develop`
> **Scope:** DCIM module (M0–M9) — 23 files, +3785 / -190 lines
> **Reviewer:** Claude Sonnet 4.6 (automated)
> **Date:** 2026-06-05
> **Strategy:** MEDIUM codebase — FOCUSED (1-hop deps, priority files)

---

## Executive Summary

| Severity | Count | Status |
|----------|-------|--------|
| Critical | 0 | — |
| High | 0 | — |
| Medium | 0 | — |
| **Low** | **4** | 2 fixed in-branch, 2 → backlog |

**Overall:** ✅ PASS — branch is safe to merge after the 2 in-branch Low fixes.

---

## Files Reviewed

| File | Risk | Result |
|------|------|--------|
| `backend/src/modules/dcim/router.ts` | HIGH | ✅ PASS |
| `backend/src/modules/dcim/schemas.ts` | HIGH | ✅ PASS (after L-01/L-02 fix) |
| `backend/src/modules/dcim/middleware.ts` | HIGH | ✅ PASS |
| `backend/src/modules/dcim/queries.ts` | HIGH | ✅ PASS |
| `backend/src/modules/dcim/audit.ts` | HIGH | ✅ PASS |
| `backend/src/index.ts` (DCIM additions) | HIGH | ✅ PASS |
| `backend/prisma/migrations/20260604120000_dcim_initial/migration.sql` | MEDIUM | ✅ PASS |
| `frontend/components/dcim/PlaceCIModal.tsx` | MEDIUM | ✅ PASS |
| `frontend/components/CIDetailModal.tsx` | MEDIUM | ✅ PASS |
| `frontend/components/EditCIModal.tsx` | MEDIUM | ✅ PASS |
| Frontend pages + components (M4–M9) | LOW | ✅ PASS |
| Locale files | LOW | ✅ PASS |

---

## A01 — Broken Access Control ✅ PASS

### Findings

**DCIM router mount (index.ts):**
```typescript
app.use('/api/dcim', authenticateToken, requireDcimAccess, createDcimRouter(prisma));
```
- `authenticateToken` always runs first — sets `req.user`, validates JWT, checks `users.active = true` ✅
- `requireDcimAccess` blocks `VIEWER` and unauthenticated (`!role`) on ALL DCIM routes ✅
- Individual write routes additionally apply `requireAdmin` ✅

**RBAC matrix verified:**
| Endpoint | VIEWER | AUDITOR | ADMIN |
|----------|--------|---------|-------|
| GET /api/dcim/* | 403 | ✅ | ✅ |
| POST/PATCH/DELETE /api/dcim/* | 403 | 403 | ✅ |
| PATCH /api/cis/:id/placement | 403 | 403 | ✅ |

**UUID validation:**
- All `:id` path params protected by `requireUuidParam('id')` ✅
- Query params (`buildingId`, `floorId`, `roomId`) validated with `isUuid()` helper before Prisma ✅
- `:ciId` in `/racks/:ciId/elevation` protected by `requireUuidParam('ciId')` ✅

**Retroactive coverage (M2.0):**
- 64 existing routes in contracts/documents/licenses/masters now have `requireUuidParam('id')` — closes F-02 from v2.6.x backlog ✅

### No issues found.

---

## A02 — Cryptographic Failures ✅ PASS

No new cryptographic operations in this diff. JWT/bcrypt/TLS unchanged.

---

## A03 — Injection ✅ PASS

### Findings

**All Prisma ORM calls:** use type-safe client methods (`.findMany`, `.create`, `.update`, `.delete`) — no SQL injection surface ✅

**Raw SQL queries (`$queryRaw`):**

`getOverpowerAlerts` (queries.ts):
```typescript
await prisma.$queryRaw<...>`
  SELECT hw.ci_id, ci.name, COALESCE(agg.sum_power_w, 0), hw.rack_power_max_w
  FROM hardware_cis hw ...
`
// No user input interpolated — fully static query ✅
```

`getRoomHeatmap` (queries.ts):
```typescript
WHERE fp.room_id = ${roomId}::uuid
```
- `roomId` is interpolated as a parameterized placeholder by tagged template — never string concatenation ✅
- `::uuid` cast adds DB-level type enforcement ✅

`dcimAudit` (audit.ts):
```typescript
VALUES (gen_random_uuid(), ${action}, ${entity}, ${entityId}::uuid, ${userEmail}, now())
```
- All values parameterized ✅
- `entityId` cast to `::uuid` — invalid UUID would error before insertion ✅
- `action`, `entity`, `userEmail` are caller-controlled strings, but all callers are internal (not from request body) ✅

**DCIM power cron (index.ts):**
```typescript
'system@cmdb.local' // hardcoded literal — not user-supplied ✅
```

### No issues found.

---

## A04 — Insecure Design

### Findings

**Zod schemas coverage:** all 10 POST/PATCH bodies have schema validation before Prisma ✅

**Enum fields:** `kind` (RACK_SLOT/INFRASTRUCTURE/EMPTY), `orientation` (FRONT/REAR), `aisle.kind` (HOT/COLD/MIXED) — all use `z.enum([...])` ✅

---

### 🟡 L-01 — gridX/gridY without upper bound [FIXED IN-BRANCH]

**File:** `backend/src/modules/dcim/schemas.ts`
**Original:**
```typescript
gridX: z.number().int().min(0),
gridY: z.number().int().min(0),
```
**Risk:** An ADMIN could insert a footprint at `gridX=9999999`, causing the ReactFlow canvas to render a ~1 million-cell grid, potentially causing OOM in the browser.
**Fix applied:** `max(999)` added to both fields.
**Severity:** Low — ADMIN-only surface, no data loss, frontend-only impact.

---

### 🟡 L-02 — uPosition/sizeU/powerW without upper bound [FIXED IN-BRANCH]

**File:** `backend/src/modules/dcim/schemas.ts`
**Original:**
```typescript
uPosition: z.number().int().min(1).nullable(),
sizeU:     z.number().int().min(1).nullable(),
powerW:    z.number().int().min(0).nullable(),
```
**Risk:** `uPosition=999999` or `sizeU=999999` would pass validation. The server's capacity check (`uEnd > rack.rackTotalU`) only runs when `rackTotalU` is set. Without it, absurd values would persist in the DB silently.
**Fix applied:** `max(1000)` on `uPosition`, `max(100)` on `sizeU`, `max(1_000_000)` on `powerW`.
**Severity:** Low — ADMIN-only, no privilege escalation, data integrity issue only.

---

### 🟡 L-03 — DcimBuildingUpdateSchema allows branchId change [BACKLOG v2.6.1]

**File:** `backend/src/modules/dcim/schemas.ts`
**Detail:** `DcimBuildingUpdateSchema = DcimBuildingCreateSchema.partial()` inherits `branchId: z.string().uuid().optional()`. This allows moving a building between branches via PATCH, which may break hierarchical assumptions (floors/rooms still reference the building).
**Risk:** Low — ADMIN-only, DB FK constraints prevent orphan data. Moving a building to a different branch is a valid admin operation but should ideally re-validate that the target branch exists and warn about the move.
**Recommendation:** In v2.6.1, omit `branchId` from `DcimBuildingUpdateSchema` or add explicit validation.

---

### 🟡 L-04 — Cron uses non-user email for audit log [BACKLOG v2.6.1]

**File:** `backend/src/index.ts` (DCIM power cron)
**Detail:**
```typescript
'system@cmdb.local' // user_email in DCIM_POWER_ALERT audit record
```
**Risk:** `system@cmdb.local` may not be recognized in audit log reports or filtered incorrectly by tools that expect real user emails. Not a security vulnerability — audit log integrity is maintained.
**Recommendation:** Introduce a reserved `SYSTEM_ACTOR = 'system@cmdb.local'` constant and document it in the audit log schema. Already used by pattern in other cron jobs (if any).

---

## A05 — Security Misconfiguration ✅ PASS

- No new debug endpoints introduced ✅
- `helmet` not modified ✅
- CSP not modified (DCIM module uses no `eval`, `Function()`, or inline scripts) ✅
- R3F/three.js (WebGL) NOT added in v2.6.0 (deferred to v2.7.0) — no CSP `unsafe-eval` needed ✅

---

## A06 — Vulnerable Components ✅ PASS

No new `npm` dependencies added. Existing `reactflow` (already installed) used for RoomPlan2D. No new packages to audit.

---

## A07 — Authentication & Session Failures ✅ PASS

- JWT validation via `authenticateToken` applied to all DCIM routes ✅
- `users.active` check runs on every request ✅
- No session tokens created or modified by DCIM code ✅

---

## A08 — Software & Data Integrity ✅ PASS

- No `eval()`, `Function()`, or `exec()` in DCIM code ✅
- Migration SQL uses `IF NOT EXISTS` guards — idempotent ✅
- CHECK constraints on DB for dimensions (`rack_width_mm`, `rack_depth_mm`, `width_mm`, `depth_mm` positive and < 100000) ✅
- Migration rollback SQL documented in comments ✅
- L-02 fix (Zod max bounds) closes the integer overflow surface ✅

---

## A09 — Logging & Monitoring Failures ✅ PASS

### Audit log coverage

| Operation | Audit action | Verified |
|-----------|--------------|---------|
| CREATE building/floor/room/aisle/footprint | `CREATE_DCIM_*` | ✅ |
| UPDATE building/floor/room/aisle/footprint | `UPDATE_DCIM_*` | ✅ |
| DELETE building/floor/room/aisle/footprint | `DELETE_DCIM_*` | ✅ |
| Assign rack to footprint | `ASSIGN_RACK` | ✅ |
| Unassign rack from footprint | `UNASSIGN_RACK` | ✅ |
| CI physical placement | `CI_PLACEMENT` | ✅ |
| Daily power overload scan | `DCIM_POWER_ALERT` | ✅ |

All audit records use `dcimAudit()` with `prisma.$executeRaw` tagged template — insert-only, never update/delete (ISO 27001 A.8.15 immutability) ✅

**Internal errors:** all catch blocks log `console.error('[DCIM] ...')` internally and return generic `{ error: 'Internal server error' }` — no stack traces or Prisma error objects exposed ✅

---

## A10 — Server-Side Request Forgery ✅ PASS

No outbound HTTP calls in the DCIM module. The power cron calls only internal Prisma methods. No caller-supplied URLs accepted.

---

## Summary of Actions

| ID | Severity | Action | Status |
|----|----------|--------|--------|
| L-01 | Low | Add `max(999)` to `gridX`/`gridY` in `DcimFootprintCreateSchema` | ✅ Fixed in-branch |
| L-02 | Low | Add `max()` bounds to `uPosition`, `sizeU`, `powerW` in `CIPlacementSchema` | ✅ Fixed in-branch |
| L-03 | Low | Restrict `branchId` change in `DcimBuildingUpdateSchema` | → Backlog v2.6.1 |
| L-04 | Low | Document `system@cmdb.local` as reserved system actor constant | → Backlog v2.6.1 |

---

## Coverage Notes

- Frontend components reviewed for XSS surface (no `dangerouslySetInnerHTML`, no `eval`) ✅
- ReactFlow node data is typed — no arbitrary HTML injection ✅
- PlaceCIModal: client-side conflict check is informational only; server enforces placement validation ✅
- i18n locale files reviewed — no executable content ✅

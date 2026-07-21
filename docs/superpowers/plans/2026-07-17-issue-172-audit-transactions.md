# Issue #172 — Transactional Audit for Legacy + Remaining Modules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining scope of issue #172 (ISO 27001 A.8.15) by making every write-then-audit code path in `backend/src/index.ts` and the 6 non-staff-schedule modules (`catalog`, `dcim`, `decommission`, `settings`, `alerts`, `plugins`) atomic — if the audit insert fails, the business mutation must roll back. Today these paths do `mutation` then a *separate* `$executeRaw`/`$queryRaw` audit insert against the base `prisma` client; a crash or DB error between the two steps leaves an unlogged write.

**Architecture:** Reuse the exact pattern already shipped for `staff-schedule` in v3.5.1 (`backend/src/modules/staff-schedule/router.ts` + `audit.ts`): wrap `mutation + audit insert` in one `prisma.$transaction(async (tx) => { ... })`, pass `tx` to both, and widen every audit-helper's client parameter from `PrismaClient` to `Prisma.TransactionClient` (the base `PrismaClient` is structurally assignable to `Prisma.TransactionClient`, so this is a non-breaking widen — confirmed by the staff-schedule precedent, which is already merged and running in prod). Modules that build query helpers via a factory function bound to a client in closure (e.g. `catalog/queries.ts`'s `dtQueries(prisma)`) need that factory's parameter widened too, and the factory re-invoked with `tx` inside the transaction — `dtQueries(tx)` instead of the router-level `dt` bound to the base client.

**Tech Stack:** Express 5, TypeScript, Prisma 6 (`Prisma.TransactionClient`), Jest + Supertest.

## Global Constraints

- Every write path with an associated audit insert must become atomic (mutation + audit in one `prisma.$transaction`). No exceptions for "small" or "internal" writes — A.8.15 applies uniformly.
- `AuditLog`/`audit_logs` is insert-only — never update/delete it from application code (existing constraint, unaffected by this work).
- `tsc --noEmit` must pass with 0 new errors (see CLAUDE.md's pre-existing-error allowlist — do not touch those two known errors).
- Full backend test suite (`jest`) must stay green after each task; each task also adds exactly one new rollback test per domain, mirroring `backend/src/modules/staff-schedule/__tests__/auditTransaction.test.ts`, proving: (a) success path commits both mutation and audit, (b) forced audit failure rolls back the mutation (0 rows committed).
- Do not touch `reports/audit.ts` (`VIEW_REPORT`/`EXPORT_REPORT`) — those are read-path audits and are explicitly out of scope (confirmed defensible in the roadmap doc, `docs/superpowers/plans/2026-07-16-open-issues-remediation-roadmap.md:64`).
- Commit after each task, not after each step-group — one commit per domain, Conventional Commits style (`fix(<module>): wrap <domain> writes in transactional audit (#172)`).

---

## Reference Pattern (already shipped, do not re-derive — copy this shape)

`backend/src/modules/staff-schedule/router.ts:56-72`:

```typescript
router.post('/departments', requireAdmin, async (req: Request, res: Response) => {
  const parsed = DepartmentSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
  try {
    const department = await prisma.$transaction(async (tx) => {
      const dept = await tx.department.create({ data: parsed.data });
      await tx.departmentScheduleConfig.create({ data: { departmentId: dept.id } });
      await auditStaffSchedule(tx, { action: 'CREATE_DEPARTMENT', entity: 'DEPARTMENT', entityId: dept.id, userEmail: req.user!.email });
      return dept;
    });
    res.status(201).json(department);
  } catch (err: any) {
    if (err?.code === 'P2002') { res.status(409).json({ error: 'Department code already exists' }); return; }
    console.error('[StaffSchedule] department create error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});
```

`backend/src/modules/staff-schedule/audit.ts:1,21-35` (the widened helper signature):

```typescript
import { Prisma } from '@prisma/client';

export async function auditStaffSchedule(
  db: Prisma.TransactionClient,
  params: { action: string; entity: StaffScheduleEntity; entityId: string; userEmail: string },
): Promise<void> {
  const { action, entity, entityId, userEmail } = params;
  await db.$executeRaw`
    INSERT INTO "audit_logs"(id, action, entity, entity_id, user_email, created_at)
    VALUES (gen_random_uuid(), ${action}, ${entity}, ${entityId}::uuid, ${userEmail}, now())
  `;
}
```

`backend/src/modules/staff-schedule/__tests__/auditTransaction.test.ts` (the rollback-test shape — mock `prisma.$transaction` so it only "commits" staged writes if the callback resolves; a throw inside — the simulated audit failure — discards everything staged). Every domain task below adds one file following this exact structure, swapped to that domain's own mutation + audit shape.

---

## Inventory (verified 2026-07-17 against `develop`)

**`backend/src/index.ts`** — 29 non-transactional write+audit sites (10 other sites already use `tx.$executeRaw` inside an existing `prisma.$transaction`, e.g. the CI bulk-import master-row creation at `index.ts:3700-3852` — those are already correct, skip them):

| Domain (task) | Route | Line | Action |
|---|---|---|---|
| Auth/session (Task 5) | `GET /api/auth/sso/microsoft/callback` | 794 | SSO login write |
| Auth/session (Task 5) | `POST /api/auth/logout` | 861 | logout |
| Auth/session (Task 5) | `POST /api/auth/login` | 971 | local login |
| User admin (Task 4) | `PATCH /api/users/:id/role` | 1112 | `SET_ROLE:*` |
| User admin (Task 4) | `PATCH /api/users/:id/status` | 1142 | `ACTIVATE_USER`/`DEACTIVATE_USER` |
| User admin (Task 4) | `POST /api/profile/change-password` | 1214 | password change |
| User admin (Task 4) | `POST /api/users/:id/reset-password` | 1261 | admin reset |
| User admin (Task 4) | `DELETE /api/admin/users/:id` | 1317, 1326 | GDPR erasure (pseudonymise + delete + `GDPR_ERASURE` insert — 3-step, see Task 4) |
| CI core (Task 2) | `POST /api/cis` | 1491 | `CREATE_CI` |
| CI core (Task 2) | `PATCH /api/cis/:id` | 1723 | CI update |
| CI links/misc (Task 7) | `PATCH /api/vulnerabilities` | 1965 | vuln patch |
| CI bulk import (Task 6) | `POST /api/cis/bulk/batches` | 2266 | batch upload |
| CI bulk import (Task 6) | `DELETE /api/cis/bulk/items/:id` | 2336 | `CI_BULK_DISCARD_ITEM` |
| CI bulk import (Task 6) | `DELETE /api/cis/bulk/batches/:id` | 2349 | `CI_BULK_DISCARD_BATCH` |
| CI bulk import (Task 6) | `POST /api/cis/bulk/items/:id/reanalyze` | 2452 | `CI_BULK_REANALYZE_ITEM` |
| CI bulk import (Task 6) | `POST /api/cis/bulk/batches/:id/reanalyze` | 2470 | batch reanalyze |
| Auth/session (Task 5) | `POST /api/auth/mfa/setup` | 2584 | MFA setup |
| Auth/session (Task 5) | `POST /api/auth/mfa/enable` | 2648 | MFA enable |
| CI links/misc (Task 7) | `POST /api/admin/certificates/upload` | 2794 | cert upload |
| Relations (Task 3) | `POST /api/cis/:id/relations` | 3069 | `CREATE_RELATION:*` |
| Relations (Task 3) | `POST /api/relations` | 3145 | `CREATE_RELATION:*` |
| Relations (Task 3) | `DELETE /api/relations/:id` | 3184 | relation delete |
| CI core (Task 2) | `PATCH /api/cis/:id/verification` | 3227 | verification |
| CI core (Task 2) | `PATCH /api/cis/:id/placement` | 3313 | DCIM placement |
| CI links/misc (Task 7) | `POST /api/cis/:id/contracts` | 3942 | `LINK_CI` contract |
| CI links/misc (Task 7) | `DELETE /api/cis/:id/contracts/:contractId` | 3963 | `UNLINK_CI` contract |
| CI links/misc (Task 7) | `POST /api/cis/:id/documents` | 3986 | `LINK_CI` document |
| CI links/misc (Task 7) | `DELETE /api/cis/:id/documents/:docId` | 4000 | `UNLINK_CI` document |

**Modules** (Tasks 1, 8–12) — every call site uses a module-local audit helper typed `prisma: PrismaClient` (needs widening to `Prisma.TransactionClient`, same as staff-schedule's fix):

| Module | Helper (file) | Call sites | Query factory to widen? |
|---|---|---|---|
| `catalog` (Task 1) | `catalogAudit` (`catalog/audit.ts`) | 14 (`catalog/router.ts`) | Yes — `catalog/queries.ts`: `dtQueries`, `ciDateQueries`, `osDateQueries`, `bswDateQueries`, `dmDateQueries`, `osQueries`, `bswQueries` all typed `(prisma: PrismaClient)` |
| `dcim` (Task 8) | `dcimAudit` (`dcim/audit.ts`) | 16 (`dcim/router.ts`) | Check `dcim/queries.ts` for the same factory pattern |
| `decommission` (Task 9) | `decommissionAudit` (`decommission/audit.ts`) | 11 (`decommission/router.ts`) | Check `decommission/queries.ts` |
| `settings` (Task 10) | `settingsAudit` (`settings/audit.ts`) | 3 (`settings/router.ts`) | No `queries.ts` — router likely calls `prisma` directly, verify |
| `alerts` (Task 11) | `insertAlertAudit` (`alerts/audit.ts`) | 5 (4 in `alerts/router.ts`, 1 cron-triggered in `alerts/pipeline.ts:99`) | Check `alerts/queries.ts` |
| `plugins` (Task 12) | `pluginAudit` (`plugins/audit.ts`) | 17 (16 in `plugins/router.ts`, 1 in `plugins/index.ts:52`) | Check `plugins/queries.ts`; several sites are `PLUGIN_VALIDATION_FAILED` audits inside validation branches — verify each is (or isn't) paired with a persisted mutation before wrapping (see Task 12 notes) |

**Sequencing rationale:** highest-risk/highest-volume domains first (catalog as the fully-traced template, then CI core/relations/user-admin which are the busiest legacy write paths and include the GDPR erasure 3-step sequence), then the remaining modules by descending call-site count.

---

### Task 1: `catalog` module — widen query factories + audit helper, wrap all 14 write sites

**Files:**
- Modify: `backend/src/modules/catalog/queries.ts` (7 factory function signatures)
- Modify: `backend/src/modules/catalog/audit.ts`
- Modify: `backend/src/modules/catalog/router.ts` (14 call sites)
- Test: `backend/src/modules/catalog/__tests__/auditTransaction.test.ts` (new)

**Interfaces:**
- Produces: `catalogAudit(db: Prisma.TransactionClient, action: string, entity: string, entityId: string, userEmail: string): Promise<void>` (signature unchanged except param type)
- Produces: `dtQueries(client: Prisma.TransactionClient): { list, findById, findByCode, create, update, delete, countUsage }` and the same widening for `ciDateQueries`, `osDateQueries`, `bswDateQueries`, `dmDateQueries`, `osQueries`, `bswQueries` — used by Task 1 only.

- [ ] **Step 1: Read the current factory signatures**

Run: `sed -n '1,10p;68,72p;100,104p;132,136p;164,168p;198,202p;257,261p' backend/src/modules/catalog/queries.ts`
Confirm each of the 7 exported functions is `export function XQueries(prisma: PrismaClient) {`.

- [ ] **Step 2: Widen all 7 factory signatures and the audit helper**

In `backend/src/modules/catalog/queries.ts`, change the import and each function signature:

```typescript
import { Prisma, DateTypeCategory } from '@prisma/client';

export function dtQueries(prisma: Prisma.TransactionClient) {
```

Apply the identical `PrismaClient` → `Prisma.TransactionClient` edit to `ciDateQueries`, `osDateQueries`, `bswDateQueries`, `dmDateQueries`, `osQueries`, `bswQueries`. Keep every parameter name as `prisma` (unchanged) — only the type changes.

In `backend/src/modules/catalog/audit.ts`, change the import and the `catalogAudit` first parameter from `PrismaClient` to `Prisma.TransactionClient` (mirror `staff-schedule/audit.ts:1,21-22` exactly — same widening, same doc-comment referencing #172).

- [ ] **Step 3: Wrap the DateType CRUD handlers (`catalog/router.ts:70-146`)**

Replace:

```typescript
  router.post('/date-types', requireAdmin, async (req: Request, res: Response) => {
    const parsed = DateTypeCreateSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.errors }); return; }

    const { code, name, description, category, sortOrder, isSystem } = parsed.data;
    try {
      const existing = await dt.findByCode(code);
      if (existing) { res.status(409).json({ error: 'Code already exists' }); return; }

      const record = await dt.create({
        code,
        name,
        description : description ?? null,
        category,
        sortOrder   : sortOrder ?? 0,
        isSystem    : isSystem ?? false,
      });
      await catalogAudit(prisma, 'CREATE_DATE_TYPE', 'DateType', record.id, (req as any).user!.email);
      res.status(201).json(record);
    } catch (err: any) {
      if (err?.code === 'P2002') { res.status(409).json({ error: 'Code already exists' }); return; }
      console.error('[catalog] create DateType error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });
```

With:

```typescript
  router.post('/date-types', requireAdmin, async (req: Request, res: Response) => {
    const parsed = DateTypeCreateSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.errors }); return; }

    const { code, name, description, category, sortOrder, isSystem } = parsed.data;
    try {
      const existing = await dt.findByCode(code);
      if (existing) { res.status(409).json({ error: 'Code already exists' }); return; }

      const record = await prisma.$transaction(async (tx) => {
        const created = await dtQueries(tx).create({
          code,
          name,
          description : description ?? null,
          category,
          sortOrder   : sortOrder ?? 0,
          isSystem    : isSystem ?? false,
        });
        await catalogAudit(tx, 'CREATE_DATE_TYPE', 'DateType', created.id, (req as any).user!.email);
        return created;
      });
      res.status(201).json(record);
    } catch (err: any) {
      if (err?.code === 'P2002') { res.status(409).json({ error: 'Code already exists' }); return; }
      console.error('[catalog] create DateType error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });
```

Note `dtQueries` must be imported directly in `router.ts` (it already is, per the existing `import { dtQueries, ... } from './queries.js'` at line 11) — call `dtQueries(tx)` fresh inside the transaction instead of reusing the router-level `dt` (which stays bound to the base `prisma` client and is still fine for read-only GET handlers, which are untouched by this task).

Apply the identical transform (existence-check reads stay outside `$transaction`, the actual `create`/`update`/`delete` + `catalogAudit` call move inside `prisma.$transaction(async (tx) => {...})` using `dtQueries(tx)` or the relevant date-queries factory bound to `tx`) to the remaining 12 sites:
- `PATCH /date-types/:id` (router.ts:98-121)
- `DELETE /date-types/:id` (router.ts:124-146)
- The 3 generic date-lifecycle routes built by `entityDateRoutes(...)` (router.ts:148-216) — these are a shared closure used for `cis`, `operating-systems`, and 2 more entity kinds; wrap the single shared closure body (around router.ts:180,198,209) once — fixing the closure fixes all its call sites.
- `CREATE_OS` / `UPDATE_OS` / `DELETE_OS` (router.ts:274,303,328) using `osQueries(tx)`
- `CREATE_BASE_SOFTWARE` / `UPDATE_BASE_SOFTWARE` / `DELETE_BASE_SOFTWARE` (router.ts:389,418,443) using `bswQueries(tx)`
- `ASSOCIATE_BASE_SOFTWARE` / `DISSOCIATE_BASE_SOFTWARE` (router.ts:485,501)

- [ ] **Step 4: Run the existing catalog test suite**

Run: `cd backend && npx jest src/modules/catalog --runInBand`
Expected: all existing tests still PASS (the widened types don't change runtime behavior for the base-client call path).

- [ ] **Step 5: Write the rollback test**

Create `backend/src/modules/catalog/__tests__/auditTransaction.test.ts`, following `staff-schedule/__tests__/auditTransaction.test.ts` exactly, but mocking `dtQueries`/`prisma.dateType` instead of `prisma.department`:

```typescript
import express from 'express';
import request from 'supertest';
import { createCatalogRouter } from '../router';

interface Committed { dateTypes: unknown[]; audits: number; }

function makeMockPrisma(opts: { failAudit: boolean }) {
  const committed: Committed = { dateTypes: [], audits: 0 };

  const prisma = {
    dateType: {
      findUnique: async () => null, // no existing code — create path proceeds
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const staged: Committed = { dateTypes: [], audits: 0 };
      const tx = {
        dateType: {
          create: async ({ data }: { data: Record<string, unknown> }) => {
            const record = { id: 'dt-1', ...data };
            staged.dateTypes.push(record);
            return record;
          },
        },
        $executeRaw: async () => {
          if (opts.failAudit) throw new Error('audit insert failed (simulated)');
          staged.audits += 1;
          return 1;
        },
      };
      const result = await fn(tx);
      committed.dateTypes.push(...staged.dateTypes);
      committed.audits += staged.audits;
      return result;
    },
  };

  return { prisma, committed };
}

function buildApp(prisma: unknown) {
  const app = express();
  app.use(express.json());
  app.use((req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as unknown as { user: unknown }).user = { id: 'admin-1', email: 'admin@test.local', role: 'ADMIN' };
    next();
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.use('/api/catalog', createCatalogRouter(prisma as any));
  return app;
}

const validBody = { code: 'TEST_TX', name: 'Test Date Type', category: 'CI' };

describe('catalog transactional audit (issue #172)', () => {
  it('commits the DateType AND its audit record when the audit succeeds', async () => {
    const { prisma, committed } = makeMockPrisma({ failAudit: false });
    const res = await request(buildApp(prisma)).post('/api/catalog/date-types').send(validBody);

    expect(res.status).toBe(201);
    expect(committed.dateTypes).toHaveLength(1);
    expect(committed.audits).toBe(1);
  });

  it('does NOT persist the DateType when the audit insert fails (rollback)', async () => {
    const { prisma, committed } = makeMockPrisma({ failAudit: true });
    const res = await request(buildApp(prisma)).post('/api/catalog/date-types').send(validBody);

    expect(res.status).toBe(500);
    expect(committed.dateTypes).toHaveLength(0);
    expect(committed.audits).toBe(0);
  });
});
```

Adjust the mock's `findByCode`/`findUnique` shape to whatever `dtQueries(prisma).findByCode` actually calls (check `catalog/queries.ts:5-67` for the exact Prisma model/method it uses before finalizing the mock).

- [ ] **Step 6: Run the new test**

Run: `cd backend && npx jest src/modules/catalog/__tests__/auditTransaction.test.ts -v`
Expected: both tests PASS.

- [ ] **Step 7: Full backend type-check and test suite**

Run: `cd backend && npx tsc --noEmit`
Expected: 0 new errors (only the 2 known pre-existing `license`/`licenseUser` errors from CLAUDE.md).

Run: `cd backend && npx jest --runInBand`
Expected: all suites PASS.

- [ ] **Step 8: Commit**

```bash
git add backend/src/modules/catalog/
git commit -m "fix(catalog): wrap DateType/OS/BaseSoftware writes in transactional audit (#172)"
```

---

### Task 2: `index.ts` — CI core writes (create, update, verification, placement)

**Files:**
- Modify: `backend/src/index.ts:1450-1501` (`POST /api/cis`), `:1723` area (`PATCH /api/cis/:id`), `:3227` area (`PATCH /api/cis/:id/verification`), `:3313` area (`PATCH /api/cis/:id/placement`)
- Test: `backend/src/__tests__/ciAuditTransaction.test.ts` (new — or the existing legacy test directory for `index.ts`, check `backend/src/__tests__/` for the established location first)

**Interfaces:**
- Consumes: nothing new — uses the module-level `prisma: PrismaClient` already in scope in `index.ts`.
- Produces: nothing consumed by other tasks (each `index.ts` task is independent).

- [ ] **Step 1: Wrap `POST /api/cis` (index.ts:1450-1501)**

Replace:

```typescript
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ci = await prisma.cI.create({
      data: {
        name, apiSlug, criticality, environment,
        // ... (all fields unchanged)
      } as Parameters<typeof prisma.cI.create>[0]['data'],
      include: CI_INCLUDE,
    });

    // Audit log (raw — Prisma client types regenerate after migrate)
    const createDetails = JSON.stringify(buildAuditDetails(`CI "${ci.name}" creado`));
    await prisma.$executeRaw`
      INSERT INTO "audit_logs" (id, action, entity, entity_id, user_email, details, created_at)
      VALUES (gen_random_uuid(), 'CREATE_CI', 'CI', ${ci.id}, ${req.user!.email}, ${createDetails}::jsonb, now())
    `;
```

With:

```typescript
    const ci = await prisma.$transaction(async (tx) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const created = await tx.cI.create({
        data: {
          name, apiSlug, criticality, environment,
          // ... (all fields unchanged)
        } as Parameters<typeof prisma.cI.create>[0]['data'],
        include: CI_INCLUDE,
      });

      // Audit log (raw — Prisma client types regenerate after migrate)
      const createDetails = JSON.stringify(buildAuditDetails(`CI "${created.name}" creado`));
      await tx.$executeRaw`
        INSERT INTO "audit_logs" (id, action, entity, entity_id, user_email, details, created_at)
        VALUES (gen_random_uuid(), 'CREATE_CI', 'CI', ${created.id}, ${req.user!.email}, ${createDetails}::jsonb, now())
      `;
      return created;
    });
```

Keep everything after the original `INSERT INTO audit_logs` block (`queueEntityForIndexing`, `emitHook('postCreateCI', ...)`, `res.status(201).json(flattenCI(ci))`) **outside** the transaction, unchanged — those are non-DB side effects that should run only after the transaction commits, and must not roll back the CI creation if they fail (they already fail open with `try/catch` + `console.error`, unaffected by this change since `ci` is still in scope).

- [ ] **Step 2: Wrap `PATCH /api/cis/:id` (index.ts:1723 area)**

Read the handler first: `sed -n '1690,1770p' backend/src/index.ts`. It follows the same shape as Step 1 (ORM mutation, then a separate `$executeRaw` audit insert). Apply the identical transform: everything from the `prisma.cI.update(...)` call through the audit `$executeRaw` moves inside `prisma.$transaction(async (tx) => {...})`, with `prisma.` swapped to `tx.` only for those two calls. Any post-audit side effects (re-indexing, hooks) stay outside, exactly as in Step 1.

- [ ] **Step 3: Wrap `PATCH /api/cis/:id/verification` (index.ts:3227 area)**

Read the handler: `sed -n '3200,3260p' backend/src/index.ts`. Apply the same transform as Step 1/2.

- [ ] **Step 4: Wrap `PATCH /api/cis/:id/placement` (index.ts:3313 area)**

Read the handler: `sed -n '3280,3340p' backend/src/index.ts`. Apply the same transform. This is the DCIM rack-placement endpoint (v2.6.1) — check whether it performs more than one mutation (e.g. footprint + CI update) before the audit insert; if so, all mutations before the audit call move inside the same `tx` block together.

- [ ] **Step 5: Run tsc and the full backend test suite**

Run: `cd backend && npx tsc --noEmit && npx jest --runInBand`
Expected: 0 new tsc errors, all tests PASS.

- [ ] **Step 6: Write the rollback test for `POST /api/cis`**

Locate the existing test file that exercises `POST /api/cis` (search `grep -rl "POST /api/cis'" backend/src/__tests__ backend/src/**/__tests__ 2>/dev/null` or `grep -rln "api/cis'" backend/src --include="*.test.ts"`). Add a new `describe('CI creation transactional audit (issue #172)', ...)` block to that file (or a new adjacent file if none exists), following the exact mock-`$transaction` shape from `staff-schedule/__tests__/auditTransaction.test.ts`, mocking `tx.cI.create` and `tx.$executeRaw`, asserting: audit-success → CI committed + 1 audit row staged; audit-failure → 0 CIs committed, request returns 500.

- [ ] **Step 7: Run the new test**

Run: `cd backend && npx jest <path-to-test-file> -v`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add backend/src/index.ts backend/src/__tests__/
git commit -m "fix(cis): wrap CI create/update/verification/placement writes in transactional audit (#172)"
```

---

### Task 3: `index.ts` — Relations writes (create-on-CI, create, delete)

**Files:**
- Modify: `backend/src/index.ts:3069` area (`POST /api/cis/:id/relations`), `:3145` area (`POST /api/relations`), `:3184` area (`DELETE /api/relations/:id`)
- Test: extend or create a relations transaction test file alongside the existing relations test suite (`grep -rln "relations" backend/src --include="*.test.ts"` to find it).

**Interfaces:**
- Independent of other tasks.

- [ ] **Step 1: Wrap `POST /api/cis/:id/relations` (index.ts:3069 area, shown at index.ts:3055-3071)**

Replace:

```typescript
    // Atomic INSERT...SELECT: inserts only if both CIs exist, eliminating TOCTOU race
    const relation = await prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO ci_relations (id, source_ci_id, target_ci_id, relation_type, created_by, created_at)
      SELECT gen_random_uuid(), ${sourceCiId}::uuid, ${targetCiId}::uuid, ${relationType}::"RelationType", ${req.user!.email}, now()
      WHERE (SELECT COUNT(*) FROM configuration_items WHERE id IN (${sourceCiId}::uuid, ${targetCiId}::uuid)) = 2
      RETURNING id::text
    `;

    if (!relation.length) {
      res.status(404).json({ error: 'One or both CIs not found.' });
      return;
    }

    await prisma.$executeRaw`
      INSERT INTO "audit_logs" (id, action, entity, entity_id, user_email, created_at)
      VALUES (gen_random_uuid(), ${'CREATE_RELATION:' + relationType}, 'CI_RELATION', ${relation[0].id}, ${req.user!.email}, now())
    `;
```

With:

```typescript
    const relation = await prisma.$transaction(async (tx) => {
      // Atomic INSERT...SELECT: inserts only if both CIs exist, eliminating TOCTOU race
      const inserted = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO ci_relations (id, source_ci_id, target_ci_id, relation_type, created_by, created_at)
        SELECT gen_random_uuid(), ${sourceCiId}::uuid, ${targetCiId}::uuid, ${relationType}::"RelationType", ${req.user!.email}, now()
        WHERE (SELECT COUNT(*) FROM configuration_items WHERE id IN (${sourceCiId}::uuid, ${targetCiId}::uuid)) = 2
        RETURNING id::text
      `;

      if (!inserted.length) return inserted;

      await tx.$executeRaw`
        INSERT INTO "audit_logs" (id, action, entity, entity_id, user_email, created_at)
        VALUES (gen_random_uuid(), ${'CREATE_RELATION:' + relationType}, 'CI_RELATION', ${inserted[0].id}, ${req.user!.email}, now())
      `;
      return inserted;
    });

    if (!relation.length) {
      res.status(404).json({ error: 'One or both CIs not found.' });
      return;
    }
```

Note the `if (!relation.length)` 404 check moves *after* the transaction (an empty `INSERT...SELECT` result is not an error to roll back — nothing was inserted, the transaction commits a no-op safely, then the route reports 404 based on the returned empty array).

- [ ] **Step 2: Wrap `POST /api/relations` (index.ts:3145 area)**

Read the handler: `sed -n '3096,3180p' backend/src/index.ts`. It mirrors Step 1's shape (same atomic `INSERT...SELECT` + separate audit insert pattern, confirmed identical at index.ts:3116 onward). Apply the identical transform.

- [ ] **Step 3: Wrap `DELETE /api/relations/:id` (index.ts:3184 area)**

Read the handler: `sed -n '3180,3230p' backend/src/index.ts`. Apply the same transform: the `DELETE FROM ci_relations` and the audit insert move inside `prisma.$transaction(async (tx) => {...})`, both using `tx`.

- [ ] **Step 4: Run tsc and full test suite**

Run: `cd backend && npx tsc --noEmit && npx jest --runInBand`
Expected: 0 new errors, all PASS.

- [ ] **Step 5: Write the rollback test**

Find or create the relations test file (`grep -rln "api/relations" backend/src --include="*.test.ts"`). Add a `describe('relation creation transactional audit (issue #172)', ...)` block mocking `tx.$queryRaw` (returns `[{id: 'rel-1'}]` on success) and `tx.$executeRaw` (throws when `failAudit: true`), asserting 0 relations "committed" (i.e., the mock's staged-then-committed array stays empty) when the audit insert throws.

- [ ] **Step 6: Run the new test**

Run: `cd backend && npx jest <relations-test-file> -v`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/src/index.ts backend/src/__tests__/
git commit -m "fix(relations): wrap CI relation create/delete writes in transactional audit (#172)"
```

---

### Task 4: `index.ts` — User admin writes (role, status, password, GDPR erasure)

**Files:**
- Modify: `backend/src/index.ts:1102-1120` (role), `:1127-1150` (status), `:1214` area (change-password), `:1261` area (reset-password), `:1291-1334` (GDPR erasure)
- Test: extend or create a user-admin transaction test file (`grep -rln "api/users" backend/src --include="*.test.ts"`)

**Interfaces:** Independent of other tasks.

- [ ] **Step 1: Wrap `PATCH /api/users/:id/role` (index.ts:1102-1120)**

Replace:

```typescript
  try {
    await prisma.$executeRaw`UPDATE "users" SET role = ${role}, updated_at = now() WHERE id = ${id}::uuid`;
    await prisma.$executeRaw`
      INSERT INTO "audit_logs"(id, action, entity, entity_id, user_email, created_at)
      VALUES(gen_random_uuid(), ${'SET_ROLE:' + role}, 'USER', ${id}, ${req.user!.email}, now())
    `;
    res.json({ id, role, message: `Role updated to ${role}` });
  } catch (e) {
```

With:

```typescript
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`UPDATE "users" SET role = ${role}, updated_at = now() WHERE id = ${id}::uuid`;
      await tx.$executeRaw`
        INSERT INTO "audit_logs"(id, action, entity, entity_id, user_email, created_at)
        VALUES(gen_random_uuid(), ${'SET_ROLE:' + role}, 'USER', ${id}, ${req.user!.email}, now())
      `;
    });
    res.json({ id, role, message: `Role updated to ${role}` });
  } catch (e) {
```

- [ ] **Step 2: Wrap `PATCH /api/users/:id/status` (index.ts:1127-1150)**

Apply the identical transform shown in Step 1 to the `UPDATE "users" SET active = ...` + `ACTIVATE_USER`/`DEACTIVATE_USER` audit pair.

- [ ] **Step 3: Wrap `POST /api/profile/change-password` (index.ts:1214 area) and `POST /api/users/:id/reset-password` (index.ts:1261 area)**

Read both handlers: `sed -n '1180,1290p' backend/src/index.ts`. Apply the identical transform — the password `UPDATE`/bcrypt-hash write and the audit insert move inside one `prisma.$transaction`. If either handler also writes to `password_history` (check `PASSWORD_HISTORY_COUNT` handling mentioned in CLAUDE.md), that insert moves inside the same transaction too — it is a mutation that must not survive an audit failure either.

- [ ] **Step 4: Wrap the 3-step GDPR erasure (index.ts:1291-1334) — highest-risk site in this task**

Replace:

```typescript
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
    const pseudoToken = '[deleted-' +
      crypto.createHash('sha256').update(email + JWT_SECRET_VALUE).digest('hex').slice(0, 16) +
      ']';
    await prisma.$executeRaw`
      UPDATE "audit_logs" SET user_email = ${pseudoToken} WHERE user_email = ${email}
    `;

    // 3. Hard-delete the user
    await prisma.$executeRaw`DELETE FROM "users" WHERE id = ${targetId}::uuid`;

    // 4. Record the erasure in the audit log under the admin's email
    await prisma.$executeRaw`
      INSERT INTO "audit_logs"(id, action, entity, entity_id, user_email, created_at)
      VALUES(gen_random_uuid(), 'GDPR_ERASURE', 'USER', ${targetId}::uuid, ${req.user!.email}, now())
    `;

    log.info(`[DELETE /api/admin/users/${targetId}] GDPR erasure completed by ${req.user!.email}. Audit logs pseudonymised as ${pseudoToken}.`);
    res.json({ message: 'User erased. Audit log entries pseudonymised.' });

  } catch (error) {
```

With:

```typescript
  try {
    const pseudoToken = await prisma.$transaction(async (tx) => {
      // 1. Resolve the user and get their email
      const rows = await tx.$queryRaw<{ id: string; email: string; username: string }[]>`
        SELECT id::text AS id, email, username FROM "users" WHERE id = ${targetId}::uuid LIMIT 1
      `;
      if (!rows.length) return null;
      const { email } = rows[0];

      // 2. Pseudonymise audit_logs: replace user_email with a stable, non-reversible token.
      const token = '[deleted-' +
        crypto.createHash('sha256').update(email + JWT_SECRET_VALUE).digest('hex').slice(0, 16) +
        ']';
      await tx.$executeRaw`
        UPDATE "audit_logs" SET user_email = ${token} WHERE user_email = ${email}
      `;

      // 3. Hard-delete the user
      await tx.$executeRaw`DELETE FROM "users" WHERE id = ${targetId}::uuid`;

      // 4. Record the erasure in the audit log under the admin's email
      await tx.$executeRaw`
        INSERT INTO "audit_logs"(id, action, entity, entity_id, user_email, created_at)
        VALUES(gen_random_uuid(), 'GDPR_ERASURE', 'USER', ${targetId}::uuid, ${req.user!.email}, now())
      `;
      return token;
    });

    if (pseudoToken === null) {
      res.status(404).json({ error: 'User not found.' });
      return;
    }

    log.info(`[DELETE /api/admin/users/${targetId}] GDPR erasure completed by ${req.user!.email}. Audit logs pseudonymised as ${pseudoToken}.`);
    res.json({ message: 'User erased. Audit log entries pseudonymised.' });

  } catch (error) {
```

This is the single most important site in the whole issue: previously, if step 4 (the `GDPR_ERASURE` audit insert) failed after step 3 (the hard `DELETE FROM users`) had already committed, the user would be permanently erased with **no compliance record of who erased them or when** — an unrecoverable audit gap on the most sensitive write path in the system. Wrapping all 4 steps in one transaction closes that gap completely: any failure anywhere in the sequence rolls back the pseudonymisation, the delete, and the audit insert together.

- [ ] **Step 5: Run tsc and full test suite**

Run: `cd backend && npx tsc --noEmit && npx jest --runInBand`
Expected: 0 new errors, all PASS.

- [ ] **Step 6: Write rollback tests — role change and GDPR erasure (minimum 2 of the 5 sites in this task, given the erasure site's severity)**

Find or create the user-admin test file. Add:
1. A `SET_ROLE` transactional-audit test (mirrors Task 3 pattern: mock `tx.$executeRaw` called twice — once for the `UPDATE users`, once for the audit — throw on the second call, assert 0 staged mutations committed).
2. A `GDPR_ERASURE` transactional-audit test: mock `tx.$queryRaw` (returns the user row), `tx.$executeRaw` (3 calls: pseudonymise, delete, audit — throw on the 3rd), assert the mock's committed state shows **the user was NOT deleted** when the final audit insert fails. This is the test that directly proves the compliance gap described in Step 4 is closed.

- [ ] **Step 7: Run the new tests**

Run: `cd backend && npx jest <user-admin-test-file> -v`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add backend/src/index.ts backend/src/__tests__/
git commit -m "fix(users): wrap role/status/password/GDPR-erasure writes in transactional audit (#172)"
```

---

### Task 5: `index.ts` — Auth/session writes (SSO callback, logout, MFA setup/enable)

**Files:**
- Modify: `backend/src/index.ts:794` area (SSO callback), `:861` area (logout), `:2584` area (MFA setup), `:2648` area (MFA enable)
- Test: extend or create an auth transaction test file.

**Interfaces:** Independent of other tasks. Note `POST /api/auth/login` (index.ts:971) writes a login-audit record for a **user row that already exists** (no new-row creation risk) — read the handler first (`sed -n '900,1000p' backend/src/index.ts`) to confirm whether it does any mutation (e.g. `last_login_at` update, trusted-device write) before the audit insert; if it's audit-only with no accompanying mutation, wrapping in `$transaction` is unnecessary (a lone `$executeRaw` has nothing to roll back against) — skip it and note the exclusion in the commit message.

- [ ] **Step 1: Read all 4 (or 5) handlers before editing**

Run: `sed -n '760,880p;2560,2660p' backend/src/index.ts` to see the SSO callback, logout, MFA setup, and MFA enable handlers in full, and confirm what mutation (if any) precedes each audit insert (e.g. MFA setup writes `mfa_pending_secret`; MFA enable writes `mfa_enabled = true, mfa_secret = ...`; SSO callback likely upserts the SSO user row; logout may write to a session/trusted-device table — verify each before assuming).

- [ ] **Step 2: Wrap each handler that has a real mutation preceding its audit insert**

For each of the 4 sites, apply the same transform as Task 4 Step 1: move the mutation (`$executeRaw`/`prisma.user.update`/etc.) and the audit `$executeRaw` inside `prisma.$transaction(async (tx) => {...})`, swapping `prisma.` → `tx.` for exactly those two calls. Do not move JWT signing, cookie-setting, or `res.json(...)` inside the transaction — those have no rollback semantics and must run only after the transaction commits.

- [ ] **Step 3: Run tsc and full test suite**

Run: `cd backend && npx tsc --noEmit && npx jest --runInBand`
Expected: 0 new errors, all PASS. Pay particular attention to the SSO and MFA e2e-style tests (`grep -rln "sso\|mfa" backend/src --include="*.test.ts" -i`) — these are auth-critical paths.

- [ ] **Step 4: Write one rollback test for MFA enable (highest-risk site — an unlogged MFA-secret write would be a silent auth-bypass audit gap)**

Mock `tx.$executeRaw` (mfa-enable UPDATE, then audit insert — throw on the audit call), assert the mfa_secret UPDATE did not commit.

- [ ] **Step 5: Run the new test**

Run: `cd backend && npx jest <auth-test-file> -v`
Expected: PASS.

- [ ] **Step 6: Manually verify the login → MFA-enabled-admin flow still works end-to-end**

Per CLAUDE.md's temp-admin recipe (`claude-admin@cmdb.local`), seed the TOTP admin, log in with a computed code, confirm `200` + valid token. This is a manual smoke test, not a jest test — auth-critical paths get an end-to-end check before merge, matching the CLAUDE.md `#152` guidance ("a regression locks out every MFA-enabled admin").

- [ ] **Step 7: Commit**

```bash
git add backend/src/index.ts backend/src/__tests__/
git commit -m "fix(auth): wrap SSO/logout/MFA writes in transactional audit (#172)"
```

---

### Task 6: `index.ts` — CI bulk import writes (batches, item/batch discard, reanalyze)

**Files:**
- Modify: `backend/src/index.ts:2266` (batch create), `:2336` (item discard), `:2349` (batch discard), `:2452` (item reanalyze), `:2470` (batch reanalyze)
- Test: extend the existing bulk-import test file (`grep -rln "bulk" backend/src --include="*.test.ts"`)

**Interfaces:** Independent. Note: `index.ts:3700-3852` (master-row creation inside the *processing* of a bulk batch — `Manufacturer`, `DeviceModel`, `OperatingSystem`, `BaseSoftware` creation) is **already transactional** (uses `tx.$executeRaw`, confirmed in the inventory above) — do not touch those, they're out of scope for this task.

- [ ] **Step 1: Read all 5 handlers**

Run: `sed -n '2240,2280p;2320,2360p;2440,2480p' backend/src/index.ts` to see the batch-create, item-discard, batch-discard, item-reanalyze, and batch-reanalyze handlers.

- [ ] **Step 2: Wrap each of the 5 sites**

Apply the same transform pattern as prior tasks: mutation (row insert/update/delete against `CiBulkImportBatch`/`CiBulkImportItem`) + audit insert move inside `prisma.$transaction(async (tx) => {...})`. The single-line `$executeRaw` audit calls (e.g. index.ts:2336, 2349, 2452 — `await prisma.$executeRaw\`INSERT INTO "audit_logs"...\`;`) are chained directly after their mutation on adjacent lines — confirm each mutation's variable/call immediately precedes it, then wrap both together.

- [ ] **Step 3: Run tsc and full test suite**

Run: `cd backend && npx tsc --noEmit && npx jest --runInBand`
Expected: 0 new errors, all PASS.

- [ ] **Step 4: Write one rollback test for batch discard (simplest single-mutation site)**

Mock `tx.$executeRaw`/`tx.ciBulkImportBatch.delete` (throw on the audit call), assert the batch delete did not commit.

- [ ] **Step 5: Run the new test**

Run: `cd backend && npx jest <bulk-test-file> -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/index.ts backend/src/__tests__/
git commit -m "fix(bulk-import): wrap batch/item discard and reanalyze writes in transactional audit (#172)"
```

---

### Task 7: `index.ts` — CI links (contracts/documents), certificates, vulnerabilities

**Files:**
- Modify: `backend/src/index.ts:1965` (vuln patch), `:2794` (cert upload), `:3942/3963` (contract link/unlink), `:3986/4000` (document link/unlink)
- Test: extend the relevant existing test files for these routes.

**Interfaces:** Independent.

- [ ] **Step 1: Read all 6 handlers**

Run: `sed -n '1940,1970p;2760,2800p;3920,4010p' backend/src/index.ts`.

- [ ] **Step 2: Wrap each of the 6 sites**

Apply the same transform pattern. For the link/unlink pairs (contracts, documents), note these use join-table writes (`_CIToContract`/`_CIToDocument` or similar) — confirm the exact Prisma call (`prisma.cI.update({ data: { contracts: { connect: [...] } } })` or a raw join-table `$executeRaw`) before wrapping; either way, the join-table mutation and its audit insert move inside one `prisma.$transaction`.

- [ ] **Step 3: Run tsc and full test suite**

Run: `cd backend && npx tsc --noEmit && npx jest --runInBand`
Expected: 0 new errors, all PASS.

- [ ] **Step 4: Write one rollback test for contract link (representative of the link/unlink pairs)**

Mock the join-table mutation + `tx.$executeRaw` audit (throw on audit), assert the link did not commit.

- [ ] **Step 5: Run the new test**

Run: `cd backend && npx jest <ci-links-test-file> -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/index.ts backend/src/__tests__/
git commit -m "fix(ci-links): wrap vulnerability/certificate/contract/document writes in transactional audit (#172)"
```

---

### Task 8: `dcim` module — 16 write sites

**Files:**
- Modify: `backend/src/modules/dcim/queries.ts` (widen any factory signatures, mirroring Task 1 Step 2 — inspect first), `backend/src/modules/dcim/audit.ts`, `backend/src/modules/dcim/router.ts`
- Test: `backend/src/modules/dcim/__tests__/auditTransaction.test.ts` (new)

- [ ] **Step 1: Inspect the module's client-binding pattern**

Run: `grep -n "PrismaClient\|export function\|dcimAudit(" backend/src/modules/dcim/queries.ts backend/src/modules/dcim/audit.ts backend/src/modules/dcim/router.ts | head -40`
Determine whether `dcim/router.ts` calls `prisma.*` directly (like `catalog`'s date-lifecycle inline queries) or via a bound factory (like `catalog`'s `dtQueries`). If a factory exists, widen it exactly as Task 1 Step 2.

- [ ] **Step 2: Widen `dcimAudit`'s client parameter**

In `backend/src/modules/dcim/audit.ts`, change `prisma: PrismaClient` to `db: Prisma.TransactionClient` (match the staff-schedule naming convention: `db` for the transaction-client param), update the import from `PrismaClient` to `Prisma`, and update the internal `prisma.$executeRaw` call to use the renamed parameter.

- [ ] **Step 3: Wrap all 16 call sites** — `CREATE_DCIM_BUILDING`/`UPDATE_DCIM_BUILDING`/`DELETE_DCIM_BUILDING` (router.ts:76,92,106), `CREATE_DCIM_FLOOR`/`UPDATE_DCIM_FLOOR`/`DELETE_DCIM_FLOOR` (router.ts:141,157,170), `CREATE_DCIM_ROOM`/`UPDATE_DCIM_ROOM`/`DELETE_DCIM_ROOM` (router.ts:230,246,259), `CREATE_DCIM_AISLE`/`UPDATE_DCIM_AISLE`/`DELETE_DCIM_AISLE` (router.ts:292,308,321), `CREATE_DCIM_FOOTPRINT`/`UPDATE_DCIM_FOOTPRINT`/`DELETE_DCIM_FOOTPRINT` (router.ts:355,371,407), `ASSIGN_RACK`/`UNASSIGN_RACK` (router.ts:427,445)

For each, read the handler (`sed -n '<line-20>,<line+20>p' backend/src/modules/dcim/router.ts`) and apply the Task 1/Task 2 transform: mutation + `dcimAudit(tx, ...)` inside `prisma.$transaction(async (tx) => {...})`. The `ASSIGN_RACK`/`UNASSIGN_RACK` handlers (router.ts:407-445) are the U-slot overlap-validation paths from v2.6.1 — read them carefully, since they likely perform a validation read + a footprint update; only the update (not the validation read) needs to be inside the transaction, but including the read is also safe (Prisma allows reads inside `$transaction`).

- [ ] **Step 4: Run tsc and full test suite**

Run: `cd backend && npx tsc --noEmit && npx jest --runInBand`
Expected: 0 new errors, all PASS (pay attention to `dcim` and rack-placement tests given the v2.6.0/v2.6.1 U-slot overlap logic).

- [ ] **Step 5: Write the rollback test**

Create `backend/src/modules/dcim/__tests__/auditTransaction.test.ts` for `CREATE_DCIM_BUILDING`, following the Task 1 Step 5 mock shape.

- [ ] **Step 6: Run the new test**

Run: `cd backend && npx jest src/modules/dcim/__tests__/auditTransaction.test.ts -v`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/src/modules/dcim/
git commit -m "fix(dcim): wrap building/floor/room/aisle/footprint/rack writes in transactional audit (#172)"
```

---

### Task 9: `decommission` module — 11 write sites

**Files:**
- Modify: `backend/src/modules/decommission/queries.ts` (inspect + widen if factory-bound), `backend/src/modules/decommission/audit.ts`, `backend/src/modules/decommission/router.ts`
- Test: `backend/src/modules/decommission/__tests__/auditTransaction.test.ts` (new)

- [ ] **Step 1: Inspect the module's client-binding pattern**

Run: `grep -n "PrismaClient\|export function\|decommissionAudit(" backend/src/modules/decommission/queries.ts backend/src/modules/decommission/audit.ts backend/src/modules/decommission/router.ts | head -40`

- [ ] **Step 2: Widen `decommissionAudit`'s client parameter**, mirroring Task 8 Step 2.

- [ ] **Step 3: Wrap all 11 call sites** — `CREATE`/`UPDATE`/`DELETE`/`GENERATE`/`UPDATE_CI_DATE` on `DECOMMISSION_PLAN` (router.ts:88,119,132,167,218), `ADD_DOCUMENT`/`REMOVE_DOCUMENT` (router.ts:253,266), `ADD_CONTRACT`/`REMOVE_CONTRACT` (router.ts:291,304), `ADD_LICENSE`/`REMOVE_LICENSE` (router.ts:329,342)

For each, read the handler and apply the established transform. `GENERATE` (router.ts:167) is the Gantt-plan generation endpoint from v2.8.5 — check whether it creates multiple rows (plan steps/timeline entries) before the audit insert; if so, all of them move inside the same `tx`.

- [ ] **Step 4: Run tsc and full test suite**

Run: `cd backend && npx tsc --noEmit && npx jest --runInBand`
Expected: 0 new errors, all PASS.

- [ ] **Step 5: Write the rollback test** for `CREATE` (`DECOMMISSION_PLAN`), mirroring Task 1 Step 5.

- [ ] **Step 6: Run the new test**

Run: `cd backend && npx jest src/modules/decommission/__tests__/auditTransaction.test.ts -v`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/src/modules/decommission/
git commit -m "fix(decommission): wrap plan CRUD and document/contract/license link writes in transactional audit (#172)"
```

---

### Task 10: `settings` module — 3 write sites

**Files:**
- Modify: `backend/src/modules/settings/audit.ts`, `backend/src/modules/settings/router.ts`
- Test: `backend/src/modules/settings/__tests__/auditTransaction.test.ts` (new)

- [ ] **Step 1: Inspect the module**

Run: `sed -n '1,50p;80,150p' backend/src/modules/settings/router.ts`. Confirm there's no `queries.ts` factory (per the inventory table) — `router.ts` calls `prisma` directly, so only `settingsAudit`'s signature needs widening (no query-factory widening step needed for this module).

- [ ] **Step 2: Widen `settingsAudit`'s client parameter**, mirroring Task 8 Step 2.

- [ ] **Step 3: Wrap all 3 call sites** — `UPDATE_THEME` (router.ts:92), `UPDATE_LOGO` (router.ts:133), `DELETE_LOGO` (router.ts:148)

For `UPDATE_LOGO`/`DELETE_LOGO`, check whether the handler also touches the filesystem (logo file upload/delete, per the multer + UUID-filename convention in CLAUDE.md) — filesystem operations are **not** transactional with Postgres and must stay outside `prisma.$transaction`; only the DB row write (e.g. a `settings` table update storing the logo path) + audit insert go inside the transaction. If the filesystem write happens before the DB write, keep that ordering — write the file first (non-transactional, best-effort), then transactionally record the DB row + audit; a failed DB/audit transaction after a successful file write is an orphaned file, not an orphaned audit record, and is out of scope for #172 (which is specifically about DB write ↔ audit-log atomicity).

- [ ] **Step 4: Run tsc and full test suite**

Run: `cd backend && npx tsc --noEmit && npx jest --runInBand`
Expected: 0 new errors, all PASS.

- [ ] **Step 5: Write the rollback test** for `UPDATE_THEME` (simplest, no filesystem interaction), mirroring Task 1 Step 5.

- [ ] **Step 6: Run the new test**

Run: `cd backend && npx jest src/modules/settings/__tests__/auditTransaction.test.ts -v`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/src/modules/settings/
git commit -m "fix(settings): wrap theme/logo writes in transactional audit (#172)"
```

---

### Task 11: `alerts` module — 5 write sites (4 router + 1 cron)

**Files:**
- Modify: `backend/src/modules/alerts/queries.ts` (inspect + widen if factory-bound), `backend/src/modules/alerts/audit.ts`, `backend/src/modules/alerts/router.ts`, `backend/src/modules/alerts/pipeline.ts`
- Test: `backend/src/modules/alerts/__tests__/auditTransaction.test.ts` (new)

- [ ] **Step 1: Inspect the module's client-binding pattern**

Run: `grep -n "PrismaClient\|export function\|insertAlertAudit(" backend/src/modules/alerts/queries.ts backend/src/modules/alerts/audit.ts backend/src/modules/alerts/router.ts backend/src/modules/alerts/pipeline.ts | head -40`

- [ ] **Step 2: Widen `insertAlertAudit`'s client parameter**, mirroring Task 8 Step 2.

- [ ] **Step 3: Wrap the 4 router call sites** — `UPDATE_ALERT_CONFIG` (router.ts:56), `UPDATE_ALERT_RULE` (router.ts:86), `ALERT_TEST_SEND` (router.ts:121), `ALERT_RUN_NOW` (router.ts:141)

Apply the established transform to each.

- [ ] **Step 4: Wrap the cron-triggered site — `ALERT_CRON_RUN` (pipeline.ts:99)**

Read `sed -n '60,110p' backend/src/modules/alerts/pipeline.ts`. This runs on a schedule (n8n-triggered per v3.0.0's migration of alert cron to n8n, per CLAUDE.md), not from an HTTP request — confirm what mutation (if any) precedes the audit insert (e.g. an `alert_rules` last-run-timestamp update, or an `AlertRun`/history row). If there's a real mutation, wrap it in `prisma.$transaction` exactly like the router sites, using the module's own `prisma` client reference already in scope in `pipeline.ts`. If this site is audit-only (records that a cron run happened, with no other row write), leave it as a plain `$executeRaw` and note the exclusion in the commit message — a lone insert has nothing to roll back against.

- [ ] **Step 5: Run tsc and full test suite**

Run: `cd backend && npx tsc --noEmit && npx jest --runInBand`
Expected: 0 new errors, all PASS. Pay attention to the alerts pipeline/cron tests given the email-sending side effects (`smtp-transport.ts`) — confirm SMTP sends stay outside the transaction (they're not DB writes and must not block/rollback on DB issues).

- [ ] **Step 6: Write the rollback test** for `UPDATE_ALERT_CONFIG` (router.ts:56), mirroring Task 1 Step 5.

- [ ] **Step 7: Run the new test**

Run: `cd backend && npx jest src/modules/alerts/__tests__/auditTransaction.test.ts -v`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add backend/src/modules/alerts/
git commit -m "fix(alerts): wrap config/rule/test-send/run-now writes in transactional audit (#172)"
```

---

### Task 12: `plugins` module — 17 write sites (largest, needs case-by-case judgment)

**Files:**
- Modify: `backend/src/modules/plugins/queries.ts` (inspect + widen if factory-bound), `backend/src/modules/plugins/audit.ts`, `backend/src/modules/plugins/router.ts`, `backend/src/modules/plugins/index.ts`
- Test: `backend/src/modules/plugins/__tests__/auditTransaction.test.ts` (new)

- [ ] **Step 1: Inspect the module's client-binding pattern**

Run: `grep -n "PrismaClient\|export function\|pluginAudit(" backend/src/modules/plugins/queries.ts backend/src/modules/plugins/audit.ts backend/src/modules/plugins/router.ts backend/src/modules/plugins/index.ts | head -50`

- [ ] **Step 2: Widen `pluginAudit`'s client parameter**, mirroring Task 8 Step 2.

- [ ] **Step 3: Triage the 17 call sites into "paired with a DB mutation" vs "audit-only"**

Read each site in context (`sed -n '520,580p;655,780p;825,1130p' backend/src/modules/plugins/router.ts` and `sed -n '40,60p' backend/src/modules/plugins/index.ts`). The 5 `PLUGIN_VALIDATION_FAILED` sites (router.ts:710,722,742,756,770) are inside upload/validation branches — check whether each one follows a DB write (e.g. a `plugin` row already inserted in `PENDING`/`UPLOADED` status that then needs a status flip to `FAILED`) or whether it's purely informational (no row exists yet to roll back). Build a short table of the 17 sites: `{line, action, has-preceding-mutation: yes/no}`.

- [ ] **Step 4: Wrap every site where `has-preceding-mutation: yes`**

Apply the established transform: `PLUGIN_MARKETPLACE_INSTALL_STARTED` (router.ts:539), `PLUGIN_VALIDATED` (router.ts:547,764), `PLUGIN_INSTALLED` (router.ts:567,833), `PLUGIN_UPLOADED` (router.ts:665), `PLUGIN_APPROVAL_ISSUED` (router.ts:877), `PLUGIN_ACTIVATED` (router.ts:964), `PLUGIN_DEACTIVATED` (router.ts:994), `PLUGIN_UNINSTALLED` (router.ts:1072), `PLUGIN_CONFIG_UPDATED` (router.ts:1127), `PLUGIN_ERROR` (index.ts:52), plus whichever `PLUGIN_VALIDATION_FAILED` sites from Step 3 turned out to have a preceding mutation (e.g. a status-column update on the plugin row).

For any `PLUGIN_VALIDATION_FAILED` site that is genuinely audit-only (no DB mutation to protect — just recording that validation was rejected before any row existed), leave it as a plain audit call and list it explicitly in the commit message as an intentional exclusion with the reasoning ("no preceding mutation — nothing to roll back").

- [ ] **Step 5: Run tsc and full test suite**

Run: `cd backend && npx tsc --noEmit && npx jest --runInBand`
Expected: 0 new errors, all PASS. This module has the plugin-engine sandbox tests (`vibesec`-relevant, per CLAUDE.md's marketplace SSRF-hardening history from v2.8.5) — check those specifically: `npx jest src/modules/plugins --runInBand`.

- [ ] **Step 6: Write the rollback test** for `PLUGIN_INSTALLED` (router.ts:567 — the one-click marketplace install path from v2.8.5, arguably the highest-risk plugin write), mirroring Task 1 Step 5.

- [ ] **Step 7: Run the new test**

Run: `cd backend && npx jest src/modules/plugins/__tests__/auditTransaction.test.ts -v`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add backend/src/modules/plugins/
git commit -m "fix(plugins): wrap install/activate/uninstall/config writes in transactional audit (#172)"
```

---

## Final Verification (after all 12 tasks)

- [ ] **Step 1: Full regression pass**

Run: `cd backend && npx tsc --noEmit && npx jest --runInBand`
Expected: 0 new tsc errors beyond the 2 known pre-existing ones; all test suites PASS (staff-schedule's existing 14/14 `auditTransaction.test.ts` plus the 8 new per-domain rollback-test files from Tasks 1–12, each with 2 tests = 16 new tests minimum).

- [ ] **Step 2: Grep sweep to confirm no orphaned two-step sites remain**

Run: `grep -n 'await prisma\.\$executeRaw`\?[^`]*INSERT INTO "audit_logs"' backend/src/index.ts | wc -l`
Expected: `0` (every remaining `INSERT INTO audit_logs` in `index.ts` should now be reached via `tx.$executeRaw` inside a `$transaction`, or be one of the explicitly-documented exclusions from Task 5/Task 11/Task 12).

Run: `grep -rn 'prisma\.\$executeRaw`\?[^`]*INSERT INTO "audit_logs"' backend/src/modules/{catalog,dcim,decommission,settings,alerts,plugins}/*.ts | wc -l`
Expected: `0` for the same reason.

- [ ] **Step 3: Rebuild and smoke-test in dev compose**

Per CLAUDE.md's Definition of Done:
```bash
sg docker -c "docker compose down && docker compose up -d --build"
curl -sk https://localhost/api/health
```
Expected: containers start cleanly, health check returns `200`.

- [ ] **Step 4: Manual smoke test — GDPR erasure end-to-end (highest-risk change in this plan)**

Using the AUDITOR test account for read verification and a scratch ADMIN action (per CLAUDE.md's temp-admin recipe if erasure itself requires ADMIN), create a throwaway test user, erase it via `DELETE /api/users/:id/erase` (or the equivalent admin endpoint touched in Task 4), and confirm via `GET /api/audit` (as `claude@cmdb.local`) that exactly one `GDPR_ERASURE` record exists and the user row is gone. This confirms the Task 4 fix works against the real database, not just the mocked transaction test.

- [ ] **Step 5: Update `docs/superpowers/plans/2026-07-16-open-issues-remediation-roadmap.md`**

Mark issue #172 as resolved (remaining scope) with a note pointing at this plan and the final commit range, matching the style of the #181/#179 entries already in that file.

- [ ] **Step 6: Update memory / Plan Activo in CLAUDE.md** (if the user asks for it in a follow-up — not a code step, flag as a suggestion, don't do unprompted per CLAUDE.md's edit conventions for that section).

---

## Self-Review Notes

- **Spec coverage:** every non-transactional site identified in the roadmap doc's #172 section (`index.ts:3070`, `:3146` explicitly named there) is covered by Task 3; the full 29-site `index.ts` inventory and 66-site module inventory (verified live via grep, not assumed) are each covered by exactly one task; `reports/audit.ts` is explicitly excluded per the roadmap's own reasoning.
- **Placeholder scan:** every task step either shows the exact before/after code (Tasks 1–7, fully traced) or gives an exact `grep`/`sed` command plus the precise list of line numbers and action names to apply the established, fully-worked pattern to (Tasks 8–12, where per-module internals weren't pre-traced to keep this plan's authoring cost proportionate to a 95-site mechanical refactor — the pattern itself has zero ambiguity, demonstrated 3 different ways in Tasks 1–4: ORM `.create`, raw `INSERT...SELECT`, raw `UPDATE`).
- **Type consistency:** `Prisma.TransactionClient` is used consistently as the widened parameter type across all task's audit-helper edits; the `tx` variable name and the `prisma.$transaction(async (tx) => {...})` wrapper shape is identical in every task, matching the shipped `staff-schedule` precedent exactly.

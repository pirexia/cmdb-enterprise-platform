# vCenter HOSTS Relation — DRS Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a VM is live-migrated by VMware DRS to a different ESXi host between syncs, the vCenter sync must remove the now-stale `HOSTS` relation to the old host, so a VM is never shown as hosted by two ESXi hosts at once.

**Architecture:** The per-VM HOSTS enrichment block in `runVCenterSync()` (`vcenterService.ts`) already upserts a `HOSTS` relation from the VM's *current* ESXi `PHYSICAL_SERVER` CI. This plan adds, immediately after that upsert (and only when the current host was unambiguously resolved), a reconciliation step that deletes any other `HOSTS` relation targeting the same VM whose source is a *different* `PHYSICAL_SERVER` CI — writing a `DELETE_RELATION` audit row per deletion and re-indexing the affected old host. It is deliberately skipped when the host is unresolved (`esxiHost` null) or ambiguous (`hostCi.length !== 1`), so a bad/empty resolution never wipes a good relation.

**Tech Stack:** TypeScript 5, Express 5, Prisma 6 (`cIRelation.findMany` / `.delete`, `$executeRaw` tagged templates), Jest + ts-jest (unit tests with a hand-rolled fake Prisma).

## Global Constraints

- **A.8.15 (ISO 27001) — every write logged:** each relation deletion MUST insert an `audit_logs` row with `action='DELETE_RELATION'`, `entity='CI_RELATION'`, `entity_id=<relation id>`, `user_email=<sync user>`. Mirror the shape used by `DELETE /api/relations/:id` in `backend/src/index.ts:3183-3186`.
- **Best-effort, never fail the VM sync:** the reconciliation runs inside the existing `try { … } catch (relErr) { console.warn(…) }` best-effort block around the HOSTS step (`vcenterService.ts:222-259`). A failure here must never increment `errors` or abort the VM's own CI sync.
- **Safety fence (D5 / open-risk #3 spirit):** only delete relations whose `relationType='HOSTS'`, `targetCiId=<this VM>`, `sourceCiId != <current host CI id>`, AND whose source CI is a `PHYSICAL_SERVER`. Never touch relations of any other type, direction, or source CI type.
- **Raw SQL:** `$executeRaw` tagged template literals only — never string concatenation, never `$queryRawUnsafe`.
- **TypeScript gate:** `cd backend && npx tsc --noEmit` must pass with no new errors (the two known pre-existing `license`/`licenseUser` errors are expected and ignored).
- **Prisma model casing:** the Prisma client exposes the relation model as `prisma.cIRelation` and the CI model as `prisma.cI` (capital-I casing used throughout `vcenterService.ts`).

---

### Task 1: Reconcile stale HOSTS relations on DRS host change

**Files:**
- Modify: `backend/src/modules/integrations/vcenterService.ts:234-256` (add reconciliation after the existing HOSTS upsert; update the stale comment at lines 216-220)
- Modify (tests): `backend/src/modules/integrations/__tests__/vcenter.test.ts` (extend `makeFakePrisma` `cIRelation` mock at lines 176-178; add tests in the "HOSTS relation (Task H2)" describe block near line 743)
- Docs: `docs/INTEGRATIONS.md:130` and `docs/INTEGRATIONS.md:154` (document the DRS reconciliation behavior)

**Interfaces:**
- Consumes (unchanged, already in scope inside the block):
  - `ciId: string` — the VM's CI id (set on both the create and update branches above).
  - `hostCi: { id: string }[]` — result of the current-host lookup; reconciliation runs only when `hostCi.length === 1`.
  - `deps.prisma`, `deps.userEmail`, `deps.queueForIndexing`.
- Produces: no new exported symbols. New Prisma call sites used by the tests:
  - `prisma.cIRelation.findMany({ where: { targetCiId, relationType: 'HOSTS', sourceCiId: { not }, sourceCI: { ciTypeDef: { code: 'PHYSICAL_SERVER' } } }, select: { id: true, sourceCiId: true } })`
  - `prisma.cIRelation.delete({ where: { id } })`

- [ ] **Step 1: Extend the fake Prisma `cIRelation` mock with `findMany` + `delete` defaults**

In `backend/src/modules/integrations/__tests__/vcenter.test.ts`, change the `cIRelation` block inside `makeFakePrisma` (currently lines 176-178):

```typescript
    cIRelation: {
      upsert: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]), // default: no stale HOSTS relations
      delete: jest.fn().mockResolvedValue({}),
    },
```

Rationale: default `findMany → []` means every pre-existing test (which sets no stale relations) sees zero deletions and stays green. The reconciliation query is on `cIRelation.findMany`, a *different* mock from `cI.findMany`, so the existing `cI.findMany` call-order sequencing (`toHaveBeenCalledTimes(3)`) is unaffected.

- [ ] **Step 2: Write the failing DRS-move test**

Add this test inside the `describe('runVCenterSync — HOSTS relation (Task H2)', …)` block (after the existing test that ends near line 797) in `backend/src/modules/integrations/__tests__/vcenter.test.ts`:

```typescript
  it('DRS move — a stale HOSTS relation to a DIFFERENT physical host is deleted + audited, new one upserted', async () => {
    const fakePrisma = makeFakePrisma({
      cI: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'ci-vm-1' }),
        update: jest.fn(),
        findMany: jest
          .fn()
          .mockResolvedValueOnce([])                        // H1 adoption-candidates (none)
          .mockResolvedValueOnce([{ id: 'ci-new-host' }])   // H2 current-host lookup (new ESXi)
          .mockResolvedValueOnce([]),                       // G4 retire query
      },
      cIRelation: {
        upsert: jest.fn().mockResolvedValue({}),
        // one stale HOSTS relation pointing at the OLD host
        findMany: jest.fn().mockResolvedValue([{ id: 'rel-stale-1', sourceCiId: 'ci-old-host' }]),
        delete: jest.fn().mockResolvedValue({}),
      },
    });

    const queue = jest.fn();
    const result = await runVCenterSync({
      prisma: fakePrisma,
      connector: makeFakeConnector([vm({ esxiHost: 'esxi-new.local' })]),
      defaults: DEFAULTS,
      queueForIndexing: queue,
      userEmail: 'admin@test.local',
    });

    expect(result.errors).toBe(0);

    // current-host relation upserted (unchanged behavior)
    expect(fakePrisma.cIRelation.upsert).toHaveBeenCalledTimes(1);

    // stale-relation lookup is correctly fenced
    const staleArgs = fakePrisma.cIRelation.findMany.mock.calls[0][0];
    expect(staleArgs).toMatchObject({
      where: {
        targetCiId: 'ci-vm-1',
        relationType: 'HOSTS',
        sourceCiId: { not: 'ci-new-host' },
        sourceCI: { ciTypeDef: { code: 'PHYSICAL_SERVER' } },
      },
    });

    // stale relation deleted
    expect(fakePrisma.cIRelation.delete).toHaveBeenCalledWith({ where: { id: 'rel-stale-1' } });

    // A.8.15 — a DELETE_RELATION audit row was written (the action is a LITERAL only in the
    // reconciliation raw; insertAuditRow passes action as a bound param, so this uniquely matches)
    const rawSql = fakePrisma.$executeRaw.mock.calls.map((c: any) => c[0].join(''));
    expect(rawSql.some((sql: string) => sql.includes('DELETE_RELATION'))).toBe(true);

    // old host's relation list changed → re-indexed
    expect(queue).toHaveBeenCalledWith('ci', 'ci-old-host');
  });
```

- [ ] **Step 3: Run the new test to verify it fails**

Run: `cd backend && npx jest src/modules/integrations/__tests__/vcenter.test.ts -t "DRS move" -v`
Expected: FAIL — `cIRelation.delete` not called / no `DELETE_RELATION` raw / `queue` not called with `('ci', 'ci-old-host')` (reconciliation code does not exist yet).

- [ ] **Step 4: Implement the reconciliation in `vcenterService.ts`**

In `backend/src/modules/integrations/vcenterService.ts`, locate the `if (hostCi.length === 1) { … }` block (lines 234-254). Insert the reconciliation **after** the existing `await deps.prisma.cIRelation.upsert({ … });` call and **before** the block's closing `}`:

```typescript
            // DRS reconciliation: DRS can live-migrate a VM to a different ESXi host between
            // syncs. The current host now holds the (upserted) HOSTS relation above; remove any
            // STALE HOSTS relation still pointing at this VM from a DIFFERENT physical-server host
            // so the VM is never shown as hosted by two ESXi hosts at once. Fenced to
            // PHYSICAL_SERVER sources (exactly what a previous sync's H2 step created) and to
            // sourceCiId != current host (never deletes the relation just upserted). This only
            // runs inside `hostCi.length === 1`, so an unresolved (esxiHost null) or ambiguous
            // (0 / 2+ host matches) resolution never deletes anything.
            const staleHostRelations = await deps.prisma.cIRelation.findMany({
              where: {
                targetCiId: ciId,
                relationType: 'HOSTS',
                sourceCiId: { not: hostCi[0].id },
                sourceCI: { ciTypeDef: { code: 'PHYSICAL_SERVER' } },
              },
              select: { id: true, sourceCiId: true },
            });
            for (const stale of staleHostRelations) {
              await deps.prisma.cIRelation.delete({ where: { id: stale.id } });
              // A.8.15: every write logged. Mirror the DELETE_RELATION audit shape used by the
              // public DELETE /api/relations/:id route (index.ts).
              await deps.prisma.$executeRaw`
                INSERT INTO "audit_logs"(id, action, entity, entity_id, user_email, details, created_at)
                VALUES(gen_random_uuid(), 'DELETE_RELATION', 'CI_RELATION', ${stale.id}::uuid, ${deps.userEmail},
                       ${JSON.stringify({ source: 'vcenter', reason: 'stale HOSTS relation removed (VM migrated ESXi host)', targetCiId: ciId })}::jsonb, now())`;
              // The old host's relation list changed — re-index it. (The VM itself is already
              // queued by the create/update branch above.)
              void deps.queueForIndexing('ci', stale.sourceCiId);
            }
```

Then update the now-inaccurate limitation comment at lines 216-220. Replace:

```typescript
        // Best-effort HOSTS relation to the ESXi host's physical-server CI, if one exists in
        // the inventory and vCenter reported a resolvable host name for this VM. Never fails
        // the VM's own CI sync — this is enrichment, not a required step. Known limitation:
        // if a VM moves to a different ESXi host between syncs, the old HOSTS relation is not
        // removed — not handled in this pass.
```

with:

```typescript
        // Best-effort HOSTS relation to the ESXi host's physical-server CI, if one exists in
        // the inventory and vCenter reported a resolvable host name for this VM. Never fails
        // the VM's own CI sync — this is enrichment, not a required step. DRS host changes are
        // reconciled below: when the current host is unambiguously resolved, any stale HOSTS
        // relation to a previous ESXi host is removed (see the reconciliation block).
```

- [ ] **Step 5: Run the new test to verify it passes**

Run: `cd backend && npx jest src/modules/integrations/__tests__/vcenter.test.ts -t "DRS move" -v`
Expected: PASS.

- [ ] **Step 6: Add the "no stale relations" guard test**

Add this test right after the DRS-move test in the same describe block:

```typescript
  it('esxiHost resolved but no stale relations exist — reconciliation deletes nothing', async () => {
    const fakePrisma = makeFakePrisma({
      cI: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'ci-vm-1' }),
        update: jest.fn(),
        findMany: jest
          .fn()
          .mockResolvedValueOnce([])                      // adoption
          .mockResolvedValueOnce([{ id: 'ci-host-1' }])   // current-host lookup
          .mockResolvedValueOnce([]),                     // retire
      },
      // cIRelation.findMany uses the factory default → [] (no stale relations)
    });

    const result = await runVCenterSync({
      prisma: fakePrisma,
      connector: makeFakeConnector([vm({ esxiHost: 'esxi01.local' })]),
      defaults: DEFAULTS,
      queueForIndexing: jest.fn(),
      userEmail: 'admin@test.local',
    });

    expect(result.errors).toBe(0);
    expect(fakePrisma.cIRelation.upsert).toHaveBeenCalledTimes(1);
    expect(fakePrisma.cIRelation.delete).not.toHaveBeenCalled();
  });
```

- [ ] **Step 7: Add the "unresolved host — no reconciliation" guard test**

Add this test after Step 6's test:

```typescript
  it('esxiHost === null — reconciliation is not reached (no stale-relation lookup, no delete)', async () => {
    const fakePrisma = makeFakePrisma({
      cI: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'ci-vm-1' }),
        update: jest.fn(),
        findMany: jest
          .fn()
          .mockResolvedValueOnce([])  // adoption
          .mockResolvedValueOnce([]), // retire (host lookup is skipped when esxiHost null)
      },
    });

    const result = await runVCenterSync({
      prisma: fakePrisma,
      connector: makeFakeConnector([vm({ esxiHost: null })]),
      defaults: DEFAULTS,
      queueForIndexing: jest.fn(),
      userEmail: 'admin@test.local',
    });

    expect(result.errors).toBe(0);
    expect(fakePrisma.cIRelation.findMany).not.toHaveBeenCalled();
    expect(fakePrisma.cIRelation.delete).not.toHaveBeenCalled();
  });
```

Note: the 0-match and 2+-match (ambiguous) host cases need no new test — reconciliation is nested inside the existing `if (hostCi.length === 1)` guard, and the pre-existing tests at lines 799 and 826 already assert `cIRelation.upsert` is not called for those; deletion lives in the same guarded branch.

- [ ] **Step 8: Run the full vcenter test file to confirm no regressions**

Run: `cd backend && npx jest src/modules/integrations/__tests__/vcenter.test.ts -v`
Expected: PASS — all pre-existing tests plus the 3 new ones green.

- [ ] **Step 9: TypeScript gate**

Run: `cd backend && npx tsc --noEmit`
Expected: no new errors (only the two known pre-existing `Property 'license'/'licenseUser' does not exist on type 'PrismaClient'` errors may appear).

- [ ] **Step 10: Update the integration docs**

In `docs/INTEGRATIONS.md`, append to the end of the `esxiHost` paragraph (line 130, after the sentence that ends "…y fue sustituido por el mapeo inverso.)"):

```markdown
 Si DRS migra una VM a otro host ESXi entre sincronizaciones, la relación `HOSTS` obsoleta al host anterior se **elimina** en la siguiente sincro (reconciliación en `vcenterService.ts`): sólo se ejecuta cuando el host actual se resuelve sin ambigüedad (exactamente un `PHYSICAL_SERVER`), nunca borra sobre una resolución nula/ambigua, y cada borrado deja un registro de auditoría `DELETE_RELATION`.
```

And in the `POST /api/integrations/vcenter/sync` table row (line 154), append after "…es una operación de enriquecimiento aislada por VM.":

```markdown
 Además, si la VM cambió de host ESXi (DRS), la relación `HOSTS` anterior se elimina en la misma pasada (reconciliación, auditada como `DELETE_RELATION`).
```

- [ ] **Step 11: Commit**

```bash
git add backend/src/modules/integrations/vcenterService.ts \
        backend/src/modules/integrations/__tests__/vcenter.test.ts \
        docs/INTEGRATIONS.md
git commit -m "fix(integrations): reconciliar relación HOSTS obsoleta al migrar VM de ESXi (DRS)"
```

---

## Self-Review

- **Spec coverage:** The single requirement (gap #1 — stale HOSTS relation after DRS move) is implemented in Step 4, tested in Steps 2/6/7, audited per the global constraint, documented in Step 10.
- **Placeholder scan:** No TBD / "handle edge cases" / vague steps — all code shown in full.
- **Type consistency:** `prisma.cIRelation` / `prisma.cI` casing matches `vcenterService.ts`; the stale-lookup `where` shape in the test (Step 2) exactly matches the implementation (Step 4); `select: { id, sourceCiId }` fields match the loop's `stale.id` / `stale.sourceCiId` usage.
- **Safety:** deletion is triple-fenced (relationType HOSTS + targetCiId this VM + source is a different PHYSICAL_SERVER) and only runs under `hostCi.length === 1`; the whole step stays inside the existing best-effort try/catch so it can never fail the VM sync.

## Open decision (surface to the user before/at execution)

The fence restricts deletion to `HOSTS` relations whose source is a `PHYSICAL_SERVER`. This intentionally would also remove a *manually created* `HOSTS` relation from a different physical server to this VM (there is no per-relation "sync-owned" marker — `createdBy` is unreliable because manual syncs use the admin's email and scheduled syncs use the M2M identity). For a `VIRTUAL_SERVER` this is the correct semantic (a VM has exactly one hypervisor host), so this is judged acceptable. Confirm this is the desired behavior, or we add a stricter marker.

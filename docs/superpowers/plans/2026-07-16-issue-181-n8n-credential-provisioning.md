# Issue #181 — Fix n8n Credential Provisioning (500/400) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the n8n auto-provisioner successfully create all its credentials and the vCenter workflow, so every backend boot reports `errors: []` instead of the current 4 failures.

**Architecture:** Two independent code fixes plus one prod-backfill runbook. (1) The n8n bootstrap script creates the service-identity user by direct SQL, which skips the hook that gives a user its **personal `Project`** — n8n 1.123.x requires a personal project to create credentials, so the two `500`s. Fix: the bootstrap also creates the project + relation, idempotently. (2) `buildLdapCredential` sends fields the n8n public API `ldap` credential schema rejects (`baseDn` is not allowed; `port` must be a string), causing the LDAP `400`. Fix: align the payload to the schema. (3) The vCenter workflow `400` is a **cascade** — its node references the `CMDB Service Token` credential (`httpHeaderAuth`); that credential fails to create, so `injectCredentialIds` leaves an empty id and n8n rejects the workflow. It resolves once (1) lands; no code change, just verification.

**Tech Stack:** bash + PostgreSQL (`scripts/lib/n8n-bootstrap.sh`), TypeScript/Jest (`backend/src/modules/n8n-provisioning/`), n8n public REST API 1.123.27, Podman.

## Global Constraints

- **A02 / A.8.12:** never print credential values or the n8n API key into logs or the transcript. When probing the live API, pass secrets via env (`podman exec -e KEY=…`), never string-interpolated, and never `echo` them.
- **A09:** no response bodies/secrets in logs; the provisioner already logs only `name:action` and error strings — keep it that way.
- **ISO 22301 / no new SPOF:** the fix must not tie automated provisioning to the human owner account (`andres.matias@dachser.com`, `global:owner`) — that account's deletion would `ON DELETE CASCADE` its projects and break provisioning. The service identity `cmdb-provisioner@cmdb.local` must own its own project. (This is why Option A, not Option B from the roadmap.)
- **Idempotency:** the bootstrap runs on every install/update and on manual re-runs — the project-creation SQL must be safe to run repeatedly (guard-then-insert, no duplicate rows).
- **DoD:** `cd backend && npx tsc --noEmit` clean (only the two known `license`/`licenseUser` pre-existing errors); `cd backend && npx jest src/modules/n8n-provisioning` green; `bash -n scripts/lib/n8n-bootstrap.sh` valid.
- **Deploy caveat (memory `ops_podman_compose_build_cache_bug`):** `.env`/image changes reach prod reliably only via a full `down`/`up`; the prod backfill (Task 4) is a live DB write and needs the user's OK.
- **Do not touch #172/#152/#153** — this plan is #181 only.

## Verified root-cause evidence (already gathered live, 2026-07-16)

- Owner `andres.matias@dachser.com` (`global:owner`) has a personal project (`Andres Matías <…>`, type `personal`) + `project_relation` role `project:personalOwner`. Service identity `cmdb-provisioner@cmdb.local` (`global:admin`) has **neither** → `POST /api/v1/credentials` returns `500 Could not find any entity of type "Project" … role project:personalOwner`.
- `GET /api/v1/credentials/schema/ldap` (n8n 1.123.27) → `additionalProperties:false`, properties `{hostname, port:string, bindDN, bindPassword, connectionSecurity(enum), allowUnauthorizedCerts:boolean, caCertificate, timeout}`, `required:["hostname"]`. `buildLdapCredential` currently sends `baseDn` (rejected) and `port` as a **number** (schema wants string) → `400 … additional property "baseDn" … is not of a type(s) string`.
- vCenter template node uses `genericAuthType: httpHeaderAuth` (the `CMDB Service Token` credential). `provisioner.ts` builds credentials first (populating `credIdMap`) then workflows; a failed credential ⇒ no `credIdMap` entry ⇒ `injectCredentialIds` leaves the node's credential id empty ⇒ `POST /api/v1/workflows` `400`.

## File Structure

- `scripts/lib/n8n-bootstrap.sh` — **modify.** In `n8n_ensure_owner_and_key` Case B, after the user upsert, add an idempotent personal-project + relation upsert for the service identity.
- `backend/src/modules/n8n-provisioning/credentials.ts` — **modify.** `buildLdapCredential`: drop `baseDn`, send `port` as a string. Adjust the `LdapCredential` type if it declares those.
- `backend/src/modules/n8n-provisioning/__tests__/credentials.test.ts` — **modify.** The two LDAP tests currently assert the buggy shape (`port` numeric, `baseDn` present) — update them to the schema-correct shape.
- Prod backfill — **runbook, operator-run (Task 4).** One-time SQL against the existing prod provisioner (the bootstrap fix only helps future runs), then verify via resync.

---

### Task 1: Bootstrap creates the service identity's personal project (fixes both 500s)

**Files:**
- Modify: `scripts/lib/n8n-bootstrap.sh` — inside `n8n_ensure_owner_and_key`, Case B (after the `INSERT INTO n8n_data."user" … ON CONFLICT …` at ~lines 108-112, before `_n8n_mint_key login …`).

**Interfaces:**
- Consumes: `$ctr_exec`, `$pg`, `$du`, `$dn`, `$pe` (provisioner email) already in scope in Case B.
- Produces: after this function runs, `cmdb-provisioner@cmdb.local` has exactly one `n8n_data.project` (type `personal`) + one `n8n_data.project_relation` (role `project:personalOwner`). Idempotent across re-runs.

- [ ] **Step 1: Add the idempotent project-creation SQL**

In `scripts/lib/n8n-bootstrap.sh`, immediately after the user-upsert `psql` command in Case B (the block that ends `|| { n8n_bootstrap_log "ERROR: upsert de la identidad de servicio falló"; return 1; }`), insert:

```bash
    # #181 — n8n 1.123.x exige que el usuario tenga un "personal project" para crear
    # credenciales vía API. El INSERT directo del usuario (arriba) se salta el hook que
    # normalmente lo crea, así que lo creamos a mano. Idempotente (guard-then-insert).
    local _proj_id; _proj_id="$(openssl rand -hex 8)"   # 16 chars, válido para project.id (varchar 36)
    $ctr_exec "$pg" psql -U "$du" -d "$dn" -v ON_ERROR_STOP=1 \
      -v pemail="$pe" -v pid="$_proj_id" -c "
      WITH u AS (SELECT id FROM n8n_data.\"user\" WHERE email = :'pemail'),
           existing AS (
             SELECT pr.\"projectId\" FROM n8n_data.project_relation pr
             JOIN u ON u.id = pr.\"userId\"
             WHERE pr.role = 'project:personalOwner'
           ),
           new_proj AS (
             INSERT INTO n8n_data.project (id, name, type, \"createdAt\", \"updatedAt\")
             SELECT :'pid', 'CMDB Provisioner <' || :'pemail' || '>', 'personal', now(), now()
             WHERE NOT EXISTS (SELECT 1 FROM existing)
             RETURNING id
           )
      INSERT INTO n8n_data.project_relation (\"projectId\", \"userId\", role, \"createdAt\", \"updatedAt\")
      SELECT np.id, u.id, 'project:personalOwner', now(), now()
      FROM new_proj np, u
      WHERE NOT EXISTS (SELECT 1 FROM existing);
      " >/dev/null 2>&1 \
      || { n8n_bootstrap_log "ERROR: no se pudo crear el personal project del provisioner (#181)"; return 1; }
    n8n_bootstrap_log "Personal project del provisioner garantizado (#181)"
```

- [ ] **Step 2: Syntax-check**

Run: `bash -n scripts/lib/n8n-bootstrap.sh`
Expected: exit 0 (no output).

- [ ] **Step 3: Verify the SQL logic against the live dev n8n (or a scratch DB) — idempotency + correctness**

This is infra bash with no jest harness; verify by DB state. If a dev n8n stack is up, source the lib and run just the new SQL twice against the dev provisioner (or a throwaway test email), asserting:
- after first run: exactly 1 `project` (type `personal`) + 1 `project_relation` (`project:personalOwner`) for that user;
- after second run: still exactly 1 of each (no duplicate).

```bash
# example assertion query (adjust container/email for dev):
podman exec cmdb-postgres psql -U admin -d cmdb_db -tAc "
SELECT count(*) FROM n8n_data.project_relation pr
JOIN n8n_data.\"user\" u ON u.id = pr.\"userId\"
WHERE u.email='<test-email>' AND pr.role='project:personalOwner';"
# expected: 1 after first run, still 1 after a second run
```

If no dev n8n is running, note this as deferred-to-Task-4 (the prod backfill exercises the same SQL under supervision). Do **not** spin up extra containers solely for this.

- [ ] **Step 4: Commit**

```bash
git add scripts/lib/n8n-bootstrap.sh
git commit -m "fix(n8n): bootstrap creates service-identity personal project (#181)"
```

---

### Task 2: Fix `buildLdapCredential` payload to match n8n's ldap schema (fixes the 400)

**Files:**
- Modify: `backend/src/modules/n8n-provisioning/credentials.ts` — `buildLdapCredential` (and the `LdapCredential` type if it declares `baseDn` / `port: number`).
- Test: `backend/src/modules/n8n-provisioning/__tests__/credentials.test.ts` — the two `buildLdapCredential` cases (lines ~57-78) assert the buggy shape and must change.

**Interfaces:**
- Consumes: nothing new.
- Produces: `buildLdapCredential(...).data` = `{ hostname: string, port: string, bindDN: string, bindPassword: string, connectionSecurity: 'none'|'tls'|'startTls', allowUnauthorizedCerts: boolean }` — **no `baseDn`**, `port` is a **string**. Matches `GET /api/v1/credentials/schema/ldap` (`additionalProperties:false`).

- [ ] **Step 1: Update the failing tests first (TDD — red)**

Replace the two LDAP test cases in `credentials.test.ts` (lines ~57-78) with:

```ts
  it('ldap:// → connectionSecurity none, port "389" (string), sin baseDn', () => {
    const c = buildLdapCredential(cfg({ ldap: {
      useLdap: true, url: 'ldap://dc.example.com:389', baseDN: 'DC=example,DC=com',
      bindDN: 'CN=svc,DC=example,DC=com', bindPassword: 'secret',
    } }))!;
    expect(c.name).toBe(CRED_NAMES.ldap);
    expect(c.type).toBe('ldap');
    expect(c.data.hostname).toBe('dc.example.com');
    expect(c.data.port).toBe('389');                 // n8n ldap schema: port is a string
    expect(c.data.connectionSecurity).toBe('none');
    expect(c.data).not.toHaveProperty('baseDn');     // schema: additionalProperties:false
    expect(c.data.bindDN).toBe('CN=svc,DC=example,DC=com');
    expect(c.data.bindPassword).toBe('secret');
  });

  it('ldaps:// → connectionSecurity tls, port "636" (string)', () => {
    const c = buildLdapCredential(cfg({ ldap: {
      useLdap: true, url: 'ldaps://dc.example.com:636', baseDN: 'DC=example,DC=com',
    } }))!;
    expect(c.data.connectionSecurity).toBe('tls');
    expect(c.data.port).toBe('636');
  });
```

- [ ] **Step 2: Run tests — verify red**

Run: `cd backend && npx jest src/modules/n8n-provisioning/__tests__/credentials.test.ts`
Expected: FAIL — current code returns `port: 389` (number) and includes `baseDn`.

- [ ] **Step 3: Fix `buildLdapCredential`**

In `credentials.ts`, change the returned `data` object: remove the `baseDn` line and make `port` a string:

```ts
    data: {
      hostname,
      port: String(port),
      bindDN: bindDN ?? '',
      bindPassword: bindPassword ?? '',
      connectionSecurity,
      // Never skip cert verification — allowUnauthorizedCerts: true disables TLS validation (MITM risk).
      // For self-signed certs in dev, set LDAP_ALLOW_UNAUTHORIZED_CERTS=true explicitly.
      allowUnauthorizedCerts: process.env.LDAP_ALLOW_UNAUTHORIZED_CERTS === 'true',
    },
```

If the `LdapCredential` type (in `credentials.ts`) declares `baseDn` or `port: number`, update it: remove `baseDn`, set `port: string`. Also remove now-unused `baseDN` destructuring only if it becomes unused (it is — drop `baseDN` from the `const { … } = cfg.ldap` line).

> **Note (document in the commit body):** the n8n LDAP *credential* has no base-DN field — the search base is a parameter on the LDAP node, not the credential. The `ldap-ad-sync` workflow already provides it at the node level (that workflow provisions successfully today), so dropping `baseDn` here loses nothing.

- [ ] **Step 4: Run tests — verify green + tsc**

Run: `cd backend && npx jest src/modules/n8n-provisioning/__tests__/credentials.test.ts`
Expected: PASS.
Run: `cd backend && npx tsc --noEmit`
Expected: 0 new errors.

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/n8n-provisioning/credentials.ts \
        backend/src/modules/n8n-provisioning/__tests__/credentials.test.ts
git commit -m "fix(n8n-provisioning): align ldap credential payload to n8n schema — drop baseDn, port as string (#181)"
```

---

### Task 3: Full module suite + build verification

**Files:** none (verification only).

- [ ] **Step 1: Whole-module suite + tsc**

Run: `cd backend && npx jest src/modules/n8n-provisioning && npx tsc --noEmit`
Expected: all green; 0 new tsc errors. Confirms Tasks 1-2 didn't regress the other provisioning tests.

- [ ] **Step 2: Commit (only if any incidental fix was needed; otherwise skip)**

---

### Task 4: Prod backfill + end-to-end verification (runbook, operator-run — needs user OK)

> The bootstrap fix (Task 1) only runs on future install/update/manual-bootstrap. The **existing** prod provisioner still lacks its project, so a one-time backfill is needed. This is a live DB write + a backend rebuild/redeploy — run with the user's OK. Never print the n8n API key.

- [ ] **Step 1: Backfill the existing prod provisioner's personal project**

Run the same idempotent SQL from Task 1 against prod (via the sourced lib or inline), then assert:

```bash
podman exec cmdb-postgres-prod psql -U admin -d cmdb_db -tAc "
SELECT count(*) FROM n8n_data.project_relation pr
JOIN n8n_data.\"user\" u ON u.id = pr.\"userId\"
WHERE u.email='cmdb-provisioner@cmdb.local' AND pr.role='project:personalOwner';"
# expected: 1
```

- [ ] **Step 2: Deploy the code fix (Task 2) — rebuild backend, verify dist, full down/up**

Per the documented safe procedure (memory `ops_podman_compose_build_cache_bug`): `podman build` direct, grep the LDAP fix marker in the built `dist` (`grep 'String(port)'` in `dist/src/modules/n8n-provisioning/credentials.js` and confirm no `baseDn`), tag `latest`, full stack `down`/`up`. (This can ride along with the next release rather than a standalone deploy — coordinate with the user.)

- [ ] **Step 3: Verify all four provisioning calls now succeed**

Trigger a resync (temp ADMIN recipe from CLAUDE.md; compute the TOTP in-container, never print it) and assert `errors: []`:

```bash
curl -sk -H "Authorization: Bearer $TOKEN" -X POST https://localhost/api/admin/n8n/resync | python3 -c "import sys,json; print('errors:', json.load(sys.stdin)['report']['errors'])"
# expected: errors: []
```

Also confirm the boot log after a restart shows `aprovisionamiento completado` (no `con errores`). Delete the temp admin afterwards.

- [ ] **Step 4: Close #181**

```bash
gh issue close 181 --repo pirexia/cmdb-enterprise-platform \
  -c "Resuelto: bootstrap crea el personal project del provisioner (fix 500s), buildLdapCredential alineado al schema n8n (drop baseDn + port string, fix 400 LDAP), y el workflow vCenter deja de dar 400 al resolverse su credencial. Verificado en prod: resync errors:[]."
```

---

## Self-Review

**Spec coverage (the 4 failures):**
- `CMDB Service Token` 500 → Task 1 (personal project). ✔
- `CMDB SMTP` 500 → Task 1 (same root cause; SMTP payload is already valid — it 500'd only on the Project). ✔
- `CMDB LDAP` 400 → Task 2 (drop `baseDn`, string `port`). Note: after Task 2, LDAP also needs Task 1 (it would then reach the Project 500) — both required, verified together in Task 4. ✔
- `vCenter Sync` workflow 400 → cascade of the Service Token credential; resolves once Task 1 lands (verified in Task 4 Step 3, no separate code change). ✔

**Placeholder scan:** every code/SQL step is concrete. The only empirical unknown left — whether the vCenter 400 is *purely* a cascade — is explicitly a verification step (Task 4 Step 3), with the mechanism already traced (node → `httpHeaderAuth` → empty `credIdMap` id). If it unexpectedly persists after Task 1, that becomes a new finding to diagnose, not a silent gap.

**Type consistency:** `port: String(port)` and the dropped `baseDn` are applied consistently in `credentials.ts`, its type, and both updated tests. The bootstrap SQL uses the exact table/column/role names verified live (`n8n_data.project`, `n8n_data.project_relation`, role `project:personalOwner`, project `type='personal'`).

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-16-issue-181-n8n-credential-provisioning.md`.

**Suggested order:** Task 1 → Task 2 → Task 3 (all code, reviewable) → Task 4 (prod runbook, needs your OK; ideally folded into the next release deploy rather than a standalone prod interruption).

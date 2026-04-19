# Fix Critical Security Issues #68 & #69 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the OS command injection vulnerability in the CSR generation endpoint (Issue #68) and confirm Issue #69 is already resolved.

**Architecture:** The backend is a single Express file (`backend/src/index.ts`, ~4 000 lines). The CSR endpoint calls OpenSSL via `child_process.exec` — a shell-based API that processes a template string, making shell injection possible regardless of sanitisation. Replacing it with `child_process.execFile` passes arguments as an array directly to the kernel, bypassing the shell entirely.

**Tech Stack:** Node.js / TypeScript, `child_process.execFile` (stdlib), OpenSSL CLI, Docker Compose.

---

## Pre-work: Issue #69 — verify already fixed

The audit reported `docker-compose.prod.yml` exposed the backend port on the host. Inspection of the current file (and the audit-base commit `6cb8338`) shows the backend service has **no `ports:` stanza** — it is already internal-only. The finding was based on an older commit predating the nginx gateway feature. No code change is needed; the issue will be closed after verification in Task 2.

---

## File Map

| Action | File | What changes |
|--------|------|--------------|
| Modify | `backend/src/index.ts` lines 1801–1851 | Replace `exec`/`execAsync` with `execFile`/`execFileAsync`; remove shell command string; pass all OpenSSL arguments as an array; remove the now-redundant `sanitiseDnField` helper (the `sanitiseSan` helper for the SAN value can also be removed — no shell means no injection vector, though it can be kept as belt-and-suspenders input validation) |
| Verify (no change) | `docker-compose.prod.yml` | Confirm no `ports:` on backend service |

---

## Task 1 — Replace `exec` with `execFile` in the CSR endpoint

**Files:**
- Modify: `backend/src/index.ts:1777–1873`

### Current code (lines 1801–1851, abridged)

```typescript
const { exec } = await import('child_process');
const { promisify } = await import('util');
const execAsync = promisify(exec);
// ...
const cmd = `openssl req -new -newkey rsa:4096 -nodes \
  -keyout "${keyPath}" \
  -out "${csrPath}" \
  -subj "${subject}" \
  -addext "subjectAltName=${sanValue}"`;

const { stderr } = await execAsync(cmd);
```

The shell expands the template string. Even after `sanitiseDnField` strips obvious metacharacters, edge cases remain and relying on sanitisation to prevent injection is a defence-in-depth anti-pattern — the shell must not be involved at all.

---

- [ ] **Step 1: Open `backend/src/index.ts` and replace the `exec` import + shell command with `execFile`**

  Replace lines 1801–1854 (from `const { exec } = await import(...)` through `const { stderr } = await execAsync(cmd);`) with the following:

  ```typescript
  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const execFileAsync = promisify(execFile);

  // ...existing certDir / keyPath / csrPath / fs.mkdirSync block stays unchanged...

  // Build the subject string (still needed as a single -subj argument value)
  const safeCn  = cn.trim().replace(/[/\\"'\0]/g, '');
  const safeO   = o?.trim()  ? o.trim().replace(/[/\\"'\0]/g, '')   : '';
  const safeOu  = ou?.trim() ? ou.trim().replace(/[/\\"'\0]/g, '')  : '';
  const safeC   = c?.trim()  ? c.trim().replace(/[/\\"'\0]/g, '')   : '';
  const safeSt  = st?.trim() ? st.trim().replace(/[/\\"'\0]/g, '')  : '';
  const safeL   = l?.trim()  ? l.trim().replace(/[/\\"'\0]/g, '')   : '';

  const subject =
    `/CN=${safeCn}` +
    (safeC  ? `/C=${safeC}`   : '') +
    (safeSt ? `/ST=${safeSt}` : '') +
    (safeL  ? `/L=${safeL}`   : '') +
    (safeO  ? `/O=${safeO}`   : '') +
    (safeOu ? `/OU=${safeOu}` : '');

  // Build SAN extension
  let sanValue: string;
  if (san?.trim()) {
    sanValue = san.trim().replace(/[^a-zA-Z0-9.:,\-_*]/g, '');
  } else {
    const ipPattern = /^(\d{1,3}\.){3}\d{1,3}$/;
    sanValue = ipPattern.test(safeCn) ? `IP:${safeCn}` : `DNS:${safeCn}`;
  }
  if (!sanValue.includes('localhost')) {
    sanValue += ',DNS:localhost,IP:127.0.0.1';
  }

  log.info(`[POST /api/admin/certificates/csr] Generating 4096-bit CSR: ${subject} | SAN: ${sanValue}`);

  // execFile passes args as an array — no shell is invoked, injection is impossible
  const { stderr } = await execFileAsync('openssl', [
    'req', '-new', '-newkey', 'rsa:4096', '-nodes',
    '-keyout', keyPath,
    '-out',    csrPath,
    '-subj',   subject,
    '-addext', `subjectAltName=${sanValue}`,
  ]);
  ```

  > **Note:** The `/` characters in the `-subj` value are OpenSSL DN separators, not shell metacharacters — they are safe to pass as arguments. The sanitisation of `\`, `"`, `'`, and null bytes (`\0`) in the subject fields is a belt-and-suspenders measure only; with `execFile` they are not injection vectors.

- [ ] **Step 2: Remove the two now-unused standalone helper functions**

  Delete the `sanitiseDnField` function (lines 1777–1782) and the `sanitiseSan` function (lines 1784–1787). The inline replacements in Step 1 make them redundant. If you prefer to keep the helpers for readability, that's fine — just inline-replace the `sanitiseDnField(...)` and `sanitiseSan(...)` calls with the new `.replace(...)` calls already shown in Step 1.

  The full removed block:
  ```typescript
  /** Sanitise a DN field to prevent shell-injection through the -subj argument. */
  function sanitiseDnField(value: string): string {
    // Strip characters that are special inside an OpenSSL -subj string or shell:
    // forward-slash (path separator in DN), double-quote, backslash, backtick, $, newline.
    return value.replace(/[/\\"'`$\n\r]/g, '');
  }

  /** Sanitise a SAN value (DNS or IP token). Only allow safe characters. */
  function sanitiseSan(value: string): string {
    return value.replace(/[^a-zA-Z0-9.:,\-_*]/g, '');
  }
  ```

- [ ] **Step 3: TypeScript check — 0 new errors**

  ```bash
  cd backend && npx tsc --noEmit 2>&1 | grep -v "Property 'license'" | grep -v "Property 'licenseUser'"
  ```

  Expected: no output (exit 0). Any new error must be fixed before continuing.

- [ ] **Step 4: Rebuild containers and verify health**

  ```bash
  sg docker -c "docker compose down && docker compose up -d --build"
  ```

  Wait ~30 s for startup, then:

  ```bash
  curl -sk https://localhost/api/health
  ```

  Expected output: `{"status":"ok"}` (or similar JSON with `"status":"ok"`).

- [ ] **Step 5: Smoke-test the CSR endpoint**

  ```bash
  # 1. Obtain a token (replace password with your local admin password)
  TOKEN=$(curl -sk -X POST https://localhost/api/auth/login \
    -H "Content-Type: application/json" \
    -d '{"email":"admin@cmdb.local","password":"Admin1234!"}' \
    | grep -o '"token":"[^"]*"' | cut -d'"' -f4)

  # 2. Generate a CSR — should return JSON with a "csr" field
  curl -sk -X POST https://localhost/api/admin/certificates/csr \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $TOKEN" \
    -d '{"cn":"test.cmdb.local","o":"Acme Corp","c":"ES"}' \
    | grep -c '"csr"'
  ```

  Expected: `1` (the `"csr"` key is present in the response).

- [ ] **Step 6: Commit**

  ```bash
  git add backend/src/index.ts
  git commit -m "fix(security): replace exec with execFile in CSR endpoint — closes #68

  child_process.exec passes the command through /bin/sh; even with field
  sanitisation, shell injection is possible. execFile bypasses the shell
  entirely by passing OpenSSL arguments as an array, making injection
  structurally impossible.

  Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
  ```

---

## Task 2 — Verify Issue #69 is already resolved and close it

**Files:**
- Verify (no change): `docker-compose.prod.yml`

- [ ] **Step 1: Confirm no backend `ports:` in docker-compose.prod.yml**

  ```bash
  grep -n "ports:" docker-compose.prod.yml
  ```

  Expected output (only nginx, not backend):
  ```
  144:    ports:
  ```

  If a `ports:` entry for the backend appears, remove the stanza:
  ```yaml
  # Delete these two lines from the backend service:
  ports:
    - "${BACKEND_PORT:-3000}:3000"
  ```

- [ ] **Step 2: Close GitHub issue #69 with a comment**

  ```bash
  gh issue close 69 --comment "Verified: the backend service has no \`ports:\` stanza in \`docker-compose.prod.yml\` in the current codebase (confirmed at commits \`6cb8338\` and \`f1a52a9\`). The finding references an older pre-nginx-gateway version of the file. No code change is required — closing as already resolved."
  ```

- [ ] **Step 3: Close GitHub issue #68 after confirming the fix commit is on develop**

  ```bash
  gh issue close 68 --comment "Fixed in commit \$(git rev-parse --short HEAD) on develop: replaced \`child_process.exec\` with \`child_process.execFile\` — OpenSSL arguments are now passed as an array, bypassing the shell entirely."
  ```

---

## Task 3 — Push to develop

- [ ] **Step 1: Verify current branch is develop**

  ```bash
  git branch --show-current
  ```

  Expected: `develop`. If not on develop, run `git checkout develop` first.

- [ ] **Step 2: Push**

  ```bash
  git push origin develop
  ```

  Expected: fast-forward push; no force needed.

- [ ] **Step 3: Confirm issues are closed on GitHub**

  ```bash
  gh issue view 68 --json state,title | grep '"state":"CLOSED"'
  gh issue view 69 --json state,title | grep '"state":"CLOSED"'
  ```

  Expected: both lines print the closed state.

---

## Self-Review

**Spec coverage:**
- Issue #68 (command injection): ✅ Covered in Task 1 — `execFile` eliminates the shell
- Issue #69 (backend port exposed): ✅ Covered in Task 2 — already resolved; verification + issue closure documented

**Placeholder scan:** No TBD, no TODO, no "similar to Task N", all code blocks are complete.

**Type consistency:** `execFileAsync` is defined and used in Task 1 Steps 1–5. No name divergence.

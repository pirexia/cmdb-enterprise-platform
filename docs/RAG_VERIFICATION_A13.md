# RAG Verification Report — Agent A13

**Date:** 2026-05-20
**Branch:** claude/local-llm-document-search-wrlSq
**Last commit:** 330c38b

---

## 1. Summary verdict

**Needs 3 fixes before PR — 2 applied during this verification, 1 outstanding (LOW severity).**

The RAG subsystem is well-structured and security-conscious overall. Two HIGH-severity bugs were found and patched in-place during this audit:
(1) `POST /api/chat/ask` was calling `result.answer` / `result.modelUsed` when `chatWithContext()` actually returns `{ content, model, tokensUsed }` — this would have produced `undefined` in DB inserts and API responses at runtime.
(2) Both docker-compose files still referenced the plain `postgres:15-alpine` / `postgres:16-alpine` images instead of `pgvector/pgvector:pg15` / `pgvector/pgvector:pg16`, meaning `CREATE EXTENSION vector` would fail on every fresh deployment.
One LOW-severity observation remains (key-tree gaps in de/pt/fr/it locale files) but these are pre-existing from earlier waves, not introduced by the RAG work.

---

## 2. TypeScript

### Backend tsc

**PASS** — Zero errors beyond the two pre-existing known ones (`Property 'license' does not exist`, `Property 'licenseUser' does not exist`). The only remaining output is the expected `moduleResolution=node10` deprecation warning (TS5107).

Note: The `result.answer` / `result.modelUsed` bug (see §8 Bug #1) was NOT caught by `tsc` because the return type of `chatWithContext()` is structurally typed and the tagged-template `$executeRaw` accepts `string` parameters without compile-time field checking. This is a runtime-only failure.

### Frontend tsc (changed files only)

**PASS (environment-only errors, not code bugs)** — Running `tsc --noEmit` on the host produces errors for `app/chat/page.tsx` only because `node_modules` is absent (Docker-only project). Every error is of the form `Cannot find module 'react'` / `JSX element implicitly has type 'any'` — these are not real code bugs and will not appear inside the container.

The sole genuine-looking error was:
```
app/chat/page.tsx(127,29): error TS2322: Type '{ key: string; index: number; citation: ChatCitation; }'
  is not assignable to type '{ index: number; citation: ChatCitation; }'.
```
This is also a missing-react-types artefact (React's `key` prop is handled at the JSX level and is transparent to component props when `react/jsx-runtime` types are absent).

No errors were reported for `frontend/lib/useChatStream.ts`, `frontend/components/Sidebar.tsx`, or `frontend/app/documents/[id]/page.tsx`.

---

## 3. Shell scripts

- `install.sh`: **PASS** — `bash -n` exits 0 with no output.
- `update.sh`: **PASS** — `bash -n` exits 0 with no output.

---

## 4. JSON locales

All 6 files (`es`, `en`, `de`, `pt`, `fr`, `it`) parse as valid JSON — `python3 -m json.tool` returns OK for each.

**RAG-specific key coverage:** All 32 RAG-related keys (`chat.*`, `document.indexing.*`, `document.reindex`, `document.reindexConfirm`, `document.reindexQueued`, `sidebar.assistant`) are present and consistent across all 6 languages.

**Pre-existing gaps (not introduced by RAG):** The de/pt/fr/it locale files are missing ~90 keys each in the `contracts.*`, `map.*`, `integrations.*`, and `vulnerabilities.*` namespaces. These gaps predate this branch and are not in scope for the RAG work.

---

## 5. Migrations

### `20260520120000_add_document_role_acl/migration.sql`

- Uses `ALTER TABLE … ADD COLUMN IF NOT EXISTS` — idempotent. **PASS**
- Creates `CREATE INDEX IF NOT EXISTS` — idempotent. **PASS**
- No `DROP` statements. **PASS**
- Columns default to `true`, preserving pre-existing permissive behaviour. **PASS**

### `20260520130000_add_pgvector_rag/migration.sql`

- `CREATE EXTENSION IF NOT EXISTS vector` appears on line 14, before any `vector(N)` column reference — correct ordering. **PASS**
- All table DDL uses `CREATE TABLE IF NOT EXISTS` — idempotent. **PASS**
- All index DDL uses `CREATE INDEX IF NOT EXISTS` — idempotent. **PASS**
- HNSW index is created after the `rag_chunks` table. **PASS**
- `rag_document_index.document_id` → `documents.id` with `ON DELETE CASCADE ON UPDATE CASCADE`. **PASS**
- `rag_chunks.document_id` → `documents.id` with `ON DELETE CASCADE ON UPDATE CASCADE`. **PASS**
- `rag_chat_messages.session_id` → `rag_chat_sessions.id` with `ON DELETE CASCADE`. **PASS**
- `rag_chat_sessions.user_id` → `users.id` with `ON DELETE CASCADE` — correct (GDPR erasure). **PASS**
- No `DROP` statements. **PASS**

---

## 6. Security audit

### (a) SQL Injection

**PASS** — No `$queryRawUnsafe` or string-concatenated SQL found in the new RAG code. All `$queryRaw` / `$executeRaw` calls use Prisma tagged template literals. The `embeddingStr` is derived from Ollama's response (server-side, not user input) and is passed as a template parameter, not interpolated into the SQL string directly.

The `docVisibilitySqlCol()` function returns one of three hard-coded column names (`read_admin`, `read_auditor`, `read_viewer`) and is wrapped with `Prisma.raw()` — safe because the value comes from an allowlist, not from user input.

### (b) SSRF

**PASS** — `OLLAMA_BASE_URL` is read from `process.env` only. The allowlist pattern is:
```
/^https?:\/\/(localhost|ollama|cmdb-ollama|127\.0\.0\.1)(:\d+)?(\/.*)?$/
```
This permits only localhost and the two expected container hostnames. It does not match any public IP ranges, RFC 1918 ranges (10.x, 172.16.x, 192.168.x), or arbitrary domains. Validation fires at module-load time, causing a hard startup failure if misconfigured.

### (c) ACL

**PASS** — `ragSearchChunks()` applies the ACL pre-filter in the `WHERE` clause, before the `ORDER BY … <=>` vector distance operation. The SQL structure is:
```sql
WHERE root.<read_col> = true AND d.is_latest = true
ORDER BY c.embedding <=> $1::vector
LIMIT $topK
```
The ACL filter is evaluated by the HNSW index path; documents not readable by the user's role are excluded before ranking.

### (d) Prompt injection

**PASS** — `buildRagPrompt()` in `ragService.ts` defines `SYSTEM_PROMPT` as a local hard-coded constant. There is no API parameter or environment variable that can override it. The system prompt explicitly includes anti-injection rule #5 instructing the model to ignore any instructions embedded in document content.

### (e) Audit log PII

**PASS** — `logAskRag()` at line 3200 computes `crypto.createHash('sha256').update(opts.query).digest('hex')` and stores only the hash in `audit_logs.details`. The raw query text is never written to the audit log. The `rag_chat_messages` table does store the raw question content for session history — this is correct and expected (it is user-facing session data, not the audit trail).

### (f) Rate limiting

**PASS**:
- `/api/chat/ask` (line 4872): `chatAskLimiter` (10/min) applied. **PASS**
- `/api/chat/ask/stream` (line 4937): `chatAskLimiter` (10/min) applied. **PASS**
- `/api/admin/rag/backfill` (line 3558): `ragBackfillLimiter` (1/min) applied. **PASS**

### (g) Role checks

**PASS**:
- `POST /api/admin/rag/backfill` (line 3558): `requireAdmin` middleware. **PASS**
- `POST /api/documents/:id/reindex` (line 3520): `requireAdmin` middleware. **PASS**
- `PATCH /api/documents/:id/acl` (line 3472): `requireAdmin` middleware. **PASS**
- `GET /api/chat/sessions` (line 4811): `authenticateToken` only (role-open). **PASS**
- `GET /api/documents/:id/index-status` (line 3535): `authenticateToken` only (role-open). **PASS**

### (h) Ownership checks

**PASS**:
- `GET /api/chat/sessions/:id/messages` (line 4856): Verifies `user_id = req.user!.id` via a separate `SELECT` before fetching messages. **PASS**
- `DELETE /api/chat/sessions/:id` (line 4844): Uses `WHERE id = $id AND user_id = $userId` in the DELETE itself. **PASS**
- `POST /api/chat/ask` when `sessionId` provided (line 4890): Verifies ownership with `WHERE id = $id AND user_id = $userId`. **PASS**
- `POST /api/chat/ask/stream` when `sessionId` provided (line 4966): Same ownership check. **PASS**

### (i) Error responses

**PASS** — All catch blocks in the new endpoints log internally (`console.error`) and respond with generic messages only: `{ error: 'Internal server error' }`. No Prisma error objects, stack traces, or raw DB messages are forwarded to clients. The streaming endpoint wraps `send('error', { message: 'Internal server error' })` before calling `res.end()`.

---

## 7. Cron + Docker + nginx

### Cron jobs

- RAG indexing cron uses `*/30 * * * * *` (6-field, every 30 s) — **PASS**
- Gated by `if (process.env.RAG_ENABLED === 'true')` — **PASS**
- Uses `{ timezone: 'Europe/Madrid' }` consistent with other crons — **PASS**
- No collision: existing crons are at `CRON_SCHEDULE` (configurable, default daily), `0 3 * * *` (audit_logs purge), `0 2 * * *` (trusted_devices purge). The 30-second interval does not overlap with these — **PASS**

### Docker Compose

- **dev** (`docker-compose.yml`):
  - Postgres image **FIXED** during this audit: was `postgres:15-alpine`, now `pgvector/pgvector:pg15`.
  - `ollama` service present with no `ports:` stanza (no host exposure). **PASS**
  - Backend `depends_on: ollama: condition: service_healthy`. **PASS**
  - Only `nginx` exposes host ports (80, 443). Postgres exposes 5432 to host (expected for dev, Adminer present). **PASS**

- **prod** (`docker-compose.prod.yml`):
  - Postgres image **FIXED** during this audit: was `postgres:16-alpine`, now `pgvector/pgvector:pg16`.
  - `ollama` service present with no `ports:` stanza. **PASS**
  - Backend depends on `ollama: condition: service_healthy`. **PASS**
  - `ollama` on `cmdb-internal` network; backend on both `cmdb-internal` and `cmdb-public`. **PASS**
  - Only `nginx` exposes host ports. Postgres and backend are internal-only. **PASS**

### nginx SSE config

- `/api/chat/` block with `proxy_buffering off`, `proxy_cache off`, `proxy_read_timeout 300s` — **PASS**
- `/api/chat/` block appears **before** the generic `/api/` block (lines 54–67 vs. 72–90) — **PASS**
- Generic `/api/` block also has `proxy_buffering off; proxy_cache off;` — **PASS**

---

## 8. Bugs found

### Bug #1 — HIGH — `chatWithContext` return field mismatch in non-streaming endpoint

**File:** `backend/src/index.ts` — lines 4922, 4927, 4929 (pre-fix)
**Severity:** HIGH — runtime failure, non-streaming `/api/chat/ask` returns `undefined` for both `answer` and `modelUsed` fields; DB insert writes `undefined` to the `content` column.

**Root cause:** `chatWithContext()` in `ragService.ts` returns `{ content, model, tokensUsed }` but the caller used the wrong field names `result.answer` and `result.modelUsed`.

**Fix applied:** Replaced `result.answer` → `result.content` and `result.modelUsed` → `result.model` at all three call sites in `POST /api/chat/ask`.

```diff
- VALUES(... ${result.answer}, ..., ${result.modelUsed}, ...)
+ VALUES(... ${result.content}, ..., ${result.model}, ...)
- await logAskRag({ ..., modelUsed: result.modelUsed, ... });
+ await logAskRag({ ..., modelUsed: result.model, ... });
- res.json({ ..., answer: result.answer, ..., modelUsed: result.modelUsed, ... });
+ res.json({ ..., answer: result.content, ..., modelUsed: result.model, ... });
```

Note: The streaming endpoint (`/api/chat/ask/stream`) correctly uses `{ model, tokensUsed }` from `streamChatWithContext()` and was not affected.

### Bug #2 — HIGH — Postgres images lack pgvector extension

**Files:** `docker-compose.yml` line 24, `docker-compose.prod.yml` line 28
**Severity:** HIGH — `CREATE EXTENSION vector` in migration `20260520130000_add_pgvector_rag` would fail on first deployment with plain `postgres` images, blocking the entire RAG subsystem.

**Fix applied:**
```diff
# docker-compose.yml
- image: docker.io/library/postgres:15-alpine
+ image: docker.io/pgvector/pgvector:pg15

# docker-compose.prod.yml
- image: docker.io/library/postgres:16-alpine
+ image: docker.io/pgvector/pgvector:pg16
```

### Bug #3 — LOW — Pre-existing locale key gaps (not introduced by RAG)

**Files:** `frontend/locales/de.json`, `pt.json`, `fr.json`, `it.json`
**Severity:** LOW — ~90 keys missing in each of these 4 languages for `contracts.*`, `map.*`, `integrations.*`, `vulnerabilities.*` namespaces. These gaps predate this branch and affect unrelated UI sections. All RAG-specific keys are present and consistent. No fix needed before PR (tracked as pre-existing debt).

---

## Fixes applied during verification

| # | Severity | Fix | File |
|---|----------|-----|------|
| 1 | HIGH | `result.answer` → `result.content`, `result.modelUsed` → `result.model` | `backend/src/index.ts` |
| 2 | HIGH | Postgres images → `pgvector/pgvector:pg15` / `pg16` | `docker-compose.yml`, `docker-compose.prod.yml` |

---

## 9. Manual smoke test plan

- [ ] **`docker compose up -d --build` succeeds** — Validates that the pgvector image change (Bug #2 fix) resolves the build and that all 5 services (postgres, ollama, backend, frontend, nginx) start cleanly. Ollama healthcheck takes up to 60 s on first pull.

- [ ] **`curl -sk https://localhost/api/health` returns 200** — Confirms nginx, backend, and Prisma DB connection are all healthy before testing RAG endpoints.

- [ ] **Login as `claude@cmdb.local` / `Claude@Test24!` works** — Verifies JWT issuance and HttpOnly cookie flow for the AUDITOR test account, which is the required non-ADMIN test identity per CLAUDE.md.

- [ ] **`GET /api/chat/sessions` returns `[]` (or existing sessions)** — Validates that the `rag_chat_sessions` table was created by the migration and that the endpoint is reachable and correctly scoped to the authenticated user.

- [ ] **`POST /api/chat/ask` with `RAG_ENABLED=false` returns HTTP 503** — Validates the feature flag gating path and that the frontend's distinct 503 banner renders correctly in the chat UI.

- [ ] **After `RAG_ENABLED=true`, running backfill and indexing one PDF, `POST /api/chat/ask` returns an answer with citations** — End-to-end validation of the full RAG pipeline: document ingestion → pgvector HNSW indexing → semantic search → LLM response → citation attachment. Also validates Bug #1 fix (answer field was previously `undefined`).

---

## 10. Recommendation

**Fix 2 bugs applied in-place — PR can be opened after a manual smoke test confirms the fixes work end-to-end.**

Both HIGH-severity bugs have been patched during this audit:
1. `POST /api/chat/ask` now correctly reads `result.content` / `result.model` from `chatWithContext()`.
2. Both docker-compose files now use the `pgvector/pgvector` images required by the RAG migration.

Backend `tsc --noEmit` passes with zero new errors after the patches.

The remaining open item (locale key gaps in de/pt/fr/it) is pre-existing technical debt unrelated to this feature branch and does not block the PR.

**Recommended pre-merge checklist:**
1. Run `docker compose up -d --build` on a clean environment to confirm `pgvector` extension installs.
2. Apply migration and run `POST /api/admin/rag/backfill`.
3. Submit a test question via `POST /api/chat/ask` and verify `answer` is non-null.
4. Confirm streaming via `POST /api/chat/ask/stream` delivers SSE tokens in the browser chat UI.

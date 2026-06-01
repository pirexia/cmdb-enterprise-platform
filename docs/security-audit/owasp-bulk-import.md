# OWASP Top 10 (2021) Security Audit — Bulk Document Import

**Audit ID:** OWASP-BULK-IMPORT-001
**Audit date:** 2026-05-29
**Auditor:** Independent security review
**Scope:** The "Bulk Document Import" feature. ADMIN-only multi-file upload to a disk staging area, asynchronous AI metadata extraction (Ollama), human review/correction, and per-line materialization into real `Document` (+ optional `Contract`/`Addendum`/`License`) records with associations.
**Code under review:**
- `backend/src/index.ts` — staging constants + magic-byte validator (`3115–3162`), AI worker (`BulkAnalysisSchema`, `normalizeAnalysis`, `matchCIsForImport`, `recomputeBatchStatus`, `processBulkImportQueue` `3532–3695`), materialization (`BulkItemDecisionSchema`, `materializeBulkItem` `3697–3847`), multer config (`bulkUpload`, `bulkUploadMiddleware` `4033–4064`), HTTP endpoints (`4366–4588`), and the hourly cleanup cron (`5468–5491`).
- `backend/src/services/ragService.ts` — `analyzeDocumentForImport` + `OLLAMA_BASE_URL` allowlist (`68–95`, `495–587`).
- `backend/prisma/migrations/20260529000000_bulk_document_import/migration.sql` and the `BulkImportBatch` / `BulkImportItem` models in `backend/prisma/schema.prisma` (`781–817`).
- Frontend: `frontend/app/documents/page.tsx` (`BulkUploadModal`) and `frontend/app/documents/bulk/[batchId]/page.tsx` (review screen).

**Platform version:** v2.3.x (feature branch, unmerged migration on `main`)
**Classification:** CONFIDENTIAL — Internal security audit record

---

## Executive Summary

The Bulk Document Import feature is, overall, a **well-engineered and security-conscious implementation**. It correctly applies the project's hard rules in the great majority of places: every endpoint is gated by `authenticateToken` + `requireAdmin`; all batch/item reads and mutations are scoped to `created_by = req.user!.email` at the SQL `WHERE` clause (DB-level ownership, not post-fetch); all dynamic SQL uses Prisma tagged template literals with `::uuid` casts and `Prisma.join` for `IN` lists; the AI's JSON output is parsed through a strict Zod schema, never used to build SQL, and every foreign key it suggests (document type, vendor, parent contract, CIs) is re-validated for existence at commit time inside a transaction; the `LIKE` query in `matchCIsForImport` escapes `% _ \` and uses `ESCAPE '\\'`; magic bytes are validated for every file before anything touches disk; staged filenames are server-generated UUIDs and every disk read defensively wraps the stored name in `path.basename`; the Ollama base URL is taken only from the environment and validated against an internal-host allowlist at module load; the file copy-then-delete rollback keeps staging intact until the DB transaction commits; and the staging area is bounded by per-file size, per-batch file-count, per-batch total-byte caps, plus an hourly TTL cleanup cron.

The audit nevertheless identified one **HIGH** finding (a time-of-check/time-of-use double-commit race that can produce duplicate materialized records and orphaned files), two **MEDIUM** findings (no re-validation of file content integrity at materialization time; no cap on the number of concurrent open batches per admin), and several **LOW / INFO** items (incomplete audit coverage of commit/edit actions, internal error text surfaced to the admin UI, the TTL cron silently discarding partially-reviewed batches, and the AI per-cycle budget interacting with the shared Ollama queue).

### Findings by Severity

| Severity | Count | Description |
|----------|-------|-------------|
| CRITICAL | 0 | No critical findings |
| HIGH | 1 | Double-commit TOCTOU race (BULK-A08-1 / BULK-A01-2) |
| MEDIUM | 2 | No magic-byte re-check at materialization (BULK-A08-2); no per-admin batch cap (BULK-A04-1) |
| LOW | 4 | Commit/edit audit gap; internal error text in UI; TTL cron discards reviewed batches; AI budget/DoS interaction |
| INFO | 6 | Positive controls documented; no action required |

**Overall verdict: SOLID with one race condition to fix before production.** The core trust boundaries (access control, injection, SSRF, AI-output validation) are correctly implemented. The HIGH finding is a concurrency correctness/integrity bug, not an authn/authz bypass, and is straightforward to remediate with a conditional `UPDATE` guard.

---

## A01: Broken Access Control

**Applicability:** HIGH — multi-file write feature touching Documents, Contracts and Licenses.
**Risk Level:** LOW (one HIGH item is cross-listed under A08 as it is fundamentally an integrity race).

### Controls Verified (positive)

- **Role gating is complete.** Every one of the eight bulk endpoints is declared with `authenticateToken, requireAdmin`: `POST /api/documents/bulk/batches` (`4372`), `GET .../batches` (`4429`), `GET .../batches/:id` (`4446`), `DELETE .../items/:id` (`4469`), `DELETE .../batches/:id` (`4488`), `PATCH .../items/:id` (`4509`), `POST .../items/:id/commit` (`4529`), `POST .../batches/:id/commit` (`4558`). No bulk endpoint is reachable by `AUDITOR`/`VIEWER`.
- **Ownership is enforced at the database layer, not post-fetch.** Every batch/item lookup carries `b.created_by = ${req.user!.email}` (or `b.created_at`/`b.id` joined to the batch) directly in the SQL `WHERE` clause: list (`4437`), detail (`4452`), delete item (`4475`), delete batch (`4492`), patch (`4516`), commit item (`4536`), commit batch (`4562`). A non-owning admin who guesses a batch/item UUID receives `404`, and no file or analysis content is returned. This satisfies the CLAUDE.md rule "ownership checks must be DB-level filters, not post-fetch filtering."
- **The AI worker correctly operates as a system process** (`processBulkImportQueue`, `3641`) without an owner scope — that is correct because it is not an HTTP-reachable, user-driven path; it only reads `PENDING_ANALYSIS` rows and writes back analysis. It never escalates privilege or crosses tenant boundaries.

### Finding BULK-A01-1 — INFO

The ownership model is "creator-only": a batch is visible and mutable solely by the admin whose `email` created it. Because all three roles that can reach these endpoints are `ADMIN` (and ADMINs are otherwise mutually trusted in this platform), this is a reasonable design, but note that there is **no shared/admin-team visibility** — if admin A is offboarded mid-import, admin B cannot resume or clean up A's batches through the API (only the TTL cron will eventually reap them). This is a usability/continuity observation, not a vulnerability.

**Recommendation (INFO):** If operational continuity across admins is desired, consider allowing any ADMIN to view/discard any batch while keeping `created_by` for audit attribution. No action required for security.

> The double-commit race that allows the same staged item to be materialized twice is documented as **BULK-A08-1** (it is an integrity/TOCTOU issue rather than an authorization bypass).

---

## A02: Cryptographic Failures

**Applicability:** LOW — the feature introduces no new secrets, key material, or transport.
**Risk Level:** NONE

### Assessment

- Staged filenames use `crypto.randomUUID()` (`4406`, `3775`) — cryptographically strong, unguessable, collision-resistant. There is no sequential or predictable identifier exposed to the client for staged files.
- No passwords, tokens, or key material are stored in `bulk_import_batch` / `bulk_import_item`. The `analysis` JSONB holds only extracted document metadata (dates, vendor names, CI hints) and the user's decision.
- Files are stored on disk unencrypted, consistent with the existing `DOCUMENTS_DIR` model (at-rest encryption is a platform-level concern handled outside this feature and out of scope here).

**Recommendation:** No action required.

---

## A03: Injection

**Applicability:** HIGH — the feature builds many SQL statements and ingests untrusted AI output and untrusted file content.
**Risk Level:** LOW

### Controls Verified (positive)

- **All SQL uses tagged template literals.** Every `$queryRaw` / `$executeRaw` in the feature is a Prisma tagged template — there is no string concatenation and no `$queryRawUnsafe` anywhere in the bulk paths. UUIDs are cast with `::uuid`, integers/bigints interpolated as values, and the only `IN (...)` list (CI existence check, `3769`) is built with `Prisma.join(decision.ciIds.map((id) => Prisma.sql`${id}::uuid`))` — parameterized, not concatenated.
- **The `LIKE` query is escaped correctly.** `matchCIsForImport` (`3592`) escapes the LIKE metacharacters with `hint.replace(/[\\%_]/g, (c) => '\\' + c)` (`3598`) and applies `ESCAPE '\\'` on every `ILIKE` clause (`3602`, `3605`). The hint is also length-bounded (`< 3` skipped, sliced to 20 hints, result `LIMIT 5` per hint and global `>= 25` cap) — this both prevents wildcard injection and bounds the scan, satisfying the CLAUDE.md LIKE rule.
- **The AI output is a hard trust boundary that is respected.** `analyzeDocumentForImport` returns `BulkAnalysisRaw` whose fields are all typed `unknown` and the function is documented "UNVALIDATED — the caller must validate/sanitize before persisting." `normalizeAnalysis` (`3569`) runs the raw object through `BulkAnalysisSchema` (`3535`, strict Zod with `.max()` length caps and `z.enum` for `suggestedTarget`), coerces each field, runs dates through `parseIsoDateSafe` (which rejects rollover dates like `2026-02-31`, `3556`), and filters/trims `ciHints`. The normalized result is stored as a parameterized `::jsonb` value (`3676`) — never interpolated into SQL text. The model's free-text never reaches a SQL statement, a shell, or `eval`.
- **AI-suggested foreign keys are re-validated, not trusted.** `ciHints` are resolved to real CI UUIDs only via the escaped DB lookup in `matchCIsForImport`; at commit, `materializeBulkItem` independently re-checks existence of `documentTypeId` (`3757`), `vendorId` (`3761`), `parentContractId` (`3765`), and counts the `ciIds` against `configuration_items` (`3768–3770`) before any insert. The user's reviewed `BulkItemDecision` is itself fully Zod-validated (`BulkItemDecisionSchema`, `3718`) — every id is `z.string().uuid()`, strings are length-capped, dates are regex-checked.

### Finding BULK-A03-1 — INFO

The document text fed to the model is control-char-stripped and length-capped in `analyzeDocumentForImport` (`519–520`) and wrapped in `<DOCUMENT>...</DOCUMENT>` with an explicit anti-injection system instruction (`530–532`). This mirrors `buildRagPrompt`'s `<ENTITY_DATA>` framing and is the correct defensive posture. Note that prompt-injection of the LLM cannot escalate to SQL/DB injection here because of the validation pipeline above — the worst an injected document can do is influence *suggested* metadata, which the human reviewer must confirm and which is re-validated against the DB at commit. No finding.

**Recommendation:** No action required.

---

## A04: Insecure Design

**Applicability:** HIGH — staging area, background AI budget, and cleanup lifecycle are design decisions with availability and DoS implications.
**Risk Level:** MEDIUM

### Controls Verified (positive)

- **Layered upload limits.** Per-file size (`MAX_FILE_SIZE`, multer `limits.fileSize`, `4036`), per-batch file count (`BULK_MAX_FILES` default 20, multer `limits.files` + explicit `.array('files', BULK_MAX_FILES)`, `4036`/`4049`), and per-batch total bytes (`BULK_MAX_TOTAL_BYTES` default 200 MB, checked at `4378`) are all enforced server-side. The frontend count check (`4289` in `page.tsx`) is advisory only — the server is authoritative.
- **Bounded AI work per tick.** `BULK_ANALYZE_BUDGET` (default 2, `3128`) caps items analyzed per cron cycle, and `processBulkImportQueue` runs *after* `processRagQueue` in the same 30 s tick (`5499`), explicitly so bulk analysis "never starves the normal RAG indexing queue." Generated tokens are capped (`num_predict: 512`, `561`) and the chat call has a timeout (`CHAT_TIMEOUT_MS`). This is good DoS-aware design.
- **TTL cleanup cron.** The hourly cron (`5471`) reaps batches older than `BULK_BATCH_TTL_HOURS` (default 24) and unlinks their non-committed staged files, bounding disk growth (cited ISO 22301 / NIS2). The worker also marks items `ANALYZING` before work and `ERROR` on failure (`3657`, `3683`) so a poison file cannot wedge the queue forever.

### Finding BULK-A04-1 — MEDIUM | CVSS:3.1/AV:N/AC:L/PR:H/UI:N/S:U/C:N/I:N/A:H (4.4)

**Location:** `POST /api/documents/bulk/batches` (`4372`); no per-creator open-batch limit anywhere.

While each individual batch is capped (20 files / 200 MB), there is **no limit on the number of concurrent batches a single admin may create**. An admin (or a compromised/abused admin session) can call `POST .../batches` in a loop, each call writing up to 200 MB to `STAGING_DIR`. With the default 24-hour TTL, up to 24 hours of unbounded batch creation accumulates before the cron reaps anything — the staging directory and the `bulk_import_batch`/`bulk_import_item` tables can grow without bound, risking disk exhaustion on the backend container (which shares the volume with the live `DOCUMENTS_DIR`) and degrading the AI queue (every new batch adds `PENDING_ANALYSIS` items the worker must grind through at 2/tick).

**Impact:** Availability — disk exhaustion could take down document storage and the database volume; queue saturation delays legitimate analysis. Requires ADMIN, so the trust bar is high, but A04/NIS2 explicitly call out "unbounded resource consumption" as a design defect, and ISO 22301 RTO targets assume bounded disk.

**Remediation:** Before creating a batch, count the caller's existing non-terminal batches and reject beyond a configurable ceiling, e.g.:
```ts
const open = await prisma.$queryRaw<{ c: bigint }[]>`
  SELECT COUNT(*) AS c FROM "bulk_import_batch"
  WHERE created_by = ${req.user!.email}
    AND status NOT IN ('COMMITTED','DISCARDED')`;
if (Number(open[0].c) >= BULK_MAX_OPEN_BATCHES) {
  res.status(429).json({ error: 'Demasiados lotes abiertos; finalízalos o descártalos' }); return;
}
```
Also consider a global staging-dir size watermark check, and applying `express-rate-limit` to the upload route.

### Finding BULK-A04-2 — LOW

**Location:** Cleanup cron (`5471–5491`).

The TTL cron selects **all** batches older than the TTL with no status filter (`5473–5475`), then deletes the batch row (cascading the items) and unlinks non-committed staged files. This means a batch the admin has *reviewed but not yet committed* (`READY`), or a `PARTIALLY_COMMITTED` batch with remaining un-committed lines, is silently destroyed at the 24-hour mark — the reviewer's edited decisions (stored in `analysis.decision`) and the staged source files are lost with no warning. Already-committed Documents survive (they were copied to `DOCUMENTS_DIR` and their staged copy already unlinked at commit), so this is a data-*availability*/UX issue, not data corruption.

**Impact:** A long-running review (e.g. an admin importing 20 contracts over two days) can lose work and source files. No security boundary is crossed.

**Remediation:** Either (a) exclude `READY`/`PARTIALLY_COMMITTED` from the reaper and only purge `UPLOADED`/`ANALYZING`/`ANALYZED`-but-untouched/`ERROR` batches past TTL, or (b) extend the TTL when an item is PATCHed/reviewed (bump `updated_at` and key the reaper off `updated_at` instead of `created_at`). Document the chosen retention behaviour for the operator (ISO 27001 A.5.37).

---

## A05: Security Misconfiguration

**Applicability:** MEDIUM — new disk paths, new env-driven config, file-type handling.
**Risk Level:** LOW

### Controls Verified (positive)

- **No CSP/helmet changes.** The feature adds no Express-level header changes; it relies on the existing `helmet` + nginx CSP stack. Verified by absence of any `res.setHeader('Content-Security-Policy', ...)` or helmet reconfiguration in the bulk code.
- **Config is env-driven with safe defaults.** `STAGING_DIR`, `BULK_MAX_FILES`, `BULK_MAX_TOTAL_MB`, `BULK_BATCH_TTL_HOURS`, `BULK_ANALYZE_BUDGET` (`3122–3128`) all read from `process.env` with sane fallbacks. `STAGING_DIR` defaults to a subdirectory of `DOCUMENTS_DIR` (`_staging`) — inside the allowlisted base dir, never a caller-supplied path.
- **Allowed extension set is tight** (`ALLOWED_EXTENSIONS`, `3131`) and enforced at the multer `fileFilter` (`4037`) before the file is even buffered.

### Finding BULK-A05-1 — INFO

The legacy `doc` and Office/ODF formats share the same ZIP magic prefix (`504b0304`) for `docx/xlsx/pptx/odt/ods` (`3142–3146`), so a renamed-`.xlsx`-as-`.docx` passes the magic check. This is an accepted limitation of magic-byte validation for container formats and is not exploitable here (all are parsed read-only by `parseDocument` and never executed). `txt`/`csv` accept on extension only (`3150–3151`, `3157`) — also acceptable since they are inert text. No finding.

**Recommendation:** No action required. If stricter typing is ever needed, validate the ZIP central-directory contents (`[Content_Types].xml`) for OOXML, but this is overkill for the current threat model.

---

## A06: Vulnerable and Outdated Components

**Applicability:** LOW — the feature reuses existing dependencies.
**Risk Level:** NONE (within scope)

### Assessment

No new npm packages are introduced by this feature. It reuses `multer` (^2.1.1, already audited), `zod` (^3.24.2), `@prisma/client` (^6.x), Node's built-in `crypto`/`fs`/`path`, and the existing `ragService` Ollama client (native `fetch`). The document parser (`parseDocument` in `docParser.ts`) and chunker are pre-existing components reused unchanged.

**Recommendation:** Run `npm audit` in the backend container after the next dependency bump cycle, with particular attention to `multer` and the document-parsing libraries (`mammoth`, `xlsx`, `pdf-parse` family) since they process untrusted file bytes. Out of scope for this feature audit.

---

## A07: Identification and Authentication Failures

**Applicability:** LOW — no new auth flow; relies on existing JWT/session middleware.
**Risk Level:** NONE

### Assessment

Authentication is delegated entirely to the existing `authenticateToken` middleware (JWT in HttpOnly cookie or `Authorization: Bearer`), which already validates signature, algorithm, the `mfaSetupRequired` flag, and the user's `active` status on every request. The bulk endpoints add `requireAdmin` on top. No new session, token, or credential handling is introduced.

One observation worth noting for completeness: `BulkUploadModal` in `frontend/app/documents/page.tsx` calls the upload with raw `fetch(..., { credentials: 'include' })` (`296`) rather than the `apiFetch` wrapper. This still sends the HttpOnly cookie correctly. The session cookie is `SameSite=Strict`, which is the CSRF backstop for this state-changing POST; the JSON-body mutating endpoints (`PATCH`, commit) use `apiFetch`. No CSRF token is used anywhere in the app (the platform relies on `SameSite=Strict`), so this is consistent with the existing design — no new gap is introduced. No finding.

**Recommendation:** No action required.

---

## A08: Software and Data Integrity Failures

**Applicability:** HIGH — files move between staging and the live store, and DB records are materialized transactionally.
**Risk Level:** MEDIUM-HIGH

### Controls Verified (positive)

- **Copy-then-delete rollback is correct.** `materializeBulkItem` copies the staged file to `DOCUMENTS_DIR` *before* the DB transaction (`3779`), runs all inserts inside a single `prisma.$transaction` (`3782`), unlinks the staging copy **only after the transaction commits** (`3834`), and on any failure unlinks the *destination* copy (`3840`) so no orphan survives a failed commit. The staging copy is preserved on failure, so the item can be retried. This is a clean, well-reasoned integrity design.
- **Defensive `path.basename`.** Every disk operation on a stored filename wraps it in `path.basename(...)` (`3659`, `3776`, `4479`, `4499`, `5482`) — even though `staged_file_name` is always a server-generated UUID + allowlisted extension, this is correct defense-in-depth against path traversal.
- **Atomic per-line materialization.** The Document insert, optional Contract/License create, association inserts, audit-log inserts, and the item `COMMITTED` status update are all inside one transaction (`3782–3831`), so a partial materialization cannot occur.

### Finding BULK-A08-1 — HIGH | CVSS:3.1/AV:N/AC:H/PR:H/UI:N/S:U/C:N/I:H/A:L (5.3)  *(cross-listed as BULK-A01-2)*

**Location:** `materializeBulkItem` (`3749–3847`) + commit endpoint (`4529`). Time-of-check/time-of-use double-commit race.

The "already committed" guard is a **read-before-transaction check on a stale row**. The commit endpoint fetches the item (including `status`) at `4531–4536`, then `materializeBulkItem` re-checks `if (item.status === 'COMMITTED')` at `3754` — but `item` is the row object captured *before* the transaction. Inside the transaction, the status flip is an **unconditional** `UPDATE ... SET status='COMMITTED' ... WHERE id=${item.id}::uuid` (`3828`) with **no `AND status != 'COMMITTED'` guard and no `SELECT ... FOR UPDATE` row lock**.

Two concurrent `POST .../items/:id/commit` requests (or a commit racing the batch-commit loop) can therefore both pass the stale pre-check and both run the transaction. The consequence:
- **Two Document rows** are inserted for the same staged file (each gets a fresh `gen_random_uuid()` and a separate copy in `DOCUMENTS_DIR`), with two `CREATE`/`Document` audit records.
- For `target: 'license'` with the same `licenseNumber`, **two License rows** may be created (License uniqueness depends on schema — if `licenseNumber` is not uniquely constrained, duplicates persist).
- For `target: 'contract'`, the unique `contract_number` constraint makes the *second* contract insert fail with P2002 — but only *after* the second Document was already inserted and its staging-to-final copy made; the catch unlinks `finalPath` for the *second* attempt, but the **first transaction's Document is already committed and its staging file already unlinked**, while the second attempt re-copies from a now-deleted `stagedPath` (the `fs.existsSync` check at `3778` may then 400, or — if it copied before the first unlink — leaves an orphaned final-store file). The result is non-deterministic: duplicate documents, orphaned files, or confusing errors.

**Impact:** Integrity — duplicate materialized records and orphaned files in the document store; pollution of the audit trail with duplicate `CREATE` entries; possible orphaned `DOCUMENTS_DIR` files outside any DB reference (these are *not* reaped by the bulk TTL cron, which only touches staging). Exploitation requires an authenticated ADMIN issuing concurrent requests (or a UI double-click / network retry), so `AC:H/PR:H`, but the impact on data integrity is real and the trigger (double-click, retry, the batch-commit loop overlapping a manual commit) is plausible in normal operation.

**Remediation:** Make the status transition the concurrency gate. Either:
1. Add a guard to the update and verify it affected a row:
```ts
const upd = await tx.$executeRaw`
  UPDATE "bulk_import_item" SET status='COMMITTED', committed_document_id=${documentId}::uuid, error_message=NULL, updated_at=now()
  WHERE id=${item.id}::uuid AND status <> 'COMMITTED'`;
if (Number(upd) !== 1) throw new BulkValidationError('El elemento ya fue confirmado');
```
(placing this *before* the file copy / inserts so the row is claimed first), **or**
2. `SELECT ... FOR UPDATE` the item row at the top of the transaction and re-read its status there.

Option 1 with the claim performed first (set an intermediate `COMMITTING` state, or rely on the conditional update returning 0 rows to abort and roll back) is the most robust.

### Finding BULK-A08-2 — MEDIUM | CVSS:3.1/AV:N/AC:L/PR:H/UI:N/S:U/C:L/I:L/A:N (3.5)

**Location:** `materializeBulkItem` (`3773–3779`) — no magic-byte re-validation at materialization.

Magic bytes are validated on upload (`4384–4390`), but **not re-validated when the staged file is materialized into the live document store**. CLAUDE.md's A08 rule reads "File uploads validated by magic bytes + UUID filenames" and the audit brief explicitly asks for "magic bytes on staged upload AND at materialization." Between upload and commit, the file lives on disk in `STAGING_DIR` for up to `BULK_BATCH_TTL_HOURS`. If the staging directory is writable by another process, a container compromise, or a misconfigured shared volume, a staged file could be swapped for malicious content that then gets copied verbatim into `DOCUMENTS_DIR` and indexed/served, with no integrity check at the boundary.

**Impact:** Defense-in-depth gap. The primary upload check stands, so this is not directly exploitable without an additional write-primitive on the staging volume; severity is MEDIUM because it is an explicit deviation from the project's stated integrity control and the time window is long (hours).

**Remediation:** In `materializeBulkItem`, before/after the `fs.copyFileSync`, re-read the first bytes and re-run `validateMagicBytes(buf, ext)` against the staged file; on mismatch, abort with a `BulkValidationError` and do not insert. This makes the integrity guarantee hold at the *trust boundary where the file becomes a real Document*, not only at intake.

### Finding BULK-A08-3 — INFO

`recomputeBatchStatus` (`3618`) and the commit flow correctly wrap `COUNT(*)` results with `Number()` before comparison/JSON, honouring the BigInt rule. The batch/item GET also `Number()`-wraps `totalBytes`/`committed`/`pending` (`4441`, `4464`). No finding.

---

## A09: Security Logging and Monitoring Failures

**Applicability:** MEDIUM — every CI/contract/document/license write must produce an `AuditLog`.
**Risk Level:** LOW

### Controls Verified (positive)

| Event | Location | Audit record |
|-------|----------|--------------|
| Bulk upload (batch created) | `4414–4417` | `action: 'BULK_UPLOAD', entity: 'BulkImportBatch'` + `details` JSONB (`fileCount`, `totalBytes`) |
| Document materialized | `3788` | `action: 'CREATE', entity: 'Document'` |
| Contract materialized | `3805` | `action: 'CREATE', entity: 'Contract'` |
| License materialized | `3819` | `action: 'CREATE', entity: 'License'` |
| Discard single item | `4482` | `action: 'BULK_DISCARD_ITEM', entity: 'BulkImportItem'` |
| Discard whole batch | `4503` | `action: 'BULK_DISCARD_BATCH', entity: 'BulkImportBatch'` |

All audit inserts are parameterized and go to the insert-only `audit_logs` table — no UI path updates/deletes them, consistent with the ISO 27001 A.8.15 immutability rule. The materialization audit records are inside the same transaction as the entity creation, so they cannot be lost if the commit succeeds.

### Finding BULK-A09-1 — LOW

There is **no explicit `BULK_COMMIT` audit record** for the commit *action* itself. The materialized entities do get `CREATE` audit rows, which is the substantive requirement, but a forensic reviewer cannot distinguish a Document/Contract created via bulk import from one created via the normal single-upload flow, nor correlate which batch/item produced it. Additionally, the `PATCH .../items/:id` decision-edit endpoint (`4509`) writes the user's reviewed decision to `analysis.decision` **without any audit record** — so the chain of *who edited the AI suggestion to what* before commit is not captured.

The associations created during materialization (`document_contracts`, `document_licenses`, `document_cis`, and the contract/license↔CI `connect`) also do not emit per-association audit rows, though the parent `CREATE` records exist. Given the platform rule "every write to a CI/relation/contract/document must insert an AuditLog," the association joins are arguably a minor gap, but the parent-entity `CREATE` records provide reasonable coverage.

**Impact:** Compliance/forensics gap (ISO 27001 A.8.15, NIS2 Art.21). Not exploitable; reduces traceability.

**Remediation:**
- Add a `BULK_COMMIT` audit row (entity `BulkImportItem`, `entity_id` = item id, `details` = `{ batchId, documentId, target, contractId?, licenseId? }`) inside the materialization transaction.
- Optionally add a `BULK_REVIEW_EDIT` row on PATCH (low priority — staging metadata only).

### Finding BULK-A09-2 — LOW

**Location:** worker error-mark (`3680–3683`) and `error_message` surfaced via `GET .../batches/:id` (`4458`) to the review UI.

The worker stores `String(e).slice(0, 500)` of the parse/analysis exception into `error_message`, which is returned verbatim to the admin review screen. For a document-parse failure this can include internal file-system paths (e.g. `/app/documents/_staging/<uuid>.pdf`) or library stack fragments. CLAUDE.md requires "never expose stack traces / Prisma errors; generic messages + internal logging." The exposure is ADMIN-only (the only role that can read it), so the blast radius is limited, but it deviates from the stated control.

**Impact:** Low — internal path/diagnostic disclosure to an already-privileged admin.

**Remediation:** Store a generic, user-facing message (e.g. `'No se pudo analizar el documento'`) in `error_message`, and log the full `e` only to the server console (which the worker already does at `3679`). Keep a coarse machine-readable error category if the UI needs to branch.

---

## A10: Server-Side Request Forgery (SSRF)

**Applicability:** MEDIUM — the feature makes outbound HTTP calls to Ollama.
**Risk Level:** NONE

### Controls Verified (positive)

- **The Ollama base URL is environment-only and allowlisted.** `OLLAMA_BASE_URL` is read solely from `process.env` (`ragService.ts:70`) and validated at **module load** by `validateOllamaUrl` against `ALLOWED_OLLAMA_PATTERN` (`83–95`), which restricts to `http(s)://(localhost|ollama|cmdb-ollama|127.0.0.1)(:port)`. There is **no code path** by which a caller-supplied URL, the uploaded filename, the document content, or the AI output influences the outbound request target — `analyzeDocumentForImport` always fetches `${OLLAMA_BASE_URL}/api/chat` (`550`) with a fixed path.
- The document text is sent as the *body* of the request, never as a URL component, so document-controlled SSRF is structurally impossible.
- The outbound call has a timeout (`CHAT_TIMEOUT_MS`) and a token cap, bounding resource use.

**Recommendation:** No action required. This is a textbook-correct anti-SSRF implementation.

---

## Summary Risk Matrix

| OWASP Category | Risk | Key Finding |
|----------------|------|-------------|
| A01: Broken Access Control | LOW | All endpoints `requireAdmin`; ownership enforced at SQL layer. (Double-commit cross-listed as A08.) |
| A02: Cryptographic Failures | NONE | No new secrets; UUID staged filenames. |
| A03: Injection | LOW | Tagged-template SQL throughout; LIKE escaped; AI output strictly validated and never reaches SQL. |
| A04: Insecure Design | MEDIUM | No per-admin batch cap → disk/queue DoS (BULK-A04-1); TTL cron discards reviewed batches (BULK-A04-2). |
| A05: Security Misconfiguration | LOW | Tight extension allowlist; env-driven config; no CSP/helmet change. |
| A06: Vulnerable Components | NONE | No new dependencies. |
| A07: Auth & Session | NONE | Reuses existing JWT/`requireAdmin`; SameSite=Strict CSRF backstop. |
| A08: Software & Data Integrity | MEDIUM-HIGH | **Double-commit TOCTOU race (BULK-A08-1, HIGH)**; no magic-byte re-check at materialization (BULK-A08-2, MEDIUM); copy-then-delete rollback is otherwise correct. |
| A09: Logging & Monitoring | LOW | Upload/discard/CREATE audited; no `BULK_COMMIT` row; internal error text surfaced to admin UI. |
| A10: SSRF | NONE | Ollama URL env-only + allowlist; no caller-influenced outbound target. |

---

## Conclusion

The Bulk Document Import feature demonstrates a strong baseline security posture. The dangerous trust boundaries — authorization, SQL injection, the AI-output → persistence pipeline, file-path traversal, and SSRF — are all handled correctly and in line with the project's non-negotiable rules. The transactional materialization with copy-then-delete rollback is a particularly good piece of integrity engineering.

The one finding that should block production is the **double-commit TOCTOU race (BULK-A08-1)**: because the `status='COMMITTED'` flip is unconditional and the pre-check reads a pre-transaction snapshot, concurrent or retried commits can duplicate Documents/Licenses and orphan files in the live store. The fix is a one-line conditional `UPDATE` (or a `FOR UPDATE` lock) and is low-effort.

The two MEDIUM items — no per-admin batch cap (availability/DoS) and no magic-byte re-check at the materialization boundary (integrity defense-in-depth) — should be addressed before the feature is exposed to high-volume use. The LOW/INFO items (commit/edit audit coverage, internal error text in the UI, TTL reaping of reviewed batches, and AI-budget tuning) are hardening and compliance-completeness improvements.

### Compliance Impact

- **ISO 27001:2022 A.8.15 (Logging):** Substantially met (upload, discard, and entity CREATE audited); close the `BULK_COMMIT`/PATCH gap (BULK-A09-1) for full coverage.
- **ISO 22301:2019 / NIS2 (Availability):** Address BULK-A04-1 (unbounded batch creation) and BULK-A04-2 (reviewed-batch reaping) to honour bounded-resource and recovery expectations.
- **OWASP A08:** Address BULK-A08-1 and BULK-A08-2 to satisfy the "magic bytes at materialization" and transactional-integrity criteria.

---

## Recommended Remediation Backlog

| Priority | Finding | Action | Effort |
|----------|---------|--------|--------|
| HIGH | BULK-A08-1 | Add `AND status <> 'COMMITTED'` guard (claim row first) or `SELECT … FOR UPDATE` in `materializeBulkItem`; abort if 0 rows claimed | Low (30 min) |
| MEDIUM | BULK-A08-2 | Re-run `validateMagicBytes` on the staged file at materialization before copy; abort on mismatch | Low (30 min) |
| MEDIUM | BULK-A04-1 | Cap concurrent open batches per `created_by` (429 over ceiling); consider rate-limit + staging-dir watermark | Low (1 h) |
| LOW | BULK-A04-2 | Exclude `READY`/`PARTIALLY_COMMITTED` from the TTL reaper, or key it off `updated_at` and bump on review | Low (45 min) |
| LOW | BULK-A09-1 | Emit `BULK_COMMIT` audit row in the materialization transaction; optionally audit PATCH edits | Low (45 min) |
| LOW | BULK-A09-2 | Store generic `error_message`; log full exception server-side only | Low (15 min) |
| INFO | BULK-A01-1 | Decide on cross-admin batch visibility for operational continuity | Design decision |

---

*Audit completed: 2026-05-29. Scope limited to the Bulk Document Import feature and its directly supporting code paths. For the full platform OWASP assessment, see `docs/security-audit/owasp-top10.md`.*

# OWASP Top 10 (2021) Security Audit — OCR as Reached from Bulk Document Import

**Audit ID:** OWASP-BULK-OCR-001
**Audit date:** 2026-05-29
**Auditor:** Independent security review
**Classification:** CONFIDENTIAL — Internal security audit record
**Platform version:** v2.3.x (`feature/bulk-document-import`)

## Scope

This audit covers the **OCR fallback as it is now reachable from the Bulk Document Import pipeline**, plus two robustness fixes shipped alongside it. It deliberately does **not** re-audit the standalone OCR feature in the single-document upload + `processRagQueue` path — that is covered by `owasp-ocr.md` (OWASP-OCR, v2.3.2, 2026-05-28). Where this report's conclusions differ from that earlier one, it says so explicitly (see A03-1).

**Code under review:**
- `backend/src/services/docParser.ts` — `parsePdfWithOcr` (`97–151`), `parsePdf` OCR-fallback branch (`164–170`), OCR constants (`42–47`), `parseDocument` PDF timeout handling (`377–392`).
- `backend/src/index.ts` — `processBulkImportQueue` staged-path construction + `parseDocument` call (`3641–3695`, esp. `3659–3660`), `STAGING_DIR` (`3122`), the AI-budget / queue scheduling (`3128`, `5504–5515`), and the hourly `cleanupBulkBatches` cron with the `make_interval(...::int)` fix (`5481–5501`).
- `backend/src/services/ragService.ts` — `analyzeDocumentForImport` + the `ANALYSIS_MAX_CHARS` 12000→6000 reduction (`489–590`, esp. `495`, `522–523`).
- `backend/Dockerfile` (OCR system packages, `37–48`) and `backend/package.json` / `package-lock.json` (`node-tesseract-ocr` `2.2.1`).

**What is in scope that the prior OCR audit was not:** the bulk path runs OCR on **PENDING_ANALYSIS** items where the file was staged with a server-generated UUID name (`crypto.randomUUID()` + extension) under `STAGING_DIR`, then read back as `path.join(STAGING_DIR, path.basename(item.staged_file_name))`. The provenance of the path fed to `pdftoppm` is therefore the central A08 question, and the per-document resource bounds (page count, CPU, temp disk) are the central A04 question.

## Methodology

Read every line of `parsePdfWithOcr`, `parseDocument`, the bulk worker, the upload endpoint that creates staged files, and the cleanup cron. Traced the exact value that flows into each subprocess argument. Read the actual source of `node-tesseract-ocr@2.2.1` inside `node_modules` (not just its docs) to verify how it invokes the `tesseract` binary. Cross-checked every claim against the project's hard rules in `CLAUDE.md` (execFile-only, allowlisted base dirs, `path.basename` guard, no unbounded resource consumption, no internals in API responses). Confirmed git provenance of the three changes (`0d463ab` OCR fallback, `041b13d` analysis-cap, `79d9875` `::int` cast).

## Findings by Severity

| Severity | Count | IDs |
|----------|-------|-----|
| CRITICAL | 0 | — |
| HIGH     | 1 | BULK-OCR-A03-1 (third-party OCR lib shells out via `exec`, contradicting the execFile-only rule and the prior audit's claim) |
| MEDIUM   | 2 | BULK-OCR-A04-1 (parse "timeout" does not kill `pdftoppm`/`tesseract` — CPU/disk uncapped); BULK-OCR-A04-2 (no page-count cap before rasterisation; tmpfs exhaustion) |
| LOW      | 3 | BULK-OCR-A03-2 (`OCR_DPI`/`OCR_LANGUAGES` unvalidated env into argv); BULK-OCR-A09-1 (OCR activation/failure not in AuditLog); BULK-OCR-A05-1 (Alpine OCR packages unpinned) |
| INFO     | 4 | A01, A06, A10 controls verified; analysis-cap & `::int` fixes reviewed clean |

**Overall verdict: SOLID design, one HIGH to fix.** Access control, path provenance, SSRF surface and the AI-output trust boundary are all correctly handled. The HIGH is a supply-chain/coding-standard violation (the OCR npm wrapper uses a shell), currently **not exploitable** because no attacker-influenced string reaches the shell command — but it is a latent command-injection primitive and a direct breach of the CLAUDE.md "execFile, never exec" rule, so it is rated on the standard rather than on today's reachability. The two MEDIUMs are real availability gaps that the bulk path makes materially more likely than the single-upload path (admins routinely bulk-upload many scans at once).

---

## A01: Broken Access Control

**Risk Level:** LOW (controls verified).

### Controls Verified

- The only way to create a `bulk_import_item` with status `PENDING_ANALYSIS` is `POST /api/documents/bulk/batches`, gated by `authenticateToken, requireAdmin, bulkUploadMiddleware` (`index.ts:4382`). OCR is therefore reachable only behind an ADMIN session.
- `processBulkImportQueue` (`3641`) is an internal node-cron task chained after `processRagQueue` (`5509`); it is not an HTTP endpoint and accepts no caller input. It selects rows strictly by `WHERE status='PENDING_ANALYSIS'` (`3648`) — there is no API surface that hands a file path to OCR.
- The file path fed to `parseDocument` is `path.join(STAGING_DIR, path.basename(item.staged_file_name))` (`3659`). `STAGING_DIR` is operator-controlled env (`3122`); `staged_file_name` is written only at upload as `${crypto.randomUUID()}.${ext}` (`4416`). The `path.basename(...)` guard neutralises any `../` even if a row were tampered with directly in the DB.

### Finding BULK-OCR-A01-1 — INFO

The `path.basename` guard on `staged_file_name` is correct defence-in-depth, but the **extension** segment of the staged name is derived from the user-supplied `originalname` (`path.extname(f.originalname)`, `4415`). It is constrained by `ALLOWED_EXTENSIONS` (multer `fileFilter`, `4048`) and by magic-byte validation (`4396`), so it cannot smuggle a path separator or shell metacharacter into the staged filename in any reachable way. No action required; noted because the extension is the one part of the staged name that originates from the client.

---

## A02: Cryptographic Failures

**Risk Level:** LOW (controls verified).

### Controls Verified

- Rasterised PNGs are written into a per-document `fs.mkdtempSync(path.join(os.tmpdir(), 'cmdb-ocr-'))` directory (`docParser.ts:104`) and removed in a `finally` block via `fs.rmSync(tmpDir, { recursive: true, force: true })` (`149`) on every path — success, `pdftoppm`/`tesseract` throw, or the outer `Promise.race` rejection. No OCR-extracted text is logged; only page counts, the UUID `label`, DPI and language are (`122`, `144`).
- The `label` in all log lines is `path.basename(filePath)` = the UUID staged name, **not** the user's `original_name`. The user's original filename is sent to the AI as metadata (`analyzeDocumentForImport(... { fileName: item.original_name })`, `3668`) but never written to OCR logs, so no PII leaks via the OCR log path.

### Finding BULK-OCR-A02-1 — LOW (carried from owasp-ocr A02-2)

`fs.mkdtempSync` relies on the default `0700` mode rather than setting it explicitly. Identical to the single-upload path and already documented as OCR-A02-2; not re-scored here. Same remediation: `fs.chmodSync(tmpDir, 0o700)` after creation, or pass `{ mode: 0o700 }`.

---

## A03: Injection

**Risk Level:** HIGH (one HIGH, one LOW).

### Controls Verified

- `parsePdfWithOcr` rasterises with `execFileAsync('pdftoppm', ['-r', OCR_DPI, '-png', filePath, prefix])` (`docParser.ts:110`) — `execFile`, array argv, **no shell**, satisfying the CLAUDE.md rule for the poppler call. `OCR_DPI`, `filePath` and `prefix` are all server-controlled (env / mkdtemp / UUID), so even though they are not validated they cannot be attacker-influenced through the bulk path.
- The `text` extracted by OCR is fed to `analyzeDocumentForImport`, which strips control characters, caps length, wraps the text in `<DOCUMENT>…</DOCUMENT>`, and uses an explicit anti-prompt-injection system prompt (REGLA 4) with `format: 'json'` and `temperature: 0` (`ragService.ts:522–549`). The model output is never used to build SQL — it is validated downstream by a Zod schema at commit time (per `owasp-bulk-import.md` A03). The OCR-as-text → LLM trust boundary is intact.

### Finding BULK-OCR-A03-1 — HIGH | CVSS 6.7 (CVSS:3.1/AV:L/AC:L/PR:H/UI:N/S:U/C:H/I:H/A:H)

**Location:** `node-tesseract-ocr@2.2.1` invoked at `docParser.ts:127` (`tesseract.recognize(pngs[i], { lang: OCR_LANGUAGES, oem: '1', psm: '3' })`).

**Description:** Reading the library's actual source (`node_modules/node-tesseract-ocr/src/index.js`), `recognize` does **not** use `execFile`. It builds a single string command and runs it through a **shell**:

```js
const exec = require("child_process").exec
...
const inputOption = isSingleLocalFile ? `"${input}"` : "stdin"
const command = [binary, inputOption, "stdout", ...options].join(" ")
const child = exec(command, ...)        // ← shell, string concatenation
```

`getOptions` interpolates config values raw: `lang` becomes `` `-l ${value}` ``, and `psm`/`oem`/`dpi` become `` `--${key} ${value}` `` — all concatenated into the shell string. This is a textbook command-injection primitive and a **direct violation of the CLAUDE.md hard rule "external command execution must use `execFile`, never `exec` (no shell)."**

It also **contradicts the prior OCR audit** (`owasp-ocr.md`, finding A03 / A03-2), which asserts the library "constructs its own `execFile` call internally" and that "execFile prevents shell injection at the OS level." That claim is factually incorrect for version 2.2.1; the wrapper uses `child_process.exec`. This audit corrects the record.

**Impact / current reachability:** In the bulk path the two values reaching the shell are:
- the image path `pngs[i]` = `path.join(tmpDir, f)` — `tmpDir` is from `mkdtempSync` (random, server-controlled, no metacharacters) and `f` matches pdftoppm's `p-NN.png` output pattern. The library wraps it in double quotes. Not attacker-influenced. **Not exploitable today.**
- `lang` = `OCR_LANGUAGES`, an **environment variable** (`docParser.ts:43`). Not document-content-derived and not user-supplied at runtime. So today the only way to inject is to control the deployment environment (compromised CI/`.env`/secret), at which point the attacker already has the container.

The reason this is rated **HIGH rather than Info** despite no current attacker-controlled input: (a) it is an outright breach of a non-negotiable project rule, (b) it is a live shell primitive sitting one careless change away from exploitability (e.g. a future feature that lets an admin pick OCR language per-batch, or routes any document-derived hint into a tesseract config option, would become RCE), and (c) the prior audit explicitly relied on the false premise that this path is execFile-safe, so the gap is currently *undocumented and trusted*.

**Remediation (pick one):**
1. **Preferred — drop the wrapper.** Replace the `node-tesseract-ocr` call with a direct `execFileAsync('tesseract', [pngPath, 'stdout', '-l', OCR_LANGUAGES, '--oem', '1', '--psm', '3'])`. This removes the shell entirely, removes a dependency, and brings the call in line with the `pdftoppm` call right above it. Tesseract writes recognised text to stdout when the output base is `stdout`.
2. If the wrapper must stay, hard-validate `OCR_LANGUAGES` against `^[a-z]{2,4}(\+[a-z]{2,4})*$` at module load (see A03-2) so no whitespace/metacharacter can reach the shell, and add a regression test asserting the spawned command contains no shell metacharacters. This narrows but does not eliminate the standards violation.

### Finding BULK-OCR-A03-2 — LOW | CVSS 3.1 (CVSS:3.1/AV:L/AC:H/PR:H/UI:N/S:U/C:N/I:L/A:L)

**Location:** `docParser.ts:43–44` (`OCR_LANGUAGES`, `OCR_DPI` read from env without validation), used at `110` and `127`.

**Description:** Neither env value is range-checked or pattern-checked. For the `pdftoppm` `-r` argument this is execFile-safe but allows `OCR_DPI=999999` to drive pages to absurd resolutions (multiplying the A04 disk/CPU problem). For `OCR_LANGUAGES`, given A03-1 the value lands in a shell string — making validation here also part of the A03-1 mitigation, not merely a quality issue. This finding is carried from owasp-ocr A03-1/A03-2 and re-flagged because in the bulk path the resource-amplification angle (A04) is more acute.

**Remediation:** Clamp DPI to 72–600 and validate `OCR_LANGUAGES` against the language-code regex above, both at module load, falling back to the safe defaults on invalid input.

---

## A04: Insecure Design (Resource Exhaustion / Availability)

**Risk Level:** MEDIUM (two findings). This is the category where the *bulk* path is materially riskier than the single-upload path the prior audit covered.

### Controls Verified

- A whole-document timeout of `Math.max(MAX_PARSE_TIME_MS, MAX_OCR_TIME_MS)` (default `max(60s,180s)=180s`) wraps `parseWork()` via `Promise.race` (`docParser.ts:378–385`).
- `MAX_FILE_BYTES = 100 MB` in docParser (`37`) and multer's per-file `MAX_FILE_SIZE` (50 MB default) + `BULK_MAX_TOTAL_BYTES` (200 MB/batch) + `BULK_MAX_FILES` (20) cap upload volume (`index.ts:3117`, `3123–3124`, `4046`).
- `BULK_ANALYZE_BUDGET = 2` items per 30-second cron tick (`3128`, `3650`) limits how many documents OCR concurrently with the shared Ollama/CPU.

### Finding BULK-OCR-A04-1 — MEDIUM | CVSS 6.5 (CVSS:3.1/AV:N/AC:L/PR:H/UI:N/S:U/C:N/I:N/A:H)

**Location:** `docParser.ts:382–392` (the `Promise.race` timeout) vs. `110` / `127` (the unkilled subprocesses).

**Description:** The "timeout" does not bound CPU or disk — it only abandons the JS promise. `execFileAsync('pdftoppm', …)` is called with **no `timeout` and no `killSignal` option** (`110`), and `node-tesseract-ocr`'s `recognize` accepts no abort signal either. When `Promise.race` rejects after 180 s, `parseDocument` returns and the worker moves on, **but the `pdftoppm` and `tesseract` child processes keep running to completion**, continuing to burn CPU and write PNGs/scratch data. Worse, when the race rejects, control never returns to `parsePdfWithOcr`'s `finally`, so its `fs.rmSync(tmpDir)` only fires once the underlying promise eventually settles — which for a runaway rasterisation can be long after the "timeout." During that window the abandoned job's temp dir is **not** cleaned, and the next cron tick can launch up to `BULK_ANALYZE_BUDGET` more such jobs. A handful of large scanned PDFs uploaded in one batch can thus pin the single backend CPU and accumulate temp data well past the nominal 180 s cap — degrading or stalling the whole backend (and the shared RAG/Ollama queue) for all users. The trigger requires an authenticated ADMIN (or compromised admin creds / malicious insider), which is why it is MEDIUM rather than HIGH.

**Remediation:**
1. Pass a real subprocess timeout so the OS kills the child: `execFileAsync('pdftoppm', [...], { timeout: MAX_OCR_TIME_MS, killSignal: 'SIGKILL' })`.
2. Replace `node-tesseract-ocr` with a direct `execFileAsync('tesseract', [...], { timeout: perPageMs, killSignal: 'SIGKILL' })` (also closes A03-1) and wrap each page in its own per-page budget so one stuck page cannot consume the whole window.
3. Because the `finally` cleanup is tied to the underlying (not the race) promise, ensure cleanup also runs on the abandon path — e.g. drive the whole OCR step off an `AbortController` whose `abort()` both kills the children and triggers cleanup.

### Finding BULK-OCR-A04-2 — MEDIUM | CVSS 6.5 (CVSS:3.1/AV:N/AC:L/PR:H/UI:N/S:U/C:N/I:N/A:H)

**Location:** `docParser.ts:107–120` (no page-count check before `pdftoppm`).

**Description:** Before rasterising, the code does not consult `pdf-parse`'s `numpages` to bound work. A 50 MB scanned PDF can hold many hundreds of pages; `pdftoppm -r 300` renders **all** of them up-front, each full-page 300-DPI PNG being roughly 2–8 MB, so a single document can generate gigabytes under `os.tmpdir()`. In production `/tmp` is `tmpfs` (RAM-backed), default-capped at half host RAM with no explicit `size=` in `docker-compose.prod.yml`. Combined with A04-1 (the subprocess is not killed at timeout) and a 20-file batch, this is a realistic path to exhausting container memory → OOM-kill of the backend → DoS for all CMDB users. This is the same architectural gap as owasp-ocr A04-1, but the bulk path raises the *likelihood* sharply: bulk import is explicitly designed for admins to drop many scanned PDFs at once.

**Remediation:**
1. In `parsePdf`, before falling back to OCR, check `data.numpages` against `OCR_MAX_PAGES` (env, default ~100) and skip (return `[]`, mark item reviewable) when exceeded.
2. Set an explicit `tmpfs: - /tmp:size=512m` (or a value sized for `MAX_FILE_BYTES` × expected concurrency) on the backend service in `docker-compose.prod.yml`, so a runaway rasterisation fails the single job instead of the container.

---

## A05: Security Misconfiguration

**Risk Level:** LOW.

### Controls Verified

- OCR system packages are installed at build time (`Dockerfile:37–48`); Tesseract uses pre-baked tessdata and never downloads at runtime. Container runs as non-root `node` (uid 1000).
- `OCR_ENABLED` defaults true unless explicitly `'false'` (`docParser.ts:45`); defaults for DPI/lang/timeout are operationally safe.

### Finding BULK-OCR-A05-1 — LOW (carried from owasp-ocr A05-2)

`tesseract-ocr`, `tesseract-ocr-data-*` and `poppler-utils` are installed via `apk add --no-cache` with no version pin (`Dockerfile:37–48`); each rebuild silently adopts whatever Alpine ships. No new issue introduced by the bulk change, but the bulk path increases how much these binaries are exercised. Remediation unchanged: pin versions or add Trivy/Grype image scanning in CI.

---

## A06: Vulnerable & Outdated Components

**Risk Level:** LOW (one HIGH coding-standard issue is cross-listed at A03-1; the package itself has no public CVE).

### Components Audited

| Component | Version (lockfile / image) | Note |
|-----------|----------------------------|------|
| `node-tesseract-ocr` (npm) | `2.2.1` (package-lock.json) | **Uses `child_process.exec` (shell)** — see BULK-OCR-A03-1 |
| `pdf-parse` (npm) | `1.1.x` | unchanged from prior audit |
| `tesseract-ocr` / `poppler-utils` (Alpine) | rolling, unpinned | see A05-1 |

### Finding BULK-OCR-A06-1 — INFO

`node-tesseract-ocr@2.2.1` has no published CVE as of the audit date, but is effectively **unmaintained** and ships the shell-based invocation documented in A03-1. Treat its presence as a supply-chain liability and prefer a direct `execFile('tesseract', …)` (remediation A03-1 option 1), which removes the dependency entirely. Add `npm audit` to CI.

---

## A07: Authentication & Session Failures

**Risk Level:** LOW (controls verified). The OCR fallback is reachable only after `authenticateToken + requireAdmin` on `POST /api/documents/bulk/batches`, and otherwise only from the internal cron. No external trigger exists. No findings beyond those already in `owasp-bulk-import.md` A07. The `apiLimiter` and the per-batch caps (count/size) bound how fast an authenticated admin can enqueue OCR work.

---

## A08: Software & Data Integrity

**Risk Level:** LOW (controls verified).

### Controls Verified

- Magic bytes are validated for **every** file before anything is written to disk (`index.ts:4393–4400`, `validateMagicBytes` `3154`). A renamed binary with a `.pdf` extension is rejected with 400 before staging, so it never reaches `pdftoppm`.
- The path passed to OCR (`3659`) derives solely from a `crypto.randomUUID()` staged name re-wrapped in `path.basename` — see A01. The user's `original_name` is metadata only and never used in a filesystem op in the OCR path.
- The OCR result is plain text routed through the validated AI extraction + Zod-at-commit boundary (A03 controls); a scanned PDF cannot inject structured data that bypasses commit-time foreign-key re-validation.

### Finding BULK-OCR-A08-1 — INFO

`MAGIC_BYTES` for `txt`/`csv` is an empty array → accept-on-extension (`3157`). Those types never reach `pdftoppm`/`tesseract` (only `application/pdf` triggers OCR, `docParser.ts:348`), so this is not an OCR-path integrity issue; it is the same general upload observation already logged as owasp-ocr A08-1. No OCR-specific action.

---

## A09: Security Logging & Monitoring

**Risk Level:** LOW (one LOW).

### Controls Verified

- The upload that creates the batch writes a `BULK_UPLOAD` AuditLog row with the admin email and file counts (`index.ts:4424–4427`). Per-item analysis failures are persisted to `bulk_import_item.error_message` (truncated to 500 chars, `3680–3684`), giving a queryable per-item error trail. Item discard / batch discard emit `BULK_DISCARD_ITEM` audit rows (`4492`).

### Finding BULK-OCR-A09-1 — LOW (carried from owasp-ocr A09-1; re-scoped to bulk)

When a bulk item's PDF takes the OCR fallback, no AuditLog row records that OCR ran, how many pages, or whether it failed — `processBulkImportQueue` only flips the item to `ANALYZED`/`ERROR` and writes `error_message`. There is no `OCR_INVOKED`/`OCR_FAILED` audit event. For NIS2 Art.23 / ISO 27001 A.8.15, an auditor reviewing a sensitive bulk-imported scan cannot confirm from the audit trail whether its content was OCR-extracted (and thus indexed) or silently failed. Remediation: insert an `OCR_INVOKED` (and `OCR_FAILED` on the catch path) AuditLog row from `processBulkImportQueue` with `{pages, dpi, lang}` details and `user_email='system'`, mirroring `INDEX_DOC`.

---

## A10: Server-Side Request Forgery (SSRF)

**Risk Level:** N/A (controls verified). The OCR step makes no outbound network calls: `pdftoppm` and `tesseract` are local binaries operating on local files; tessdata is baked into the image. The only network call in the bulk pipeline is `analyzeDocumentForImport` → Ollama, whose base URL is taken from env and validated against an internal-host allowlist at module load (per `owasp-bulk-import.md` A10), with no user-supplied URL. No findings.

---

## Sanity Check — the two robustness fixes

**Analysis-cap 12000 → 6000 (`ragService.ts:495`, commit `041b13d`).** Reviewed clean. The value only bounds how much OCR/extracted text is sent to the metadata-extraction LLM; it does not gate any security control. The text is still control-char-stripped (`522`), still wrapped in `<DOCUMENT>` with the anti-injection system prompt (`533–535`), and still validated by Zod at commit time. A smaller excerpt is, if anything, marginally safer (less attacker-controlled text reaching the model) and is overridable via `BULK_ANALYSIS_MAX_CHARS`. **No new issue.** Minor functional note (not a security finding): for documents whose metadata lives past the first 6000 chars, extraction quality drops — but the human-review step before materialization is the compensating control, so confidentiality/integrity are unaffected.

**`make_interval(hours => ${BULK_BATCH_TTL_HOURS}::int)` (`index.ts:5485`, commit `79d9875`).** Reviewed clean and is a genuine fix: Prisma binds the JS number as `bigint`, and `make_interval(hours => bigint)` has no matching signature (Postgres 42883), so the prior code threw every hour and the staging TTL cleanup never ran — meaning staged files (and the OCR DoS surface in A04) could accumulate indefinitely. The `::int` cast resolves the overload. `BULK_BATCH_TTL_HOURS` is `parseInt`-parsed from env (`3125`) and bound as a parameter (not concatenated), so the cast introduces no injection risk and correctly restores the only bound on staging-area growth. **Net security improvement.** (One adjacent note already captured in `owasp-bulk-import.md`: the cron silently discards partially-reviewed batches at TTL — out of scope here.)

---

## Remediation Backlog (priority order)

| Priority | ID | Action |
|----------|-----|--------|
| P1 (HIGH) | BULK-OCR-A03-1 | Replace `node-tesseract-ocr` with a direct `execFileAsync('tesseract', [...])` (no shell); removes the command-injection primitive, the dependency, and corrects the false "execFile-safe" assumption in `owasp-ocr.md`. |
| P2 (MED) | BULK-OCR-A04-1 | Pass `{ timeout, killSignal: 'SIGKILL' }` to the OCR subprocess(es) and drive cleanup off an AbortController so the parse timeout actually terminates `pdftoppm`/`tesseract` and frees temp disk. |
| P2 (MED) | BULK-OCR-A04-2 | Add `OCR_MAX_PAGES` page-count cap before rasterising; set explicit `tmpfs: /tmp:size=…` on the backend in `docker-compose.prod.yml`. |
| P3 (LOW) | BULK-OCR-A03-2 | Validate/clamp `OCR_DPI` (72–600) and `OCR_LANGUAGES` (`^[a-z]{2,4}(\+[a-z]{2,4})*$`) at module load (also part of A03-1 mitigation). |
| P3 (LOW) | BULK-OCR-A09-1 | Emit `OCR_INVOKED` / `OCR_FAILED` AuditLog rows from `processBulkImportQueue`. |
| P4 (LOW) | BULK-OCR-A05-1 | Pin Alpine OCR packages or add Trivy/Grype image scanning in CI. |

*End of report. All 10 OWASP Top 10 (2021) categories assessed for the OCR-as-reached-from-bulk-import surface and the two accompanying robustness fixes. Standalone single-upload OCR is covered separately in `owasp-ocr.md`.*

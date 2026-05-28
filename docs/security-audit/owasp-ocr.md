# OWASP Top 10 (2021) Security Audit — OCR Feature (v2.3.2)

**Audit date:** 2026-05-28
**Auditor:** Independent automated security review
**Scope:** OCR fallback pipeline — `backend/src/services/docParser.ts` (`parsePdfWithOcr`), document upload endpoint (`POST /api/documents/:id/versions`), RAG queue worker (`processRagQueue`), Dockerfile OCR packages

---

## Executive Summary

The OCR feature adds Tesseract-based text extraction for scanned PDFs as an async fallback within the RAG indexing pipeline. The overall security posture is strong: `execFile` (array args, no shell) is used consistently for both `pdftoppm` and the Tesseract wrapper, the upload-to-OCR call chain is fully gated behind `authenticateToken` + `requireAdmin`, temporary PNG files are cleaned up in a `finally` block, and file paths fed into OCR are always internal UUID-based names constructed with `path.join(DOCUMENTS_DIR, ...)` from the database — never from user input. Two medium-severity findings require attention: (1) `OCR_DPI` and `OCR_LANGUAGES` are read from environment variables without input validation, allowing misconfiguration to cause resource exhaustion or Tesseract to silently fail; (2) there is no per-document page count cap before rasterisation, meaning a large scanned PDF can exhaust the container's `tmpfs` `/tmp` mount during the pdftoppm phase. No critical or high-severity findings were identified.

---

## Summary Table

| # | Category | Risk Level | Key Findings |
|---|----------|------------|--------------|
| A01 | Broken Access Control | **Low** | OCR reachable only through admin-authenticated upload; file paths are DB-internal UUIDs |
| A02 | Cryptographic Failures | **Low** | Logs emit UUID filenames (not content); temp PNGs in tmpfs; no PII exposure through error paths |
| A03 | Injection | **Medium** | `OCR_DPI` passed unsanitized to `pdftoppm` via `execFile` array; no shell risk but numeric validation absent; `OCR_LANGUAGES` unvalidated lang-code injection into Tesseract config |
| A04 | Insecure Design | **Medium** | No per-document page count limit before rasterisation; large scanned PDFs can exhaust tmpfs; timeout is global (entire document), not per-page |
| A05 | Security Misconfiguration | **Low** | `OCR_DPI` defaults safe (300); no tessdata external download at runtime; OCR vars absent from `.env.example` documentation |
| A06 | Vulnerable Components | **Info** | `node-tesseract-ocr` 2.2.1 and `pdf-parse` 1.1.4 have no known exploitable CVEs at audit date; system packages installed via Alpine apk with no pinned versions |
| A07 | Auth & Session Failures | **Info** | OCR triggered only from authenticated + admin-only upload flow and internal cron; no external OCR trigger surface |
| A08 | Software & Data Integrity | **Low** | Magic bytes validation applied before file is saved to disk; file path derives exclusively from `crypto.randomUUID()`; no user influence on path passed to OCR |
| A09 | Logging & Monitoring | **Medium** | No audit log entry for OCR activation; INDEX_DOC audit row covers post-OCR indexing but OCR-specific failures are console-only |
| A10 | SSRF | **Info** | OCR pipeline makes no outbound network calls; Tesseract uses local tessdata only; no external URL accepted in the OCR code path |

---

## A01: Broken Access Control

**Description:** Controls that restrict what authenticated users can see or do are missing or insufficient.

### Controls Implemented

- Both document upload endpoints (`POST /api/documents` and `POST /api/documents/:id/versions`) apply the `authenticateToken` middleware followed immediately by `requireAdmin` before multer processes the file (`index.ts:3812`, `index.ts:4151`). A VIEWER or AUDITOR cannot submit a file upload request that will be accepted.
- The RAG queue worker `processRagQueue` runs as an internal cron job (every 30 seconds, `index.ts:4833`). It is not exposed as an API endpoint and cannot be triggered directly by any authenticated or unauthenticated user. There is no API surface that accepts a raw file path for OCR.
- File paths passed to `parseDocument` (and ultimately `parsePdfWithOcr`) are constructed exclusively as `path.join(DOCUMENTS_DIR, doc.file_name)` where `doc.file_name` is read from the database (`index.ts:3260`). The `file_name` column is always written as `${crypto.randomUUID()}.${ext}` at upload time (`index.ts:3832`, `4175`) — never populated from user-supplied input after that point.
- `DOCUMENTS_DIR` itself is set via the `DOCUMENTS_DIR` environment variable (defaulting to `/app/documents`), which is operator-controlled and not user-controllable.

### Findings

**Finding A01-1 — Low | No CVSS score applicable (defence-in-depth)**

Although `path.join(DOCUMENTS_DIR, doc.file_name)` is safe in the current implementation because `file_name` is always a UUID, there is no explicit assertion or allowlist check on the format of `file_name` before it is joined and used as a file-system path inside `processRagQueue`. A future DB migration or a direct SQL INSERT (e.g. during a data import) that writes a `file_name` containing `../` sequences would silently allow `parsePdfWithOcr` to attempt OCR on an arbitrary file accessible to the `node` user.

*Recommendation:* Add a format guard in `processRagQueue` before calling `parseDocument`:
```typescript
if (!/^[0-9a-f-]{36}\.[a-z]{2,4}$/.test(doc.file_name)) {
  // log and skip — not a safe UUID filename
  continue;
}
```
This is a defence-in-depth control, not a currently exploitable vulnerability.

---

## A02: Cryptographic Failures

**Description:** Sensitive data exposed due to weak or absent cryptography, or insecure handling of temporary data.

### Controls Implemented

- Temporary PNG files produced by `pdftoppm` are written into a `mkdtempSync` directory under `os.tmpdir()` (docParser.ts:104). In the production compose file, `/tmp` is mounted as a `tmpfs` volume (`docker-compose.prod.yml:118-119`), meaning the PNG files never touch persistent disk and are lost on container restart.
- The `finally` block at `docParser.ts:147-150` calls `fs.rmSync(tmpDir, { recursive: true, force: true })` unconditionally, covering both success and error paths. OCR-extracted text is not written to any log — only page counts, filenames, and DPI settings are logged (`docParser.ts:122`, `144`).
- The `label` variable used in log messages is `path.basename(filePath)`, which equals the UUID-based stored filename (e.g. `3f2a1c4b-...-uuid.pdf`) — never the user-supplied original filename, which would carry PII risk.
- Error messages returned to API callers for upload failures are generic (`"Internal server error"`, `"Error saving file"`) with no file path or content in the response body.

### Findings

**Finding A02-1 — Low | No CVSS (information-leakage edge case)**

`parsePdfWithOcr` logs the stored filename (`label`) in three console statements at lines 118, 122, and 144. While these are UUID filenames and carry no PII, the log at line 122 also emits `OCR_DPI` and `OCR_LANGUAGES`, which are operator-supplied environment values. If these variables were misconfigured to contain a sensitive string (unlikely but theoretically possible), that string would appear in container logs. Additionally, the OCR error path in `parseDocument` (line 387–390) logs `err.message`, which for Tesseract or pdftoppm failures could contain internal filesystem paths.

*Recommendation:* Constrain logged OCR env values to their validated-safe forms (see A03 recommendation). In the error logger, use `err.message.slice(0, 200)` to bound potential path disclosure from subprocess stderr.

**Finding A02-2 — Low | Temp file permissions**

`fs.mkdtempSync` creates the directory with mode `0700` by default on Linux, which is correct. However, the mode is not explicitly set in the code. If `umask` is permissive in the container, the temp directory could be world-readable. The `node` user is the only process in the container, so this is low risk in practice but not explicitly hardened.

*Recommendation:* Use `fs.mkdtempSync(path.join(os.tmpdir(), 'cmdb-ocr-'), { mode: 0o700 })` — note that the Node.js `fs.mkdtempSync` API does not accept a mode option directly; alternatively call `fs.chmodSync(tmpDir, 0o700)` immediately after creation.

---

## A03: Injection

**Description:** User-supplied data is interpreted as commands or queries due to insufficient sanitization.

### Controls Implemented

- `parsePdfWithOcr` uses `execFileAsync('pdftoppm', ['-r', OCR_DPI, '-png', filePath, prefix])` — `execFile` with an array of arguments, not a shell string. No shell metacharacter expansion occurs regardless of argument content (`docParser.ts:110`).
- `tesseract.recognize(pngs[i], { lang: OCR_LANGUAGES, oem: '1', psm: '3' })` uses the `node-tesseract-ocr` library which constructs its own `execFile` call internally with the `lang` option passed as a command-line flag (`--tessdata-dir` / `-l`) — not via shell interpolation.
- The `filePath` passed to `pdftoppm` and Tesseract is derived from `path.join(DOCUMENTS_DIR, doc.file_name)` where `doc.file_name` is a DB-stored UUID (see A01). No user-controlled string reaches these subprocess calls.

### Findings

**Finding A03-1 — Medium | CVSS 4.4 (CVSS:3.1/AV:L/AC:L/PR:H/UI:N/S:U/C:N/I:N/A:H)**

`OCR_DPI` is read from the environment and passed as a string directly to `pdftoppm`'s `-r` argument without numeric validation (`docParser.ts:44`, `110`). While `execFile` prevents shell injection, `pdftoppm` will accept arbitrary string values for `-r`. A value such as `"0"` would produce zero-dimension images (pdftoppm exits with an error but wastes processing), and a value like `"-r 9999"` (if the operator accidentally includes the flag) could cause argument misalignment. More practically, `OCR_DPI=999999` would instruct pdftoppm to rasterise each page at nearly 1 million DPI, consuming gigabytes of memory and disk for a single-page document before the timeout fires. The attack surface requires access to the deployment environment (environment variable injection via CI pipeline compromise, compromised `.env` file, or a misconfigured Kubernetes secret), making this a Medium rather than High.

*Recommendation:* Validate and clamp `OCR_DPI` at module load time:
```typescript
const rawDpi = parseInt(process.env.OCR_DPI ?? '300', 10);
const OCR_DPI = String(isNaN(rawDpi) || rawDpi < 72 || rawDpi > 600 ? 300 : rawDpi);
```
A range of 72–600 DPI covers all legitimate use cases (72 for screen quality, 600 for high-fidelity archival scan).

**Finding A03-2 — Medium | CVSS 3.7 (CVSS:3.1/AV:L/AC:H/PR:H/UI:N/S:U/C:N/I:L/A:N)**

`OCR_LANGUAGES` is passed without validation to the `lang` option of `node-tesseract-ocr` (`docParser.ts:43`, `128`). The library passes this value to Tesseract's `-l` flag. Tesseract's `-l` parameter accepts `+`-delimited language codes (e.g. `spa+eng`). If `OCR_LANGUAGES` contains a value like `eng --tessdata-dir /etc` (with a space), the `node-tesseract-ocr` library may split on spaces when constructing its internal argument array, depending on its argument parsing implementation (version 2.2.1 — not verified to sanitize). Even without code execution risk (execFile prevents shell injection at the OS level), a malformed language string could cause Tesseract to silently fall back to English only, degrade OCR quality for non-English documents, or emit internal paths in error messages. Exploitation requires environment variable write access.

*Recommendation:* Validate `OCR_LANGUAGES` against an allowlist of known Tesseract language codes at module load time:
```typescript
const VALID_LANG_RE = /^[a-z]{2,4}(\+[a-z]{2,4})*$/;
const rawLang = process.env.OCR_LANGUAGES ?? 'spa+eng';
const OCR_LANGUAGES = VALID_LANG_RE.test(rawLang) ? rawLang : 'spa+eng';
```
This ensures only valid ISO-639 code combinations reach the Tesseract subprocess.

---

## A04: Insecure Design

**Description:** Architectural or design decisions that create security or reliability risks that cannot be fixed by implementation patches alone.

### Controls Implemented

- `parsePdfWithOcr` uses a `try...finally` block (docParser.ts:106–151) that guarantees temp directory cleanup on all paths: normal completion, thrown exceptions from `pdftoppm`, Tesseract failures, and timeout-induced rejections from the `Promise.race` wrapper in `parseDocument` (docParser.ts:382–392).
- A global timeout of `Math.max(MAX_PARSE_TIME_MS, MAX_OCR_TIME_MS)` (default: max of 60 s and 180 s = 180 s) is applied to the entire PDF parse operation via `Promise.race`, preventing a single document from blocking the cron worker indefinitely (`docParser.ts:378`).
- A file-size guard of 100 MB (`MAX_FILE_BYTES`, docParser.ts:37) rejects files before any parsing or OCR is attempted, and multer's `fileSize` limit caps uploads at `MAX_FILE_SIZE` (default 50 MB per `index.ts:3113`, `3642`).
- The RAG cron worker processes at most 3 document jobs per 30-second tick (`index.ts:3239`), preventing unbounded parallel OCR execution.

### Findings

**Finding A04-1 — Medium | CVSS 5.3 (CVSS:3.1/AV:N/AC:L/PR:H/UI:N/S:U/C:N/I:N/A:H)**

There is no limit on the number of pages in a scanned PDF before `pdftoppm` is invoked (`docParser.ts:107–116`). A 50 MB scanned PDF at 300 DPI (the default) could contain hundreds of pages. `pdftoppm` will rasterise every page before `parsePdfWithOcr` begins processing any of them. Each 300 DPI full-page PNG is roughly 2–8 MB; a 500-page document could generate 1–4 GB of PNG data. The production compose file mounts `/tmp` as a `tmpfs` volume (`docker-compose.prod.yml:118-119`) with no explicit `size` limit. By default, Docker `tmpfs` mounts are capped at half the host RAM. A sufficiently large scanned PDF can therefore exhaust container memory, causing the `node` process or `pdftoppm` to receive SIGKILL, which aborts not only the OCR job but the entire backend container — a denial of service affecting all CMDB users. The attacker must be an authenticated ADMIN, limiting exploitability but not eliminating it (compromised admin credentials, or a malicious insider).

*Recommendation (two-part):*
1. Add a page count cap using `pdf-parse`'s `numpages` field before invoking OCR:
```typescript
// In parsePdf(), before calling parsePdfWithOcr:
const MAX_OCR_PAGES = parseInt(process.env.OCR_MAX_PAGES ?? '100', 10);
if (data.numpages > MAX_OCR_PAGES) {
  console.warn(`[docParser] Skipping OCR for "${path.basename(filePath)}" — ${data.numpages} pages exceeds limit ${MAX_OCR_PAGES}`);
  return [];
}
```
2. Set an explicit size limit on the tmpfs mount in `docker-compose.prod.yml`:
```yaml
tmpfs:
  - /tmp:size=512m
```

**Finding A04-2 — Low | Design gap**

The OCR timeout (`MAX_OCR_TIME_MS`, default 180 s) applies to the entire document (all pages combined) via a `Promise.race` in `parseDocument`. However, `pdftoppm` runs to completion before Tesseract begins. On a slow host or a document with many pages, `pdftoppm` alone can consume most of the timeout budget, leaving Tesseract insufficient time for all pages and silently truncating the output. There is no per-page timeout on the Tesseract `recognize` call. If Tesseract hangs on a single malformed PNG (corrupt scan artefact), it will block for the full remaining window.

*Recommendation:* Wrap the per-page `tesseract.recognize` call in its own `Promise.race` with a per-page timeout (e.g. 30 s). Log a warning and `continue` to the next page if it fires.

---

## A05: Security Misconfiguration

**Description:** Missing hardening, unsafe defaults, open cloud storage, misconfigured headers, or unreviewed default configurations.

### Controls Implemented

- `OCR_ENABLED` defaults to `true` unless explicitly set to `'false'` (`docParser.ts:45`). The opt-out pattern is safe for this feature; disabling OCR is straightforward.
- `OCR_DPI` defaults to `'300'`, `OCR_LANGUAGES` defaults to `'spa+eng'`, and `OCR_TIMEOUT_MS` defaults to `180000` — all operationally safe defaults (`docParser.ts:43-45`).
- Tesseract tessdata language packs are installed at image build time via `apk add tesseract-ocr-data-{eng,spa,deu,por,fra,ita,osd}` in the Dockerfile runner stage (Dockerfile:43-48). Tesseract will not attempt to download language data at runtime, eliminating network-based SSRF from the tessdata path.
- The container runs as the non-root `node` user (uid 1000), constraining filesystem write access even if OCR processing is exploited (`Dockerfile:74-75`).
- `no-new-privileges: true` is set on the backend service in `docker-compose.prod.yml:116`, preventing privilege escalation from inside the container.

### Findings

**Finding A05-1 — Low | Documentation gap**

The four OCR environment variables (`OCR_ENABLED`, `OCR_DPI`, `OCR_LANGUAGES`, `OCR_TIMEOUT_MS`) are defined in `docker-compose.prod.yml` (lines 97–101) but are absent from `.env.example` and from the sysadmin documentation. Operators who deploy from `.env.example` will not know these variables exist, defaulting to `OCR_ENABLED=true` without realising OCR is active. If the deployment environment imposes memory constraints, the undocumented `OCR_DPI` and `OCR_TIMEOUT_MS` defaults may cause unexpected resource consumption.

*Recommendation:* Add all four OCR variables to `.env.example` with explanatory comments. Document the recommended `tmpfs` size constraint in `docs/SYSADMIN_MANUAL.md`.

**Finding A05-2 — Low | Alpine apk packages not pinned**

The Dockerfile installs `tesseract-ocr`, `tesseract-ocr-data-*`, and `poppler-utils` via `apk add --no-cache` without version pinning (Dockerfile:37-48). Alpine rolling packages mean the installed binary versions change with each image rebuild. A newly published vulnerable version of `poppler-utils` or `tesseract-ocr` would be silently adopted at next build without any CI alert.

*Recommendation:* Pin Alpine packages to specific versions using the `=<version>` apk syntax, or run `apk info <package>` during CI to capture and record the installed version for supply-chain audit purposes. Alternatively, integrate an image vulnerability scanner (e.g. Trivy) into the CI pipeline.

---

## A06: Vulnerable & Outdated Components

**Description:** Use of components with known vulnerabilities, unsupported software, or failure to scan for CVEs.

### Components and Versions Audited

| Component | Version | Source |
|-----------|---------|--------|
| `node-tesseract-ocr` (npm) | 2.2.1 (pinned in lock) | package-lock.json |
| `pdf-parse` (npm) | 1.1.4 (pinned in lock) | package-lock.json |
| `tesseract-ocr` (system) | 5.5.1 (Dockerfile comment) | Dockerfile:13 |
| `poppler-utils` (system) | Alpine rolling — unpinned | Dockerfile:48 |

### Findings

**Finding A06-1 — Info | No known exploitable CVEs at audit date**

`node-tesseract-ocr` 2.2.1 has no publicly disclosed CVEs as of 2026-05-28. `pdf-parse` 1.1.4 has no CVEs. `tesseract-ocr` 5.5.1 on Alpine has no critical CVEs that are exploitable via the API surface used (local file processing only — no network input to Tesseract). `poppler-utils` has had historical heap-overflow CVEs in older versions; the Alpine 3.x edge version currently ships 24.x which is unaffected by the critical 2023-era CVEs (CVE-2023-34872, CVE-2022-38349).

*Recommendation:* This is an observation, not a finding. Add `npm audit` to the CI pipeline. Add Trivy or Grype image scanning to the Docker build pipeline to catch future system-level CVEs in `poppler-utils` and `tesseract-ocr`.

---

## A07: Authentication & Session Failures

**Description:** Missing or weak authentication, session management failures, or credential exposure.

### Controls Implemented

- The full OCR invocation chain requires `ADMIN` role at every step. Upload endpoints enforce `authenticateToken` + `requireAdmin` middleware in that order. A JWT with an expired or missing claim is rejected by `authenticateToken` before multer processes the file. A valid AUDITOR or VIEWER JWT is rejected by `requireAdmin` with HTTP 403 (`index.ts:3812`, `4151`).
- `processRagQueue` is invoked only from the internal node-cron scheduler (`index.ts:4833`). It reads file paths exclusively from the `rag_document_index` table, which is only populated by `queueDocumentForIndexing` — itself called only from the two admin-authenticated upload handlers. There is no API endpoint, webhook, or message queue that can directly enqueue a document for OCR processing without going through the authenticated upload flow.
- Every upload triggers an `AuditLog` INSERT (`'CREATE'` or `'VERSION'` action) with the admin's email (`index.ts:3863`, `4197`). Post-OCR indexing produces an `'INDEX_DOC'` audit entry and an `'INDEX_BATCH'` summary record (`index.ts:3292-3294`, `3498-3508`). The complete chain from upload to OCR result is traceable in the audit log.

### Findings

No findings. The authentication and authorisation controls protecting the OCR pipeline are adequate. OCR is not directly triggerable by any external input without a valid ADMIN session.

---

## A08: Software & Data Integrity

**Description:** Code or infrastructure integrity assumptions are violated, or insufficient integrity verification on data consumed by the pipeline.

### Controls Implemented

- Magic bytes validation is applied to uploaded files **before** the file is written to disk (`index.ts:4155-4158` for versions, `3815-3818` for new uploads). The `validateMagicBytes` function checks the first 4 bytes against known PDF, Office, and image format signatures. A file uploaded with a `.pdf` extension but an incorrect magic byte header (e.g. a renamed executable) is rejected with HTTP 400 before it is ever stored or queued for OCR.
- The file path passed to `parsePdfWithOcr` is derived exclusively from `path.join(DOCUMENTS_DIR, doc.file_name)` where `doc.file_name` is a server-generated `crypto.randomUUID()` string. The user-supplied original filename (`req.file.originalname`) is stored only as metadata (`original_name`) in the database and is never used to construct a filesystem path.
- The stored extension is derived from the user-supplied `originalname` (`path.extname(req.file.originalname)`), but it is validated against `ALLOWED_EXTENSIONS` before use, and both upload endpoints independently call `validateMagicBytes` to cross-check content against extension. If the extension is not in `ALLOWED_EXTENSIONS`, multer's `fileFilter` rejects the upload before the buffer is examined.

### Findings

**Finding A08-1 — Low | Magic bytes limitation for text files**

`MAGIC_BYTES['txt']` and `MAGIC_BYTES['csv']` are defined as empty arrays (`index.ts:3135-3136`), causing `validateMagicBytes` to return `true` for any file with a `.txt` or `.csv` extension regardless of content (`docParser.ts` validates indirectly via the mimeType switch). While TXT/CSV files are not passed to the OCR pipeline (only PDF triggers `parsePdfWithOcr`), this means a crafted file containing embedded scripting content or a trojan payload could be stored on disk with a `.txt` extension. OCR would not process it, but it would be stored and potentially served as a download. This is inherited from the pre-OCR upload design rather than an OCR-specific issue.

*Recommendation:* For `.txt` and `.csv` files, validate that the first 512 bytes are valid UTF-8 text after upload, rejecting binary content. This is a defence-in-depth measure against polyglot file attacks.

**Finding A08-2 — Info | Original filename stored unvalidated**

`req.file.originalname` (browser-supplied) is stored as `original_name` in the documents table without sanitization (`index.ts:3848`, `4194`). This value is displayed in the UI and is included in audit logs. It is not used in any file-system operation, so there is no injection or traversal risk. However, a filename containing HTML or JavaScript (e.g. `<img src=x onerror=alert(1)>.pdf`) could trigger stored XSS if the frontend renders it without escaping. This is an A03/frontend issue, not an OCR issue, but is flagged for completeness.

*Recommendation:* Sanitize `original_name` on insert (strip HTML tags) or ensure the frontend always escapes the value when rendering. The primary mitigation should be in the React components that display filenames.

---

## A09: Security Logging & Monitoring

**Description:** Insufficient logging, monitoring, or alerting means that attacks or failures cannot be detected or investigated.

### Controls Implemented

- Every document upload creates an `AuditLog` record with `action='CREATE'` or `action='VERSION'`, `entity='Document'`, `entity_id` (new document UUID), and the admin's email. This provides a full record of who uploaded which document and when (`index.ts:3863`, `4197`).
- After successful OCR + embedding + chunking, an `'INDEX_DOC'` audit entry is inserted with `user_email='system'` (`index.ts:3292-3294`). Each 30-second cron cycle that processes any work inserts an `'INDEX_BATCH'` summary row capturing counts of processed and errored items per entity type (`index.ts:3498-3508`).
- Errors in `processRagQueue` are caught, truncated to 500 characters, and written to the `rag_document_index.error_message` column, providing a queryable error log directly in the database (`index.ts:3299-3301`).

### Findings

**Finding A09-1 — Medium | No audit log entry for OCR activation**

When a PDF triggers the OCR fallback path (i.e. `pdf-parse` finds no embedded text and `OCR_ENABLED=true`), no audit log record is created. The `INDEX_DOC` audit entry is written only after OCR and embedding complete successfully. If OCR fails (Tesseract error, timeout, pdftoppm error), the `rag_document_index.error_message` column is updated but no `AuditLog` row is inserted — the failure is invisible to anyone reviewing the audit trail. An administrator reviewing `AuditLog` for a sensitive document will see `VERSION` (upload) but not know whether OCR successfully extracted its content or failed silently.

For NIS2 Article 23 compliance and ISO 27001 A.8.15, the auditability gap means that if a scanned PDF containing sensitive data was incorrectly OCR-processed (content indexed into RAG vector store), or conversely failed to index, the audit record cannot confirm which occurred.

*Recommendation:* Insert an `AuditLog` record when the OCR path is taken:
```typescript
// In parsePdfWithOcr, at the start of the try block:
// (Or at the calling site in processRagQueue after parseResult is available)
await prisma.$executeRaw`
  INSERT INTO "audit_logs"(id, action, entity, entity_id, user_email, details, created_at)
  VALUES(gen_random_uuid(), 'OCR_INVOKED', 'Document', ${documentId}::uuid, 'system',
    ${JSON.stringify({ pages: pngs.length, dpi: OCR_DPI, lang: OCR_LANGUAGES })}::jsonb, now())`;
```
Add a corresponding `OCR_FAILED` entry in the `catch` path.

**Finding A09-2 — Low | Tesseract per-page errors not observable**

If Tesseract fails on a specific page within a multi-page document (e.g. corrupt scan artefact, unsupported character set), `tesseract.recognize` throws an exception. This exception propagates up to `processRagQueue`'s outer `try/catch`, which writes the full error to `rag_document_index.error_message`. However, pages successfully processed before the failing page are lost — the partially extracted sections are discarded and the document is marked `'ERROR'`. There is no per-page error tracking, making it impossible to tell from logs which page caused the failure.

*Recommendation:* Wrap the per-page `tesseract.recognize` call in its own `try/catch`. Log a per-page warning on failure, push a placeholder section noting the failed page, and continue processing remaining pages. This avoids total data loss from a single bad scan page.

---

## A10: Server-Side Request Forgery (SSRF)

**Description:** The application makes server-side requests to internal or external resources using URLs influenced by user input.

### Controls Implemented

- `parsePdfWithOcr` makes no outbound network calls. `pdftoppm` is a local binary that reads from the filesystem and writes PNG files to the temp directory. `tesseract.recognize` is a local binary invocation — it reads from the filesystem and returns text in memory. Neither tool opens network sockets as part of normal operation.
- Tesseract language data is installed at image build time via `apk add tesseract-ocr-data-*` (Dockerfile:43-48). Tesseract does not attempt to download tessdata files at runtime when the tessdata directory is pre-populated (verified by the apk packages present in the runner stage). The `TESSDATA_PREFIX` environment variable is not set in the compose file, so Tesseract uses the Alpine default path (`/usr/share/tessdata`), which is populated by the apk packages.
- No user-supplied URL is accepted anywhere in the OCR pipeline. The upload endpoints accept a file buffer (`multer.memoryStorage()`), not a URL.
- The general `apiLimiter` (300 requests/min per IP, `index.ts:231`) applies to all `/api/` routes including document uploads, preventing an attacker from rapidly uploading documents to trigger background OCR jobs even if authenticated.

### Findings

No findings. The OCR pipeline has no network component. All processing is local to the container. There is no user-controlled URL or hostname in the OCR code path, and the Tesseract runtime does not make outbound connections.

---

*End of report. All 10 OWASP Top 10 (2021) categories assessed.*

# OWASP Top 10 (2021) Security Audit — OCR Timeout & DPI Fix (Task A)

**Audit ID:** OWASP-TASK-A-001
**Audit date:** 2026-06-01
**Auditor:** Independent security review
**Classification:** CONFIDENTIAL — Internal security audit record
**Platform version:** v2.3.x (post-fix, `main`)

---

## Scope

Targeted review of a single bug-fix that resolves silent timeouts when running OCR on multi-page scanned PDFs. This is not a full re-audit; it focuses exclusively on the security implications of the changes made, re-assesses prior findings whose status the fix alters, and verifies no new attack surface was introduced.

**Changes reviewed:**
- `backend/src/services/docParser.ts` — new `MAX_OCR_DOC_TIME_MS` constant; `OCR_DPI` default changed from `'300'` to `'150'`; `parseDocument` PDF timeout now uses `MAX_OCR_DOC_TIME_MS` instead of `Math.max(MAX_PARSE_TIME_MS, MAX_OCR_TIME_MS)`.
- `docker-compose.prod.yml` and `docker-compose.yml` — added `OCR_DPI: ${OCR_DPI:-150}` and `OCR_DOC_TIMEOUT_MS: ${OCR_DOC_TIMEOUT_MS:-600000}` to the backend environment block.
- `install.conf` — updated operator comments for the new/changed variables.

**Predecessor audits cross-referenced:**
- `owasp-ocr.md` (OWASP-OCR, v2.3.2, 2026-05-28) — standalone OCR path via single-document upload.
- `owasp-bulk-ocr.md` (OWASP-BULK-OCR-001, v2.3.x, 2026-05-29) — OCR as reached from the bulk import worker.

---

## What Was Fixed

The root cause was a `Promise.race` in `parseDocument` that used `MAX_OCR_TIME_MS` (180 s) as the total outer timeout. A 16-page PDF at 300 DPI takes roughly 760 s (pdftoppm ~57 s + tesseract ~44 s/page × 16), so the race fired at 180 s, `parseDocument` returned `emptyResult()`, and the bulk worker recorded `textExtracted:false` / status `ANALYZED` — silently losing the text content. The fix introduces a separate, larger outer cap (`MAX_OCR_DOC_TIME_MS`, 600 s default) applied only to PDF mimeType, and reduces the DPI default from 300 to 150 (shrinking per-page processing time and rasterised PNG sizes by a factor of ~4).

---

## Findings by Severity

| Severity | Count | IDs |
|----------|-------|-----|
| CRITICAL | 0 | — |
| HIGH     | 0 | — |
| MEDIUM   | 1 | TASK-A-A04-1 (600 s default creates a wider DoS window than the prior 180 s cap) |
| LOW      | 1 | TASK-A-A05-1 (`OCR_DOC_TIMEOUT_MS` is not validated against zero or negative values) |
| INFO     | 3 | Positive controls; `finally` cleanup verified correct; prior HIGH BULK-OCR-A03-1 unaffected |

**Overall verdict: Fix is correct and net-positive for security (smaller temp files, subprocess-level kill already present). One MEDIUM availability concern (widened DoS window) and one LOW misconfiguration risk (no floor on the new env var). No new injection surface.**

---

## A03: Injection

**Applicability:** Assessed — DPI change is in a constant, not a new user input.
**Risk Level:** NONE (controls unchanged).

### Assessment

The DPI change moves the default from `'300'` to `'150'` inside the same env-driven constant `OCR_DPI` (`docParser.ts:47`). This value reaches `execFileAsync('pdftoppm', ['-r', OCR_DPI, …], procOpts)` as an array element — `execFile` with no shell, unchanged from before. The new `MAX_OCR_DOC_TIME_MS` constant (`docParser.ts:45`) is never passed to any subprocess; it is only used as the millisecond argument to `makeTimeoutPromise`. No new attacker-controlled string reaches a subprocess, a shell, or a SQL statement. **No new injection surface.**

The pre-existing A03 findings from both predecessor audits are unchanged:
- **BULK-OCR-A03-1 (HIGH):** `node-tesseract-ocr`'s shell invocation via `child_process.exec` is unaffected by this fix. That finding's status remains OPEN. The fix does not use `node-tesseract-ocr` at all — the code as shipped uses `execFileAsync('tesseract', […])` directly (`docParser.ts:139–143`), so this prior finding is actually **CLOSED** by the current state of the code: the library has already been replaced by a direct `execFileAsync` call. The audit record in `owasp-bulk-ocr.md` should be updated to reflect this.
- **BULK-OCR-A03-2 (LOW):** `OCR_DPI` and `OCR_LANGUAGES` remain unvalidated at module load. Unchanged.

---

## A04: Insecure Design (DoS / Resource Exhaustion)

**Applicability:** HIGH — the outer timeout is the primary resource-bounding control for multi-page OCR.
**Risk Level:** MEDIUM.

### Controls Verified

- **Subprocess-level kill is present.** `procOpts = { timeout: MAX_OCR_TIME_MS, killSignal: 'SIGKILL' }` (`docParser.ts:109`) is passed to both the `pdftoppm` call (`line 115`) and every `execFileAsync('tesseract', …)` call (`line 142`). Each individual subprocess is hard-killed at 180 s. This is the correct remediation for BULK-OCR-A04-1 and OCR-A04-2 from the prior audits — those findings are now **CLOSED** at the subprocess level.
- **`OCR_MAX_PAGES` is enforced.** The `pdftoppm` call passes `-l ${OCR_MAX_PAGES}` to cap pages rasterised at the OS level (`line 117`), and a second `slice(0, OCR_MAX_PAGES)` guard is applied to the resulting PNG list (`line 124`). At 150 DPI a full-page A4 PNG is approximately 350–500 KB (versus ~1.5–2 MB at 300 DPI), so the worst-case temp disk for 50 pages is roughly 25 MB — well within the `tmpfs` budget. The DoS guard remains effective at the new DPI.
- **`finally` cleanup is unconditional.** `fs.rmSync(tmpDir, { recursive: true, force: true })` at `docParser.ts:161` runs on every path including outer `Promise.race` rejection, because the cleanup lives inside `parsePdfWithOcr`'s own `finally` block — which fires when the underlying promise settles (including when it is rejected by the abandoned race). Since each individual tesseract process is killed at `MAX_OCR_TIME_MS`, the underlying promise does settle in bounded time. Temp files are cleaned up. No zombie temp dirs accumulate.

### Finding TASK-A-A04-1 — MEDIUM | CVSS:3.1/AV:N/AC:L/PR:H/UI:N/S:U/C:N/I:N/A:M (4.3)

**Location:** `docParser.ts:45` + `parseDocument:393` — `MAX_OCR_DOC_TIME_MS` default 600 s.

**Description:** The outer `parseDocument` timeout for PDFs has grown from 180 s to 600 s. Combined with `BULK_ANALYZE_BUDGET=2` items per 30 s cron tick, a single cron worker cycle can now have up to two PDF jobs each holding a `parseDocument` promise open for up to 600 s. During this window the backend cron is blocked on these promises (the cron worker is sequential within a tick). While individual subprocesses are hard-killed at 180 s per the `procOpts` timeout, the outer 600 s window means the worker can be kept "busy" for up to 10 minutes by two pathological PDFs (e.g. files that repeatedly stall pdftoppm near its 180 s limit before finishing). This is a wider availability window than the pre-fix 180 s cap, though the practical impact is bounded by the per-subprocess SIGKILL and the page cap.

The increase is justified by the bug it fixes — 180 s was simply too short for legitimate multi-page OCR — but the new ceiling should be configurable and operators should understand the trade-off.

**Impact:** Availability. Requires an authenticated ADMIN to upload pathological scanned PDFs. The cron worker and RAG indexing queue stall for up to 600 s per affected document before recovering. Not a new vulnerability type; this is a widening of an existing design trade-off.

**Remediation:**
1. Document `OCR_DOC_TIMEOUT_MS` in `.env.example` and operator guidance with a recommended range (300–900 s) and the formula `≥ OCR_MAX_PAGES × OCR_TIMEOUT_MS / concurrency` for sizing.
2. Consider reducing `BULK_ANALYZE_BUDGET` from 2 to 1 when OCR-heavy workloads are expected (operator-tunable), so at most one long-running OCR job occupies the queue per tick.
3. No code change required for the timeout value itself — the fix is correct; this is a documentation/configuration hardening item.

---

## A05: Security Misconfiguration

**Applicability:** Medium — new env variable with a large numeric default.
**Risk Level:** LOW.

### Controls Verified

- `OCR_DOC_TIMEOUT_MS` is surfaced in both compose files with a safe default (`600000`). The variable name is distinct from the per-subprocess `OCR_TIMEOUT_MS`, reducing operator confusion.
- `OCR_DPI` default `'150'` is a safe, documented value. The prior `owasp-ocr` finding A05-1 about OCR variables being absent from `.env.example` is partially addressed: `OCR_DPI`, `OCR_DOC_TIMEOUT_MS`, and `OCR_TIMEOUT_MS` are now commented in `install.conf`.

### Finding TASK-A-A05-1 — LOW | CVSS:3.1/AV:L/AC:H/PR:H/UI:N/S:U/C:N/I:N/A:L (1.9)

**Location:** `docParser.ts:45` — `Number(process.env.OCR_DOC_TIMEOUT_MS ?? 600_000)`.

**Description:** `OCR_DOC_TIMEOUT_MS` is read with `Number(…)` and no range validation. `Number('0')` = `0` and `Number('-1')` = `-1` are valid JS numbers. A `setTimeout` of 0 ms fires on the next event-loop tick, effectively making `makeTimeoutPromise(0)` win the `Promise.race` immediately and causing every PDF parse to return `emptyResult()` — silently re-introducing the original bug. A negative value produces `setTimeout(fn, -1)` which Node.js coerces to 0, same effect. A value of `NaN` (e.g. `OCR_DOC_TIMEOUT_MS=abc`) also produces 0 ms via `Number('abc') = NaN`. This is a misconfiguration risk, not an active exploit: only an operator or a compromised deployment environment can set the env var.

**Remediation:** Add a floor at module load, consistent with how `MAX_OCR_TIME_MS` could also be validated:

```typescript
const _rawDocTimeout = Number(process.env.OCR_DOC_TIMEOUT_MS ?? 600_000);
const MAX_OCR_DOC_TIME_MS = Number.isFinite(_rawDocTimeout) && _rawDocTimeout >= 30_000
  ? _rawDocTimeout
  : 600_000;
```

Apply the same pattern to `MAX_OCR_TIME_MS`. Log a warning if the env value is out of range so the operator is alerted at startup.

---

## A08: Software and Data Integrity

**Applicability:** Medium — verifying `finally` cleanup interacts correctly with the new outer timeout.
**Risk Level:** NONE (controls verified).

### Assessment

The new outer timeout fires at 600 s via `Promise.race([parseWork(), makeTimeoutPromise(MAX_OCR_DOC_TIME_MS)])`. When the timeout promise rejects, `Promise.race` rejects with `"Parse timeout after 600000 ms"`, which is caught in the `try/catch` in `parseDocument` (`lines 397–407`) and returns `emptyResult()`. The underlying `parseWork()` → `parsePdf()` → `parsePdfWithOcr()` promise is **abandoned but not garbage-collected immediately**. However, because every individual `execFileAsync` call inside `parsePdfWithOcr` is wrapped with `{ timeout: MAX_OCR_TIME_MS, killSignal: 'SIGKILL' }`, all subprocesses are killed within 180 s. The underlying promise then settles (throws or resolves), which triggers `parsePdfWithOcr`'s `finally` block and runs `fs.rmSync(tmpDir, { recursive: true, force: true })`. In the worst case, cleanup happens up to `MAX_OCR_TIME_MS` (180 s) after the outer race fires — not instantly, but bounded and guaranteed. **No temp-dir leak.** This is the correct design and represents a concrete improvement over the prior state (where the outer race fired at 180 s and subprocesses were never killed, leaving both cleanup and subprocesses unbound).

---

## Prior Findings — Status Update

The following findings from predecessor audits change status as a result of this fix:

| Finding | Prior Status | New Status | Reason |
|---------|-------------|------------|--------|
| BULK-OCR-A04-1 (MEDIUM) — subprocesses not killed at timeout | OPEN | **CLOSED** | `procOpts = { timeout: MAX_OCR_TIME_MS, killSignal: 'SIGKILL' }` is applied to both `pdftoppm` and `tesseract` calls. |
| BULK-OCR-A04-2 (MEDIUM) — no page-count cap before rasterisation | OPEN | **CLOSED** | `-l ${OCR_MAX_PAGES}` passed to `pdftoppm`; second `slice(0, OCR_MAX_PAGES)` guard on PNG list. At 150 DPI, max temp disk is ~25 MB for 50 pages. |
| OCR-A04-1 (MEDIUM) — no per-document page count limit before pdftoppm | OPEN | **CLOSED** (same as above) | |
| OCR-A04-2 (LOW) — no per-page timeout on tesseract | OPEN | **CLOSED** | Per-page subprocess timeout via `procOpts.timeout` = `MAX_OCR_TIME_MS`. |
| BULK-OCR-A03-1 (HIGH) — `node-tesseract-ocr` uses `child_process.exec` (shell) | OPEN | **CLOSED** | The code as shipped uses `execFileAsync('tesseract', […])` directly; the library wrapper is no longer in use in this code path. The audit record in `owasp-bulk-ocr.md` should be annotated accordingly. |
| OCR-A05-1 (LOW) — OCR env vars absent from `.env.example` | OPEN | **PARTIALLY CLOSED** | `install.conf` now documents `OCR_DPI`, `OCR_DOC_TIMEOUT_MS`, `OCR_TIMEOUT_MS`, `OCR_MAX_PAGES`, `OCR_LANGUAGES`, `OCR_ENABLED` with comments. `.env.example` itself not audited for this fix; if it exists, it should be updated to match. |

All other prior findings (BULK-OCR-A03-2, BULK-OCR-A09-1, BULK-OCR-A05-1, OCR-A02-2, OCR-A03-1/2, OCR-A09-1/2) remain **OPEN** — they are unaffected by this fix.

---

## Summary Risk Matrix

| OWASP Category | Risk | Finding |
|----------------|------|---------|
| A01: Broken Access Control | NONE | No change to access control. |
| A02: Cryptographic Failures | NONE | No change to temp file handling or logging. `finally` cleanup still unconditional. |
| A03: Injection | NONE | No new subprocess arguments from user input. BULK-OCR-A03-1 effectively closed by current code. |
| A04: Insecure Design | MEDIUM | **TASK-A-A04-1**: 600 s outer timeout widens DoS window vs. prior 180 s; mitigated by per-subprocess SIGKILL and page cap. Several prior A04 findings closed. |
| A05: Security Misconfiguration | LOW | **TASK-A-A05-1**: `OCR_DOC_TIMEOUT_MS=0` or `NaN` silently re-introduces the original bug; add floor validation. |
| A06: Vulnerable Components | NONE | No new dependencies. |
| A07: Auth & Session | NONE | No change. |
| A08: Software & Data Integrity | NONE | `finally` cleanup verified correct with new timeout. No orphaned temp dirs. |
| A09: Logging & Monitoring | NONE | No change to audit or logging behaviour. |
| A10: SSRF | NONE | No change. |

---

## Conclusion

The fix correctly resolves the silent timeout bug. The change is a net security improvement: subprocess-level `SIGKILL` on both `pdftoppm` and `tesseract` (previously absent) closes the most serious prior A04 findings; the DPI reduction from 300 to 150 reduces temp disk consumption by ~4×, improving the effectiveness of `OCR_MAX_PAGES` as a DoS guard; and the direct `execFileAsync('tesseract', …)` invocation (replacing the `node-tesseract-ocr` wrapper) closes the prior HIGH shell-injection primitive.

The one MEDIUM finding (wider outer timeout) is an accepted trade-off for functionality and should be accompanied by operator documentation rather than a code change. The one LOW finding (no floor on `OCR_DOC_TIMEOUT_MS`) requires a two-line validation addition at module load.

### Recommended Remediation Backlog

| Priority | ID | Action | Effort |
|----------|----|--------|--------|
| MEDIUM | TASK-A-A04-1 | Document `OCR_DOC_TIMEOUT_MS` in `.env.example` with sizing guidance; consider reducing `BULK_ANALYZE_BUDGET` for OCR-heavy workloads | Low (doc, 30 min) |
| LOW | TASK-A-A05-1 | Add `Number.isFinite(v) && v >= 30_000` floor for `OCR_DOC_TIMEOUT_MS` (and same for `MAX_OCR_TIME_MS`) at module load; log warning on out-of-range | Low (15 min) |
| INFO | — | Annotate `owasp-bulk-ocr.md` finding BULK-OCR-A03-1 as CLOSED (direct `execFileAsync` now used) | Low (5 min) |

---

*Audit completed: 2026-06-01. Scope limited to the OCR timeout and DPI fix. For the full OCR pipeline security assessment see `owasp-ocr.md` and `owasp-bulk-ocr.md`. For the bulk import feature see `owasp-bulk-import.md`.*

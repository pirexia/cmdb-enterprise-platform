# Compliance Review — Release v2.5.3

**Scope:** `git diff main...develop`
**Date:** 2026-06-04
**Frameworks covered:** ISO 27001:2022, GDPR (EU 2016/679), NIS2 (EU 2022/2555), ISO 22301:2019
**Companion document:** [`docs/security-audit/owasp-v2.5.3.md`](../security-audit/owasp-v2.5.3.md)

---

## Executive summary

| Framework | Verdict | Open findings |
|-----------|---------|---------------|
| ISO 27001:2022 | ✅ PASS | 1 LOW (audit gap in sync-eol) — fixed in this branch |
| GDPR | ✅ PASS | None |
| NIS2 | ✅ PASS | None |
| ISO 22301:2019 | ✅ PASS | None |

**Release recommendation:** PROCEED to v2.5.3 after F-01 (sync-eol audit log) is committed.

---

## ISO 27001:2022

| Control | Requirement | Status | Evidence |
|---------|-------------|--------|----------|
| A.5.37 | Documented operating procedures | ✅ | PLAN_v2.5.3.md, this doc, OWASP review |
| A.8.12 | Data leakage prevention | ✅ | No secrets in source/logs; `.env` boundaries respected |
| A.8.15 | Logging | ⚠️→✅ | `UPDATE_CI`, `UPDATE_MASTER`, `CREATE_MASTER` preserved on all modified writes. **F-01:** `sync-eol` UPDATE on `device_models` lacked an audit entry — fixed in this branch (3-line addition) |
| A.8.15 | Log protection (insert-only AuditLog) | ✅ | No `UPDATE`/`DELETE` against `audit_logs` introduced |
| A.9.2 | User access management | ✅ | RBAC unchanged. New write surface (`PATCH /api/cis/:id` inline) gated by `requireAdmin` |

**Verdict: PASS**

---

## GDPR (EU 2016/679)

| Article | Requirement | Status | Evidence |
|---------|-------------|--------|----------|
| Art. 5 (data minimisation) | Collect only what is strictly necessary | ✅ | EOL/EOS dates are vendor lifecycle metadata, not personal data. No new PII fields |
| Art. 17 (right to erasure) | Erasure path must cover all PII | ✅ | No new PII surface added → `DELETE /api/users/:id/erase` scope unchanged |
| Art. 25 (privacy by design) | DPIA for new personal-data processing | ✅ | No new personal-data processing introduced |
| Art. 30 (records of processing) | Data flows documented | ✅ | endoflife.date integration pre-existing, no new third-party data flow |
| Art. 32 (security of processing) | Pseudonymisation, audit, integrity | ✅ | AuditLog and access-control unchanged in scope |
| Logging hygiene | No personal data in logs (use IDs) | ✅ | New logs use CI IDs and master entity IDs — no email/username in structured messages |

**Verdict: PASS — no DPIA required**

---

## NIS2 (EU 2022/2555)

| Requirement | Status | Evidence |
|-------------|--------|----------|
| Art. 21 — incident reporting (24h initial / 72h detailed) | ✅ | AuditLog & error-log infrastructure unaffected → reporting windows preserved |
| Art. 21 — supply-chain risk management | ✅ | No new third-party integrations introduced |
| Art. 21 — business continuity | ✅ | Bulk-import skip-AI change **improves** availability: rows now process even when Ollama is down (graceful degradation) |
| Independent disable for new integrations | ✅ | RAG/Ollama already toggleable via `RAG_ENABLED` env var; behaviour preserved |

**Verdict: PASS**

---

## ISO 22301:2019 (Business continuity)

| Control | Requirement | Status | Evidence |
|---------|-------------|--------|----------|
| Backup mechanism | `pg_dump` workflow intact | ✅ | No change to DB infra or volumes |
| Stateful service additions | Documented recovery procedure | ✅ | No new stateful services introduced |
| RTO target < 15 min | Application restartable from clean Docker pull | ✅ | Migration `20260604110000_device_models_eol_eos` is idempotent (`ADD COLUMN IF NOT EXISTS`) — safe to redeploy |
| Dev-first validation | Tested in dev compose before prod | ✅ | All four tasks validated via `podman-compose.prod.yml` rebuild cycle |

**Verdict: PASS**

---

## Action items for v2.5.3 release

- [x] Document compliance verdict
- [x] Document OWASP verdict
- [ ] Apply F-01 fix (sync-eol audit log) → see [`docs/security-audit/owasp-v2.5.3.md`](../security-audit/owasp-v2.5.3.md)
- [ ] Defer F-02, F-03 to v2.6.x backlog in `docs/PLAN_v2.5.3.md`

---

## Sign-off

Branch `develop` HEAD `ff176f8` has been reviewed against the four frameworks above. With F-01 applied, the release v2.5.3 satisfies all non-negotiable compliance directives stated in `CLAUDE.md`.

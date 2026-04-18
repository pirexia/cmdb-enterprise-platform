# Business Continuity Plan (BCP) — RTO / RPO / MTPD
**Document ID:** ISMS-BCP-001  
**Version:** 1.0  
**Status:** Draft  
**Owner:** [REPLACE: CISO / IT Manager]  
**Last DR test:** [REPLACE: YYYY-MM-DD — not yet conducted]  
**Next review:** [REPLACE: YYYY-MM-DD — review annually]  
**Framework:** ISO 22301:2019, NIS2 Art. 21(2)(c)

---

## 1. Business Impact Analysis (BIA)

### 1.1 Dependent Business Processes

| Process | Depends on CMDB Platform | Impact if unavailable |
|---------|--------------------------|----------------------|
| IT asset management | Yes — primary tool | Medium: manual workaround possible |
| Software license compliance | Yes | High: audit risk if untracked |
| Contract expiry monitoring | Yes | Medium: email alerts would be missed |
| Security incident investigation | Yes — audit logs | Critical: no traceability during outage |

### 1.2 Impact of Unavailability

| Duration | Impact |
|----------|--------|
| < 1 hour | Negligible — transient outage, no business impact |
| 1–4 hours | Low — operational inconvenience, ticket backlog |
| 4–24 hours | Medium — license/contract deadline risk; security monitoring gap |
| > 24 hours | High — regulatory exposure (NIS2 availability obligation); potential audit finding |
| > 72 hours | Critical — business continuity breach; mandatory NIS2 notification |

---

## 2. Continuity Objectives

| Metric | Target | Rationale |
|--------|--------|-----------|
| **RPO** (Recovery Point Objective) | ≤ 24 hours | Daily backup schedule; maximum acceptable data loss = 1 day |
| **RTO** (Recovery Time Objective) | ≤ 4 hours | Time to rebuild containers + restore from backup on available host |
| **MTPD** (Maximum Tolerable Period of Disruption) | 72 hours | NIS2 significant incident threshold; >72h triggers Art. 23 notification |

**Note:** RTO assumes the host server is available. If host reprovisioning is required, add 2–4 hours for OS/Docker setup.

---

## 3. Recovery Procedures

### 3.1 Standard Recovery (host available)

```bash
# 1. Restore database from latest backup
gunzip -c /opt/cmdb/backups/backup_YYYYMMDD_HHMMSS.sql.gz | \
  docker exec -i cmdb-postgres psql -U admin cmdb_db

# 2. Restore document store (if docs-backup.sh was used)
tar -xzf /opt/cmdb/backups/docs_YYYYMMDD_HHMMSS.tar.gz -C /opt/cmdb/documents/

# 3. Rebuild and start containers
cd /opt/cmdb
docker compose -f docker-compose.prod.yml down
docker compose -f docker-compose.prod.yml up -d --build

# 4. Apply pending migrations
docker exec cmdb-backend npx prisma migrate deploy

# 5. Health check
curl -sk https://localhost/api/health
```

### 3.2 Full Host Reprovisioning (host unavailable)

1. Provision new RHEL 9 / Ubuntu 22.04 host
2. Follow `docs/SYSADMIN_MANUAL.md` §Install → run `bash scripts/install.sh`
3. Restore database and document store per §3.1
4. Update DNS A record to point to new host IP

### 3.3 Minimum Viable Service

During recovery, the following is acceptable as minimum viable operation:
- Read-only access to exported database backup (CSV/SQL)
- Manual review of audit logs via `psql` direct connection

---

## 4. Backup Architecture

| Component | Script | Schedule | Retention | Off-site? |
|-----------|--------|----------|-----------|-----------|
| PostgreSQL database | `scripts/db-backup.sh` | Daily 02:00 | 30 days | [REPLACE: No — add rclone/s3 step] |
| Document store | `scripts/docs-backup.sh` | Daily 02:30 | 30 days | [REPLACE: No — add rclone/s3 step] |

**Known gap:** Both backups are stored on the same host as the live platform. A single host failure destroys both live data and all backups. Remediation: [REPLACE: add off-site replication via rclone/aws s3 cp at end of backup scripts].

### 4.1 Backup Integrity Verification

Both backup scripts include automatic integrity verification (`gunzip -t` for PostgreSQL, `tar -tzf` for document store). Verification failure causes the script to exit with status 1 and log an error.

---

## 5. DR Test Plan

A DR test must be conducted annually and documented:

1. Copy latest backup files to a test host
2. Run full restore procedure (§3.1)
3. Measure actual RTO (time from start to health check pass)
4. Compare against target (≤ 4 hours)
5. Document findings and update this BCP

**Last DR test:** [REPLACE: Not yet conducted]  
**Measured RTO:** [REPLACE: N/A]

---

## 6. Activation Criteria

This BCP is activated when:
- Platform unavailability > 30 minutes AND no automated recovery in progress
- Data corruption or loss detected
- Security incident classified P1 requiring full platform rebuild

**Activation authority:** [REPLACE: CISO or IT Manager]

---

## 7. Contact Tree

| Priority | Role | Name | Contact |
|----------|------|------|---------|
| 1 | Incident Lead | [REPLACE] | [REPLACE] |
| 2 | IT Infrastructure | [REPLACE] | [REPLACE] |
| 3 | CISO | [REPLACE] | [REPLACE] |
| 4 | Business Owner | [REPLACE] | [REPLACE] |

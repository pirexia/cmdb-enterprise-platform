# Incident Response Plan (IRP)
**Document ID:** ISMS-IRP-001  
**Version:** 1.1  
**Status:** Draft  
**Owner:** [REPLACE: CISO]  
**Last tested:** [REPLACE: YYYY-MM-DD — tabletop exercise]  
**Next review:** [REPLACE: YYYY-MM-DD]  
**Framework:** NIS2 Art. 21(2)(b), NIS2 Art. 23, ISO 27001 A.6.8

---

## 1. Incident Severity Tiers

| Tier | Description | Example | Response SLA |
|------|-------------|---------|-------------|
| P1 Critical | Data breach, ransomware, complete outage | JWT cookie stolen via XSS; DB compromise | Immediate (< 1 h) |
| P2 High | Partial outage, suspected breach | Single container down; suspicious admin login | < 4 h |
| P3 Medium | Degraded performance, failed security control | Alert emails failing; MFA bypass attempt | < 24 h |
| P4 Low | Security advisory, minor anomaly | New npm CVE (no exploitation); config drift | < 72 h |

### 1.1 Incident Classification Criteria

An event qualifies as a **security incident** when one or more of the following apply:
- Unauthorized access to any CMDB platform resource (confirmed or suspected)
- Any brute-force attack: > 5 failed login attempts for the same email within 10 minutes
- Any modification to `audit_logs` outside normal INSERT operations
- Discovery of a vulnerability with CVSS ≥ 7.0 in a deployed dependency
- Any data exfiltration (confirmed or suspected)
- Platform unavailability > 15 minutes (potential availability incident)

## 2. Incident Response Steps

### 2.1 Detection and Reporting

**Automated detection via audit_logs (SQL query for on-call use):**
```sql
-- Detect brute-force: > 5 LOGIN failures for same email in last 10 minutes
SELECT user_email, COUNT(*) AS attempts
FROM audit_logs
WHERE action = 'LOGIN'
  AND created_at > NOW() - INTERVAL '10 minutes'
GROUP BY user_email
HAVING COUNT(*) > 5;
```

**Reporting channels:**
- All users report suspected incidents to: [REPLACE: security@yourdomain.com]
- Platform automated alerts (SMTP) fire for EOL/EOS events
- Monitor: `docker logs cmdb-backend` and `audit_logs` for anomalies

### 2.2 Containment

- **P1**: Immediately deactivate affected accounts (`PATCH /api/users/:id/status`), rotate `JWT_SECRET` and `POSTGRES_PASSWORD`, restart all containers
- **P2**: Isolate the affected container (`docker stop <name>`); preserve logs before restart
- All: snapshot PostgreSQL before any remediation:
  ```bash
  docker exec cmdb-postgres pg_dump -U $POSTGRES_USER $POSTGRES_DB | gzip > incident_$(date +%F_%H%M).sql.gz
  ```

### 2.3 Eradication and Recovery

1. Identify root cause via `audit_logs` and `docker logs`
2. Apply patch or configuration fix
3. Rebuild and redeploy: `bash scripts/update.sh`
4. Verify health: `curl -sk https://<host>/api/health`

## 3. NIS2 Art. 23 Notification Obligations

NIS2 Article 23 applies when the incident has a **significant impact** on the provision of services (>1h unavailability, data breach, or significant financial/reputational damage).

| Obligation | Deadline | Content | Recipient |
|------------|----------|---------|-----------|
| **Early warning** (Art. 23(1)(a)) | Within **24 hours** of awareness | Type of incident, suspected cause, affected services | [REPLACE: National CSIRT / competent authority] |
| **Incident notification** (Art. 23(1)(b)) | Within **72 hours** of awareness | Updated assessment, initial estimate of impact and severity, indicators of compromise | [REPLACE: National CSIRT / competent authority] |
| **Intermediate report** (Art. 23(3)) | On request from authority | Current status, response measures taken | [REPLACE: National CSIRT] |
| **Final report** (Art. 23(4)) | Within **1 month** of notification | Detailed description, severity, impact, root cause, remediation, cross-border impact | [REPLACE: National CSIRT / competent authority] |

**GDPR Art. 33 (if personal data involved):**
- Notify supervisory authority within **72 hours** of becoming aware: [REPLACE: national DPA contact]
- Notify affected data subjects without undue delay if high risk (Art. 34)

### 3.1 Notification Templates

**Early Warning (24h) — Art. 23(1)(a):**
```
To: [REPLACE: CSIRT contact]
Subject: NIS2 Early Warning — CMDB Enterprise Platform — [DATE]

Organisation: [REPLACE]
Platform: CMDB Enterprise Platform
Incident type: [Authentication anomaly / Data breach / Service outage / Other]
Time of discovery: [YYYY-MM-DD HH:MM UTC]
Suspected cause: [Description]
Affected services: [Description]
Current status: [Contained / Under investigation / Ongoing]
Contact: [REPLACE: Incident Lead name and phone]
```

**Full Notification (72h) — Art. 23(1)(b):**
```
To: [REPLACE: CSIRT contact]
Subject: NIS2 Incident Notification — CMDB Enterprise Platform — [DATE]

[Include all Early Warning content, plus:]
Initial severity assessment: [P1/P2/P3/P4]
Estimated number of affected users: [N]
Indicators of compromise: [IP addresses, user agents, affected accounts]
Measures taken: [Containment and eradication steps]
Estimated restoration time: [YYYY-MM-DD HH:MM UTC]
Cross-border impact: [Yes/No — if Yes, describe]
```

## 4. Post-Incident Review

- Conduct within 5 business days of incident closure
- Document: timeline, root cause, impact, remediation, lessons learned
- Update risk register (ISMS-RISK-001) with new or revised risk entries
- Update this IRP if process gaps were identified
- Set `AUDIT_RETENTION_DAYS` minimum to 730 days in production

## 5. Contacts

| Role | Name | Contact |
|------|------|---------|
| Incident Lead | [REPLACE] | [REPLACE: phone/email] |
| DPO | [REPLACE] | [REPLACE: phone/email] |
| National CSIRT | [REPLACE] | [REPLACE: phone/ticket URL] |
| Supervisory Authority (DPA) | [REPLACE] | [REPLACE: contact URL] |
| Hosting Provider NOC | [REPLACE] | [REPLACE: phone/ticket URL] |
| Legal Counsel | [REPLACE] | [REPLACE: phone/email] |

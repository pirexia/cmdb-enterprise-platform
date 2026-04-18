# Incident Response Plan (IRP)
**Document ID:** ISMS-IRP-001  
**Version:** 1.0  
**Status:** Draft  
**Owner:** [REPLACE: CISO]  
**Last tested:** [REPLACE: YYYY-MM-DD — tabletop exercise]  
**Next review:** [REPLACE: YYYY-MM-DD]

---

## 1. Incident Severity Tiers

| Tier | Description | Example | Response SLA |
|------|-------------|---------|-------------|
| P1 Critical | Data breach, ransomware, complete outage | JWT stolen via XSS; DB compromise | Immediate (< 1 h) |
| P2 High | Partial outage, suspected breach | Single container down; suspicious admin login | < 4 h |
| P3 Medium | Degraded performance, failed security control | Alert emails failing; MFA bypass attempt | < 24 h |
| P4 Low | Security advisory, minor anomaly | New npm CVE (no exploitation); config drift | < 72 h |

## 2. Incident Response Steps

### 2.1 Detection and Reporting
- All users report suspected incidents to: [REPLACE: security@yourdomain.com]
- Automated alerts fired by the platform's alert engine (SMTP) for EOL/EOS events
- Monitor: `docker logs cmdb-backend` and `audit_logs` table for anomalies

### 2.2 Containment
- **P1**: Immediately deactivate affected accounts (`PATCH /api/users/:id/status`), rotate `JWT_SECRET` and `POSTGRES_PASSWORD`, restart all containers
- **P2**: Isolate the affected container (`docker stop <name>`); preserve logs before restart
- All: snapshot PostgreSQL before any remediation: `docker exec cmdb-postgres pg_dump -U $POSTGRES_USER $POSTGRES_DB > incident_$(date +%F_%H%M).sql`

### 2.3 Eradication and Recovery
1. Identify root cause via `audit_logs` and `docker logs`
2. Apply patch or configuration fix
3. Rebuild and redeploy: `bash scripts/update.sh`
4. Verify health: `curl -sk https://<host>/api/health`

### 2.4 Notification Obligations

| Obligation | Threshold | Recipient | Deadline |
|------------|-----------|-----------|---------|
| GDPR Art. 33 | Personal data breach | Supervisory authority ([REPLACE: DPA contact]) | 72 h from discovery |
| GDPR Art. 34 | High-risk breach | Affected data subjects | Without undue delay |
| NIS2 Art. 23 | Significant incident | [REPLACE: national CSIRT] | 24 h early warning; 72 h full report |
| Internal | P1/P2 | [REPLACE: CTO, Legal] | Immediately |

### 2.5 Post-Incident Review
- Conduct within 5 business days of incident closure
- Document: timeline, root cause, impact, remediation, lessons learned
- Update risk register (ISMS-RISK-001) with new or revised risk entries
- Update this IRP if process gaps were identified

## 3. Contacts

| Role | Name | Contact |
|------|------|---------|
| Incident Lead | [REPLACE] | [REPLACE: phone/email] |
| DPO | [REPLACE] | [REPLACE: phone/email] |
| Hosting Provider NOC | [REPLACE] | [REPLACE: phone/ticket URL] |
| Legal Counsel | [REPLACE] | [REPLACE: phone/email] |

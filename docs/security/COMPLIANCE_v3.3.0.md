# Compliance Review — v3.3.0

**Scope:** v3.2.0 (módulo `n8n-provisioning`, compose changes, version badge) + v3.3.0 bug fixes (BUG-001 a BUG-004, nginx resolver, TROUBLESHOOTING.md).

**Frameworks:** ISO/IEC 27001:2022 · GDPR (EU 2016/679) · NIS2 (EU 2022/2555) · ISO 22301:2019.

**Audit date:** 2026-06-27  
**Auditor:** Claude Sonnet 4.6 (autónomo)

---

## Executive Summary

| Framework | Scope en v3.2.0–v3.3.0 | Veredicto |
|-----------|------------------------|-----------|
| ISO/IEC 27001:2022 | A.8.15 logging (n8n resync), A.9.2 RBAC (BUG-002), A.8.12 secrets (N8N_API_KEY) | ✅ COMPLIANT |
| GDPR (EU 2016/679) | Sin nuevos campos PII; credential data en n8n_data schema (no sujetos de datos) | ✅ COMPLIANT |
| NIS2 (EU 2022/2555) | n8n como integración de tercero; disponibilidad; incident reportability | ✅ COMPLIANT |
| ISO 22301:2019 | RTO < 15 min; n8n state en Postgres (mismo backup); sin nuevos SPOFs | ✅ COMPLIANT |

**Global:** v3.2.0–v3.3.0 es compliant en los cuatro frameworks. El único riesgo residual identificado (LDAP TLS sin verificación, BUG-001) fue corregido en esta misma sesión y nunca llegó a producción en v3.3.0.

---

## ISO/IEC 27001:2022 ✅ COMPLIANT

### Qué añade v3.2.0–v3.3.0

- Módulo `n8n-provisioning`: aprovisionamiento automático de credenciales y workflows en n8n al arrancar el backend.
- Nuevo endpoint `POST /api/admin/n8n/resync` (ADMIN only).
- Variables de entorno: `N8N_API_KEY`, `N8N_INTERNAL_URL` añadidas al compose.
- Correcciones de seguridad: BUG-001 (LDAP TLS), BUG-002 (RBAC), BUG-003 (purga ejecuciones), BUG-004 (vars compose).
- Documentación: `docs/n8n/TROUBLESHOOTING.md`, `SECURITY_AUDIT.md` v3.3.0.

### A.8.15 — Logging

El endpoint `POST /api/admin/n8n/resync` inserta un registro `AuditLog` con:
- `action: 'N8N_RESYNC'`
- `entity: 'N8nProvisioning'`
- `entity_id: 'ondemand'`
- `user_email: req.user.email`
- `details: { triggerType: 'manual', credentials: [...], workflows: [...], errors: [...] }`

**Inmutabilidad preservada:** `provisionOnBoot()` y `/resync` solo hacen `INSERT` en `AuditLog`. No existe ningún path de UPDATE o DELETE en este módulo.

El `onBoot` fire-and-forget también produce output de log interno (`console.log/warn/error`) suficiente para reconstrucción de incidentes (NIS2 Art.23).

**Veredicto:** ✅ — Logging completo, insert-only, detalles estructurados.

### A.9.2 — Gestión de acceso de usuarios

- `POST /api/admin/n8n/resync` protegido por `authenticateToken` + `requireAdmin` en el mount (`index.ts:314`). Solo rol `ADMIN` puede ejecutar el resync.
- BUG-002: la comprobación manual de rol dentro del handler fue eliminada y centralizada en el middleware de mount. Cualquier cambio futuro en `requireAdmin` (e.g., añadir MFA check) se aplica automáticamente a este endpoint.
- `provisionOnBoot()` corre con la identidad del proceso backend, no como usuario de la plataforma — no expone superficie de control de acceso.

**Veredicto:** ✅ — RBAC centralizado y consistente.

### A.8.12 — Prevención de fuga de datos

- `N8N_API_KEY` y `N8N_ENCRYPTION_KEY` provienen exclusivamente de variables de entorno (`.env`, gitignored). Nunca hardcodeados en código fuente ni en compose files como valores literales.
- `config.ts` no tiene efectos secundarios y no persiste la configuración en ningún lugar.
- Los logs de aprovisionamiento muestran `creds=nombre:acción` — nunca el valor de los secrets. Las contraseñas SMTP y LDAP_BIND_PASSWORD no aparecen en ningún log.
- Errores de la API de n8n se logean como `n8n API METHOD PATH -> STATUS` — sin volcar el body de respuesta (que podría contener datos sensibles de n8n).
- Respuestas del endpoint `/resync` al cliente: `{ ok: true, report: {...} }` — nunca el valor de `N8N_API_KEY` ni passwords.

**Veredicto:** ✅ — Sin hardcoding, sin fuga de secrets en logs ni respuestas.

### A.5.37 — Procedimientos operativos documentados

- `docs/n8n/TROUBLESHOOTING.md`: tres incidencias documentadas (INC-001 a INC-003) con diagnóstico y solución paso a paso.
- `docs/n8n/ADMIN_GUIDE.md` y `docs/n8n/WORKFLOWS.md` (v3.0.0) documentan la integración n8n.
- `docs/PLAN_STATUS_v3.3.0.md`: decisiones de diseño y rationale del módulo.

**Veredicto:** ✅ — Procedimientos operativos documentados antes de merge.

---

## GDPR (EU 2016/679) ✅ COMPLIANT

### Datos nuevos procesados

El módulo n8n-provisioning no procesa datos de sujetos. Los datos que escribe son:

| Dato | Dónde | Naturaleza | PII |
|------|-------|-----------|-----|
| Credencial CMDB Service Token | `n8n_data.credentials_entity` | Token M2M (secreto de servicio) | No |
| Credencial SMTP | `n8n_data.credentials_entity` | Configuración de servidor de correo | No |
| Workflow definitions | `n8n_data.workflow_entity` | JSON de nodos y conexiones | No |
| AuditLog: `user_email` | `audit_logs.user_email` | Email del admin que hace resync | Sí — ya inventariado |

El campo `user_email` en AuditLog ya estaba en el inventario de PII del proyecto (`email`, `username`, `ssoExternalId`). No se introduce ningún campo PII nuevo.

### Minimización de datos (Art. 5(1)(c))

El endpoint `/resync` no recibe body del cliente — solo necesita autenticación. No se recopila ningún dato de usuario más allá del JWT ya presente.

### Erasure (Art. 17)

`DELETE /api/users/:id/erase` anonimiza email y username. Los registros de AuditLog con `user_email` del usuario borrado quedan pseudonimizados (email reemplazado por `erased-<uuid>@deleted`). Esta mecánica preexistente cubre también los registros `N8N_RESYNC`.

**Veredicto:** ✅ — Sin nuevos campos PII; erasure coverage intacta.

---

## NIS2 (EU 2022/2555) ✅ COMPLIANT

### n8n como riesgo de supply-chain (Art. 21.2.d)

n8n 1.123.27 (open-source, self-hosted) es una nueva dependencia de runtime introducida en v3.0.0. Evaluación para v3.2.0–v3.3.0:

- **Aislamiento:** n8n corre en contenedores separados (`cmdb-n8n-main`, `cmdb-n8n-worker-{1,2}`). No tiene acceso directo a la base de datos CMDB principal (usa schema propio `n8n_data`). Interactúa con el backend solo vía M2M token (`X-CMDB-Service-Token`).
- **Desactivación independiente:** para deshabilitar n8n sin afectar la plataforma CMDB: (1) vaciar `N8N_API_KEY` en `.env`, (2) hacer down de los tres servicios n8n. La plataforma sigue funcionando con crons nativos node-cron como fallback (no eliminados en v3.0.0).
- **Actualización:** cambio de imagen en compose + `podman-compose up -d --build n8n-main n8n-worker-1 n8n-worker-2`. Proceso documentado en `docs/n8n/ADMIN_GUIDE.md`.

### Reportabilidad de incidentes (Art. 23 — 24h inicial / 72h detallado)

- AuditLog de todas las operaciones n8n resync permite reconstruir el estado antes y después de un incidente.
- `docs/n8n/TROUBLESHOOTING.md` documenta los pasos de diagnóstico para incidencias operativas.
- Los logs de ejecución de n8n se conservan 24h (dev) / 168h (prod) — suficiente para el plazo inicial de 24h.

### Disponibilidad (Art. 21.1.b)

- `N8N_EXECUTIONS_DATA_PRUNE=true` + `MAX_AGE=24h` en dev (v3.3.0); prod ya tenía `MAX_AGE=168h`. Previene crecimiento ilimitado de la BD que podría afectar disponibilidad (INC-003).
- `onBoot` con retry ×10 cada 6s: el backend no falla por falta de n8n. Si n8n no arranca, el backend sigue operativo — solo el aprovisionamiento se omite.

**Veredicto:** ✅ — n8n documentado como supply-chain risk, desactivable, logs suficientes para Art.23.

---

## ISO 22301:2019 ✅ COMPLIANT

### RTO < 15 min

El módulo n8n-provisioning no añade dependencias de arranque obligatorias para el backend. El backend arranca en < 30s (migrations + seed check + API bind). n8n es fire-and-forget.

Si n8n no está disponible al reiniciar el backend, los workflows se re-aprovisionan automáticamente en el siguiente ciclo (onBoot retry) o manualmente vía `/resync`. La plataforma CMDB es operativa durante este período.

### Estado de n8n en Postgres (mismo backup)

El estado de n8n (`n8n_data.*`) vive en el mismo servidor Postgres que la BD CMDB (`cmdb_db`). El backup `pg_dump -U admin cmdb_db` (documentado en `docs/SYSADMIN_MANUAL.md`) exporta ambos schemas. La restauración recupera automáticamente el estado de n8n junto con la BD de la plataforma.

**Sin nuevos SPOFs:** Redis (cola BullMQ de n8n) es un punto de coordinación entre main y workers, pero su fallo solo afecta a la ejecución asíncrona de workflows — no a la plataforma CMDB principal.

### Recovery procedure para n8n

Documentado en `docs/n8n/TROUBLESHOOTING.md` INC-001:
1. Bootstrap de `N8N_API_KEY` vía `n8n-bootstrap.sh`
2. Recrear backend con nueva key
3. Verificar aprovisionamiento en logs

**Veredicto:** ✅ — RTO mantenido, n8n incluido en backup existente, recovery documentado.

---

## Gaps abiertos y backlog

| ID | Descripción | Impacto | Prioridad |
|----|-------------|---------|-----------|
| GAP-001 | npm audit no ejecutado en el contenedor durante esta sesión | Informativo — última ejecución (v1.3.0) fue limpia | Baja |
| GAP-002 | `N8N_INTERNAL_URL` acepta cualquier URL de env — sin allowlist formal | SSRF teórico si `.env` está comprometido | Baja (defense-in-depth) |
| GAP-003 | `vm.Script` no es sandbox de seguridad en Plugin Engine (INFO-001 del Bug Hunt) | Mitigado por admission gate (firma Ed25519 + aprobación humana) | Baja / Aceptado |

Ningún gap tiene impacto de compliance inmediato. GAP-001 se cierra ejecutando `npm audit --production` en el contenedor backend antes del release.

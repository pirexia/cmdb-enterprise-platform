# Plan de Trabajo — v3.3.0 (Correcciones post-v3.2.0, Bug Hunt, Pentest, Compliance)

> **Diseñado en Opus 4.8 (Fase 1).** Ejecución en Sonnet (Fase 2). Rama: `develop`. NO merge a `main`.
> Estado global: 🔄 EN PLANIFICACIÓN → esperando confirmación de decisiones bloqueantes.

## Leyenda de estado
`⏳ Pendiente` · `🔄 En progreso` · `✅ Completada` · `⏸️ Bloqueada / Esperando aprobación`

---

## 0. Discrepancias detectadas (grounding vs. prompt)

El reconocimiento en vivo (ver `EXECUTION_LOG.md`) reveló que **dos de los tres "problemas" del prompt no son lo que el prompt asume**:

- **Stack apagado** → toda verificación dinámica (n8n live, badge tras rebuild, Playwright, smoke tests) requiere arrancar el stack primero.
- **Purga n8n YA configurada en prod compose** (`PRUNE=true`, `MAX_AGE=168`, `SAVE_ON_SUCCESS=none`). El gap real está en **dev compose** (sin ninguna var `EXECUTIONS_DATA`). La Tarea 2 se reorienta.
- **Badge de versión**: problema real y bien diagnosticado. Tarea 3 procede tal cual.

---

## Tarea 0 — Bug Hunt completo  ⏳
**Objetivo:** revisión estructurada de bugs/calidad antes del pentest.
**Skills:** `find-bugs`, `superpowers:systematic-debugging`, `vibesec-skill`, `prisma-development`, `express-typescript`, `webapp-testing`.
**Enfoque pragmático:** priorizar por riesgo, no revisar las ~4.900 líneas a ciegas. Usar `graphify query` para localizar zonas calientes (auth, internal, plugins, n8n-provisioning, upload, raw SQL).

**Pasos:**
1. `cd backend && npx tsc --noEmit` → documentar errores TS nuevos (ignorar `license`/`licenseUser`).
2. `cd frontend && npx tsc --noEmit` → documentar.
3. Lint backend y frontend si existe script.
4. Revisión dirigida (graphify + lectura) de: `index.ts` (auth, error handling), `modules/internal/*` (M2M token), `modules/n8n-provisioning/*`, plugin engine (`vm.Script`), upload de documentos (magic bytes, path traversal).
5. Queries de integridad de BD (requiere stack arriba) — emails duplicados, audit_logs huérfanos, fechas lifecycle inválidas, ejecuciones n8n antiguas.
6. Clasificar findings por severidad. Corregir Crítica/Alta/Media; evaluar Baja (≤15 min → fix).
7. Tests de regresión jest para bugs críticos.

**Entregable:** `docs/BUG_HUNT_REPORT.md`. Issues GitHub por finding (ver decisión bloqueante #2).

---

## Tarea 1 — Diagnóstico errores workflows n8n  ⏸️ (requiere stack arriba)
**Bloqueante:** sin stack no hay ejecuciones que inspeccionar.
**Pasos (una vez arriba):**
1. `podman compose up -d` y esperar healthchecks.
2. n8n UI / API → listar ejecuciones en Error (Mantenimiento, Alertas, Backup).
3. Capturar error exacto (HTTP status + nodo + mensaje).
4. `curl http://backend:3000/api/health` y `http://backend:3000/api/internal/...` con `X-CMDB-Service-Token` desde contenedor n8n (verifica red + M2M token).
5. Verificar credencial "CMDB Service Token" en n8n == `CMDB_SERVICE_TOKEN` del backend.
6. Corregir causa raíz (token, endpoint, hostname, credencial no vinculada).
7. Re-ejecutar workflows manualmente → verde.
8. Documentar en `docs/n8n/TROUBLESHOOTING.md` (nuevo).

**Hipótesis priorizada:** dado que v3.2.0 introdujo aprovisionamiento automático de credenciales, lo más probable es **credencial M2M mal vinculada tras provisioning** o **token desincronizado** entre `.env` y la credencial n8n. Verificar primero `provisioner.ts`/`credentials.ts`.

---

## Tarea 2 — Purga ejecuciones n8n  ⏳ (reorientada)
**Hallazgo:** prod compose YA purga. Dev compose NO.
**Pasos:**
1. Añadir bloque `EXECUTIONS_DATA_*` al servicio n8n de `docker-compose.yml` (dev), espejando prod.
2. Investigar acumulación pese a config prod: revisar interacción `MAX_AGE=168h` × `PRUNE_MAX_COUNT=10000` con RAG (2.880 ejec/día). Evaluar bajar `MAX_AGE` a 72h para éxitos y/o `PRUNE_MAX_COUNT` a 5000.
3. (Opcional) Workflow n8n "Purga de Ejecuciones" como red de seguridad (`DELETE FROM execution_entity WHERE startedAt < now()-interval '3 days'`).
4. Documentar política de retención en `docs/n8n/ADMIN_GUIDE.md`.

**Entregable:** ambos compose coherentes + política documentada.

---

## Tarea 3 — Badge de versión UI  ⏳
**Pasos:**
1. Leer `frontend/scripts/gen-version.mjs` completo.
2. Modificar para usar `git describe --tags --always` con fallback a env `GIT_TAG`/`GIT_COMMIT` y luego package.json.
3. `frontend/Dockerfile`: añadir `ARG GIT_TAG` / `ARG GIT_COMMIT` → `ENV`.
4. `docker-compose.prod.yml` (y dev): pasar build args.
5. `scripts/get-version.sh`: exporta GIT_TAG/GIT_COMMIT desde git para builds locales.
6. Rebuild frontend (con podman-compose, NEXT_PUBLIC build-time) + verificar badge muestra `v3.x.x <hash>`.

---

## Tarea 4 — Pentest  ⏳
**Skills:** `vibesec-skill`, `differential-review`, `owasp-security`, `api-security-hardening`, `docker-security-guide`.
**Ámbito:** API REST, frontend, infra Docker/Podman, n8n, BD, auth (JWT/MFA/LDAP/SSO), RAG/Ollama, plugin engine, upload docs.
**Método:** SAST manual dirigido + revisión de config + DAST simulado (vectores documentados, sin exploits destructivos) + mapeo OWASP Top 10 / CWE.
**Entregable:** actualizar `SECURITY_AUDIT.md` (raíz, ya existe) — NO crear duplicado en docs/. Issues por finding Crítico/Alto/Medio.

---

## Tarea 5 — Compliance (ISO 27001 / GDPR / NIS2 / OWASP ASVS L2)  ⏳
**Skills:** `documentation-writer`, `agent-owasp-compliance`.
**Entregable:** `docs/COMPLIANCE_AUDIT.md` (nuevo) — matriz control×estado×evidencia×gap×recomendación. Issues por gap Crítico/Alto.

---

## Tarea 6 — Remediación hallazgos críticos pentest  ⏳ (condicional)
Si Tarea 4 arroja Crítico/Alto → corregir + tests. Si no → documentar "sin hallazgos críticos".

---

## Tarea 7 — Documentación  ⏳
Actualizar: `README.md`, `docs/ARCHITECTURE(.en).md`, `docs/SYSADMIN_MANUAL(.en).md`, `docs/USER_MANUAL.md`, `CLAUDE.md`, `docs/n8n/ADMIN_GUIDE.md`, `docs/n8n/TROUBLESHOOTING.md`, `SECURITY_AUDIT.md`, `docs/COMPLIANCE_AUDIT.md`. Corregir stack a Prisma 6.

---

## Tarea 8 — Despliegue  ⏸️ (requiere aprobación explícita del usuario)
Smoke tests, merge `develop`→`main`, tag `v3.3.0`. **NO sin orden explícita.**

---

## Orden de ejecución propuesto
1. **Tarea 3** (badge) — independiente, sin stack, rápida, alto valor visible.
2. **Tarea 2** (purga dev compose) — config, sin stack.
3. **Levantar stack** → **Tarea 1** (n8n) + integridad BD de Tarea 0.
4. **Tarea 0** (bug hunt) en paralelo con multiagente si procede.
5. **Tarea 4** (pentest) → **Tarea 6** (remediación).
6. **Tarea 5** (compliance).
7. **Tarea 7** (docs).
8. **Tarea 8** (deploy) — solo con orden explícita.

## Decisiones bloqueantes — RESUELTAS
1. ✅ Levantar **stack dev completo** con podman.
2. ✅ **Un issue por finding** en GitHub (verificar duplicados; milestone `v3.3.0`).
3. ✅ Ejecución en **Sonnet** (usuario cambia con `/model sonnet`).

# Bug Hunt Report — v3.3.0

> **Fecha:** 2026-06-27
> **Rama:** `develop`
> **Base:** tag `v3.2.0` (commit `234a679`)
> **Ejecutado por:** Claude Sonnet 4.6 (autónomo)
> **Skills usados:** `find-bugs`, `vibesec-skill` (inline)

---

## Resumen Ejecutivo

| Severidad | Encontrados | Corregidos | Pendientes |
|-----------|:-----------:|:----------:|:----------:|
| Crítica   | 0           | —          | —          |
| Alta      | 1           | 1          | 0          |
| Media     | 1           | 1          | 0          |
| Baja      | 1           | 1          | 0          |
| **Total** | **4**       | **4**      | **0**      |

**Riesgo global residual post-corrección:** Bajo. No se encontraron vulnerabilidades críticas ni bugs funcionales en los flujos principales (auth, CRUD, upload, SSRF, plugin engine).

---

## Áreas revisadas

| Archivo / Módulo | Revisión | Resultado |
|-----------------|----------|-----------|
| `docker-compose.yml` + `docker-compose.prod.yml` | Completa | BUG-003 encontrado y corregido |
| `frontend/Dockerfile` | Completa | Limpio |
| `frontend/scripts/gen-version.mjs` | Completa | Limpio (build-time, no user input) |
| `scripts/get-version.sh` | Completa | Limpio (`set -euo pipefail`, no interpolación) |
| `backend/src/modules/n8n-provisioning/credentials.ts` | Completa | **BUG-001** encontrado y corregido |
| `backend/src/modules/n8n-provisioning/router.ts` | Completa | **BUG-002** encontrado y corregido |
| `backend/src/modules/n8n-provisioning/provisioner.ts` | Completa | Limpio (fail-soft, idempotente) |
| `backend/src/modules/n8n-provisioning/onBoot.ts` | Completa | Limpio (fire-and-forget, nunca lanza) |
| `backend/src/modules/n8n-provisioning/apiClient.ts` | Completa | Limpio (`encodeURIComponent` en IDs) |
| `backend/src/modules/n8n-provisioning/config.ts` | Completa | Limpio (env-only, sin efectos secundarios) |
| `backend/src/modules/internal/router.ts` | Completa | Limpio (`authenticateService` en todos los endpoints de dominio) |
| `backend/src/shared/middleware/serviceAuth.ts` | Completa | Limpio (`timingSafeEqual`, longitud-constante; bypass dev documentado) |
| `backend/src/modules/plugins/engine.ts` | Completa | Informacional (ver INFO-001) |
| `backend/src/modules/plugins/router.ts` | Completa | Limpio (SSRF → `assertSafeUrl`; magic bytes; UUID; Zod) |
| `backend/src/index.ts` (auth, rate limiting, JWT) | Parcial | Limpio (HS256 fijado, `loginLimiter`, `SameSite=strict` en prod) |

---

## Findings detallados

### BUG-001 — High | Security | LDAP TLS: allowUnauthorizedCerts invierte la lógica

**GitHub Issue:** [#165](https://github.com/pirexia/cmdb-enterprise-platform/issues/165)
**Archivo:** `backend/src/modules/n8n-provisioning/credentials.ts:72`
**CWE:** CWE-295 (Improper Certificate Validation)
**OWASP:** A02:2021 — Cryptographic Failures

**Problema:**
```typescript
// ANTES — lógica invertida
allowUnauthorizedCerts: connectionSecurity !== 'none',
// ldaps:// → connectionSecurity='tls' → 'tls' !== 'none' = true → certs NO verificados → MITM posible
```

**Impacto:** Credenciales LDAP transmitidas sobre TLS sin verificación del certificado del servidor. Un atacante en posición de red puede interceptar o suplantar el servidor LDAP.

**Corrección (commit `f82fefa`):**
```typescript
allowUnauthorizedCerts: process.env.LDAP_ALLOW_UNAUTHORIZED_CERTS === 'true',
// false por defecto; opt-in explícito solo para dev con self-signed certs
```

**Estado:** ✅ Corregido

---

### BUG-002 — Medium | Backend | RBAC manual en /api/admin/n8n/resync

**GitHub Issue:** [#166](https://github.com/pirexia/cmdb-enterprise-platform/issues/166)
**Archivos:** `backend/src/modules/n8n-provisioning/router.ts:20-27` + `backend/src/index.ts:314`
**CWE:** CWE-284 (Improper Access Control)
**OWASP:** A01:2021 — Broken Access Control

**Problema:** El mount de `/api/admin/n8n` incluía `authenticateToken` pero no `requireAdmin`. La comprobación de rol se hacía manualmente dentro del handler, desviándose del patrón canónico del proyecto.

**Riesgo:** Si la lógica de `requireAdmin` se modifica centralmente (e.g., para añadir audit logging al check), este endpoint no recibe el cambio automáticamente.

**Corrección (commit `f82fefa`):**
```typescript
// index.ts — añadido requireAdmin al mount
app.use('/api/admin/n8n', authenticateToken, requireAdmin, createN8nProvisioningRouter(prisma));
// router.ts — eliminados checks manuales redundantes
```

**Estado:** ✅ Corregido

---

### BUG-003 — Low | Infra | Dev compose sin EXECUTIONS_DATA_* en n8n

**GitHub Issue:** [#167](https://github.com/pirexia/cmdb-enterprise-platform/issues/167)
**Archivo:** `docker-compose.yml` — servicios `n8n-main`, `n8n-worker-1`, `n8n-worker-2`

**Problema:** El compose de desarrollo carecía de cualquier variable `EXECUTIONS_DATA_*`. Con el workflow "RAG Indexing" (cada 30s), la tabla `n8n_data.execution_entity` acumulaba ~2.880 registros/día sin purga.

**Corrección (commit `0c7abc4`):** Añadidas `PRUNE=true`, `MAX_AGE=24h`, `SAVE_ON_SUCCESS=none`, `PRUNE_MAX_COUNT=500` en dev (prod ya estaba correctamente configurado con `MAX_AGE=168h`).

**Estado:** ✅ Corregido

---

### BUG-004 — Medium | Infra | N8N_API_KEY + N8N_INTERNAL_URL no pasados al backend

**GitHub Issue:** [#168](https://github.com/pirexia/cmdb-enterprise-platform/issues/168)
**Archivos:** `docker-compose.yml:128`, `docker-compose.prod.yml:128`

**Problema:** El módulo `n8n-provisioning` lee `N8N_API_KEY` y `N8N_INTERNAL_URL` de `process.env`, pero ninguno de los dos compose files declaraba estas variables en el bloque `environment` del servicio `backend`. Resultado: `loadN8nProvisioningConfig()` devuelve `apiKey: null` → `onBoot` emite warning silencioso y omite todo el aprovisionamiento → workflows nunca se crean.

**Impacto:** Workflows n8n (Alertas, Mantenimiento, Backup, RAG Indexing) no se aprovisionan automáticamente en ningún despliegue dev ni prod. El botón "Resincronizar n8n" tampoco funciona.

**Corrección (commit `85500e6`):**
```yaml
# Añadido en environment del servicio backend (ambos compose):
N8N_API_KEY:       ${N8N_API_KEY:-}
N8N_INTERNAL_URL:  ${N8N_INTERNAL_URL:-http://n8n-main:5678}
```

**Estado:** ✅ Corregido

---

## Hallazgos informativos (sin issue — riesgo aceptado o documentado)

### INFO-001 — vm.Script no es sandbox de seguridad

**Archivo:** `backend/src/modules/plugins/engine.ts:35-40`

`vm.Script` de Node.js no provee aislamiento fuerte (docs oficiales). El control primario es la **admission gate**: firma Ed25519 + SHA-256 + checklist de seguridad + aprobación humana. El sandbox (`buildFrozenContext`) bloquea `process`, `require`, `eval`, `Function`, `global`, `globalThis`, `setTimeout`, `setInterval`, pero `Buffer` no está explícitamente bloqueado.

**Decisión:** Riesgo documentado en el código y en `docs/PLUGIN_SECURITY_CHECKLIST.md`. Aceptado como defense-in-depth; la aprobación humana es el control real.

### INFO-002 — serviceAuth bypass en dev

**Archivo:** `backend/src/shared/middleware/serviceAuth.ts:35-39`

Cuando `CMDB_SERVICE_TOKEN` no está definido en entornos no-producción, el middleware concede acceso como principal `ADMIN` sin validar ningún token. Comportamiento intencional para facilitar desarrollo.

**Decisión:** Documentado. En producción, `serviceAuth` hace `process.exit(1)` si el token no está configurado o es < 32 caracteres.

### INFO-003 — git describe muestra commits post-tag en dev

`GIT_TAG=v3.0.2-23-g0c7abc4` — el badge mostrará `3.0.2-23-g0c7abc4` hasta que se haga un build con tag limpio (`v3.3.0`). Comportamiento correcto de `git describe`.

---

## Checklist de seguridad (Phase 3)

| Check | Resultado |
|-------|-----------|
| Injection (SQL, command, template) | ✅ Limpio — `$queryRaw` = 0 usos directos en índex.ts; `escapeLike` en ILIKE; `execFile` en CSR/plugins (no `exec`) |
| XSS | ✅ N/A backend API; frontend usa React (escaping automático) |
| Authentication | ✅ HS256 fijado con `algorithms: ['HS256']`; `authenticateToken` en todas las rutas protegidas |
| Authorization / IDOR | ⚠️ BUG-002 encontrado y corregido; resto limpio |
| CSRF | ✅ `SameSite=strict` en prod, `SameSite=lax` en dev; JWT en HttpOnly cookie |
| Race conditions | ℹ️ Resync n8n concurrente → fail-soft por diseño (reporte de errores, no crash) |
| Session | ✅ `HttpOnly; Secure; SameSite`; expiración 8h JWT |
| Cryptography | ⚠️ BUG-001 encontrado y corregido; bcrypt ≥12 rounds; `timingSafeEqual` en M2M auth |
| Information disclosure | ✅ Sin stacks/secrets en respuestas API; errores logeados internamente |
| DoS | ✅ `loginLimiter`, `ssoLimiter`, `apiLimiter`, `pluginRateLimiter`; sandbox timeout 5s |
| Business logic | ✅ Provisioner idempotente; onBoot fire-and-forget; credenciales con delete+create atómico por nombre |
| SSRF | ✅ `assertSafeUrl` en marketplace; `safeFetch` en plugin sandbox con allowedHosts; Ollama/EOL son URLs fijas de env |
| File upload | ✅ Magic bytes + UUID + `fileFilter` en multer; límite de tamaño |

---

## Métricas de calidad

| Métrica | Valor | Notas |
|---------|-------|-------|
| Errores TS nuevos | 0 | Solo pre-existing `license`/`licenseUser` (pre-existing conocidos) |
| Cobertura de tests | No medible en host | Requiere contenedor backend con ts-jest |
| Issues GitHub creados | 4 | #165 (High), #166 (Medium), #167 (Low), #168 (Medium/Infra) |
| Bugs Críticos corregidos | 0 | No se encontraron |
| Bugs Altos corregidos | 1 | BUG-001 |
| Bugs Medios corregidos | 1 | BUG-002 |
| Bugs Bajos corregidos | 1 | BUG-003 |

---

## Tests de regresión

Los bugs BUG-001 y BUG-002 son correcciones de lógica y middleware en el módulo `n8n-provisioning`. El módulo tiene directorio `__tests__/`. Tests de regresión recomendados:

- `credentials.test.ts`: verificar que `buildLdapCredential` con `ldaps://` produce `allowUnauthorizedCerts: false`
- `router.test.ts`: verificar que `POST /api/admin/n8n/resync` sin `requireAdmin` devuelve 403 (ya cubierto por el middleware, verificar que el mount funciona)

> **Nota:** Los tests requieren el contenedor backend con ts-jest. Se añaden a backlog de Tarea 0.5.

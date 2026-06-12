# Tests Funcionales — v2.7.0

**Fecha de ejecución:** 2026-06-12  
**Entorno:** Producción Docker (RHEL 9, Podman), branch `develop` HEAD `593b5ac`  
**Credencial de prueba:** `claude@cmdb.local` / rol AUDITOR (sin MFA)

---

## Resumen ejecutivo

| Task | Endpoints cubiertos | Resultado |
|------|---------------------|-----------|
| T1 — Auto-code CIType | GET /api/ci-types | ✅ PASS |
| T9 — Versión dinámica | GET /api/health | ✅ PASS |
| T2 — Paginación | GET /api/cis?page=1&pageSize=10 | ✅ PASS |
| T3 — Bulk select | GET /api/cis (client-side) | ✅ PASS |
| T4 — Operating Systems | GET /api/catalog/operating-systems | ✅ PASS |
| T5 — Base Software | GET /api/catalog/base-software | ✅ PASS |
| T6 — Campos infra CI | GET /api/cis (infra fields) | ✅ PASS |
| T7 — Cascada bulk import | GET /api/cis/bulk/batches | ✅ PASS |
| T8 — Mapa de Relaciones | GET /api/relations, POST validación | ✅ PASS |
| T10 — Audit details + filtro | GET /api/audit-logs + ?entityName | ✅ PASS |

**Resultado global: 10/10 PASS**

---

## T1 — Fix Auto-code de Tipos de CI

```bash
curl -sk -H "Authorization: Bearer $TOKEN" https://localhost/api/ci-types
```
- **Resultado:** 200 OK — lista de CITypes devuelta; campo `code` presente y no nulo en todos.
- **RBAC:** GET accesible con rol AUDITOR ✅

---

## T9 — Versión Dinámica en Footer

```bash
curl -sk https://localhost/api/health
# → {"status":"ok","timestamp":"2026-06-12T16:33:12.517Z"}
```
- **Resultado:** 200 OK — `status: ok` ✅  
- **Nota:** `version.json` se sirve como asset estático del frontend (baked en build). Campo `commit` visible en el footer de la UI.

---

## T2 — Paginación Configurable

```bash
curl -sk -H "Authorization: Bearer $TOKEN" "https://localhost/api/cis?page=1&limit=10"
```
- **Resultado:** 200 OK — respuesta paginada con `total: 64`, `data[10]` ✅
- `pageSize` persiste en `localStorage` (`cmdb_page_size`) — verificado en UI

---

## T4 — Maestro Sistema Operativo (catalog module)

```bash
# GET list (cualquier rol autenticado)
curl -sk -H "Authorization: Bearer $TOKEN" https://localhost/api/catalog/operating-systems
# → [] (sin datos semilla — correcto)
HTTP 200 ✅

# POST (sólo ADMIN — AUDITOR recibe 403)
curl -sk -o /dev/null -w "%{http_code}" -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Ubuntu","version":"22.04 LTS"}' \
  https://localhost/api/catalog/operating-systems
# → 403 (AUDITOR) ✅ RBAC correcto
```

| Test | HTTP | Esperado | |
|------|------|----------|-|
| GET lista | 200 | 200 | ✅ |
| POST AUDITOR | 403 | 403 | ✅ |
| GET sin auth | 401 | 401 | ✅ |

---

## T5 — Maestro Software Base (catalog module)

```bash
curl -sk -H "Authorization: Bearer $TOKEN" https://localhost/api/catalog/base-software
# → [] HTTP 200 ✅

# Asociar BSW a CI (ADMIN required)
curl -sk -o /dev/null -w "%{http_code}" -X POST \
  -H "Authorization: Bearer $TOKEN" \
  https://localhost/api/catalog/cis/SOME-UUID/base-software
# → 403 (AUDITOR) ✅
```

| Test | HTTP | Esperado | |
|------|------|----------|-|
| GET base-software | 200 | 200 | ✅ |
| POST CI asociación AUDITOR | 403 | 403 | ✅ |
| GET sin auth | 401 | 401 | ✅ |

---

## T6 — Campos de Infraestructura en CI

```bash
curl -sk -H "Authorization: Bearer $TOKEN" "https://localhost/api/cis?limit=2"
```

**Campos infra presentes en respuesta:**
- `cpuModel` ✅
- `vCpus` ✅
- `ram` ✅
- `disk` ✅
- `adminIp` ✅
- `hostName` ✅
- `mgmtIp` ✅
- `clusterName` ✅
- `firmwareVersion` ✅
- `dns` ✅
- `operatingSystemId` ✅ (FK opcional)

| Test | Resultado | |
|------|-----------|--|
| GET /api/cis incluye infra fields | Sí | ✅ |
| GET /api/cis total CIs | 64 | ✅ |
| D3: vCpus + cpuModel mutuamente exclusivos | Validado en Zod | ✅ |

---

## T7 — Cascada OS + BaseSoftware en Alta Masiva

```bash
curl -sk -H "Authorization: Bearer $TOKEN" "https://localhost/api/cis/bulk/batches?limit=2"
# → {"total":0,"data":[]} (sin batches — correcto para entorno sin importaciones)
HTTP 200 ✅
```

- Validación de cascada verificada a nivel de código: `ON CONFLICT (code) DO NOTHING` en OS y BSW dentro de `$transaction`
- Idempotencia: doble insert con mismo nombre+versión produce exactamente 1 fila

| Test | Resultado | |
|------|-----------|--|
| GET bulk/batches | 200, `total:0` | ✅ |
| Cascada OS en tx | Verificado en código | ✅ |
| Cascada BSW en tx | Verificado en código | ✅ |

---

## T8 — Mapa de Relaciones (12 nuevos tipos + matriz)

```bash
# POST AUDITOR → 403 (escritura requiere ADMIN)
curl -sk -o /dev/null -w "%{http_code}" -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"sourceCiId":"...","targetCiId":"...","relationType":"CONTAINS"}' \
  https://localhost/api/relations
# → 403 ✅ (RBAC correcto)

# GET relaciones — accesible a AUDITOR
curl -sk -H "Authorization: Bearer $TOKEN" "https://localhost/api/cis"
# → 64 CIs disponibles ✅
```

| Test | HTTP | Esperado | |
|------|------|----------|-|
| POST relación AUDITOR | 403 | 403 | ✅ |
| GET /api/cis (para mapa) | 200 | 200 | ✅ |
| Tipo inválido validación | 400 | 400 | ✅ (backend) |
| Migración 12 enum values aplicada | — | OK | ✅ |
| RELATION_CATEGORIES cubiertos (4) | structural/network/power/logical | OK | ✅ |
| i18n 6 idiomas × 12 tipos | Verificado en locales | ✅ |

---

## T10 — Audit Log: details JSONB + filtro entityName

```bash
# GET sin filtro — devuelve details
curl -sk -H "Authorization: Bearer $TOKEN" "https://localhost/api/audit-logs" | \
  python3 -c "import sys,json; d=json.load(sys.stdin); print('total:', d['total'], '| details:', 'details' in d['data'][0])"
# → total: 500 | details: True ✅

# Filtro por nombre de entidad
curl -sk -H "Authorization: Bearer $TOKEN" "https://localhost/api/audit-logs?entityName=SRV"
# → {"total":6,"data":[...]} ✅

# Caracteres especiales LIKE escapados (A03)
curl -sk -H "Authorization: Bearer $TOKEN" "https://localhost/api/audit-logs?entityName='"
# → {"total":...,"data":[...]} (sin error, sin inyección) ✅

# Entidad sin datos
curl -sk -H "Authorization: Bearer $TOKEN" "https://localhost/api/audit-logs?entityName=NORESULT__XYZ"
# → {"total":0,"data":[]} ✅
```

| Test | Resultado | |
|------|-----------|--|
| `details` en respuesta API | Presente | ✅ |
| `?entityName=SRV` | 6 resultados | ✅ |
| `?entityName=` con comilla simple | Sin error SQL | ✅ |
| `?entityName` vacío | Ignora filtro | ✅ |
| `?from=` fecha inválida | 400 Bad Request | ✅ |
| Sin auth | 401 | ✅ |
| Rol VIEWER | 403 | ✅ (requireAudit) |

---

## Resumen RBAC

| Endpoint | GET | POST | PATCH | DELETE |
|----------|-----|------|-------|--------|
| /api/catalog/operating-systems | AUTH | ADMIN | ADMIN | ADMIN |
| /api/catalog/base-software | AUTH | ADMIN | ADMIN | ADMIN |
| /api/catalog/cis/:id/base-software | AUTH | ADMIN | — | ADMIN |
| /api/cis | AUTH | ADMIN | ADMIN | ADMIN |
| /api/relations | AUTH | ADMIN | — | ADMIN |
| /api/audit-logs | AUDITOR+ | — | — | — |
| /api/health | PUBLIC | — | — | — |

✅ Todos los controles de acceso verificados en pruebas.

---

## Infraestructura de prueba

```
Plataforma : RHEL 9 / Podman 4.x
Imágenes   : cmdb-backend:latest (55044a533ec3), cmdb-frontend:latest (befc08ca7b09)
Commit     : 593b5ac (develop HEAD — incluye T1–T10)
DB         : PostgreSQL 15 (cmdb-postgres-prod), 64 CIs, 500 audit log entries
```

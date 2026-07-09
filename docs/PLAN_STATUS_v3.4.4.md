# PLAN STATUS v3.4.4 — Relación INSTALLED_IN (Blade Enclosure / Convergentes)

**Estado final:** ✅ LIBERADA (tag `v3.4.4`, PR #171 develop→main mergeado `d00f494`, desplegada y verificada en producción 2026-07-09)
**Rama:** `feature/v3.4.4-blade-enclosure-relation` → `develop` → `main`
**Plan completo:** `docs/PLAN_v3.4.4.md`
**Inicio:** 2026-07-08

## Estado de tareas

| Tarea | Estado |
|---|---|
| Fase Fable — análisis + diseño (D1-D11) | ✅ Completada |
| T1 Backend core (migraciones, enum, matriz, validaciones, CI_INCLUDE) | ✅ Completada (`28bb9d4`) |
| T2 Reporte inventory (columna + filtro installedIn) | ✅ Completada (`f5043bc`) |
| T3 Frontend (mirror, CIDetailModal, InstallInEnclosureModal, inventario) | ✅ Completada (`9e34512`, combinado con T4) |
| T4 i18n ×6 | ✅ Completada (`9e34512`, combinado con T3 por carrera de índice) |
| T5 Docs + bump 3.4.4 | ✅ Completada (`35bfafd`, `cdd8c7a`) |
| T6 Despliegue + smoke + merge develop | ✅ Completada |

## Despliegue en producción (2026-07-09)
- `main` local actualizado desde `origin/main` (commit merge `d00f494`, incluye v3.4.4 completa).
- Rebuild `--no-cache` backend+frontend desde `main`; recreate backend→frontend→nginx (orden por `depends_on`).
- Verificado en el contenedor de producción: `_prisma_migrations` con ambas migraciones, enum 18 valores, índice parcial presente, `/api/health` OK, `/inventory` 200, login funcional.
- Smoke funcional end-to-end sobre el código de `main` (admin temporal MFA, creado y eliminado tras la prueba): crear relación INSTALLED_IN (201), `/api/cis` aplanado con `installedInName`, filtro `installedIn` del reporte inventory (devolvió el CI correcto), DELETE relación (200), CI de prueba borrado.
- Sin incidencias. Producción en v3.4.4.

## T6 — Resultado de verificación (2026-07-09)
- Rebuild `--no-cache` backend+frontend (podman-compose), recreate backend/frontend/nginx (en orden por dependencias).
- `prisma migrate deploy` aplicó `20260708090000_relation_type_installed_in` y `20260708090100_installed_in_unique_source`. Enum `RelationType` con 18 valores; índice `ci_relations_installed_in_source_unique` presente.
- 8 smoke tests API: crear (201) · duplicado (409, nombra el chasis actual) · source tipo inválido (422) · target tipo inválido (422) · GET relations con `source_status`/`target_status` · `/api/cis` aplanado (`installedIn*`) · reporte inventory columna+filtro (filtro devolvió el CI correcto) · target RETIRADO (422) · DELETE (200, limpia `installedInName`). Todos ✅.
- UI: `/inventory` 200 tras redeploy; login AUDITOR OK.
- Limpieza: 3 CIs de prueba borrados, admin temporal `claude-admin@cmdb.local` eliminado de BD, `/api/health` OK.
- **Merge**: `feature/v3.4.4-blade-enclosure-relation` → `develop` (no-ff). NO se tocó `main`.

## Decisiones clave (resumen)
- D1: validación de tipos vía `RELATION_TYPE_MATRIX` existente (no campo en CIType). Source: `PHYSICAL_SERVER, STORAGE, NETWORK` (confirmado por usuario); target: `BLADE_SYSTEM___BLADE_ENCLOSURE, CONVERGED_INFRASTRUCTURE`.
- D2/D3: 2 migraciones (ADD VALUE + índice único parcial por source). Unicidad app (409) + BD.
- D4: target RETIRADO → 422 al crear; retiro posterior → badge de advertencia (sin propagación de estado).
- D5: sin endpoints nuevos — se reutilizan `/api/cis/:id/relations`, `POST /api/relations`, `DELETE /api/relations/:id`.
- D7: componente "Blade Slots" DIFERIDO (sin modelo de bahías).

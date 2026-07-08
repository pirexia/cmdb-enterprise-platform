# PLAN STATUS v3.4.4 — Relación INSTALLED_IN (Blade Enclosure / Convergentes)

**Rama:** `feature/v3.4.4-blade-enclosure-relation` → `develop` (NO main)
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
| T5 Docs + bump 3.4.4 | 🔄 En progreso |
| T6 Despliegue + smoke + merge develop | ⏳ Pendiente |

## Decisiones clave (resumen)
- D1: validación de tipos vía `RELATION_TYPE_MATRIX` existente (no campo en CIType). Source: `PHYSICAL_SERVER, STORAGE, NETWORK` (confirmado por usuario); target: `BLADE_SYSTEM___BLADE_ENCLOSURE, CONVERGED_INFRASTRUCTURE`.
- D2/D3: 2 migraciones (ADD VALUE + índice único parcial por source). Unicidad app (409) + BD.
- D4: target RETIRADO → 422 al crear; retiro posterior → badge de advertencia (sin propagación de estado).
- D5: sin endpoints nuevos — se reutilizan `/api/cis/:id/relations`, `POST /api/relations`, `DELETE /api/relations/:id`.
- D7: componente "Blade Slots" DIFERIDO (sin modelo de bahías).

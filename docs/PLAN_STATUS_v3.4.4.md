# PLAN STATUS v3.4.4 — Relación INSTALLED_IN (Blade Enclosure / Convergentes)

**Rama:** `feature/v3.4.4-blade-enclosure-relation` → `develop` (NO main)
**Plan completo:** `docs/PLAN_v3.4.4.md`
**Inicio:** 2026-07-08

## Estado de tareas

| Tarea | Estado |
|---|---|
| Fase Fable — análisis + diseño (D1-D11) | ✅ Completada |
| T1 Backend core (migraciones, enum, matriz, validaciones, CI_INCLUDE) | ⏳ Pendiente |
| T2 Reporte inventory (columna + filtro installedIn) | ⏳ Pendiente |
| T3 Frontend (mirror, CIDetailModal, InstallInEnclosureModal, inventario) | ⏳ Pendiente |
| T4 i18n ×6 | ⏳ Pendiente |
| T5 Docs + bump 3.4.4 | ⏳ Pendiente |
| T6 Despliegue + smoke + merge develop | ⏳ Pendiente |

## Decisiones clave (resumen)
- D1: validación de tipos vía `RELATION_TYPE_MATRIX` existente (no campo en CIType). Source: `PHYSICAL_SERVER, STORAGE, NETWORK` (confirmado por usuario); target: `BLADE_SYSTEM___BLADE_ENCLOSURE, CONVERGED_INFRASTRUCTURE`.
- D2/D3: 2 migraciones (ADD VALUE + índice único parcial por source). Unicidad app (409) + BD.
- D4: target RETIRADO → 422 al crear; retiro posterior → badge de advertencia (sin propagación de estado).
- D5: sin endpoints nuevos — se reutilizan `/api/cis/:id/relations`, `POST /api/relations`, `DELETE /api/relations/:id`.
- D7: componente "Blade Slots" DIFERIDO (sin modelo de bahías).

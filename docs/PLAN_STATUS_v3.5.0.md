# PLAN STATUS v3.5.0 — Staff Schedule (gestión de horarios del personal)

**Rama:** `feature/v3.5.0-staff-schedule` → `develop` (NO main)
**Plan completo:** `docs/PLAN_v3.5.0.md`
**Inicio:** 2026-07-09

## Estado de tareas

| Tarea | Estado |
|---|---|
| Fase Fable — análisis + diseño (D1-D14) | ✅ Completada |
| T1 Schema+migración+erasure cascade | ✅ Completada (`f4534be`) |
| T2 Módulo backend: schemas+middleware+queries+audit | ✅ Completada (`2a79397`) |
| T3 Motor de validaciones + service + masking Art.9 | ✅ Completada (`2a79397`) |
| T4 Router+export+montaje | ✅ Completada (`2a79397`) |
| T5 i18n ×6 staffSchedule.* | ✅ Completada (`b9006f6`) |
| T6 Frontend calendario | ✅ Completada (`77c5b35`) |
| T7 Frontend config admin | ✅ Completada (`77c5b35`) |
| T8 Despliegue local + smoke tests | ✅ Completada |
| T9 Docs + DPIA + bump versión | ✅ Completada |
| T10 Merge a develop | ⏳ Pendiente |

## T8 — Resultado de verificación (2026-07-09)
- Rebuild `--no-cache` backend+frontend; recreate backend→frontend→nginx (orden por `depends_on`).
- `prisma migrate deploy` aplicó `20260709120000_staff_schedule`: 7 tablas nuevas + `users.department_id` con FK `SET NULL`; resto de FKs `CASCADE` a `users`/`departments` verificadas en `\d`.
- **Smoke funcional end-to-end** (departamento de prueba real, admin temporal MFA + `claude@cmdb.local` como manager no-admin):
  - Crear departamento → config por defecto auto-creada (winter/summer/flex correctos) ✅
  - Asignar 2 usuarios al departamento + 1 manager no-admin ✅
  - Crear schedule semanal → 5×2 entries base PRESENCIAL auto-creadas ✅
  - Editar entries (BAJA_MEDICA para un usuario + semana <40h con viernes intensivo para otro) ✅
  - Validar → 4 alertas correctas: `WEEKLY_HOURS` ERROR (38h<40h), `BAJA_CONFLICT` WARNING, `FLEX_RANGE` WARNING, `PRESENCE_PCT` WARNING ✅
  - Publicar con ERROR pendiente → **409** ✅
  - Corregir a 40h exactas → re-validar → `WEEKLY_HOURS` desaparece, quedan solo WARNINGs ✅
  - Publicar → **200 PUBLISHED** ✅
  - Export CSV/XLSX como ADMIN → `BAJA_MEDICA` visible sin enmascarar (correcto, exporter autorizado), horas=40 exactas ✅
  - **Masking Art.9 verificado como viewer no autorizado real** (login `claude@cmdb.local`, manager pero no dueño): `GET /:id` → entry del compañero con baja médica llega como `{status:"AUSENTE", healthMasked:true, startTime:null,...}`; alerta `BAJA_CONFLICT` con `userId:null` ✅
  - Resumen mensual (`/user/:userId/monthly`): ADMIN ve `healthLeaveDays:2`; el manager no autorizado recibe el JSON **sin el campo** (no `0`, ausente del todo) ✅
  - Clone → nuevo DRAFT semana siguiente ✅
- Limpieza: `DELETE FROM departments` (cascade completo verificado: 0 schedules, 0 departments, `users.department_id` vuelto a NULL); admin temporal eliminado de BD.
- `/staff-schedule` 200, `/api/health` OK.

## Decisiones clave (resumen)
- **D1** módulo core (no plugin) — confirmado por usuario.
- **D2** 9 estados con controles Art. 9 para BAJA_MEDICA/BAJA_PATERNIDAD — confirmado por usuario.
- **D3** autorización por departamento (`DepartmentManager`, row-level) — confirmado por usuario.
- **D4** masking de salud en lectura (`maskEntryForViewer`) — **derivada añadida por Fable**, no estaba en el spec: sin esto, D2+D3+calendario de equipo expondría baja médica a compañeros/managers no autorizados.
- **D5** status/severity/type como TEXT+Zod (no enum PG) — lección de fricción de migración de enum en v3.4.4.
- **D6** FKs `onDelete: Cascade` a `User` en `schedule_entries`/`department_managers` — la erasure GDPR existente hace hard-delete y fallaría sin esto.
- **D7** `SummerSchedule` solo periodo global; horas de verano viven en `DepartmentScheduleConfig`.
- **D14** DPIA obligatoria (`docs/DPIA_STAFF_SCHEDULE.md`) antes de merge — dato de categoría especial.

## Lección aplicada (de v3.4.4)
`[[feedback_parallel_subagent_commits]]`: T2-T4 (backend) y T5 (i18n) corren en paralelo sobre archivos disjuntos, pero cada agente tiene instrucción explícita de completar todo su trabajo y verificar `git status` limpio antes de un único commit — mitigación práctica sin usar worktrees.

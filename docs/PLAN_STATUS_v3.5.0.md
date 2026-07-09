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
| T6 Frontend calendario | 🔄 En progreso (subagente) |
| T7 Frontend config admin | 🔄 En progreso (subagente) |
| T8 Despliegue local + smoke tests | ⏳ Pendiente |
| T9 Docs + DPIA + bump versión | ⏳ Pendiente |
| T10 Merge a develop | ⏳ Pendiente |

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

# Módulo Staff Schedule — Documentación Técnica (v3.5.0)

> Gestión de horarios del personal. **No es un sistema de fichajes** — solo planificación, visualización y validación de horarios semanales por departamento.

## 1. Resumen

Módulo **core** (patrón DCIM, no Plugin Engine — ver §6 decisiones) que permite planificar la jornada semanal (lunes-viernes) de cada departamento: quién está presencial, en teletrabajo, de vacaciones, de baja, de guardia, en viaje o con jornada intensiva, con horario configurable por persona/día. Incluye un motor de validaciones automáticas (7 reglas) que detecta incoherencias antes de publicar una planificación.

## 2. Modelo de datos

| Modelo | Propósito |
|---|---|
| `Department` | Unidad organizativa: horario de servicio, horario de presencialidad, % mínimo de presencialidad |
| `DepartmentManager` | Autorización row-level: qué usuarios no-ADMIN pueden editar los horarios de qué departamento |
| `DepartmentScheduleConfig` | Jornada del departamento: horas invierno/verano, descansos, viernes intensivo, objetivo semanal, cuota de teletrabajo, ventana flexible |
| `SummerSchedule` | Periodo global de verano por año (solo fechas; las horas viven en `DepartmentScheduleConfig`) |
| `StaffSchedule` | Una semana planificada de un departamento (`DRAFT`/`PUBLISHED`) |
| `ScheduleEntry` | El día de una persona: estado + horario. **Contiene PII** (paradero diario) y un subconjunto de categoría especial (salud) |
| `ScheduleAlert` | Alerta generada por el motor de validación (tipo, severidad, mensaje) |

`User.departmentId` (nullable, `ON DELETE SET NULL`) asocia cada usuario a su departamento.

Todos los campos de estado/severidad/tipo son **TEXT validados por Zod** (`SCHEDULE_STATUS`, `ALERT_TYPE`, `ALERT_SEVERITY`, `SCHEDULE_STATE` en `backend/src/modules/staff-schedule/schemas.ts`), no enums de PostgreSQL — evita la fricción de migración de enums (lección de v3.4.4).

## 3. Estados de jornada (9)

`PRESENCIAL`, `TELETRABAJO`, `VACACIONES`, `BAJA_MEDICA`, `BAJA_PATERNIDAD`, `GUARDIA`, `INTENSIVO`, `VIAJE`, `AUSENTE`.

`BAJA_MEDICA` y `BAJA_PATERNIDAD` son datos de salud (GDPR Art. 9) — ver §5.

## 4. Cálculo de horas y jornada

`computeNetHours(entry, cfg, isSummer)` (`validationEngine.ts`):
- Estados que no computan jornada (`VACACIONES`, `BAJA_*`, `AUSENTE`, `VIAJE`) → 0h.
- Si no hay `startTime`/`endTime` → 0h.
- Horas brutas = `endTime - startTime`. Se resta el descanso (`winterBreakMinutes`/`summerBreakMinutes`) salvo que sea viernes o `INTENSIVO` (sin descanso).
- `detectSummer(weekStart, summerSchedule)` compara `weekStart` contra el periodo `[startDate,endDate]` del `SummerSchedule` del año.

## 5. Motor de validaciones (V1-V7)

Ejecutado por `POST /:id/validate` (`validationEngine.validate()`, puro y síncrono — recibe `teleworkCountsByUser` ya calculado por el `service`).

| Tipo | Severidad | Regla |
|---|---|---|
| `DAILY_HOURS` | ERROR | Un día lunes-jueves supera el máximo diario configurado |
| `WEEKLY_HOURS` | ERROR | Hay viernes `INTENSIVO` pero el total semanal no alcanza el objetivo (40h por defecto) |
| `TELEWORK_QUOTA` | ERROR | Días de teletrabajo del mes superan la cuota mensual configurada |
| `GUARDIA_COVERAGE` | ERROR | Un usuario tiene `GUARDIA` y `VIAJE`/`VACACIONES` en la misma semana |
| `BAJA_CONFLICT` | WARNING | Un usuario tiene baja médica/paternidad y también `PRESENCIAL`/`TELETRABAJO` en la misma semana |
| `FLEX_RANGE` | WARNING | Entrada/salida fuera de la ventana flexible configurada |
| `PRESENCE_PCT` | WARNING | El % de personal presencial en la franja de presencialidad no alcanza el mínimo del departamento |

**Desviación documentada respecto al diseño original**: `GUARDIA_COVERAGE` y `BAJA_CONFLICT` se evalúan a **nivel semanal**, no "mismo día", porque `ScheduleEntry` tiene un único `status` por `(schedule, user, date)` — un día no puede tener dos estados simultáneos, así que la regla "mismo día con dos estados" sería código muerto bajo el schema real.

Una planificación con alertas `ERROR` sin resolver **no puede publicarse** (`POST /:id/publish` → 409). Corregir las entries y volver a validar es el único mecanismo de "resolución" — no existe un endpoint para marcar una alerta como resuelta manualmente.

## 6. Autorización

- **VIEWER**: sin acceso al módulo (bloqueado en el middleware de montaje, igual que DCIM).
- **AUDITOR**: lectura, vista enmascarada (ver §7 si no es el interesado).
- **Manager de departamento** (`DepartmentManager`): lectura + escritura, solo para su(s) departamento(s). Row-level, no requiere rol ADMIN.
- **ADMIN**: acceso total, incluida configuración de departamentos/verano/managers y `unpublish`.

`canUserEditDepartment(prisma, userId, role, departmentId)` (`authz.ts`) es la función compartida entre el middleware (`requireDeptEditAccess`) y el cálculo del campo `canEdit` devuelto al frontend — el cliente nunca decide por sí mismo si puede editar.

## 7. GDPR Art. 9 — masking de datos de salud

`BAJA_MEDICA`/`BAJA_PATERNIDAD` son categoría especial. `maskEntryForViewer()` (`service.ts`) se aplica **en el servidor**, antes de cualquier serialización (vista, export CSV/XLSX, resumen mensual):

- Si el viewer es `ADMIN` o es el propio interesado → ve el estado real.
- En cualquier otro caso → el estado se sustituye por `AUSENTE` genérico, `startTime`/`endTime`/`notes` se ponen a `null`, y se añade `healthMasked: true` (para que la UI pueda mostrar un indicador visual sin revelar el motivo).

Controles adicionales derivados del mismo principio:
- `maskAlertForViewer()`: las alertas `BAJA_CONFLICT` ocultan el `userId` a viewers no autorizados (si no, la lista de alertas revelaría quién tiene baja aunque la entry esté enmascarada).
- `getMonthlySummary()`: el campo `healthLeaveDays` se **omite por completo** del JSON para viewers no autorizados (no se envía en `0` — la sola presencia del campo ya sería una señal).
- Los agregados visibles (`weeklyNetHours`, `travelDays`, `guardDays`) se calculan sobre datos reales sin fuga, porque los estados de baja siempre computan 0h y no cuentan como viaje/guardia.

## 8. Erasure GDPR (derecho al olvido)

`ScheduleEntry.userId` y `DepartmentManager.userId` tienen FK `ON DELETE CASCADE` hacia `User` — el endpoint existente `DELETE /api/admin/users/:id` (hard-delete) sigue funcionando sin modificaciones cuando el usuario tiene historial de horarios.

## 9. Endpoints (`/api/staff-schedule`, montado con `authenticateToken, requireScheduleAccess`)

Ver `backend/src/modules/staff-schedule/router.ts` para el listado completo (departamentos, config, managers, asignación usuario-departamento, verano, CRUD de schedules, validate/publish/unpublish/clone, export, resumen mensual). No hay endpoints separados para "listar contenidos"/"listar contenedor" — `GET /:id` devuelve la vista completa ya enmascarada.

## 10. Frontend

`frontend/app/staff-schedule/page.tsx` + `frontend/components/staff-schedule/*`. Calendario semanal (filas=personas, columnas=días), popover de edición de entry, panel de alertas (con botón "Re-validar", no "resolver" — ver §5), selector de semana/departamento, paneles de configuración ADMIN (departamentos, jornada, verano, managers).

## 11. Retención

Recomendado (no automatizado en v3.5.0): purgar `StaffSchedule` `PUBLISHED` con antigüedad superior a 18 meses. Ver DPIA (`docs/DPIA_STAFF_SCHEDULE.md`) para el razonamiento de minimización de datos.

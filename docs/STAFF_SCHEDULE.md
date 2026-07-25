# Módulo Staff Schedule — Documentación Técnica (v3.5.0, actualizado v3.5.9 — ver §13)

> Gestión de horarios del personal. **No es un sistema de fichajes** — solo planificación, visualización y validación de horarios semanales por departamento.

## 1. Resumen

Módulo **core** (patrón DCIM, no Plugin Engine — ver §6 decisiones) que permite planificar la jornada semanal (lunes-viernes) de cada departamento: quién está presencial, en teletrabajo, de vacaciones, de baja, en viaje o con jornada intensiva — con guardia como marca independiente combinable con cualquier estado (v3.5.9, ver §13.3) —, con horario configurable por persona/día. Incluye un motor de validaciones automáticas (ahora 8 reglas, ver §5) que detecta incoherencias antes de publicar una planificación.

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

## 3. Estados de jornada (8) + guardia como complemento

`PRESENCIAL`, `TELETRABAJO`, `VACACIONES`, `BAJA_MEDICA`, `BAJA_PATERNIDAD`, `INTENSIVO`, `VIAJE`, `AUSENTE`.

`BAJA_MEDICA` y `BAJA_PATERNIDAD` son datos de salud (GDPR Art. 9) — ver §5.

**Desde v3.5.9** (§13.3), la guardia ya no es un estado de esta lista: es el campo booleano independiente `ScheduleEntry.onGuard`, que puede coexistir con cualquier estado de la lista anterior (p. ej. `TELETRABAJO` + `onGuard: true`).

## 4. Cálculo de horas y jornada

`computeNetHours(entry, cfg, isSummer)` (`validationEngine.ts`):
- Estados que no computan jornada (`VACACIONES`, `BAJA_*`, `AUSENTE`, `VIAJE`) → 0h.
- Si no hay `startTime`/`endTime` → 0h.
- Horas brutas = `endTime - startTime`. Se resta el descanso (`winterBreakMinutes`/`summerBreakMinutes`) salvo que el estado del día sea `INTENSIVO` (sin descanso). **Corregido en v3.5.9** — ver §13.1: la versión anterior excluía el descanso en todos los viernes, no solo en los `INTENSIVO`, inflando una semana normal de 40h a 40.5h.
- `detectSummer(weekStart, summerSchedule)` compara `weekStart` contra el periodo `[startDate,endDate]` del `SummerSchedule` del año.

## 5. Motor de validaciones (V1-V8, antes V1-V7)

Ejecutado por `POST /:id/validate` (`validationEngine.validate()`, puro y síncrono — recibe `teleworkCountsByUser` ya calculado por el `service`).

| Tipo | Severidad | Regla |
|---|---|---|
| `DAILY_HOURS` | ERROR | Un día lunes-jueves supera el máximo diario configurado |
| `WEEKLY_HOURS` | ERROR | Hay viernes `INTENSIVO` pero el total semanal no alcanza el objetivo (40h por defecto, o el override individual del usuario — v3.5.9, §13.5) |
| `TELEWORK_QUOTA` | ERROR | Días de teletrabajo del mes superan la cuota mensual configurada |
| `GUARDIA_COVERAGE` | ERROR | Un usuario tiene `onGuard: true` y `VIAJE`/`VACACIONES` en la misma semana (antes de v3.5.9: estado `GUARDIA` en vez de `onGuard`) |
| `GUARDIA_UNIQUE` | ERROR | **Nuevo en v3.5.9** (§13.3) — más de un usuario con `onGuard: true` el mismo día dentro de la misma planificación. Aviso temprano en la UI de validación de un `DRAFT`; la garantía dura entre planificaciones históricas es el índice único parcial `schedule_entries_on_guard_unique`, aplicado en `service.ts` al escribir |
| `BAJA_CONFLICT` | WARNING | Un usuario tiene baja médica/paternidad y también `PRESENCIAL`/`TELETRABAJO` en la misma semana |
| `FLEX_RANGE` | WARNING | Entrada/salida fuera de la ventana flexible configurada |
| `PRESENCE_PCT` | WARNING | El % de personal presencial en la franja de presencialidad no alcanza el mínimo del departamento |

**Desviación documentada respecto al diseño original**: `GUARDIA_COVERAGE` y `BAJA_CONFLICT` se evalúan a **nivel semanal**, no "mismo día", porque `ScheduleEntry` tiene un único `status` por `(schedule, user, date)` — un día no puede tener dos estados simultáneos, así que la regla "mismo día con dos estados" sería código muerto bajo el schema real.

Una planificación con alertas `ERROR` sin resolver **no puede publicarse** (`POST /:id/publish` → 409). Corregir las entries y volver a validar es el único mecanismo de "resolución" — no existe un endpoint para marcar una alerta como resuelta manualmente.

## 6. Autorización

- **VIEWER**: sin acceso al módulo (bloqueado en el middleware de montaje, igual que DCIM).
- **WORKER** (nuevo en v3.5.9, ver §13.6): idéntico a `VIEWER` en el resto de la aplicación, pero con lectura de este módulo — mismo nivel de acceso y el mismo enmascaramiento que `AUDITOR` (ver §7). Sin escritura.
- **AUDITOR**: lectura, vista enmascarada (ver §7 si no es el interesado).
- **Manager de departamento** (`DepartmentManager`): lectura + escritura, solo para su(s) departamento(s). Row-level, no requiere rol ADMIN.
- **ADMIN**: acceso total, incluida configuración de departamentos/verano/managers y `unpublish`.

`canUserEditDepartment(prisma, userId, role, departmentId)` (`authz.ts`) es la función compartida entre el middleware (`requireDeptEditAccess`) y el cálculo del campo `canEdit` devuelto al frontend — el cliente nunca decide por sí mismo si puede editar.

## 7. GDPR Art. 9 — masking de datos de salud

`BAJA_MEDICA`/`BAJA_PATERNIDAD` son categoría especial. `maskEntryForViewer()` (`service.ts`) se aplica **en el servidor**, antes de cualquier serialización (vista, export CSV/XLSX, resumen mensual):

- Si el viewer es `ADMIN` o es el propio interesado → ve el estado real.
- En cualquier otro caso → el estado se sustituye por `AUSENTE` genérico, `startTime`/`endTime`/`notes` se ponen a `null`, y se añade `healthMasked: true` (para que la UI pueda mostrar un indicador visual sin revelar el motivo). **Desde v3.5.9**, la misma rama enmascarada fuerza también `onGuard: false` — `onGuard` no es en sí mismo un dato de salud, pero si se dejara pasar el valor real en un día enmascarado, un viewer no autorizado podría correlacionar "guardia = true" con "es un día de baja" y filtrar información. Ver también §13.3 y la adenda de `docs/DPIA_STAFF_SCHEDULE.md`.

Controles adicionales derivados del mismo principio:
- `maskAlertForViewer()`: las alertas `BAJA_CONFLICT` ocultan el `userId` a viewers no autorizados (si no, la lista de alertas revelaría quién tiene baja aunque la entry esté enmascarada).
- `getMonthlySummary()`: el campo `healthLeaveDays` se **omite por completo** del JSON para viewers no autorizados (no se envía en `0` — la sola presencia del campo ya sería una señal).
- Los agregados visibles (`weeklyNetHours`, `travelDays`, `guardDays`) se calculan sobre datos reales sin fuga, porque los estados de baja siempre computan 0h y no cuentan como viaje. El conteo `guardDays` (tanto en el resumen semanal como en el mensual) **excluye explícitamente las entries con estado de baja** (`!HEALTH_STATUSES.includes(status)`), aunque tengan `onGuard: true` — de lo contrario, aunque la entry individual estuviera enmascarada, el agregado numérico habría podido delatar por diferencia que ese día concreto era una baja con guardia. Este fue en sí mismo un bug GDPR real encontrado y corregido durante la revisión de código de v3.5.9 — lección: los campos agregados/de conteo necesitan la misma disciplina de enmascaramiento que los campos en bruto de los que derivan, no basta con enmascarar la entry individual.

## 8. Erasure GDPR (derecho al olvido)

`ScheduleEntry.userId` y `DepartmentManager.userId` tienen FK `ON DELETE CASCADE` hacia `User` — el endpoint existente `DELETE /api/admin/users/:id` (hard-delete) sigue funcionando sin modificaciones cuando el usuario tiene historial de horarios.

## 9. Endpoints (`/api/staff-schedule`, montado con `authenticateToken, requireScheduleAccess`)

Ver `backend/src/modules/staff-schedule/router.ts` para el listado completo (departamentos, config, managers, asignación usuario-departamento, verano, CRUD de schedules, validate/publish/unpublish/clone, export, resumen mensual). No hay endpoints separados para "listar contenidos"/"listar contenedor" — `GET /:id` devuelve la vista completa ya enmascarada.

## 10. Frontend

`frontend/app/staff-schedule/page.tsx` + `frontend/components/staff-schedule/*`. Calendario semanal (filas=personas, columnas=días), popover de edición de entry, panel de alertas (con botón "Re-validar", no "resolver" — ver §5), selector de semana/departamento, paneles de configuración ADMIN (departamentos, jornada, verano, managers).

**Decisión de diseño — la gestión de departamentos vive DENTRO del módulo (no en Datos Maestros).** Los CRUD de `Department`/config/managers/asignación de usuarios están en `ScheduleConfigPanel.tsx`, accesible desde el botón "Configuración" de `/staff-schedule` (solo ADMIN), NO en `/admin/masters`. Es intencionado (el módulo posee su propia configuración, igual que DCIM con edificios/salas) — **no reubicar a Datos Maestros sin decisión explícita**. Contrapartida conocida: menor descubribilidad (un usuario que busca "departamentos" tiende a mirar primero en Datos Maestros); mitigado con notas cruzadas en `docs/USER_MANUAL.md` §18 y §34.6. Si en el futuro se decide exponerlo también en Datos Maestros, hacerlo como enlace/atajo a la misma UI, sin duplicar lógica.

## 11. Retención

Recomendado (no automatizado en v3.5.0): purgar `StaffSchedule` `PUBLISHED` con antigüedad superior a 18 meses. Ver DPIA (`docs/DPIA_STAFF_SCHEDULE.md`) para el razonamiento de minimización de datos.

## 12. Auditoría (issue #172)

Toda mutación (13 endpoints de escritura) inserta un registro en `audit_logs` **dentro de la misma transacción** que el cambio de negocio: el router envuelve `mutación + auditStaffSchedule(tx, …)` en un único `prisma.$transaction(async (tx) => { … })`. Si el insert de auditoría falla, la mutación revierte — no puede quedar una escritura sin registrar (ISO 27001 A.8.15). `auditStaffSchedule` acepta un `Prisma.TransactionClient`; los helpers de `queries.ts`/`service.ts`/`authz.ts` se ampliaron al mismo tipo para poder ejecutarse con el `tx`. El endpoint `EXPORT_STAFF_SCHEDULE` audita un **acceso de lectura** (no una escritura de negocio), por lo que se registra fuera de transacción. Test de rollback: `__tests__/auditTransaction.test.ts`.

**Deuda aceptada (problema secundario del issue #172):** los registros guardan `action`+`entity`+`entity_id`+`user_email`+`created_at` — suficiente para A.8.15 (quién, qué acción, sobre qué entidad, cuándo) y la secuencia se preserva (tabla insert-only). NO se usa la columna `details` (jsonb) para el "antes/después", y `UPDATE_SCHEDULE_ENTRIES` registra el `scheduleId` (no una fila por día/persona modificada). Es una **decisión consciente**: la reconstrucción forense fina (diff por entrada) es un *nice-to-have*, no un requisito de cumplimiento, y añadirla ahora ampliaría el volumen de `audit_logs` sin necesidad clara. Si en el futuro se requiere trazabilidad por entrada, poblar `details` con el diff es una extensión aislada de bajo riesgo.

> **Alcance:** el fix de #172 se aplicó a este módulo (el más nuevo y con datos de salud). Los dominios legacy de `index.ts` (relaciones, etc.) siguen el patrón antiguo (mutación + auditoría en pasos separados) — misma deuda preexistente, tratada como trabajo de seguimiento en el issue.

## 13. Changelog v3.5.9

### 13.1 Fix: sobre-cómputo de horas semanales (descanso de viernes)

`computeNetHours` (`validationEngine.ts`) restaba el descanso de comida en todos los días **excepto viernes**, incondicionalmente — la exclusión estaba pensada solo para el estado `INTENSIVO` (jornada continua), pero el código la aplicaba a *cualquier* viernes, tuviera o no ese estado. Una semana normal de 5×8h con viernes `PRESENCIAL` se computaba como 40.5h en lugar de 40h (el descanso del viernes nunca se restaba). **Corregido**: el descanso se aplica todos los días salvo que el estado del día sea `INTENSIVO` — el día de la semana ya no es parte de la condición.

### 13.2 Fix: el 409 de conflicto de guardia nunca se disparaba

El manejador del error de violación de restricción única de Postgres (`P2002`) que debía traducir un conflicto de guardia en un `409` limpio nunca coincidía en la práctica: Prisma informa la **tupla de columnas** violada (`['department_id', 'date']`) en `err.meta.target`, no el nombre del índice. La comparación original buscaba el nombre del índice (`schedule_entries_on_guard_unique`), que nunca aparece ahí — el resultado real era un `500` genérico en vez del `409` previsto. **Detectado durante la verificación end-to-end en producción**, no por las 2 revisiones de código previas del PR. **Corregido**: la comparación ahora coincide contra la tupla real de columnas devuelta por Prisma.

### 13.3 GUARDIA: de estado exclusivo a complemento booleano

`GUARDIA` deja de ser uno de los 9 estados de jornada mutuamente excluyentes. Pasa a ser un campo booleano independiente, `ScheduleEntry.onGuard`, que puede coexistir con cualquier estado — una persona puede estar `TELETRABAJO` y de guardia el mismo día. Los estados de jornada quedan en 8: `PRESENCIAL`, `TELETRABAJO`, `VACACIONES`, `BAJA_MEDICA`, `BAJA_PATERNIDAD`, `INTENSIVO`, `VIAJE`, `AUSENTE`.

- **Garantía a nivel de BD**: índice único parcial `schedule_entries_on_guard_unique` sobre `(department_id, date) WHERE on_guard = true` — como máximo una persona de guardia por departamento y día, imposible de violar aunque dos escrituras concurrentes pasen la validación de aplicación.
- **Aviso temprano**: nueva regla de validación `GUARDIA_UNIQUE` (motor V1-V7, ahora con una regla más) detecta el conflicto *antes* de publicar, como advertencia previa al error 409 que daría la BD si de todos modos se intentara escribir una segunda guardia.
- **Migración de datos**: las filas preexistentes con `status = 'GUARDIA'` se convirtieron a `onGuard: true` + `status: 'PRESENCIAL'`.
- Ver también §13.2 (el fix del 409 real de este índice) y `docs/DPIA_STAFF_SCHEDULE.md` (adenda) para el tratamiento GDPR de `onGuard` en el masking.

### 13.4 Clonado rediseñado + "Importar semana anterior"

El clonado anterior (`cloneToNextWeek`, implícito, sin parámetro de destino) era rígido: siempre calculaba "la semana siguiente" a partir del origen, y si esa semana concreta ya tenía planificación, el error ("ya existe una planificación para la semana siguiente") no dejaba claro que otras semanas futuras sí estaban libres.

- **`cloneToWeek`** sustituye ese flujo: el usuario elige cualquier lunes futuro sin planificación existente para ese departamento (modal con selector de fecha en el frontend); el backend rechaza con un mensaje claro solo si ese destino concreto no está disponible.
- **Nuevo: "Importar semana anterior"** — botón adicional en el estado de semana vacía que clona hacia delante la planificación de la semana inmediatamente anterior del mismo departamento. Segunda vía para poblar una semana nueva, sin pasar por el selector de fecha de Clonar.

### 13.5 Horas semanales por usuario (`weeklyTargetHours` override)

Los departamentos siguen teniendo un objetivo semanal por defecto (40h, `DepartmentScheduleConfig`), pero ahora un `ADMIN` puede fijar una **anulación individual** por usuario (p. ej. para una jornada reducida/parcial) desde el panel de configuración de horarios. Este valor alimenta:
- La regla de validación `WEEKLY_HOURS` (usa el objetivo del usuario si existe, si no el del departamento).
- El **autocompletado de hora de salida** en el editor de entrada: al introducir la hora de entrada y salir del campo, la hora de salida se calcula a partir de la jornada diaria propia del usuario (derivada de su `weeklyTargetHours` si lo tiene) más el descanso del departamento.

### 13.6 Separación de contadores de teletrabajo (semana vs. mes)

El resumen semanal ahora muestra por separado `teleworkDaysWeek` (días de teletrabajo de la semana visible) y `teleworkDaysMonth` (acumulado del mes completo) — antes solo se exponía la cifra acumulada del mes, con la etiqueta engañosa de "días de teletrabajo" sin aclarar que era del mes y no de la semana.

### 13.7 Rol `WORKER`

Nuevo rol de usuario. Se comporta exactamente igual que `VIEWER` en el resto de la aplicación, salvo que **además** obtiene acceso de lectura al módulo Staff Schedule (todos los departamentos, con las mismas reglas de enmascaramiento GDPR que `AUDITOR` — ver §7). Pensado para empleados que necesitan consultar horarios sin las capacidades más amplias de `AUDITOR`/`ADMIN`. Asignable por un `ADMIN` desde Configuración → Usuarios, igual que cualquier otro rol. No tiene autorización de escritura en este módulo ni en ningún otro (misma superficie que `VIEWER` salvo esta única lectura adicional).

### 13.8 Vista de solo lectura "Todos los departamentos"

Seleccionar "Todos los departamentos" en el filtro de departamento (en vez de uno concreto) muestra la planificación de todos los departamentos para la semana seleccionada, apilada, en modo **solo lectura** — ninguna celda es editable en esta vista, independientemente de los permisos reales del usuario que la consulta. Antes de este cambio, esa selección no mostraba nada útil.

### 13.9 "Aplicar a toda la semana"

Nuevo botón en el editor de entrada que rellena los 5 días laborables de una persona con el mismo estado/horario/notas/guardia en una sola acción, en vez de editar cada día individualmente.

### 13.10 Un departamento por usuario (confirmación de diseño)

Ya garantizado estructuralmente por el modelo de datos: `User` tiene una única FK `departmentId` opcional — este rework no cambió eso, solo lo confirma/documenta explícitamente porque surgió como pregunta de diseño durante el trabajo de esta versión.

### 13.11 Limitación conocida: sin endpoint de borrado

No existe un endpoint para eliminar una planificación (`StaffSchedule`). Una planificación en estado `DRAFT` solo puede dejarse tal cual o publicarse — nunca borrarse vía API.

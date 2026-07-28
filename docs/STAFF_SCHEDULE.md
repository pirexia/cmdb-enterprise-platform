# Módulo Staff Schedule — Documentación Técnica (v3.5.0, actualizado v3.5.12 — ver §17)

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

## 3. Estados de jornada (11) + guardia como complemento

`PRESENCIAL`, `TELETRABAJO`, `VACACIONES`, `FESTIVO`, `FESTIVO_LOCAL`, `BAJA_MEDICA`, `BAJA_PATERNIDAD`, `INTENSIVO`, `INTENSIVO_TELETRABAJO`, `VIAJE`, `AUSENTE`.

**Desde v3.5.12** (§17.7), `FESTIVO` (festivo nacional) y `FESTIVO_LOCAL` (festivo local) se comportan como `VACACIONES` para el cómputo de horas y para `PRESENCE_PCT` (0h, fuera del denominador de disponibles). Al ser `TEXT`+Zod (no un enum de PostgreSQL), añadirlos no requirió migración de BD — solo ampliar `SCHEDULE_STATUS` en `schemas.ts`.

**Desde v3.5.11** (§16.1), `INTENSIVO_TELETRABAJO` (jornada intensiva desde casa) combina las dos semánticas: cuenta como jornada continua para el cómputo de horas y como teletrabajo para la cuota. Ambas se centralizan en dos allowlists de `schemas.ts` — `INTENSIVE_STATUSES` (sin descanso, sin `FLEX_RANGE`) y `TELEWORK_STATUSES` (consumen cuota) — en lugar de comparar contra literales dispersos por el módulo.

`BAJA_MEDICA` y `BAJA_PATERNIDAD` son datos de salud (GDPR Art. 9) — ver §5.

**Desde v3.5.9** (§13.3), la guardia ya no es un estado de esta lista: es el campo booleano independiente `ScheduleEntry.onGuard`, que puede coexistir con cualquier estado de la lista anterior (p. ej. `TELETRABAJO` + `onGuard: true`).

## 4. Cálculo de horas y jornada

`computeNetHours(entry, cfg, isSummer)` (`validationEngine.ts`):
- Estados que no computan jornada (`VACACIONES`, `BAJA_*`, `AUSENTE`, `VIAJE`) → 0h.
- Si no hay `startTime`/`endTime` → 0h.
- Horas brutas = `endTime - startTime`. Se resta el descanso (`winterBreakMinutes`/`summerBreakMinutes`) salvo que el estado del día esté en `INTENSIVE_STATUSES` — `INTENSIVO` o `INTENSIVO_TELETRABAJO`, jornada continua sin descanso (v3.5.11). **Corregido en v3.5.9** — ver §13.1: la versión anterior excluía el descanso en todos los viernes, no solo en los `INTENSIVO`, inflando una semana normal de 40h a 40.5h.
- `detectSummer(weekStart, summerSchedule)` compara `weekStart` contra el periodo `[startDate,endDate]` del `SummerSchedule` del año.

## 5. Motor de validaciones (V1-V8, antes V1-V7)

Ejecutado por `POST /:id/validate` (`validationEngine.validate()`, puro y síncrono — recibe `teleworkCountsByUser` ya calculado por el `service`).

| Tipo | Severidad | Regla |
|---|---|---|
| `DAILY_HOURS` | ERROR | Un día lunes-jueves supera el máximo diario configurado |
| `WEEKLY_HOURS` | ERROR | Hay viernes `INTENSIVO` pero el total semanal no alcanza el objetivo **efectivo** (40h por defecto, o el override individual del usuario — v3.5.9, §13.5; reducido por días `VACACIONES`/`FESTIVO`/`FESTIVO_LOCAL` de la semana — v3.5.12, §17.7) |
| `TELEWORK_QUOTA` | ERROR | Días de teletrabajo del mes superan la cuota mensual **efectiva del trabajador** (v3.5.11, §16.2: override propio si lo tiene, si no el tope del departamento; un trabajador marcado como 100% teletrabajo queda exento) |
| `GUARDIA_COVERAGE` | ERROR | Un usuario tiene `onGuard: true` y `VIAJE`/`VACACIONES` en la misma semana (antes de v3.5.9: estado `GUARDIA` en vez de `onGuard`) |
| `GUARDIA_UNIQUE` | ERROR | **Nuevo en v3.5.9** (§13.3) — más de un usuario con `onGuard: true` el mismo día dentro de la misma planificación. Aviso temprano en la UI de validación de un `DRAFT`; la garantía dura entre planificaciones históricas es el índice único parcial `schedule_entries_on_guard_unique`, aplicado en `service.ts` al escribir |
| `BAJA_CONFLICT` | WARNING | Un usuario tiene baja médica/paternidad y también `PRESENCIAL`/`TELETRABAJO` en la misma semana |
| `FLEX_RANGE` | WARNING | Entrada/salida fuera de la ventana flexible configurada |
| `PRESENCE_PCT` | WARNING | El % de personal presencial que **solapa** la franja de presencialidad no alcanza el mínimo del departamento. El denominador cuenta solo a quien está disponible ese día (v3.5.11, §16.3 — corrige un 0.0% permanente) |

**Desviación documentada respecto al diseño original**: `GUARDIA_COVERAGE` y `BAJA_CONFLICT` se evalúan a **nivel semanal**, no "mismo día", porque `ScheduleEntry` tiene un único `status` por `(schedule, user, date)` — un día no puede tener dos estados simultáneos, así que la regla "mismo día con dos estados" sería código muerto bajo el schema real.

Una planificación con alertas `ERROR` sin resolver **no puede publicarse** (`POST /:id/publish` → 409). Corregir las entries y volver a validar es el único mecanismo de "resolución" — no existe un endpoint para marcar una alerta como resuelta manualmente.

## 6. Autorización

> **Cambiado en v3.5.10** (ver §14). `WORKER` pasa a llamarse `MANAGER` y `VIEWER` recupera el acceso de lectura al módulo, limitado a horarios publicados.

| Rol | Horarios publicados | Borradores | Editar / publicar | Configuración del módulo |
|---|---|---|---|---|
| `VIEWER` | ✅ lectura (enmascarada) | ❌ | ❌ | ❌ |
| `AUDITOR` | ✅ lectura (enmascarada) | ❌ | ❌ | ❌ |
| `MANAGER` | ✅ lectura (enmascarada) | ✅ solo los departamentos que gestiona | ✅ solo los departamentos que gestiona | ❌ |
| `ADMIN` | ✅ todos | ✅ todos | ✅ todos | ✅ departamentos, verano, managers, `unpublish` |

- Los cuatro roles superan `requireScheduleAccess`; **qué** ven se decide en la consulta, no en el middleware.
- La visibilidad se aplica **en la cláusula `WHERE` de Prisma** (`buildScheduleVisibilityFilter`, `queries.ts`), nunca por filtrado posterior en memoria — los controles de acceso a filas deben ser filtros de BD (OWASP A01). Un horario fuera de alcance devuelve **404**, no 403: un borrador ajeno no debe revelar siquiera que existe.
- Un rol desconocido cae en la rama más restrictiva (solo publicados), de modo que añadir un rol al enum sin tocar esa función no abre datos por accidente.
- **`MANAGER` fuera de este módulo**: equivalente a `AUDITOR` (lectura, incluida DCIM), salvo los registros de auditoría, que le quedan vetados — `requireAudit` sigue admitiendo solo `ADMIN` y `AUDITOR`, y el informe `audit-trail` está en una denylist explícita porque el rango lineal de roles por sí solo se lo concedería.
- **Manager de departamento** (`DepartmentManager`): la autorización de escritura sigue siendo row-level y no cambia. Tener rol `MANAGER` no otorga por sí solo edición: hace falta la fila `DepartmentManager` del departamento concreto.

`canUserEditDepartment(prisma, userId, role, departmentId)` (`authz.ts`) es la función compartida entre el middleware (`requireDeptEditAccess`) y el cálculo del campo `canEdit` devuelto al frontend — el cliente nunca decide por sí mismo si puede editar.

**Desde v3.5.12** (§17.2), `canViewSummary()` (`service.ts`) **delega** en `canUserEditDepartment` — no reimplementa el criterio — para decidir si `ScheduleRow.summary` (horas semanales, teletrabajo, guardias, viajes) se incluye en la respuesta: ADMIN o gestor de *ese* departamento concreto, no por rango de rol. El campo se **omite del JSON**, no se envía a cero, para quien no está autorizado — mismo patrón que `healthLeaveDays` en §7.

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


## 14. Changelog v3.5.10

### 14.1 `WORKER` pasa a `MANAGER`, un perfil intermedio real

El rol `WORKER` introducido en v3.5.9 era `VIEWER` con una excepción para este módulo. Se renombra a `MANAGER` y se le da el alcance que su nombre sugiere: administra y publica los horarios de los departamentos que gestiona, y fuera del módulo lee lo mismo que un `AUDITOR` **salvo los registros de auditoría**.

El renombrado se hizo con `ALTER TYPE "UserRole" RENAME VALUE 'WORKER' TO 'MANAGER'`, así que las filas existentes conservaron su rol sin migración de datos.

**Cambio de permisos a tener en cuenta al actualizar**: quien tuviera `WORKER` gana lectura de DCIM y de los informes de rango `AUDITOR`.

### 14.2 `VIEWER` recupera el módulo, limitado a lo publicado

Antes `VIEWER` estaba bloqueado del módulo entero. Ahora entra y ve los horarios **publicados** de todos los departamentos, con el mismo enmascaramiento de datos de salud que ya se aplicaba a `AUDITOR`. Reabrir el módulo no debilita el masking: éste nunca dependió de que `VIEWER` estuviera bloqueado, sino de si el visor es `ADMIN` o el propio interesado (§7).

### 14.3 Nombre real de AD en lugar del `sAMAccountName`

Nueva columna `users.display_name`, poblada desde el `displayName` del directorio en la auto-provisión y refrescada en cada login. El calendario, el popover de entrada, el panel de alertas y los selectores de usuario muestran «Andrés Matías López» en lugar de «andres.matias», con respaldo al `username` para cuentas locales o filas anteriores a v3.5.10 (`displayLabel`, `frontend/lib/displayLabel.ts`).

Es dato personal: no aparece en ningún mensaje de log, y desaparece con la fila en la erasure GDPR, que hace `DELETE` y no anonimización por campos (§8).

### 14.4 Resumen mensual

`getMonthlySummary` agrega ahora solo los horarios que el visor tiene derecho a ver, filtrando por la relación en la propia consulta. Excepción deliberada: el propio usuario ve siempre su resumen completo aunque el horario esté en borrador — son sus datos.

## 15. Refinamientos v3.5.10 (segunda tanda, detectados en verificación en vivo)

### 15.1 `FLEX_RANGE` no aplica a `INTENSIVO`

La alerta "fuera de horario flexible" se disparaba para entradas `INTENSIVO`, que es jornada continua con horario propio y no usa la ventana flexible de entrada/salida. La regla se restringe a los estados que sí la usan (`PRESENCIAL`, `TELETRABAJO`) en lugar de excluir solo `INTENSIVO`.

### 15.2 Endpoints GET de managers y miembros de departamento

`GET /departments/:id/managers` y `GET /departments/:id/members` — antes no existía ninguno de los dos; el panel de configuración solo podía añadir/quitar managers a ciegas y no mostraba quién pertenecía al departamento. Lectura pura, sin auditoría, protegida por `requireScheduleAccess`.

### 15.3 `DELETE /:id` — descartar un horario en borrador

Solo `DRAFT` (D10: un `PUBLISHED` debe despublicarse antes). `ScheduleEntry`/`ScheduleAlert` caen por `onDelete: Cascade`. Resuelve el callejón sin salida de un horario creado o clonado antes de que el departamento tuviera su membresía final: sin este endpoint, la semana quedaba permanentemente bloqueada para volver a clonarse.

### 15.4 `POST /:id/sync-members` — resincronizar miembros

Añade entradas base `PRESENCIAL` para los miembros activos del departamento que aún no tengan ninguna entrada en el horario. **No destructivo**: nunca toca entradas existentes, idempotente. Solo `DRAFT`. Cubre dos escenarios: un horario vacío o parcial (creado antes de la membresía final del departamento) y un trabajador nuevo que se incorpora a un departamento con horarios ya planificados meses por delante.

### 15.5 Orden manager-first en el calendario

`buildScheduleView` ordenaba las filas por el orden de iteración interno del `Map` (efectivamente por `userId`, sin significado para quien lo lee). Ahora el/los responsables del departamento (`DepartmentManager`) aparecen primero, y el resto se ordena alfabéticamente por `displayName` (con respaldo a `username`). Comparador puro `sortRowManagerFirst`, testeado sin necesidad de montar toda la maquinaria de `buildScheduleView`.

### 15.6 Panel de configuración: managers y miembros visibles

El panel ahora lista los managers actuales de cada departamento (con botón de quitar por fila, ya no a ciegas desde el mismo `<select>` de añadir) y los miembros activos. La edición de horas semanales del trabajador pasa a tener su propio selector — antes reutilizaba el de la sección "asignar departamento", así que sin elegir un trabajador ahí el botón de guardar nunca se habilitaba — y el campo se prefija con las horas efectivas actuales del trabajador elegido.

### 15.7 UI de horario vacío

Cuando un horario existe (`StaffSchedule`) pero no tiene ninguna fila, se muestra un aviso con los botones "Sincronizar miembros" y "Eliminar" en lugar de una rejilla vacía sin ninguna acción disponible. Los mismos dos botones aparecen en la cabecera para cualquier horario `DRAFT` editable, para poder incorporar nuevos trabajadores a una planificación ya hecha.

## 16. Cambios de v3.5.11

### 16.1 Estado `INTENSIVO_TELETRABAJO`

Jornada intensiva realizada desde casa. Combina las dos semánticas ya existentes: no deduce descanso (como `INTENSIVO`) y consume cuota mensual de teletrabajo (como `TELETRABAJO`). Queda fuera de `FLEX_RANGE` por la misma razón que `INTENSIVO` (§15.1): es jornada continua con horario propio y no usa la ventana flexible.

Las tres semánticas no se expresan como comparaciones sueltas contra literales, sino mediante dos allowlists en `schemas.ts`:

- `INTENSIVE_STATUSES` = `['INTENSIVO', 'INTENSIVO_TELETRABAJO']` → sin descanso en `computeNetHours`, fuera de `FLEX_RANGE`, cuentan como "viernes intensivo" para `WEEKLY_HOURS`.
- `TELEWORK_STATUSES` = `['TELETRABAJO', 'INTENSIVO_TELETRABAJO']` → consumen cuota (`countTeleworkThisMonth`) y suman a los contadores `teleworkDaysWeek` / `teleworkDaysMonth`.

Un estado futuro que sea intensivo, teletrabajo o ambos se añade a la lista correspondiente, sin tener que cazar comparaciones dispersas por el módulo.

### 16.2 Cuota de teletrabajo por trabajador

Tres campos nuevos en `users`, todos opcionales — sin ninguno fijado, el comportamiento es exactamente el anterior (tope del departamento):

| Campo | Significado |
|---|---|
| `telework_full` | Exento de la cuota (p. ej. 100% teletrabajo por motivos médicos) |
| `telework_quota_days` | Tope mensual propio, en días |
| `telework_quota_pct` | Tope mensual propio, como % de los días laborables del mes |

`resolveTeleworkCap()` (puro, en `validationEngine.ts`) resuelve el tope efectivo con prioridad **total > días > porcentaje > tope del departamento** (D1). Devuelve `null` para el trabajador exento — explícitamente "sin tope", no un `Infinity` que se pudiera comparar por accidente.

**D2 — la base del porcentaje son los días L-V del mes natural**, no los días efectivamente planificados como trabajo. Con la segunda opción el tope se movería según se rellena el horario, que es justo lo contrario de lo que se espera de una cuota.

Edición: `PUT /api/staff-schedule/users/:userId/telework-quota` (solo ADMIN, mutación + `AuditLog` en una única transacción) y el panel de configuración del módulo. Los rangos se validan en Zod **y** con `CHECK` constraints en la BD, para que el invariante aguante también una escritura que no pase por la API.

### 16.3 Fix: `PRESENCE_PCT` reportaba siempre 0.0%

**Causa raíz.** La regla contaba a un trabajador como presente solo si su jornada **contenía por completo** la franja núcleo (`startTime <= presenceStart && endTime >= presenceEnd`). Con la configuración real del departamento —franja `09:00–18:00`, 9 h— y jornadas de ~8.5 h, ninguna jornada real podía satisfacerla nunca: el numerador era 0 por construcción y la alerta se disparaba todos los días con `0.0%`, hubiera quien hubiera en la oficina.

**Correcciones.**

1. **Solape en vez de contención**: `startTime < presenceEnd && endTime > presenceStart`. La métrica pasa a significar "% de la plantilla disponible que está en la oficina ese día", que es lo que expresa "presencialidad mínima del 50%".
2. **Denominador = personal disponible**: se excluyen los estados que no computan jornada (`VACACIONES`, `BAJA_*`, `AUSENTE`, `VIAJE`). Quien está de vacaciones no puede estar presente; contarlo hacía que una semana de vacaciones incumpliera el mínimo por definición.
3. **`PRESENCIAL` sin horas cuenta como presente**: es la forma exacta en que `createSchedule` siembra una semana nueva. Sin esta regla, toda semana recién creada reportaría 0% hasta rellenar los horarios uno a uno.

Un día en que nadie está disponible (todo el departamento de vacaciones) no genera alerta: el denominador es 0 y la métrica no está definida.

## 17. Cambios de v3.5.12 — UX de la vista, filtro por trabajador, vista mensual e impresión

Spec: `docs/internal/specs/2026-07-28-v3.5.12-staff-schedule-ux-print.md`. Plan: `docs/internal/plans/2026-07-28-v3.5.12-staff-schedule-ux-print.md`.

### 17.1 Geometría de tabla uniforme y altura de fila mínima

`StaffScheduleCalendar.tsx` pasa de `w-full` + `min-w-*` por columna (ancho dependiente del contenido) a `table-fixed` + `<colgroup>` con porcentajes declarados — así todas las tablas de departamento tienen exactamente el mismo reparto de columnas, sin depender de qué texto contenga cada una. Dos repartos según haya o no columna de resumen visible (§17.2): con resumen, persona 16% / cada día 13.6% / resumen 16%; sin resumen, persona 16% / cada día 16.8%.

`ScheduleCell.tsx` pasa de `min-h-[3.5rem]` (altura variable) a `h-11` fija, padding mínimo, y el nombre del estado en `line-clamp-2` para que un estado largo (`INTENSIVO_TELETRABAJO`, `BAJA_PATERNIDAD`) parta en dos líneas en vez de desbordar o forzar la fila más alta. Con `table-fixed` + altura fija, todas las filas de todas las tablas quedan idénticas por construcción.

### 17.2 Resumen semanal restringido a ADMIN/gestor del departamento

`ScheduleRow.summary` (horas semanales, teletrabajo, viajes, guardias) pasa a **opcional**. `canViewSummary()` (`service.ts`) delega en `canUserEditDepartment` — mismo criterio que `canEdit`, no un criterio nuevo que pudiera divergir con el tiempo. `buildScheduleView` omite la clave `summary` entera (no la envía a `0`) para quien no está autorizado. El export CSV/XLSX hereda el control automáticamente al operar sobre una `ScheduleView` ya así construida.

**Decisión**: autorizado = ADMIN **o** gestor de *ese* departamento concreto — no "MANAGER o superior" por rango de rol. Un `MANAGER` no ve el resumen de departamentos que no gestiona; coherente con cómo `canEdit` y el masking Art. 9 siempre han razonado en este módulo.

### 17.3 Alertas ocultas cuando el horario está publicado

`AlertPanel` solo se renderiza si `status === 'DRAFT'`; al ocultarse, el calendario pasa de `grid xl:grid-cols-[1fr_20rem]` a ancho completo. Las alertas siguen en BD (publicar sigue exigiendo 0 `ERROR` sin resolver, D10 sin cambios) — solo se deja de mostrar el panel de un horario ya cerrado.

### 17.4 Filtro por trabajador (semana / mes)

Dos endpoints nuevos:

- `GET /api/staff-schedule/users?q=` — buscador para el selector. `q` mínimo 2 caracteres (400 si no), resultado máx. 20, `active: true` y `departmentId != null`. Devuelve **solo** `{id, username, displayName}` — sin `email` (minimización GDPR Art. 5.1.c, un selector no necesita el correo).
- `GET /api/staff-schedule/user/:userId/entries?from=&to=` — entradas de un trabajador en un rango, acotado a **62 días** server-side (400 si se excede). Visibilidad resuelta en el `WHERE` (`buildScheduleVisibilityFilter`, igual que el resto del módulo) — un `VIEWER` consultando un trabajador con horario en `DRAFT` recibe un array vacío, nunca 403 (no se revela que el borrador existe). Cada entrada pasa por `maskEntryForViewer`. `weeklyTargetHours` por entrada se agrupa por `(departmentId, lunes ISO de la semana)` y usa el mismo `computeEffectiveWeeklyTarget` de §17.7 — no un valor plano por departamento — para que la vista de trabajador no diverja de la vista de departamento.

`WorkerFilter.tsx` (combobox con búsqueda, debounce 250ms, mismo patrón que el combobox de sistemas de `/decommission`) + `WorkerScheduleView.tsx` (semana: fila única; mes: rejilla L-V por semanas). Siempre de solo lectura — la edición sigue exclusiva de la vista departamento-semana, donde vive la autorización row-level.

### 17.5 Vista mensual de un departamento

`GET /api/staff-schedule` gana `from`/`to` opcionales sobre `weekStart`, **además** del `weekStart` exacto preexistente (nunca lo sustituye — los llamantes actuales siguen funcionando sin cambios). Acotado a **6 semanas** server-side. `DepartmentMonthView.tsx` apila una `StaffScheduleCalendar` de solo lectura por semana; una semana sin horario se muestra como fila explícita "sin horario" (nunca se omite en silencio — un hueco sería indistinguible de un fallo de carga).

### 17.6 Impresión con previsualización

Decisión: CSS de impresión (`app/print.css`) + `window.print()`, sin dependencias nuevas — el diálogo nativo del navegador **es** la previsualización (imprimir o guardar como PDF). Descartado jsPDF/html2canvas: +1MB de bundle, superficie CVE nueva (A06), texto rasterizado no seleccionable, y control de saltos de página manual frente a `break-inside: avoid`, que es la primitiva exacta para "no partir una tabla salvo que sea más grande que la página entera".

`.print-block` en cada tabla (evita que se parta entre páginas), `.no-print` en cabecera/filtros/botones de acción, `.print-only` para una cabecera de documento autoexplicativa (título, departamento/trabajador, rango, fecha de generación) — imprescindible porque un PDF suelto sale del contexto de la aplicación.

**Auditoría de impresión (ISO 27001 A.8.15)**: imprimir es una exportación de datos personales fuera del sistema, igual que CSV/XLSX. `POST /api/staff-schedule/audit/print` valida que el `targetId` es visible para el visor (404 si no, sin revelar existencia) e inserta `AuditLog` con acción `PRINT_STAFF_SCHEDULE` dentro de una `$transaction`; `user_email` viene **siempre** de la sesión, nunca del cuerpo de la petición (verificado en vivo: un `userEmail` falsificado en el body se ignora). El ping es fire-and-forget desde `PrintButton.tsx` (`beforeprint`, cubre tanto el botón como Ctrl+P nativo) — un fallo de red no bloquea la impresión (D7): el dato ya está en pantalla, impedir imprimir no protegería nada.

**Bug real cazado en verificación en vivo (no en revisión de código)**: para la vista departamento-semana, `targetId` se envió inicialmente como el **id del horario** (`view.schedule.id`), pero `isDepartmentVisibleToViewer` (compartida con `DEPARTMENT_MONTH`) siempre resuelve `targetId` como un **id de departamento**. Toda impresión desde esa vista devolvía 404 silenciosamente en vez de registrar la exportación. Confirmado en producción con la cuenta AUDITOR de pruebas (404 con `targetId` incorrecto, 204 + fila de auditoría correcta tras el fix), corregido a `view.schedule.departmentId`.

#### 17.6.1 Orientación de página — una sola `@page` por trabajo de impresión

> **No reintroducir una segunda `@page` con nombre.** Esta sección documenta un intento fallido para que no se repita.

El primer diseño usaba dos reglas: `@page` por defecto (apaisada) y una `@page portrait-narrow` con nombre, seleccionada por vista con la propiedad `page` sobre una clase `.print-portrait`. **Chromium no re-maqueta el contenido cuando una página con nombre cambia el TAMAÑO a mitad de documento**: el contenido conserva el ancho del contexto de página anterior y se recorta sobre la hoja del nuevo tamaño.

Diagnosticado sobre el PDF real generado por el usuario (analizado con `pypdf`, no a ojo):

| Página | Geometría | Contenido |
|---|---|---|
| 1 | 297×210 mm (apaisada) | solo la cabecera del documento |
| 2-3 | 210×297 mm (vertical) | tablas maquetadas al ancho apaisado → ~398pt fuera del borde derecho |

Las tablas se maquetaron con el ancho útil de la hoja apaisada (~785pt) y se emitieron sobre hojas verticales (561pt útiles): se perdía por la derecha desde el jueves en adelante. La cabecera, al vivir **fuera** del contenedor `.print-portrait`, pertenecía al otro contexto de página y se llevaba una hoja apaisada entera para ella sola. Se comprobó que las reglas CSS estaban correctamente compiladas en el contenedor — el enfoque era el equivocado, no las reglas.

**Diseño actual**: la orientación se elige **una vez por trabajo de impresión**, reescribiendo desde JS una única regla `@page` en un `<style>` dedicado — `usePrintPageOrientation(orientation)` en `hooks/useStaffSchedule.ts`. Con una sola geometría en todo el documento, maquetación y papel siempre coinciden. La regla se mantiene sincronizada con la vista activa (no se escribe en el `onClick`), de modo que el Ctrl+P nativo del navegador también obtiene la orientación correcta, sin depender del momento en que se ejecute nuestro manejador.

| Vista | Orientación | Motivo |
|---|---|---|
| Todos los departamentos | Vertical, márgenes 6mm | Apila varias tablas estrechas; prioriza hojas, no ancho |
| Departamento — mes | Vertical, márgenes 6mm | Ídem, por semanas |
| Departamento — semana | Apaisada, márgenes 8mm | Rejilla ancha de 7 columnas |
| Trabajador | Apaisada, márgenes 8mm | Ídem |

#### 17.6.2 Qué NO llega al papel, y por qué el ancho encaja

- **Cromo de aplicación**: `AppShell.tsx`/`TopBar.tsx` marcan barra lateral y barra superior como `.no-print`. No bastaba con marcar la cabecera del propio módulo: esos componentes viven fuera de él y el CSS del módulo no los alcanzaba, así que la impresión salía con la barra lateral.
- **Fondos**: `print-color-adjust: exact` está acotado a `.print-block` — nunca a `*`. Aplicado globalmente forzaba a imprimir los fondos gris claro de la aplicación (`bg-slate-50`), gastando tóner en un tinte que nadie necesita. El informe sale sobre blanco salvo los colores de estado del calendario.
- **Barras de desplazamiento**: `<main className="overflow-y-auto">` (`.app-main-scroll`) es el contenedor real de scroll de la aplicación; sin neutralizarlo algunos navegadores dibujaban su barra en el PDF.
- **Resumen y alertas**: `.no-print` sobre la columna de resumen y el panel de alertas, **con independencia del rol** — regla más fuerte que el control de acceso en pantalla (§17.2): quien sí ve el resumen en pantalla tampoco lo obtiene en papel, porque el informe impreso es solo la rejilla del calendario.
- **Ancho**: la tabla mantiene `table-layout: fixed` en impresión. Un intento previo lo cambió a `auto` para que las columnas restantes reocuparan el hueco de la columna de resumen oculta; fue el error que rompió el encaje, porque con `auto` **es el contenido quien decide el ancho** y un estado largo (`INTENSIVO_TELETRABAJO`) empujaba la tabla fuera de la página. Reducir el tamaño de fuente no lo arreglaba y por eso la letra menguaba sin que la tabla encogiera. Con `fixed` los porcentajes del `<colgroup>` reparten el ancho disponible y el contenido nunca puede ensancharla; el reflujo tras ocultar la columna de resumen lo da el propio `display:none` del `<col>`, que hace que el 84% declarado restante se escale hasta el 100%.

#### 17.6.3 Cabecera del documento

Dos líneas exactas, por el requisito de condensar: línea 1 el título más el número de semana ISO cuando se imprime una sola semana (`isoWeekNumber()`, p. ej. «… semana 31 de 2026»); línea 2 pliega departamento/trabajador, rango y «Generado: …». Se renderiza **una sola vez**, en `page.tsx`, para las cuatro vistas — `AllDepartmentsView` llegó a renderizar la suya propia y el encabezado salía duplicado.

### 17.7 Estados `FESTIVO`/`FESTIVO_LOCAL` y objetivo semanal por semana

Ver §3. Además de contar como 0h (igual que `VACACIONES`), estos dos estados —junto con `VACACIONES`— **reducen el objetivo de horas semanales** en vez de contar como un déficit contra un objetivo plano de 40h.

`computeEffectiveWeeklyTarget(entries, cfg, isSummer, baseTarget)` (`validationEngine.ts`) resta, por cada día `VACACIONES`/`FESTIVO`/`FESTIVO_LOCAL` de la semana del usuario, las horas contratadas de ese día concreto (`winterFridayNetHours`/`summerFridayNetHours` si es viernes, `winterDailyNetHours`/`summerDailyNetHours` el resto), con suelo en 0. Deliberadamente **más estrecho** que `NON_WORKING_STATUSES`: `BAJA_MEDICA`, `BAJA_PATERNIDAD`, `AUSENTE` y `VIAJE` siguen contando como déficit contra el objetivo completo — solo vacaciones y festivos lo reducen (decisión de producto).

Aplicado en los tres sitios donde se calcula o valida un objetivo semanal: la alerta `WEEKLY_HOURS` (§5), `ScheduleRow.summary.weeklyTargetHours` en `buildScheduleView` (la vista de departamento), y `UserEntryView.weeklyTargetHours` en `listUserEntries` (la vista de trabajador, §17.4 — agrupado por semana, no un valor plano por departamento, para que las dos vistas no diverjan).

**Verificado en vivo contra producción**: una semana real de 5 días `VACACIONES` (departamento con `weeklyTargetNetHours=40`, `summerDailyNetHours=8`, `summerFridayNetHours=6`) reporta `weeklyTargetHours: 2` — exactamente `40 - (4×8 + 6) = 2`. Una entrada `FESTIVO` de prueba en lunes (semana de invierno, `winterDailyNetHours=8`) redujo el objetivo de 40 a 32, creada y eliminada sobre un horario `DRAFT` desechable, sin tocar datos reales.

### 17.8 Lección operativa — rutas relativas en `.env` y el checkout desde el que se despliega

Durante el despliegue de esta versión, ejecutar `podman-compose` desde el **worktree** de integración (no desde `/opt/cmdb-enterprise-platform`) hizo que `DOCUMENTS_STORAGE_PATH=./document-storage` (ruta relativa) resolviera contra el directorio equivocado — un `document-storage/` vacío recién creado en el worktree, en vez del real. El backend entró en crash-loop por un `EACCES` al intentar `mkdir` en él, **antes** de escribir nada (ningún dato tocado ni perdido; los certificados TLS usan el volumen nombrado `cmdb-tls-certs`, no una ruta relativa, así que no se vieron afectados). Corregido desplegando siempre desde el checkout principal, donde las rutas relativas del `.env`/`docker-compose.prod.yml` resuelven contra los directorios reales de producción. Añade matiz a la regla ya documentada en memoria ("worktrees no heredan `.env`"): copiar el `.env` no basta si además se ejecuta el despliegue desde el worktree — el propio directorio de trabajo importa para toda ruta relativa del compose, no solo para las variables.

**Verificación en producción** contra el departamento real, día 2026-07-27: 1 presente de 3 disponibles (1 de vacaciones y 1 de baja fuera del denominador) → `33.3%`, contrastado contra las filas de la BD. Bajo la regla anterior el mismo día daba `0/5 = 0.0%`.

### 17.9 Defectos encontrados en la verificación en navegador (no por revisión de código)

El entorno de desarrollo de esta sesión no permitía instalar Chrome (sin `sudo`), así que la verificación automatizada llegó hasta la capa de API. Los siguientes defectos **solo aparecieron cuando el usuario probó la interfaz real**, y conviene registrarlos como clase de fallo, no solo como incidencias sueltas.

#### 17.9.1 Crash de la vista de trabajador — contrato desalineado entre agentes paralelos

Seleccionar un trabajador rompía la página con `Cannot read properties of undefined (reading 'status')`.

`WorkerEntryItem` (frontend) declaraba una forma **anidada** — `{ date, departmentName, entry: MaskedEntryFields }` — mientras que `UserEntryView` (backend, `service.ts`) siempre ha sido **plana**: `status`/`onGuard`/`startTime`… en el primer nivel. Las dos piezas las construyeron agentes distintos en paralelo (B3 backend, F4 frontend) contra un contrato descrito en prosa, y nunca coincidieron.

**Por qué no lo cazó nada antes**: `tsc` no puede detectarlo porque la respuesta del `fetch` se convierte al tipo declarado sin validación en tiempo de ejecución (`await res.json() as WorkerEntryItem[]`) — TypeScript cree lo que se le afirma. Los tests de backend verificaban la forma real del servidor; los del frontend no existen para componentes. La lección aplicable: **cuando dos tareas paralelas comparten un contrato de API, el tipo del cliente debe derivarse del tipo del servidor o validarse en ejecución**, o el desalineamiento sobrevive a todas las comprobaciones estáticas.

#### 17.9.2 Filas fijas del calendario pintando sobre el título de la vista

Al hacer scroll, la fila de cabecera y la primera columna del calendario se superponían al título de la página.

Causa: conflicto de `z-index`. La cabecera de página es `sticky z-10`; el `thead` del calendario es `z-20` y su primera columna congelada `z-30`. El contenedor de la tabla no crea contexto de apilamiento propio (no tiene `position`, `z-index` ni `transform`), así que esos valores compiten **directamente** con el de la cabecera y ganan. Corregido subiendo la cabecera a `z-40`: por encima de la tabla, por debajo de modales y popovers del módulo (`z-50`).

#### 17.9.3 Bloques de color de estado con tamaños distintos

El color del estado vivía en el `<button>` interior, que tenía altura fija `h-11`. Cuando una fila crecía —porque otra celda partía a dos líneas— el botón se quedaba en sus 44px y dejaba espacio sin colorear dentro de la celda, de modo que los bloques parecían de tamaños diferentes.

Corregido con `h-full` en lugar de la altura fija, manteniendo el color en el `<button>` y el `p-0.5` del `<td>` (el margen interior que separa visualmente el bloque del borde de la celda). Una celda de tabla siempre se estira hasta la altura de su fila y un porcentaje de altura en su hijo se resuelve contra esa altura **usada**, así que el bloque crece con la fila. Se probó antes mover el color al `<td>`: garantizaba el relleno completo pero eliminaba el margen interior, así que se descartó.

> Consecuencia en impresión: por esto **no** se colapsa la altura de celda a `auto` en `@media print` aunque ahorraría milímetros por fila — con una altura indefinida el porcentaje del bloque colapsa a la altura del contenido y los bloques vuelven a salir desiguales en papel. La densidad del informe la aportan la orientación y el espaciado condensado, no el encogido de celdas.

#### 17.9.4 Número de día en la rejilla mensual

La rejilla mensual de la vista de trabajador solo mostraba los nombres de los días de la semana (lun-vie) reutilizados en cada fila, sin ninguna indicación de qué día del mes era cada celda. `ScheduleCell` gana una prop opcional `dayNumber` que se pinta como una pequeña marca en la esquina; las vistas semanales la omiten porque su cabecera de columna ya lleva la fecha completa. `DepartmentMonthView` no la necesita: cada semana muestra su rango de fechas en su propia cabecera.

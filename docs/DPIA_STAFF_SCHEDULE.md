# Evaluación de Impacto en la Protección de Datos (DPIA) — Módulo Staff Schedule

**Referencia:** GDPR Art. 35 (Evaluación de impacto relativa a la protección de datos) y Art. 9 (Categorías especiales de datos).
**Fecha:** 2026-07-09 · **Versión del módulo:** v3.5.0 · **Responsable del tratamiento:** [a completar por la organización desplegante]

---

## 1. Descripción del tratamiento

### 1.1 Finalidad
Planificación, visualización y validación de horarios de trabajo semanales del personal, organizados por departamento. **No es un sistema de fichaje/control horario en tiempo real** — es una herramienta de planificación previa. No registra accesos, geolocalización, ni biometría.

### 1.2 Naturaleza del tratamiento
- Almacenamiento de un estado diario por persona (`ScheduleEntry`: fecha, estado de jornada, horario planificado, notas libres).
- Cálculo agregado de horas trabajadas, días de teletrabajo, viajes y guardias.
- Generación automática de alertas de incumplimiento de política horaria.
- Autorización de escritura delegada a responsables de departamento (no solo administradores de sistema).

### 1.3 Categorías de interesados
Empleados de la organización cuyos usuarios existen en el CMDB (cuentas locales, LDAP/AD, o SSO Microsoft ya provisionadas — este módulo no crea identidades nuevas, reutiliza `User`).

### 1.4 Categorías de datos tratados

| Dato | Categoría | Fuente |
|---|---|---|
| Paradero diario (presencial/teletrabajo/viaje/guardia/ausente) | Dato personal ordinario | `ScheduleEntry.status` |
| Horario de entrada/salida planificado | Dato personal ordinario | `ScheduleEntry.startTime/endTime` |
| **Baja médica** (`BAJA_MEDICA`) | **Categoría especial — Art. 9 (salud)** | `ScheduleEntry.status` |
| **Baja de paternidad/maternidad** (`BAJA_PATERNIDAD`) | **Categoría especial — Art. 9 (salud/situación familiar asociada a permiso legal)** | `ScheduleEntry.status` |
| Notas libres asociadas a un día | Potencialmente dato personal ordinario o especial según contenido introducido por el usuario | `ScheduleEntry.notes` |
| Departamento y rol de responsable | Dato personal ordinario | `User.departmentId`, `DepartmentManager` |

**Nota sobre el campo `notes` (texto libre):** es el único vector residual de riesgo no eliminado por diseño — un usuario podría escribir información de salud adicional en el campo de notas de una entry `BAJA_MEDICA`. El campo `notes` se enmascara (`null`) por `maskEntryForViewer()` exactamente igual que `startTime`/`endTime` cuando el estado es de salud y el viewer no está autorizado, por lo que el mismo control de acceso lo cubre. Recomendación operativa: formar a los usuarios para no introducir diagnósticos o detalles médicos en `notes` (minimización en origen).

## 2. Necesidad y proporcionalidad

### 2.1 Base jurídica
- **Datos ordinarios de horario/paradero**: interés legítimo de la organización en la gestión y organización del trabajo (planificación de cobertura de servicio, guardias, cumplimiento de jornada).
- **Datos de salud (bajas)**: obligación legal en el ámbito laboral (gestión de ausencias por incapacidad temporal/permisos parentales) — Art. 9.2.b GDPR (obligaciones y derechos específicos en el ámbito del Derecho laboral y de seguridad social). **La organización desplegante debe confirmar esta base jurídica según su jurisdicción antes de producción** — este documento no sustituye asesoría legal local.

### 2.2 Minimización de datos
- El módulo **no** registra fichajes reales (hora exacta de entrada/salida efectiva), solo la planificación — evita duplicar datos ya tratados, si existiera, por un sistema de control horario legal separado.
- Los 9 estados de jornada están predefinidos (allowlist Zod) — no hay campo de texto libre para "motivo de ausencia" más allá de `notes`, que es opcional.
- No se solicita el diagnóstico ni la causa de la baja médica — solo el hecho de que existe (`BAJA_MEDICA` como categoría, sin subtipo).
- `SummerSchedule`/`DepartmentScheduleConfig` son configuración organizativa, no datos personales.

### 2.3 Necesidad de esta arquitectura de autorización
La autorización row-level (`DepartmentManager`) es una medida de minimización de **acceso**, no de dato: sin ella, cualquier funcionalidad de edición delegada habría requerido conceder rol `ADMIN` global (acceso de escritura a todo el CMDB) a responsables de equipo — una escalada de privilegio desproporcionada respecto a la finalidad (gestionar horarios de su propio departamento).

## 3. Medidas para gestionar los riesgos

### 3.1 Riesgo: exposición de datos de salud a personal no autorizado (compañeros, otros managers)
**Medida — masking en el servidor (`maskEntryForViewer`, `maskAlertForViewer`, omisión de `healthLeaveDays`)**: el estado real de baja médica/paternidad, su horario y notas se sustituyen por un estado genérico (`AUSENTE`) para cualquier viewer que no sea `ADMIN` ni el propio interesado. Aplicado en las 3 superficies de exposición: vista de calendario (`GET /:id`), export (CSV/XLSX) y resumen mensual. El campo `healthLeaveDays` del resumen mensual se **omite** (no se envía en `0`) para no filtrar ni siquiera la existencia de una baja mediante inferencia del valor.

**Verificado en despliegue** (no solo por revisión de código): smoke test con un manager real no-ADMIN confirmó que la entry llega enmascarada, la alerta `BAJA_CONFLICT` no revela el `userId`, y el resumen mensual no incluye el campo — ver `docs/PLAN_STATUS_v3.5.0.md` §T8.

### 3.2 Riesgo: imposibilidad de ejercer el derecho al olvido (Art. 17) por integridad referencial
**Medida — FKs `ON DELETE CASCADE`** de `ScheduleEntry.userId` y `DepartmentManager.userId` hacia `User`: el endpoint de erasure existente (`DELETE /api/admin/users/:id`) puede seguir haciendo hard-delete del usuario sin fallar por restricción de clave foránea, eliminando en cascada todo el historial de horarios de la persona borrada.

### 3.3 Riesgo: acceso de escritura desproporcionado (managers con permisos de ADMIN global)
**Medida — autorización row-level** (`DepartmentManager` + `requireDeptEditAccess`): un responsable de departamento solo puede editar/validar/publicar/clonar planificaciones de los departamentos que gestiona explícitamente, nunca de otros, y nunca accede a funciones ADMIN del resto del CMDB.

### 3.4 Riesgo: acumulación indefinida de historial de paradero/salud
**Medida propuesta (no automatizada en v3.5.0)**: retención de 18 meses para `StaffSchedule` en estado `PUBLISHED`, tras los cuales debería purgarse (cascada elimina `ScheduleEntry`/`ScheduleAlert` asociados). **Pendiente de implementación como cron/job** — documentado aquí como medida recomendada, no como control ya activo. Responsabilidad de la organización desplegante definir el plazo legal aplicable (puede variar según normativa laboral local) antes de activar la purga.

### 3.5 Riesgo: trazabilidad insuficiente de accesos/cambios
**Medida — AuditLog insert-only**: toda escritura (creación/edición de departamento, config, manager, asignación de usuario, creación/edición/validación/publicación/clonado de schedule) inserta un registro en `audit_logs` con `action`, `entity`, `entity_id`, `user_email` — igual que el resto del CMDB (ISO 27001 A.8.15). Las lecturas (incluidas las de datos de salud enmascarados) no generan audit log individual en v3.5.0; si la organización requiere trazabilidad de accesos a datos de salud incluso enmascarados, es una extensión futura a valorar.

### 3.6 Destinatarios de los datos
- **ADMIN**: acceso completo, incluidos datos de salud sin enmascarar (necesario para administración del sistema y gestión de RRHH si el rol se asigna a perfiles de RRHH).
- **Manager de departamento**: datos ordinarios de su departamento sin enmascarar; datos de salud SIEMPRE enmascarados salvo que sean su propio registro.
- **AUDITOR**: lectura de todo el CMDB con el mismo enmascaramiento que un manager (nunca ve datos de salud ajenos).
- **El propio interesado**: siempre ve su propio estado real, incluida su propia baja médica/paternidad.
- No hay transferencia a terceros ni a países fuera del EEE en este módulo (los datos permanecen en la base de datos PostgreSQL local del despliegue).

## 4. Conclusión

El tratamiento es **necesario y proporcionado** para la finalidad de organización del trabajo, siempre que:
1. La organización desplegante confirme la base jurídica aplicable para el tratamiento de datos de salud en su jurisdicción (§2.1).
2. Se implemente la política de retención propuesta (§3.4) antes de un uso prolongado en producción.
3. Se forme a los usuarios sobre no introducir información médica detallada en el campo `notes` (§1.4).

Con las medidas de minimización y masking descritas, el riesgo residual para los interesados se considera **bajo**. No se requiere consulta previa a la autoridad de control salvo que la organización desplegante identifique factores de riesgo adicionales específicos de su contexto (volumen de empleados, sector regulado, etc.).

---

## 5. Adenda — v3.5.9 (2026-07-25)

Rework del módulo con cambios funcionales relevantes para esta DPIA (ver `docs/STAFF_SCHEDULE.md` §13 para el detalle técnico completo). No amplía las categorías de datos tratadas (§1.4) ni introduce nuevas finalidades; se documenta como adenda porque toca dos de los controles descritos en §3.

### 5.1 Riesgo: correlación de la guardia (`onGuard`) con un día de baja médica/paternidad

En este rework, la guardia deja de ser uno de los estados de jornada y pasa a ser un campo independiente, `onGuard` (booleano), que puede coexistir con cualquier estado — incluidos `BAJA_MEDICA`/`BAJA_PATERNIDAD`. `onGuard` **no es en sí mismo un dato de salud** y no está sujeto a la base jurídica de §2.1.b. Sin embargo, si su valor real se sirviera sin cambios en un día en el que el estado subyacente está enmascarado, un viewer no autorizado podría inferir mediante correlación que ese día concreto corresponde a una baja (por ejemplo, si observa que el patrón de guardias de una persona se interrumpe justo esa semana, o si compara la vista enmascarada con conocimiento externo del calendario de guardias).

**Medida — extensión de `maskEntryForViewer()`**: la misma rama del código que sustituye el estado real por `AUSENTE` genérico (§3.1 de este documento) ahora también fuerza `onGuard: false` en la respuesta enmascarada, con independencia del valor real almacenado. Aplica en las mismas 3 superficies ya cubiertas por el masking existente (vista de calendario, export, resumen). No requiere una base jurídica nueva porque no se trata como dato de salud en sí — es una medida de minimización defensiva para evitar la correlación con un dato que sí lo es.

**Hallazgo relacionado, registrado como lección de revisión**: durante la revisión de código de este rework se detectó (y corrigió) que los agregados numéricos `guardDays` (resumen semanal y resumen mensual) no excluían las entries con estado de baja médica/paternidad del conteo, aunque la entry individual sí estuviera correctamente enmascarada — un viewer no autorizado podía en principio inferir "esta persona tiene una baja con guardia asociada" a partir de una discrepancia en el agregado, sin que ninguna entry individual revelara el estado real. Es un recordatorio de que **los campos derivados/agregados necesitan la misma disciplina de enmascaramiento que los campos en bruto de los que se calculan** — enmascarar solo la entry no basta si un agregado aguas abajo se calcula antes del masking o sin excluir los mismos registros. Recomendación para futuras extensiones del módulo: cualquier nuevo campo agregado o de conteo debe revisarse explícitamente contra esta misma clase de fuga antes de exponerse.

### 5.2 Nuevo rol `WORKER` — destinatario adicional (actualización de §3.6)

Se añade el rol de usuario `WORKER`, que se comporta como `VIEWER` en el resto de la aplicación pero obtiene acceso de lectura a este módulo. A efectos de esta DPIA, `WORKER` tiene **exactamente el mismo modelo de amenaza y el mismo tratamiento que `AUDITOR`** ya documentado en §3.6: lectura de todos los departamentos, con el mismo enmascaramiento de datos de salud (nunca ve `BAJA_MEDICA`/`BAJA_PATERNIDAD` reales salvo que sea su propio registro, ni el `onGuard` real de un día enmascarado — §5.1). No se trata de una categoría de destinatario nueva desde el punto de vista de riesgo, solo de un nombre de rol adicional con ese mismo alcance; se documenta aquí para que la lista de "quién puede ver estos datos" quede completa. §3.6 se actualiza en consecuencia: donde decía "AUDITOR: lectura de todo el CMDB con el mismo enmascaramiento que un manager", léase "AUDITOR y WORKER".

---
**Este documento debe revisarse** ante cualquier cambio que amplíe las categorías de datos tratadas, los destinatarios, o el periodo de retención.


---

## Adenda v3.5.10 — `users.display_name`

**Dato nuevo tratado:** nombre y apellidos del empleado, tal como constan en el `displayName` de Active Directory (p. ej. «Andrés Matías López»).

| Aspecto | Valoración |
|---|---|
| **Categoría** | Dato personal identificativo ordinario (art. 4.1 RGPD). **No** es categoría especial del art. 9 |
| **Finalidad** | Presentación legible en el calendario de horarios y en el panel de usuarios. Sustituye al `sAMAccountName`, que ya era un identificador personal pero menos legible |
| **Base legal** | La misma que el resto del módulo: art. 6.1.b (ejecución del contrato laboral) y 6.1.f (interés legítimo en la organización del trabajo) |
| **Minimización** | Solo se almacena el nombre para mostrar. No se incorporan otros atributos del directorio (departamento AD, teléfono, cargo) aunque estén disponibles en la misma consulta |
| **Origen** | Active Directory corporativo. No se solicita al interesado ni se introduce a mano |
| **Actualización** | Se refresca en cada login y en cada sincronización: el directorio es la fuente de verdad |
| **Conservación** | La de la fila de usuario. No tiene retención propia |
| **Logs** | **No se escribe en ningún log.** Los mensajes de log del módulo y de la sincronización usan el identificador técnico (UUID), nunca el nombre ni el email |
| **Derecho de supresión** | `DELETE /api/users/:id/erase` hace `DELETE` de la fila completa, no anonimización campo a campo, por lo que `display_name` desaparece con ella. No requiere tratamiento adicional |
| **Riesgo residual** | **Bajo.** El dato ya era accesible para los mismos usuarios en forma de `sAMAccountName`, que en esta organización deriva del nombre real. La legibilidad aumenta, la población de datos expuestos no |

**Conclusión:** el cambio no altera el nivel de riesgo de la DPIA original. No procede consulta previa a la autoridad de control.

## Adenda v3.5.10 — ampliación de la audiencia de lectura

`VIEWER` recupera el acceso de lectura al módulo, limitado a horarios **publicados**. Esto amplía la población que puede ver la planificación de sus compañeros.

El enmascaramiento de datos de salud (art. 9) **no se ve afectado**: nunca dependió de que `VIEWER` estuviera bloqueado del módulo, sino de si el visor es `ADMIN` o el propio interesado. Un `VIEWER` recién admitido recibe exactamente el mismo tratamiento que ya recibía un `AUDITOR`: los estados `BAJA_MEDICA` y `BAJA_PATERNIDAD` se le sirven como `AUSENTE`, sin horas ni notas, y con `onGuard` forzado a `false` para que la guardia no permita correlacionar.

Se añade una salvaguarda que antes no existía: los **borradores** dejan de ser visibles para `VIEWER` y `AUDITOR`. Antes, `AUDITOR` veía cualquier horario en cualquier estado; ahora solo los publicados. El cambio **reduce** la exposición para ese rol.

## Adenda v3.5.12 (2026-07-28) — impresión, buscador de trabajadores, dos estados nuevos

Ver `docs/STAFF_SCHEDULE.md` §17 para el detalle técnico. Esta versión introduce un **canal de salida de datos nuevo** (impresión/PDF) y un **endpoint de búsqueda** que no existían en versiones anteriores; no amplía las categorías de datos del §1.4 ni introduce datos de salud adicionales.

### A. Nuevo canal de salida: impresión a papel/PDF

**Naturaleza del tratamiento nuevo**: hasta esta versión, los únicos canales por los que los datos de este módulo salían del sistema controlado eran el export CSV/XLSX (§9 del cuerpo principal, ya auditado). La impresión (`window.print()`, sin intermediario servidor) es un canal equivalente en cuanto a riesgo — el mismo contenido ya visible en pantalla puede terminar en papel o en un PDF fuera del control del CMDB — pero antes no dejaba ningún rastro.

**Medida — auditoría del hecho de imprimir**: `POST /api/staff-schedule/audit/print` registra `action=PRINT_STAFF_SCHEDULE`, `entity`/`entity_id` del objetivo impreso y `user_email` de la sesión (nunca del cliente, verificado en vivo que un valor falsificado en el cuerpo se ignora) — mismo principio de trazabilidad ya aplicado a `EXPORT_STAFF_SCHEDULE` (ISO 27001 A.8.15). El servidor **no ve ni recibe** el contenido impreso (no hay renderizado server-side) — solo registra que la operación de impresión se disparó sobre un objetivo que el visor tenía derecho a ver (revalidado server-side, 404 si no).

**Decisión de diseño — el registro de auditoría no bloquea la impresión** (D7): si el ping de auditoría falla (red, servidor no disponible), la impresión procede igualmente. Es una decisión consciente: el dato ya está en pantalla en el momento de imprimir, así que negar la impresión por un fallo de logging no protege ningún dato adicional, solo degrada el servicio. El coste es que un fallo de red puntual puede dejar una impresión sin registrar — riesgo residual aceptado, coherente con el resto del módulo (p. ej. §3.5, las lecturas tampoco generan audit log individual).

**Riesgo no cubierto por este control, y fuera del alcance técnico del CMDB**: una vez impreso o guardado como PDF, el documento sale del control de acceso del sistema — quien lo imprime puede compartirlo, extraviarlo o almacenarlo sin las protecciones del CMDB (masking de salud incluido, aunque el masking ya se aplicó antes de llegar a la pantalla, así que un viewer no autorizado nunca puede imprimir una baja médica ajena sin enmascarar — el control de acceso de §3.1 sigue siendo la barrera real). Recomendación operativa para la organización desplegante: política de manejo de documentos impresos que contengan datos de personal, fuera del alcance de este DPIA técnico.

### B. Buscador de trabajadores — minimización de datos

`GET /api/staff-schedule/users?q=` devuelve **únicamente** `{id, username, displayName}` de personal activo con departamento asignado — explícitamente **sin** `email` (Art. 5.1.c, minimización): un selector de búsqueda no necesita el correo para cumplir su función. Comparar con `DepartmentMemberInfo` (usado en el panel de configuración ADMIN), que sí incluye `email` porque ese contexto lo requiere — la elección de campos por endpoint, no un tipo compartido, es deliberada.

Esta búsqueda no expone nada que un `VIEWER` no viera ya: los nombres de todo el personal ya son visibles en los horarios publicados de todos los departamentos (Adenda v3.5.10). Lo que sí queda controlado, exactamente igual que en el resto del módulo, es el **horario** que se puede consultar después de encontrar a la persona (`GET /user/:userId/entries`, mismo masking Art. 9 y misma resolución de visibilidad en el `WHERE` que el resto de endpoints de lectura — nunca 403 para no revelar la existencia de un borrador ajeno).

### C. Estados `FESTIVO` / `FESTIVO_LOCAL`

Dos estados de jornada nuevos (festivo nacional / festivo local). **Dato personal ordinario**, no categoría especial — misma naturaleza que `VACACIONES`, ya cubierta en §1.4. No se solicita información adicional (no hay subtipo, motivo ni texto libre asociado más allá del `notes` ya existente). No amplía el §1.4 ni requiere una base jurídica distinta de la ya documentada en §2.1 para datos ordinarios de horario/paradero.

### Conclusión de la adenda

El riesgo residual del módulo se mantiene **bajo**. La impresión introduce un canal de salida nuevo, pero mitigado con el mismo principio de auditoría ya validado para el export, y sin ampliar quién puede ver qué — el masking Art. 9 se aplica *antes* de que el dato llegue a la vista imprimible, no como un paso posterior que la impresión pudiera saltarse. No se requiere consulta previa a la autoridad de control.

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
**Este documento debe revisarse** ante cualquier cambio que amplíe las categorías de datos tratadas, los destinatarios, o el periodo de retención.

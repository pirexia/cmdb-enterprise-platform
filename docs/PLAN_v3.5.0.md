# PLAN v3.5.0 — Módulo Staff Schedule (gestión de horarios del personal)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Módulo **core** (no plugin) de planificación de horarios: calendario semanal por departamento (personas × días), estados de jornada, motor de validaciones V1–V7, cálculo de horas invierno/verano/intensivo, autorización por departamento y controles GDPR Art. 9 para estados de baja.

**Architecture:** Módulo core `backend/src/modules/staff-schedule/` siguiendo el patrón DCIM (router factory + middleware + queries + audit + service + validationEngine + export). 6 tablas nuevas + `User.departmentId` + tabla de autorización `DepartmentManager`. Frontend Next.js Client Components en `frontend/app/staff-schedule/`.

**Tech Stack:** Express 5 + Prisma 6 + PostgreSQL 16 (estados/severidades como **TEXT + allowlist Zod**, patrón NIS2 — sin enums PG), Next.js 16 App Router, Tailwind 4, exceljs (ya en repo), i18n propio ×6.

**Rama:** `feature/v3.5.0-staff-schedule` (desde `develop`). **NO merge a `main`.**

---

## Context

RRHH/IT necesita planificar (no fichar) la jornada semanal del personal por departamento, con jornada normal/verano, viernes intensivo, cuota de teletrabajo, reglas de presencialidad y validaciones automáticas. Los usuarios ya existen (`User`: AD/LDAP/local/SSO). Se añade un dominio nuevo con datos personales sensibles (paradero diario + estado de salud), lo que obliga a tratar cumplimiento GDPR desde el diseño.

## Hallazgos de análisis (grounding, 2026-07-09)

- **No existe `Department`.** Modelos org actuales: `Branch` (sitio físico + `SupportArea`), `CostCenter`, `Location`, `SupportArea`. Ninguno es unidad organizativa de personas → `Department` nuevo justificado, sin solape. `User` **no** tiene `departmentId`.
- **`req.user` = `{ id, username, email, role, mfa_enabled }`** (`index.ts:225`, `shared/types.ts`). Roles: ADMIN/AUDITOR/VIEWER.
- **Patrón módulo core = DCIM** (`backend/src/modules/dcim/`): `middleware.ts` (`requireDcimAccess` bloquea VIEWER, `requireAdmin`, `requireUuidParam`), router factory `createDcimRouter(prisma)`, montaje `app.use('/api/dcim', authenticateToken, requireDcimAccess, createDcimRouter(prisma))` (`index.ts:299`).
- **Erasure GDPR** (`DELETE /api/admin/users/:id`, `index.ts:1264`) hace `DELETE FROM users` en raw SQL. Con FK requerida `ScheduleEntry.userId` (default Prisma = `Restrict`) **la erasure fallaría**. → los FKs a `User` deben ser `onDelete: Cascade` y la erasure debe contemplar el nuevo PII.
- **Plugin Engine** admite permiso `db:schema` (DDL) pero gated 4-eyes y sandbox runtime — descartado por decisión del usuario (módulo core).

---

## Decisiones de diseño (Fase Fable) — 3 confirmadas por el usuario + derivadas

| # | Decisión | Justificación |
|---|----------|---------------|
| **D1** | **Módulo core** `backend/src/modules/staff-schedule/`, NO plugin | Confirmado por usuario. 6 tablas + FK en `User` core + motor de validación; el sandbox del engine no encaja. Patrón DCIM. |
| **D2** | **9 estados con controles GDPR Art. 9** para `BAJA_MEDICA`/`BAJA_PATERNIDAD` | Confirmado por usuario. Son datos de salud (categoría especial). Requiere: masking en lectura, DPIA, base jurídica, inclusión en erasure, retención. |
| **D3** | **Autorización por departamento** (row-level) vía tabla `DepartmentManager` | Confirmado por usuario. Un no-admin puede editar SOLO horarios de departamentos que gestiona. Evita escalada a ADMIN global. |
| **D4** | **Masking de salud en lectura** (`maskEntryForViewer`) | *Derivada de D2+D3+calendario de equipo.* Un calendario de equipo expondría la baja médica a colegas → violación Art. 9. El estado preciso (`BAJA_MEDICA`/`BAJA_PATERNIDAD`) solo lo ven **ADMIN** y **el propio interesado**; el resto (managers, AUDITOR) ve un genérico `AUSENTE` con flag `healthMasked:true`. Configurable a futuro si RRHH necesita que managers vean el detalle. |
| **D5** | **Estados/severidad/tipo como TEXT + allowlist Zod** (no enum PG) | Patrón NIS2 del repo (evita fricción de migración de enum, ver lección v3.4.4). Validación en el borde con `z.enum`. |
| **D6** | **FKs a `User` con `onDelete: Cascade`** (`ScheduleEntry.user`, `DepartmentManager.user`) + **extender erasure** para borrar `schedule_entries` y `department_managers` del usuario | La erasure hace hard-delete; sin cascade fallaría. Las entradas son PII del interesado (paradero+salud) → se borran con el derecho al olvido. |
| **D7** | **`SummerSchedule` = solo periodo global por año** (`year, startDate, endDate`); las **horas** de verano viven en `DepartmentScheduleConfig` (`summer*`) | El spec duplicaba horas en ambos. Fuente de verdad única: periodo global, horas por departamento. El motor detecta "semana de verano" si `weekStart ∈ [startDate,endDate]` del año. |
| **D8** | **Horas como `Float`**; comparaciones con tolerancia `EPS=0.01` | FP: comparar `weeklyNet >= 40` con epsilon para evitar 39.9999. Tiempos como `String "HH:MM"` validados por regex `^([01]\d|2[0-3]):[0-5]\d$`. |
| **D9** | **Cálculo de horas efectivas centralizado** en `validationEngine.computeNetHours(entry, config, isSummer)` | net = (endTime−startTime) − break. break = 0 si viernes/intensivo; si no, `winterBreakMinutes`/`summerBreakMinutes` según temporada. |
| **D10** | **`StaffSchedule` inmutable tras PUBLISHED** (solo ADMIN puede despublicar) | Congelar planificación publicada. Ediciones solo en `DRAFT`. |
| **D11** | **Audit + retención**: toda escritura → `AuditLog`; cron de purga de `staff_schedules` PUBLISHED > 18 meses (retención documentada en DPIA) | ISO 27001 A.8.15 + minimización GDPR. El cron se registra pero puede diferirse su activación. |
| **D12** | **VIEWER bloqueado del módulo** (como DCIM); AUDITOR solo lectura con masking; manager R/W su depto; ADMIN full | Coherencia con RBAC existente. |
| **D13** | **Seed de departamentos NO automático**; se crean vía UI/endpoint ADMIN. Los usuarios se asignan a departamento por endpoint ADMIN | El módulo no inventa datos org; el admin configura. |
| **D14** | **DPIA obligatoria** `docs/DPIA_STAFF_SCHEDULE.md` antes de merge | CLAUDE.md exige DPIA para nuevo procesamiento de datos personales; aquí además categoría especial. |

## Global Constraints

- Conventional Commits; ≥1 commit por tarea. Rama `feature/v3.5.0-staff-schedule`. **NO merge a `main`.**
- `npx tsc --noEmit` limpio en backend y frontend (ignorar pre-existentes `license`/`licenseUser`).
- NO `prisma migrate dev`; migración manual `migration.sql` + `prisma migrate deploy` en contenedor.
- Toda escritura → `AuditLog` (`action`, `entity`, `entity_id`, `user_email`). Errores API genéricos, sin stack traces.
- `$queryRaw`/`$executeRaw` solo tagged templates; LIKE escapado; nunca `$queryRawUnsafe`.
- i18n: toda cadena vía `t("key")` en los 6 locales (`es,en,de,pt,fr,it`).
- Estética canónica de la casa (`rounded-none`, `ring-1 ring-slate-200`, header sticky, botón primario `bg-[var(--accent)]`).
- **GDPR Art. 9**: el estado preciso de baja médica/paternidad NUNCA se serializa a un viewer no autorizado (masking en el service, no en el cliente).
- No PII en logs (usar userId, no email/nombre en mensajes de log del módulo).

---

## Modelo de datos (final — ajustado sobre el spec)

Añadir a `schema.prisma`. **TEXT+Zod** para status/severity/type (D5). `SummerSchedule` reducido (D7). FKs cascade (D6). Nueva `DepartmentManager` (D3).

```prisma
model Department {
  id             String   @id @default(uuid()) @db.Uuid
  name           String
  code           String   @unique
  serviceStart   String   // "09:00"
  serviceEnd     String   // "19:00"
  presenceStart  String   // "10:00"
  presenceEnd    String   // "14:00"
  minPresencePct Int      @default(50)
  users          User[]
  managers       DepartmentManager[]
  schedules      StaffSchedule[]
  config         DepartmentScheduleConfig?
  createdAt      DateTime @default(now()) @map("created_at")
  updatedAt      DateTime @updatedAt @map("updated_at")
  @@map("departments")
}

model DepartmentManager {           // D3 — autorización row-level
  id           String @id @default(uuid()) @db.Uuid
  departmentId String @db.Uuid @map("department_id")
  userId       String @db.Uuid @map("user_id")
  department   Department @relation(fields: [departmentId], references: [id], onDelete: Cascade)
  user         User       @relation(fields: [userId], references: [id], onDelete: Cascade)
  createdAt    DateTime @default(now()) @map("created_at")
  @@unique([departmentId, userId])
  @@index([userId])
  @@map("department_managers")
}

model DepartmentScheduleConfig {
  id                     String @id @default(uuid()) @db.Uuid
  departmentId           String @unique @db.Uuid @map("department_id")
  winterDailyNetHours    Float  @default(8.0)  @map("winter_daily_net_hours")
  winterMaxDailyNetHours Float  @default(9.0)  @map("winter_max_daily_net_hours")
  winterBreakMinutes     Int    @default(60)   @map("winter_break_minutes")
  winterFridayNetHours   Float  @default(6.0)  @map("winter_friday_net_hours")
  summerDailyNetHours    Float  @default(8.0)  @map("summer_daily_net_hours")
  summerMaxDailyNetHours Float  @default(9.0)  @map("summer_max_daily_net_hours")
  summerBreakMinutes     Int    @default(30)   @map("summer_break_minutes")
  summerFridayNetHours   Float  @default(6.0)  @map("summer_friday_net_hours")
  weeklyTargetNetHours   Float  @default(40.0) @map("weekly_target_net_hours")
  monthlyTeleworkCap     Int    @default(10)   @map("monthly_telework_cap")
  flexEntryStart         String @default("07:00") @map("flex_entry_start")
  flexEntryEnd           String @default("10:30") @map("flex_entry_end")
  flexExitStart          String @default("16:00") @map("flex_exit_start")
  flexExitEnd            String @default("19:00") @map("flex_exit_end")
  department             Department @relation(fields: [departmentId], references: [id], onDelete: Cascade)
  @@map("department_schedule_configs")
}

model SummerSchedule {              // D7 — solo periodo global
  id        String   @id @default(uuid()) @db.Uuid
  year      Int      @unique
  startDate DateTime @db.Date @map("start_date")
  endDate   DateTime @db.Date @map("end_date")
  createdAt DateTime @default(now()) @map("created_at")
  @@map("summer_schedules")
}

model StaffSchedule {
  id           String  @id @default(uuid()) @db.Uuid
  departmentId String  @db.Uuid @map("department_id")
  weekStart    DateTime @db.Date @map("week_start")   // lunes
  weekEnd      DateTime @db.Date @map("week_end")     // viernes/sábado
  status       String  @default("DRAFT")              // DRAFT | PUBLISHED (TEXT+Zod)
  year         Int
  isSummerWeek Boolean @default(false) @map("is_summer_week")
  createdBy    String  @map("created_by")
  createdAt    DateTime @default(now()) @map("created_at")
  updatedAt    DateTime @updatedAt @map("updated_at")
  department   Department @relation(fields: [departmentId], references: [id], onDelete: Cascade)
  entries      ScheduleEntry[]
  alerts       ScheduleAlert[]
  @@unique([departmentId, weekStart])
  @@index([departmentId])
  @@index([weekStart])
  @@map("staff_schedules")
}

model ScheduleEntry {
  id         String  @id @default(uuid()) @db.Uuid
  scheduleId String  @db.Uuid @map("schedule_id")
  userId     String  @db.Uuid @map("user_id")
  date       DateTime @db.Date
  status     String                                  // 9 estados (TEXT+Zod)
  startTime  String? @map("start_time")              // "09:00"
  endTime    String? @map("end_time")
  notes      String?
  createdAt  DateTime @default(now()) @map("created_at")
  updatedAt  DateTime @updatedAt @map("updated_at")
  schedule   StaffSchedule @relation(fields: [scheduleId], references: [id], onDelete: Cascade)
  user       User @relation(fields: [userId], references: [id], onDelete: Cascade)  // D6
  @@unique([scheduleId, userId, date])
  @@index([scheduleId])
  @@index([userId])
  @@index([date])
  @@map("schedule_entries")
}

model ScheduleAlert {
  id         String  @id @default(uuid()) @db.Uuid
  scheduleId String  @db.Uuid @map("schedule_id")
  type       String                                  // 6 tipos (TEXT+Zod)
  severity   String                                  // WARNING | ERROR
  message    String
  userId     String? @db.Uuid @map("user_id")
  date       DateTime? @db.Date
  resolved   Boolean @default(false)
  createdAt  DateTime @default(now()) @map("created_at")
  schedule   StaffSchedule @relation(fields: [scheduleId], references: [id], onDelete: Cascade)
  @@index([scheduleId])
  @@index([type])
  @@map("schedule_alerts")
}
```

`User` (extensión):
```prisma
  departmentId    String?          @db.Uuid @map("department_id")
  department      Department?      @relation(fields: [departmentId], references: [id], onDelete: SetNull)
  managedDepartments DepartmentManager[]
  scheduleEntries ScheduleEntry[]
```

**Allowlists (TEXT+Zod)** — `schemas.ts`:
- `SCHEDULE_STATUS = ['PRESENCIAL','TELETRABAJO','VACACIONES','BAJA_MEDICA','BAJA_PATERNIDAD','GUARDIA','INTENSIVO','VIAJE','AUSENTE']`
- `HEALTH_STATUSES = ['BAJA_MEDICA','BAJA_PATERNIDAD']` (subconjunto para masking D4)
- `ALERT_TYPE = ['TELEWORK_QUOTA','WEEKLY_HOURS','DAILY_HOURS','PRESENCE_PCT','FLEX_RANGE','GUARDIA_COVERAGE','BAJA_CONFLICT']`
- `ALERT_SEVERITY = ['WARNING','ERROR']`, `SCHEDULE_STATE = ['DRAFT','PUBLISHED']`

---

## Migraciones (manuales, D5 evita enums PG)

Directorio `backend/prisma/migrations/20260709120000_staff_schedule/migration.sql` — `CREATE TABLE IF NOT EXISTS` para las 6 tablas + `ALTER TABLE users ADD COLUMN IF NOT EXISTS department_id uuid` + FKs + índices + `@@unique`. Un solo archivo (todas las tablas del dominio se crean juntas; sin dependencia de enum → una transacción es segura). FKs `ON DELETE CASCADE` en `schedule_entries.user_id`, `department_managers.user_id/department_id`, y `ON DELETE SET NULL` en `users.department_id`.

---

## Endpoints REST (`backend/src/modules/staff-schedule/router.ts`)

Montaje: `app.use('/api/staff-schedule', authenticateToken, requireScheduleAccess, createStaffScheduleRouter(prisma))` (bloquea VIEWER).

Middleware específico (`middleware.ts`):
- `requireScheduleAccess` — bloquea VIEWER (lectura permitida a AUDITOR/manager/ADMIN).
- `requireDeptEditAccess(prisma)` — para escritura sobre un schedule/departamento: pasa si `role==='ADMIN'` o si existe `DepartmentManager(userId=req.user.id, departmentId=<target>)`. El `departmentId` objetivo se resuelve del body (crear) o del `:id` del schedule (editar) → helper `resolveTargetDeptId`.
- `requireAdmin` — config global (departamentos, verano, asignación de managers/usuarios).
- `requireUuidParam` (reutilizar patrón DCIM).

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| GET | `/departments` | access | Listar departamentos |
| POST | `/departments` | admin | Crear departamento (+ config por defecto) |
| PUT | `/departments/:id` | admin | Actualizar departamento |
| GET | `/departments/:id/config` | access | Config de horario |
| PUT | `/departments/:id/config` | admin | Actualizar config |
| POST | `/departments/:id/managers` | admin | Asignar manager (userId) |
| DELETE | `/departments/:id/managers/:userId` | admin | Quitar manager |
| PUT | `/users/:userId/department` | admin | Asignar usuario a departamento |
| GET | `/summer?year=` | access | Periodo verano del año |
| POST | `/summer` | admin | Crear/actualizar periodo verano (upsert por year) |
| GET | `/` | access | Listar schedules por `?departmentId&weekStart` |
| GET | `/:id` | access | Detalle: entries (**masked** D4) + alerts + resumen por persona |
| POST | `/` | deptEdit | Crear schedule semanal (auto-crea entries base de los usuarios del depto) |
| PUT | `/:id` | deptEdit | Actualizar entries (solo si DRAFT, D10) |
| POST | `/:id/validate` | deptEdit | Ejecuta V1–V7, regenera `ScheduleAlert` |
| POST | `/:id/publish` | deptEdit | DRAFT→PUBLISHED (rechaza si hay alertas ERROR sin resolver) |
| POST | `/:id/unpublish` | admin | PUBLISHED→DRAFT (solo ADMIN, D10) |
| POST | `/:id/clone` | deptEdit | Clona entries a la semana siguiente (nuevo DRAFT) |
| GET | `/:id/export` | access | CSV/XLSX (**masked** salvo ADMIN) |
| GET | `/user/:userId/monthly?year&month` | access* | Resumen mensual (teletrabajo/horas/viaje). *AUDITOR/manager ven masked; el propio usuario y ADMIN sin mask |

**Respuesta de `/:id` (shape):**
```ts
{
  schedule: { id, departmentId, weekStart, weekEnd, status, year, isSummerWeek },
  days: string[],                    // fechas ISO lunes..viernes(/sáb)
  rows: Array<{
    userId, username,
    entries: Record<isoDate, {       // status YA enmascarado según viewer (D4)
      status, startTime, endTime, notes, healthMasked?: boolean
    }>,
    summary: { weeklyNetHours, teleworkDaysMonth, travelDays, guardDays }
  }>,
  alerts: Array<{ id, type, severity, message, userId?, date?, resolved }>,
}
```

---

## Motor de validaciones (`validationEngine.ts`) — pseudocódigo

```
computeNetHours(entry, cfg, isSummer):
  if entry.status in [VACACIONES,BAJA_*,AUSENTE,VIAJE]: return 0   // no computan jornada
  if not entry.startTime or not entry.endTime: return 0
  gross = minutesBetween(startTime,endTime) / 60
  isFriday = weekday(entry.date)===5
  if isFriday or entry.status===INTENSIVO: brk = 0
  else brk = (isSummer ? cfg.summerBreakMinutes : cfg.winterBreakMinutes)/60
  return gross - brk

detectSummer(weekStart, summerSchedule[year]):
  return summer && weekStart>=summer.startDate && weekStart<=summer.endDate

validate(schedule, entries, cfg, summer) -> alerts[]:
  isSummer = detectSummer(schedule.weekStart, summer)
  maxDaily = isSummer ? cfg.summerMaxDailyNetHours : cfg.winterMaxDailyNetHours   // 9.0
  target   = cfg.weeklyTargetNetHours                                             // 40.0
  byUser = groupBy(entries, userId)

  // V3 (DAILY_HOURS, ERROR): lun-jue net > maxDaily
  for e in entries where weekday(e.date) in [1..4]:
     if computeNetHours(e,cfg,isSummer) > maxDaily + EPS:
        push ERROR DAILY_HOURS (userId=e.userId, date=e.date)

  for (userId, es) in byUser:
     weekly = sum(computeNetHours(e,cfg,isSummer) for e in es)
     hasIntensiveFriday = any(e.status===INTENSIVO and weekday(e.date)===5)
     // V2 (WEEKLY_HOURS, ERROR): viernes intensivo pero semana < target
     if hasIntensiveFriday and weekly < target - EPS:
        push ERROR WEEKLY_HOURS (userId)
     // V1 (TELEWORK_QUOTA, ERROR): teletrabajo del MES > cap  (requiere query cross-schedule del mes)
     teleMonth = countTeleworkThisMonth(userId, schedule.year, monthOf(schedule.weekStart))
     if teleMonth > cfg.monthlyTeleworkCap:
        push ERROR TELEWORK_QUOTA (userId)
     // V6 (GUARDIA_COVERAGE, ERROR): mismo día VIAJE/VACACIONES + GUARDIA
     for day: if statuses(userId,day) intersect {GUARDIA} and {VIAJE,VACACIONES}:
        push ERROR GUARDIA_COVERAGE (userId, date=day)
     // V7 (BAJA_CONFLICT, WARNING): BAJA_* y a la vez PRESENCIAL/TELETRABAJO el mismo día
     for day: if statuses(userId,day) intersect {BAJA_MEDICA,BAJA_PATERNIDAD} and {PRESENCIAL,TELETRABAJO}:
        push WARNING BAJA_CONFLICT (userId, date=day)
     // V5 (FLEX_RANGE, WARNING): entrada/salida fuera de rango flexible
     for e in es where e.startTime:
        if e.startTime < cfg.flexEntryStart or e.startTime > cfg.flexEntryEnd
           or e.endTime < cfg.flexExitStart or e.endTime > cfg.flexExitEnd:
           push WARNING FLEX_RANGE (userId, date=e.date)

  // V4 (PRESENCE_PCT, WARNING): por día, % PRESENCIAL en franja de presencialidad < minPresencePct
  deptUserCount = count(distinct userId in schedule)
  for day in weekdays:
     present = count(users with status PRESENCIAL and [startTime,endTime] cubre [presenceStart,presenceEnd])
     if deptUserCount>0 and (present/deptUserCount)*100 < cfg.minPresencePct:
        push WARNING PRESENCE_PCT (date=day)

  return alerts
```
`countTeleworkThisMonth` = query sobre `schedule_entries` join `staff_schedules` del mismo departamento+mes (no solo la semana actual). Publish (`/:id/publish`) rechaza con 409 si quedan alertas `severity==='ERROR' && !resolved`.

---

## GDPR / Art. 9 — masking, erasure, DPIA (crítico)

**Masking (D4)** — `service.maskEntryForViewer(entry, viewer)`:
```
if entry.status in HEALTH_STATUSES and viewer.role !== 'ADMIN' and viewer.id !== entry.userId:
   return { ...entry, status:'AUSENTE', startTime:null, endTime:null, notes:null, healthMasked:true }
return entry
```
Aplicado en `GET /:id`, `GET /:id/export`, `GET /user/:userId/monthly` **antes de serializar**. Nunca confiar en el cliente para ocultar. El export XLSX/CSV usa la misma función.

**Erasure (D6)** — extender `DELETE /api/admin/users/:id` (`index.ts:1264`): antes del `DELETE FROM users`, con Cascade los `schedule_entries` y `department_managers` se borran solos; añadir al log de erasure la nota de que se purgaron entradas de horario. (Alternativa sin tocar index.ts: el Cascade en DB ya garantiza integridad; **mínimo imprescindible = los FKs Cascade de D6**. Extender el mensaje del audit es deseable.)

**DPIA** — `docs/DPIA_STAFF_SCHEDULE.md`: finalidad, base jurídica (interés legítimo/organización del trabajo; salud = obligación laboral Art. 9.2.b), categorías de datos, minimización (masking), destinatarios (managers ven genérico), retención (18 meses, D11), medidas técnicas (RBAC, masking, audit, cascade-erasure), evaluación de riesgo.

---

## Frontend (`frontend/app/staff-schedule/`)

Página `page.tsx` (Client Component, patrón canónico header sticky). Componentes en `frontend/components/staff-schedule/`:
- `StaffScheduleCalendar.tsx` — grid: filas=personas, columnas=días. Celda coloreada por estado + horario.
- `ScheduleCell.tsx` — celda (color por estado desde un `STATUS_META` local; muestra `healthMasked` como "Ausente" neutro).
- `ScheduleEntryPopover.tsx` — editar estado + startTime/endTime + notes (solo si puede editar).
- `AlertPanel.tsx` — lateral, agrupa por severidad (ERROR rojo / WARNING ámbar), botón resolver.
- `WeekSelector.tsx`, `DepartmentFilter.tsx`.
- `ScheduleConfigPanel.tsx` + `SummerScheduleConfig.tsx` (ADMIN) — config depto/jornada/flexible/verano.
- `PersonSummary` (inline) — horas semanales, teletrabajo usado/mes, viajes.
Hooks: `useStaffSchedule.ts`, `useScheduleValidation.ts`, `useScheduleExport.ts`.
Gating de edición en cliente: el backend es la autoridad (deptEdit); el cliente oculta controles si `!canEdit` (deriva de un campo `canEdit` que devuelve `GET /:id` calculado por el server según manager/admin). Sidebar: nueva entrada de menú `staff-schedule` (icono calendario).

`STATUS_META` (color sugerido): PRESENCIAL azul, TELETRABAJO verde, VACACIONES naranja, BAJA_MEDICA rojo, BAJA_PATERNIDAD verde oscuro, GUARDIA amarillo, INTENSIVO lila, VIAJE cian, AUSENTE gris.

---

## i18n (×6) — namespace `staffSchedule.*`

Todas las claves del spec (título/subtítulo, weekSelector, filter, `status.*` ×9, `alert.*` + `alert.type.*` ×7 + `alert.severity.*`, `action.*`, `config.*`, `summary.*`, `entry.*`) **más** las derivadas: `staffSchedule.status.masked` ("Ausente"), `staffSchedule.alert.DAILY_HOURS`, `staffSchedule.canEdit.readonly`, `staffSchedule.publish.blockedByErrors`, `staffSchedule.manager.title`, `staffSchedule.gdpr.maskedNotice`. Lista completa consolidada en Task 5.

---

## Tareas

### Task 1 — Schema + migración + erasure cascade (Backend)
**Files:** `backend/prisma/schema.prisma`, `backend/prisma/migrations/20260709120000_staff_schedule/migration.sql`, `backend/src/index.ts` (erasure msg).
- [ ] 1.1 Añadir los 6 modelos + extensión `User` al schema.
- [ ] 1.2 Escribir `migration.sql` (CREATE TABLE IF NOT EXISTS ×6 + ALTER users + FKs Cascade/SetNull + índices + uniques). NO ejecutar (deploy en Task 8).
- [ ] 1.3 `prisma generate` se hará en build; verificar sintaxis con `npx prisma validate` en contenedor si posible (si no, en Task 8).
- [ ] 1.4 Extender el mensaje de audit de la erasure (opcional, no romper el flujo).
- [ ] 1.5 Commit `feat(staff-schedule): schema + migration (departments, schedules, entries, alerts, managers)`.

### Task 2 — Módulo backend: middleware + schemas + queries (Backend)
**Files:** `backend/src/modules/staff-schedule/{schemas.ts,middleware.ts,queries.ts,audit.ts}`.
- [ ] Allowlists + Zod (`DepartmentSchema`, `DeptConfigSchema`, `SummerSchema`, `ScheduleCreateSchema`, `EntriesUpdateSchema` con `z.enum(SCHEDULE_STATUS)` y regex de hora). `middleware.ts` (`requireScheduleAccess`, `requireDeptEditAccess`, `resolveTargetDeptId`, `requireUuidParam`). `queries.ts` (helpers Prisma: cargar schedule con entries+users del depto, `countTeleworkThisMonth`). `audit.ts` (insert `AuditLog`).
- [ ] Commit `feat(staff-schedule): module foundation (schemas, middleware, queries, audit)`.

### Task 3 — Motor de validaciones + service + masking (Backend)
**Files:** `backend/src/modules/staff-schedule/{validationEngine.ts,service.ts}`.
- [ ] `validationEngine.ts` (`computeNetHours`, `detectSummer`, `validate` → V1–V7 según pseudocódigo). `service.ts` (CRUD, publish/unpublish/clone, `maskEntryForViewer`, cálculo de `canEdit` y `summary`).
- [ ] Tests jest del engine (casos: 40h con viernes intensivo OK; <40h ERROR; >9h diaria ERROR; teletrabajo 11/mes ERROR; presencialidad <50% WARNING; masking oculta BAJA_MEDICA a no-admin).
- [ ] Commit `feat(staff-schedule): validation engine V1-V7 + service + Art.9 masking`.

### Task 4 — Router + montaje + export (Backend)
**Files:** `backend/src/modules/staff-schedule/{router.ts,export.ts}`, `backend/src/index.ts` (mount).
- [ ] Todos los endpoints de la tabla; `export.ts` (CSV/XLSX con exceljs, masked). Montar en `index.ts`. `tsc --noEmit` limpio.
- [ ] Commit `feat(staff-schedule): REST router, export, mount`.

### Task 5 — i18n ×6 (Docs/Frontend)
**Files:** `frontend/locales/{es,en,de,pt,fr,it}.json`.
- [ ] Bloque `staffSchedule.*` completo (spec + derivadas) en los 6. Validar JSON + conteo de paridad.
- [ ] Commit `feat(i18n): staffSchedule keys ×6`.

### Task 6 — Frontend calendario (Frontend)
**Files:** `frontend/app/staff-schedule/page.tsx`, `frontend/components/staff-schedule/*`, hooks, `Sidebar` entry.
- [ ] Calendario + celda + popover + week selector + department filter + person summary + alert panel. Gating por `canEdit`. Estética canónica.
- [ ] Commit `feat(staff-schedule): weekly calendar UI + alerts panel`.

### Task 7 — Frontend config admin (Frontend)
**Files:** `frontend/components/staff-schedule/{ScheduleConfigPanel,SummerScheduleConfig}.tsx`.
- [ ] Config departamentos/jornada/flexible/verano + asignación de managers y usuarios a departamento (ADMIN). 
- [ ] Commit `feat(staff-schedule): admin config panels (department, hours, summer, managers)`.

### Task 8 — Despliegue + verificación (inline)
- [ ] Rebuild `--no-cache` backend+frontend (podman-compose); recreate backend→frontend→nginx; `prisma migrate deploy` (verificar 6 tablas + columna `users.department_id`).
- [ ] Smoke (admin temporal MFA, procedimiento CLAUDE.md, borrar al acabar): crear depto+config → asignar usuarios+manager → crear schedule → editar entries → validate (comprobar V1–V7) → intentar publish con ERROR (409) → resolver → publish → export → **verificar masking** (login como manager NO-admin: BAJA_MEDICA aparece como AUSENTE) → clone. Limpiar datos.
- [ ] `tsc` limpio, `/api/health` OK, `/staff-schedule` 200.

### Task 9 — Docs + DPIA + versión
**Files:** `docs/STAFF_SCHEDULE.md`, `docs/DPIA_STAFF_SCHEDULE.md`, `docs/ARCHITECTURE.md(.en)`, `docs/USER_MANUAL.md(.en)`, `CLAUDE.md`, `frontend/package.json`→`3.5.0`, `docs/PLAN_STATUS_v3.5.0.md`, `docs/EXECUTION_LOG.md`.
- [ ] Commits `docs: v3.5.0 staff-schedule (technical, DPIA, architecture, user manual)` + `chore(release): bump frontend a 3.5.0`.

### Task 10 — Merge
- [ ] Merge no-ff `feature/v3.5.0-staff-schedule` → `develop`. **NO a main.**

---

## Multiagente sugerido (Fase Sonnet)
Serializar T1 (schema es raíz de todo). Luego paralelizable: **Agente Backend** (T2→T3→T4, secuencial entre sí), **Agente i18n** (T5, independiente), **Agente Frontend** (T6→T7, depende de T4 para shapes pero puede arrancar con los tipos del plan). **Agente Docs** (T9). ⚠️ **Lección v3.4.4**: no paralelizar `git commit` de subagentes en el mismo checkout (índice compartido mezcla commits) → serializar el paso de commit o usar worktrees por agente (`[[feedback_parallel_subagent_commits]]`).

## Self-review (cobertura spec)
9 estados ✅(D2) · jornada invierno/verano/intensivo ✅(D9 computeNetHours) · compensación 40h ✅(V2) · horario servicio/presencialidad/flexible ✅(config+V4/V5) · teletrabajo 10/mes ✅(V1) · V1–V7 ✅(engine) +DAILY_HOURS derivada · endpoints ✅(+managers/users/dept) · calendario+config+alertas ✅(T6/T7) · export ✅(T4) · i18n ✅(T5) · **GDPR Art.9** ✅(D2/D4/D6/D14 — refuerzo sobre el spec) · RBAC por depto ✅(D3). Desviaciones vs spec: `SummerSchedule` sin horas (D7), estados como TEXT no enum (D5), masking de salud añadido (D4), `DepartmentManager` añadido (D3).
```
```

**FIN DEL DISEÑO (Fase Fable).** Plan escrito. Parada obligatoria para cambio manual a Sonnet.

# v3.5.2 — Fix estado de integraciones (Configuración → Integraciones y sistemas)

**Tipo:** patch / bugfix
**Rama:** `fix/integrations-status-display` → `develop` → PR `develop`→`main`
**Base:** v3.5.1

## Problema reportado

En **Configuración → Integraciones y sistemas**:

1. **LDAP aparecía "Deshabilitado"** pese a tener `USE_LDAP=true` (+ `LDAP_URL`, `LDAP_BASE_DN`, `LDAP_BIND_DN`, `LDAP_BIND_PASSWORD`) en el `.env` del backend, y con el backend autenticando por LDAP correctamente.
2. **Backend API aparecía "No responde".**
3. Revisión de **Información del sistema** (componentes / versiones / columna Estado).

## Causa raíz

1. **Backend API "No responde"** — el frontend consultaba `apiFetch("/health")`. nginx solo enruta `/api/*` al backend; `/health` cae en `location /` → frontend → **404 HTML** → `res.json()` lanza → `healthData=null` → badge "No responde". Verificado en producción: `GET /health` → 404, `GET /api/health` → `200 {"status":"ok"}`.
2. **LDAP "Deshabilitado"** — el badge evaluaba `process.env.NEXT_PUBLIC_USE_LDAP`, una variable (a) **distinta** de la `USE_LDAP` del backend y (b) **horneada en build-time** en el bundle de Next.js. Nunca estaba definida (`NEXT_PUBLIC_*` ausente en el runtime del frontend), por lo que el badge quedaba permanentemente en "Deshabilitado", desconectado del estado real del backend. El mismo defecto afectaba al badge SMTP (hardcodeado `ok={true}`).

## Solución

**Backend** (`backend/src/modules/integrations/router.ts`):
- Nuevo endpoint `GET /api/integrations/status` (solo `authenticateToken`, cualquier rol) que devuelve `{ ldap: process.env.USE_LDAP === 'true', smtp: smtpConfigured() }` — banderas booleanas no sensibles que reflejan la configuración **runtime** del servidor. A01 respetado (autenticado, solo lectura, sin PII).

**Frontend** (`frontend/app/settings/page.tsx`):
- `apiFetch("/health")` → `apiFetch("/api/health")` (chequeo `r.ok` antes de `.json()`).
- Nuevo estado `intStatus` alimentado por `/api/integrations/status` al abrir la pestaña; los badges **LDAP** y **SMTP** leen del backend en lugar de `NEXT_PUBLIC_USE_LDAP` / hardcode.

**Tests** (`integrations.test.ts`): +3 (401 sin token; AUDITOR ve `{ldap,smtp}` reflejando env; VIEWER con env vacío → `false/false`). Total módulo integraciones: **15/15 ✓**.

## Información del sistema — revisión (sin cambios de código)

Todos los componentes presentes y en versión correcta. `nginx` real `1.30.0` (badge `1.30` vía `NGINX_VERSION`); Express 5.2.1, Prisma 6.19.3, TypeScript 5.9.3, Zod 3.25.76, Helmet 8.2.0, jsonwebtoken 9.0.3, bcrypt 6.0.0, node-cron 4.2.1, nodemailer 8.0.9, multer 2.1.1; frontend hardcodeado Next 16.2.4 / React 19.2.3 / Tailwind 4.2.1 / ExcelJS 4.4.0 (coinciden con el lock). Node.js y PostgreSQL se autodetectan en runtime.

**Lógica de la columna Estado** (`SysStatusBadge`) — correcta y sin bug: `!hasEolData` → gris (sin datos EOL) → `isEol` → rojo (EOL) → `daysToEol ≤ 90` → ámbar (EOL próximo) → verde (activo). El orden garantiza que los valores ya vencidos (negativos) caen en `isEol` antes del umbral de 90 días.

## Verificación

- `npx tsc --noEmit`: 0 errores nuevos.
- `npx jest src/modules/integrations`: 15/15 ✓.
- Despliegue limpio en producción + comprobación end-to-end de los tres badges y la tabla de Información del sistema.

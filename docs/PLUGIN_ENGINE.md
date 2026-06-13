# Motor de Plugins (Plugin Engine) — Referencia técnica

> Versión: v2.8.0 · Audiencia: arquitectos, desarrolladores backend, equipo de plataforma
> Documentos relacionados: [PLUGIN_DEVELOPMENT_GUIDE.md](PLUGIN_DEVELOPMENT_GUIDE.md) (cómo construir un plugin) · [PLUGIN_SECURITY_CHECKLIST.md](PLUGIN_SECURITY_CHECKLIST.md) (gate de admisión 4-eyes)

Esta guía describe **lo que el motor hace realmente** según el código fuente en `backend/src/modules/plugins/`. No describe capacidades planificadas que no estén implementadas; las brechas conocidas se señalan explícitamente en la sección [Estado de implementación](#estado-de-implementación).

---

## 1. Visión general

El Motor de Plugins permite a usuarios con rol **ADMIN** extender el CMDB sin modificar el core ni romper sus garantías de seguridad y compliance. Un plugin es un bundle (`.zip` / `.tar.gz`) que puede aportar:

- **Hooks** del ciclo de vida del core (p. ej. ejecutar lógica tras crear un CI).
- **Migraciones DDL aisladas** que crean tablas propias con prefijo `plg_<id>_`.
- **Cron jobs** programados (node-cron).
- **UI por iframe** embebida en slots predefinidos del frontend.
- **Rutas REST** declaradas en el manifest (registro previsto; ver [Estado de implementación](#estado-de-implementación)).

El módulo vive en `backend/src/modules/plugins/` siguiendo la **convención de módulos** del repo (router, schemas, middleware, queries, audit, engine), montado desde `index.ts`. No añade código a `index.ts` salvo los puntos de emisión de hooks y la llamada de arranque.

### Arquitectura de alto nivel

```
                 ┌──────────────────────────────────────────────────────────┐
                 │                    backend (Express)                      │
  ADMIN ──────▶  │  /api/plugins/*  ──▶ router.ts (12 endpoints, requireAdmin)│
  (panel admin)  │                         │                                 │
                 │                         ▼                                 │
                 │   engine.ts:  PluginValidator · LifecycleManager          │
                 │               SandboxExecutor (vm.Script) · MigrationRunner│
                 │               HookRegistry · CronRegistry · RouteRegistry  │
                 │                         │                                 │
                 │   index.ts:  emitHook('pre*'/'post*')  ◀── puntos del core │
                 │                         │                                 │
                 └─────────────────────────┼─────────────────────────────────┘
                                           ▼
                          PostgreSQL: plugin_registry, plugin_hooks,
                          plugin_cron_jobs, plugin_routes,
                          plugin_data_backups, plugin_data_store,
                          + tablas plg_<id>_* creadas por el rol cmdb_plugin

  Browser ──▶ frontend: PluginProvider → PluginSlot → <iframe sandbox> ──▶ /api/plugins/:id/ui
```

### Flujo de admisión (upload → activate)

```mermaid
graph LR
  A[Upload .zip] -->|POST /upload| B[UPLOADED]
  B -->|POST /:id/validate<br/>checksum + Ed25519| C[VALIDATED]
  C -->|POST /:id/install<br/>migración + extracción| D[INSTALLED]
  D -->|POST /:id/activate<br/>4-eyes en prod| E[ACTIVE]
  E -->|POST /:id/deactivate| F[INACTIVE]
  F -->|POST /:id/activate| E
  D -->|POST /:id/uninstall| G[backup + down-migration + delete]
```

---

## 2. Modelo de confianza (D1)

> **El runtime `vm` NO es la frontera de seguridad.** La documentación de Node.js lo declara textualmente: *"The vm module is not a security mechanism."* Un plugin malicioso aprobado por error por un revisor humano **puede escapar** del sandbox. El sandbox es defensa en profundidad, no el control primario.

La **frontera de seguridad real es el gate de admisión**, una combinación de controles técnicos y humanos:

| Control | Dónde | Qué verifica |
|---------|-------|--------------|
| Firma **Ed25519** | `router.ts` → `crypto.verify` con `PLUGIN_SIGNING_PUBLIC_KEY` | Que el bundle proviene de un editor de confianza (firma sobre el checksum) |
| Checksum **SHA-256** | `PluginValidator.validateChecksum` | Que el `.zip` no se alteró tras la subida |
| **Magic bytes** + extensión | `PluginValidator.validateUploadedFile` | Que el archivo es realmente gzip (`1f8b`) o zip (`504b`); rechaza symlinks |
| **Allowlist DDL** + prefijo `plg_` | `PluginValidator.validateMigrationSql` | Que la migración no toca tablas core |
| **Checklist de revisión** humana | [PLUGIN_SECURITY_CHECKLIST.md](PLUGIN_SECURITY_CHECKLIST.md) | Que el código no exfiltra PII, no accede a `process`/`require`/`fs`, no hace `fetch` a hosts no declarados |
| Aprobación **4-eyes** en producción | `router.ts` → `/:id/activate` | Que un segundo ADMIN distinto al solicitante autoriza la activación |

### Endurecimiento del sandbox (defensa en profundidad)

`SandboxExecutor.runHandler` (en `engine.ts`) ejecuta el código del plugin con `vm.Script` sobre un **contexto congelado** (`Object.freeze` antes de `vm.createContext`). El contexto expone deliberadamente un subconjunto mínimo:

- **Disponible:** `prisma` (proxy), `logger`, `config` (congelado), `fetch` (restringido), `console`, `JSON`, `Math`, `Date`, `parseInt`, `parseFloat`, `isNaN`, `isFinite`, `encodeURIComponent`, `decodeURIComponent`, y los datos del evento en `__pluginData__`.
- **Bloqueado (forzado a `undefined`):** `process`, `require`, `module`, `exports`, `global`, `globalThis`, `__filename`, `__dirname`, `setTimeout`, `setInterval`, `clearTimeout`, `clearInterval`. No se inyecta `fs` ni `child_process`.
- **Timeout:** `SANDBOX_TIMEOUT_MS = 5000` ms. Al superarlo se lanza `PLUGIN_TIMEOUT`.
- **`fetch` restringido (anti-SSRF, OWASP A10):** el wrapper `safeFetch` valida el `origin` de cada URL contra `allowedHosts` del manifest; si no coincide, lanza `PLUGIN_SSRF`.

> El sandbox usa `vm`, no `worker_threads` ni un proceso aislado. Por eso el gate de admisión es imprescindible: es la única barrera fuerte.

---

## 3. Ciclo de vida del plugin

La máquina de estados la implementa `PluginLifecycleManager` en `engine.ts`. Las transiciones válidas son estrictas; cualquier otra se rechaza con 409.

```mermaid
stateDiagram-v2
  [*] --> UPLOADED
  UPLOADED --> VALIDATED
  UPLOADED --> ERROR
  VALIDATED --> INSTALLED
  VALIDATED --> ERROR
  INSTALLED --> ACTIVE
  INSTALLED --> UNINSTALLING
  INSTALLED --> ERROR
  ACTIVE --> INACTIVE
  ACTIVE --> ERROR
  INACTIVE --> ACTIVE
  INACTIVE --> UNINSTALLING
  ERROR --> UNINSTALLING
  ERROR --> VALIDATED
  UNINSTALLING --> [*]
```

| Estado | Significado | Transiciones permitidas |
|--------|-------------|-------------------------|
| `UPLOADED` | Bundle subido y registrado; manifest parseado | `VALIDATED`, `ERROR` |
| `VALIDATED` | Checksum (+ firma si presente) verificados; manifest re-validado | `INSTALLED`, `ERROR` |
| `INSTALLED` | Migración ejecutada; bundle extraído a `installed/` | `ACTIVE`, `UNINSTALLING`, `ERROR` |
| `ACTIVE` | Hooks/cron registrados; plugin en ejecución | `INACTIVE`, `ERROR` |
| `INACTIVE` | Desactivado; código presente pero sin registrar | `ACTIVE`, `UNINSTALLING` |
| `ERROR` | Fallo en validación, instalación o reactivación; `lastError` poblado | `UNINSTALLING`, `VALIDATED` |
| `UNINSTALLING` | Estado terminal durante el borrado | — |

> **Nota de implementación:** `/:id/activate` y `/:id/deactivate` actualizan el estado directamente (con sus propios chequeos de estado origen) en lugar de pasar por `canTransition`. El conjunto de transiciones de arriba es el contrato declarado por `PluginLifecycleManager.validTransitions`.

---

## 4. Modelos de datos

Seis modelos Prisma en `backend/prisma/schema.prisma` (todos con PK `uuid`, `@@map` snake_case, índices en FKs y `onDelete: Cascade` hacia `PluginRegistry`).

### `PluginRegistry` (`plugin_registry`)
Registro central y de gobierno de cada plugin.

| Campo | Tipo | Notas |
|-------|------|-------|
| `id` | uuid (PK) | Clave primaria interna |
| `pluginId` | string único | `id` del manifest (kebab-case) |
| `name`, `version`, `author`, `license` | string | Metadatos del manifest |
| `status` | string | Estado del ciclo de vida |
| `manifest` | Json | Manifest completo validado |
| `config` | Json (`{}`) | Configuración mutable (inyectada al sandbox) |
| `permissions` | string[] | Permisos declarados |
| `checksum` | string | SHA-256 del bundle |
| `installedAt`, `updatedAt` | DateTime | Timestamps |
| `lastError` | string? | Último error (si `ERROR`) |
| `approvedBy`, `approvedAt` | string?/DateTime? | Quién y cuándo aprobó la activación (4-eyes) |
| `dataRetention` | string (`HARD`) | Política de retención de datos del plugin |

### `PluginHook` (`plugin_hooks`)
Hooks registrados por el plugin.

| Campo | Tipo | Notas |
|-------|------|-------|
| `event` | string | Nombre del evento (p. ej. `postCreateCI`) |
| `priority` | int (50) | Orden de ejecución ascendente |
| `handlerCode` | string | Código fuente JS del handler |
| `isActive` | bool (true) | Si el hook está activo |

### `PluginCronJob` (`plugin_cron_jobs`)
Tareas programadas del plugin.

| Campo | Tipo | Notas |
|-------|------|-------|
| `name`, `schedule` | string | Nombre y expresión cron |
| `handlerCode` | string | Código del job |
| `isActive` | bool (true) | Si el job está activo |
| `lastRunAt`, `nextRunAt` | DateTime? | Última/próxima ejecución |

### `PluginRoute` (`plugin_routes`)
Rutas REST declaradas por el plugin (registro de metadatos).

| Campo | Tipo | Notas |
|-------|------|-------|
| `method`, `path` | string | Verbo y ruta (únicos por `pluginId`) |
| `handlerCode` | string | Código del handler |
| `isActive` | bool (true) | Si la ruta está activa |
| `requiresAuth` | bool (true) | Si requiere autenticación |
| `requiredRole` | string? | Rol mínimo requerido |

### `PluginDataBackup` (`plugin_data_backups`)
Backups JSON de los datos del plugin antes de desinstalar.

| Campo | Tipo | Notas |
|-------|------|-------|
| `backupPath` | string | Ruta del fichero JSON de backup |
| `sizeBytes` | int | Tamaño del backup |
| `reason` | string | Motivo (p. ej. `UNINSTALL`) |
| `createdAt` | DateTime | Timestamp |

### `PluginDataStore` (`plugin_data_store`)
Almacén JSONB ligero para plugins que no necesitan DDL propio. Clave única `(tableName, entityId, pluginId)`.

| Campo | Tipo | Notas |
|-------|------|-------|
| `tableName` | string | Nombre lógico de la "tabla" |
| `entityId` | uuid | Identificador de la entidad |
| `pluginId` | string | Plugin propietario |
| `data` | Json | Carga de datos |

---

## 5. Sistema de hooks

El core emite eventos en puntos clave mediante `emitHook(event, data, type)` (exportado por `engine.ts`). El `HookRegistry` mantiene, por evento, una lista de handlers ordenada por `priority` ascendente.

- **Pre-hooks** (`type: 'pre'`): se ejecutan **antes** de la operación. Si cualquiera devuelve `{ cancel: true, reason }`, el core aborta la operación y responde `409` con el `reason`. Errores del handler se registran pero **no** cancelan.
- **Post-hooks** (`type: 'post'`, por defecto): se ejecutan **después** con `Promise.allSettled` (fire-and-forget). Sus errores se registran y **nunca** se propagan al core.
- **Coste cero en reposo:** `emitHook` hace early-return si `hookRegistry.hasHandlers(event)` es falso. Un despliegue sin plugins activos no paga sobrecoste.

### Eventos emitidos por el core

Verificados en `backend/src/index.ts`:

| Evento | Tipo | Punto del core | Payload |
|--------|------|----------------|---------|
| `preCreateCI` | pre | `POST /api/cis` | `{ body, user }` |
| `postCreateCI` | post | `POST /api/cis` | `{ id, body, user }` |
| `preUpdateCI` | pre | `PATCH /api/cis/:id` | `{ id, body, user }` |
| `postUpdateCI` | post | `PATCH /api/cis/:id` | `{ id, body, user }` |
| `preDeleteCI` | pre | `DELETE /api/cis/:id` | `{ id, user }` |
| `postDeleteCI` | post | `DELETE /api/cis/:id` | `{ id, user }` |
| `preCreateContract` | pre | `POST /api/contracts` | `{ body, user }` |
| `postCreateContract` | post | `POST /api/contracts` | `{ id, body, user }` |
| `preCreateDocument` | pre | `POST /api/documents` | `{ body, user }` |
| `postCreateDocument` | post | `POST /api/documents` | `{ id, body, user }` |
| `preCreateLicense` | pre | `POST /api/licenses` | `{ body, user }` |
| `postCreateLicense` | post | `POST /api/licenses` | `{ id, body, user }` |
| `postLogin` | post | `POST /api/auth/login` | `{ userId, role, email }` |

> `postLogin` **no** se emite para tokens limitados (cuando el ADMIN aún debe completar el setup de MFA).

---

## 6. Endpoints REST

Todas las rutas se montan bajo `/api/plugins` y aplican `pluginRateLimiter` (100 req/min por IP+plugin) y `requireAdmin` (solo rol ADMIN). Las rutas con `:id` validan que sea UUID y cargan el plugin con `requirePluginExists`.

| # | Método | Path | Descripción |
|---|--------|------|-------------|
| 1 | `GET` | `/api/plugins` | Lista todos los plugins registrados (con manifest y permisos) |
| 2 | `GET` | `/api/plugins/marketplace` | Proxy al marketplace configurado (nunca acepta URL del cliente — A10) |
| 3 | `POST` | `/api/plugins/upload` | Sube un bundle; valida magic bytes, extrae y valida el manifest, calcula checksum, crea registro `UPLOADED` |
| 4 | `POST` | `/api/plugins/:id/validate` | Verifica checksum + firma Ed25519 (si presente) + re-valida manifest → `VALIDATED` |
| 5 | `POST` | `/api/plugins/:id/install` | Ejecuta `migration.sql` (si existe) y extrae el bundle a `installed/` → `INSTALLED` |
| 6 | `POST` | `/api/plugins/:id/activate` | Activa el plugin; en producción exige `approvalToken` 4-eyes → `ACTIVE` |
| 7 | `POST` | `/api/plugins/:id/deactivate` | Desactiva un plugin `ACTIVE` → `INACTIVE` |
| 8 | `POST` | `/api/plugins/:id/uninstall` | Backup JSON + down-migration + borrado de ficheros y registro |
| 9 | `GET` | `/api/plugins/:id/config` | Devuelve la configuración actual del plugin |
| 10 | `PATCH` | `/api/plugins/:id/config` | Fusiona claves nuevas en la configuración existente |
| 11 | `GET` | `/api/plugins/:id/logs` | Lee los `audit_logs` del plugin (`entity='PLUGIN'`); soporta `?limit` (máx 200) y `?since` |
| 12 | `POST` | `/api/plugins/:id/rollback` | Rollback de versión — **no implementado** (responde `501`) |

**Auditoría:** toda escritura inserta un registro en `audit_logs` con `entity='PLUGIN'` vía `pluginAudit()`. Acciones: `PLUGIN_UPLOADED`, `PLUGIN_VALIDATED`, `PLUGIN_VALIDATION_FAILED`, `PLUGIN_INSTALLED`, `PLUGIN_ACTIVATED`, `PLUGIN_DEACTIVATED`, `PLUGIN_UNINSTALLED`, `PLUGIN_CONFIG_UPDATED`, `PLUGIN_ERROR`.

### Aprobación 4-eyes (activación en producción)

Solo se exige cuando `NODE_ENV === 'production'` **y** `PLUGIN_REQUIRE_APPROVAL_PROD === 'true'`. El `approvalToken` es un JWT (firmado con el `JWT_SECRET` de la plataforma) que debe:

1. Verificar correctamente (no expirado, firma válida).
2. Pertenecer a un usuario con rol `ADMIN`.
3. Ser de un ADMIN **distinto** al solicitante (no coinciden `id` ni `email`). Si coinciden → `403` por violación 4-eyes.

---

## 7. Sistema de slots UI

El frontend embebe la UI de cada plugin activo en **slots** predefinidos mediante iframes aislados (decisión D3).

### Componentes
- **`PluginContext.tsx`** — `PluginProvider` (montado en `app/layout.tsx`) carga `GET /api/plugins`, filtra los `ACTIVE` y agrupa sus `manifest.uiSlots` en `slotsByName`. Expone `usePlugins()`.
- **`PluginSlot.tsx`** — `<PluginSlot slotName="..." context={...} />`. Renderiza un `PluginIframe` por cada plugin registrado en ese slot. Si no hay ninguno, renderiza `null` (coste cero).
- **`PluginIframe.tsx`** — embebe `<iframe sandbox="allow-scripts allow-same-origin">` cuyo `src` es `/api/plugins/:id/ui?slot=<slot>`. Gestiona el puente `postMessage`.

### Los 7 slots

| Slot | Ubicación prevista |
|------|--------------------|
| `DashboardWidget` | Widget en el dashboard |
| `CIDetailTab` | Pestaña en el detalle de un CI |
| `ContractDetailTab` | Pestaña en el detalle de un contrato |
| `TopBarMenu` | Entrada en la barra superior |
| `SettingsPanel` | Panel en ajustes |
| `InventoryColumn` | Columna en el listado de inventario |
| `MapOverlay` | Overlay sobre el mapa de relaciones |

### Puente `postMessage`

Validado por origen (`event.origin === window.location.origin`) y por fuente (solo del iframe concreto).

- **Host → iframe** (al cargar): `cmdb:init` con `{ token: null, locale, theme: "light", context }`. El JWT vive en cookie HttpOnly y **no** se expone al iframe; las llamadas del plugin a la API reutilizan la cookie automáticamente.
- **Iframe → host:**
  - `cmdb:resize` `{ height }` — ajusta la altura del iframe.
  - `cmdb:navigate` `{ path }` — navegación interna (solo paths que empiezan por `/`).

---

## 8. Arranque y reactivación

`initializePluginEngine(app, prisma)` se invoca una vez al final de `index.ts`, tras montar middleware y rutas. Su cometido:

1. Monta el router de gestión en `/api/plugins`.
2. Lee los plugins en estado `ACTIVE` (`getActivePlugins`, incluye hooks/cron/routes). Si las tablas aún no existen (primer arranque antes de migrar), avisa y sale sin error.
3. Por cada plugin ACTIVE:
   - **Re-registra hooks** activos en el `HookRegistry`, envolviendo cada `handlerCode` en el `SandboxExecutor`.
   - **Re-registra cron jobs** activos con `node-cron`; cada ejecución corre en el sandbox y actualiza `lastRunAt`.
   - Marca sus rutas como montadas (`routeRegistry.mount`).
4. Si un plugin falla al reactivarse → se marca `ERROR` (con `lastError`) y se audita `PLUGIN_ERROR`, **sin bloquear el arranque** del resto.

Este diseño cumple el RTO de ISO 22301: un fallo de plugin no impide que la aplicación arranque.

---

## 9. Almacenamiento en disco

Bajo `PLUGIN_STORAGE_PATH` (volumen `cmdb-plugins`):

| Subdirectorio | Contenido |
|---------------|-----------|
| `staging/` | Bundles subidos (`<uuid>.zip`) pendientes de instalar |
| `installed/<db-uuid>/` | Contenido extraído del bundle ya instalado |
| `backups/` | Backups JSON pre-uninstall (`<db-uuid>_<timestamp>.json`) |

---

## 10. Aislamiento de migraciones (D2)

- Las migraciones (`migration.sql` en el bundle) las ejecuta `MigrationRunner` vía `execFile('psql', ...)` (nunca `exec` — sin inyección de shell), con la conexión `PLUGIN_DATABASE_URL` (rol `cmdb_plugin`). En desarrollo, si no está definida, cae a `DATABASE_URL`.
- `PluginValidator.validateMigrationSql` aplica una **allowlist DDL**: solo `CREATE TABLE`/`CREATE INDEX`/`CREATE UNIQUE INDEX`/`INSERT INTO plg_*`/comentarios. Rechaza `DROP`/`TRUNCATE`/`ALTER`/`DELETE` sobre tablas que no empiecen por `plg_`. Toda `CREATE TABLE` debe usar el prefijo `plg_<plugin-id>_`.
- **Down-migration:** si el bundle incluye `down.sql` se ejecuta; si no, el runner genera automáticamente `DROP TABLE` para todas las tablas `plg_<id>_*` (consultando `pg_tables`).
- **Backup previo:** antes de la down-migration, el uninstall vuelca a JSON todas las tablas `plg_*` del plugin y registra un `PluginDataBackup`.

El rol `cmdb_plugin` se crea con `scripts/create-plugin-db-role.sql` (ver SYSADMIN_MANUAL): `GRANT CREATE` sobre `public` para crear objetos nuevos, **sin** privilegios `SELECT/UPDATE/DELETE` sobre tablas core.

---

## 11. Estado de implementación

Diferencias conocidas entre el diseño completo y el código actual (v2.8.0). Documentadas para evitar suponer capacidades inexistentes:

- **Endpoint `GET /api/plugins/:id/ui` — no implementado en backend.** El `PluginIframe` del frontend apunta a esta ruta, pero `router.ts` no la define. Hasta que se añada, los iframes de slot fallarán al cargar (mostrarán el estado de error del componente).
- **Registro real de rutas de plugin (`PluginRoute`) — pendiente.** El `RouteRegistry` solo marca rutas como "montadas"; el montaje efectivo en Express no está implementado.
- **Proxy de Prisma para el sandbox — pendiente.** En la reactivación, los handlers reciben `{}` como `prismaProxy` (comentario `prismaProxy — wired in T3` en `index.ts`). El acceso `db:read`/`db:write` desde un hook aún no está cableado al cliente real.
- **`/api/plugins/:id/rollback` — `501 Not Implemented`** (placeholder explícito).
- **`PLUGIN_SIGNING_PUBLIC_KEY`** lo lee `router.ts` para verificar firmas, pero **no** aparece en `.env.example` ni en los `docker-compose`. Debe configurarse manualmente si se usan plugins firmados.
- **Respuesta de `GET /api/plugins`:** el backend devuelve `{ plugins: [...] }`, pero `frontend/app/plugins/admin/page.tsx` espera un array plano. El `PluginContext` sí maneja ambas formas; el panel admin podría no listar correctamente hasta alinear el shape.

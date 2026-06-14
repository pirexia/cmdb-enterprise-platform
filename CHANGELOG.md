# Changelog

All notable changes to CMDB Enterprise Platform are documented in this file.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)  
Versioning: [Semantic Versioning](https://semver.org/)

---

## [2.8.2] — 2026-06-14

### Added

- **DateType — catálogo de tipos de fecha** (`date_types`) — nuevo recurso maestro con enum de categorías (`HARDWARE`, `SOFTWARE`, `OS`, `GENERAL`), `sortOrder`, bandera `isSystem` y 16 tipos semilla (end-of-life, end-of-support, warranty-end, premier-support-end, etc.). CRUD completo en `/api/catalog/date-types` (solo ADMIN puede crear/modificar/eliminar; los tipos de sistema no se pueden borrar). UI en Admin → Datos Maestros → Tipos de Fechas.
- **Asociaciones de fechas por entidad** — tablas `ci_dates`, `operating_system_dates`, `base_software_dates`, `device_model_dates` (UNIQUE por entidad+tipo). API REST en `/api/catalog/{entity}/{id}/dates`. Disparadores PostgreSQL que sincronizan las columnas espejo `eol_date`/`eos_date` en `configuration_items` y `device_models` cuando se insertan/actualizan/eliminan filas con códigos canónicos (`end-of-life`/`end-of-support`, `hw-end-of-life`/`hw-end-of-support`).
- **`LifecycleDatesEditor`** — componente reutilizable (`frontend/components/LifecycleDatesEditor.tsx`) con badge de vencimiento (rojo < 0 días, ámbar < 90 días, verde resto), add/edit/delete inline y filtro por categoría de DateType. Integrado en las pestañas OS y Software Base de Admin → Datos Maestros.
- **Ciclo de vida en Modelos de Hardware** — filas de DeviceModel en Admin → Datos Maestros → Modelos de Hardware muestran el panel `LifecycleDatesEditor` al hacer clic en el icono de Calendario (categoría `HARDWARE`).
- **Agregador de fechas de ciclo de vida para CI** — `GET /api/catalog/cis/:ciId/lifecycle-dates` combina fechas propias del CI + fechas del OS asociado + fechas del DeviceModel (`ciModel`) + fechas de cada Software Base asociado. Campo `source` identifica la procedencia. Respuesta ordenada por `DateType.sortOrder`.
- **Sección "Fechas de Ciclo de Vida" en CIDetailModal** — tabla de solo lectura con columnas Tipo / Fuente / Fecha / Notas; badges rojo "Vencido" y ámbar "< 90 días". Disponible en los 6 idiomas (ES/EN/DE/PT/FR/IT).

### Fixed

- **Dropdown de selección masiva** — el menú desplegable de bulk-select se renderizaba recortado dentro de `overflow-x-auto`. Corregido con `ReactDOM.createPortal` + `getBoundingClientRect` para anclar el panel al `document.body`.

### Changed

- **CIDetailModal** — ampliado a `max-w-6xl` con layout de dos columnas responsive (datos principales a la izquierda, relaciones/contratos/documentos a la derecha).
- **Pestaña "Modelos" → "Modelos de Hardware"** — renombrada en los 6 idiomas de la UI.

---

## [2.8.1] — 2026-06-13

### Fixed (security)

- **Validador de migraciones DDL endurecido** — `PluginValidator.validateMigrationSql` ahora captura el identificador de destino de cada verbo peligroso y bloquea `TRUNCATE`, `DELETE FROM`, `ALTER TABLE`, `DROP INDEX` (y demás `DROP`) y `UPDATE` cuyo objetivo no empiece por `plg_`; `GRANT`/`REVOKE` quedan prohibidos por completo. Comentarios y literales se eliminan antes de validar para evitar smuggling.
- **Sin fallback a superusuario en migraciones** — `MigrationRunner` rechaza ejecutar `migration.sql`/`down.sql` si `PLUGIN_DATABASE_URL` (rol `cmdb_plugin`) no está configurada, en lugar de caer al `DATABASE_URL` del core.
- **Rate limiter IPv6** — `pluginRateLimiter` usa `ipKeyGenerator` para normalizar direcciones IPv6 a su subred /64, evitando el bypass del límite por rotación de IPv6.
- **Panel de administración** — corregido el shape de respuesta esperado por `frontend/app/plugins/admin/page.tsx` y añadido el visor de logs del plugin.

### Added

- **Runtime de ejecución de plugins** — el motor queda cableado de extremo a extremo:
  - `install` parsea el bundle a filas `PluginHook`/`PluginCronJob`/`PluginRoute` (`parseBundleArtifacts`); la instalación falla si un hook/cron/route declarado en el manifest no tiene su fichero de handler.
  - `activate` registra hooks, cron jobs y rutas en vivo (`pluginRuntime.registerPlugin`); `deactivate`/`uninstall` los desmontan.
  - **Proxy Prisma con scope** (`buildPrismaProxy`) enrutado por el rol `cmdb_plugin` (solo objetos `plg_*`): expone `$queryRaw`/`$queryRawUnsafe` (gate `db:read`) y `$executeRaw`/`$executeRawUnsafe` (gate `db:write`); el cliente Prisma del core nunca se expone.
  - **Rutas dinámicas** servidas en `/api/ext/:pluginId/*` (dispatcher contra el `RouteRegistry`, auth `requiresAuth`/`requiredRole` por ruta).
  - **Servido de UI** en `GET /api/plugins/:id/ui[/*]` (default `index.html`) a cualquier usuario autenticado, con CSP estricta y validación de `?slot` contra `manifest.uiSlots`.
- **Plugin de referencia `hello-world`** — `examples/plugins/hello-world/` con manifest, migración, hook `postCreateCI`, ruta `GET /ping`, cron `heartbeat` y UI de dashboard.
- **Suite de tests del runtime** — cobertura del proxy Prisma con scope, registro/desmontaje de hooks/cron/routes y dispatcher de rutas.

### Security (sandbox)

- **`eval` y `Function` bloqueados** en el contexto `vm` del sandbox (forzados a `undefined`), alineando el contexto de ejecución con la blocklist documentada.

### Docs

- **Documentos actualizados**: `docs/PLUGIN_DEVELOPMENT_GUIDE.md` (bundle solo `.zip`; secciones de rutas, cron y proxy Prisma; UI implementada) y `docs/PLUGIN_ENGINE.md` (estado de implementación: H-01/H-02/H-04 resueltos; endpoints `/api/ext/*` y `/api/plugins/:id/ui`).

---

## [2.8.0] — 2026-06-13

### Added

- **Motor de Plugins (Plugin Engine)** — nuevo módulo `backend/src/modules/plugins/` (patrón DCIM: engine, router, schemas, middleware, queries, audit) que permite a usuarios ADMIN instalar extensiones de terceros sin tocar el core. Referencia técnica en `docs/PLUGIN_ENGINE.md`.
- **Sandbox de ejecución** — `SandboxExecutor` basado en `vm.Script` con contexto congelado (sin `fs`/`process`/`require`/`eval`/`globalThis`), timeout de 5 s y `fetch` restringido a la allowlist del manifest (anti-SSRF).
- **12 endpoints REST** bajo `/api/plugins` (todos `requireAdmin` + rate-limit): list, marketplace, upload, validate, install, activate, deactivate, uninstall, config GET/PATCH, logs, rollback (placeholder `501`).
- **Panel de administración** `/plugins/admin` — subir, validar, instalar, activar, desactivar, desinstalar, configurar y ver logs de plugins; sección de marketplace. i18n en 6 idiomas.
- **Slots UI por iframe** — `PluginProvider`, `PluginSlot` y `PluginIframe` (`<iframe sandbox="allow-scripts allow-same-origin">`) con puente `postMessage` (`cmdb:init`/`cmdb:resize`/`cmdb:navigate`) en 7 slots: DashboardWidget, CIDetailTab, ContractDetailTab, TopBarMenu, SettingsPanel, InventoryColumn, MapOverlay.
- **Hooks del ciclo de vida del core** — `emitHook('pre*'/'post*')` instrumentado en 13 puntos de `index.ts` (CRUD de CIs, creación de contratos/documentos/licencias, login). Pre-hooks pueden cancelar la operación (409); post-hooks fire-and-forget; coste cero sin plugins activos.
- **Migraciones DDL aisladas** — `MigrationRunner` ejecuta `migration.sql` vía `execFile('psql')` con prefijo obligatorio `plg_<id>_`; down-migrations (auto-generadas si falta `down.sql`) + backup JSON antes de desinstalar.
- **6 modelos Prisma** — `plugin_registry`, `plugin_hooks`, `plugin_cron_jobs`, `plugin_routes`, `plugin_data_backups`, `plugin_data_store`.
- **Marketplace** — proxy a un repositorio configurable (`PLUGIN_MARKETPLACE_URL`); nunca acepta URL del cliente (A10).
- **Firma Ed25519** — verificación de firma sobre el checksum del bundle en `validate` (clave pública en `PLUGIN_SIGNING_PUBLIC_KEY`).
- **Reactivación al arranque** — `initializePluginEngine` reactiva los plugins `ACTIVE` (hooks + cron); un plugin que falle se marca `ERROR` sin bloquear el arranque (RTO ISO 22301).
- **Variables de entorno** `PLUGIN_STORAGE_PATH`, `PLUGIN_MAX_SIZE_MB`, `PLUGIN_DATABASE_URL`, `PLUGIN_REQUIRE_APPROVAL_PROD`, `PLUGIN_ENABLE_MARKETPLACE`, `PLUGIN_MARKETPLACE_URL`; volumen Docker `cmdb-plugins` en ambos compose.

### Security

- **Rol de base de datos restringido** `cmdb_plugin` (`scripts/create-plugin-db-role.sql`) — solo `GRANT CREATE` sobre `public` para crear objetos `plg_*`; sin acceso `SELECT/UPDATE/DELETE` a tablas core.
- **Gate de admisión 4-eyes** — en producción (`PLUGIN_REQUIRE_APPROVAL_PROD=true`) la activación exige `approvalToken` de un segundo ADMIN distinto al solicitante.
- **Validación de uploads** — magic bytes (gzip `1f8b` / zip `504b`), rechazo de symlinks, allowlist de extensiones, nombres UUID, límite de tamaño.
- **Allowlist DDL** — `PluginValidator.validateMigrationSql` rechaza `DROP`/`TRUNCATE`/`ALTER`/`DELETE` sobre tablas no-`plg_`.
- **Auditoría** — toda escritura inserta un registro `PLUGIN_*` en `audit_logs` (insert-only).
- **Modelo de confianza documentado** — `vm` no es la frontera de seguridad (Node.js); la frontera es el gate de admisión (firma + checksum + checklist + 4-eyes). Ver `docs/PLUGIN_SECURITY_CHECKLIST.md`.

### Docs

- **3 guías nuevas**: `docs/PLUGIN_ENGINE.md` (referencia técnica), `docs/PLUGIN_DEVELOPMENT_GUIDE.md` (guía de desarrollo), `docs/PLUGIN_SECURITY_CHECKLIST.md` (checklist de admisión 4-eyes).
- **Documentos actualizados**: ARCHITECTURE (ES/EN) §14, USER_MANUAL (ES/EN) §31, SYSADMIN_MANUAL (ES/EN) §22, README (ES/EN), este CHANGELOG.

---

## [2.7.0] — 2026-06-12

### Added

- **Maestro Sistema Operativo** — CRUD completo (`/api/catalog/operating-systems`) con auto-generación de código interno y campo EoL para alertas automáticas.
- **Maestro Software Base** — CRUD completo (`/api/catalog/base-software`) con tipos `MIDDLEWARE`, `AGENT`, `RUNTIME`, `DATABASE`, `OTHER`; asociación M:M a CIs.
- **Campos de infraestructura en CI** — 11 nuevos campos opcionales en `configuration_items`: `host_name`, `mgmt_ip`, `admin_ip`, `dns`, `cluster_name`, `cpu_model` (físico), `v_cpus` (virtual/cloud), `ram_gb`, `disk_gb`, `firmware_version`, `operating_system_id` (FK al maestro).
- **Alta masiva en cascada** — El importador Excel crea automáticamente registros de OS y BaseSoftware durante el commit del batch, con idempotencia (`ON CONFLICT DO NOTHING`).
- **12 nuevos tipos de relación** en 4 categorías semánticas: `CONTAINS`, `COMPOSED_OF`, `ATTACHED_TO` (estructural); `CONNECTS_TO`, `UPLINKS_TO` (red); `POWERS`, `PROTECTS` (eléctrica); `REPLICATES_TO`, `RUNS_ON`, `QUERIES`, `LICENSES`, `MANAGES` (lógica).
- **Mapa de Relaciones** — renombrado desde "Mapa de Dependencias"; leyenda de categorías con colores; validación de tipo de relación por tipo de CI en backend y UI.
- **AuditLog details** — campo `details` JSONB en `audit_logs` con `description` y `changes[]` estructurados; ningún campo PII.
- **Filtro por nombre de entidad** en `GET /api/audit-logs` (`?entityName=`) — búsqueda ILIKE insensible a mayúsculas con escapado OWASP A03.
- **Módulo `catalog/`** — nuevo módulo `backend/src/modules/catalog/` (patrón DCIM: router, schemas, queries, audit).
- **`scripts/install.sh` y `scripts/update.sh`** — pasan `GIT_COMMIT` como build-arg para baking del hash en `version.json`; nginx restart post-deploy.

### Fixed

- **Auto-code de Tipos de CI** — el campo `code` se genera automáticamente (slug uppercase) si el cliente no lo envía, eliminando errores de constraint NOT NULL.
- **Paginación configurable** — el selector de registros/página persiste en `localStorage`; rangos disponibles: 10, 25, 50, 100.
- **Multiselect "todos los filtrados"** — la acción de selección masiva ahora selecciona todos los CIs del filtro activo (no solo la página visible).

### Changed

- El Mapa de Dependencias pasa a llamarse **Mapa de Relaciones** en toda la UI y en los 6 idiomas.
- `RelationType` enum extendido de 5 a 17 valores (retrocompatible — `IF NOT EXISTS`).

### Security

- `escapeLike()` helper aplicado a todos los filtros ILIKE en `$queryRaw` (OWASP A03).
- `validateRelationCiTypes()` aplicado en backend antes de cualquier INSERT de relación.
- OWASP Top 10: 0 C / 0 H / 0 M — 2 Low informativos (L-01: mensajes de validación verbosos, L-02: duplicación RELATION_TYPE_MATRIX backend/frontend). Ver `docs/security/OWASP_v2.7.0.md`.
- Compliance ISO 27001 / GDPR / NIS2 / ISO 22301: todos los frameworks COMPLIANT. Ver `docs/security/COMPLIANCE_v2.7.0.md`.

---

## [2.6.1] — 2026-06-10

### Added

- DCIM rack placement full flow: assign-rack desde panel de edición de huella.
- Validación de solapamiento de U-slots; UX de placement en EditCIModal.
- Sección de ubicación en rack en CIDetailModal con pre-relleno de placement.
- `GET /api/cis/:id` — endpoint dedicado para detalle de un CI.
- Footprint kinds + panel de edición inline + protección 409 en delete.

### Fixed

- Documentación: inventario de skills + convención de módulos.
- `.gitignore` hardening.

---

## [2.6.0] — 2026-06-04

### Added

- **Módulo DCIM MVP 2D** — Buildings / Floors / Rooms / Aisles / Footprints.
- `RackElevation2D` SVG + `RoomPlan2D` ReactFlow + `PlaceCIModal`.
- Alertas de potencia (cron) + overlay heatmap.
- `requireUuidParam` blanket — cierra F-02 en 64 rutas existentes.
- OWASP 0 C/H/M — 4 Low (2 corregidos en rama).

---

## [2.5.3] y anteriores

Consulta el histórico de commits y PRs en el repositorio.

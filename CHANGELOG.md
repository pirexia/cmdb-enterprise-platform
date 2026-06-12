# Changelog

All notable changes to CMDB Enterprise Platform are documented in this file.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)  
Versioning: [Semantic Versioning](https://semver.org/)

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

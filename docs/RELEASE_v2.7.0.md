# Release Notes — v2.7.0

**Fecha:** 2026-06-12  
**Rama base:** `develop`  
**PRs incluidos:** #90 · #91 · #92 · #93 · #94 · #95 · #96 · #97 · #98 · #99  
**Commit HEAD:** `593b5ac`

---

## Resumen

v2.7.0 es la primera release mayor tras el lanzamiento del módulo DCIM (v2.6.0/v2.6.1). Agrupa 10 tareas de mejora que enriquecen el inventario con datos de infraestructura, añaden dos nuevos catálogos de maestros, mejoran la UX de listados, amplían el Mapa de Relaciones con 12 nuevos tipos semánticos y refuerzan la trazabilidad del registro de auditoría.

---

## Novedades principales

### 1. Maestros: Sistema Operativo y Software Base

- Nuevo catálogo `/api/catalog/operating-systems`: registra distribuciones con nombre, versión, fabricante y fecha de EoL.
- Nuevo catálogo `/api/catalog/base-software`: modela middleware y agentes del sistema (Tomcat, NGINX, agentes de monitorización, etc.) con tipo y fecha EoL.
- Cada software base se puede asociar a uno o más CIs (servidores físicos, virtuales o cloud) en una relación M:M.
- Ambos catálogos se administran desde **Administración → Maestros** (solo ADMIN).

### 2. Campos de infraestructura en CI

Los CIs de tipo servidor disponen ahora de 11 nuevos campos de infraestructura: hostname, IPs de gestión y administración, DNS, clúster, CPUs (modelo físico o vCPUs virtual/cloud mutuamente excluyentes), RAM, disco, versión de firmware y sistema operativo (FK al maestro).

### 3. Alta masiva en cascada

El importador Excel puede crear automáticamente registros de Sistema Operativo y Software Base durante la importación. Si el registro ya existe (mismo código), se reutiliza sin duplicar — operación idempotente dentro de la misma transacción que crea el CI.

### 4. Mapa de Relaciones ampliado

El antiguo "Mapa de Dependencias" pasa a llamarse **Mapa de Relaciones** y añade 12 nuevos tipos de relación en 4 categorías semánticas con código de colores:

| Categoría | Color | Nuevos tipos |
|-----------|-------|--------------|
| Estructural | Índigo | CONTAINS, COMPOSED_OF, ATTACHED_TO |
| Red | Teal | CONNECTS_TO, UPLINKS_TO |
| Eléctrica | Ámbar | POWERS, PROTECTS |
| Lógica | Naranja | REPLICATES_TO, RUNS_ON, QUERIES, LICENSES, MANAGES |

La UI filtra automáticamente los tipos disponibles según el tipo de CI en cada extremo de la relación. El backend valida la matriz independientemente del cliente.

### 5. Mejoras en el Registro de Eventos

- Cada evento incluye ahora un campo de descripción legible (ej. "CI SRV-PROD-01 creado").
- Nuevo filtro de búsqueda por nombre de entidad en la columna **Entidad** — búsqueda ILIKE insensible a mayúsculas, combinable con filtros de fecha.

### 6. Correcciones de UX

- **Auto-code de Tipos de CI**: el campo `code` ya no es obligatorio desde el cliente; se genera automáticamente.
- **Paginación configurable**: selector de 10/25/50/100 registros por página con persistencia en `localStorage`.
- **Multiselect "todos los filtrados"**: la selección masiva cubre todos los CIs del filtro activo.

### 7. Versión dinámica en footer

El commit hash del build aparece en el footer de la aplicación, facilitando la identificación exacta del despliegue en soporte y auditoría.

---

## Cambios de esquema

```sql
-- Nuevas tablas
CREATE TABLE operating_systems (...);
CREATE TABLE base_software (...);
CREATE TABLE _ci_base_software (...);

-- Nuevas columnas en configuration_items
ALTER TABLE configuration_items ADD COLUMN host_name text;
ALTER TABLE configuration_items ADD COLUMN mgmt_ip text;
-- ... (11 columnas en total)

-- Extensión enum
ALTER TYPE "RelationType" ADD VALUE IF NOT EXISTS 'CONTAINS';
-- ... (12 valores nuevos)

-- AuditLog
ALTER TABLE audit_logs ADD COLUMN details jsonb;
```

Todas las migraciones usan `IF NOT EXISTS` (seguras para reaplique). Aplicar con:

```bash
sg docker -c "docker exec cmdb-backend npx prisma migrate deploy"
# o en Podman:
podman exec cmdb-backend-prod npx prisma migrate deploy
```

---

## Procedimiento de actualización

```bash
# 1. Pull del código
git pull origin develop

# 2. Ejecutar el script de actualización
sudo ./scripts/update.sh
```

El script reconstruye imágenes con el commit hash actual, aplica migraciones y reinicia nginx.

---

## Seguridad

- **OWASP Top 10**: 0 Críticos / 0 Altos / 0 Medios — 2 Low informativos (L-01, L-02). Ver `docs/security/OWASP_v2.7.0.md`.
- **Compliance**: ISO 27001:2022, GDPR, NIS2, ISO 22301 — todos COMPLIANT. Ver `docs/security/COMPLIANCE_v2.7.0.md`.
- **Tests funcionales**: 10/10 PASS. Ver `docs/testing/FUNCTIONAL_TESTS_v2.7.0.md`.

---

## Compatibilidad

- No hay cambios de API incompatibles con versiones anteriores.
- El enum `RelationType` se extiende con `IF NOT EXISTS` — retrocompatible.
- El campo `details` en `audit_logs` es nullable — los registros existentes no se ven afectados.
- El campo `code` auto-generado en Tipos de CI no rompe clientes que ya lo enviaban.

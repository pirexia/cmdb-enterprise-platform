# Plan de desarrollo v2.8.0 — Plugin Engine

> Estado general: ⬜ **PENDIENTE** — en planificación  
> Rama base: `develop`  
> Target: `main` tag `v2.8.0`  
> Prerequisito: v2.7.0 completada y publicada (tag `v2.7.0`)  
> Fecha de redacción: 2026-06-12  

---

## Objetivo

v2.8.0 introduce un **Motor de Plugins** que permite a los operadores cargar extensiones de lógica de negocio sin modificar ni reconstruir el código base. Un plugin es un módulo JavaScript/TypeScript que se carga en tiempo de ejecución en el backend, expone hooks tipados y puede registrar endpoints REST propios bajo `/api/plugins/:pluginId/`.

El objetivo estratégico es desacoplar la integración de herramientas externas (ServiceNow, Jira, Dynatrace, Zabbix, Ansible AWX, etc.) del ciclo de releases del CMDB core, permitiendo que el equipo de operaciones desarrolle, publique y actualice conectores de forma independiente.

---

## Principios de diseño

| # | Principio |
|---|-----------|
| P1 | **Seguridad primero:** los plugins se ejecutan en un contexto sandbox (vm2 o Node.js `--experimental-vm-modules`), sin acceso directo al sistema de archivos ni a variables de entorno del host. |
| P2 | **Aislamiento:** cada plugin obtiene un cliente Prisma de solo lectura por defecto; el acceso de escritura se declara en el manifiesto y es aprobado por el ADMIN. |
| P3 | **Trazabilidad:** toda invocación de un plugin escribe una entrada en `AuditLog` con `entity: 'PLUGIN'`, `entity_id: pluginId`, y el resultado (éxito/error). |
| P4 | **Compatibilidad:** la API pública del motor de plugins sigue SemVer; los plugins declaran la versión mínima del motor que requieren. |
| P5 | **Reversibilidad:** un plugin puede desactivarse en caliente (sin reiniciar el backend) y sus endpoints desaparecen en menos de 1 s. |

---

## Resumen ejecutivo

v2.8.0 entrega la **infraestructura** del motor (P1–P5) y dos plugins de referencia que demuestran los patrones de integración más comunes:

1. **ServiceNow Connector** — sincronización bidireccional CI CMDB ↔ ServiceNow CMDB. Lee CIs del CMDB local y los upserta en ServiceNow vía REST API. Puede recibir webhooks de ServiceNow para actualizar campos en el CMDB local.
2. **Zabbix Monitor** — consulta la API de Zabbix para enriquecer la vista de CI con datos de disponibilidad (último ping, alertas activas). Solo lectura.

---

## Arquitectura del motor

### Componentes backend

```
backend/src/modules/plugins/
  engine/
    loader.ts        — Descarga/valida el bundle del plugin (hash SHA-256, tamaño máx. 5 MB)
    sandbox.ts       — Contexto vm2 con lista blanca de módulos permitidos (axios, zod, date-fns)
    registry.ts      — Map<pluginId, PluginInstance> con ciclo de vida (load/start/stop/unload)
    router.ts        — Monta/desmonta subrouters de plugins dinámicamente
    audit.ts         — pluginAudit() helper (insert-only)
    api-bridge.ts    — API pública inyectada al plugin: prismaReadOnly, auditWrite, httpFetch (allowlist)
  manifest.ts        — Zod schema del manifiesto (plugin.json)
  router.ts          — /api/plugins CRUD (ADMIN) + /api/plugins/:id/invoke
  schemas.ts         — Zod schemas para Create/Update/Invoke
  queries.ts         — Prisma CRUD sobre tabla plugins
```

### Tabla `plugins`

```sql
CREATE TABLE plugins (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text NOT NULL,
  version        text NOT NULL,
  bundle_hash    text NOT NULL,           -- SHA-256 del bundle JS
  bundle_url     text,                    -- URL interna (object storage) del bundle
  manifest       jsonb NOT NULL,          -- contenido validado de plugin.json
  enabled        boolean NOT NULL DEFAULT false,
  write_access   boolean NOT NULL DEFAULT false,  -- requiere aprobación ADMIN explícita
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  created_by     text NOT NULL            -- user_email del instalador
);
```

### Manifiesto (`plugin.json`)

```jsonc
{
  "id": "servicenow-connector",
  "name": "ServiceNow Connector",
  "version": "1.0.0",
  "engineMin": "2.8.0",           // versión mínima del motor
  "entrypoint": "index.js",
  "permissions": {
    "prismaRead": true,
    "prismaWrite": false,          // si true, requiere write_access=true en DB
    "httpAllowlist": [             // solo estos dominios pueden llamarse con api.fetch()
      "https://instance.service-now.com"
    ],
    "endpoints": [                 // endpoints que registra el plugin
      { "method": "GET",  "path": "/sync/status" },
      { "method": "POST", "path": "/sync/trigger" }
    ]
  },
  "hooks": ["onCICreated", "onCIUpdated", "onCIDeleted"]
}
```

### API pública del plugin (inyectada por `api-bridge.ts`)

```typescript
interface PluginAPI {
  // Prisma read-only (todos los modelos, solo SELECT)
  db: PrismaClient;

  // HTTP fetch con allowlist de dominios del manifiesto
  fetch(url: string, options?: RequestInit): Promise<Response>;

  // Escribe en AuditLog (sin PII, solo IDs)
  audit(action: string, details: object): Promise<void>;

  // Logger estructurado (sale a stdout del backend, prefijado con [plugin:id])
  log: { info(msg: string, meta?: object): void; warn(...): void; error(...): void };
}
```

### Ciclo de vida de un plugin

```
ADMIN sube bundle → loader valida hash + tamaño → sandbox.load() →
registry.register() → ADMIN activa (enabled=true) → router monta subrouter →
hooks registrados en EventBus → [uso] → ADMIN desactiva → router desmonta →
hooks eliminados → sandbox.unload()
```

---

## Hooks del sistema

El backend emite eventos tipados que los plugins pueden suscribir:

| Hook | Cuándo se emite | Payload |
|------|-----------------|---------|
| `onCICreated` | Después de `POST /api/cis` exitoso | `{ ciId, ciTypeCode, name }` |
| `onCIUpdated` | Después de `PATCH /api/cis/:id` exitoso | `{ ciId, changes: {field, old, new}[] }` |
| `onCIDeleted` | Después de `DELETE /api/cis/:id` exitoso | `{ ciId }` |
| `onRelationCreated` | Después de `POST /api/relations` exitoso | `{ relationId, sourceId, targetId, type }` |
| `onAuditLogWritten` | En cada INSERT en `audit_logs` | `{ action, entity, entityId }` |

Los hooks son **fire-and-forget con timeout de 5 s**. Un hook que lanza excepción o supera el timeout registra un error en `AuditLog` pero no propaga el error al handler original.

---

## Endpoints del motor

| Método | Ruta | Auth | Descripción |
|--------|------|------|-------------|
| GET | `/api/plugins` | ADMIN | Listar plugins instalados |
| POST | `/api/plugins` | ADMIN | Instalar un plugin (upload bundle) |
| PATCH | `/api/plugins/:id` | ADMIN | Activar/desactivar/aprobar write_access |
| DELETE | `/api/plugins/:id` | ADMIN | Desinstalar (detiene sandbox, elimina de DB) |
| POST | `/api/plugins/:id/invoke` | AUDITOR+ | Invocar un endpoint del plugin |
| GET | `/api/plugins/:id/logs` | ADMIN | Últimas 500 líneas de log del plugin |

---

## Tabla maestra de tareas

| ID | Tarea | Fase | Complejidad | Depende de | Estimación |
|----|-------|------|-------------|------------|------------|
| **P1** | Diseño detallado del sandbox (vm2 vs Worker threads) + PoC | 1 | Alta | — | 2 días |
| **P2** | Tabla `plugins` + migración + CRUD básico (`/api/plugins`) | 1 | Media | P1 | 1 día |
| **P3** | `loader.ts` — descarga, validación SHA-256, límite de tamaño | 2 | Media | P1 | 1 día |
| **P4** | `sandbox.ts` — contexto vm2, inyección PluginAPI, timeout | 2 | Alta | P1, P3 | 2 días |
| **P5** | `registry.ts` + `router.ts` — carga/descarga dinámica de subrouters | 2 | Alta | P4 | 2 días |
| **P6** | `api-bridge.ts` — Prisma read-only, fetch con allowlist, audit, log | 3 | Media | P4 | 1 día |
| **P7** | EventBus de hooks (`onCICreated` etc.) — integración con index.ts | 3 | Media | P5, P6 | 1 día |
| **P8** | Frontend: página `/admin/plugins` (lista, instalar, activar, logs) | 4 | Media | P2, P5 | 2 días |
| **P9** | Plugin de referencia: Zabbix Monitor (solo lectura) | 5 | Media | P6, P7 | 2 días |
| **P10** | Plugin de referencia: ServiceNow Connector (bidireccional) | 5 | Alta | P6, P7 | 3 días |
| **P11** | Tests (Jest): loader, sandbox timeout, hook fire-and-forget | 6 | Media | P4–P7 | 1 día |
| **P12** | Docs: OWASP + Compliance + User/Sysadmin manuals + CHANGELOG | 7 | Baja | P1–P11 | 1 día |

**Estimación total:** ~19 días-persona.

---

## Decisiones abiertas (requieren confirmación antes de ejecutar)

| # | Pregunta | Propuesta |
|---|----------|-----------|
| **Q1** | **Sandbox:** vm2 (EOL, mantenimiento comunitario) vs. Node.js `--experimental-vm-modules` vs. Worker threads | Worker threads + `MessageChannel` es la opción más segura a largo plazo (sin deprecaciones). Requiere serialización de payload. **Confirmar antes de P1.** |
| **Q2** | **Almacenamiento de bundles:** sistema de archivos vs. columna `bytea` en PostgreSQL | `bytea` en PostgreSQL simplifica backups y evita gestión de volúmenes extra. Límite 5 MB es razonable para un bundle minificado. |
| **Q3** | **Autenticación de plugins a servicios externos:** ¿las credenciales van en la DB o en variables de entorno? | Columna `secrets` (encrypted con `pgcrypto` + clave en env) en tabla `plugin_configs`. Nunca en el bundle. |
| **Q4** | **Scope del plugin ServiceNow para v2.8.0:** ¿sincronización completa o solo demostración de un campo? | Solo demostración de un campo (`short_description` ↔ `description` del CI) para mantener el scope. Sincronización completa → v2.9.0. |
| **Q5** | **Vista 3D de sala DCIM** (diferida desde v2.6.0 y v2.7.0) | Fuera de v2.8.0. Requiere R3F (Three.js) + análisis de rendimiento. → v2.9.0. |

---

## Riesgos

| Riesgo | Probabilidad | Impacto | Mitigación |
|--------|-------------|---------|------------|
| vm2/Worker no aisla suficientemente el código malicioso | Media | Alto | PoC de escape en P1; si no es aceptable → modo noop (plugins solo vía HTTP webhook externo, sin ejecución in-process) |
| Bundle sizes > 5 MB (bundlers incluyen node_modules) | Alta | Bajo | Documento de empaquetado para plugin devs: usar esbuild con `--external:axios` (axios está en allowlist del motor) |
| Incompatibilidad de Prisma read-only con transacciones del motor | Baja | Medio | Usar `PrismaClient` separado con `datasourceUrl` read-only (PostgreSQL hot-standby o usuario READ-ONLY) |
| Latencia de hooks > 5 s bloquea respuestas | Baja | Alto | Timeout enforced en `api-bridge.ts`; hooks async con `Promise.race` |

---

## Criterios de aceptación

1. Un plugin puede instalarse, activarse y desactivarse sin reiniciar el backend.
2. Un plugin con timeout > 5 s no bloquea el handler original.
3. Un plugin no puede leer variables de entorno del proceso host.
4. Un plugin no puede hacer llamadas HTTP a dominios fuera de su allowlist.
5. Toda invocación de plugin escribe en `AuditLog`.
6. `npx tsc --noEmit` pasa con 0 errores nuevos.
7. Contenedores rebuildan y arrancan limpios en < 5 min.
8. Tests unitarios (P11) pasan al 100%.
9. OWASP Top 10: 0 C / 0 H / 0 M.
10. Página `/admin/plugins` funciona en los 6 idiomas.

---

## Backlog adicional (candidatos v2.9.0)

- Vista 3D de sala DCIM (Three.js / React Three Fiber).
- Sincronización completa CI ↔ ServiceNow CMDB (scope completo).
- Generación automática de `frontend/lib/relationTypes.ts` desde el módulo backend (cierra L-02 de v2.7.0).
- Reemplazar mensajes de validación de RelationTypeMatrix por códigos de error + ID (cierra L-01 de v2.7.0).
- Plugin Ansible AWX: trigger de playbooks desde la ficha de CI.
- Plugin Dynatrace: enriquecimiento de CIs con métricas de APM.

# Plan consolidado v2.8.x — Plugin Engine (estado y backlog)

> Documento único de seguimiento del Plugin Engine: qué se entregó, qué queda pendiente y los issues abiertos.
> Última actualización: 2026-06-13.
> Planes relacionados: `docs/PLAN_v2.8.0.md` (plan original T1–T10), `docs/BACKLOG_v2.8.0.md` (hallazgos de la revisión), `docs/security/OWASP_v2.8.0.md` (auditoría).

---

## 1. Resumen de estado

| Fase | Alcance | Estado |
|------|---------|--------|
| **v2.8.0** | Motor de plugins (T1–T10): schema, core/sandbox, API REST, panel admin, slots iframe, hooks de core, infra, tests, docs | ✅ Mergeado a `develop` |
| **v2.8.1 — batch 1** | Hardening de seguridad (M-01/M-02/M-03) + panel admin (H-03) + suite de aislamiento del sandbox | ✅ Mergeado (PR #118) |
| **v2.8.1 — batch 2** | Runtime de ejecución (H-01/H-02/H-04) + plugin de referencia + Lows L-02/L-04/L-05/L-06/L-07 | ✅ Mergeado (PR #119) |
| **v2.8.1 — cierre** | Docs del contrato runtime, Lows restantes documentados, este plan, tag + release | ✅ En curso → release |

**Conclusión:** el Plugin Engine está **funcional end-to-end** (gobierno + runtime) y endurecido. Quedan mejoras Low diferidas (sección 4) sin impacto de seguridad ni en el flujo principal.

---

## 2. Entregado — gobierno (v2.8.0)

- Máquina de estados del plugin: `UPLOADED → VALIDATED → INSTALLED → ACTIVE → INACTIVE → UNINSTALLING (+ ERROR)`.
- 6 modelos Prisma (`PluginRegistry`, `PluginHook`, `PluginCronJob`, `PluginRoute`, `PluginDataBackup`, `PluginDataStore`) + migración.
- API REST de 12 endpoints (todos ADMIN): upload, validate, install, activate (4-eyes en prod), deactivate, uninstall, config GET/PATCH, logs, rollback (501), marketplace, list.
- Gate de admisión (D1): magic-bytes, rechazo de symlinks, checksum SHA-256, firma Ed25519 opcional, validación de manifest (Zod) y de migración (allowlist DDL).
- Aislamiento de datos (D2): prefijo `plg_<id>_`, rol DB `cmdb_plugin`, down-migrations + backup JSON pre-uninstall.
- Auditoría insert-only `PLUGIN_*` en toda escritura.
- Panel admin `/plugins/admin`, slots por iframe (`PluginContext`/`PluginSlot`/`PluginIframe`) + puente postMessage.
- Hooks de core instrumentados (emitHook, fail-open): login, CIs (create/update/delete), contracts, documents, licenses.
- Infra: volumen `cmdb-plugins`, env vars `PLUGIN_*`, `scripts/create-plugin-db-role.sql`.
- Tests Jest + 3 guías de documentación.

## 3. Entregado — hardening + runtime (v2.8.1)

### Batch 1 — seguridad (PR #118) — issues #111/#113/#114/#115
- **M-01:** `validateMigrationSql` rechaza TRUNCATE/DELETE/ALTER/DROP INDEX/UPDATE sobre objetos no-`plg_` y prohíbe GRANT/REVOKE; ignora comentarios y literales de cadena.
- **M-02:** `MigrationRunner` ya **no** cae a `DATABASE_URL` (superusuario); falla de forma controlada si falta `PLUGIN_DATABASE_URL`.
- **M-03:** `pluginRateLimiter` usa `ipKeyGenerator` (sin bypass IPv6).
- **H-03:** panel admin lee `{plugins:[…]}` y alinea el visor de logs con las filas de auditoría.
- **Sandbox:** `eval`/`Function` bloqueados en el contexto vm; suite de aislamiento real habilitada (process/require/fs/eval/Function, timeout, cancel).

### Batch 2 — runtime (PR #119) — issues #109/#110/#112
- **H-01:** `install` parsea el bundle a filas `PluginHook`/`PluginCronJob`/`PluginRoute` (`hooks/<kebab>.js`, `cron/<name>.js`, `routes/<method>_<slug>.js`; falla si falta el handler; guard de path-traversal). `activate` registra hooks/cron/routes en vivo (`PluginRuntime`); `deactivate`/`uninstall` los desmontan. Rutas dinámicas servidas por un dispatcher en `/api/ext/:pluginId/*` (sin montar/desmontar Express en caliente), con `requiresAuth`/`requiredRole` por ruta + rate-limit.
- **H-02:** proxy Prisma con scope, enlazado a `PLUGIN_DATABASE_URL` (rol `cmdb_plugin`), expone `$queryRaw`/`$executeRaw` (+Unsafe) gateado por `db:read`/`db:write`. El cliente core nunca se entrega a los plugins.
- **H-04:** `GET /api/plugins/:id/ui[/*]` sirve `installed/<id>/ui/*` a cualquier usuario autenticado (fuera de `requireAdmin`), CSP estricta + `frame-ancestors 'self'`, validación de `slot` contra `manifest.uiSlots`, guard de path-traversal.
- Lows cerrados: **L-02** (`PLUGIN_SIGNING_PUBLIC_KEY` en env/compose), **L-04** (dead code `pluginUploadMulter`/`validateUploadedFile` eliminado), **L-05** (visor de logs, vía H-03), **L-06** (audit `entity_id` UUID en reactivación), **L-07** (solo `.zip`).
- Plugin de referencia `examples/plugins/hello-world` + `runtime.test.ts`.

### Verificación v2.8.1
- TSC backend + frontend: 0 errores nuevos.
- Jest: **48 passing / 5 suites** (validator 17, sandbox 9, lifecycle 7, runtime 10, api 5) en la imagen builder.
- Rebuild + redeploy prod: health 200, engine init limpio, sin `ERR_ERL_KEY_GEN_IPV6`; `/api/ext/nope/ping`→404, `/api/plugins/:id/ui`→401 (sin auth)/404 (auth, inexistente), admin→403 (AUDITOR).
- E2E completo en vivo (upload→activate→crear CI→fila en `plg_hello_world_log`) **no ejecutable** de forma no interactiva: requiere sesión ADMIN con MFA obligatorio (CLAUDE.md). Cubierto por `runtime.test.ts`.

---

## 4. Pendiente (backlog diferido) — candidato a v2.8.2

| ID | Issue | Severidad | Descripción | Acción propuesta |
|----|-------|-----------|-------------|------------------|
| L-01 | #116 | Low | `POST /api/plugins/:id/rollback` devuelve `501` | Implementar rollback de versión (mantener bundles previos + re-instalar) o descopar en docs |
| L-03 | #116 | Low | `install` ejecuta la migración antes de extraer el bundle; si la extracción falla, la migración queda aplicada | Extraer primero y migrar desde `installDir`, o revertir la migración ante fallo |
| L-04* | #116 | Low | `lifecycleManager.canTransition` no se invoca desde `updateStatus` (resto del dead code ya eliminado) | Hacer cumplir las transiciones válidas en `updateStatus` |
| L-08 | #116 | Low | Los zips en `staging/` se localizan por escaneo O(n) del manifest; los huérfanos no se recolectan | Guardar la ruta de staging en `PluginRegistry`; GC de huérfanos |
| L-09 | #116 | Low | El `approvalToken` 4-eyes es un JWT de sesión genérico (sin scope/nonce, replay dentro del TTL) | Emitir un token de aprobación efímero acotado a `{pluginId, action}` |

\* L-04 quedó parcialmente cerrado (dead code eliminado; falta solo enforcement de `canTransition`).

### Mejoras futuras (no en backlog formal)
- Permiso `db:read` sobre tablas core (hoy el rol `cmdb_plugin` solo accede a `plg_*`; leer core requeriría GRANT selectivo y una decisión de exposición de datos).
- Rutas dinámicas con parámetros de path (hoy el match es exacto método+path).
- Requerir firma Ed25519 obligatoria en producción (hoy `manifest.signature` es opcional).

---

## 5. Issues GitHub

| Issue | Estado |
|-------|--------|
| #109 H-01, #110 H-02, #112 H-04 | ✅ Cerrado (PR #119) |
| #111 H-03, #113 M-01, #114 M-02, #115 M-03 | ✅ Cerrado (PR #118) |
| **#116** Low batch | 🟡 Abierto — reducido a L-01, L-03, L-04 (canTransition), L-08, L-09 |
| #87 (E2E Docker socket, ajeno al plugin engine) | 🟡 Abierto (preexistente) |

---

## 6. Release

- Rama: `develop` contiene v2.8.0 + v2.8.1 completos.
- Acción: merge `develop → main`, tag **`v2.8.1`**, GitHub release con las notas de 2.8.0 (feature) + 2.8.1 (runtime + hardening).
- v2.8.0 fue la fase de desarrollo de la feature; **v2.8.1 es la primera release del Plugin Engine lista para producción** (runtime cableado + endurecido). No se taguea v2.8.0 por separado (estado intermedio).
- Requisito operativo de despliegue: ejecutar `scripts/create-plugin-db-role.sql` y definir `PLUGIN_DATABASE_URL` (rol `cmdb_plugin`) antes de instalar plugins con migración/acceso a BD.

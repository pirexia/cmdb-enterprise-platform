# Plan v3.2.0 — `.env` como única fuente de verdad + aprovisionamiento n8n auto + instalador de producto

> **Para ejecutores agénticos:** SUB-SKILL REQUERIDA — usar `superpowers:subagent-driven-development` (recomendado) o `superpowers:executing-plans` para implementar tarea a tarea. Los pasos usan checkbox (`- [ ]`).

**Goal:** Que `.env` sea la única fuente de verdad de la configuración (SMTP, LDAP, token M2M) y que la propia aplicación aprovisione las credenciales y workflows de n8n automáticamente al arrancar y bajo demanda (botón en Settings), de modo que el producto se instale y opere en cualquier empresa sin intervención manual de la IA.

**Architecture:** Un módulo de aprovisionamiento en el backend (`modules/n8n-provisioning/`) lee los secretos del entorno, renderiza credenciales y workflows desde plantillas versionadas, y los aplica a n8n vía su **API REST pública** (`/api/v1/`) usando `N8N_API_KEY`. Se dispara (a) automáticamente al arrancar el backend (idempotente, con reintentos hasta que n8n esté sano) y (b) bajo demanda desde un botón "Resincronizar" en Settings. Los scripts `install.sh`/`update.sh` generan los secretos que faltan y hacen el bootstrap único del propietario + API key de n8n.

**Tech Stack:** Node 22 / Express 5 / TypeScript 5 (backend), Next.js 16 / React 19 (frontend), n8n 1.123.27 (Queue Mode) + Redis 7, PostgreSQL 16, Bash (install/update), Podman Compose. Tests: jest + supertest.

## Global Constraints

- **Sin secretos en el repo.** Todo secreto vive en `.env` (o se genera en install/update con `openssl rand`); nunca hardcodear. Las plantillas de workflow/credencial usan placeholders sustituidos en runtime desde `process.env`.
- **El backend NO accede al socket de contenedores** (A05 / docker-security). La integración con n8n es exclusivamente vía su API REST por la red interna. `podman exec` solo lo usan los scripts del host.
- **Idempotencia obligatoria:** reaplicar el aprovisionamiento debe *actualizar* credenciales/workflows existentes (match por `name` estable), nunca duplicar (evita el bug "Alertas CMDB duplicado").
- **i18n ×6** en toda cadena nueva de UI: `es/en/de/fr/it/pt` (`frontend/locales/*.json`), vía `t("clave")`.
- **AuditLog** en cada resync (acción `N8N_RESYNC`, entidad `N8nProvisioning`, `user_email`) — ISO 27001 A.8.15.
- **Toda llamada `$queryRaw`/`$executeRaw`** con tagged templates.
- **Despliegue:** trabajar en `develop`; pasar a `main` solo por orden explícita. Builds con `podman-compose` (frontend hornea `NEXT_PUBLIC_*` en build-time).
- **Versiones tras n8n (v3.0.0):** vars de entorno críticas obligatorias en compose (`:?`): `CMDB_SERVICE_TOKEN` (≥32 chars), `REDIS_PASSWORD`, `N8N_ENCRYPTION_KEY`. Nuevas en v3.2.0: `N8N_API_KEY`, `N8N_INTERNAL_URL`, `ALERT_FROM_EMAIL`, `LDAP_SYNC_GROUP_DN`, `LDAP_SYNC_DOMAIN`.

---

## Contexto y hallazgos (estado actual confirmado en código)

- **Dos almacenes de config.** n8n guarda credenciales **cifradas** en `n8n_data.credentials_entity` (con `N8N_ENCRYPTION_KEY`) y los workflows referencian credenciales por ID + parámetros de nodo. No existe forma nativa de que una credencial "lea el `.env`". Hoy se sincroniza a mano (UI) — lo que este plan elimina.
- **`install.sh` (1389 líneas) y `update.sh` (865 líneas)** se modificaron por última vez el **16-jun** (Plugin Engine v2.8.0), **antes** de v3.0.0 (n8n, 21-jun). Ninguno menciona n8n/Redis/credenciales.
- **`install.sh` escribe su propio `.env`** por heredoc (`scripts/install.sh:1006` → `ENVEOF`), **sin** `CMDB_SERVICE_TOKEN`, `REDIS_PASSWORD`, `N8N_ENCRYPTION_KEY`, `N8N_BASIC_AUTH_PASSWORD`, `BACKUP_LOCAL_PATH`. Como `docker-compose.prod.yml` las exige con `${VAR:?... is required}`, **`compose up` aborta** → el instalador actual no arranca en v3.0.0+.
- **`.env.example` SÍ está actualizado** (tiene `CMDB_SERVICE_TOKEN`, `REDIS_PASSWORD`, `N8N_ENCRYPTION_KEY`, `N8N_ALLOWED_IPS`, `N8N_BASIC_AUTH_*`, `BACKUP_LOCAL_PATH` con valores placeholder). install.sh simplemente no lo usa para generar el `.env` real.
- **n8n 1.123.27**, API pública **habilitada** (`GET http://cmdb-n8n-main:5678/api/v1/workflows` → 401 sin key, no 404). Tabla `n8n_data.user_api_keys` (id, userId, label, apiKey, scopes). **No hay comando CLI** para crear API keys → bootstrap a resolver en spike (Task 0).
- **Las 7 plantillas de workflow** viven en `docs/n8n/json/*.json` (`alertas-cmdb`, `mantenimiento-cmdb`, `rag-indexing`, `bulk-import-cis`, `ldap-ad-sync`, `backup-cmdb`, `notificaciones-cmdb`).
- **Parámetros hoy manuales** que deben pasar a env: remitente de Alertas (`fromEmail`, hoy editado a mano), `baseDN` + filtro `memberOf` del nodo LDAP, dominio de sync. Credenciales hoy manuales: `Header Auth` (X-CMDB-Service-Token), `SMTP`, `LDAP`.
- **Inconsistencia conocida:** el login LDAP del backend lee `LDAP_SEARCH_BASE` (`backend/src/services/ldap.ts:41`) pero `.env`/install.sh escriben `LDAP_BASE_DN`. Se unifica en este plan.

### Estructura de archivos (qué se crea/modifica)

**Backend — nuevo módulo `backend/src/modules/n8n-provisioning/`:**
- `config.ts` — carga tipada de los valores de aprovisionamiento desde `process.env` (`N8nProvisioningConfig`).
- `apiClient.ts` — cliente fino de la API REST de n8n (`/api/v1/`): list/create/update/activate workflows y credentials. Una sola responsabilidad: HTTP + auth.
- `credentials.ts` — construye los payloads de credenciales desde la config (`buildHeaderAuthCredential`, `buildSmtpCredential`, `buildLdapCredential`).
- `workflows.ts` — carga las plantillas de `templates/` y las renderiza (inyecta credenciales por nombre + `baseDN`/filtro/`fromEmail`/schedule).
- `provisioner.ts` — orquestador idempotente (`provisionAll`): upsert credenciales → upsert workflows → activar según política. Devuelve un `ProvisionReport`.
- `router.ts` — `POST /api/internal-admin/n8n/resync` (ADMIN) → `provisionAll` + AuditLog.
- `templates/*.json` — las 7 plantillas (copiadas de `docs/n8n/json/`, con placeholders `{{ENV:VAR}}` en los puntos parametrizables).
- `__tests__/*.test.ts` — tests por archivo (mocked fetch / mocked prisma).

**Backend — modificaciones:**
- `backend/src/index.ts` — montar el router; invocar `provisionOnBoot()` tras el arranque (no-fatal).
- `backend/src/services/ldap.ts:41` — leer `LDAP_SEARCH_BASE ?? LDAP_BASE_DN` (compat).

**Frontend:**
- `frontend/components/admin/N8nResyncCard.tsx` — tarjeta con botón "Resincronizar configuración" + estado/resultado.
- página de Settings/Admin que la monta (a decidir en Task 8 según dónde encaje).
- `frontend/locales/{es,en,de,fr,it,pt}.json` — bloque `settings.n8n.*`.

**Scripts / infra:**
- `scripts/install.sh` — generación de secretos n8n/Redis + bloque heredoc `.env` ampliado + bootstrap owner/API key + arranque ordenado.
- `scripts/update.sh` — migración de `.env` (append de vars ausentes con valores generados) + re-aprovisionamiento.
- `scripts/lib/n8n-bootstrap.sh` (nuevo) — funciones compartidas para crear owner + API key de n8n (resultado del spike Task 0).
- `.env.example` — añadir `N8N_API_KEY`, `N8N_INTERNAL_URL`, `ALERT_FROM_EMAIL`, `LDAP_SYNC_GROUP_DN`, `LDAP_SYNC_DOMAIN`, `LDAP_SEARCH_BASE`.

**Docs:**
- `docs/n8n/ADMIN_GUIDE.md`, `docs/n8n/WORKFLOWS.md`, `docs/ARCHITECTURE.md`(+`.en`), `docs/SYSADMIN_MANUAL.md`(+`.en`), `CLAUDE.md`.

---

## Orden de ejecución

`T0 (spike)` → `T1` → `T2`,`T3`,`T4` (paralelizables) → `T5` → `T6`,`T7` → `T8` → `T9`,`T10` → `T11` → `T12 (release, solo por orden)`.

---

## Tareas

### Task 0 — Spike: bootstrap no interactivo de owner + API key de n8n (1.123.27)

**Objetivo:** Determinar la secuencia exacta y reproducible para, en una instancia n8n recién arrancada y vacía, (a) crear/garantizar la cuenta propietaria sin el wizard interactivo y (b) emitir una API key pública válida, todo desde el host (psql + `podman exec`).

**Files:**
- Crear: `scripts/lib/n8n-bootstrap.sh`
- Crear: `docs/n8n/PROVISIONING.md` (documenta la secuencia hallada)

**Interfaces:**
- Produce: función bash `n8n_ensure_owner_and_key(container, db_container, db_user, db_name) -> echo API_KEY` usada por install/update.

- [ ] **Step 1:** Investigar en una instancia limpia: probar `N8N_USER_MANAGEMENT_DISABLED`, owner-setup vía `POST /rest/owner/setup`, y emisión de key vía `POST /rest/api-keys` tras `POST /rest/login`. Documentar el formato del `apiKey` (JWT firmado por n8n vs token plano) inspeccionando `n8n_data.user_api_keys` y `n8n_data.settings`.
- [ ] **Step 2:** Escribir `n8n_ensure_owner_and_key()` con la secuencia que funcione. Criterio de aceptación: la key devuelta autentica `GET /api/v1/workflows` con `200` (`X-N8N-API-KEY: <key>`).
- [ ] **Step 3:** Validar idempotencia: una segunda llamada no falla y reutiliza/rota la key de forma controlada (label fija `cmdb-provisioning`).
- [ ] **Step 4:** Documentar en `docs/n8n/PROVISIONING.md` la secuencia + supuestos de versión (1.123.x).
- [ ] **Step 5:** Commit: `chore(n8n): spike bootstrap owner+API key no interactivo (scripts/lib/n8n-bootstrap.sh)`.

> **Salida de seguridad:** si el bootstrap por env/REST resultara inviable en 1.123.27, el fallback documentado es insertar la cuenta owner + key directamente en `n8n_data` firmando el JWT con el secreto de `settings` (acoplado a versión; marcar como frágil y cubrir con un test de smoke en update.sh).

---

### Task 1 — Config tipada del aprovisionamiento + nuevas env vars

**Files:**
- Crear: `backend/src/modules/n8n-provisioning/config.ts`
- Crear: `backend/src/modules/n8n-provisioning/__tests__/config.test.ts`
- Modificar: `.env.example` (añadir vars nuevas)
- Modificar: `backend/src/services/ldap.ts:41`

**Interfaces:**
- Produce:
  ```ts
  export interface N8nProvisioningConfig {
    apiBaseUrl: string;          // N8N_INTERNAL_URL ?? 'http://n8n-main:5678'
    apiKey: string | null;       // N8N_API_KEY (null → provisioning deshabilitado)
    serviceToken: string;        // CMDB_SERVICE_TOKEN
    smtp:  { host?: string; port: number; secure: boolean; user?: string; pass?: string; from: string } | null;
    ldap:  { url?: string; baseDN?: string; bindDN?: string; bindPassword?: string; groupDN?: string; syncDomain?: string; useLdap: boolean } | null;
  }
  export function loadN8nProvisioningConfig(): N8nProvisioningConfig;
  ```
- Consume: `process.env`.

- [ ] **Step 1:** Test `config.test.ts`: con `SMTP_HOST` definido y `SMTP_USER` vacío → `smtp.host` set, `smtp.user` undefined, `smtp.from = ALERT_FROM_EMAIL`. Con `N8N_API_KEY` ausente → `apiKey === null`.
- [ ] **Step 2:** Run jest → FAIL (módulo no existe).
- [ ] **Step 3:** Implementar `loadN8nProvisioningConfig()` leyendo: `N8N_INTERNAL_URL`, `N8N_API_KEY`, `CMDB_SERVICE_TOKEN`, `SMTP_*`, `ALERT_FROM_EMAIL`, `LDAP_*`, `LDAP_SYNC_GROUP_DN`, `LDAP_SYNC_DOMAIN`, `USE_LDAP`.
- [ ] **Step 4:** En `.env.example` añadir, en una sección `# ── v3.2.0 — n8n provisioning ──`:
  ```
  N8N_INTERNAL_URL=http://n8n-main:5678
  N8N_API_KEY=
  ALERT_FROM_EMAIL=cmdb-alerts@noreply.local
  LDAP_SEARCH_BASE=
  LDAP_SYNC_GROUP_DN=
  LDAP_SYNC_DOMAIN=
  ```
- [ ] **Step 5:** En `ldap.ts:41` cambiar a `process.env.LDAP_SEARCH_BASE ?? process.env.LDAP_BASE_DN ?? 'dc=example,dc=com'`.
- [ ] **Step 6:** Run jest → PASS. `npx tsc --noEmit` sin errores nuevos.
- [ ] **Step 7:** Commit: `feat(n8n-provisioning): config tipada desde env + LDAP_SEARCH_BASE compat`.

---

### Task 2 — Cliente API de n8n (`apiClient.ts`)

**Files:**
- Crear: `backend/src/modules/n8n-provisioning/apiClient.ts`
- Crear: `backend/src/modules/n8n-provisioning/__tests__/apiClient.test.ts`

**Interfaces:**
- Consume: `N8nProvisioningConfig` (Task 1).
- Produce:
  ```ts
  export interface N8nApiClient {
    listWorkflows(): Promise<{ id: string; name: string; active: boolean }[]>;
    createWorkflow(body: unknown): Promise<{ id: string }>;
    updateWorkflow(id: string, body: unknown): Promise<void>;
    activateWorkflow(id: string): Promise<void>;
    listCredentials(): Promise<{ id: string; name: string; type: string }[]>;
    createCredential(body: unknown): Promise<{ id: string }>;
  }
  export function makeN8nApiClient(cfg: N8nProvisioningConfig): N8nApiClient;
  ```

- [ ] **Step 1:** Test con `fetch` mockeado: `listWorkflows()` envía `GET {apiBaseUrl}/api/v1/workflows` con header `X-N8N-API-KEY` y parsea `data[]`.
- [ ] **Step 2:** jest → FAIL.
- [ ] **Step 3:** Implementar con `fetch` nativo (Node 22). Cada método valida `res.ok`; si no, lanza `Error` con status (sin volcar el body completo en logs — A09).
- [ ] **Step 4:** jest → PASS.
- [ ] **Step 5:** Commit: `feat(n8n-provisioning): cliente REST /api/v1 (apiClient.ts)`.

> Nota n8n API: las credenciales se crean por `POST /api/v1/credentials` (no exponen `GET` de datos), por lo que el upsert de credenciales se hace por **nombre** consultando `listCredentials()` y, si existe, recreando (delete+create) — la API v1 no permite update de `data` de credencial. Documentar este matiz en `provisioner.ts`.

---

### Task 3 — Renderizado de credenciales desde env (`credentials.ts`)

**Files:**
- Crear: `backend/src/modules/n8n-provisioning/credentials.ts`
- Crear: `backend/src/modules/n8n-provisioning/__tests__/credentials.test.ts`

**Interfaces:**
- Consume: `N8nProvisioningConfig`.
- Produce:
  ```ts
  export const CRED_NAMES = { headerAuth: 'CMDB Service Token', smtp: 'CMDB SMTP', ldap: 'CMDB LDAP' } as const;
  export function buildHeaderAuthCredential(cfg: N8nProvisioningConfig): { name: string; type: 'httpHeaderAuth'; data: { name: string; value: string } };
  export function buildSmtpCredential(cfg: N8nProvisioningConfig): { name: string; type: 'smtp'; data: Record<string, unknown> } | null;
  export function buildLdapCredential(cfg: N8nProvisioningConfig): { name: string; type: 'ldap'; data: Record<string, unknown> } | null;
  ```

- [ ] **Step 1:** Tests: `buildHeaderAuthCredential` → `data = { name: 'X-CMDB-Service-Token', value: <serviceToken> }`. `buildSmtpCredential` con host puerto 25 → `secure:false`, sin `user`→ sin auth. `buildLdapCredential` con `useLdap=false`→ `null`.
- [ ] **Step 2:** jest → FAIL.
- [ ] **Step 3:** Implementar los tres builders (SMTP: `secure` derivado de puerto/`SMTP_SECURE`; STARTTLS por defecto en 25).
- [ ] **Step 4:** jest → PASS.
- [ ] **Step 5:** Commit: `feat(n8n-provisioning): builders de credenciales desde env`.

---

### Task 4 — Plantillas de workflow + renderizador (`workflows.ts` + `templates/`)

**Files:**
- Crear: `backend/src/modules/n8n-provisioning/templates/*.json` (7, copiadas de `docs/n8n/json/`, con placeholders)
- Crear: `backend/src/modules/n8n-provisioning/workflows.ts`
- Crear: `backend/src/modules/n8n-provisioning/__tests__/workflows.test.ts`

**Interfaces:**
- Consume: `N8nProvisioningConfig`, `CRED_NAMES`.
- Produce:
  ```ts
  export interface RenderedWorkflow { name: string; nodes: unknown[]; connections: unknown; settings: unknown; activateWhen: 'smtp'|'ldap'|'always'; }
  export function renderWorkflows(cfg: N8nProvisioningConfig): RenderedWorkflow[];
  ```

- [ ] **Step 1:** Preparar plantillas: en `alertas-cmdb.json`, nodo `Send Email` → `fromEmail: "{{ENV:ALERT_FROM_EMAIL}}"` + binding credencial `smtp` por nombre `CMDB SMTP`; nodos HTTP → binding `httpHeaderAuth` = `CMDB Service Token`. En `ldap-ad-sync.json` → `baseDN: "{{ENV:LDAP_BASE_DN}}"`, `filter` con `memberOf={{ENV:LDAP_SYNC_GROUP_DN}}`, credencial `ldap` = `CMDB LDAP`. Marcar `activateWhen` por workflow.
- [ ] **Step 2:** Test `workflows.test.ts`: `renderWorkflows(cfg)` sustituye `{{ENV:ALERT_FROM_EMAIL}}` por el valor de cfg y deja los 7 con nombres estables; LDAP marcado `activateWhen:'ldap'`.
- [ ] **Step 3:** jest → FAIL.
- [ ] **Step 4:** Implementar `renderWorkflows()` (lee templates con `import`/`fs`, sustituye `{{ENV:...}}`, inyecta bindings de credencial por nombre).
- [ ] **Step 5:** jest → PASS.
- [ ] **Step 6:** Commit: `feat(n8n-provisioning): plantillas de workflow + renderizador`.

---

### Task 5 — Orquestador idempotente (`provisioner.ts`)

**Files:**
- Crear: `backend/src/modules/n8n-provisioning/provisioner.ts`
- Crear: `backend/src/modules/n8n-provisioning/__tests__/provisioner.test.ts`

**Interfaces:**
- Consume: `N8nApiClient`, builders (Task 3), `renderWorkflows` (Task 4).
- Produce:
  ```ts
  export interface ProvisionReport { credentials: {name:string; action:'created'|'recreated'|'skipped'}[]; workflows: {name:string; action:'created'|'updated'; active:boolean}[]; errors: string[]; }
  export async function provisionAll(client: N8nApiClient, cfg: N8nProvisioningConfig): Promise<ProvisionReport>;
  ```

- [ ] **Step 1:** Test con `N8nApiClient` mockeado: upsert por nombre (si la credencial existe → recreate; si el workflow existe → update por id; si no → create). Activación según `activateWhen` + presencia de config (SMTP→Alertas activo; `useLdap=false`→LDAP no se activa).
- [ ] **Step 2:** jest → FAIL.
- [ ] **Step 3:** Implementar `provisionAll`: (1) credenciales (match por nombre vía `listCredentials`), (2) workflows (match por nombre vía `listWorkflows`, update/create), (3) `activateWorkflow` por política. Acumular `ProvisionReport`; capturar errores por item sin abortar el resto.
- [ ] **Step 4:** jest → PASS.
- [ ] **Step 5:** Commit: `feat(n8n-provisioning): orquestador idempotente provisionAll`.

---

### Task 6 — Auto-aprovisionamiento al arrancar el backend

**Files:**
- Crear: `backend/src/modules/n8n-provisioning/onBoot.ts`
- Modificar: `backend/src/index.ts` (invocación tras `app.listen`)
- Crear: `backend/src/modules/n8n-provisioning/__tests__/onBoot.test.ts`

**Interfaces:**
- Produce: `export function provisionOnBoot(): void;` (fire-and-forget, no bloquea el arranque).

- [ ] **Step 1:** Test: con `N8N_API_KEY` ausente → `provisionOnBoot` loguea aviso y **no** lanza. Con key → reintenta hasta que `listWorkflows` responde (backoff), luego `provisionAll`.
- [ ] **Step 2:** jest → FAIL.
- [ ] **Step 3:** Implementar `provisionOnBoot()`: si `cfg.apiKey` null → `log.warn('[n8n] N8N_API_KEY ausente; aprovisionamiento omitido')` y return. Si no → reintentos (máx 10, 6s) hasta n8n sano → `provisionAll` → log del `ProvisionReport`. Errores no son fatales.
- [ ] **Step 4:** En `index.ts`, tras el arranque, `provisionOnBoot();` (junto a `startAlertScheduler`).
- [ ] **Step 5:** jest → PASS; `tsc --noEmit` limpio.
- [ ] **Step 6:** Commit: `feat(n8n-provisioning): auto-aprovisionar al arrancar (no-fatal, con reintentos)`.

---

### Task 7 — Endpoint de resync bajo demanda (ADMIN)

**Files:**
- Crear: `backend/src/modules/n8n-provisioning/router.ts`
- Modificar: `backend/src/index.ts` (montar router)
- Crear: `backend/src/modules/n8n-provisioning/__tests__/router.test.ts`

**Interfaces:**
- Ruta: `POST /api/admin/n8n/resync` (montada con `authenticateToken` + `requireAdmin`).
- Respuesta: `200 { report: ProvisionReport }` | `503 { error }` si `apiKey` null.

- [ ] **Step 1:** Tests supertest: sin token → 401; rol AUDITOR → 403; ADMIN con `apiKey` null → 503; ADMIN OK → 200 con `report` + se inserta `AuditLog` (`N8N_RESYNC`).
- [ ] **Step 2:** jest → FAIL.
- [ ] **Step 3:** Implementar `createN8nProvisioningRouter(prisma)`; handler llama `provisionAll`, inserta AuditLog con `$executeRaw`, devuelve el report. Montar en `index.ts`: `app.use('/api/admin/n8n', authenticateToken, requireAdmin, createN8nProvisioningRouter(prisma))`.
- [ ] **Step 4:** jest → PASS.
- [ ] **Step 5:** Commit: `feat(n8n-provisioning): endpoint ADMIN POST /api/admin/n8n/resync + auditoría`.

---

### Task 8 — Botón "Resincronizar configuración" en Settings + i18n

**Files:**
- Crear: `frontend/components/admin/N8nResyncCard.tsx`
- Modificar: la página de admin/settings donde encaje (decidir leyendo `frontend/app/settings/page.tsx` / `app/admin/page.tsx`)
- Modificar: `frontend/locales/{es,en,de,fr,it,pt}.json` (bloque `settings.n8n.*`)

**Interfaces:**
- Consume: `POST /api/admin/n8n/resync` vía `lib/apiFetch.ts`.

- [ ] **Step 1:** Crear `N8nResyncCard.tsx` siguiendo el patrón canónico de la casa (panel `ring-1 ring-slate-200 bg-white shadow-sm`, botón primario `rounded-none bg-[var(--accent)]`). Estado: idle/loading/done/error; al pulsar, POST y render del `ProvisionReport` (credenciales + workflows con su acción).
- [ ] **Step 2:** Añadir claves i18n en los 6 idiomas: `settings.n8n.title`, `.desc`, `.button`, `.running`, `.success`, `.error`, `.no_apikey`.
- [ ] **Step 3:** Montar la tarjeta en la sección de administración (solo visible para ADMIN).
- [ ] **Step 4:** Verificación manual (Playwright MCP, login con admin temporal MFA según CLAUDE.md): pulsar el botón, ver el report.
- [ ] **Step 5:** Commit: `feat(settings): botón Resincronizar configuración n8n (ADMIN) + i18n ×6`.

---

### Task 9 — `install.sh`: secretos n8n/Redis + bootstrap + arranque ordenado

**Files:**
- Modificar: `scripts/install.sh` (generación de secretos; heredoc `.env`; fase de bootstrap n8n)
- Usa: `scripts/lib/n8n-bootstrap.sh` (Task 0)

- [ ] **Step 1:** Tras `JWT_SECRET`, generar: `CMDB_SERVICE_TOKEN="$(openssl rand -hex 32)"`, `REDIS_PASSWORD="$(openssl rand -base64 24 | tr -d '/+=' )"`, `N8N_ENCRYPTION_KEY="$(openssl rand -hex 32)"`, `N8N_BASIC_AUTH_PASSWORD="$(openssl rand -base64 18)"`, `BACKUP_LOCAL_PATH="${DATA_PATH}/backups"`.
- [ ] **Step 2:** Ampliar el heredoc `.env` (antes de `ENVEOF`, `scripts/install.sh:~1097`) con la sección n8n/Redis completa: las anteriores + `N8N_INTERNAL_URL=http://n8n-main:5678`, `N8N_ALLOWED_IPS`, `N8N_BASIC_AUTH_ACTIVE=true`, `N8N_BASIC_AUTH_USER=n8n-admin`, `ALERT_FROM_EMAIL`, `LDAP_SEARCH_BASE=${LDAP_BASE_DN}`, `LDAP_SYNC_GROUP_DN`, `LDAP_SYNC_DOMAIN`, y `N8N_API_KEY=` (se rellena en Step 4).
- [ ] **Step 3:** Tras `compose up -d`, esperar salud de `n8n-main` (`/healthz`).
- [ ] **Step 4:** `source scripts/lib/n8n-bootstrap.sh`; `API_KEY=$(n8n_ensure_owner_and_key cmdb-n8n-main cmdb-postgres-prod admin cmdb_db)`; escribir `N8N_API_KEY=$API_KEY` en `.env` (reemplazo in-place) y `restart` del backend para que lo recoja.
- [ ] **Step 5:** Eliminar de la guía interactiva los pasos "crea credenciales / importa workflows / activa" (ahora automático). El backend aprovisiona al reiniciar.
- [ ] **Step 6:** Prueba en limpio (entorno desechable): `install.sh` desatendido → `curl -sk https://localhost/api/health` OK + `GET /api/v1/workflows` (con la key) lista los 7 workflows.
- [ ] **Step 7:** Commit: `feat(install): genera secretos n8n/Redis + bootstrap API key + arranque ordenado`.

---

### Task 10 — `update.sh`: migración de `.env` + re-aprovisionamiento

**Files:**
- Modificar: `scripts/update.sh`

- [ ] **Step 1:** Función `ensure_env_var(KEY, default_or_generator)`: si `KEY` no está en `.env`, la añade (genera secretos con `openssl` cuando aplique). Aplicarla a todas las vars de v3.0.0+ y v3.2.0 para upgrades desde <3.0.0.
- [ ] **Step 2:** Si `N8N_API_KEY` está vacía tras la migración, ejecutar `n8n_ensure_owner_and_key` y rellenarla.
- [ ] **Step 3:** Tras `compose up -d --build` y `prisma migrate deploy`, el backend re-aprovisiona al arrancar (Task 6). Opcionalmente, `curl -X POST .../api/admin/n8n/resync` si hay token admin disponible (documentado, no obligatorio).
- [ ] **Step 4:** Prueba de upgrade simulada: partir de un `.env` estilo v2.9 → `update.sh` añade las vars n8n/Redis sin tocar las existentes; stack arranca.
- [ ] **Step 5:** Commit: `feat(update): migración de .env (vars n8n/Redis) + re-aprovisionamiento`.

---

### Task 11 — Documentación

**Files:** `docs/n8n/ADMIN_GUIDE.md`, `docs/n8n/WORKFLOWS.md`, `docs/n8n/PROVISIONING.md`, `docs/ARCHITECTURE.md`(+`.en`), `docs/SYSADMIN_MANUAL.md`(+`.en`), `CLAUDE.md`.

- [ ] **Step 1:** `ADMIN_GUIDE.md`: sustituir "crea credenciales/importa/activa manualmente" por "el backend aprovisiona automáticamente al arrancar; resync desde Settings". Documentar que **`.env` es la única fuente de verdad** y el flujo: *editar `.env` → reiniciar backend (o pulsar Resincronizar)*.
- [ ] **Step 2:** `ARCHITECTURE.md`(+`.en`): sección "n8n provisioning" (módulo backend + API REST + boot/botón).
- [ ] **Step 3:** `SYSADMIN_MANUAL.md`(+`.en`): instalación/actualización con los scripts ya n8n-aware.
- [ ] **Step 4:** `CLAUDE.md`: nota de que el aprovisionamiento de n8n es automático y app-native (no manual).
- [ ] **Step 5:** Commit: `docs(v3.2.0): aprovisionamiento n8n automático + .env única fuente de verdad`.

---

### Task 12 — Release (FUERA DE ALCANCE hasta orden explícita)

- [ ] PR `develop → main`, tag `v3.2.0`, GitHub release, despliegue limpio en prod, smoke tests (instalador limpio + upgrade + resync).

---

## Verificación end-to-end

1. `cd backend && npx tsc --noEmit` → 0 errores nuevos (ignorar `Property 'license'`/`'licenseUser'`/`'stagingZip'`).
2. `docker exec cmdb-backend npx jest modules/n8n-provisioning` → verde.
3. **Instalador limpio** (entorno desechable): `install.sh` desatendido → health OK + 7 workflows aprovisionados + Alertas activo (si SMTP) sin tocar la UI de n8n.
4. **Única fuente de verdad:** editar `ALERT_FROM_EMAIL` en `.env` → `compose restart backend` → la credencial/nodo de n8n reflejan el cambio (verificado vía `GET /api/v1/workflows`).
5. **Botón resync:** editar `.env`, pulsar "Resincronizar" en Settings → `ProvisionReport` muestra `updated` sin reiniciar.
6. **Upgrade:** `.env` estilo v2.9 → `update.sh` añade vars sin romper; stack arranca y aprovisiona.
7. **Idempotencia:** dos resync seguidos → segundo todo `updated/recreated/skipped`, sin duplicados en n8n.

## Riesgos y mitigaciones

- **Bootstrap de API key (Task 0)** es la incógnita principal → se aísla en spike con fallback documentado (inserción directa firmada).
- **API v1 no actualiza `data` de credencial** → patrón delete+create por nombre (idempotente). Aceptable: las credenciales se recrean, los workflows se rebindan por nombre.
- **Secretos por la red interna** (backend→n8n) → tráfico en red `cmdb-internal` aislada; documentar. No exponer `N8N_API_KEY` en logs ni respuestas.
- **Orden de arranque** (backend antes que n8n) → `provisionOnBoot` reintenta con backoff; no fatal.

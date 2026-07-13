# PLAN STATUS v3.5.3 — Conector vCenter (sincronización VM → CMDB)

**Estado final:** 🚧 EN DEVELOP (rama `feature/v3.5.3-vcenter-connector`, no fusionada a `develop` todavía — esta tarea es la última de 6, la fusión y el tag son un paso posterior a este documento)
**Rama:** `feature/v3.5.3-vcenter-connector` (cortada de `develop`)
**Plan completo:** `docs/PLAN_v3.5.3.md`
**Inicio:** 2026-07-12

## Estado de tareas

| Tarea | Estado |
|---|---|
| Fase de diseño (Opus) — plan D1–D5 | ✅ Completada (`6b0f303`) |
| Task A — Migración `vcenter_sync` column | ✅ Completada (`add9b68`) |
| Task B — Connector core (types, base, client, mapper) | ✅ Completada (`25e78b5`, `9344a13`, `86bd1b7`, fix `1bbd745`) |
| Task C — Sync service + rutas (ADMIN + internal) | ✅ Completada (`f30c39e`, fix `b8dc294`) |
| Task D — Workflow n8n plantilla en código | ✅ Completada (`37ebcca`, fix `a9c1192`) |
| Task E — Frontend vCenter card | ✅ Completada (`d398ac2`, fix `6491def`) |
| Task F — Compose/install wiring + docs + verificación | ✅ Completada (este commit) |
| Task G1 — Schema: `Hypervisor` master + `CI.hypervisorId`/`powerState` (drop `vcenter_sync`) | ✅ Completada (`9edba06`) |
| Task G2 — Backend: masters CRUD `Hypervisor` + validación obligatoria en CI `VIRTUAL_SERVER` | ✅ Completada (`d290356`) |
| Task G3 — Frontend: campo "Hipervisor" en `AddCIModal`/`EditCIModal` | ✅ Completada (`112789b`) |
| Task G4 — Rework conector vCenter: fencing por `hypervisorId` exacto + `powerState` | ✅ Completada (`eaa0a11`) |
| Task H1 — Adopción de CIs manuales pre-existentes en el primer sync (match por nombre) | ✅ Completada (`24cef18`) |
| Task H2 — Resolución best-effort de `esxiHost` + relación `HOSTS` idempotente | ✅ Completada (`7570d62`) |

## Resumen de lo entregado

Conector genérico de sincronización externa (`BaseConnector` → `VCenterConnector` → `VCenterClient` → `VCenterMapper`) bajo `backend/src/modules/integrations/connectors/`, primera implementación concreta: **vCenter → CMDB**, sincronización unidireccional de VMs como CIs `VIRTUAL_SERVER`.

- **Task A**: columna aditiva `vcenter_sync jsonb` en `configuration_items` (migración `20260712100000_ci_vcenter_sync_column`, `CI.vcenterSync Json?`). Sin tabla nueva, sin cambio de esquema relacional. **Nota:** este diseño quedó superado por el rediseño de las Tasks G1-G4 (ver más abajo) — `vcenter_sync` se eliminó y se sustituyó por la tabla maestra `Hypervisor` + `CI.hypervisorId`/`CI.powerState`.
- **Task B**: `connectors/types.ts` (`IHypervisorConnector`, `DiscoveredVM`, `SyncResult`); `VCenterMapper.toCI()` puro, TDD (7/7 tests: apagada, suspendida, IP guest ausente, `guest_OS` desconocido, redondeo MiB→GB); `vcenterConfig.ts` (env→config tipada, `toPublicConfig()` sin secretos); `VCenterClient` sobre **`https` nativo de Node** (desviación: el plan original mencionaba `undici`, mantenido fuera de las dependencias del proyecto — no rompe ningún requisito, la sesión/TLS/self-signed se implementan igual); `VCenterConnector` orquesta el descubrimiento normalizando `power_state` desconocido a `POWERED_OFF`.
- **Task C**: `runVCenterSync()` — lock en proceso, upsert de campos D5 (`vCpus`/`ram`/`adminIp`/`hostName`/`clusterName`/`operatingSystem`/`vcenter_sync`), retiro de VMs huérfanas fenced por `ciType=VCENTER_CI_TYPE AND vcenter_sync IS NOT NULL` (nunca toca CIs creados manualmente), auditoría `SYNC_VCENTER` en `audit_logs` incluso en fallo catastrófico (fix `b8dc294`, con sanitización de mensajes de error por-VM para no filtrar internals de Prisma en la respuesta). 4 rutas ADMIN/AUDITOR bajo `/api/integrations/vcenter/*` + 1 ruta interna M2M `/api/internal/vcenter/sync`. **Nota:** el fencing por `vcenter_sync IS NOT NULL` quedó igualmente superado por el rediseño de las Tasks G1-G4 — ahora es igualdad exacta `hypervisorId === <id de la fila VMware>` (ver más abajo).
- **Task D**: plantilla de workflow n8n `"vCenter Sync"` (`n8n-provisioning/templates/vcenter-sync.ts`) — Schedule Trigger (`VCENTER_SYNC_CRON`) → HTTP Request a `/api/internal/vcenter/sync` (header `X-CMDB-Service-Token`) → IF 200 → NoOp / notificar fallo. Nueva clave `ActivateWhen: 'vcenter'` gobernada por `VCENTER_SYNC_ENABLED`. Fix `a9c1192`: el nodo de notificación de fallo no incluía `channel`, por lo que ni el gate de Teams ni el de Slack disparaban — corregido a `channel:"both"`.
- **Task E**: `VCenterCard.tsx` + `SyncLogTable.tsx` en Configuración → Integraciones — badge de estado (configurado/no configurado/error), botones **Probar conexión** / **Sincronizar ahora** (ADMIN only), última sincronización relativa, tabla de historial. Hooks `useVCenterStatus`/`useVCenterTest`/`useSyncNow`/`useSyncLog`. i18n ×6 completo (`settings.integrations.vcenter_*`). Fix `6491def`: tiempo relativo y badge de estado del log no traducían pese a recibir `t()`.
- **Task F** (este documento): wiring de las 10 variables `VCENTER_*` en `docker-compose.yml` y `docker-compose.prod.yml` (backend `environment:`, estilo `${VAR:-default}` — todas opcionales, ninguna usa `:?` porque el feature viene apagado por defecto); `.env.example` (nueva sección junto a LDAP Sync); `scripts/update.sh` `check_new_env_vars()` (10 vars en `NEW_VARS` + defaults en el `case`, **no** tocado `ensure_required_env_vars()`); `docs/INTEGRATIONS.md` nuevo (arquitectura del patrón de conector, cómo añadir un futuro conector, referencia de env vars, D1–D5, riesgo self-signed, prueba manual, tabla de 5 endpoints); `docs/ARCHITECTURE.md`/`.en.md` (subsección "Conector vCenter" bajo `## 8. Módulos Funcionales`/`## 8. Functional Modules`); `docs/USER_MANUAL.md`/`.en.md` (subsección de la tarjeta vCenter en la pestaña Integraciones); `CLAUDE.md` (nota de patrón de conector + D1–D5 bajo la convención de módulos, y entrada 🚧 EN DEVELOP en "Releases recientes"); `docs/EXECUTION_LOG.md` nuevo (log retrospectivo Tasks A–F).

## Resumen del rediseño Hypervisor (Tasks G1-G4)

Después de que Task F cerrara el conector vCenter tal como lo describe el plan original, el usuario —que en producción real opera VMware vCenter, Oracle OLVM y zonas Solaris simultáneamente— preguntó cómo garantizaba el diseño que la sincronización de vCenter nunca tocara una VM que no fuera suya. La respuesta honesta era que no lo garantizaba del todo: la valla de retiro original (`ciType=VCENTER_CI_TYPE AND vcenter_sync IS NOT NULL`) es un chequeo de "no nulo", y en cuanto existiera un segundo conector rellenando su propia columna de metadatos, ese chequeo dejaría de distinguir "propiedad de vCenter" de "propiedad de cualquier conector".

Las cuatro tareas G1-G4 sustituyen `CI.vcenterSync jsonb` por un diseño de propiedad explícito: **Task G1** (`9edba06`) añade la tabla maestra `Hypervisor` (`code`/`name`/`isSystem`, sembrada con `code='VMWARE', isSystem=true`, siguiendo el patrón ya existente de `CIType`/`OperatingSystem`) y las columnas `CI.hypervisorId` (FK) + `CI.powerState` (escalar), eliminando `vcenter_sync`. **Task G2** (`d290356`) añade el CRUD de administración en `/api/masters/hypervisors` (filas `isSystem=true` protegidas contra edición/borrado con `409`) y hace `hypervisorId` obligatorio, server-side, al crear/editar cualquier CI `VIRTUAL_SERVER`. **Task G3** (`112789b`) añade el desplegable "Hipervisor" correspondiente en `AddCIModal`/`EditCIModal`, poblado desde ese mismo endpoint. **Task G4** (`eaa0a11`) reescribe la valla de retiro del conector vCenter: en vez de `vcenter_sync IS NOT NULL`, ahora es **igualdad exacta** `hypervisorId === <id de la fila VMware>` — la única regla que sigue siendo segura cuando exista un segundo conector (p. ej. OLVM) cuyas VMs también tendrían un `hypervisorId` no nulo, apuntando a su propia fila maestra.

El resultado final: `hypervisorId` se fija solo en la creación del CI (nunca se refresca — es un marcador de clasificación, no un hecho físico) y es la base de la propiedad; `powerState` sigue el patrón D5 original (hecho físico, refrescado en cada sync). Ver `docs/INTEGRATIONS.md` § "Modelo de propiedad tras el rediseño Hypervisor" para el detalle completo, incluyendo la receta actualizada para futuros conectores (OLVM/Solaris).

## Resumen Tasks H1-H2 (adopción + relación HOSTS)

**Task H1** (`24cef18`) resuelve un problema práctico dejado abierto por el rediseño Hypervisor: el conector solo matcheaba VMs a CIs por `apiSlug === "vm-{moref}"`, lo que nunca reconoce los 208 CIs `VIRTUAL_SERVER` pre-existentes, introducidos manualmente antes de que este conector existiera (su `apiSlug` es el que le asignó un admin o una importación). Sin esto, el primer sync habría creado un CI duplicado por cada VM ya inventariada. La solución: cuando no hay match por `apiSlug`, se busca un CI **sin clasificar** (`hypervisorId IS NULL`) cuyo nombre coincida (case-insensitive) con el de la VM; si el match es inequívoco (exactamente uno), se "adopta" — se le fija `apiSlug` al valor canónico y `hypervisorId` al del hipervisor VMware, además de los campos físicos habituales — de modo que los siguientes syncs ya lo reconocen directamente por `apiSlug`. Cero o dos-o-más candidatos caen al camino normal de creación; nunca se adivina. La valla de seguridad reutiliza la misma propiedad que ya protegía la valla de retiro (G1-G4): `hypervisorId IS NULL` excluye a nivel de BD cualquier CI ya clasificado por otro hipervisor (este u otro futuro, p. ej. OLVM), así que la adopción nunca reclasifica un CI ajeno.

**Task H2** (`7570d62`) añade resolución best-effort del host ESXi de cada VM (`VCenterClient.hostSummary()` + `VCenterConnector.discover()`, según los esquemas vSphere `VM.Summary`/`Host.Info`) y, cuando existe exactamente un CI `PHYSICAL_SERVER` cuyo `name`/`hostName` coincide (case-insensitive) con ese host, crea una relación `CIRelation` `HOSTS` idempotente hacia él en `vcenterService.ts`. **Caveat documentado**: los nombres de campo de la API vSphere usados no se verificaron contra un vCenter real en esta sesión — el código está defensivamente envuelto para que cualquier suposición incorrecta degrade con seguridad a `esxiHost: null`/sin relación creada, sin afectar el resto del sync de la VM. La resolución de `cluster` sigue genuinamente fuera de alcance (no tocada por H1 ni H2).

## Decisiones clave (D1–D5, resumen)

- **D1**: credenciales/config solo por env vars — sin tabla `integration_configs`, sin cifrado AES en BD.
- **D2**: `power_state` nunca sobrescribe `status` — VMs nuevas se crean `ACTIVO`; ausencia en vCenter ⇒ `RETIRADO`.
- **D3**: workflow n8n como plantilla de código auto-aprovisionada (patrón desde v3.2.0), no JSON importable manualmente.
- **D4**: historial de sync en `audit_logs` (`action='SYNC_VCENTER'`) — sin tabla `sync_logs` nueva.
- **D5**: vCenter posee hechos físicos (specs, IPs, hostname); el operador posee la gobernanza (criticidad, entorno, owners) — nunca se sobrescribe tras la creación.

## Desviaciones respecto al plan original

- **HTTP client**: `VCenterClient` usa el módulo `https` nativo de Node en vez de `undici` (mencionado en `docs/PLAN_v3.5.3.md`) — `undici` no es una dependencia de este proyecto; la funcionalidad (sesión, TLS self-signed, timeouts) es equivalente.
- **`cluster`**: los endpoints de vm-detail/guest-identity usados por `VCenterConnector` no exponen este campo directamente; queda documentado como `null` (gap conocido, no bloqueante). Fix aplicado tras la revisión final de rama: como el conector siempre resuelve `clusterName=null` por este gap, escribirlo incondicionalmente en cada update borraba cualquier valor que un operador hubiera fijado a mano — ahora solo se escribe cuando el conector resuelve un valor real (commit `3504ec1`).
- **`esxiHost`**: inicialmente documentado como `null` por el mismo gap que `cluster` (Task B/G4). La Task H2 (`7570d62`, posterior a esta revisión final) añadió su resolución best-effort vía `VCenterClient.hostSummary()` y, cuando resuelve a un valor y existe exactamente un CI `PHYSICAL_SERVER` que coincide por nombre/hostname, crea una relación `HOSTS` idempotente hacia él — ver detalle en el resumen de H1/H2 más abajo. Esta corrección documental (revisión final de rama) sustituye la afirmación anterior, ya obsoleta, de que el CI se sincroniza "sin la relación `HOSTS`".

## Deuda aceptada (revisión final de rama)

- **Auditoría por-CI no transaccional**: cada `cI.create`/`update`/`retire` y su `insertAuditRow()` correspondiente en `runVCenterSync()` son awaits independientes, no envueltos en `prisma.$transaction` — si el insert de auditoría fallara tras confirmar la mutación, quedaría un CI escrito/retirado sin su fila de auditoría individual (el mismo patrón que motivó la auditoría transaccional de Staff Schedule, issue #172). **Mitigación existente**: coincide con el patrón ya usado por las integraciones hermanas Greenbone/CrowdStrike (tampoco transaccionales) y la corrida completa SIEMPRE deja un resumen `SYNC_VCENTER` auditado — incluso en fallo catastrófico — así que la ejecución nunca queda invisible, solo el detalle por-CI en el caso límite de fallo del propio insert de auditoría. Se deja como deuda documentada, no como bloqueante de este merge; seguimiento recomendado alineado con el mismo esfuerzo de auditoría transaccional que #172 abrió para `index.ts` legacy.

## Verificación de Task F (file-level, sin contenedores en ejecución)

- `python3 -c "import yaml; yaml.safe_load(open('docker-compose.yml'))"` y lo mismo para `docker-compose.prod.yml` → parseo OK.
- `podman-compose -f docker-compose.yml config` y `podman-compose -f docker-compose.prod.yml config` → resuelven sin error (exit 0 en ambos), confirmando que las 10 vars nuevas no rompen la interpolación de compose.
- `bash -n scripts/update.sh` → sin errores de sintaxis tras añadir los 10 nombres a `NEW_VARS` y sus ramas `case`.
- Revisión manual de los Markdown nuevos/editados: cabeceras `##`/`###` consistentes, sin fences sin cerrar.

## Verificación en vivo (controlador, post-rebuild)

Stack reconstruido por completo (`podman-compose -f docker-compose.prod.yml down && up -d --build`) para incorporar el código de las 6 tareas. Resultados:

- **Backend**: arranque limpio — `60 migrations found ... No pending migrations to apply` (confirma que la migración de Task A ya estaba aplicada y el schema es consistente), seed ya presente, `🚀 CMDB API running`. `curl -sk https://localhost/api/health` → `{"status":"ok",...}`.
- **Endpoints vCenter** (probados con la cuenta de test `claude@cmdb.local`, rol AUDITOR, más una petición sin token):
  - `GET /api/integrations/vcenter/status` sin token → `401`.
  - `GET /api/integrations/vcenter/status` con AUDITOR → `200 {"configured":false,"host":null,"sslVerify":false,"syncEnabled":false,"lastSyncAt":null,"lastSyncResult":null}` — sin secretos, tal como exige D1.
  - `GET /api/integrations/vcenter/sync-log` con AUDITOR → `200 []` (sin ejecuciones todavía, correcto).
  - `POST /api/integrations/vcenter/sync` con AUDITOR → `403 {"error":"Admin role required..."}` — RBAC confirmado en vivo, no solo en tests.
- **`tsc --noEmit`**: no ejecutable directamente en el contenedor de producción (imagen runtime sin `tsconfig.json`/`src/`, solo `dist/` compilado — comportamiento esperado). El propio éxito del build Docker (que compila TypeScript como parte del build) ya certifica 0 errores; además cada una de las Tareas A-E ya verificó `tsc --noEmit` limpio de forma independiente durante su propia implementación/revisión.
- **Frontend**: `GET /settings` → `200`. Confirmado que el bundle Next.js compilado contiene el nuevo código (`grep -rl "vcenter_sync_now|VCenterCard" /app/.next` → varios chunks coinciden), es decir, la tarjeta se compiló e incluyó correctamente en el build de producción.
- **Smoke test visual de la UI**: **no realizado** — este entorno no tiene el binario de Chrome instalado para Playwright (`Chromium distribution 'chrome' is not found`). Sustituido por la verificación de bundle + endpoints de arriba, que cubre la misma superficie de riesgo (código presente, correctamente compilado, endpoints correctos) sin la confirmación visual pixel-a-pixel.
- **n8n / aprovisionamiento del workflow "vCenter Sync"**: **no verificable en este stack** — `provisionOnBoot()` falla con `401 unauthorized` al llamar a la API de n8n (`N8N_API_KEY` en `.env` no coincide con la clave real de esta instancia de n8n). Confirmado que es un problema de **infraestructura preexistente, no relacionado con el conector vCenter**: afecta igual al resync de cualquiera de los 5 workflows ya activados (Alertas, Backup, Bulk Import, Mantenimiento, RAG), no solo al nuevo. La plantilla `vcenter-sync.ts` en sí está completamente cubierta por tests unitarios (Task D, revisados) que verifican su estructura, `activateWhen` y sustitución de placeholders — lo que no se pudo confirmar en vivo es el aprovisionamiento real vía API, por esta causa externa a la feature. **Acción recomendada para el usuario**: regenerar `N8N_API_KEY` (`ensure_n8n_api_key()` en `scripts/update.sh`, o manualmente desde la UI de n8n) y volver a lanzar el resync — no se ha tocado esta configuración aquí para no mutar infraestructura compartida sin autorización explícita para ese cambio concreto.

## Verificación en vivo del rediseño Hypervisor (Tasks G1-G4, controlador, post-rebuild)

Stack reconstruido de nuevo por completo (`down && up -d --build`) para incorporar el código de
las Tasks G1-G4 sobre lo ya verificado de F. El build de Docker (que compila TypeScript) terminó
sin errores, certificando `tsc --noEmit` limpio en todo el árbol sin necesidad de ejecutarlo en el
contenedor runtime (que no lleva `tsconfig.json`/`src/`).

- **Migraciones**: `62 migrations found ... No pending migrations to apply` — confirma que las
  migraciones de G1 (tabla `hypervisors` + `CI.hypervisorId`/`powerState`, drop de `vcenter_sync`)
  quedaron correctamente incorporadas en la imagen reconstruida, sin drift respecto a lo aplicado
  manualmente durante la Task G1.
- **`GET /api/masters/hypervisors`** (AUDITOR) → `200 [{"code":"VMWARE","name":"VMware vSphere / vCenter","isSystem":true,...}]` — exactamente la fila sembrada, ninguna más.
- **`GET /api/integrations/vcenter/status`** sigue funcionando tras el rework del conector (`200 {"configured":false,...}`) — el endpoint no dependía de `vcenter_sync` directamente y no se rompió por el cambio de esquema subyacente.
- **La pregunta original del usuario, verificada directamente contra la BD real**: de los **208 CIs
  `VIRTUAL_SERVER` ya existentes** en esta instancia (datos reales, no de prueba — mezcla plausible
  de VMware/OLVM/Solaris/entradas manuales), **el 100% tiene `hypervisor_id IS NULL`** ahora mismo.
  Ninguno fue tocado por la migración (columna aditiva, sin backfill) y, con el nuevo fencing por
  igualdad exacta, **ninguno de ellos podría ser retirado jamás** por una sincronización de vCenter
  — activarla o no (`VCENTER_SYNC_ENABLED`) es irrelevante para estos 208 CIs mientras no se les
  asigne explícitamente el hipervisor VMware (vía sync real o edición manual).
- **Smoke del resto de la app**: `GET /api/cis?limit=1` → `200` (inventario core intacto);
  `GET /settings` → `200`; el bundle de Next.js reconstruido contiene el código del nuevo campo
  "Hipervisor" (`grep -rl "hypervisor_label|requiresHypervisor" /app/.next` → coincide en varios
  chunks, incluido el de `/inventory`).
- **Smoke visual de la UI**: no realizado (mismo motivo que en Task F — sin binario de Chrome para
  Playwright en este entorno); sustituido por la verificación de bundle + endpoints de arriba.

**Estado final de Task F: completada.** Único punto pendiente de verificación (aprovisionamiento n8n) es un problema operativo preexistente, documentado, fuera del alcance de esta feature — no bloquea el merge del código.

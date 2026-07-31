# Integraciones — Conectores de Sincronización Externa

> Este documento cubre el **patrón de conector** introducido en v3.5.3 y su primera implementación, el **conector vCenter** (VMware vSphere → CMDB). Sirve también de referencia para futuros conectores (OLVM, Solaris/Illumos, etc.).

## Índice

1. [Arquitectura del patrón de conector](#1-arquitectura-del-patrón-de-conector)
2. [Cómo añadir un futuro conector](#2-cómo-añadir-un-futuro-conector)
3. [Referencia de variables de entorno](#3-referencia-de-variables-de-entorno)
4. [Decisiones de diseño D1–D5](#4-decisiones-de-diseño-d1d5)
5. [Riesgo de certificado self-signed](#5-riesgo-de-certificado-self-signed)
6. [Endpoints](#6-endpoints)
7. [Prueba manual contra un vCenter real](#7-prueba-manual-contra-un-vcenter-real)
8. [LDAP / Active Directory — grupo de acceso y sincronización de usuarios (v3.5.10)](#8-ldap--active-directory--grupo-de-acceso-y-sincronización-de-usuarios-v3510)
9. [Importación de vulnerabilidades Greenbone — formato real y staging (v3.6.0)](#9-importación-de-vulnerabilidades-greenbone--formato-real-y-staging-v360)
   - [9.12 Segunda fuente: CrowdStrike Spotlight (mismo staging, sin tag todavía)](#912-segunda-fuente-crowdstrike-spotlight-mismo-staging-sin-tag-todavía)

---

## 1. Arquitectura del patrón de conector

```
backend/src/modules/integrations/
├── connectors/
│   ├── types.ts                      # IHypervisorConnector, DiscoveredVM, SyncResult
│   ├── base/
│   │   └── BaseConnector.ts          # abstracto — scaffold común
│   └── vcenter/
│       ├── VCenterClient.ts          # HTTP (https nativo de Node), sesión, TLS
│       ├── VCenterConnector.ts       # implementa IHypervisorConnector para vCenter
│       ├── VCenterMapper.ts          # mapeo puro VM vCenter → payload de CI
│       └── __tests__/
├── vcenterConfig.ts                  # lee/valida env vars → config tipada
├── vcenterService.ts                 # runVCenterSync() — orquestación
└── router.ts                         # rutas ADMIN/AUDITOR (extiende el router existente)

backend/src/modules/internal/
└── vcenter.ts                        # ruta M2M para el workflow n8n
```

**Capas, de fuera hacia dentro:**

- **`BaseConnector`** (abstracto) — define el contrato mínimo (`connect()`, `discover()`, `close()`) que implementa `IHypervisorConnector` (`connectors/types.ts`). No contiene lógica compartida todavía (es un scaffold, no una clase base con comportamiento); su valor es documentar la forma esperada para conectores futuros.
- **`VCenterConnector`** — implementación concreta que orquesta las llamadas al cliente HTTP en una lista de `DiscoveredVM[]` normalizados (p. ej. normaliza `power_state` desconocidos a `POWERED_OFF` en lugar de lanzar error).
- **`VCenterClient`** — la única capa que habla HTTP. Usa el módulo **`https` nativo de Node** (no `undici`, que no es una dependencia de este proyecto — desviación respecto al plan original, ver `docs/PLAN_v3.5.3.md`). Gestiona la sesión vCenter (`POST /api/session`, header `vmware-api-session-id`), TLS self-signed opcional vía un `https.Agent` propio, y nunca registra credenciales en logs. Un 404 en `guest/identity` se trata como caso normal (VMware Tools no está corriendo en la VM), no como error.
- **`VCenterMapper`** — función **pura** `toCI(vm, defaults)`, sin I/O, que traduce una VM descubierta a los payloads de creación/actualización de CI. Es la pieza con más valor de test unitario del módulo (casos: apagada, suspendida, IP de guest ausente, `guest_OS` desconocido/vacío, redondeo MiB→GB).
- **`vcenterConfig.ts`** — lee y valida las variables `VCENTER_*`, expone `isConfigured()`/`toPublicConfig()` (esta última nunca incluye usuario/contraseña, verificado con `Object.keys`, no solo comprobaciones "falsy").
- **`vcenterService.ts`** (`runVCenterSync()`) — orquesta el ciclo completo: lock en proceso → conectar → descubrir → crear/actualizar/retirar CIs → auditar. Ver el algoritmo completo en `docs/PLAN_v3.5.3.md` § "Sync algorithm".

### Flujo de una sincronización

```
n8n (cron VCENTER_SYNC_CRON)  ──POST──▶ /api/internal/vcenter/sync  (X-CMDB-Service-Token)
UI "Sincronizar ahora" (ADMIN) ──POST──▶ /api/integrations/vcenter/sync (JWT)
                                            │
                                            ▼
                                    runVCenterSync()
                                            │
                     ┌──────────────────────┼───────────────────────┐
                     ▼                      ▼                       ▼
            VCenterConnector.connect()  discover() → VMs   VCenterMapper.toCI(vm)
                     │                                              │
                     └──────────────► Prisma upsert CI ◄────────────┘
                                            │
                                   audit_logs (SYNC_VCENTER)
                                            │
                              queueForIndexing (RAG re-index)
```

---

## 2. Cómo añadir un futuro conector

> **Nota:** esta no es una extensibilidad hipotética. El parque de virtualización real de este proyecto incluye, además de vCenter, **OLVM (Oracle Linux Virtualization Manager)** y **zonas Solaris** — ambos son candidatos directos para el siguiente conector siguiendo exactamente esta receta.

El objetivo del patrón es que un conector nuevo (p. ej. **OLVM** o **zonas Solaris**) se pueda añadir sin tocar el core de sincronización ni el router existente:

1. Crear `connectors/<sistema>/<Sistema>Client.ts` — capa HTTP/API propia del sistema externo. Nunca loguear credenciales; nunca aceptar una URL suministrada por el llamante (A10 SSRF — el host sale siempre de una env var operador-controlada).
2. Crear `connectors/<sistema>/<Sistema>Connector.ts` implementando `IHypervisorConnector` (`connect()`, `discover(): Promise<DiscoveredVM[]>`, `close()`). Si el nuevo sistema no encaja en la forma `DiscoveredVM` (pensada para VMs), generalizar el tipo en `connectors/types.ts` en vez de forzarlo.
3. Escribir un **mapper puro** `connectors/<sistema>/<Sistema>Mapper.ts` con `toCI(entity, defaults)` — sin I/O, cubierto por tests unitarios primero (TDD), igual que `VCenterMapper`.
4. Crear `<sistema>Config.ts` (env vars propias, con `toPublicConfig()` que nunca exponga secretos) y `<sistema>Service.ts` (`run<Sistema>Sync()`, reutilizando el mismo patrón de lock-en-proceso + auditoría en `audit_logs` que `vcenterService.ts` — no crear una tabla `sync_logs` nueva).
4b. **Sembrar su propia fila en la tabla maestra `Hypervisor`** (p. ej. `code='OLVM', isSystem=true`) vía su propia migración — **no** reutilizar ni añadir una nueva columna `vcenter_sync`-style JSONB por conector; ese proliferar de columnas ad-hoc es exactamente lo que el rediseño Tasks G1-G4 vino a eliminar. Resolver el `id` de esa fila **una vez por ejecución de sync** (no por VM) y usarlo para (a) asignar `CI.hypervisorId` solo en la creación de cada CI descubierto y (b) construir la valla de retiro del conector propio como **igualdad exacta** `hypervisorId === <id de la fila propia>` — nunca un chequeo de "no nulo", que dejaría de ser seguro en cuanto exista más de un conector activo.
5. Registrar rutas propias: una rama ADMIN/AUDITOR en `integrations/router.ts` (o un router hermano) y, si el nuevo conector necesita ejecución programada, una ruta interna M2M en `backend/src/modules/internal/` protegida por `X-CMDB-Service-Token`.
6. Si necesita programación periódica, añadir una plantilla de workflow en `n8n-provisioning/templates/` siguiendo `vcenter-sync.ts` como referencia, y una nueva clave `ActivateWhen` en `n8n-provisioning/config.ts`/`workflows.ts`.
7. Añadir la tarjeta de estado correspondiente en `frontend/app/settings/components/` reutilizando el patrón de `VCenterCard.tsx` + `SyncLogTable.tsx` + hooks (`useXStatus`, `useXTest`, `useSyncNow`, `useSyncLog`).

**Ningún paso anterior requiere modificar `VCenterClient`, `VCenterMapper`, `VCenterConnector` o `vcenterService.ts`** — el core del conector vCenter queda intacto al añadir un conector nuevo.

---

## 3. Referencia de variables de entorno

| Var | Default | Explicación |
|-----|---------|-------------|
| `VCENTER_URL` | *(vacío)* | URL base de vCenter, p. ej. `https://vcenter.local`. Vacío ⇒ conector deshabilitado (`isConfigured()` devuelve `false`, `/status` lo refleja, `/test` y `/sync` devuelven `409 VCENTER_NOT_CONFIGURED`). |
| `VCENTER_USER` | *(vacío)* | Usuario de vCenter usado para crear la sesión (`POST /api/session`, Basic auth). |
| `VCENTER_PASSWORD` | *(vacío)* | Contraseña de vCenter. **Nunca se registra en logs ni se devuelve en ninguna respuesta de API** (`toPublicConfig()` la excluye por completo). |
| `VCENTER_SSL_VERIFY` | `false` | `true` fuerza validación de certificado TLS estándar. `false` acepta certificados self-signed (ver [§5](#5-riesgo-de-certificado-self-signed)). |
| `VCENTER_CA_CERT` | *(vacío)* | Ruta opcional a un PEM de CA dentro del contenedor backend, para validar correctamente un certificado self-signed en lugar de desactivar la verificación. |
| `VCENTER_SYNC_ENABLED` | `false` | Puerta maestra: además de la configuración básica, gobierna si se aprovisiona/activa el workflow n8n programado y si los endpoints `/sync` responden (si es `false`, devuelven `409 VCENTER_SYNC_DISABLED`). |
| `VCENTER_CI_TYPE` | `VIRTUAL_SERVER` | Código de `CIType` destino para las VMs descubiertas (ya sembrado en el catálogo, `isSystem=true`). |
| `VCENTER_DEFAULT_ENVIRONMENT` | `PRODUCTION` | Valor de `environment` asignado a los CIs **solo en la creación** — vCenter no aporta este dato de gobernanza (D5). |
| `VCENTER_DEFAULT_CRITICALITY` | `MEDIUM` | Valor de `criticality` asignado a los CIs **solo en la creación** (mismo motivo que arriba). |
| `VCENTER_SYNC_CRON` | `0 */6 * * *` | Expresión cron usada por el workflow n8n `"vCenter Sync"` (cada 6 horas por defecto). |

Todas son **opcionales** — el conector viene desactivado de fábrica y no requiere ninguna acción para instalaciones que no usan vCenter. Reutiliza además `CMDB_SERVICE_TOKEN` (auth M2M n8n→backend) y `N8N_INTERNAL_URL`, ya existentes desde v3.0.0/v3.2.0.

**Red Hat Lightspeed (v3.7.0)** — ver [§9.13](#913-tercera-fuente-red-hat-lightspeed-live-pull-en-vez-de-subida-de-fichero) para el detalle completo:

| Var | Default | Explicación |
|-----|---------|-------------|
| `REDHAT_LIGHTSPEED_CLIENT_ID` | *(vacío)* | Client ID de la cuenta de servicio de Red Hat (console.redhat.com → Identity & Access Management → Service Accounts). Vacío ⇒ conector deshabilitado, `/redhat-lightspeed/status` lo refleja y el botón "Importar" queda desactivado en la UI. |
| `REDHAT_LIGHTSPEED_CLIENT_SECRET` | *(vacío)* | Client secret de la misma cuenta de servicio. **Nunca se registra en logs ni se devuelve en ninguna respuesta de API.** |
| `REDHAT_LIGHTSPEED_BASE_URL` | `https://console.redhat.com` | Host de las APIs de Insights Vulnerability + Inventory. No suele necesitar cambiarse. |

---

## 4. Decisiones de diseño D1–D5

Resumen operativo — el detalle y la justificación completa están en `docs/PLAN_v3.5.3.md` § "Design Decisions".

| # | Decisión |
|---|----------|
| **D1** | Credenciales y configuración **solo por variables de entorno**. Sin tabla `integration_configs` nueva, sin módulo de cifrado AES en BD — sigue el patrón ya usado por LDAP/SMTP/n8n en este proyecto. El panel de UI es solo estado + Probar + Sincronizar (sin formulario de credenciales). |
| **D2** | La sincronización **nunca sobrescribe** el campo de gobernanza `status` de un CI tras su creación. Las VMs nuevas se crean `ACTIVO`; el estado de ciclo de vida queda bajo control del operador a partir de ahí. El estado real de encendido se guarda en la columna escalar **`CI.powerState`**, refrescada en cada sync. Una VM ausente de vCenter provoca `status = RETIRADO`. |
| **D3** | El workflow n8n se distribuye como **plantilla de código** (`n8n-provisioning/templates/vcenter-sync.ts`), auto-aprovisionada al arrancar el backend y desde el botón "Resincronizar" de Configuración — el patrón canónico desde v3.2.0 (`.env` como única fuente de verdad), no un JSON importable manualmente. |
| **D4** | El historial de sincronizaciones se guarda en `audit_logs` (`action='SYNC_VCENTER'`), exactamente como ya hacen las integraciones Greenbone/CrowdStrike — sin tabla `sync_logs` nueva. El esquema relacional gana dos columnas en `configuration_items`: **`hypervisor_id`** (FK a la nueva tabla maestra `Hypervisor`, marcador de propiedad/clasificación) y **`power_state`** (columna escalar, hecho físico refrescado en cada sync). Ver [rediseño Tasks G1-G4](#modelo-de-propiedad-tras-el-rediseño-hypervisor-tasks-g1-g4) más abajo — sustituye a la columna aditiva `vcenter_sync jsonb` del diseño original. |
| **D5** | **vCenter posee los hechos físicos** (`vCpus`, `ram`, `adminIp`, `hostName`, `clusterName`, `operatingSystem`, `powerState`) y los refresca en cada sync. **El operador posee la gobernanza**: `status`, `criticality`, `environment`, `businessOwner`, `technicalLead` y cualquier campo NIS2/GDPR nunca se tocan después de la creación inicial. `hypervisorId` es un caso especial: se fija **solo en la creación** y nunca se refresca — no es un "hecho físico" que se repita cada sync, es el **marcador de clasificación/propiedad** del CI (ver más abajo). |

### Modelo de propiedad tras el rediseño Hypervisor (Tasks G1-G4)

Tras el diseño original (Tasks A-F, columna `CI.vcenterSync jsonb`), el usuario planteó una pregunta clave: dado que este entorno real corre **VMware vCenter, Oracle OLVM y zonas Solaris** a la vez, ¿cómo garantiza el diseño que la sincronización de vCenter nunca toque una VM que pertenece a otro hipervisor? Un simple `vcenter_sync IS NOT NULL` deja de ser una valla segura en cuanto existe un segundo conector, porque *cualquier* conector rellenaría esa misma columna.

La respuesta (commits `9edba06`/`d290356`/`112789b`/`eaa0a11`) introduce una tabla maestra **`Hypervisor`** (`code`/`name`/`isSystem`, como `CIType`/`OperatingSystem`), sembrada con una fila `code='VMWARE', isSystem=true`, y sustituye `CI.vcenterSync` por dos columnas:

- **`CI.hypervisorId`** (FK a `Hypervisor`) — se asigna **solo al crear** el CI y nunca se toca en updates posteriores. Es el marcador de propiedad/clasificación.
- **`CI.powerState`** (columna escalar) — el hecho físico de encendido, refrescado en cada sync (sustituye a `vcenter_sync.powerState`).

**La regla de propiedad ahora es: un CI es propiedad de vCenter si y solo si `hypervisorId` es exactamente igual al id de la fila `Hypervisor` de VMware — no simplemente "no nulo".** Esto es lo que hace segura la valla de retiro (`retire fence`) en un futuro con múltiples hipervisores: un futuro conector OLVM sembraría su propia fila (`code='OLVM'`) y asignaría su propio `hypervisorId` a las VMs que descubre; esas VMs también tendrían `hypervisorId` no nulo, así que un chequeo de "no nulo" haría que el conector vCenter intentara retirar (o el conector OLVM intentara tocar) VMs que no le pertenecen. La igualdad exacta contra el id concreto del hipervisor propio es la única valla correcta en ese escenario.

Además, `hypervisorId` es ahora **obligatorio** (validado en servidor y cliente) al crear/editar cualquier CI de tipo `VIRTUAL_SERVER` — se muestra como un desplegable "Hipervisor" en `AddCIModal`/`EditCIModal`, poblado desde `/api/masters/hypervisors`. `cluster`/`lastSyncAt` por VM siguen sin capturarse (simplificación aceptada: `cluster` no se resuelve — gap documentado en el plan original; `lastSyncAt` es redundante con `CI.updatedAt`). **`esxiHost` sí se resuelve** (Task H2, mecanismo reescrito y verificado contra un vCenter real 8.x): como esta versión de vCenter **no** expone el host en el summary/detalle de la VM, se resuelve por **mapeo inverso** — `VCenterClient.listHosts()` (`GET /api/vcenter/host` → MoRef+nombre) y, por cada host, `VCenterClient.listVmIdsOnHost()` (`GET /api/vcenter/vm?hosts={host}`) para construir el mapa VM→nombre-de-host en `VCenterConnector.buildEsxiHostMap()`. Cuando existe exactamente un CI `PHYSICAL_SERVER` cuyo `name`/`hostName` coincide (case-insensitive) con ese host, se crea una relación `HOSTS` idempotente hacia él en `vcenterService.ts`. Todo best-effort: cualquier fallo (listado de hosts, o de VMs de un host) degrada a `esxiHost: null`/sin relación, nunca aborta el sync. (El intento inicial vía `VM.Summary.host`/`Host.Info` no funcionó contra el vCenter real — ese campo no existe en esta versión — y fue sustituido por el mapeo inverso.) Si DRS migra una VM a otro host ESXi entre sincronizaciones, la relación `HOSTS` obsoleta al host anterior se **elimina** en la siguiente sincro (reconciliación en `vcenterService.ts`): sólo se ejecuta cuando el host actual se resuelve sin ambigüedad (exactamente un `PHYSICAL_SERVER`), nunca borra sobre una resolución nula/ambigua, y cada borrado deja un registro de auditoría `DELETE_RELATION`.

### Excepción de adopción — Task H1

El párrafo D5 anterior describe `hypervisorId` como estrictamente "solo en la creación". Existe una única excepción, introducida por la Task H1 (`24cef18`): cuando una VM descubierta no matchea ningún CI por `apiSlug` pero existe exactamente un CI **sin clasificar** (`hypervisorId IS NULL`) cuyo `name` coincide (case-insensitive) con el nombre de la VM, ese CI se **adopta** — es decir, se le fija `apiSlug = vm-{moref}` y `hypervisorId` al id del hipervisor VMware, por única vez, además de los campos físicos normales. Esto reconoce en el primer sync los CIs `VIRTUAL_SERVER` introducidos manualmente antes de que existiera este conector, evitando crear duplicados. La valla de seguridad es la misma que ya protege la valla de retiro (Tasks G1-G4): un CI ya clasificado por **cualquier** hipervisor (este u otro futuro, p. ej. OLVM) nunca es candidato — el filtro `hypervisorId: null` a nivel de BD lo excluye siempre. Cero o dos-o-más candidatos por nombre hacen caer el flujo al camino normal de creación de un CI nuevo; nunca se adivina a qué registro fusionar.

---

## 5. Riesgo de certificado self-signed

La mayoría de instalaciones de vCenter en entornos internos usan un certificado TLS **self-signed** (o firmado por una CA corporativa no presente en el almacén de confianza del sistema operativo del contenedor backend).

- **`VCENTER_SSL_VERIFY=false`** (valor por defecto) desactiva la validación estándar de certificado para las llamadas HTTPS hacia `VCENTER_URL` — es una **decisión consciente** para no bloquear la integración en el caso más común (vCenter interno, sin CA pública), documentada aquí explícitamente como tal. El tráfico sigue siendo TLS (cifrado en tránsito); lo que se renuncia es a la verificación de identidad del servidor, lo que abre una ventana teórica a un ataque man-in-the-middle **dentro de la red interna** donde vive el backend.
- **Alternativa recomendada**: usar **`VCENTER_CA_CERT`** apuntando a un fichero PEM (montado o copiado dentro del contenedor backend) con el certificado de la CA que firmó el certificado de vCenter. Con esta variable rellena, `VCenterClient` puede validar correctamente el certificado sin desactivar la verificación global — es la opción a preferir en cualquier entorno donde la CA interna esté disponible.
- **Nunca** se debe apuntar `VCENTER_URL` a un endpoint expuesto a Internet sin resolver primero la verificación de certificado (A02 — Cryptographic Failures).

---

## 6. Endpoints

| Método | Ruta | Auth | Propósito |
|---|---|---|---|
| `GET` | `/api/integrations/vcenter/status` | JWT, `requireAudit` (ADMIN o AUDITOR) | Config del conector sin secretos (`toPublicConfig()`) + info de la última sincronización desde `audit_logs`. Nunca expone usuario/contraseña. |
| `POST` | `/api/integrations/vcenter/test` | JWT, `requireAdmin` | Verifica conectividad/credenciales contra vCenter (crea y cierra una sesión) sin ejecutar una sincronización completa ni tocar CIs. |
| `POST` | `/api/integrations/vcenter/sync` | JWT, `requireAdmin` | Lanza una sincronización manual completa (botón "Sincronizar ahora" en Configuración). Devuelve `SyncResult` (`created`/`updated`/`retired`/`errors`). `409 VCENTER_NOT_CONFIGURED` / `409 VCENTER_SYNC_DISABLED` / `409 SYNC_IN_PROGRESS` según el caso. Desde la Task H2, cada VM sincronizada también intenta crear, best-effort, una relación `HOSTS` hacia el CI `PHYSICAL_SERVER` que coincide con su `esxiHost` (si hay exactamente uno) — no forma parte del `SyncResult` agregado, es una operación de enriquecimiento aislada por VM. Además, si la VM cambió de host ESXi (DRS), la relación `HOSTS` anterior se elimina en la misma pasada (reconciliación, auditada como `DELETE_RELATION`). |
| `GET` | `/api/integrations/vcenter/sync-log` | JWT, `requireAudit` (ADMIN o AUDITOR) | Últimas 20 ejecuciones de sincronización, leídas de `audit_logs` (`action='SYNC_VCENTER'`). |
| `POST` | `/api/internal/vcenter/sync` | `X-CMDB-Service-Token` (M2M, `timingSafeEqual`) | Ruta gemela de `POST /api/integrations/vcenter/sync`, invocada por el workflow n8n programado en lugar de un JWT de usuario. Misma lógica (`runVCenterSync()`), mismos códigos `409`. |
| `GET` | `/api/masters/hypervisors` | JWT, cualquier usuario autenticado | Lista de hipervisores maestros (`code`/`name`/`isSystem`) — usada para poblar el desplegable "Hipervisor" en `AddCIModal`/`EditCIModal`. |
| `POST` | `/api/masters/hypervisors` | JWT, `requireAdmin` | Crea un hipervisor maestro nuevo (p. ej. `code='OLVM'`). |
| `PATCH` | `/api/masters/hypervisors/:id` | JWT, `requireAdmin` | Edita un hipervisor maestro. `409` si `isSystem=true` (la fila `VMWARE` sembrada no se puede editar). |
| `DELETE` | `/api/masters/hypervisors/:id` | JWT, `requireAdmin` | Elimina un hipervisor maestro. `409` si `isSystem=true`. |

---

## 7. Prueba manual contra un vCenter real

No existe un vCenter real disponible en CI, por lo que la ruta feliz (sesión + descubrimiento + creación de CIs) debe verificarse manualmente contra una instancia real o un vCenter de laboratorio.

1. **Rellenar las variables** en el `.env` del backend (ver [§3](#3-referencia-de-variables-de-entorno)):
   ```bash
   VCENTER_URL=https://vcenter.midominio.local
   VCENTER_USER=svc_cmdb@vsphere.local
   VCENTER_PASSWORD=********
   VCENTER_SSL_VERIFY=false   # o true + VCENTER_CA_CERT si tienes la CA
   VCENTER_SYNC_ENABLED=true
   ```
2. **Reconstruir y levantar** los contenedores (patrón ya documentado en este proyecto):
   ```bash
   sg docker -c "docker compose down && docker compose up -d --build"
   ```
3. **Iniciar sesión** con la cuenta de pruebas del proyecto (ver la sección "Testing Credentials" de `CLAUDE.md`) y obtener un token:
   ```bash
   TOKEN=$(curl -sk -X POST https://localhost/api/auth/login \
     -H 'Content-Type: application/json' \
     -d '{"email":"claude@cmdb.local","password":"Claude@Test24!"}' \
     | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")
   ```
   > `claude@cmdb.local` es rol `AUDITOR` — puede leer `/status` y `/sync-log`, pero **no** puede ejecutar `/test` ni `/sync` (`requireAdmin`). Para probar esos dos endpoints, usa la cuenta ADMIN temporal descrita en `CLAUDE.md` § "Testing ADMIN-only flows".
4. **Probar la conexión** (no modifica el inventario):
   ```bash
   curl -sk -X POST https://localhost/api/integrations/vcenter/test \
     -H "Authorization: Bearer $TOKEN"
   ```
   Respuesta esperada: `{ "ok": true, "message": "..." }`. Si `VCENTER_NOT_CONFIGURED`, revisa el paso 1; si el error es TLS, revisa `VCENTER_SSL_VERIFY`/`VCENTER_CA_CERT`.
5. **Lanzar una sincronización**:
   ```bash
   curl -sk -X POST https://localhost/api/integrations/vcenter/sync \
     -H "Authorization: Bearer $TOKEN"
   ```
   Respuesta esperada: `{ "status": "SUCCESS", "created": N, "updated": N, "retired": N, "errors": [] }`.
6. **Verificar los CIs creados** en `/inventory`, filtrando por tipo **"Servidor Virtual"** — deben aparecer las VMs descubiertas, con `vCpus`/`ram`/`adminIp`/`hostName` poblados, `status = ACTIVO`, `hypervisorId` apuntando a la fila `VMWARE` sembrada y `powerState` reflejando el estado real de encendido. (Nota: crear o editar manualmente un CI `VIRTUAL_SERVER` desde la UI ahora exige seleccionar un **Hipervisor** en el desplegable de `AddCIModal`/`EditCIModal` — es un campo obligatorio desde el rediseño Tasks G1-G4.)
7. **Repetir el paso 5** una segunda vez y confirmar que las VMs ya existentes se reportan en `updated` (no se duplican), que `status` no cambia si se había modificado manualmente entre medias (D2), y que `hypervisorId` tampoco cambia (solo se asigna en la creación).
8. (Opcional) Apagar/eliminar una VM de prueba en vCenter y volver a sincronizar — el CI correspondiente debe pasar a `status = RETIRADO` sin ser eliminado de la base de datos.


---

## 8. LDAP / Active Directory — grupo de acceso y sincronización de usuarios (v3.5.10)

A diferencia de los conectores de las secciones anteriores, que traen **elementos de configuración** desde un sistema externo, esta integración gobierna **quién puede entrar** en la aplicación. Por eso no sigue el patrón `BaseConnector`: vive en `services/ldapDirectory.ts` (consultas al directorio) y `modules/integrations/ldapSyncService.ts` (sincronización).

### 8.1 Puerta de grupo en el login

Con `LDAP_REQUIRED_GROUP` configurado, un usuario solo puede iniciar sesión vía LDAP si pertenece a ese grupo de seguridad de AD. La comprobación ocurre **después** del bind correcto, con el `sAMAccountName` autoritativo ya resuelto, y **antes** de crear o rehabilitar cualquier fila local: quien no tiene derecho de acceso no llega a existir en la aplicación.

| Situación | Respuesta | Efecto secundario |
|---|---|---|
| `LDAP_REQUIRED_GROUP` vacío | Login normal | Ninguno — comportamiento anterior a v3.5.10 |
| Pertenece al grupo | Login normal | Se refresca `display_name` |
| No pertenece | `401 Invalid credentials` | `active = false` + `AuditLog LDAP_GROUP_DENIED`, en una transacción |
| No se puede verificar | `401 Invalid credentials` | Ninguno; log `LDAP_GROUP_CHECK_UNAVAILABLE` |

Dos decisiones que conviene entender antes de tocar este código:

- **El 401 de "no pertenece" es idéntico al de credenciales erróneas.** Distinguirlos permitiría a un atacante enumerar qué cuentas existen en el directorio.
- **Si la pertenencia no se puede comprobar, no se entra** (falta `LDAP_BIND_DN`, el directorio no responde, el grupo no se resuelve). Degradar a "permitir" convertiría una caída parcial del directorio en una desactivación silenciosa de la política de acceso. Las cuentas locales (`@cmdb.local` / `@cmdb.internal`) no pasan por esta puerta, así que un directorio caído nunca deja al administrador fuera del sistema.

La pertenencia se resuelve **anidada** por defecto, con `memberOf:1.2.840.113556.1.4.1941:` (`LDAP_MATCHING_RULE_IN_CHAIN`), porque en AD corporativo el grupo de acceso suele contener otros grupos. `LDAP_GROUP_NESTED=false` exige pertenencia directa.

### 8.2 Sincronización de usuarios

Una única función, `runLdapGroupSync()`, alimenta las dos entradas —el botón de Configuración → Integraciones y el workflow diario de n8n— precisamente para que la regla no pueda divergir entre ambas.

Qué hace con cada miembro del grupo:

| Situación | Acción |
|---|---|
| En el grupo, sin fila local | **Alta** con `LDAP_SYNC_DEFAULT_ROLE` y contraseña = bcrypt de 32 bytes aleatorios |
| En el grupo, con fila, datos distintos | **Actualiza** `email`, `username`, `display_name` |
| En el grupo, con fila inactiva | **Reactiva** |
| Ya no está en el grupo, o deshabilitado en AD | **Desactiva** (`active = false`) |
| Fila manual (`sso_external_id IS NULL`) | **Intocable** — excluida por cláusula de BD |

Invariantes:

- **Nunca se hace `DELETE`.** Quien sale del grupo se desactiva, para que la auditoría conserve el histórico.
- **Nunca se reescribe el rol** de un usuario existente. AD posee la identidad; el operador posee la gobernanza — el mismo principio D5 del conector vCenter. Una promoción manual a `MANAGER` o `ADMIN` sobrevive a la pasada nocturna.
- Cada mutación va con su `AuditLog` en la misma transacción.
- Un fallo en una fila se acumula en `errors[]` y devuelve `207`; no aborta la pasada.
- Un lock en proceso impide que el botón y la pasada de n8n se solapen (`409 SYNC_IN_PROGRESS`).

### 8.3 Endpoints

| Ruta | Auth | Uso |
|---|---|---|
| `GET /api/integrations/ldap/status` | `requireAudit` | Estado de configuración |
| `POST /api/integrations/ldap/sync` | `requireAdmin` | Botón de la UI |
| `GET /api/integrations/ldap/sync-log` | `requireAudit` | Historial, leído de `audit_logs` |
| `POST /api/internal/ldap/sync` | `X-CMDB-Service-Token` | Disparo diario desde n8n |

Códigos: `200` correcto · `207` parcial con `errors[]` · `400 LDAP_GROUP_NOT_CONFIGURED` · `409 SYNC_IN_PROGRESS` · `502 LDAP_DIRECTORY_UNAVAILABLE`.

### 8.4 Workflow n8n

`LDAP Group Sync` — Schedule diario (por defecto 03:00, `LDAP_SYNC_CRON`) → `POST /api/internal/ldap/sync` → notificación si falla. Code-provisioned, como el resto. Se auto-activa solo si `USE_LDAP=true` **y** `LDAP_REQUIRED_GROUP` no está vacío.

Sustituye al workflow `LDAP/AD Sync`, que consultaba el directorio con un nodo LDAP y calculaba el diff en un nodo Code. Se retiró junto con los endpoints `/api/internal/users/ldap-sync*`: eran una segunda implementación de la misma regla de acceso, con capacidad de divergir de la del login.

### 8.5 Variables de entorno

| Variable | Por defecto | Significado |
|---|---|---|
| `LDAP_REQUIRED_GROUP` | *(vacío)* | CN o DN del grupo. Vacío ⇒ sin restricción |
| `LDAP_GROUP_NESTED` | `true` | `false` ⇒ `memberOf` directo |
| `LDAP_GROUP_SEARCH_BASE` | *(cae a `LDAP_SEARCH_BASE`)* | Base para buscar el grupo |
| `LDAP_SYNC_DEFAULT_ROLE` | `VIEWER` | Rol de alta; nunca se reaplica |
| `LDAP_SYNC_MAX_MEMBERS` | `5000` | Tope duro por pasada |
| `LDAP_SYNC_CRON` | `0 3 * * *` | Cadencia del workflow |

`LDAP_SYNC_GROUP_DN` y `LDAP_SYNC_DOMAIN` quedaron **obsoletas**: alimentaban el workflow retirado.

---

## 9. Importación de vulnerabilidades Greenbone — formato real y staging (v3.6.0)

> **Estado: en `develop`, sin tag ni merge a `main` todavía.** Esta sección documenta el módulo tal y como quedó implementado y verificado en vivo en esta rama; no confirma un release.

Rama: `backend/src/modules/vuln-import/` (`parser.ts`, `matcher.ts`, `classifier.ts`, `service.ts`, `queries.ts`, `audit.ts`, `schemas.ts`, `router.ts`), montado en `/api/vuln-import`. Frontend: `frontend/app/vulnerabilities/imports/` (listado) y `frontend/app/vulnerabilities/imports/[id]/` (revisión).

> **Actualización (misma rama, sin tag todavía):** el módulo ganó una segunda fuente — CrowdStrike Spotlight — sobre el mismo staging. Las secciones 9.1–9.11 de abajo describen el diseño original con Greenbone como única fuente; todo lo que dicen sigue siendo cierto, y sigue aplicando sin cambios a un informe Greenbone. La [§9.12](#912-segunda-fuente-crowdstrike-spotlight-mismo-staging-sin-tag-todavía) documenta específicamente lo que CrowdStrike Spotlight añade y en qué difiere.

### 9.1 Qué sustituye

El conector Greenbone original (`POST /api/integrations/greenbone`, sección "Conectores" de Integraciones) se construyó contra un formato **inventado**, no contra una exportación real de Greenbone/OpenVAS. Comparado directamente con una exportación real (`docs/mocks/greenbone_SRV-MYGESTR01D.json`), el mock antiguo (`docs/mocks/greenbone_sample_LEGACY_INVENTADO.json`, renombrado en este release — ver más abajo) **no comparte ni un solo campo** con el formato real: el importador leía `results[]`, mientras que Greenbone exporta `allHostSubreportEntries[].vulnerabilities[]`. El bug que motivó todo el rediseño: subir un informe real contra el importador antiguo "tenía éxito" en silencio con 0 vulnerabilidades procesadas, porque el campo que el código esperaba sencillamente no existía en el JSON.

Este módulo sustituye por completo la ingesta: parsea el formato real (`GreenboneReportSchema`, Zod, `.passthrough()` en los campos agregados que nunca se leen), rechaza explícitamente el formato antiguo con `400` en vez de "tener éxito" con 0 entradas, y — el cambio de fondo — **nunca escribe directamente sobre un CI**. Toda subida pasa primero por una cola de revisión (staging).

### 9.2 Modelo de identidad: `key = oid@port`, no `cve`

En una exportación real, solo **~4%** de los hallazgos llevan un CVE asociado (2 de 52 en el fixture real de prueba) — el resto son detecciones basadas en el NVT (Network Vulnerability Test) de Greenbone sin CVE público. Usar `cve` como identidad habría descartado o colisionado la inmensa mayoría de los hallazgos reales.

La identidad de una vulnerabilidad Greenbone es ahora:

```
key = "${oid}@${port}"
```

`oid` es el identificador único del NVT de Greenbone; `port` participa porque el mismo NVT puede dispararse en más de un puerto del mismo host. `cve` se conserva como **campo de visualización**, compatible hacia atrás: el primer CVE encontrado en el array `cve[]` del hallazgo, o cadena vacía si no hay ninguno — nunca se usa para identidad ni para deduplicar.

`PATCH /api/vulnerabilities` (el endpoint existente de cambio de estado de una vulnerabilidad) acepta ahora un campo opcional `key` y resuelve identidad como `key ?? cve`, para ser compatible tanto con entradas nuevas identificadas por `key` como con entradas legacy que solo tienen `cve`.

### 9.3 Cascada de emparejamiento de CI (5 niveles)

Igual que el conector vCenter (`matchHost()` en `matcher.ts`), la cascada prueba niveles en orden y **se detiene en el primer nivel que devuelve algún resultado** — nunca sigue a un nivel de menor confianza si el actual ya dio candidatos:

| # | Nivel | Contra qué compara | Confianza |
|---|-------|---------------------|-----------|
| 1 | IP exacta | `admin_ip` / `mgmt_ip` / `console_ip` | `EXACT_IP` |
| 2 | Nombre de CI exacto | `name` (case-insensitive) | `EXACT_NAME` |
| 3 | Hostname exacto | `host_name`, o `host_name` con el sufijo de dominio recortado (`SRV-X.azkar.com` → `SRV-X`) | `EXACT_HOSTNAME` |
| 4 | DNS exacto | columna `dns` (case-insensitive) | `EXACT_DNS` |
| 5 | Nombre parcial (fuzzy) | `LIKE '%name%'`, con `%`/`_`/`\` escapados | `FUZZY` |

Dos o más CIs distintos en el mismo nivel → **`AMBIGUOUS`** con la lista completa de candidatos; nunca se elige uno automáticamente. Esto corrige un antipatrón real del importador antiguo (`ORDER BY LENGTH(name) LIMIT 1` en `modules/integrations/router.ts`), que adivinaba en silencio cuál de varios CIs candidatos era el correcto. Ningún nivel devuelve nada → **`UNMATCHED`**.

Igual que en el conector vCenter, la consulta es un único `$queryRaw` con tagged template literals (UNION ALL de los 5 niveles) — nunca `$queryRawUnsafe` ni concatenación de strings; el patrón `LIKE` del nivel 5 se escapa con la misma función `escapeLike()` que ya usa el resto del proyecto.

### 9.4 Flujo de staging (nunca escritura directa)

Subir un informe Greenbone crea un **`VulnImportBatch`** (estado `PENDING`) con una **`VulnImportEntry`** por vulnerabilidad parseada — dos tablas Postgres nuevas, `vuln_import_batches` y `vuln_import_entries`. Ningún CI se modifica en esta fase.

```
POST /upload  →  parser.ts (valida formato)
              →  matcher.ts (cascada 5 niveles, por host)
              →  classifier.ts (NUEVA / EXISTENTE_PENDIENTE / REAPARECIDA, por entrada)
              →  VulnImportBatch (PENDING) + N × VulnImportEntry
```

Un operador revisa el lote en `/vulnerabilities/imports/:id` (frontend): puede reasignar el CI emparejado, cambiar la severidad, incluir/excluir hallazgos (individualmente o en bloque por pestaña), y ver la descripción/remediación completa en un panel expandible por entrada. Solo entonces:

- **`POST /batches/:id/accept`** — transaccional: escribe cada entrada `INCLUDE` en la columna `vulnerabilities` (JSON) del CI correspondiente **e** inserta el registro de auditoría `VULN_IMPORT_ACCEPT`, en una única `prisma.$transaction`. Bloquea con `422 UNRESOLVED_MATCHES` (listando las entradas concretas que bloquean) si queda alguna entrada `INCLUDE` sin CI resuelto (`UNMATCHED`/`AMBIGUOUS`). El batch pasa a `ACCEPTED`.
- **`POST /batches/:id/discard`** — no toca ningún CI; el batch pasa a `DISCARDED`.

Ambas transiciones son terminales: un batch `PENDING` solo puede pasar a `ACCEPTED` o `DISCARDED` una vez (`409 BATCH_NOT_PENDING` en cualquier intento posterior de editar/aceptar/descartar).

### 9.5 Clasificación contra lo ya almacenado en el CI

Cada vulnerabilidad entrante se compara contra lo que ya hay guardado en el CI emparejado (por `key`, o por `cve` para entradas legacy pre-migración):

| Clasificación | Cuándo | Decisión por defecto |
|---|---|---|
| **NUEVA** | No existe ninguna entrada con esa identidad en el CI | `INCLUDE` solo si severidad ≥ `MEDIUM`; si no, `EXCLUDE` |
| **EXISTENTE_PENDIENTE** | Existe y su estado sigue abierto (`NUEVO`/`ASIGNADO`/`EN_CURSO`/`PARADO`) | `EXCLUDE` — nunca se reimporta lo que ya está en curso |
| **REAPARECIDA** | Existe y su estado era `RESUELTO` | `INCLUDE` — siempre, con independencia de la severidad |

El umbral de severidad para `NUEVA` (`MEDIUM`+) es una constante de módulo (`classifier.ts`), no configurable por variable de entorno. `REAPARECIDA` se pre-marca siempre para inclusión sin importar la severidad: una vulnerabilidad que reaparece tras haberse dado por resuelta es exactamente la señal que un operador necesita ver, con independencia de si es `LOW` o `CRITICAL`.

### 9.6 Estado `REABIERTA` y el escaneo de alertas existente

Al aceptar un batch, una entrada `REAPARECIDA` transiciona el estado almacenado de `RESUELTO` a un estado nuevo: **`REABIERTA`**. El `resolvedAt` previo se conserva (no se borra) y se fija un `reopenedAt` nuevo — la vulnerabilidad conserva su historial de cuándo se dio por resuelta la primera vez, además de cuándo volvió a aparecer.

`REABIERTA` cuenta como **abierta** en todos los sitios donde open-vs-resolved importa, incluido el escaneo existente de alertas de vulnerabilidades (`backend/src/modules/alerts/engine.ts`, lista `open` en la línea ~161). Deliberadamente **no** se creó un mecanismo de alerta nuevo para "reaparición": basta con que `REABIERTA` sea un estado abierto más para que el motor de alertas ya existente (CRITICAL/HIGH abiertos) la recoja sin cambios adicionales — la misma filosofía D4 del conector vCenter (reusar `audit_logs` en vez de una tabla `sync_logs` nueva) aplicada aquí a "reusar el motor de alertas en vez de un mecanismo paralelo".

También se añade la banda de severidad **`INFO`** (CVSS 0.0), inexistente hasta ahora, para las detecciones Greenbone de severidad nula.

### 9.7 Endpoints

| Método | Ruta | Auth | Propósito |
|---|---|---|---|
| `POST` | `/api/vuln-import/upload` | JWT, `requireAdmin` | Sube un informe Greenbone real (`allHostSubreportEntries[]`), crea el batch `PENDING` con sus entradas clasificadas. `400` si el body tiene forma del mock antiguo (`results[]`) u otro formato no reconocido. |
| `GET` | `/api/vuln-import/batches` | JWT, `requireAudit` | Lista paginada de batches, filtrable por `status`. |
| `GET` | `/api/vuln-import/batches/:id` | JWT, `requireAudit` | Detalle de un batch con sus entradas, filtrable por `classification`/`severity`/`decision`. |
| `PATCH` | `/api/vuln-import/batches/:id/entries/:entryId` | JWT, `requireAdmin` | Corrige una entrada: reasignar `ciId`, cambiar `severity`, cambiar `decision` (`INCLUDE`/`EXCLUDE`). Solo sobre batches `PENDING`. |
| `POST` | `/api/vuln-import/batches/:id/entries/bulk-decision` | JWT, `requireAdmin` | Include/exclude en bloque sobre un filtro (`classification`/`severity`/`decision`). |
| `POST` | `/api/vuln-import/batches/:id/accept` | JWT, `requireAdmin` | Acepta el batch: escritura transaccional en los CIs afectados + `VULN_IMPORT_ACCEPT` en `audit_logs`. `422 UNRESOLVED_MATCHES` si queda algún `INCLUDE` sin CI resuelto. |
| `POST` | `/api/vuln-import/batches/:id/discard` | JWT, `requireAdmin` | Descarta el batch sin tocar ningún CI. |

El body de `POST /upload` está limitado a **20 MB** (frente al límite global de 2 MB de la aplicación) mediante un `express.json({limit:'20mb'})` de ámbito de ruta, montado en `index.ts` **antes** del parser global de 2 MB — Express despacha el middleware con coincidencia de ruta en orden de registro, así que un parser de ruta más específico registrado después del global nunca llegaría a tiempo.

### 9.8 Compatibilidad hacia atrás

- **`POST /api/integrations/greenbone` (legacy)** sigue existiendo, para cualquier llamador externo que ya lo use, pero ahora es un **shim delgado** que delega en la misma lógica de staging: crea un batch y devuelve `{message, batchId, summary}` en vez de escribir directamente. Un body con la forma del mock antiguo (`{results: [...]}`) devuelve ahora `400` con un mensaje claro, en vez del "éxito" silencioso con 0 vulnerabilidades que motivó este rediseño.
- **`PATCH /api/vulnerabilities`** resuelve identidad como `key ?? cve` (ver [§9.2](#92-modelo-de-identidad-key--oidport-no-cve)), compatible con entradas nuevas y legacy a la vez.
- **`backend/scripts/backfill-vuln-keys.js`** — script idempotente que rellena `key = cve` en cualquier entrada de vulnerabilidad almacenada anterior a este release y que aún no tiene `key`. Soporta `--dry-run`. Ver `docs/SYSADMIN_MANUAL.md` para el procedimiento de ejecución.

### 9.9 Bug real encontrado y corregido durante la verificación en vivo

`audit_logs.entity_id` es `varchar(36)` (dimensionado para un UUID desnudo). El insert de auditoría de `PATCH /api/vulnerabilities` construía, sin embargo, un string compuesto `${ciId}:${key}` que desborda esa columna para cualquier `key`/`cve` real — Postgres rechazaba el insert (error `22001`, "value too long for type character varying") y la petición entera devolvía `500`.

Este bug **es anterior a v3.6.0** (existe desde el commit de #172 que envolvió esta escritura en una transacción) pero nunca se disparó en producción porque ningún CI tenía datos reales de vulnerabilidades hasta que este módulo empezó a escribirlos. Corregido: `entity_id` ahora contiene solo el `ciId` desnudo; la identidad de la vulnerabilidad se movió a la columna `details` (jsonb, sin límite de tamaño), que ya existía en `AuditLog` para este propósito.

El test unitario dedicado a este endpoint (`backend/src/__tests__/vulnPatchIdentity.test.ts`) reafirmaba la forma antigua y defectuosa (string compuesto) contra un mock aislado, en vez de ejercitar Postgres real — la brecha ya documentada en este proyecto ("ningún test de este repo toca Postgres real, todo mockea `$executeRaw`") es exactamente lo que dejó pasar este bug sin detectar hasta la verificación en vivo contra la base de datos real.

### 9.10 Verificación en vivo

Verificado contra producción con la exportación real de Greenbone `docs/mocks/greenbone_SRV-MYGESTR01D.json` (CI `SRV-MYGESTR01D`): CI emparejado por `admin_ip` con confianza `EXACT_IP` sin intervención manual; 52 vulnerabilidades parseadas sin ninguna colisión de `key`; una segunda subida del mismo fichero clasificó las 2 ya aceptadas como `EXISTENTE_PENDIENTE` sin duplicarlas; marcar una como `RESUELTO` y volver a subir el fichero produjo `REAPARECIDA`, y aceptarla transicionó a `REABIERTA` con `reopenedAt` fijado y un registro de auditoría `VULN_REOPENED`; un host con IP desconocida produjo `UNMATCHED` y `accept` bloqueó correctamente con `422 UNRESOLVED_MATCHES` nombrando las entradas concretas que bloqueaban.

### 9.11 Limitación conocida

`docs/mocks/greenbone_sample_LEGACY_INVENTADO.json` (el mock antiguo que originó este rediseño, renombrado en este release desde `greenbone_sample.json` precisamente para que nadie vuelva a diseñar contra él por error) sigue existiendo en el repositorio como referencia histórica de qué NO es el formato real. No se ha añadido un README propio a `docs/mocks/` — el sufijo `_LEGACY_INVENTADO` del nombre de fichero se consideró suficientemente autoexplicativo.

Además, los batches `PENDING` abandonados (nunca aceptados ni descartados) **no se purgan automáticamente todavía** — ver `docs/SYSADMIN_MANUAL.md` para el detalle de esta carencia conocida.

### 9.12 Segunda fuente: CrowdStrike Spotlight (mismo staging, sin tag todavía)

> **Estado: sobre la misma rama que la §9, sin tag ni merge a `main` todavía.** Esta subsección documenta trabajo de seguimiento (informalmente "v3.6.1") realizado sobre `feature/v3.6.0-greenbone-real-format` una vez cerrado lo descrito en 9.1–9.11.

**Contexto.** El conector CrowdStrike ya existente (`POST /api/integrations/crowdstrike`) ingiere estado de agente/EDR de Falcon (`{devices:[...]}` → `configuration_items.agent_status`) — funcionalidad real y sin tocar, que alimenta 4 filtros de Inventario, una insignia y un informe de seguridad. **CrowdStrike Spotlight es un producto distinto** dentro de la misma plataforma CrowdStrike: gestión de vulnerabilidades, no estado de agente. Contra una exportación real proporcionada por el usuario (`docs/mocks/crowdstrike_SRV-MYGESTR01D.json`, 841 registros para el CI `SRV-MYGESTR01D`) el formato resultó ser un array JSON plano en el nivel superior — de forma y dominio completamente distintos tanto del mock de agente/EDR como del formato Greenbone. En vez de construir un tercer módulo aislado, se generalizó el staging existente: `crowdstrikeParser.ts` produce el mismo `ParsedVulnEntry` que `parser.ts` ya produce para Greenbone, y todo lo demás del pipeline (matcher, classifier, service, router, UI de revisión) es compartido sin condicionales por fuente.

**Modelo de identidad: `vulnerability_id` solo, no `vulnerability_id + product`.** A diferencia de Greenbone (`key = oid@port`), CrowdStrike emite un registro por cada producto afectado de la misma vulnerabilidad — el fixture real trae 841 registros crudos que colapsan a **635** `vulnerability_id` distintos. Los registros que comparten un mismo ID se fusionan en una sola entrada:

- `products` — unión de producto/versión afectados de todo el grupo.
- `solution` — unión deduplicada de `recommended_remediations[].detail` de todo el grupo.
- estado — si **cualquier** registro del grupo tiene `status: "Reopened"`, la entrada fusionada queda `Reopened` ("gana Reopened" en caso de desacuerdo dentro del grupo).

`vulnerability_id` no siempre es un CVE: un registro real del fixture (`CS-V26-A757135`) no tiene `cve_id` en absoluto — es un identificador propio de CrowdStrike, sin CVE público asociado. Fusionar por `vulnerability_id + product` habría tratado cada producto afectado como una vulnerabilidad distinta, inflando el recuento y perdiendo la vista "¿está resuelta esta vulnerabilidad concreta en todos sus productos afectados?" que `vulnerability_id` solo sí da.

**Severidad CVSS vs. `exprtRating` — dos señales distintas, deliberadamente no fusionadas.** La severidad se deriva del `base_score` de CVSS (un string pegado tipo `"7.8 v3.x"`, parseado a número + `cvssVersion`), reutilizando **las mismas bandas** `scoreToSeverity` ya establecidas para Greenbone (0.0=INFO, 0.1-3.9=LOW, 4.0-6.9=MEDIUM, 7.0-8.9=HIGH, 9.0-10.0=CRITICAL) — un HIGH significa lo mismo con independencia de la fuente. CrowdStrike aporta además su **propia** valoración con IA (`exprtRating`, p. ej. "Critical"), que se almacena y se muestra como una señal **separada**, nunca mezclada con la severidad derivada de CVSS: en el fixture real, las dos discrepan en ~65% de los registros. Confundirlas habría ocultado exactamente los casos donde más importa la discrepancia.

**CISA KEV y explotación activa — premarcado forzado con independencia de la banda de severidad.** CrowdStrike Spotlight aporta dos señales que Greenbone no tiene: pertenencia al catálogo CISA KEV (`cisaKev` + `cisaDueDate`, un plazo de remediación oficial del gobierno de EE.UU. para explotación confirmada en el mundo real) y una etiqueta de probabilidad de explotación (`exploitStatus`). Ambas fuerzan inclusión premarcada en la pantalla de revisión **con independencia de la severidad** — una CVE de severidad LOW con explotación activa es más urgente que una HIGH puramente teórica. Los valores exactos de etiqueta que cuentan como "explotación activa" son una allowlist explícita (`ACTIVE_EXPLOITATION_LABELS` en `backend/src/modules/vuln-import/classifier.ts`): `"Actively used (critical)"` y `"Easily Accessible (high)"` cuentan; `"Unproven"` y `"Available (medium)"` no — una distinción deliberada, porque exploit "disponible" no es la misma afirmación que "usado activamente en el mundo real". Verificado contra la distribución completa del fixture real: 794 Unproven / 40 Available (medium) / 6 Actively used (critical) / 1 Easily Accessible (high).

**Nueva ruta de clasificación `REAPARECIDA`: la señal de reapertura del propio sistema externo.** La [§9.5](#95-clasificación-contra-lo-ya-almacenado-en-el-ci) documenta la única ruta original a `REAPARECIDA`: existe una entrada almacenada en el CI y su estado era `RESUELTO`. CrowdStrike añade una **segunda ruta, independiente**: si el `status` del registro entrante es `"Reopened"` (mapeado a `externalStatus`), la entrada se clasifica `REAPARECIDA` **aunque el CMDB no tenga ningún registro de esa vulnerabilidad todavía** — no solo cuando la copia propia del CMDB estaba previamente en `RESUELTO`. CrowdStrike solo informa `"Reopened"` de algo que él mismo ha visto cerrarse antes, así que la señal es suficiente por sí sola; en `classifier.ts` se comprueba **antes** que las ramas de "sin match" / `OPEN_STATUSES`, porque puede prevalecer sobre cualquiera de las dos (incluso sobre un estado propio todavía abierto como `NUEVO`/`ASIGNADO`/`EN_CURSO`/`PARADO`). Al aceptar, si una entrada clasificada `REAPARECIDA` por esta segunda ruta no tiene en realidad ninguna vulnerabilidad almacenada que reabrir (porque el CMDB nunca la había registrado — algo común con CrowdStrike, ya que los formatos de identidad de Greenbone y CrowdStrike son disjuntos y hoy no se cruzan entre sí), el flujo de aceptación cae a almacenarla como entrada nueva en vez de fallar.

**`cisaKev` con semántica sticky-true en el refresco de "reopen".** `cisaKev` es el único de los 8 campos nuevos de CrowdStrike que es un booleano no-nullable (sus 7 hermanos son todos nullable). En la ruta de refresco de una entrada ya almacenada que se reabre, se aplica `entry.cisaKev || existing.cisaKev` en vez de una sobrescritura directa — así una vulnerabilidad marcada alguna vez como CISA KEV nunca pierde esa marca de forma silenciosa por un refresco posterior que no la vuelva a traer (p. ej. si esa carga concreta ya no incluye el campo, o si el registro que ganó la fusión de un grupo no es el mismo que la trajo la vez anterior). Un dato de esta relevancia de seguridad no debe desaparecer sin más.

**`POST /api/integrations/crowdstrike` pasa a ser consciente del formato.** Este endpoint históricamente solo aceptaba la forma agente/EDR. Ahora autodetecta por estructura: un objeto con clave `devices` → el flujo agente/EDR **existente, sin cambios**; un array plano (opcionalmente envuelto en `{filename?, report}`) → enruta al **mismo** pipeline de staging que ya usa Greenbone (crea un batch `PENDING`, nunca escribe directamente sobre un CI); cualquier otra cosa → `400` nombrando explícitamente ambos formatos aceptados. El límite de 20 MB de cuerpo de petición (ya aplicado a `/api/vuln-import/upload` en v3.6.0, porque una exportación Greenbone real de un solo host puede superar el límite global de 2 MB) se aplica ahora **también** a `/api/integrations/crowdstrike` (una exportación Spotlight real de un solo host ronda los 686 KB — una exportación multi-host puede superarlo fácilmente), registrado en `index.ts` antes del parser global — la misma clase de bug histórico (un body parser de ámbito de ruta registrado en la posición relativa equivocada es un no-op silencioso, porque Express despacha middleware coincidente en orden de registro) evitada deliberadamente otra vez.

**Esquema.** `VulnImportEntry` gana 8 columnas nuevas, todas nullable (`products text[]`, `exprt_rating`, `cisa_kev boolean not null default false`, `cisa_due_date`, `exploit_status`, `days_open`, `external_status`, `cvss_version`) para las señales específicas de CrowdStrike; `oid` y `port` (identidad NVT-y-puerto, específica de Greenbone) pasan a ser nullable, ya que una entrada CrowdStrike no tiene ninguno de los dos. El JSON `Vulnerability` persistido en cada CI gana los mismos campos, todos opcionales, más un campo `source` que ahora varía de verdad (`'greenbone'` | `'crowdstrike'`) en vez de ser siempre `'greenbone'`.

**Interfaz.** El listado de lotes muestra una pequeña insignia de fuente (Greenbone/CrowdStrike) por fila. La pantalla de revisión muestra las insignias de CISA KEV y explotación activa **directamente en la fila colapsada** (no ocultas tras un clic de expandir — son las señales de mayor valor de estos datos y deben verse de un vistazo), con la insignia KEV mostrando el plazo de remediación cuando existe; el panel de detalle expandible gana `exprtRating` (distinguido visualmente de la pastilla de severidad CVSS para que no se lean como duplicados), `daysOpen`, la lista de `products` afectados y `cvssVersion`. La tarjeta de CrowdStrike de la página `/integrations` maneja ahora ambas formas de respuesta (staging vs. aplicación directa) exactamente igual que ya hacía la tarjeta de Greenbone, y su JSON de ejemplo se actualizó de la vieja forma de mock de agente a un fragmento mínimo real en formato Spotlight.

**Verificación en vivo contra producción** con el fixture real (`docs/mocks/crowdstrike_SRV-MYGESTR01D.json`): 841 registros crudos fusionados correctamente a 635 entradas; el CI emparejado por IP sin intervención manual; una CVE que abarca 3 productos afectados fusionada en una sola entrada; el ID propio de CrowdStrike sin CVE importado correctamente con lista de CVE vacía; 3 vulnerabilidades CISA KEV reales premarcadas correctamente; 28 vulnerabilidades de estado `Reopened` distintas clasificadas correctamente `REAPARECIDA` incluso sin registro previo en el CMDB (incluido el caso límite "sin match en absoluto + Reopened"); volver a subir el mismo fichero no produjo duplicados; el formato legacy de agente/EDR sigue funcionando sin cambios a través del mismo endpoint; un formato de cuerpo no reconocido se rechaza con `400` nombrando ambas formas aceptadas.

**Fix de UX de la pantalla de revisión, independiente de CrowdStrike.** El control de inclusión/exclusión por entrada era un botón de verbo imperativo ("Excluir"/"Incluir") que mostraba el estado ACTUAL pero se leía como una ORDEN — un usuario viendo "Excluir" en una entrada ya excluida podía razonablemente (pero incorrectamente) concluir que tenía que pulsarlo para excluirla. **El comportamiento del clasificador subyacente se verificó de forma independiente como correcto** contra datos reales de producción (las vulnerabilidades ya existentes/pendientes sí vienen excluidas por defecto) — solo cambió el texto del control de interfaz, ninguna lógica de backend. Ahora es una casilla con etiquetas orientadas al resultado ("Se importará"/"No se importará"), inequívocas sobre lo que hará realmente aceptar el lote. La etiqueta de VISUALIZACIÓN de la clasificación `EXISTENTE_PENDIENTE` (no su valor/clave subyacente, que no cambia) también se reformuló de un término técnico crudo a "Ya existe en este CI", con una explicación de apoyo de que no se reimportará, solo se refrescará.

**Limitación conocida.** La verificación visual en navegador de la UI nueva (insignias, indicador de fuente, casilla reformulada) no pudo realizarse en este entorno (sin Chrome instalable, sin sudo — la misma limitación ya documentada para v3.6.0 y para v3.5.12) — todas las afirmaciones de interfaz de arriba se verificaron por revisión de código y pruebas de API en vivo, no mirando la pantalla renderizada.

### 9.13 Tercera fuente: Red Hat Lightspeed — live-pull en vez de subida de fichero

**Contexto.** Greenbone y CrowdStrike Spotlight son ambos conectores de "pega el JSON exportado" — el operador saca un informe de la consola de la herramienta y lo sube manualmente. Red Hat Lightspeed (Red Hat Insights) es distinto: es una **API REST en vivo** contra `console.redhat.com`, así que el botón "Importar" de la tarjeta nueva no acepta ningún fichero — llama directamente a tres APIs de Red Hat, construye el mismo lote de staging que producirían Greenbone/CrowdStrike, y redirige a la misma pantalla de revisión ya existente. Ninguna pieza del pipeline compartido (matcher, classifier, tabla `vuln_import_entries`, pantalla de revisión, transacción de aceptación) se duplicó — se extendió, siguiendo el mismo precedente que CrowdStrike Spotlight sentó en v3.6.1.

**Tres APIs de Red Hat, tres roles distintos:**
1. **Insights Vulnerability API** (`GET /api/vulnerability/v1/systems`, `GET /api/vulnerability/v1/systems/{id}/cves`) — la lista de sistemas RHEL visibles para la cuenta de servicio y, por sistema, cada CVE actualmente abierta (`cvss3_score`/`cvss2_score`, `impact`, `known_exploit`, `public_date`).
2. **Inventory API** (`GET /api/inventory/v1/hosts/{id}`, `.../system_profile`) — IP/FQDN para el emparejamiento de CI (misma cascada de 5 niveles de `matcher.ts`, sin cambios) y la versión RHEL exacta (`operating_system.major/minor`) para la corrección de SO.
3. **Product Life Cycle Data API** (`access.redhat.com/product-life-cycles/api/v1/products?name=Red Hat Enterprise Linux`) — **pública, sin autenticación** — fechas oficiales de fin de soporte/fin de vida por versión mayor de RHEL.

**Autenticación: cuenta de servicio OAuth2 `client_credentials`.** Red Hat retiró la autenticación básica de sus APIs de Hybrid Cloud Console; el mecanismo vigente es una cuenta de servicio creada en `console.redhat.com` → Identity & Access Management → Service Accounts, con permisos de lectura sobre vulnerabilidad e inventario. El backend intercambia `client_id`/`client_secret` por un token Bearer de corta vida en cada ejecución (`tokenClient.ts`, endpoint fijo `sso.redhat.com`, nunca derivado de `REDHAT_LIGHTSPEED_BASE_URL` — A10 SSRF) y no lo persiste nunca; el token vive solo en memoria durante esa importación.

**Modelo de identidad: la propia CVE, no un identificador de escáner.** A diferencia de Greenbone (`key = oid@port`) y CrowdStrike (`vulnerability_id`, no siempre un CVE), el modelo de datos de Red Hat es él mismo CVE-céntrico — el campo `synopsis` que devuelve la API **es** el identificador de CVE (p. ej. `CVE-2024-1234`), y ese es directamente el `vulnKey`/identidad usada por el resto del pipeline. No hace falta ninguna fusión de registros por producto como en CrowdStrike — Red Hat ya entrega un registro por CVE por sistema.

**Severidad CVSS vs. `impact` de Red Hat — misma separación de señales que `exprtRating`.** La severidad se deriva de `cvss3_score` (o `cvss2_score` si el v3 falta) reutilizando exactamente las mismas bandas `scoreToSeverity` que Greenbone/CrowdStrike. Red Hat aporta además su propia valoración de impacto (`impact`: Low/Moderate/Important/Critical), almacenada en la nueva columna `redhat_impact` y mostrada como señal **separada**, nunca fusionada con la severidad CVSS — mismo principio ya establecido para `exprtRating` de CrowdStrike en v3.6.1.

**`known_exploit` — tercera señal de premarcado forzado, independiente de CISA KEV.** `isForcedPremarked()` en `classifier.ts` ya combinaba CISA KEV y la allowlist de `exploitStatus` de CrowdStrike; Lightspeed añade `known_exploit` como una tercera condición OR, deliberadamente en su propio campo (`knownExploit`) y no fusionada con `cisaKev` — son afirmaciones distintas de fuentes distintas (el catálogo oficial CISA KEV frente al propio juicio de Red Hat), y confundirlas ocultaría precisamente los casos donde discrepan.

**Corrección de SO + fechas de EOL/EOS — comportamiento nuevo, exclusivo de esta fuente.** Ni Greenbone ni CrowdStrike tocan nunca el sistema operativo de un CI. Lightspeed sí, y solo en el momento de **aceptar** el lote (nunca antes — la disciplina de staging aplica también a los hechos de SO, no solo a las vulnerabilidades): `correctOperatingSystem()` en `vuln-import/service.ts` resuelve o crea una fila `OperatingSystem` por `code` (p. ej. `RHEL_9.4`) y **siempre refresca** `CI.operatingSystemId` para los CIs emparejados en este lote — a diferencia de `hypervisorId` (marcador de clasificación fijado solo en la creación, ver §4 D5), la versión de SO es un hecho físico que el sistema externo posee y debe poder corregir en cada sync. La primera vez que se crea una fila `OperatingSystem` para una versión mayor de RHEL, se consulta la Product Life Cycle API y se registran sus fechas de fin de soporte (`os-end-of-support`) y fin de vida (`os-end-of-life`) en `operating_system_dates`, usando los `DateType` ya sembrados en el catálogo de fechas de ciclo de vida (v2.8.2) — reutilizado sin ninguna tabla nueva.

**Barrido de cierre — solo posible porque Lightspeed da una foto completa del CI.** Un informe manual de Greenbone o CrowdStrike no garantiza cubrir todas las vulnerabilidades de un host; una llamada a Lightspeed sí — devuelve todo lo que ese sistema tiene abierto en este momento. Esto permite un comportamiento que ninguna otra fuente puede tener de forma segura: al aceptar, cualquier vulnerabilidad ya almacenada en el CI con `source = 'redhat-lightspeed'` y estado abierto (`NUEVO`/`ASIGNADO`/`EN_CURSO`/`PARADO`/`REABIERTA`) que **no** aparezca entre las entradas de este lote para ese CI se cierra automáticamente (`RESUELTO`, `resolvedAt = ahora`, auditoría `VULN_AUTO_RESOLVED` por cada cierre). La valla de seguridad es idéntica en espíritu a la de propiedad de hipervisor (§4): el barrido comprueba **todas** las entradas del lote para ese CI (incluidas las EXCLUIDAs — una entrada excluida por severidad baja sigue significando "Lightspeed todavía la ve abierta"), pero solo actúa sobre vulnerabilidades con `source = 'redhat-lightspeed'`; las de Greenbone o CrowdStrike en el mismo CI nunca se tocan desde una aceptación de Lightspeed.

**"CI no encontrado" ya no bloquea en silencio — acción "Crear CI".** Antes de este trabajo, un host `UNMATCHED` en cualquier fuente solo bloqueaba la aceptación (`422 UNRESOLVED_MATCHES`) sin ofrecer ninguna acción. La pantalla de revisión ya tenía un selector de reasignación manual a un CI **existente** (`CiReassignPicker` + `PATCH /api/vuln-import/batches/:id/entries/:entryId` con `{ciId}`) — lo único que faltaba era crear el CI cuando no existe ninguno. En vez de un endpoint nuevo, se añadió una opción "Crear CI" dentro del mismo selector (visible solo cuando `matchConfidence === 'UNMATCHED'`) que abre `AddCIModal` (extendido con una prop `initialValues` opcional y un `onCreated` que ahora devuelve el CI creado, ambos cambios aditivos y compatibles con su único llamador preexistente) prerrellenado con el nombre/IP/hostname del host, y al crearlo reutiliza directamente `handleReassignCi` — el mismo endpoint PATCH de siempre, sin lógica nueva de backend.

**Esquema.** `VulnImportEntry` gana 3 columnas nuevas, todas nullable (`redhat_impact varchar(20)`, `known_exploit boolean`, `public_date timestamptz`) — mismo patrón aditivo que las 8 columnas de CrowdStrike en v3.6.1. El JSON `Vulnerability` persistido gana los mismos 3 campos opcionales, más `'redhat-lightspeed'` como tercer valor válido de `source`.

**Endpoints.** `GET /api/integrations/redhat-lightspeed/status` (ADMIN/AUDITOR/SOC — `requireAudit`) refleja si la cuenta de servicio está configurada, sin exponer nunca el secreto. `POST /api/integrations/redhat-lightspeed/import` (ADMIN/SOC — `requireSecurityWrite`, mismo gate que `/api/vuln-import/upload`) ejecuta el pull completo y crea un lote; `503 NOT_CONFIGURED` si faltan credenciales, `409 IMPORT_IN_PROGRESS` ante una ejecución concurrente (candado en memoria, mismo patrón que `vcenterService.ts`).

**Limitación conocida / riesgo aceptado.** Las formas JSON exactas de las tres APIs de Red Hat se infirieron de su documentación pública, no de un fixture real como sí se tuvo para Greenbone/CrowdStrike — la lección de v3.6.0 (un mock inventado puede validar silenciosamente la versión equivocada de un formato) se mitiga aquí exigiendo una verificación contra una cuenta de servicio real antes de dar el conector por probado en producción, documentada aparte una vez realizada.

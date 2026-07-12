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

Además, `hypervisorId` es ahora **obligatorio** (validado en servidor y cliente) al crear/editar cualquier CI de tipo `VIRTUAL_SERVER` — se muestra como un desplegable "Hipervisor" en `AddCIModal`/`EditCIModal`, poblado desde `/api/masters/hypervisors`. `cluster`/`lastSyncAt` por VM siguen sin capturarse (simplificación aceptada: `cluster` no se resuelve — gap documentado en el plan original; `lastSyncAt` es redundante con `CI.updatedAt`). **`esxiHost` sí se resuelve**, desde la Task H2 (`7570d62`): best-effort vía `VCenterClient.hostSummary()` + `VCenterConnector.discover()` y, cuando existe exactamente un CI `PHYSICAL_SERVER` cuyo `name`/`hostName` coincide (case-insensitive) con el host reportado, se crea una relación `HOSTS` idempotente hacia él en `vcenterService.ts`. Los nombres de campo de la API vSphere usados (esquemas `VM.Summary`/`Host.Info`) no están verificados contra un vCenter real en esta sesión — riesgo documentado; ante cualquier fallo o suposición incorrecta, degrada de forma segura a `esxiHost: null`/sin relación creada.

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
| `POST` | `/api/integrations/vcenter/sync` | JWT, `requireAdmin` | Lanza una sincronización manual completa (botón "Sincronizar ahora" en Configuración). Devuelve `SyncResult` (`created`/`updated`/`retired`/`errors`). `409 VCENTER_NOT_CONFIGURED` / `409 VCENTER_SYNC_DISABLED` / `409 SYNC_IN_PROGRESS` según el caso. Desde la Task H2, cada VM sincronizada también intenta crear, best-effort, una relación `HOSTS` hacia el CI `PHYSICAL_SERVER` que coincide con su `esxiHost` (si hay exactamente uno) — no forma parte del `SyncResult` agregado, es una operación de enriquecimiento aislada por VM. |
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

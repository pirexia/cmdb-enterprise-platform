# Guía de desarrollo de plugins

> Versión: v2.8.1 · Audiencia: desarrolladores que construyen plugins para el CMDB
> Referencia técnica del motor: [PLUGIN_ENGINE.md](PLUGIN_ENGINE.md) · Checklist de revisión: [PLUGIN_SECURITY_CHECKLIST.md](PLUGIN_SECURITY_CHECKLIST.md)

Esta guía combina un **tutorial** (construye tu primer plugin paso a paso) con **how-tos** de referencia (manifest, permisos, hooks, rutas, cron, migraciones, UI, firma, empaquetado).

> **Plugin de referencia.** El repo incluye un plugin completo y funcional en [`examples/plugins/hello-world/`](../examples/plugins/hello-world/) con manifest, migración, hook, ruta, cron job y UI. Los fragmentos de esta guía coinciden con ese ejemplo; úsalo como plantilla.

> **Antes de empezar — modelo de confianza.** El runtime que ejecuta tu código (`vm.Script`) **no es una caja fuerte**. Tu plugin será admitido en producción solo tras pasar un **gate de admisión**: firma Ed25519, checksum, revisión humana de código y aprobación de un segundo ADMIN (4-eyes). Escribe tu plugin para que sea *auditable*: permisos mínimos, hosts declarados, sin trucos para acceder a globals bloqueados. Un plugin que parezca intentar evadir el sandbox será rechazado en revisión.

---

## 1. Estructura de un plugin

Un plugin es un archivo **`.zip`** (único formato aceptado — la extracción es unzip-only) con esta estructura en la raíz:

```
mi-plugin.zip
├── manifest.json        # OBLIGATORIO — metadatos, permisos, slots, hooks, rutas, cron
├── migration.sql        # opcional — DDL de tablas plg_<id>_*
├── down.sql             # opcional — revierte migration.sql (si falta, se autogenera DROP)
├── hooks/               # opcional — un .js por cada evento de manifest.hooks
│   └── post-create-ci.js     # hooks/<kebab(evento)>.js  (postCreateCI → post-create-ci.js)
├── routes/              # opcional — un .js por cada entrada de manifest.routes
│   └── get_ping.js           # routes/<método>_<slug(path)>.js  (GET /ping → get_ping.js)
├── cron/                # opcional — un .js por cada entrada de manifest.cronJobs
│   └── heartbeat.js          # cron/<name>.js  (name del cron job en el manifest)
└── ui/                  # opcional — HTML/JS servido en los slots (iframe)
    └── index.html            # por defecto se sirve index.html
```

> Solo `manifest.json` es obligatorio. El motor lo extrae con `unzip -p manifest.json`, así que **debe estar en la raíz del archivo**, no en un subdirectorio.
>
> **Cada hook, ruta y cron declarado en el manifest debe tener su fichero de handler** en el bundle, en la ruta exacta que se indica arriba. Si falta uno, **la instalación falla** (`PLUGIN_HANDLER_MISSING`).

---

## 2. Formato del `manifest.json`

Validado por `PluginManifestSchema` (Zod) en `backend/src/modules/plugins/schemas.ts`. Campos:

| Campo | Tipo | Obligatorio | Reglas |
|-------|------|-------------|--------|
| `id` | string | sí | **kebab-case** (`^[a-z0-9-]+$`). Define el prefijo de tablas `plg_<id>_` |
| `name` | string | sí | 1–100 caracteres |
| `version` | string | sí | **semver** `MAJOR.MINOR.PATCH` |
| `author` | string | sí | 1–200 caracteres |
| `license` | string | sí | 1–50 caracteres (p. ej. `MIT`) |
| `description` | string | no | ≤ 500 caracteres |
| `engineMin` | string | no | Versión mínima del motor (semver) |
| `permissions` | string[] | no (`[]`) | Ver [§3](#3-permisos-disponibles) |
| `allowedHosts` | string[] | no (`[]`) | URLs absolutas; el sandbox solo permite `fetch` a estos hosts |
| `hooks` | string[] | no (`[]`) | Nombres de eventos a los que te suscribes |
| `routes` | object[] | no (`[]`) | `{ method, path, requiresAuth, requiredRole? }` (`path` empieza por `/`) |
| `cronJobs` | object[] | no (`[]`) | `{ name, schedule }` (expresión cron) |
| `uiSlots` | string[] | no (`[]`) | Ver [§6](#6-ui-del-plugin-iframe--postmessage) |
| `signature` | string | no | Firma Ed25519 en base64 sobre el checksum (ver [§7](#7-firmar-un-plugin-con-ed25519)) |

Ejemplo mínimo:

```json
{
  "id": "hello-world",
  "name": "Hello World",
  "version": "1.0.0",
  "author": "Equipo Plataforma",
  "license": "MIT",
  "description": "Plugin de ejemplo que registra cada CI creado.",
  "permissions": ["db:schema", "db:write", "hooks:register", "ui:iframe"],
  "hooks": ["postCreateCI"],
  "uiSlots": ["DashboardWidget"]
}
```

---

## 3. Permisos disponibles

Declara en `permissions[]` solo lo que tu plugin necesita (**mínimo privilegio** — el revisor comparará lo solicitado con lo usado).

| Permiso | Habilita |
|---------|----------|
| `db:read` | Lectura de datos vía el proxy de Prisma del sandbox |
| `db:write` | Escritura de datos vía el proxy de Prisma |
| `db:schema` | Ejecutar migración DDL (crear tablas `plg_*`). Requiere revisión + 4-eyes |
| `http:fetch` | Llamadas salientes con `fetch` — **requiere `allowedHosts` no vacío** |
| `cron:register` | Registrar cron jobs |
| `hooks:register` | Registrar hooks del ciclo de vida del core |
| `routes:register` | Registrar rutas REST |
| `ui:iframe` | Servir UI embebida en slots |

> El acceso a Prisma desde el sandbox está **cableado** (v2.8.1). Tu handler recibe un objeto `prisma` con scope (ver [§9](#9-acceso-a-la-base-de-datos-prisma-del-sandbox)); `db:read` habilita las lecturas y `db:write` las escrituras.

---

## 4. Escribir un hook handler

Por cada evento que declares en `manifest.hooks` (p. ej. `"postCreateCI"`), el código va en **`hooks/<kebab(evento)>.js`**: el motor convierte el nombre camelCase del evento a kebab-case para localizar el fichero.

| Evento en `manifest.hooks` | Fichero esperado en el bundle |
|----------------------------|-------------------------------|
| `postCreateCI` | `hooks/post-create-ci.js` |
| `preUpdateCI` | `hooks/pre-update-ci.js` |
| `postLogin` | `hooks/post-login.js` |

Tu handler es un fichero JS que define una función llamada **`handler`**. El motor lo ejecuta dentro del sandbox así (simplificado):

```js
(async function () {
  /* tu código */
  return await handler(__pluginData__);
})()
```

- Recibe **un argumento**: los datos del evento (ver tabla de payloads en [PLUGIN_ENGINE.md §5](PLUGIN_ENGINE.md#5-sistema-de-hooks)).
- En **pre-hooks** puedes **cancelar** la operación devolviendo `{ cancel: true, reason: "..." }`. El core responderá `409` con tu `reason`.
- En **post-hooks** el valor de retorno se ignora (fire-and-forget).

Dentro del handler dispones solo de: `prisma`, `logger`, `config`, `fetch` (restringido a `allowedHosts`), `console`, `JSON`, `Math`, `Date`, `parseInt`, `parseFloat`, `isNaN`, `isFinite`, `encodeURIComponent`, `decodeURIComponent`. **No** dispones de `process`, `require`, `fs`, `setTimeout`, `globalThis`, etc. El handler debe terminar en **menos de 5 segundos** (timeout).

Ejemplo de pre-hook que bloquea CIs sin nombre:

```js
async function handler(data) {
  if (!data.body?.name) {
    return { cancel: true, reason: "El CI debe tener nombre" };
  }
}
```

---

## 4.1. Escribir una ruta REST

Por cada entrada de `manifest.routes` (`{ method, path, requiresAuth, requiredRole? }`) el código va en **`routes/<método-en-minúsculas>_<slug>.js`**, donde `slug` es el `path` con cada secuencia de caracteres no alfanuméricos reemplazada por `_`:

| Entrada en `manifest.routes` | Fichero esperado | URL servida |
|------------------------------|------------------|-------------|
| `{ "method": "GET", "path": "/ping" }` | `routes/get_ping.js` | `GET /api/ext/<pluginId>/ping` |
| `{ "method": "POST", "path": "/items/list" }` | `routes/post_items_list.js` | `POST /api/ext/<pluginId>/items/list` |

El handler es una función `async function handler(req)` que:

- Recibe **un argumento** `req` con la forma `{ method, path, query, body, user }`, donde `user` es `{ email, role }` si la petición está autenticada, o `null` si no lo está.
- Devuelve `{ status?, body? }` (el motor responde con ese `status`, por defecto `200`, y serializa `body` como JSON). Si devuelves un valor plano (no un objeto con `status`/`body`), se responde `200` con ese valor como JSON.

```js
// routes/get_ping.js — GET /api/ext/hello-world/ping  (requiresAuth: true)
async function handler(req) {
  const rows = await prisma.$queryRawUnsafe(
    "SELECT count(*)::int AS n FROM plg_hello_world_log"
  );
  return {
    status: 200,
    body: {
      plugin: "hello-world",
      logged: rows[0].n,
      you: req.user ? req.user.role : null,
    },
  };
}
```

**Autenticación por ruta:** se aplica según el manifest, no de forma global.

- `requiresAuth: true` (valor por defecto): el dispatcher exige una sesión válida (JWT en cabecera `Authorization: Bearer` o cookie `token`); sin ella responde `401`.
- `requiredRole`: si lo declaras (`ADMIN`/`AUDITOR`/`VIEWER`), una sesión con otro rol recibe `403`.
- `requiresAuth: false`: la ruta es accesible sin sesión y `req.user` será `null`.

Las rutas se sirven bajo **`/api/ext/:pluginId/<path>`** y están sujetas al mismo rate-limit que el resto del módulo. El emparejamiento es exacto por método + path (sin patrones de parámetros en v2.8.1).

---

## 4.2. Escribir un cron job

Por cada entrada de `manifest.cronJobs` (`{ name, schedule }`) el código va en **`cron/<name>.js`** (el `name` debe ser alfanumérico, `-` o `_`). El motor lo agenda con `node-cron` según `schedule` cuando el plugin se activa, y lo detiene al desactivarlo o desinstalarlo. Cada ejecución actualiza `lastRunAt`.

El handler es una función **`async function handler()`** (sin argumentos):

```js
// cron/heartbeat.js — schedule "*/30 * * * *" (cada 30 min)
// El sandbox no expone setTimeout/setInterval; el scheduling lo hace el motor.
async function handler() {
  logger.info("hello-world heartbeat", new Date().toISOString());
}
```

> Dentro del handler de cron dispones del mismo sandbox que en los hooks (`prisma`, `logger`, `config`, `fetch` restringido, etc.) y del mismo timeout de 5 s.

---

## 5. Escribir una migración

Coloca tu DDL en `migration.sql`. Reglas (impuestas por `PluginValidator.validateMigrationSql`):

- **Toda** `CREATE TABLE` debe usar el prefijo `plg_<id>_` (con guiones del `id` convertidos a `_`). Para `id: "hello-world"` el prefijo es `plg_hello_world_`.
- Solo se permite tocar objetos `plg_*`: `CREATE TABLE`/`CREATE INDEX` sobre tablas con tu prefijo, `INSERT INTO plg_*`, comentarios.
- **Prohibido sobre cualquier objeto que no empiece por `plg_`:** `DROP TABLE`/`DROP INDEX` (y demás `DROP`), `TRUNCATE`, `ALTER TABLE`, `DELETE FROM`, `UPDATE`. El validador captura el identificador de destino y exige que empiece por `plg_`; tocar una tabla core hace fallar la instalación (`PLUGIN_DDL_FORBIDDEN`).
- **Prohibido por completo:** `GRANT` y `REVOKE` (no se permiten en migraciones de plugin bajo ninguna circunstancia).
- Los comentarios (`--`, `/* */`) y literales entre comillas se eliminan antes de validar, de modo que no se puede colar un verbo peligroso comentado o entrecomillado.
- Usa `IF NOT EXISTS` para idempotencia.

```sql
-- migration.sql del plugin hello-world
CREATE TABLE IF NOT EXISTS plg_hello_world_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ci_id       uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS plg_hello_world_log_ci_idx ON plg_hello_world_log (ci_id);
```

Opcionalmente, incluye `down.sql` para revertir. Si no lo incluyes, al desinstalar el motor generará automáticamente `DROP TABLE` para todas tus tablas `plg_<id>_*` (y antes hará un backup JSON).

```sql
-- down.sql
DROP TABLE IF EXISTS plg_hello_world_log CASCADE;
```

---

## 6. UI del plugin (iframe + postMessage)

Si declaras `uiSlots`, el host embebe tu UI en un `<iframe sandbox="allow-scripts allow-same-origin">` cuyo `src` es `/api/plugins/:id/ui?slot=<slot>`. Tu plugin sirve el HTML/JS bajo esa ruta.

El endpoint `GET /api/plugins/:id/ui[/*]` está **implementado** (v2.8.1) y sirve los ficheros de `installed/<id>/ui/*`:

- Por defecto sirve **`index.html`**; cualquier otra ruta (`/widget.html`, `/assets/app.js`, …) se resuelve dentro de `ui/` con protección contra path traversal.
- Es accesible a **cualquier usuario autenticado** (no solo ADMIN); una petición sin sesión válida recibe `401`.
- El parámetro `?slot=<slot>` se valida contra tu `manifest.uiSlots`; si pides un slot que no declaras, responde `400`.
- Las respuestas llevan una **CSP estricta** (`default-src 'self'`; se permiten `script-src`/`style-src` inline para UIs HTML simples; `frame-ancestors 'self'`) y `X-Content-Type-Options: nosniff`.

Slots disponibles (`uiSlots[]`): `DashboardWidget`, `CIDetailTab`, `ContractDetailTab`, `TopBarMenu`, `SettingsPanel`, `InventoryColumn`, `MapOverlay`.

El puente `postMessage` (validado por origen) funciona así:

- **Recibes del host** al cargar: `cmdb:init` con `{ token: null, locale, theme, context }`. Úsalo para localizar tu UI y leer el `context` del slot. El token es `null` por diseño: tus llamadas a la API del CMDB reutilizan automáticamente la cookie HttpOnly de la sesión.
- **Envías al host:**
  - `cmdb:resize` `{ type, height }` — para que el host ajuste la altura de tu iframe.
  - `cmdb:navigate` `{ type, path }` — para navegar internamente (paths que empiezan por `/`).

```html
<!-- ui/index.html -->
<!DOCTYPE html>
<html>
<body>
  <div id="root">Cargando…</div>
  <script>
    // Escuchar la inicialización del host
    window.addEventListener("message", (e) => {
      if (e.origin !== window.location.origin) return;
      if (e.data?.type === "cmdb:init") {
        document.getElementById("root").textContent =
          "Hola desde el plugin (locale: " + e.data.locale + ")";
        // Llamar a la ruta propia del plugin (la cookie de sesión viaja sola)
        fetch("/api/ext/hello-world/ping", { credentials: "same-origin" })
          .then((r) => r.json())
          .then((d) => { /* … */ });
        // Informar de la altura real al host
        parent.postMessage(
          { type: "cmdb:resize", height: document.body.scrollHeight },
          window.location.origin
        );
      }
    });
  </script>
</body>
</html>
```

> Ejemplo real y completo en [`examples/plugins/hello-world/ui/index.html`](../examples/plugins/hello-world/ui/index.html): consume su propia ruta `GET /api/ext/hello-world/ping` desde el iframe reutilizando la cookie de sesión.

---

## 7. Firmar un plugin con Ed25519

La firma es la pieza criptográfica del gate de admisión. Se firma el **checksum SHA-256** del bundle (los mismos bytes hex que el backend recalcula).

1. **Generar el par de claves** (una sola vez, custodia la privada):

```bash
# Clave privada Ed25519
openssl genpkey -algorithm ed25519 -out plugin-signing.key
# Clave pública en formato SPKI/DER → base64 (lo que va en PLUGIN_SIGNING_PUBLIC_KEY)
openssl pkey -in plugin-signing.key -pubout -outform DER | base64 -w0
```

2. **Calcular el checksum del bundle** (idéntico al del backend):

```bash
sha256sum mi-plugin.zip   # toma el primer campo (hex)
```

3. **Firmar el checksum** y poner la firma base64 en `manifest.signature`. El backend verifica con `crypto.verify(null, Buffer.from(checksum,'hex'), publicKey, signature)`. Un helper Node equivalente:

```js
const crypto = require("crypto");
const fs = require("fs");
const checksumHex = process.argv[2];                 // sha256 del zip
const priv = crypto.createPrivateKey(fs.readFileSync("plugin-signing.key"));
const sig = crypto.sign(null, Buffer.from(checksumHex, "hex"), priv);
console.log(sig.toString("base64"));                  // → manifest.signature
```

> El administrador debe configurar `PLUGIN_SIGNING_PUBLIC_KEY` (base64 de la clave pública SPKI/DER) en el entorno del backend. Si el manifest declara `signature` pero la variable no está configurada, la validación falla.

---

## 8. Ejemplo completo: `hello-world`

Plugin de referencia completo y funcional. Fuente en [`examples/plugins/hello-world/`](../examples/plugins/hello-world/): un hook `postCreateCI` que registra cada CI creado en su propia tabla, una ruta `GET /ping`, un cron `heartbeat` y un widget de dashboard.

**`manifest.json`**

```json
{
  "id": "hello-world",
  "name": "Hello World",
  "version": "1.0.0",
  "author": "Equipo Plataforma",
  "license": "MIT",
  "description": "Plugin de referencia: registra cada CI creado en plg_hello_world_log, expone GET /ping y un widget de dashboard.",
  "permissions": ["db:schema", "db:write", "db:read", "hooks:register", "routes:register", "cron:register", "ui:iframe"],
  "hooks": ["postCreateCI"],
  "routes": [
    { "method": "GET", "path": "/ping", "requiresAuth": true }
  ],
  "cronJobs": [
    { "name": "heartbeat", "schedule": "*/30 * * * *" }
  ],
  "uiSlots": ["DashboardWidget"],
  "allowedHosts": []
}
```

**`migration.sql`**

```sql
CREATE TABLE IF NOT EXISTS plg_hello_world_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ci_id       uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS plg_hello_world_log_ci_idx ON plg_hello_world_log (ci_id);
```

**`hooks/post-create-ci.js`**

```js
// Se ejecuta tras crear un CI. Payload: { id, body, user }
async function handler(data) {
  await prisma.$executeRaw`
    INSERT INTO plg_hello_world_log (ci_id) VALUES (${data.id}::uuid)
  `;
  logger.info("hello-world: CI registrado", data.id);
}
```

**`routes/get_ping.js`** — ver [§4.1](#41-escribir-una-ruta-rest).

**`cron/heartbeat.js`** — ver [§4.2](#42-escribir-un-cron-job).

**`ui/index.html`** — ver el ejemplo de [§6](#6-ui-del-plugin-iframe--postmessage).

---

## 9. Acceso a la base de datos: `prisma` del sandbox

Dentro de cualquier handler (hook, ruta o cron) dispones de un objeto **`prisma`**. **No** es el cliente Prisma del core: es un **proxy con scope** que enruta todas las consultas a través del rol de base de datos `cmdb_plugin`, que solo puede tocar objetos `plg_*` (tus propias tablas). El cliente Prisma del core **nunca** se expone al plugin.

El proxy ofrece únicamente cuatro métodos de SQL crudo, cada uno protegido por un permiso (gate):

| Método | Permiso requerido | Uso |
|--------|-------------------|-----|
| `prisma.$queryRaw` (tagged template) | `db:read` | Lectura parametrizada |
| `prisma.$queryRawUnsafe(sql)` | `db:read` | Lectura con SQL en string |
| `prisma.$executeRaw` (tagged template) | `db:write` | Escritura/DDL parametrizada |
| `prisma.$executeRawUnsafe(sql)` | `db:write` | Escritura con SQL en string |

- `db:read` habilita los dos métodos de lectura; `db:write` (o `db:schema`) habilita además los de escritura. Llamar a un método sin el permiso declarado lanza `PLUGIN_PERM`.
- Como el SQL se ejecuta bajo el rol `cmdb_plugin`, una consulta contra una tabla core fallará a nivel de base de datos aunque el código intente acceder a ella.
- **No hay métodos de modelo** (`prisma.user.findMany`, etc.): solo SQL crudo sobre tus tablas `plg_*`.

```js
// Lectura (requiere db:read)
const rows = await prisma.$queryRawUnsafe(
  "SELECT count(*)::int AS n FROM plg_hello_world_log"
);

// Escritura parametrizada (requiere db:write)
await prisma.$executeRaw`
  INSERT INTO plg_hello_world_log (ci_id) VALUES (${ciId}::uuid)
`;
```

> Requiere que el administrador haya configurado `PLUGIN_DATABASE_URL` (rol `cmdb_plugin`, ver `scripts/create-plugin-db-role.sql`). Si no está configurada, el acceso a `prisma` desde el plugin está deshabilitado.

---

## 10. Empaquetar y subir

1. **Empaquetar** (comprime el contenido en la raíz, no la carpeta contenedora). El único formato aceptado es **`.zip`**:

```bash
cd mi-plugin/
zip -r ../hello-world.zip manifest.json migration.sql hooks/ routes/ cron/ ui/
# Verifica que manifest.json está en la raíz:
unzip -l ../hello-world.zip | grep manifest.json   # debe mostrar "manifest.json", no "mi-plugin/manifest.json"
```

2. **Subir e instalar** desde el panel `/plugins/admin` (rol ADMIN) — ver el Manual de Usuario, sección *Gestión de Plugins*. El flujo es: **Subir → Validar → Instalar → Activar** (en producción la activación requiere aprobación 4-eyes de un segundo ADMIN). Vía API:

```bash
# Subir (multipart, campo 'plugin')
curl -sk -X POST https://localhost/api/plugins/upload \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -F "plugin=@hello-world.zip"
# → { id, pluginId, status: "UPLOADED", checksum }

# Validar → Instalar → Activar (usa el id devuelto)
curl -sk -X POST https://localhost/api/plugins/$ID/validate -H "Authorization: Bearer $ADMIN_TOKEN"
curl -sk -X POST https://localhost/api/plugins/$ID/install  -H "Authorization: Bearer $ADMIN_TOKEN"
curl -sk -X POST https://localhost/api/plugins/$ID/activate -H "Authorization: Bearer $ADMIN_TOKEN"
```

Límites: el bundle no puede superar `PLUGIN_MAX_SIZE_MB` (50 MB por defecto) y debe ser un **`.zip`** real (se valida por extensión y magic bytes `50 4B 03 04`; se rechazan symlinks). El `id` del manifest debe ser único; subir uno ya registrado devuelve `409`.

# Guía de desarrollo de plugins

> Versión: v2.8.0 · Audiencia: desarrolladores que construyen plugins para el CMDB
> Referencia técnica del motor: [PLUGIN_ENGINE.md](PLUGIN_ENGINE.md) · Checklist de revisión: [PLUGIN_SECURITY_CHECKLIST.md](PLUGIN_SECURITY_CHECKLIST.md)

Esta guía combina un **tutorial** (construye tu primer plugin paso a paso) con **how-tos** de referencia (manifest, permisos, hooks, migraciones, UI, firma, empaquetado).

> **Antes de empezar — modelo de confianza.** El runtime que ejecuta tu código (`vm.Script`) **no es una caja fuerte**. Tu plugin será admitido en producción solo tras pasar un **gate de admisión**: firma Ed25519, checksum, revisión humana de código y aprobación de un segundo ADMIN (4-eyes). Escribe tu plugin para que sea *auditable*: permisos mínimos, hosts declarados, sin trucos para acceder a globals bloqueados. Un plugin que parezca intentar evadir el sandbox será rechazado en revisión.

---

## 1. Estructura de un plugin

Un plugin es un archivo comprimido (`.zip`, `.tar.gz` o `.tgz`) con esta estructura en la raíz:

```
mi-plugin.zip
├── manifest.json        # OBLIGATORIO — metadatos, permisos, slots, hooks
├── migration.sql        # opcional — DDL de tablas plg_<id>_*
├── down.sql             # opcional — revierte migration.sql (si falta, se autogenera DROP)
├── hooks/               # opcional — código de los handlers de hooks
│   └── post-create-ci.js
└── ui/                  # opcional — HTML/JS servido en los slots (iframe)
    └── widget.html
```

> Solo `manifest.json` es obligatorio. El motor lo extrae con `unzip -p manifest.json`, así que **debe estar en la raíz del archivo**, no en un subdirectorio.

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

> El acceso real a Prisma desde el sandbox aún está en cableado (ver "Estado de implementación" en [PLUGIN_ENGINE.md](PLUGIN_ENGINE.md)). Declara `db:read`/`db:write` igualmente para que tu manifest sea correcto a futuro.

---

## 4. Escribir un hook handler

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

## 5. Escribir una migración

Coloca tu DDL en `migration.sql`. Reglas (impuestas por `PluginValidator.validateMigrationSql`):

- **Toda** `CREATE TABLE` debe usar el prefijo `plg_<id>_` (con guiones del `id` convertidos a `_`). Para `id: "hello-world"` el prefijo es `plg_hello_world_`.
- Solo se permite: `CREATE TABLE`, `CREATE INDEX`, `CREATE UNIQUE INDEX`, `INSERT INTO plg_*`, comentarios.
- **Prohibido:** `DROP`/`TRUNCATE`/`ALTER`/`DELETE` sobre cualquier tabla que **no** empiece por `plg_`. Tocar una tabla core hace fallar la instalación.
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

Slots disponibles (`uiSlots[]`): `DashboardWidget`, `CIDetailTab`, `ContractDetailTab`, `TopBarMenu`, `SettingsPanel`, `InventoryColumn`, `MapOverlay`.

El puente `postMessage` (validado por origen) funciona así:

- **Recibes del host** al cargar: `cmdb:init` con `{ token: null, locale, theme, context }`. Úsalo para localizar tu UI y leer el `context` del slot. El token es `null` por diseño: tus llamadas a la API del CMDB reutilizan automáticamente la cookie HttpOnly de la sesión.
- **Envías al host:**
  - `cmdb:resize` `{ type, height }` — para que el host ajuste la altura de tu iframe.
  - `cmdb:navigate` `{ type, path }` — para navegar internamente (paths que empiezan por `/`).

```html
<!-- ui/widget.html -->
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

> El endpoint backend `/api/plugins/:id/ui` aún no está implementado en v2.8.0 (ver "Estado de implementación" en [PLUGIN_ENGINE.md](PLUGIN_ENGINE.md)). Prepara tu `ui/` para cuando se habilite.

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

Plugin mínimo funcional: un hook `postCreateCI` que registra cada CI creado en su propia tabla, más un widget de dashboard.

**`manifest.json`**

```json
{
  "id": "hello-world",
  "name": "Hello World",
  "version": "1.0.0",
  "author": "Equipo Plataforma",
  "license": "MIT",
  "description": "Registra cada CI creado en plg_hello_world_log y muestra un widget.",
  "permissions": ["db:schema", "db:write", "hooks:register", "ui:iframe"],
  "hooks": ["postCreateCI"],
  "uiSlots": ["DashboardWidget"]
}
```

**`migration.sql`**

```sql
CREATE TABLE IF NOT EXISTS plg_hello_world_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ci_id       uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
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

**`ui/widget.html`** — ver el ejemplo de [§6](#6-ui-del-plugin-iframe--postmessage).

---

## 9. Empaquetar y subir

1. **Empaquetar** (comprime el contenido en la raíz, no la carpeta contenedora):

```bash
cd mi-plugin/
zip -r ../hello-world.zip manifest.json migration.sql hooks/ ui/
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

Límites: el bundle no puede superar `PLUGIN_MAX_SIZE_MB` (50 MB por defecto) y debe ser un `.zip`/`.tar.gz`/`.tgz` real (se valida por magic bytes). El `id` del manifest debe ser único; subir uno ya registrado devuelve `409`.

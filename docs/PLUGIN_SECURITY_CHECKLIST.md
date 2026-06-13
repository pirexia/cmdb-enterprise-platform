# Checklist de seguridad de plugins (gate de admisión 4-eyes)

> Versión: v2.8.0 · Audiencia: revisores ADMIN que aprueban plugins antes de activarlos
> Referencia técnica: [PLUGIN_ENGINE.md](PLUGIN_ENGINE.md) · Guía de desarrollo: [PLUGIN_DEVELOPMENT_GUIDE.md](PLUGIN_DEVELOPMENT_GUIDE.md)

Este documento es el **procedimiento operativo** que debe seguir todo revisor antes de aprobar la activación de un plugin. Es de obligado cumplimiento en producción (control ISO 27001 A.5.37 — procedimientos operativos documentados).

---

## 1. Por qué existe este checklist

El plugin se ejecuta con `vm.Script`. La documentación de Node.js es explícita: **"The vm module is not a security mechanism."** El sandbox (contexto congelado, sin `process`/`require`/`fs`, timeout, `fetch` con allowlist) es **defensa en profundidad**, no una caja fuerte. Un atacante decidido con un plugin aprobado por error puede escapar de él.

Por tanto, **la frontera de seguridad real es humana + criptográfica**: este checklist + la firma Ed25519 + la aprobación de un segundo ADMIN (4-eyes). Si tú apruebas un plugin malicioso, el sistema lo ejecutará con toda confianza. Revisa como si el código fuera a correr con los privilegios del backend — porque efectivamente puede acabar haciéndolo.

Un plugin desde el punto de vista de compliance es **código de terceros incorporado a un servicio esencial** → riesgo de **cadena de suministro NIS2** (ver [§8](#8-mapeo-a-compliance)).

---

## 2. Revisión de código del plugin

Descomprime el bundle y revisa **todo** el código (`hooks/`, `ui/`, cualquier `.js`). Marca cada punto:

- [ ] **Sin acceso a globals bloqueados.** Busca `process`, `require(`, `module`, `globalThis`, `global`, `__dirname`, `__filename`, `eval(`, `Function(`, `child_process`, `import(`. El sandbox los bloquea, pero **cualquier intento de usarlos es señal de alerta** → rechazar y escalar.
- [ ] **Sin acceso a filesystem.** No debe haber `fs`, `readFile`, `writeFile`, rutas absolutas del host.
- [ ] **`fetch` solo a hosts declarados.** Toda URL en `fetch(...)` debe corresponder a un host de `allowedHosts`. Rechaza si hace `fetch` a un host no declarado o construye URLs dinámicas hacia destinos no fijados (riesgo SSRF / exfiltración).
- [ ] **SQL solo sobre `plg_*`.** Cualquier `prisma.$queryRaw`/`$executeRaw`/`$queryRawUnsafe` debe operar **exclusivamente** sobre tablas con el prefijo `plg_<id>_`. Un `SELECT`/`UPDATE`/`DELETE` sobre tablas core (`users`, `configuration_items`, `audit_logs`, etc.) es **motivo de rechazo inmediato**.
- [ ] **Sin exfiltración de PII.** Verifica que no envía a hosts externos campos personales (`email`, `username`, `ssoExternalId`, nombres, DNIs de usuarios de licencia). Compara con GDPR: el plugin no debe sacar datos personales fuera de la plataforma sin justificación documentada.
- [ ] **Sin ofuscación.** Código minificado/ofuscado, cadenas codificadas en base64 que se `eval`-úan, o concatenaciones que reconstruyen identificadores bloqueados → rechazar. El código debe ser legible y auditable.
- [ ] **Logs sin secretos ni PII.** Los `logger.*`/`console.*` no deben volcar tokens, contraseñas ni datos personales.
- [ ] **Pre-hooks razonables.** Si registra pre-hooks que pueden `{ cancel: true }`, confirma que no bloquea operaciones críticas del negocio de forma abusiva (DoS lógico).

---

## 3. Verificación de firma y checksum

- [ ] **Checksum SHA-256** del `.zip` calculado localmente coincide con el registrado en el upload (`POST /upload` lo devuelve; el panel lo muestra). Si no coincide → el bundle se alteró → rechazar.
- [ ] **Firma Ed25519** presente y válida. Si el plugin viene de un editor de confianza, `manifest.signature` debe estar presente y `POST /:id/validate` debe pasar (requiere `PLUGIN_SIGNING_PUBLIC_KEY` configurado). Un plugin **sin firma** solo debe admitirse si tu organización acepta plugins internos no firmados — decisión a documentar.
- [ ] **Procedencia.** Confirma de quién proviene el bundle y por qué canal llegó. Un plugin sin procedencia clara no se aprueba.

---

## 4. Permisos: mínimo privilegio

Compara `manifest.permissions[]` con lo que el código **realmente** usa:

- [ ] Cada permiso solicitado está **justificado** por el código. Un plugin que pide `db:write` pero solo lee, o `http:fetch` sin usar `fetch`, debe ajustarse o rechazarse.
- [ ] `db:schema` → revisa la migración (ver [§5](#5-revisión-de-la-migración-sql)) con especial cuidado: es el permiso que crea estructuras persistentes.
- [ ] `http:fetch` → `allowedHosts` **no vacío** y con hosts concretos (no comodines amplios). Cuantos menos hosts, mejor.
- [ ] `routes:register` / `cron:register` → confirma que las rutas/cron declarados son coherentes con el propósito del plugin.
- [ ] Ningún permiso "por si acaso". El principio rector es **least privilege**.

---

## 5. Revisión de la migración SQL

Si el bundle incluye `migration.sql` (y/o `down.sql`):

- [ ] **Todas** las `CREATE TABLE` usan el prefijo `plg_<id>_`. El validador lo exige, pero verifícalo a ojo.
- [ ] Solo hay DDL de la **allowlist**: `CREATE TABLE` / `CREATE INDEX` / `CREATE UNIQUE INDEX` / `INSERT INTO plg_*` / comentarios.
- [ ] **Cero** `DROP`/`TRUNCATE`/`ALTER`/`DELETE` sobre tablas que no empiecen por `plg_`.
- [ ] Sin `CREATE FUNCTION`/`CREATE TRIGGER`/`COPY`/`GRANT`/`CREATE EXTENSION` ni nada que escape de la allowlist.
- [ ] `down.sql` (si existe) revierte limpiamente y tampoco toca tablas core. Recuerda: la ejecuta el rol `cmdb_plugin`, sin privilegios sobre el core, pero la revisión es tu segunda capa.

---

## 6. Proceso de aprobación 4-eyes (producción)

Cuando `NODE_ENV=production` y `PLUGIN_REQUIRE_APPROVAL_PROD=true`, la activación exige un **`approvalToken`** emitido por un ADMIN **distinto** al que solicita la activación:

1. El **ADMIN solicitante** completa Subir → Validar → Instalar y pide activar.
2. Un **segundo ADMIN** (el revisor) ejecuta este checklist íntegro.
3. Si todo pasa, el revisor proporciona su **JWT de sesión** como `approvalToken` en el body de `POST /:id/activate`.
4. El backend verifica que el token: es válido, pertenece a un `ADMIN`, y **no** coincide en `id`/`email` con el solicitante. Si coincide → `403` (violación 4-eyes).
5. La activación queda **auditada** (`PLUGIN_ACTIVATED`, con `approvedBy`/`approvedAt`).

- [ ] El revisor es una persona **diferente** del solicitante.
- [ ] El revisor ha completado **este** checklist, no solo "le ha echado un vistazo".
- [ ] Queda registro de auditoría de quién aprobó.

---

## 7. Plugin sospechoso o incidente

Si tras la activación se detecta comportamiento sospechoso (fetch a destinos raros, consumo anómalo, acceso a datos inesperados):

- [ ] **Desactivar, NO desinstalar.** Usa `POST /:id/deactivate` → estado `INACTIVE`. **No** desinstales: el uninstall ejecuta la down-migration y borra ficheros, **destruyendo evidencia forense** (aunque genera un backup JSON, pierdes el código instalado y el estado).
- [ ] **Preservar para forense.** Conserva el bundle en `staging/`, el directorio `installed/<id>/`, los `audit_logs` del plugin (`GET /:id/logs`) y cualquier backup JSON.
- [ ] **Revisar logs de auditoría.** `entity='PLUGIN'` y los hooks que ejecutó.
- [ ] **Reportar el incidente.** Si afecta a un servicio esencial o hay sospecha de fuga de datos personales, aplica los plazos **NIS2** (notificación inicial ≤ 24 h, detallada ≤ 72 h) y **GDPR** (brecha de datos personales ≤ 72 h a la autoridad). El diseño de auditoría insert-only del CMDB permite reconstruir la línea temporal.
- [ ] Solo tras concluir el análisis forense, decidir desinstalar (con su backup) o restaurar.

---

## 8. Mapeo a compliance

| Framework | Control | Cómo lo cubre este checklist |
|-----------|---------|------------------------------|
| **OWASP A04** (Insecure Design) | Threat-model de cada feature | Revisión de diseño del plugin antes de admitir |
| **OWASP A06** (Vulnerable/Outdated Components) | Componentes de terceros | El plugin es código de terceros; revisión + firma |
| **OWASP A08** (Software & Data Integrity) | Integridad de artefactos | Checksum SHA-256 + firma Ed25519 + magic bytes |
| **OWASP A10** (SSRF) | Salidas controladas | `fetch` restringido a `allowedHosts`; revisión de URLs |
| **OWASP A01/A03** | Control de acceso / inyección | SQL solo sobre `plg_*`; rol DB `cmdb_plugin` sin acceso al core |
| **ISO 27001 A.5.37** | Procedimientos operativos documentados | Este checklist es el procedimiento |
| **ISO 27001 A.8.15** | Logging / protección de logs | Toda acción de plugin se audita (insert-only) |
| **ISO 27001 A.9.2** | Gestión de accesos | Aprobación 4-eyes para activar |
| **GDPR** (UE 2016/679) | Minimización / no exfiltración de PII | Revisión anti-exfiltración; permisos mínimos |
| **NIS2** (UE 2022/2555) | Riesgo de cadena de suministro | El plugin = proveedor externo; debe poder desactivarse de forma independiente; plazos de notificación de incidentes |
| **ISO 22301** | Continuidad | Un fallo de plugin no bloquea el arranque (se marca `ERROR`); desactivable sin afectar al core |

---

## 9. Resumen — decisión final

Aprueba la activación **solo si** todas las casillas de las secciones 2–6 están marcadas. Ante cualquier duda no resuelta, **rechaza** y devuelve el plugin a su autor con las observaciones. Es preferible rechazar un plugin legítimo que admitir uno malicioso: el sandbox no te salvará.

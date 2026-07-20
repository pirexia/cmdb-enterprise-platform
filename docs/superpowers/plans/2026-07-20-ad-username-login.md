# Plan — Login de usuarios AD por nombre de usuario (sAMAccountName / UPN / NetBIOS)

**Fecha:** 2026-07-20
**Rama propuesta:** `feature/ad-username-login` (cortada de `develop`)
**Área:** Auth flow (legacy `index.ts` + `services/ldap.ts`) + frontend login + i18n. **Seguridad-crítica (OWASP A07/A03).**

---

## 1. Problema

Hoy un usuario de AD solo puede autenticarse escribiendo su **email** (`andres.matias@dachser.com`), porque:

- `LoginSchema` (`index.ts:340`) valida `email: z.string().email()` → rechaza `AZKARAD\andres.matias` y `andres.matias` (bare).
- El input del login (`frontend/app/login/page.tsx:298`) es `type="email"` → el navegador bloquea esos formatos.
- Tras autenticar contra LDAP, el handler busca al usuario en BD **por `email`** (`index.ts:904-908`) y auto-aprovisiona **por `email`** (`index.ts:909-922`).
- `services/ldap.ts` busca por `usernameAttribute = username.includes('@') ? 'mail' : 'uid'` → para AD `uid` es incorrecto (AD usa `sAMAccountName`), y no contempla UPN.

Se requiere permitir login con **usuario AD** en tres formatos, además del email actual (retrocompat):
1. **sAMAccountName** desnudo: `andres.matias`
2. **UPN**: `andres.matias@azkar.com`
3. **NetBIOS**: `AZKARAD\andres.matias`

## 2. Restricción de diseño CRÍTICA (verificada en vivo contra el AD real)

El nombre de usuario AD **NO** se puede transformar al email: `sAMAccountName ≠ local-part(UPN) ≠ local-part(mail)`. Casos reales del grupo:

| sAMAccountName | userPrincipalName | mail (en CMDB) |
|---|---|---|
| `andres.matias` | andres.matias@azkar.com | andres.matias@dachser.com |
| `miguel.poquioma` | **miguelangel**@azkar.com | miguel.poquioma@dachser.com |
| `a.juarranz` | a.juarranz@azkar.com | **alejandro.juarranz**@dachser.com |
| `javier.torres` | javier.torres@azkar.com | **javier.torres-martinez**@dachser.com |
| `jorge.espinosam` | jorge.espinosam@azkar.com | jorge.espinosa@dachser.com |

**Dominio confirmado:** NetBIOS = `AZKARAD`, DNS root / sufijo UPN = `azkar.com`.

**Corolario de diseño:** lo que el usuario teclea sirve **solo** para autenticar contra AD. El usuario de BD se resuelve SIEMPRE con la identidad **autoritativa devuelta por el directorio tras el bind** (el `sAMAccountName`), nunca con el texto tecleado. Esto resuelve de forma elegante todos los desajustes de la tabla.

## 3. Decisiones de diseño

- **D1 — Clave de mapeo estable = `sAMAccountName` (lowercased) en `ssoExternalId`, con `ssoProvider='ldap'`.** `ssoExternalId` es el campo previsto en el schema para la identidad externa (hoy guarda el email para shadow LDAP). Se cambia su semántica para LDAP a `lower(sAMAccountName)` (único en AD → respeta el índice `@unique`). No requiere migración de schema (la columna ya existe); sí actualizar el comentario en `schema.prisma` y considerar la erasure GDPR (ya anonimiza `ssoExternalId`, sigue cubierto).
- **D2 — El texto tecleado solo autentica.** Parser puro `parseLoginIdentifier()` decide el atributo de búsqueda LDAP; el `sAMAccountName` devuelto por AD es la clave de BD.
- **D3 — Sufijo UPN y dominio NetBIOS configurables por env** (`LDAP_UPN_SUFFIX`, `LDAP_NETBIOS_DOMAIN`), con derivación por defecto desde `LDAP_BASE_DN`/DNS si no se definen. No hardcodear `azkar.com`/`AZKARAD` (NIS2 portabilidad).
- **D4 — Retrocompat total.** Login por email `@dachser.com` sigue funcionando (búsqueda por `mail`). Cuentas locales `@cmdb.local`/`@cmdb.internal` siguen por bcrypt local, sin tocar.
- **D5 — Auto-sanado transitorio.** Si tras autenticar no hay fila por `ssoExternalId=lower(sam)`, se intenta match por `lower(email)=lower(mail)` y, si existe, se **actualiza** esa fila (`ssoExternalId`, `ssoProvider`) — hace el sistema resiliente aunque el backfill no cubra a alguien. Solo ocurre **después** de un bind LDAP exitoso (identidad autoritativa) → no permite secuestro de filas.
- **D6 — `username` de BD = `sAMAccountName`. [DECIDIDO: SÍ]** Para nuevos usuarios AD, `username=sam`. Para los 9 existentes, backfill de `username` a `sam` (alinea lo que teclean con lo que ven en auditoría/UI). Guardar colisiones de `username` (único) antes de aplicar.

## 4. Micro-tareas (ordenadas)

### T1 — Parser puro de identidad (nuevo módulo testeable)
- Crear `backend/src/services/ldapIdentity.ts` exportando `parseLoginIdentifier(raw): { form: 'local'|'upn'|'mail'|'sam', value, ldapAttr? }`.
- Reglas:
  - contiene `\` → NetBIOS: extraer parte tras el primer `\` → `{form:'sam', value:<sam>, ldapAttr:'sAMAccountName'}` (dominio opcionalmente validado contra `LDAP_NETBIOS_DOMAIN`).
  - contiene `@`:
    - dominio ∈ {`cmdb.local`,`cmdb.internal`} → `{form:'local', value}`.
    - dominio == `LDAP_UPN_SUFFIX` → `{form:'upn', value, ldapAttr:'userPrincipalName'}`.
    - resto → `{form:'mail', value, ldapAttr:'mail'}` (retrocompat email).
  - si no → `{form:'sam', value, ldapAttr:'sAMAccountName'}`.
- Función pura, sin I/O → unit-testeable.

### T2 — `services/ldap.ts`: autenticar por atributo correcto y devolver identidad AD
- Firmar `authenticateLDAP(username, password, usernameAttribute)` (default retro `'mail'|'sAMAccountName'`).
- Usar `authenticate({..., usernameAttribute, username: escapeLdap(value), userPassword, attributes:['sAMAccountName','userPrincipalName','mail','displayName']})`.
- Cambiar retorno de `void` a `{ sAMAccountName, userPrincipalName, mail, displayName, dn }` (extraídos del entry que devuelve la librería).
- Mantener `escapeLdap()` sobre el valor de búsqueda (A03). NetBIOS ya viene troceado por el parser (solo el `sam`).
- Mantener timeout 5s y el patrón admin-bind+search+rebind existente.

### T3 — `LoginSchema` (index.ts:339)
- Relajar `email` a identificador: `z.string().min(1).max(254)` con `.refine()` que acepte **email válido OR** `^[A-Za-z0-9._-]+$` (sam) **OR** `^[A-Za-z0-9._-]+\\[A-Za-z0-9._-]+$` (NetBIOS). Mantener límite de longitud (defensa en profundidad A03). Conservar el nombre de campo `email` (contrato con frontend intacto).

### T4 — Handler de login (index.ts:874-957)
- Sustituir `isLocalAccount` por `const id = parseLoginIdentifier(email)`; `isLocalAccount = id.form === 'local'`.
- Rama LDAP (`USE_LDAP==='true' && !isLocalAccount`):
  - `const ad = await authenticateLDAP(id.value, password, id.ldapAttr)`.
  - `const key = ad.sAMAccountName.toLowerCase()`.
  - Lookup: `SELECT ... WHERE sso_external_id = ${key} AND sso_provider = 'ldap' LIMIT 1`.
  - Si vacío y `ad.mail`: fallback `WHERE lower(email)=lower(${ad.mail})` → si existe, `UPDATE ... SET sso_external_id=${key}, sso_provider='ldap'` (+ audit `UPDATE`/`User`) y re-select.
  - Si sigue vacío: auto-aprovisionar → `username = ad.sAMAccountName`, `email = ad.mail || (ad.sAMAccountName + '@' + UPN_SUFFIX)` (email es NOT NULL), `password = bcrypt(random)`, `role='VIEWER'`, `sso_external_id=${key}`, `sso_provider='ldap'` + audit `CREATE`/`User`. Guardar colisión de `username`/`email` únicos (fallback con sufijo o error controlado 500 genérico + log interno).
- Rama local (`!ldapSuccess`) y `LDAP_STRICT_MODE`: sin cambios de lógica (usa `id.value`/`email`).
- No loguear password; mantener paridad de logging actual (info con email/sam).

### T5 — Frontend `app/login/page.tsx`
- Input línea 298: `type="email"` → `type="text"`, `autoComplete="username"`, quitar cualquier validación email-only del submit.
- Placeholder/label: usar claves i18n actualizadas (T6).

### T6 — i18n (×6: es/en/de/pt/fr/it)
- Actualizar `login.email_label` y `login.email_placeholder` a "Email o usuario" / "email o usuario AD" (o añadir claves nuevas `login.identifier_*`). Mantener las 6 en sync.

### T7 — Backfill de los 9 usuarios existentes (script único, ejecución en prod con confirmación)
- Enumerar el grupo AD (reutilizar el script de miembros) para obtener el mapa `mail → sAMAccountName`.
- Por cada usuario: `UPDATE users SET sso_external_id=lower(sam), sso_provider='ldap'[, username=lower(sam)] WHERE email=<mail>` + audit `UPDATE`/`User`. Verificar colisiones de `username` antes de tocar.
- Idempotente (no-op si ya está migrado).

### T8 — Tests
- `backend/src/services/__tests__/ldapIdentity.test.ts`: cubrir los 4 formatos + edge (local, dachser mail, netbios, sam, UPN azkar, dominio desconocido).
- (Opcional) test del mapeo de `usernameAttribute` en `authenticateLDAP` con LDAP mockeado.
- `tsc --noEmit` limpio (salvo errores license/licenseUser preexistentes).

### T9 — Docs
- Comentario de `ssoExternalId` en `schema.prisma` (semántica LDAP = sAMAccountName).
- `docs/SYSADMIN_MANUAL.md`(+`.en`): formatos de login AD soportados + nuevas vars `LDAP_UPN_SUFFIX`/`LDAP_NETBIOS_DOMAIN`.
- Declarar las 2 vars en ambos compose (opcionales, con default derivado).

## 5. Seguridad (vibesec / OWASP)

- **A03 Injection:** valores de búsqueda LDAP escapados con `escapeLdap()`; NetBIOS troceado antes de escapar; Zod con allowlist de charset + longitud.
- **A07 Auth:** el password se sigue verificando por **rebind contra AD**; rama local intacta; shadow users conservan hash bcrypt inutilizable; `LDAP_STRICT_MODE` sigue aplicando. Auto-sanado/aprovisionamiento SOLO tras bind exitoso (identidad autoritativa del directorio) → sin secuestro de filas.
- **A09 Logging:** audit `CREATE`/`UPDATE` en aprovisionamiento/upgrade; sin password en logs.
- **GDPR:** `ssoExternalId` (ahora sam) sigue cubierto por la erasure. Actualizar comentario/doc.

## 6. Verificación (DoD)

- `cd backend && npx tsc --noEmit` limpio; tests verdes.
- Rebuild backend **y frontend** (cambia login + i18n) con podman-compose; `down`/`up` completo si se añaden las 2 env vars.
- `curl -sk https://localhost/api/health` OK.
- **Matriz de login manual** (usuario `andres.matias`) — los 4 deben resolver a la MISMA fila de BD:
  1. `andres.matias` (sam) ✓
  2. `andres.matias@azkar.com` (UPN) ✓
  3. `AZKARAD\andres.matias` (NetBIOS) ✓
  4. `andres.matias@dachser.com` (email, retrocompat) ✓
  5. `claude@cmdb.local` (local) sigue funcionando ✓

## 7. Rollback

Cambios aditivos. Revertir código; el backfill es reversible (`sso_external_id`←email, `sso_provider`←NULL) aunque no es necesario.

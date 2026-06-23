# n8n — Bootstrap de aprovisionamiento (spike v3.2.0 · Task 0)

Resultado del spike: **secuencia reproducible y validada en vivo** para emitir una API key de la
API pública de n8n (`/api/v1/`) sin el wizard interactivo, desde el host (psql + `podman exec`).
Es la base de `scripts/lib/n8n-bootstrap.sh` y del módulo backend `modules/n8n-provisioning/`.

> Validado contra **n8n 1.123.27** (Queue Mode) el 2026-06-23. La key emitida autentica
> `GET /api/v1/workflows` → `200` (lista los 7 workflows).

## Hallazgos clave

1. **La API key es un JWT HS256 firmado por n8n** (campo `rawApiKey`). **No se puede falsificar
   ni insertar a mano** en `n8n_data.user_api_keys` con un valor arbitrario — hay que emitirla por
   el endpoint REST interno `POST /rest/api-keys`.
2. **`N8N_BASIC_AUTH_*` se ignora en 1.123** — la autenticación es *user management* por email
   (`userManagement.authenticationMethod = email`). El owner se gestiona en `n8n_data.user`.
3. **La API pública NO lista credenciales** (no hay scope `credential:list`/`credential:read` para
   `global:admin`; sí `credential:create`/`credential:delete`). → La **idempotencia de credenciales**
   debe leer los nombres existentes de `n8n_data.credentials_entity` directamente por Postgres
   (el backend comparte la misma BD), y luego delete+create por la API.
4. **Scopes válidos para `global:admin`** (subconjunto relevante):
   `workflow:create, workflow:read, workflow:update, workflow:delete, workflow:list,
   workflow:activate, workflow:deactivate, credential:create, credential:delete`.
   Pedir un scope fuera de la lista del rol → `400 {"message":"Invalid scopes for user role"}`.
5. **El endpoint de login** espera el campo `emailOrLdapLoginId` (no `email`).

## Secuencia validada

### Caso A — instancia n8n recién instalada (owner aún sin configurar)

`n8n_data.settings → userManagement.isInstanceOwnerSetUp = false`:

```
POST /rest/owner/setup
  { "email": "<owner>", "firstName": "...", "lastName": "...", "password": "<gen>" }
  → 200 + set-cookie (sesión)            # n8n hashea la contraseña internamente
POST /rest/api-keys   (con la cookie)
  { "label": "cmdb-provisioning", "expiresAt": null, "scopes": [ ...los 9 de arriba ] }
  → 200 { data: { rawApiKey: "<JWT>" } }
```

### Caso B — owner ya configurado (upgrade de un n8n existente) — **validado en vivo**

No conocemos la contraseña del owner humano → se crea una **identidad de aprovisionamiento**
dedicada (`global:admin`) por BD, con contraseña generada y hash bcrypt (cost 10, vía el contenedor
backend que tiene `bcryptjs`):

```sql
INSERT INTO n8n_data."user"(id,email,"firstName","lastName",password,"roleSlug",disabled,"mfaEnabled")
VALUES (gen_random_uuid(),'cmdb-provisioner@cmdb.local','CMDB','Provisioner','<bcrypt>','global:admin',false,false)
ON CONFLICT (email) DO UPDATE SET password=EXCLUDED.password, "roleSlug"='global:admin';
```
```
POST /rest/login    { "emailOrLdapLoginId": "cmdb-provisioner@cmdb.local", "password": "<gen>" }  → 200 + cookie
POST /rest/api-keys { "label": "cmdb-provisioning", "expiresAt": null, "scopes": [...] }      → 200 { data.rawApiKey }
GET  /api/v1/workflows   (header "X-N8N-API-KEY: <rawApiKey>")                                 → 200  ✓
```

## Notas de seguridad / operativa

- Las llamadas REST se ejecutan **dentro del contenedor n8n** (`podman exec cmdb-n8n-main node -e ...`),
  porque n8n no está expuesto al host (red `cmdb-internal`). El script del host orquesta; no abre puertos.
- La key (`rawApiKey`) se escribe en `.env` como `N8N_API_KEY` y **no debe loguearse**.
- La identidad `cmdb-provisioner@cmdb.local` es una cuenta `global:admin` con contraseña generada que solo
  conoce el script (en `.env` como `N8N_PROVISIONER_PASSWORD`). Es una cuenta de servicio de n8n,
  no de la CMDB.
- Idempotencia de la key: `label` fijo `cmdb-provisioning`; si ya existe se puede borrar y reemitir
  (`DELETE /rest/api-keys/:id`) para rotación controlada.

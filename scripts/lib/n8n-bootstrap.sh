#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# n8n-bootstrap.sh — Emite una API key de la API pública de n8n sin wizard.
#
# Resultado del spike v3.2.0 (Task 0). Secuencia validada contra n8n 1.123.27.
# Ver docs/n8n/PROVISIONING.md para el detalle de los hallazgos.
#
# Uso:
#   source scripts/lib/n8n-bootstrap.sh
#   API_KEY="$(n8n_ensure_owner_and_key)"
#
# Variables de entorno que consume (con defaults):
#   CTR_EXEC               comando de exec del runtime           (default: "podman exec")
#   N8N_CTR                contenedor n8n-main                    (default: cmdb-n8n-main)
#   PG_CTR                 contenedor postgres                    (default: cmdb-postgres-prod)
#   BACKEND_CTR            contenedor backend (para bcrypt)       (default: cmdb-backend-prod)
#   DB_USER / DB_NAME      credenciales psql                      (default: admin / cmdb_db)
#   N8N_OWNER_EMAIL        email del owner (caso A, fresh setup)  (default: admin@cmdb.local)
#   N8N_OWNER_PASSWORD     password del owner (caso A)            (default: generado)
#   N8N_PROVISIONER_EMAIL  identidad de servicio (caso B)         (default: cmdb-provisioner@cmdb.local)
#   N8N_PROVISIONER_PASSWORD password de la identidad (caso B)    (default: generado)
#
# Imprime SOLO la API key (rawApiKey) por stdout. Los mensajes van a stderr.
# ──────────────────────────────────────────────────────────────────────────────

n8n_bootstrap_log() { printf '[n8n-bootstrap] %s\n' "$*" >&2; }

# Scopes de la API key (válidos para global:admin / global:owner en 1.123.x).
N8N_PROVISIONING_SCOPES='["workflow:create","workflow:read","workflow:update","workflow:delete","workflow:list","workflow:activate","workflow:deactivate","credential:create","credential:delete"]'

# Devuelve "true"/"false" según si el owner de la instancia ya está configurado.
_n8n_owner_is_set_up() {
  local ctr_exec="${CTR_EXEC:-podman exec}" pg="${PG_CTR:-cmdb-postgres-prod}"
  local du="${DB_USER:-admin}" dn="${DB_NAME:-cmdb_db}"
  $ctr_exec "$pg" psql -U "$du" -d "$dn" -tAc \
    "SELECT value FROM n8n_data.settings WHERE key='userManagement.isInstanceOwnerSetUp';" 2>/dev/null \
    | tr -d '[:space:]'
}

# bcrypt hash (cost 10) de una contraseña, vía el contenedor backend.
# El backend trae `bcrypt` (nativo); algunos entornos `bcryptjs`. Se prueban ambos.
# n8n verifica indistintamente hashes $2a$/$2b$ de cualquiera de las dos libs.
_n8n_bcrypt() {
  local ctr_exec="${CTR_EXEC:-podman exec}" be="${BACKEND_CTR:-cmdb-backend-prod}" pwd="$1"
  $ctr_exec -e BCRYPT_PWD="$pwd" "$be" node -e \
    'let b; try{b=require("bcrypt")}catch(e){b=require("bcryptjs")} console.log(b.hashSync(process.env.BCRYPT_PWD,10))' 2>/dev/null
}

# Núcleo: ejecuta login/owner-setup + creación de la key DENTRO del contenedor n8n
# (n8n no está expuesto al host). Recibe el modo y las credenciales por env.
# Imprime el rawApiKey por stdout.
_n8n_mint_key() {
  local ctr_exec="${CTR_EXEC:-podman exec}" n8n="${N8N_CTR:-cmdb-n8n-main}"
  # MODE=setup|login ; EMAIL/PASSWORD ; SCOPES
  $ctr_exec \
    -e MODE="$1" -e N8N_EMAIL="$2" -e N8N_PASSWORD="$3" \
    -e N8N_FIRST="${4:-CMDB}" -e N8N_LAST="${5:-Provisioner}" \
    -e N8N_SCOPES="$N8N_PROVISIONING_SCOPES" \
    "$n8n" node -e '
    (async () => {
      const base = "http://localhost:5678";
      let cookie;
      if (process.env.MODE === "setup") {
        const r = await fetch(base + "/rest/owner/setup", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: process.env.N8N_EMAIL, firstName: process.env.N8N_FIRST,
                                 lastName: process.env.N8N_LAST, password: process.env.N8N_PASSWORD }) });
        if (!r.ok) { console.error("owner/setup -> " + r.status + " " + (await r.text()).slice(0,200)); process.exit(2); }
        cookie = (r.headers.get("set-cookie") || "").split(";")[0];
      } else {
        const r = await fetch(base + "/rest/login", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ emailOrLdapLoginId: process.env.N8N_EMAIL, password: process.env.N8N_PASSWORD }) });
        if (!r.ok) { console.error("login -> " + r.status + " " + (await r.text()).slice(0,200)); process.exit(3); }
        cookie = (r.headers.get("set-cookie") || "").split(";")[0];
      }
      const k = await fetch(base + "/rest/api-keys", {
        method: "POST", headers: { "Content-Type": "application/json", "Cookie": cookie },
        body: JSON.stringify({ label: "cmdb-provisioning", expiresAt: null, scopes: JSON.parse(process.env.N8N_SCOPES) }) });
      if (!k.ok) { console.error("api-keys -> " + k.status + " " + (await k.text()).slice(0,200)); process.exit(4); }
      const j = await k.json();
      const key = j && j.data && j.data.rawApiKey;
      if (!key) { console.error("api-keys: rawApiKey ausente"); process.exit(5); }
      process.stdout.write(key);
    })().catch(e => { console.error("ERR " + e.message); process.exit(1); });
    '
}

# Garantiza owner/identidad de servicio y devuelve una API key válida por stdout.
n8n_ensure_owner_and_key() {
  local ctr_exec="${CTR_EXEC:-podman exec}" pg="${PG_CTR:-cmdb-postgres-prod}"
  local du="${DB_USER:-admin}" dn="${DB_NAME:-cmdb_db}"
  local set_up; set_up="$(_n8n_owner_is_set_up)"

  if [ "$set_up" != "true" ]; then
    # ── Caso A: instalación nueva — owner/setup (n8n hashea la contraseña) ──
    local oe="${N8N_OWNER_EMAIL:-admin@cmdb.local}"
    local op="${N8N_OWNER_PASSWORD:-$(openssl rand -base64 18)Aa1!}"
    n8n_bootstrap_log "Owner no configurado → owner/setup ($oe)"
    _n8n_mint_key setup "$oe" "$op"
  else
    # ── Caso B: owner ya existe — identidad de servicio global:admin por BD ──
    local pe="${N8N_PROVISIONER_EMAIL:-cmdb-provisioner@cmdb.local}"
    local pp="${N8N_PROVISIONER_PASSWORD:-$(openssl rand -base64 18)Aa1!}"
    n8n_bootstrap_log "Owner ya configurado → identidad de servicio ($pe)"
    local hash; hash="$(_n8n_bcrypt "$pp")"
    if [ -z "$hash" ]; then n8n_bootstrap_log "ERROR: no se pudo hashear (¿backend arrancado?)"; return 1; fi
    $ctr_exec "$pg" psql -U "$du" -d "$dn" -v ON_ERROR_STOP=1 -c \
      "INSERT INTO n8n_data.\"user\"(id,email,\"firstName\",\"lastName\",password,\"roleSlug\",disabled,\"mfaEnabled\")
       VALUES (gen_random_uuid(),'$pe','CMDB','Provisioner','$hash','global:admin',false,false)
       ON CONFLICT (email) DO UPDATE SET password=EXCLUDED.password, \"roleSlug\"='global:admin';" >/dev/null 2>&1 \
      || { n8n_bootstrap_log "ERROR: upsert de la identidad de servicio falló"; return 1; }

    # #181 — n8n 1.123.x exige que el usuario tenga un "personal project" para crear
    # credenciales vía API. El INSERT directo del usuario (arriba) se salta el hook que
    # normalmente lo crea, así que lo creamos a mano. Idempotente (guard-then-insert).
    # NOTA: una primera versión de este bloque usaba `psql -c "..."` con `:'var'`;
    # verificado en vivo contra esta imagen de postgres (15.18 Debian) que esa forma
    # concreta no sustituía las variables (aislado con `\echo :x` vs `SELECT :x;` — el
    # primero sí sustituye, el segundo daba "syntax error near :"), mientras que la misma
    # consulta por stdin sí sustituye correctamente. No se determinó la causa exacta (no
    # es un límite documentado de psql) — se alimenta por stdin (heredoc) en su lugar,
    # con `-i` en el exec para que el contenedor reciba ese stdin, forma verificada.
    local _proj_id; _proj_id="$(openssl rand -hex 8)"   # 16 chars, válido para project.id (varchar 36)
    # SQL sin secretos (solo email + project id) — capturamos stderr para diagnóstico:
    # #181 fue precisamente un fallo silencioso de aprovisionamiento, no repetir el patrón.
    local _proj_err
    _proj_err="$($ctr_exec -i "$pg" psql -U "$du" -d "$dn" -v ON_ERROR_STOP=1 \
      -v pemail="$pe" -v pid="$_proj_id" 2>&1 >/dev/null <<'SQL'
WITH u AS (SELECT id FROM n8n_data."user" WHERE email = :'pemail'),
     existing AS (
       SELECT pr."projectId" FROM n8n_data.project_relation pr
       JOIN u ON u.id = pr."userId"
       WHERE pr.role = 'project:personalOwner'
     ),
     new_proj AS (
       INSERT INTO n8n_data.project (id, name, type, "createdAt", "updatedAt")
       SELECT :'pid', 'CMDB Provisioner <' || :'pemail' || '>', 'personal', now(), now()
       WHERE NOT EXISTS (SELECT 1 FROM existing)
       RETURNING id
     )
INSERT INTO n8n_data.project_relation ("projectId", "userId", role, "createdAt", "updatedAt")
SELECT np.id, u.id, 'project:personalOwner', now(), now()
FROM new_proj np, u
WHERE NOT EXISTS (SELECT 1 FROM existing);
SQL
    )"
    if [ $? -ne 0 ]; then
      n8n_bootstrap_log "ERROR: no se pudo crear el personal project del provisioner (#181): ${_proj_err}"
      return 1
    fi
    n8n_bootstrap_log "Personal project del provisioner garantizado (#181)"
    _n8n_mint_key login "$pe" "$pp"
  fi
}

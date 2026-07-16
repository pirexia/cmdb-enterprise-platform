# n8n Troubleshooting — CMDB Enterprise Platform

> Incidencias documentadas y resueltas. Cada entrada incluye síntoma, causa raíz y solución.

---

## INC-001 — Workflows no aprovisionados / fallan al arrancar (v3.3.0)

**Síntoma:** Los workflows n8n (Alertas CMDB, Mantenimiento CMDB, Backup CMDB, etc.) no aparecen en la UI de n8n tras instalar o actualizar. El log del backend muestra:

```
[n8n-provisioning] N8N_API_KEY no configurada; aprovisionamiento omitido.
```

O el dashboard de n8n muestra múltiples ejecuciones con estado `Error`.

**Causa raíz:** Dos problemas encadenados:

1. **BUG-004** — `N8N_API_KEY` y `N8N_INTERNAL_URL` no estaban declaradas en la sección `environment` del servicio `backend` en `docker-compose.yml` y `docker-compose.prod.yml`. El módulo `n8n-provisioning` las lee de `process.env` y no las encontraba → aprovisionamiento desactivado.

2. **BUG-002** (relacionado) — `N8N_API_KEY` debe generarse vía `scripts/lib/n8n-bootstrap.sh` DESPUÉS de que n8n esté healthy. Si el bootstrap se salta (primer arranque sin key), los workflows nunca se crean.

**Corrección permanente:** Commits `85500e6` (compose) + bootstrap docs (ver abajo). Corregido en v3.3.0.

**Solución manual (si los workflows no aparecen):**

```bash
# Paso 1: generar N8N_API_KEY (si no existe)
source scripts/lib/n8n-bootstrap.sh
export PG_CTR=cmdb-postgres      # dev
export BACKEND_CTR=cmdb-backend  # dev
# En prod: cmdb-postgres-prod, cmdb-backend-prod
KEY=$(n8n_ensure_owner_and_key 2>/dev/null)

# Paso 2: escribir en .env
if grep -q "^N8N_API_KEY=" .env; then
  sed -i "s|^N8N_API_KEY=.*|N8N_API_KEY=${KEY}|" .env
else
  sed -i "/^N8N_ENCRYPTION_KEY=/a N8N_API_KEY=${KEY}" .env
fi

# Paso 3: recrear backend para que tome la nueva key
podman-compose up -d --force-recreate backend  # dev
# o en prod:
podman-compose -f docker-compose.prod.yml up -d --force-recreate backend

# Paso 4: verificar aprovisionamiento
sleep 20 && podman logs cmdb-backend | grep n8n-provisioning
# Debe mostrar: "aprovisionamiento completado. creds=... wfs=..."

# Alternativamente: usar el botón "Resincronizar n8n" en Configuración → pestaña n8n (ADMIN)
```

**Si bootstrap falla con "There is already an entry with this name":**

La key ya fue creada en un arranque anterior pero no se guardó en `.env`. El bootstrap creó el usuario `cmdb-provisioner@cmdb.local`. Para obtener una nueva key con nombre diferente:

```bash
# Opción A: eliminar la key existente desde n8n UI (Settings → API → eliminar "cmdb-provisioner")
# y re-ejecutar el bootstrap

# Opción B: ejecutar el bootstrap con un label diferente editando la variable
# N8N_PROVISIONING_SCOPES en n8n-bootstrap.sh (cambiar el label)
```

---

## INC-002 — 502 Bad Gateway en nginx (DNS resolver timeout)

**Síntoma:** Todas las rutas devuelven 502. Logs de nginx muestran:

```
backend could not be resolved (110: Operation timed out)
```

**Causa raíz:** El resolver DNS en `nginx/conf.d/frontend.conf` tiene la IP hardcodeada. Si el stack se levanta en una red Podman con subnet diferente, la IP es incorrecta.

**Diagnóstico:**

```bash
podman exec cmdb-nginx cat /etc/resolv.conf
# → nameserver 10.89.0.1   (dev) o distinta en prod
grep "resolver" nginx/conf.d/frontend.conf
# → debe coincidir
```

**Solución:**

```bash
# Obtener IP correcta del DNS
DNS_IP=$(podman exec cmdb-nginx cat /etc/resolv.conf | grep nameserver | awk '{print $2}')
# Actualizar frontend.conf
sed -i "s|resolver [0-9.]* valid|resolver ${DNS_IP} valid|" nginx/conf.d/frontend.conf
podman exec cmdb-nginx nginx -t && podman exec cmdb-nginx nginx -s reload
```

**Corrección permanente:** Corregido en commit `d04b9f8` (v3.3.0): resolver actualizado a `10.89.0.1` (red dev `cmdb-network`). En prod verificar con `podman exec cmdb-nginx-prod cat /etc/resolv.conf`.

---

## INC-003 — Ejecuciones n8n acumuladas (miles de registros)

**Síntoma:** Dashboard n8n muestra miles de ejecuciones. La tabla `n8n_data.execution_entity` crece sin límite, especialmente con "RAG Indexing" (cada 30s).

**Causa raíz:** `docker-compose.yml` (dev) no tenía variables `EXECUTIONS_DATA_*`. En prod ya estaba correctamente configurado.

**Verificación:**

```bash
podman exec cmdb-postgres psql -U admin -d cmdb_db \
  -c "SELECT count(*) FROM n8n_data.execution_entity;"
```

**Solución de emergencia (purga manual):**

```bash
# Borrar ejecuciones exitosas antiguas (> 24h)
podman exec cmdb-postgres psql -U admin -d cmdb_db -c "
  DELETE FROM n8n_data.execution_entity
  WHERE status = 'success' AND \"startedAt\" < now() - interval '24 hours';
"
```

**Corrección permanente:** Commit `0c7abc4` (v3.3.0) — añadidas `EXECUTIONS_DATA_PRUNE=true`, `MAX_AGE=24h`, `SAVE_ON_SUCCESS=none` en dev compose.

---

## INC-004 — API key desincronizada / Authorization fallos en aprovisionamiento (v3.5.4)

**Síntoma:** El aprovisionamiento falla al arrancar. Los logs del backend muestran:

```
[n8n-provisioning] aborting: n8n rechazó la API key (HTTP 401)
```

O al hacer clic en "Resincronizar n8n" (Configuración → pestaña n8n), el backend retorna:

```
502 Bad Gateway
{"error": "n8n rechazó la API key (HTTP 401)"}
```

**Causa raíz:** La variable `N8N_API_KEY` en `.env` está desincronizada respecto a la key activa almacenada en n8n. Esto ocurre cuando:

1. La key fue eliminada manualmente en n8n (Settings → API).
2. Se restauró una BD n8n de un backup más antiguo que el `.env` actual.
3. Se migró el stack a otro servidor sin copiar `.env` completo.

**Corrección permanente (v3.5.4):** Commits `187659e`, `002e6d1`, `dca2109`, `f8cfcda`. El módulo `n8n-provisioning` ahora detecta 401/403 al instante, falla rápido, y registra un error accionable. `POST /api/admin/n8n/resync` retorna `502 { error: "..." }` en lugar de un 500 genérico.

**Solución manual (regenerar la key):**

Sigue **exactamente los pasos de INC-001, "Solución manual (si los workflows no aparecen)"**. El procedimiento `n8n_ensure_owner_and_key` genera una nueva API key alineada con n8n y actualiza `.env`.

```bash
# Paso 1-4 de INC-001:
source scripts/lib/n8n-bootstrap.sh
# ... (seguir instrucciones completas)
```

**Verificación rápida tras la regeneración:**

```bash
# El log debe mostrar:
podman logs cmdb-backend 2>&1 | grep "\[n8n-provisioning\]" | tail -5
# → "aprovisionamiento completado. creds=... wfs=..."

# Y en la UI: Configuración → n8n debe mostrar "✓ Conectado"
```

---

## INC-005 — n8n no disponible tras múltiples reintentos (arranque en frío) (v3.5.4)

**Síntoma:** Al ejecutar `docker compose down && docker compose up -d` (o equivalente en podman), el backend intenta conectar a n8n durante 60s pero falla antes de que n8n esté listo. Los logs muestran:

```
[n8n-provisioning] n8n no disponible tras 10 intentos. Continuando sin provisioning.
```

La aplicación arranca pero n8n no se provisiona (workflows no aparecen).

**Causa raíz:** En un arranque completo en frío, `n8n-main` puede tardar más de 60 segundos en ser saludable. El módulo `n8n-provisioning` usa una ventana de reintento de 10 intentos × 6 segundos = 60s, que puede quedar corta si el stack tiene carga alta o recursos limitados.

**Corrección permanente (v3.5.4):** Commit `...` — la ventana de reintento se amplió a 15 intentos × 8 segundos = **120 segundos**. Un bloque `healthcheck` se añadió al servicio `n8n-main` en ambos `docker-compose.yml` y `docker-compose.prod.yml` (para observabilidad; no se configura como dependencia del backend, por diseño — ver abajo).

**Por qué `depends_on: n8n-main` service_healthy NO está configurado:**

Hacer que el backend dependa de que n8n esté healthy violaría la restricción ISO 22301 / NIS2 del proyecto: "sin puntos únicos de fallo en servicios opcionales". n8n es una integración OPCIONAL (controlada por variables `VCENTER_*`, `SMTP_*`, etc., todas opcionales). Forzar que el backend espere a n8n haría que cualquier problema con n8n bloqueara el arranque de todo el core CMDB, violando la disponibilidad. **Esta decisión fue evaluada deliberadamente y rechazada.**

**Mitigación operativa si n8n no se provisiona a tiempo:**

1. Espera 2 minutos completos tras ejecutar `docker compose up -d` antes de usar n8n.
2. Usa el botón **"Resincronizar n8n"** en Configuración → pestaña n8n (ADMIN only). Retentará con la ventana ampliada de 120s.
3. Si la resincronización falla, verifica que n8n esté saludable:
   ```bash
   curl -s http://localhost:5678/healthz | python3 -m json.tool
   # Debe retornar: {"status": "ok"}
   ```
4. Si `healthz` retorna error, revisa los logs de n8n:
   ```bash
   podman logs cmdb-n8n-main | tail -30
   ```

**Verificación rápida tras el arranque estable:**

```bash
# Luego de 120+ segundos, verifica que los workflows están activos:
podman exec cmdb-backend bash -c 'grep "aprovisionamiento completado" <(podman logs cmdb-backend 2>&1)' || echo "Aún no aprovisionado; espera 30s e intenta el botón Resincronizar"
```

---

## Verificación rápida del estado de n8n

```bash
# Health check
curl -s http://localhost:5678/healthz | python3 -m json.tool

# Listar workflows (requiere N8N_API_KEY en .env)
N8N_API_KEY=$(grep "^N8N_API_KEY=" .env | cut -d= -f2-)
curl -s -H "X-N8N-API-KEY: $N8N_API_KEY" \
  "http://localhost:5678/api/v1/workflows?limit=20" | \
  python3 -c "import sys,json; [print(w['name'], '|', w['active']) for w in json.load(sys.stdin).get('data',[])]"

# Últimas 10 ejecuciones con errores
curl -s -H "X-N8N-API-KEY: $N8N_API_KEY" \
  "http://localhost:5678/api/v1/executions?status=error&limit=10" | \
  python3 -c "import sys,json; [print(e.get('workflowData',{}).get('name','?'), '|', e.get('startedAt')) for e in json.load(sys.stdin).get('data',[])]"

# Logs del aprovisionamiento
podman logs cmdb-backend 2>&1 | grep "\[n8n-provisioning\]"
```

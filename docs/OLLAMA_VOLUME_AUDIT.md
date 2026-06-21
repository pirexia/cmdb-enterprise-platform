# Auditoría de Persistencia del Volumen Ollama

**Fecha:** 2026-06-21  
**Contenedor auditado:** `cmdb-ollama-prod`  
**Estado:** Informe técnico — ningún cambio realizado en esta tarea

---

## 1. Estado actual

### Tipo de almacenamiento

| Campo | Valor |
|-------|-------|
| Tipo | **Bind mount** (no volumen nombrado, no anónimo) |
| Origen en el host | `/opt/cmdb-data/ollama-models` |
| Destino en el contenedor | `/root/.ollama/models` |
| Permisos | Read-Write (`RW: true`) |
| Propagación | `rprivate` |
| Filesystem del host | `/dev/mapper/vg00-opt` (LVM) |

```
# De docker inspect cmdb-ollama-prod
{
  "Type": "bind",
  "Source": "/opt/cmdb-data/ollama-models",
  "Destination": "/root/.ollama/models",
  "RW": true,
  "Propagation": "rprivate"
}
```

### Modelos descargados

| Ubicación en host | Manifiestos detectados |
|------------------|----------------------|
| `/opt/cmdb-data/ollama-models/manifests/` | `7b-instruct-q4_K_M`, `latest` (×2) |
| Blobs totales | 13 archivos SHA-256 |

Modelos identificados (por manifiestos):
- `bge-m3:latest` — modelo de embeddings
- `qwen3:latest` — modelo de chat (migrado de qwen2.5 en v2.9.2)
- `qwen2.5:7b-instruct-q4_K_M` — modelo de chat legado (puede borrarse si ya no se usa)

### Espacio en disco

| Métrica | Valor |
|---------|-------|
| Tamaño total de modelos | **11 GB** |
| Filesystem (`/opt`) | `/dev/mapper/vg00-opt`, 23 GB total |
| Espacio usado en `/opt` | 3.0 GB (14%) |
| Espacio libre en `/opt` | **20 GB** |
| Espacio libre tras modelos | ~9 GB disponibles para crecimiento |

---

## 2. Análisis de riesgo

### ✅ Riesgo de pérdida de modelos al recrear el contenedor: BAJO

El bind mount a `/opt/cmdb-data/ollama-models` **persiste independientemente del ciclo de vida del contenedor**. Si se ejecuta:

```bash
podman-compose -f docker-compose.prod.yml down
podman-compose -f docker-compose.prod.yml up -d
```

Los modelos **no se pierden** porque están en el host, no en el layer del contenedor. Esto ya estaba correctamente configurado antes de v3.0.0.

**Comparación dev vs prod:**

| Entorno | Tipo | Ruta | Persistente |
|---------|------|------|-------------|
| Dev (`docker-compose.yml`) | Named volume `ollama-models` | `/home/cmdb-admin/.local/share/containers/storage/volumes/cmdb-enterprise-platform_ollama-models/` | ✅ Sí |
| Prod (`docker-compose.prod.yml`) | Bind mount | `/opt/cmdb-data/ollama-models` | ✅ Sí |

### ⚠️ Riesgos residuales

| Riesgo | Probabilidad | Impacto | Mitigación |
|--------|-------------|---------|-----------|
| Borrado manual de `/opt/cmdb-data/ollama-models` | Baja | Alto (re-descarga 11 GB, tiempo ~30 min) | Permisos restrictivos + backup en T7 |
| Llenado del filesystem `/opt` (20 GB libres) | Media si se descargan modelos grandes | Alto (Ollama falla) | Monitorizar con `df -h /opt`; `/opt` en LVM expandible |
| Modelo legado `qwen2.5:7b-instruct-q4_K_M` ocupa espacio sin uso | Alta | Bajo | Ejecutar `ollama rm qwen2.5:7b-instruct-q4_K_M` cuando se confirme que no se usa |

---

## 3. Recomendaciones técnicas

### R1 — Incluir el directorio de modelos en el backup automatizado (Tarea 7)
El directorio `/opt/cmdb-data/ollama-models` (11 GB) debe incluirse en el backup de T7. Estrategia sugerida:
- **Full mensual** + **incremental diario** (los modelos cambian pocas veces al mes).
- O documentar que, ante un desastre, se re-descargan con `ollama pull bge-m3 && ollama pull qwen3:latest` (~30 min).
- **Decisión del usuario:** ¿incluir modelos en backup completo o documentar re-descarga?

### R2 — Limpiar modelo legado
```bash
podman exec cmdb-ollama-prod ollama rm qwen2.5:7b-instruct-q4_K_M
```
Libera ~4.5 GB en `/opt`.

### R3 — Monitorización de espacio `/opt`
Añadir al script de mantenimiento o al workflow de backup de n8n:
```bash
df -h /opt | awk 'NR==2 {if (int($5) > 80) print "WARNING: /opt at " $5 " capacity"}'
```

### R4 — Estandarización (opcional)
En el futuro podría convertirse a named volume de Podman para consistencia con el resto de volúmenes. No es urgente: el bind mount actual funciona correctamente.

---

## 4. Impacto en Tarea 7 (Backup)

Dado que **los modelos ya están persistentes** en el host (no en el contenedor), el backup de Tarea 7 debe:

1. **Opción A (recomendada para instalaciones con ancho de banda limitado):** Excluir modelos del backup automatizado. Documentar en `BACKUP_RESTORE_GUIDE.md` que ante un desastre total se re-descargan con dos comandos `ollama pull`. Ahorra 11 GB por backup.

2. **Opción B (recomendada si el destino de backup tiene espacio suficiente):** Incluir `/opt/cmdb-data/ollama-models` en el backup completo mensual. Los incrementales diarios solo incluirán cambios (prácticamente ninguno si no se descargan modelos nuevos).

> **Decisión diferida al usuario al finalizar v3.0.0.** El workflow de backup (T7) implementará Opción A por defecto, con documentación de re-descarga, e incluirá la ruta de modelos como variable configurable (`BACKUP_INCLUDE_OLLAMA_MODELS=false`).

---

## 5. Resumen ejecutivo

| Pregunta | Respuesta |
|----------|-----------|
| ¿Los modelos se perderían con `down`+`up`? | **No** — bind mount persiste en host |
| ¿Tipo de almacenamiento actual? | Bind mount `/opt/cmdb-data/ollama-models` |
| ¿Espacio ocupado? | **11 GB** (bge-m3 + qwen3 + qwen2.5 legado) |
| ¿Espacio libre en el filesystem? | **20 GB** libres en `/opt` |
| ¿Riesgo actual? | **Bajo** — ningún cambio urgente necesario |
| ¿Cambios recomendados inmediatos? | Limpiar modelo legado (R2), monitorizar espacio (R3) |
| ¿Cambios en compose necesarios? | No — la configuración actual es correcta |

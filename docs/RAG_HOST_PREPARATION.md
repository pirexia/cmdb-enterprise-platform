# Preparación del servidor para el subsistema RAG

**Aplica a:** CMDB Enterprise Platform v2.3+
**SO objetivo:** Red Hat Enterprise Linux 9 sobre VMware ESXi 8.0
**Ultima validacion:** 2026-05-20 en lx-gest01p.svc.int
**Estado:** Validado en produccion: 2026-05-20

---

## Indice

1. [Requisitos previos](#1-requisitos-previos)
2. [Dimensionamiento recomendado](#2-dimensionamiento-recomendado)
3. [Ajustes en vCenter / vSphere](#3-ajustes-en-vcenter--vsphere)
4. [Verificacion de AMX dentro del guest](#4-verificacion-de-amx-dentro-del-guest)
5. [Extension de almacenamiento (LVM)](#5-extension-de-almacenamiento-lvm)
6. [Actualizacion del sistema e instalacion de Podman](#6-actualizacion-del-sistema-e-instalacion-de-podman)
7. [Ajustes del kernel y limites del sistema](#7-ajustes-del-kernel-y-limites-del-sistema)
8. [Firewall](#8-firewall)
9. [Verificacion del runtime de contenedores (Podman)](#9-verificacion-del-runtime-de-contenedores-podman)
10. [Estructura de directorios persistentes](#10-estructura-de-directorios-persistentes)
11. [Verificacion final](#11-verificacion-final)
- [Apendice A — Consideraciones de SELinux](#apendice-a--consideraciones-de-selinux)
- [Apendice B — Dimensionamiento de modelos LLM](#apendice-b--dimensionamiento-de-modelos-llm)
- [Apendice C — Troubleshooting](#apendice-c--troubleshooting)
- [Apendice D — Controles normativos](#apendice-d--controles-normativos)

---

## 1. Requisitos previos

Antes de comenzar, verificar que se cumplen todos los puntos siguientes:

1. Acceso root o sudo a la VM de destino.
2. La VM esta alojada en un host VMware ESXi 8.0.3 o superior con CPU Intel Xeon "Sapphire Rapids" (Gold 6526Y o equivalente).
3. La VM tiene hardware version v21 o superior (necesario para exponer AMX al guest).
4. Suscripcion activa de RHEL 9 (`subscription-manager status` muestra `Current`).
5. Acceso a internet desde la VM para descargar paquetes de los repositorios RHEL y las imagenes de contenedor.
6. Un disco adicional de al menos 150 GiB disponible y visible en la VM (se usara en §5).
7. El instalador ha completado previamente los pasos de §0–§3 del `SYSADMIN_MANUAL.md` para la plataforma base.

---

## 2. Dimensionamiento recomendado

La tabla siguiente refleja tres perfiles de despliegue. El perfil "Recomendado" corresponde al servidor validado (`lx-gest01p.svc.int`).

| Parametro           | Minimo (PoC)                | Recomendado (CPU+AMX)            | Optimo (GPU)                          |
|---------------------|-----------------------------|-----------------------------------|---------------------------------------|
| vCPU                | 8                           | 12                                | 8                                     |
| RAM                 | 16 GiB                      | 32 GiB                            | 24 GiB                                |
| Disco total         | 100 GB                      | 250 GB                            | 200 GB                                |
| Acelerador          | Sin GPU                     | Sin GPU (AMX activo)              | NVIDIA T4 / A10 >= 8 GB VRAM          |
| Modelo LLM          | qwen2.5:3b-instruct-q4_K_M  | qwen2.5:7b-instruct-q4_K_M        | qwen2.5:7b-instruct-q4_K_M            |
| Usuarios concurrentes | 1                         | 5–10                              | 20+                                   |
| Rendimiento aprox.  | ~25–35 tok/s                | ~12–18 tok/s, TTFT 1–2 s          | ~50–80 tok/s (GPU offload completo)   |

> **Nota sobre rendimiento:** Con AMX activo (perfil recomendado), se obtienen ~12–18 tok/s y un tiempo hasta el primer token (TTFT) de 1–2 segundos, con respuesta completa en ~10–18 segundos. Sin AMX (solo AVX-512), la velocidad cae a ~6–9 tok/s y la respuesta completa tarda ~18–35 segundos.

> **OCR de documentos escaneados (v2.3.2+):** Tesseract 5 y poppler-utils están incluidos en la imagen Docker del backend — **no se requiere instalación adicional en el host**. El OCR es puramente CPU (no necesita GPU ni AMX). Rendimiento orientativo con el perfil recomendado: ~8 s/página a 300 DPI. Sin impacto en el dimensionamiento de hardware.

---

## 3. Ajustes en vCenter / vSphere

Estos pasos se realizan desde la consola de vCenter. La VM puede estar apagada o, si hot-add esta habilitado, en caliente para los cambios de CPU/RAM. El cambio de `cpuid.enableAMX` requiere la VM apagada.

1. Abrir vCenter → seleccionar la VM → **Editar configuracion**.
2. Subir la version de hardware a **v21**:
   - Ir a **Configuration Parameters** (Parametros de configuracion avanzada).
   - Anadir o modificar: `vmx.version = "vmx-21"`.
   - Este paso requiere que la VM este apagada.
3. Configurar los recursos de CPU:
   - Establecer **12 vCPU** (o el numero definido en §2 segun el perfil elegido).
   - Activar la opcion **"Exponer hardware CPU al SO invitado"** (host CPU passthrough). Esta opcion expone las flags de CPU del host fisico directamente al guest, incluyendo AMX.
4. Configurar la memoria: establecer **32 GiB** (o el valor del perfil elegido).
5. Anadir un disco nuevo de **150 GiB**:
   - Seleccionar **Thin Provision** en el mismo datastore.
   - Este disco se particionara en §5 para los LVs `containers` y `cmdbdata`.
6. Habilitar AMX explicitamente:
   - En **Configuration Parameters**, anadir: `cpuid.enableAMX = "TRUE"`.
7. Guardar los cambios y arrancar la VM.

---

## 4. Verificacion de AMX dentro del guest

Una vez arrancada la VM con los cambios de §3, verificar que AMX es visible desde el SO.

1. Comprobar la presencia del flag `amx_tile` en `/proc/cpuinfo`:

```bash
grep -c amx_tile /proc/cpuinfo && echo "AMX activo: OK" || echo "AMX no detectado — revisar §3"
```

2. Ver todos los flags AMX disponibles:

```bash
lscpu | grep -E 'amx_tile|amx_bf16|amx_int8'
```

   La salida esperada incluye las tres flags: `amx_tile`, `amx_bf16`, `amx_int8`. La presencia de `amx_bf16` es especialmente relevante para la inferencia de modelos en punto flotante de 16 bits.

3. Si AMX no aparece pero el host tiene CPU Sapphire Rapids, seguir estos pasos de correccion:
   - Apagar la VM completamente (no suspender).
   - En vCenter: **Editar** → **Configuration Parameters** → verificar que `cpuid.enableAMX = "TRUE"` esta presente y guardado.
   - Verificar que la version de hardware es v21 o superior.
   - Comprobar que el modo EVC del cluster (si aplica) es **Sapphire Rapids** o superior, o que EVC esta desactivado. Un modo EVC mas bajo enmascara las flags de CPU avanzadas.
   - Encender la VM y repetir los comandos anteriores.

---

## 5. Extension de almacenamiento (LVM)

La siguiente secuencia ha sido validada en produccion en `lx-gest01p.svc.int`. Se crean dos LVs dedicadas: `containers` (100 GB, punto de montaje `/var/lib/containers`) y `cmdbdata` (70 GB, punto de montaje `/opt/cmdb-data`).

> **Precaucion:** Los comandos `lvremove` son destructivos. Verificar cuidadosamente que los LVs listados no tienen sistema de ficheros ni punto de montaje activo antes de borrarlos.

1. Realizar un backup de la configuracion del grupo de volumenes:

```bash
vgcfgbackup vg00 -f /root/vg00-backup-$(date +%F).cfg
```

2. Verificar que los LVs a eliminar estan realmente huerfanos (sin FS activo ni montaje). Ejecutar para cada LV:

```bash
for lv in lv_root lv_home lv_usr lv_var lv_opt lv_tmp; do
  wipefs -n /dev/vg00/$lv 2>/dev/null
  blkid /dev/vg00/$lv 2>/dev/null
done
```

   Si todos los comandos devuelven salida vacia (sin UUID, sin tipo de FS), los LVs estan huerfanos y pueden eliminarse con seguridad.

3. Eliminar los LVs huerfanos para liberar espacio en el VG:

```bash
lvremove -y /dev/vg00/lv_root /dev/vg00/lv_home /dev/vg00/lv_usr \
            /dev/vg00/lv_var  /dev/vg00/lv_opt  /dev/vg00/lv_tmp
```

4. Identificar el disco nuevo anadido en §3 (ajustar el nombre de dispositivo segun la salida de `lsblk`):

```bash
lsblk
# Identificar el disco nuevo, tipicamente /dev/sde, sin tabla de particiones
```

5. Anadir el disco nuevo al VG existente:

```bash
pvcreate /dev/sde
vgextend vg00 /dev/sde
vgs
```

6. Crear los LVs dedicados al subsistema RAG:

```bash
lvcreate -L 100G -n containers vg00
lvcreate -L  70G -n cmdbdata   vg00
```

7. Formatear ambos LVs con XFS:

```bash
mkfs.xfs -f /dev/vg00/containers
mkfs.xfs -f /dev/vg00/cmdbdata
```

8. Crear los puntos de montaje:

```bash
mkdir -p /var/lib/containers /opt/cmdb-data
```

9. Persistir los montajes en `/etc/fstab` usando UUID (inmune a reordenaciones de dispositivos):

```bash
UUID_CONT=$(blkid -s UUID -o value /dev/vg00/containers)
UUID_DATA=$(blkid -s UUID -o value /dev/vg00/cmdbdata)
cp /etc/fstab /etc/fstab.bak.$(date +%F)
echo "UUID=$UUID_CONT /var/lib/containers xfs defaults,nofail 0 2" >> /etc/fstab
echo "UUID=$UUID_DATA /opt/cmdb-data      xfs defaults,nofail 0 2" >> /etc/fstab
```

10. Aplicar los nuevos montajes y verificar:

```bash
mount -a && systemctl daemon-reload && mount -a
df -h | grep -E 'containers|cmdb-data'
```

   La salida debe mostrar ambos puntos de montaje con el tamano correcto (~107 GiB para `containers` y ~75 GiB para `cmdb-data`, incluyendo metadatos XFS).

---

## 6. Actualizacion del sistema e instalacion de Podman

1. Verificar que la suscripcion RHEL esta activa:

```bash
subscription-manager status
```

2. Actualizar todos los paquetes del sistema:

```bash
dnf -y update
```

3. Instalar Podman y las herramientas de soporte para contenedores:

```bash
dnf -y install podman podman-compose podman-docker buildah skopeo \
              crun fuse-overlayfs slirp4netns container-selinux \
              policycoreutils-python-utils git jq curl tar bash-completion
```

4. Verificar las versiones instaladas:

```bash
podman --version   # Debe ser >= 4.9
podman-compose --version
```

   Podman >= 4.9 es necesario para el soporte completo de `podman-compose` con redes internas y bind mounts con etiquetas SELinux (`:Z`).

---

## 7. Ajustes del kernel y limites del sistema

Los parametros siguientes optimizan el kernel para cargas de trabajo de inferencia LLM (grandes asignaciones de memoria virtual, alta concurrencia de descriptores de fichero).

1. Crear el fichero de parametros del kernel:

```bash
cat > /etc/sysctl.d/99-cmdb-rag.conf <<'EOF'
vm.max_map_count     = 262144
vm.overcommit_memory = 1
vm.swappiness        = 10
fs.file-max          = 524288
net.core.somaxconn   = 4096
EOF
```

2. Aplicar los parametros sin reiniciar:

```bash
sysctl --system
```

3. Crear el fichero de limites del sistema para descriptores de fichero y procesos:

```bash
cat > /etc/security/limits.d/99-cmdb-rag.conf <<'EOF'
*  soft  nofile  131072
*  hard  nofile  131072
*  soft  nproc   65535
*  hard  nproc   65535
EOF
```

   Los limites de `limits.d` se aplican en la siguiente sesion de login. Para aplicarlos en la sesion actual usar `ulimit -n 131072`.

---

## 8. Firewall

1. Instalar y habilitar `firewalld` si no esta ya presente:

```bash
dnf -y install firewalld
systemctl enable --now firewalld
```

2. Permitir los servicios necesarios de forma permanente:

```bash
firewall-cmd --permanent --add-service=https
firewall-cmd --permanent --add-service=http
firewall-cmd --permanent --add-service=ssh
```

3. Recargar las reglas y verificar el resultado:

```bash
firewall-cmd --reload
firewall-cmd --list-all
```

   La salida de `--list-all` debe mostrar `services: cockpit dhcpv6-client http https ssh` (u otro conjunto segun la politica del entorno). El trafico entre contenedores viaja por la red interna de Podman y no requiere reglas adicionales de firewall.

---

## 9. Verificacion del runtime de contenedores (Podman)

El directorio `graphRoot` por defecto en RHEL 9 es `/var/lib/containers/storage`. Al haber montado el LV `containers` sobre `/var/lib/containers` en §5, Podman utiliza el nuevo volumen de forma transparente sin ninguna configuracion adicional.

1. Verificar la configuracion de almacenamiento de Podman:

```bash
podman info | grep -E 'graphRoot|graphRootAllocated|driver'
```

   Salida esperada:
   ```
   graphRoot: /var/lib/containers/storage
   graphRootAllocated: ~107 GB
   graphDriver: overlay
   ```

   El valor de `graphRootAllocated` refleja el tamano del LV `containers` mas los metadatos del sistema de ficheros XFS.

2. Si `graphRoot` apunta a una ruta diferente, revisar que el montaje del LV esta activo (`mount | grep containers`) y que `podman info` se ejecuta como root.

---

## 10. Estructura de directorios persistentes

Crear la estructura de directorios bajo `/opt/cmdb-data` que utilizaran los servicios del subsistema RAG (Ollama, pgvector, documentos cargados, backups):

```bash
mkdir -p /opt/cmdb-data/{repo,documents,postgres,ollama-models,backups}
ls -la /opt/cmdb-data/
```

| Directorio                      | Uso                                                       |
|---------------------------------|-----------------------------------------------------------|
| `/opt/cmdb-data/repo`           | Clon del repositorio de la plataforma                     |
| `/opt/cmdb-data/documents`      | Ficheros cargados pendientes de indexacion RAG            |
| `/opt/cmdb-data/postgres`       | Volumen persistente de PostgreSQL con extension pgvector  |
| `/opt/cmdb-data/ollama-models`  | Modelos LLM descargados por Ollama                        |
| `/opt/cmdb-data/backups`        | Backups programados de la base de datos                   |

---

## 11. Verificacion final

Ejecutar los siguientes comprobaciones en orden antes de proceder con la instalacion del subsistema RAG.

1. Verificar que Podman funciona correctamente con el nuevo almacenamiento:

```bash
podman pull docker.io/library/alpine:latest
podman run --rm alpine echo "podman OK en $(uname -m)"
podman rmi alpine
```

2. Verificar los parametros del kernel aplicados en §7:

```bash
sysctl vm.max_map_count vm.overcommit_memory fs.file-max
```

3. Verificar los limites de la sesion actual (abrir nueva sesion o aplicar con `ulimit`):

```bash
ulimit -n   # Debe mostrar 131072
ulimit -u   # Debe mostrar 65535
```

4. Verificar el espacio disponible en ambos LVs:

```bash
df -h /var/lib/containers /opt/cmdb-data
```

5. Comprobar si el sistema requiere reinicio tras las actualizaciones de §6:

```bash
needs-restarting -r || echo "no requiere reinicio"
```

   Si `needs-restarting -r` devuelve codigo de salida 1 (requiere reinicio), reiniciar la VM antes de continuar con la instalacion del subsistema RAG.

---

## Apendice A — Consideraciones de SELinux

En el servidor validado (`lx-gest01p.svc.int`) SELinux esta configurado en modo `Disabled`. Los bind mounts definidos en el compose del subsistema RAG incluyen la etiqueta `:Z`; con SELinux desactivado esta etiqueta es una instruccion no operativa (no-op) pero no causa ningun error ni comportamiento incorrecto.

**Deuda de hardening (ISO 27001 A.8.7):** reactivar SELinux en modo `Enforcing` requiere los siguientes pasos adicionales antes de poner el subsistema en produccion en entornos con politica de seguridad estricta:

1. Cambiar a modo permisivo primero para identificar las denegaciones sin bloquear el servicio:

```bash
setenforce 0
```

2. Arrancar el subsistema RAG completo y recopilar las denegaciones AVC:

```bash
ausearch -m avc -ts recent | audit2allow -M cmdb-rag
```

3. Instalar el modulo de politica generado:

```bash
semodule -i cmdb-rag.pp
```

4. Aplicar los contextos de fichero correctos sobre los directorios persistentes:

```bash
semanage fcontext -a -t container_file_t "/opt/cmdb-data(/.*)?"
semanage fcontext -a -t container_file_t "/var/lib/containers(/.*)?"
restorecon -Rv /opt/cmdb-data /var/lib/containers
```

5. Pasar a modo `Enforcing` y verificar que el subsistema sigue funcionando:

```bash
setenforce 1
```

---

## Apendice B — Dimensionamiento de modelos LLM

La tabla siguiente resume los modelos validados con Ollama en el perfil "Recomendado" (12 vCPU, 32 GiB, AMX activo).

| Modelo                            | Tamano descarga | RAM usada | tok/s (CPU+AMX, 12 vCPU) | Caso de uso                                      |
|-----------------------------------|-----------------|-----------|---------------------------|--------------------------------------------------|
| bge-m3                            | 1.2 GB          | ~1 GB     | — (solo embeddings)       | Indexacion semantica multilingue (ES/EN/DE/PT/FR/IT) |
| qwen2.5:3b-instruct-q4_K_M        | 2.0 GB          | ~2.5 GB   | ~25–35 tok/s              | Host con pocos recursos o alta concurrencia      |
| qwen2.5:7b-instruct-q4_K_M        | 4.7 GB          | ~6 GB     | ~12–18 tok/s              | **Recomendado** — buena calidad en ES y EN       |
| llama3.1:8b-instruct-q4_K_M       | 4.9 GB          | ~6 GB     | ~10–15 tok/s              | Alternativa en ingles                            |

> **Nota GPU:** Con una tarjeta NVIDIA T4 (16 GB VRAM) o A10 (24 GB VRAM) y offload completo a GPU, las velocidades son aproximadamente 3–5 veces superiores a las indicadas para CPU+AMX.

El modelo `bge-m3` se usa exclusivamente para generar embeddings vectoriales durante la indexacion de documentos. No genera texto. Los modelos de instruccion (`qwen2.5`, `llama3.1`) se usan para la generacion de respuestas en el flujo RAG.

---

## Apendice C — Troubleshooting

### AMX no aparece en `/proc/cpuinfo`

1. Verificar que la VM esta completamente apagada (no en estado de suspension).
2. En vCenter, confirmar que `cpuid.enableAMX = "TRUE"` esta guardado en Configuration Parameters.
3. Verificar que la version de hardware de la VM es v21 o superior.
4. Comprobar el modo EVC del cluster: debe ser **Sapphire Rapids** o superior, o EVC debe estar desactivado. Un modo EVC inferior enmascara las instrucciones AMX aunque el host las soporte.
5. Arrancar la VM y repetir `grep -c amx_tile /proc/cpuinfo`.

### Podman no usa el LV nuevo

1. Verificar que el LV esta montado en el punto correcto:

```bash
mount | grep containers
```

2. Si no esta montado, verificar la entrada en `/etc/fstab` y ejecutar `mount -a`.
3. Comprobar que `podman info | grep graphRoot` apunta a `/var/lib/containers/storage`.

### Ollama no responde

1. Revisar los logs del contenedor:

```bash
podman logs cmdb-ollama
```

2. Verificar que la variable `OLLAMA_BASE_URL=http://ollama:11434` esta correctamente definida en el fichero `.env` de la plataforma.
3. Confirmar que el contenedor esta en estado `running`:

```bash
podman ps | grep ollama
```

### Respuestas del LLM muy lentas

1. Comprobar que el modelo esta cargado en memoria (no requiere recarga en cada peticion):

```bash
podman exec cmdb-ollama ollama ps
```

2. Verificar que AMX sigue activo tras un posible reinicio:

```bash
grep -c amx_tile /proc/cpuinfo
```

3. Revisar la carga del sistema durante la inferencia:

```bash
top -bn1 | head -20
```

### Error "no space left on device"

```bash
df -h /var/lib/containers
df -h /opt/cmdb-data
```

Si alguno de los dos LVs esta al 100%, se puede ampliar en caliente con `lvextend -L +50G /dev/vg00/containers && xfs_growfs /var/lib/containers` (XFS soporta ampliacion en caliente).

---

## Apendice D — Controles normativos

La siguiente tabla mapea los pasos de esta guia a los controles de los marcos normativos aplicables.

| Marco               | Control                          | Descripcion del requisito                                              | Seccion relacionada en esta guia        |
|---------------------|----------------------------------|------------------------------------------------------------------------|-----------------------------------------|
| ISO 27001:2022      | A.8.7 — Proteccion contra malware | Activar SELinux Enforcing en entornos de produccion                   | Apendice A                              |
| ISO 27001:2022      | A.8.9 — Gestion de la configuracion | Documentar y versionar todos los parametros de sistema aplicados    | §7, §8                                  |
| ISO 27001:2022      | A.8.31 — Separacion de entornos  | Usar LVs dedicados para datos de produccion vs. sistema operativo      | §5                                      |
| NIS2 (EU 2022/2555) | Art. 21 — Medidas tecnicas       | Aplicar medidas de seguridad proporcionales al riesgo (sysctl, limits) | §7                                      |
| NIS2 (EU 2022/2555) | Art. 21 — Continuidad            | El subsistema RAG debe poder desactivarse independientemente sin afectar la plataforma base | §3, §5 |
| ISO 22301:2019      | §8.4 — RTO                       | La imagen de contenedor pre-construida permite RTO < 15 min desde un `podman pull` limpio | §9, §10 |
| ISO 22301:2019      | §8.4 — Backups                   | El directorio `/opt/cmdb-data/backups` debe incluirse en la politica de backup existente | §10 |

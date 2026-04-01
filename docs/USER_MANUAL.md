# 📖 CMDB Enterprise Platform — Manual de Usuario

**Versión:** 1.2.0
**Público:** Administradores CMDB y usuarios de consulta
**Fecha:** 2026-03-31

---

## Índice

1. [Primer Acceso](#1-primer-acceso)
2. [Cambio de Idioma (ES / EN)](#2-cambio-de-idioma-es--en)
3. [Gestión del Perfil y MFA](#3-gestión-del-perfil-y-mfa)
4. [Matriz de Roles](#4-matriz-de-roles)
5. [Flujo de Gobernanza: Orden de Registro](#5-flujo-de-gobernanza-orden-de-registro)
6. [Gestión del Inventario de CIs](#6-gestión-del-inventario-de-cis)
7. [Importación Masiva por CSV](#7-importación-masiva-por-csv)
8. [Gestión de Relaciones y Topología](#8-gestión-de-relaciones-y-topología)
9. [Gestión de Vulnerabilidades](#9-gestión-de-vulnerabilidades)
10. [Contratos y Adendas](#10-contratos-y-adendas)
11. [Centro de Consulta de Ciclo de Vida (EOL/EOS)](#11-centro-de-consulta-de-ciclo-de-vida-eoless)
12. [Alertas Diarias Automáticas](#12-alertas-diarias-automáticas)
13. [Centro de Reportes](#13-centro-de-reportes)
14. [Configuración y Gestión de Usuarios](#14-configuración-y-gestión-de-usuarios)
14b. [Datos Maestros — Gestión de Tipos de CI](#14b-datos-maestros--gestión-de-tipos-de-ci)
15. [Mapa de Dependencias](#15-mapa-de-dependencias)
16. [Registro de Auditoría](#16-registro-de-auditoría)
17. [Gestión de Certificados SSL/TLS](#17-gestión-de-certificados-ssltls)
18. [Campos de Resiliencia NIS2 / GDPR](#18-campos-de-resiliencia-nis2--gdpr)

---

## 1. Primer Acceso

### Acceso a la plataforma
Abre tu navegador y dirígete a:
```
http://cmdb-server:3001
```
(o la URL que te haya proporcionado tu equipo de sistemas)

### Credenciales por defecto
Tras la instalación inicial, el sistema crea estos usuarios de ejemplo en el `seed`:

| Email | Contraseña | Rol |
|-------|-----------|-----|
| `admin@cmdb.local` | `Admin1234!` | ADMIN |
| `auditor@cmdb.local` | `Audit1234!` | AUDITOR |

> ⚠️ **IMPORTANTE:** Cambia las contraseñas inmediatamente tras el primer login.

### Flujo MFA en el primer login

#### Usuarios Administrador (ADMIN) — MFA obligatorio
En el primer acceso, la plataforma **exige** configurar la autenticación de doble factor antes de acceder a la aplicación:

1. Introduce email y contraseña → la pantalla cambia al **asistente de configuración MFA**
2. Escanea el código QR con tu app de autenticación (Google Authenticator, Aegis, Authy, Microsoft Authenticator…)
3. También puedes introducir la clave manual (ocúltala con el icono del ojo)
4. Haz clic en **"Ya lo escaneé → Continuar"**
5. Introduce el código de 6 dígitos generado por la app para confirmar
6. Activa opcionalmente **"Confiar en este dispositivo durante N días"** para no pedir el código en este equipo
7. Haz clic en **"Activar MFA y entrar"** → acceso completo a la aplicación

> 🔒 No existe opción de omitir este paso para administradores. Es obligatorio por política de seguridad.

#### Usuarios Estándar (AUDITOR / VIEWER) — MFA recomendado
En el primer acceso, la plataforma **sugiere** configurar MFA:

1. Introduce email y contraseña → acceso concedido + pantalla de sugerencia
2. Puedes elegir **"Configurar MFA ahora"** (sigue el mismo asistente QR) o **"Omitir por ahora"**
3. La sugerencia solo se muestra **una vez**. En accesos posteriores no vuelve a aparecer.

### Inicio de sesión con MFA ya configurado
Si tu cuenta tiene MFA activado y el dispositivo **no es de confianza**:
1. Introduce email y contraseña
2. La pantalla cambia al paso de verificación TOTP
3. Abre tu app de autenticación y copia el código de 6 dígitos
4. Activa opcionalmente **"Confiar en este dispositivo durante N días"** para saltar este paso en futuros accesos desde este equipo
5. Haz clic en **"Verificar código"**

> El código cambia cada 30 segundos — introdúcelo antes de que expire.

### Dispositivos de confianza
Cuando marcas un equipo como de confianza, el token del dispositivo se guarda en el navegador. Durante el periodo configurado (`TRUSTED_DEVICE_TTL_DAYS`, por defecto 30 días), el paso MFA se omite automáticamente en ese dispositivo. Al cerrar sesión se borra el token de confianza del navegador.

### Inicio de sesión con LDAP/Active Directory
Si la organización tiene el conector LDAP/AD activado, verás el mensaje **"Soporta credenciales corporativas"** en la pantalla de login. En ese caso:

1. Introduce tu email corporativo y contraseña de red (las mismas del PC/dominio)
2. El sistema comprueba primero el directorio corporativo (AD/LDAP)
3. Si es tu primer login, se crea automáticamente un registro de usuario con rol **VIEWER**
4. Un administrador puede elevar tu rol en **Configuración → Usuarios**
5. Si tu cuenta tiene MFA activado, se pedirá el código TOTP en un segundo paso

> **Comportamiento fail-safe:** Si el servidor LDAP no está disponible, el sistema cae automáticamente en autenticación local sin demoras. Las cuentas que terminan en `@cmdb.local` o `@cmdb.internal` siempre se autentican de forma local, independientemente de la configuración LDAP.

> **Origen de cuenta:** En **Configuración → Usuarios**, las cuentas aprovisionadas por LDAP aparecen marcadas como 🏢 LDAP, mientras que las locales aparecen como 🔑 Local.

---

## 2. Cambio de Idioma (ES / EN)

La plataforma soporta **Español** e **Inglés**. Para cambiar el idioma:

1. Mira en la parte inferior del **menú lateral izquierdo**
2. Verás dos botones: **ES** y **EN**
3. Haz clic en el idioma deseado
4. La interfaz cambia **inmediatamente** sin recargar la página
5. Tu preferencia se **guarda automáticamente** en el navegador

> El cambio de idioma solo afecta a la interfaz. Los datos (nombres de CIs, contratos, etc.) se muestran tal como fueron introducidos.

---

## 3. Gestión del Perfil y MFA

### Acceder a tu perfil
- Haz clic en **"Mi Perfil"** en el menú lateral

### Activar la Autenticación de Doble Factor (MFA) desde el perfil
Si ya tienes acceso a la aplicación (p. ej. eres VIEWER y omitiste la sugerencia inicial), puedes activar MFA en cualquier momento:

1. Ve a **Mi Perfil → Autenticación de Doble Factor**
2. Haz clic en **"Activar MFA"**
3. Escanea el código QR con tu app de autenticación (Google Authenticator, Microsoft Authenticator, Aegis, Authy…)
4. Introduce el código de 6 dígitos generado por la app para confirmar
5. A partir de ahora, cada login desde un dispositivo no reconocido requerirá el código MFA

> ⚠️ Si pierdes acceso a tu app de MFA, contacta con un Administrador para que desactive el MFA de tu cuenta.

---

## 4. Matriz de Roles

La plataforma tiene tres roles diferenciados:

| Funcionalidad | ADMIN | AUDITOR | VIEWER |
|---------------|:-----:|:-------:|:------:|
| Ver Dashboard | ✅ | ✅ | ✅ |
| Ver Inventario de CIs | ✅ | ✅ | ✅ |
| **Crear/modificar CIs** | ✅ | ❌ | ❌ |
| **Importar CSV masivo** | ✅ | ❌ | ❌ |
| **Crear/eliminar relaciones entre CIs** | ✅ | ❌ | ❌ |
| Ver Vulnerabilidades | ✅ | ✅ | ✅ |
| **Cambiar estado de vuln.** | ✅ | ❌ | ❌ |
| Ver Contratos | ✅ | ✅ | ✅ |
| **Crear contratos** | ✅ | ❌ | ❌ |
| Ver Datos Maestros | ✅ | ❌ | ❌ |
| **Gestionar Datos Maestros** | ✅ | ❌ | ❌ |
| Ver Integraciones | ✅ | ❌ | ❌ |
| **Subir informes Greenbone/CrowdStrike** | ✅ | ❌ | ❌ |
| Ver Reportes | ✅ | ✅ | ✅ |
| **Configuración y Usuarios** | ✅ | ❌ | ❌ |
| **Ver Auditoría** | ✅ | ✅ | ❌ |
| **Enviar correo de prueba** | ✅ | ❌ | ❌ |
| **Cambiar rol de usuarios** | ✅ | ❌ | ❌ |
| MFA en primer login | Obligatorio | Sugerido | Sugerido |

> **AUDITOR** — rol diseñado para responsables de compliance, equipos de auditoría interna/externa y revisión ISO 27001. Tiene acceso de solo lectura al inventario, vulnerabilidades, contratos y reportes, y acceso exclusivo al **Registro de Auditoría** (trazabilidad de todas las acciones de la plataforma).
>
> **VIEWER** — acceso de solo lectura a inventario, vulnerabilidades, contratos y reportes. Sin acceso al log de auditoría ni a la configuración.

---

## 5. Flujo de Gobernanza: Orden de Registro

Para sacar el máximo partido a la plataforma y evitar registros huérfanos, se recomienda el siguiente **orden de registro**:

```
Paso 1: Datos Maestros (solo ADMIN)
│
├── 1.1 Tipos de CI (opcional — el sistema incluye tipos predefinidos)
│   → Ve a Datos Maestros → Tipos de CI para añadir, editar o eliminar tipos
│   → Categorías disponibles: Infraestructura, Dispositivos Usuario, Movilidad/IoT,
│      Salas de Reunión, Software, Licencias
│
├── 1.2 Áreas de Soporte
│   Ej: "Zona Centro", "Datacenter Madrid", "Soporte LATAM"
│
├── 1.3 Sedes / Branches
│   Ej: "Sede Madrid (MAD)", "Oficina Barcelona (BCN)"
│   → Cada sede se asocia a un Área de Soporte
│
├── 1.4 Fabricantes
│   Ej: Dell, HP, Cisco, Microsoft
│   → Usa "✨ Sugerir Populares" para insertar 30 fabricantes de TI de una vez
│
├── 1.5 Modelos de Dispositivo
│   Ej: "PowerEdge R740" (Dell), "ProLiant DL380 Gen10" (HP)
│   → Cada modelo se asocia a un Fabricante
│   → Usa el Centro de Consulta EOL para verificar fechas de soporte
│
└── 1.6 Proveedores
    Ej: Telefónica, AWS, Microsoft Azure
    → Se usarán al registrar Contratos

Paso 2: Contratos (solo ADMIN)
│
└── Registrar contratos con proveedores
    → Incluir fecha de inicio, fin y proveedor
    → Las Adendas son contratos vinculados al contrato padre

Paso 3: Configuration Items / CIs (solo ADMIN)
│
└── Registrar cada activo tecnológico
    → Seleccionar Tipo, Entorno, Criticidad, Sede y Modelo
    → Vincular a los Contratos correspondientes
    → Las fechas EoL/EoS se pueden rellenar manualmente o consultar en endoflife.date

Paso 4: Integraciones (solo ADMIN)
│
├── Subir informe Greenbone (JSON) → Importa vulnerabilidades CVE a los CIs
└── Subir informe CrowdStrike (JSON) → Actualiza estado del agente Falcon en los CIs
```

> **¿Por qué este orden?** Los CIs dependen de Sedes, Modelos (que dependen de Fabricantes) y Contratos. Si se registran CIs antes que los Maestros, se perderá la vinculación.

---

## 6. Gestión del Inventario de CIs

### Ver el inventario
1. Haz clic en **"Inventario de CIs"** en el menú lateral
2. La tabla muestra todos los activos con:
   - Nombre, slug, tipo de CI y badge de soporte (EoL)
   - Entorno (Production, Staging, Testing, Development)
   - Criticidad (Mission Critical, High, Medium, Low)
   - Vulnerabilidades Greenbone (conteo por severidad)
   - Estado del agente CrowdStrike Falcon

### Buscar activos
- Usa el campo de búsqueda en la parte superior derecha
- La búsqueda filtra por nombre en tiempo real
- Todos los filtros activos se respetan al exportar CSV

### Crear un nuevo CI (solo ADMIN)
1. Haz clic en **"Nuevo CI"** (botón azul superior derecho)
2. Rellena los campos obligatorios:
   - **Nombre** (único, descriptivo: `srv-prd-web-01`)
   - **Slug** (identificador URL: `srv-prd-web-01`)
   - **Tipo de CI** — selector agrupado por categoría:
     - *Infraestructura*: Servidor Físico, Servidor Virtual, Base de Datos, Equipamiento de Red, Almacenamiento, Backup, Software Base
     - *Dispositivos Usuario*: Laptop, Sobremesa, Monitor, Teclado/Ratón, Impresora/Escáner
     - *Movilidad/IoT*: Smartphone, Tablet, Sensor IoT
     - *Salas de Reunión*: Proyector/Pantalla, Sistema de Videoconferencia
     - *Software*: Aplicación Web, Microservicio/API, Software de Escritorio, Contenedor/Docker
     - *Licencias*: Licencia de Software
   - **Entorno** (Production, Staging, Testing, Development)
   - **Criticidad** (Low, Medium, High, Mission Critical)
3. Opcionales pero recomendados:
   - Hardware: Fabricante, Modelo, Número de Serie (solo en categorías de hardware)
   - Software: Versión, Tipo de Licencia (solo en categorías de software)
   - Fechas EoL / EoS (o dejar en blanco para que se rellenen automáticamente desde endoflife.date)
4. Haz clic en **"Crear CI"**

### El semáforo de soporte
Cada CI muestra un badge de soporte:
- 🟢 **Activo** — Más de 6 meses de soporte restante
- 🟠 **EoL en Xd** — Menos de 6 meses hasta la fecha de fin de soporte
- 🔴 **Sin soporte** — La fecha de EoL o EoS ya ha pasado

---

## 7. Importación Masiva por CSV

La importación masiva permite cargar cientos de CIs desde un archivo Excel/CSV.

### Paso 1: Descargar la plantilla
1. En **Inventario de CIs**, haz clic en **"Plantilla CSV"** (botón "Plantilla CSV")
2. Se descarga un archivo `plantilla-cis.csv` con los campos y ejemplos

### Campos del CSV

| Campo | Obligatorio | Descripción | Ejemplo |
|-------|-------------|-------------|---------|
| `name` | ✅ | Nombre del CI | `srv-prd-web-01` |
| `ciType` | Recomendado | Tipo de CI | `PHYSICAL_SERVER` |
| `criticality` | ✅ | `LOW`, `MEDIUM`, `HIGH`, `MISSION_CRITICAL` | `HIGH` |
| `environment` | ✅ | `DEVELOPMENT`, `TESTING`, `STAGING`, `PRODUCTION` | `PRODUCTION` |
| `manufacturer` | Opcional | Nombre exacto del fabricante | `Dell` |
| `serialNumber` | Opcional | Número de serie | `SN-DL-00001` |
| `model` | Opcional | Modelo del dispositivo | `PowerEdge R740` |
| `version` | Opcional | Versión de software | `2.1.0` |
| `licenseType` | Opcional | Tipo de licencia | `subscription` |
| `status` | Opcional | `active` o `inactive` | `active` |

### Tipos de CI válidos (código `ciType`)
Usa el código interno del tipo tal como aparece en la base de datos. Los tipos predefinidos incluyen:
`PHYSICAL_SERVER`, `VIRTUAL_SERVER`, `DATABASE`, `NETWORK_EQUIPMENT`, `STORAGE`, `BACKUP`, `BASE_SOFTWARE`, `LAPTOP`, `DESKTOP`, `PRINTER_SCANNER`, `SMARTPHONE`, `TABLET`, `IOT_SENSOR`, `PROJECTOR_SCREEN`, `VIDEO_CONFERENCING`, `WEB_APP`, `MICROSERVICE`, `DESKTOP_SOFTWARE`, `CONTAINER`, `LICENSE`

> Para obtener la lista exacta de tipos disponibles en tu instancia, consulta **Datos Maestros → Tipos de CI**.

### Paso 2: Rellenar y subir el CSV
1. Rellena el CSV con tus datos (puedes usar Excel)
2. Guarda como **CSV UTF-8**
3. En **Inventario → Importar CSV**, selecciona tu archivo
4. La barra de resultados muestra:
   - ✅ `X CIs importados correctamente`
   - ❌ `Y errores` (con descripción del error)

### Gestión de errores comunes
| Error | Causa | Solución |
|-------|-------|----------|
| `Slug already exists` | El nombre ya existe en BD | Cambiar el nombre del CI |
| `Invalid criticality` | Valor no reconocido | Usar exactamente: `LOW`, `MEDIUM`, `HIGH`, `MISSION_CRITICAL` |
| `Invalid environment` | Valor no reconocido | Usar exactamente: `DEVELOPMENT`, `TESTING`, `STAGING`, `PRODUCTION` |
| `Missing required field` | Campo obligatorio vacío | Rellenar `name`, `criticality` y `environment` |

---

## 8. Gestión de Relaciones y Topología

La plataforma soporta relaciones N:M entre CIs para modelar la topología de infraestructura y analizar el impacto de cambios.

### Tipos de relación soportados

| Tipo | Descripción | Ejemplo |
|------|-------------|---------|
| **HOSTS** | El CI origen aloja/contiene al CI destino | Servidor físico → Máquina virtual |
| **DEPENDS_ON** | El CI origen depende del CI destino | Aplicación web → Base de datos |
| **CONNECTED_TO** | El CI origen está conectado al CI destino | Servidor → Switch de red |
| **PROVIDES_SERVICE** | El CI origen provee un servicio al CI destino | Servidor DNS → Clientes |
| **BACKED_UP_BY** | El CI origen está respaldado por el CI destino | Servidor producción → Sistema de backup |

### Ver relaciones de un CI

En el **Mapa de Dependencias**, selecciona el CI para ver su grafo completo de relaciones entrantes y salientes (ver sección 15).

### Crear una nueva relación (solo ADMIN)

**Desde el Inventario:**
1. En la tabla de CIs, localiza el CI que actuará como **origen**
2. Haz clic en el icono de **enlace** en la columna de acciones (junto a los botones de editar/borrar)
3. Se abre el modal **"Nueva Relación"** con el CI origen preseleccionado
4. Selecciona el **tipo de relación** mediante el desplegable
5. Busca y selecciona el **CI destino** usando el campo de búsqueda con autocompletado
6. Haz clic en **"Crear Relación"**

**Desde el Mapa de Dependencias:**
1. Selecciona un CI en el selector del mapa
2. Haz clic en **"Nueva Relación"** (botón superior derecho del grafo)
3. Completa los pasos 4-6 del flujo anterior

### Eliminar una relación (solo ADMIN)

Las relaciones se pueden eliminar desde dos puntos de la interfaz:

**Desde el Mapa de Dependencias — Vista Grafo:**
- Haz clic directamente sobre la **arista (flecha)** que une dos CIs
- Se pide confirmación antes de eliminar

**Desde el Mapa de Dependencias — Vista Tabla:**
- Localiza la relación en la tabla
- Haz clic en el icono de papelera (🗑️) en la columna **"Acciones"**
- Se pide confirmación antes de eliminar

> El grafo y la tabla se actualizan automáticamente tras la eliminación.

### Casos de uso prácticos

**Ejemplo 1: Mapear virtualización**
```
[PROD-SRV-FISICO-01] --HOSTS--> [PROD-VM-WEB-01]
[PROD-SRV-FISICO-01] --HOSTS--> [PROD-VM-APP-01]
[PROD-SRV-FISICO-01] --HOSTS--> [PROD-VM-DB-01]
```

**Ejemplo 2: Dependencias de aplicación**
```
[APP-WEB-FRONTEND] --DEPENDS_ON--> [APP-API-BACKEND]
[APP-API-BACKEND]  --DEPENDS_ON--> [POSTGRESQL-CLUSTER]
```

**Ejemplo 3: Topología de red**
```
[SERVIDOR-01] --CONNECTED_TO--> [SWITCH-CORE-01]
[SERVIDOR-02] --CONNECTED_TO--> [SWITCH-CORE-01]
[SWITCH-CORE-01] --CONNECTED_TO--> [ROUTER-PRINCIPAL]
```

> **Análisis de impacto:** Si el `POSTGRESQL-CLUSTER` tiene una ventana de mantenimiento, puedes ver qué aplicaciones dependen de él y notificar a los propietarios.

---

## 9. Gestión de Vulnerabilidades

### Ver el panel de vulnerabilidades
1. Haz clic en **"Vulnerabilidades"** en el menú lateral
2. Se muestra una lista de todos los CIs con CVEs detectados

### Estados del ciclo de vida de una vulnerabilidad
| Estado | Descripción |
|--------|-------------|
| 🆕 **Nuevo** | Vulnerabilidad recién importada, sin asignar |
| 👤 **Asignado** | Asignado a un técnico para su análisis |
| ⚙️ **En Curso** | El técnico está trabajando en la resolución |
| ⏸️ **Parado** | Bloqueado por dependencias externas |
| ✅ **Resuelto** | Vulnerabilidad resuelta o mitigada |

### Cambiar el estado de una vulnerabilidad (solo ADMIN)
1. En el panel de vulnerabilidades, localiza el CVE
2. Usa el selector de estado en la columna "Estado"
3. El cambio se registra inmediatamente y queda en el Audit Log

### Importar desde Greenbone OpenVAS
1. Exporta el informe desde Greenbone en formato JSON (ver `docs/mocks/greenbone_sample.json` para formato)
2. Ve a **Integraciones → Greenbone OpenVAS**
3. Pega el JSON en el editor o sube el archivo
4. Haz clic en **"Importar"**
5. El sistema hace match por nombre de host con los CIs existentes
6. Las vulnerabilidades nuevas se añaden con estado "Nuevo"

### Importar desde CrowdStrike Falcon
1. Exporta el informe en formato JSON (ver `docs/mocks/crowdstrike_sample.json`)
2. Ve a **Integraciones → CrowdStrike Falcon**
3. Sube el JSON
4. Actualiza el estado del agente Falcon en los CIs correspondientes

---

## 10. Contratos y Adendas

### Ver contratos
1. Haz clic en **"Contratos y Adendas"** en el menú lateral
2. La tabla muestra: número de contrato, proveedor, fechas, CIs asociados y estado

### Estados de contratos
- 🟢 **Vigente** — Más de 60 días hasta el vencimiento
- 🟠 **Por vencer** — Menos de 60 días hasta el vencimiento
- 🔴 **Vencido** — La fecha de fin ya ha pasado

### Crear un contrato (solo ADMIN)
1. Haz clic en **"Nuevo Contrato"**
2. Rellena: Número de contrato, Proveedor, Fecha de inicio, Fecha de fin
3. Asocia los CIs cubiertos por el contrato
4. Para crear una **Adenda**, en el campo "Contrato padre" selecciona el contrato principal

### Exportar contratos a CSV
1. Aplica los filtros que necesites en la tabla
2. Haz clic en **"📥 Exportar CSV"**
3. Se descarga el CSV con los registros **filtrados** (no toda la base de datos)

---

## 10. Centro de Consulta de Ciclo de Vida (EOL/EoS)

El Centro de Consulta permite verificar las fechas de fin de soporte de hardware y software desde múltiples fuentes.

### Acceder al Centro de Consulta
1. Ve a **Datos Maestros → Modelos**
2. Haz clic sobre cualquier fila de modelo (o en el botón **🌐 Consultar**)
3. Se abre el **"Centro de Consulta de Ciclo de Vida"**

### Tres fuentes de consulta

#### 🖥️ endoflife.date (Software / OS / Firmware)
- Base de datos comunitaria con datos de EOL para Windows, Linux, MySQL, etc.
- Haz clic en **"🔍 Buscar en endoflife.date"** para abrir en nueva pestaña
- O usa **"📥 Importar versiones"** para traer las versiones directamente como modelos

#### 🏢 Park Place Technologies (Hardware Enterprise)
- Especializado en hardware enterprise: Dell, HP, Cisco, IBM, NetApp
- Haz clic en **"🔍 Buscar en Park Place"** para buscar directamente el modelo

#### 📦 Cloud-Shelf (Hardware General)
- Buscador general de hardware con información de ciclo de vida y disponibilidad
- Haz clic en **"🔍 Buscar en Cloud-Shelf"**

### Sugerir Fechas Estándar
Cuando las fuentes externas no tienen datos claros:
1. En el formulario **Nuevo Modelo**, selecciona el **Tipo** (Software / Hardware)
2. Haz clic en **"✨ Sugerir Fechas Estándar"**
3. El sistema calcula fechas estándar:
   - **Software**: EoL = hoy + 2 años
   - **Hardware**: EoL = hoy + 5 años (garantía + soporte extendido)
4. Usa estas fechas como referencia orientativa

### Sincronizar EOL con endoflife.date
Tras confirmar las fechas con las fuentes externas:
1. En la lista de modelos, haz clic en **"🔄 EOL"** del modelo correspondiente
2. El sistema consulta endoflife.date automáticamente
3. Actualiza los campos `eolDate` y `eosDate` de todos los CIs que usen ese modelo

---

## 12. Alertas Diarias Automáticas

El motor de alertas envía automáticamente un informe diario por email con los activos que requieren atención.

### ¿Cuándo se envía?
- **Por defecto**: Todos los días a las **08:30 AM** (hora de Madrid)
- El administrador de sistemas puede cambiar el horario con la variable `ALERT_CRON_SCHEDULE`

### ¿Qué incluye el informe?
El email contiene tres secciones (si hay elementos que reportar):

1. **🗓️ Fin de Soporte / Fin de Vida** — CIs cuya fecha EoL o EoS vence en los próximos 30 días
2. **📄 Contratos Próximos a Vencer** — Contratos que vencen en los próximos 30 días
3. **🛡️ Vulnerabilidades Críticas/Altas Pendientes** — CIs con CVEs CRITICAL o HIGH sin resolver

### Código de colores del informe
| Color | Significado |
|-------|-------------|
| ⛔ Rojo (VENCIDO) | Ya venció (0 días restantes o menos) |
| 🔴 Naranja-rojo (CRÍTICO) | Vence en menos de 7 días |
| 🟠 Naranja (PRÓXIMO) | Vence en 8-30 días |

### ¿Qué hacer si no recibes los emails?
1. Contacta con el Administrador de Sistemas para verificar la config SMTP
2. El admin puede probar el envío desde **Configuración → Integraciones → "📧 Enviar Correo de Prueba"**
3. Revisar la carpeta de spam

---

## 13. Centro de Reportes

El Centro de Reportes permite generar y descargar informes en PDF y Excel.

### Acceder
Haz clic en **"📊 Reportes"** en el menú lateral.

### Tipos de informes disponibles

#### 📋 Informe EoL/EoS
- Lista todos los CIs con fecha de fin de vida próxima o vencida
- Semáforo visual: 🔴 Vencido, 🟠 < 6 meses, 🟢 OK
- Descarga en PDF o Excel

#### 📑 Informe de Contratos
- Consolida contratos y adendas con estado actual
- Destaca contratos que vencen en los próximos 60 días
- Incluye: Proveedor, Nº contrato, fechas, CIs asociados

#### 🔐 Informe Ejecutivo de Seguridad (PDF)
- Resumen gráfico de CIs por estado
- Top 5 servidores con mayor número de vulnerabilidades críticas
- Cobertura del agente CrowdStrike Falcon

### Exportar a CSV desde las tablas
En las páginas de Inventario, Vulnerabilidades y Contratos:
1. Aplica los filtros que necesites
2. Haz clic en el botón **"📥 Exportar CSV"**
3. El CSV exportado **respeta los filtros activos**

---

## 14. Configuración y Gestión de Usuarios

> Solo disponible para usuarios con rol **ADMIN**

### Acceder
Haz clic en **"Configuración"** en el menú lateral.

### Pestaña: 👥 Gestión de Usuarios

Muestra todos los usuarios del sistema con:
- Nombre de usuario y email
- Origen (🏢 LDAP / 🔑 Local)
- Estado de MFA (Activo / Inactivo)
- Rol actual (ADMIN / AUDITOR / VIEWER)
- Toggle de Activo/Inactivo

#### Cambiar el rol de un usuario
1. En la columna "Rol", usa el selector desplegable
2. Selecciona **ADMIN**, **AUDITOR** o **VIEWER**
3. El cambio se aplica inmediatamente y se registra en el Audit Log

#### Desactivar/Activar una cuenta
1. Usa el toggle en la columna "Activo"
2. Confirma la acción en el diálogo
3. Una cuenta **desactivada** no puede iniciar sesión
4. No puedes desactivar tu propia cuenta (medida de seguridad)

### Pestaña: 🔌 Integraciones y Sistema
- **Backend API**: Estado del servidor (Operativo / No responde)
- **LDAP / Active Directory**: Estado de la integración
- **SMTP / Alertas**: Estado del motor de email
  - Botón **"📧 Enviar Correo de Prueba"**: Envía un email de prueba inmediatamente

---

## 14b. Datos Maestros — Gestión de Tipos de CI

> Solo disponible para usuarios con rol **ADMIN**

### Acceder
Haz clic en **"Datos Maestros"** en el menú lateral → selecciona **"Tipos de CI"** en la barra de navegación lateral izquierda.

### Estructura de la pantalla
La vista muestra las categorías de CI como secciones colapsables. Dentro de cada categoría aparecen los tipos disponibles con opciones de edición y borrado.

### Añadir un nuevo tipo de CI
1. Haz clic en **"+ Tipo"** junto a la categoría deseada
2. Introduce el nombre del tipo (ej. `Firewall`)
3. Haz clic en **"Crear"**
4. El nuevo tipo aparece inmediatamente disponible en el selector de CI del inventario

### Editar un tipo de CI
1. Haz clic en el icono de lápiz (✏️) junto al tipo
2. Edita el nombre
3. Haz clic en **"Guardar"**

### Eliminar un tipo de CI
1. Haz clic en el icono de papelera (🗑️) junto al tipo
2. Confirma la eliminación en el diálogo
3. Si existen CIs con ese tipo asignado, la eliminación se bloquea y se muestra el número de CIs afectados. Reasigna o elimina esos CIs primero.

> Los tipos del sistema son tipos predefinidos. Pueden eliminarse siempre que no tengan CIs asignados.

### Categorías disponibles

| Categoría | Descripción |
|-----------|-------------|
| **Infraestructura** | Servidores, bases de datos, red, almacenamiento, backup |
| **Dispositivos Usuario** | Equipos de trabajo individuales |
| **Movilidad/IoT** | Dispositivos móviles y sensores conectados |
| **Salas de Reunión** | Hardware audiovisual de salas |
| **Software** | Aplicaciones, microservicios, contenedores |
| **Licencias** | Licencias de software |

---

## 15. Mapa de Dependencias

El Mapa de Dependencias permite explorar las relaciones entre CIs en dos modos: **grafo visual interactivo** y **tabla exportable**. Soporta travesía multi-nivel para visualizar dependencias transitivas a varios saltos del CI seleccionado.

### Acceder
Haz clic en **"Mapa de Dependencias"** en el menú lateral.

---

### Paso 1 — Seleccionar CI y profundidad

Al entrar se muestra el formulario de configuración con dos controles:

**Buscador de CI:** escribe parte del nombre o del slug para filtrar y selecciona el CI que quieres explorar.

**Profundidad de dependencia:** determina cuántos saltos se recorren desde el CI seleccionado.

| Opción | Descripción |
|--------|-------------|
| **1 nivel** | Solo relaciones directas del CI (salientes e entrantes) |
| **2 niveles** | Relaciones directas + relaciones de los CIs vecinos |
| **3 niveles** | Hasta 3 saltos desde el CI raíz |

> A mayor profundidad, más CIs y relaciones aparecen. Para CIs muy conectados, empezar con 1 nivel y ampliar progresivamente.

Haz clic en **"Ver dependencias de…"** para cargar el grafo.

---

### Paso 2 — Explorar: Vista de Grafo

El grafo sitúa el CI seleccionado como nodo central (borde indigo + badge "origen") y dispone los demás CIs en columnas según su dirección y distancia:

- **Columnas a la izquierda**: CIs que apuntan *hacia* el CI raíz (entrantes)
- **Columna central**: CI raíz
- **Columnas a la derecha**: CIs a los que apunta el CI raíz (salientes)
- Con profundidad > 1 se añaden columnas adicionales para cada nivel

Cada arista lleva una etiqueta con el tipo de relación, codificada por color:

| Color | Tipo de relación |
|-------|-----------------|
| Indigo | HOSTS |
| Naranja | DEPENDS_ON |
| Teal | CONNECTED_TO |
| Esmeralda | PROVIDES_SERVICE |
| Púrpura | BACKED_UP_BY |

**Controles del canvas:**
- **Arrastrar**: desplaza el grafo
- **Rueda del ratón**: zoom in/out
- Los controles de zoom también están disponibles en la esquina inferior derecha

---

### Paso 2 — Explorar: Vista de Tabla

Haz clic en el botón **"Tabla"** (cabecera del mapa) para cambiar a la vista tabular. Muestra todas las relaciones encontradas en el nivel de profundidad seleccionado:

| Columna | Descripción |
|---------|-------------|
| **Dir.** | `↗ Sal.` (saliente desde el CI raíz) / `↙ Ent.` (entrante hacia el CI raíz) |
| **CI Origen** | Nombre y slug del CI de origen |
| **Tipo de Relación** | Badge con el tipo, coloreado por categoría |
| **CI Destino** | Nombre y slug del CI de destino |
| **Nivel** | Profundidad del salto (solo visible cuando la profundidad > 1) |

Las filas están ordenadas por nivel (ascendente) y luego por tipo de relación.

#### Exportar a Excel

En la vista de tabla, haz clic en **"Exportar Excel"** para descargar un archivo `.xlsx` con todas las relaciones visibles. El fichero se llama `dependencias-<slug-del-ci>.xlsx` e incluye las mismas columnas que la tabla, con anchos de columna ajustados automáticamente.

---

### Controles de la cabecera

| Control | Función |
|---------|---------|
| **← Cambiar CI** | Vuelve al formulario de selección |
| Badge de niveles | Muestra la profundidad activa |
| **Grafo / Tabla** | Alterna entre los dos modos de visualización |
| Botón de refresco | Recarga las relaciones sin cambiar la selección |
| **Nueva Relación** | Abre el modal para crear una relación (solo ADMIN) |
| Clic en arista (Vista Grafo) | Elimina la relación seleccionada con confirmación (solo ADMIN) |
| Icono 🗑️ por fila (Vista Tabla) | Elimina la relación de esa fila con confirmación (solo ADMIN) |

### Crear relaciones desde el mapa (solo ADMIN)

1. Con un CI seleccionado, haz clic en **"Nueva Relación"** (cabecera superior derecha)
2. El CI actual aparece preseleccionado como origen
3. Elige el tipo de relación y el CI destino
4. Haz clic en **"Crear Relación"** — el grafo se actualiza automáticamente

### Estado vacío
Si el CI no tiene ninguna relación registrada, el mapa muestra un mensaje con un botón directo a **"Crear primera relación"**.

---

## 16. Registro de Auditoría

> Solo disponible para usuarios con rol **ADMIN**

### Acceder
Haz clic en **"🕵️ Auditoría"** en el menú lateral.

### ¿Qué se registra?
El sistema registra automáticamente todas las acciones administrativas:

| Acción registrada | Descripción |
|-------------------|-------------|
| `CREATE_CI` | Creación de un nuevo CI |
| `CREATE_RELATION` | Creación de una relación entre dos CIs |
| `UPDATE_VULN_STATUS` | Cambio de estado de una vulnerabilidad |
| `UPDATE_VERIFICATION` | Actualización de fechas EOL/EOS verificadas |
| `SET_ROLE` | Cambio de rol de usuario |
| `ACTIVATE_USER` | Activación de cuenta de usuario |
| `DEACTIVATE_USER` | Desactivación de cuenta de usuario |

### Información registrada por entrada
- **Acción**: Qué se hizo
- **Entidad**: Sobre qué objeto (CI, VULNERABILITY, USER…)
- **ID de entidad**: Identificador del objeto afectado
- **Usuario**: Email del usuario que realizó la acción
- **Fecha y hora**: Timestamp con precisión de segundos

> El Registro de Auditoría es **append-only**: los registros no se pueden editar ni borrar desde la interfaz, garantizando la trazabilidad requerida por ISO 27001 A.12.4.

---

## 18. Campos de Resiliencia NIS2 / GDPR

> Disponible en los formularios **Añadir CI** y **Editar CI** para usuarios con rol **ADMIN**

La plataforma incluye un bloque de campos de cumplimiento normativo alineados con la **Directiva NIS2** (Network and Information Security), el estándar **ISO 22301** (continuidad de negocio) y el **Reglamento GDPR**.

### Campos disponibles

| Campo | Tipo | Descripción |
|-------|------|-------------|
| **Impacto de Negocio (NIS2)** | Enum | Clasifica el impacto del CI en caso de fallo: `Bajo`, `Medio`, `Alto`, `Crítico` |
| **Clasificación de Datos (GDPR)** | Enum | Nivel de sensibilidad de los datos: `Público`, `Interno`, `Confidencial`, `Restringido` |
| **Prioridad de Recuperación** | Número (1-5) | Orden de restauración en un plan de contingencia (1 = primero en recuperarse) |
| **RTO (minutos)** | Número | Recovery Time Objective — tiempo máximo tolerable de interrupción |
| **RPO (minutos)** | Número | Recovery Point Objective — pérdida máxima tolerable de datos en tiempo |
| **Punto Único de Fallo (SPOF)** | Booleano | Marca el CI como Single Point of Failure según ISO 22301 |
| **Contiene Datos Personales (PII)** | Booleano | Indica si el CI procesa o almacena datos personales sujetos a GDPR |

### Indicadores visuales en el Inventario

Los CIs con flags activos muestran etiquetas en la columna de nombre:

| Etiqueta | Color | Significado |
|----------|-------|-------------|
| `SPOF` | Rojo | El CI es un punto único de fallo |
| `PII` | Morado | El CI maneja datos personales (GDPR) |
| `NIS2 Crítico` | Naranja | El CI tiene impacto de negocio CRÍTICO |

### Indicadores visuales en el Mapa de Dependencias

Los nodos SPOF aparecen resaltados con **borde rojo** y la etiqueta `SPOF` en el grafo de dependencias, facilitando la identificación visual de riesgos en la topología.

### Casos de uso por normativa

**NIS2 (Directiva de Seguridad de Redes y Sistemas de Información):**
- Clasifica los CIs por impacto de negocio para priorizar la protección de activos críticos
- Facilita la notificación obligatoria de incidentes (art. 23 NIS2) al identificar sistemas afectados

**ISO 22301 (Continuidad de Negocio):**
- Los campos RTO/RPO alimentan directamente el Plan de Recuperación ante Desastres (DRP)
- La marca SPOF permite identificar cuellos de botella en la topología que requieren redundancia
- La prioridad de recuperación define el orden de restauración en el BCP

**GDPR (Reglamento General de Protección de Datos):**
- La clasificación de datos permite inventariar tratamientos de datos personales (art. 30 GDPR)
- El flag PII facilita el cumplimiento del Registro de Actividades de Tratamiento

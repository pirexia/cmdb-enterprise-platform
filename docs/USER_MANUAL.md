# 📖 CMDB Enterprise Platform — Manual de Usuario

**Versión:** 1.0.0  
**Público:** Administradores CMDB y usuarios de consulta  
**Fecha:** 2026-03-15

---

## Índice

1. [Primer Acceso](#1-primer-acceso)
2. [Cambio de Idioma (ES / EN)](#2-cambio-de-idioma-es--en)
3. [Gestión del Perfil y MFA](#3-gestión-del-perfil-y-mfa)
4. [Matriz de Roles](#4-matriz-de-roles)
5. [Flujo de Gobernanza: Orden de Registro](#5-flujo-de-gobernanza-orden-de-registro)
6. [Gestión del Inventario de CIs](#6-gestión-del-inventario-de-cis)
7. [Importación Masiva por CSV](#7-importación-masiva-por-csv)
8. [Gestión de Vulnerabilidades](#8-gestión-de-vulnerabilidades)
9. [Contratos y Adendas](#9-contratos-y-adendas)
10. [Centro de Consulta de Ciclo de Vida (EOL/EOS)](#10-centro-de-consulta-de-ciclo-de-vida-eoless)
11. [Alertas Diarias Automáticas](#11-alertas-diarias-automáticas)
12. [Centro de Reportes](#12-centro-de-reportes)
13. [Configuración y Gestión de Usuarios](#13-configuración-y-gestión-de-usuarios)
14. [Mapa de Dependencias](#14-mapa-de-dependencias)
15. [Registro de Auditoría](#15-registro-de-auditoría)

---

## 1. Primer Acceso

### Acceso a la plataforma
Abre tu navegador y dirígete a:
```
http://cmdb-server:3001
```
(o la URL que te haya proporcionado tu equipo de sistemas)

### Credenciales por defecto
Tras la instalación inicial, el sistema tiene un usuario administrador creado en el `seed`:

| Campo | Valor por defecto |
|-------|------------------|
| Email | `admin@cmdb.local` |
| Contraseña | `Admin1234!` |

> ⚠️ **IMPORTANTE:** Cambia la contraseña inmediatamente tras el primer login.

### Inicio de sesión con MFA
Si tu cuenta tiene MFA activado:
1. Introduce email y contraseña como siempre
2. Abre tu app de autenticación (Google Authenticator, Aegis, Microsoft Authenticator…)
3. Introduce el código de 6 dígitos cuando la plataforma lo solicite
4. El código cambia cada 30 segundos — introdúcelo antes de que expire

### Inicio de sesión con LDAP/Active Directory
Si la organización usa Active Directory:
1. Introduce tu email corporativo y contraseña de red
2. La autenticación se verifica contra el servidor LDAP corporativo
3. Si es tu primer login, se crea automáticamente tu cuenta con rol **VIEWER**
4. Un administrador puede elevar tu rol en **Configuración → Usuarios**

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

### Activar la Autenticación de Doble Factor (MFA)
El MFA añade una capa de seguridad adicional usando una app de autenticación (TOTP):

1. Ve a **Mi Perfil → Autenticación de Doble Factor**
2. Haz clic en **"Activar MFA"**
3. Abre tu app de autenticación en el móvil
4. Escanea el código QR que aparece en pantalla
5. Introduce el código de 6 dígitos generado por la app para confirmar
6. A partir de ahora, cada login requerirá el código MFA

> **Apps compatibles:** Google Authenticator, Microsoft Authenticator, Aegis, Authy

### Desactivar MFA
1. Ve a **Mi Perfil → Autenticación de Doble Factor**
2. Haz clic en **"Desactivar MFA"**
3. Introduce tu contraseña para confirmar

> ⚠️ Si pierdes acceso a tu app de MFA, contacta con un Administrador para que desactive el MFA de tu cuenta.

---

## 4. Matriz de Roles

La plataforma tiene dos roles diferenciados:

| Funcionalidad | ADMIN | VIEWER |
|---------------|-------|--------|
| Ver Dashboard | ✅ | ✅ |
| Ver Inventario de CIs | ✅ | ✅ |
| **Crear/modificar CIs** | ✅ | ❌ |
| **Importar CSV masivo** | ✅ | ❌ |
| Ver Vulnerabilidades | ✅ | ✅ |
| **Cambiar estado de vuln.** | ✅ | ❌ |
| Ver Contratos | ✅ | ✅ |
| **Crear contratos** | ✅ | ❌ |
| Ver Datos Maestros | ✅ | ❌ |
| **Gestionar Datos Maestros** | ✅ | ❌ |
| Ver Integraciones | ✅ | ❌ |
| **Subir informes Greenbone/CrowdStrike** | ✅ | ❌ |
| Ver Reportes | ✅ | ✅ |
| **Configuración y Usuarios** | ✅ | ❌ |
| Ver Auditoría | ✅ | ❌ |
| **Enviar correo de prueba** | ✅ | ❌ |
| **Cambiar rol de usuarios** | ✅ | ❌ |

> Los usuarios con rol VIEWER tienen acceso de **solo lectura** a toda la información de inventario, vulnerabilidades, contratos y reportes.

---

## 5. Flujo de Gobernanza: Orden de Registro

Para sacar el máximo partido a la plataforma y evitar registros huérfanos, se recomienda el siguiente **orden de registro**:

```
Paso 1: Datos Maestros (solo ADMIN)
│
├── 1.1 Áreas de Soporte
│   Ej: "Zona Centro", "Datacenter Madrid", "Soporte LATAM"
│
├── 1.2 Sedes / Branches
│   Ej: "Sede Madrid (MAD)", "Oficina Barcelona (BCN)"
│   → Cada sede se asocia a un Área de Soporte
│
├── 1.3 Fabricantes
│   Ej: Dell, HP, Cisco, Microsoft
│   → Usa "✨ Sugerir Populares" para insertar 30 fabricantes de TI de una vez
│
├── 1.4 Modelos de Dispositivo
│   Ej: "PowerEdge R740" (Dell), "ProLiant DL380 Gen10" (HP)
│   → Cada modelo se asocia a un Fabricante
│   → Usa el Centro de Consulta EOL para verificar fechas de soporte
│
└── 1.5 Proveedores
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
   - **Tipo de CI** (Servidor Físico, Virtual, Base de Datos, Laptop, etc.)
   - **Entorno** (Production, Staging, Testing, Development)
   - **Criticidad** (Low, Medium, High, Mission Critical)
3. Opcionales pero recomendados:
   - Hardware: Fabricante, Modelo, Número de Serie
   - Software: Versión, Tipo de Licencia
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

### Tipos de CI válidos
`PHYSICAL_SERVER`, `VIRTUAL_SERVER`, `DATABASE`, `NETWORK`, `STORAGE`, `BACKUP`, `HARDWARE`, `SOFTWARE`, `DESKTOP`, `LAPTOP`, `PRINTER`, `SCANNER`, `MONITOR`, `VIDEOCONFERENCE`, `SMART_DISPLAY`, `TIME_CLOCK`, `IP_PHONE`, `SMARTPHONE`, `TABLET`, `PDA`, `BARCODE_SCANNER`, `IP_CAMERA`, `UPS`, `WIFI_AP`, `CLOUD_INSTANCE`, `CLOUD_STORAGE`, `BASE_SOFTWARE`, `LICENSE`, `OTHER`

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

## 8. Gestión de Vulnerabilidades

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

## 9. Contratos y Adendas

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

## 11. Alertas Diarias Automáticas

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

## 12. Centro de Reportes

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

## 13. Configuración y Gestión de Usuarios

> Solo disponible para usuarios con rol **ADMIN**

### Acceder
Haz clic en **"Configuración"** en el menú lateral.

### Pestaña: 👥 Gestión de Usuarios

Muestra todos los usuarios del sistema con:
- Nombre de usuario y email
- Origen (🏢 LDAP / 🔑 Local)
- Estado de MFA (Activo / Inactivo)
- Rol actual (ADMIN / VIEWER)
- Toggle de Activo/Inactivo

#### Cambiar el rol de un usuario
1. En la columna "Rol", usa el selector desplegable
2. Selecciona **ADMIN** o **VIEWER**
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

## 14. Mapa de Dependencias

El Mapa de Dependencias visualiza las relaciones entre CIs (ej: una aplicación que depende de un servidor, que depende de un switch).

### Acceder
Haz clic en **"Mapa de Dependencias"** en el menú lateral.

### Navegar el mapa
- **Arrastrar**: Mueve nodos
- **Rueda del ratón**: Zoom in/out
- **Doble clic en nodo**: Ver detalles del CI
- Las **flechas** representan dependencias (CI hijo → CI padre)

### Configurar dependencias
Al crear o editar un CI, se puede configurar el campo **"CI Padre"** para establecer la jerarquía de dependencia.

---

## 15. Registro de Auditoría

> Solo disponible para usuarios con rol **ADMIN**

### Acceder
Haz clic en **"🕵️ Auditoría"** en el menú lateral.

### ¿Qué se registra?
El sistema registra automáticamente todas las acciones administrativas:

| Acción registrada | Descripción |
|-------------------|-------------|
| `CREATE_CI` | Creación de un nuevo CI |
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

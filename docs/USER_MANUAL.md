# CMDB Enterprise Platform — Manual de Usuario

**Versión:** 1.4.0
**Público:** Responsables de departamento, auditores y usuarios que gestionan el CMDB en el día a día
**Fecha:** 2026-04-07

---

## Índice

1. [Primer Acceso](#1-primer-acceso)
2. [Cambio de Idioma (ES / EN)](#2-cambio-de-idioma-es--en)
3. [Gestión del Perfil y MFA](#3-gestión-del-perfil-y-mfa)
4. [Matriz de Roles](#4-matriz-de-roles)
5. [Flujo de Gobernanza: Orden de Registro](#5-flujo-de-gobernanza-orden-de-registro)
6. [Navegación: el menú lateral](#6-navegación-el-menú-lateral)
7. [Gestión del Inventario de CIs](#7-gestión-del-inventario-de-cis)
8. [Importación Masiva por CSV](#8-importación-masiva-por-csv)
9. [Gestión de Relaciones y Topología](#9-gestión-de-relaciones-y-topología)
10. [Gestión de Vulnerabilidades](#10-gestión-de-vulnerabilidades)
11. [Repositorio Documental](#11-repositorio-documental)
12. [Contratos y Adendas](#12-contratos-y-adendas)
13. [Repositorio de Licencias](#13-repositorio-de-licencias)
14. [Centro de Consulta de Ciclo de Vida (EOL/EoS)](#14-centro-de-consulta-de-ciclo-de-vida-eoless)
15. [Alertas Diarias Automáticas](#15-alertas-diarias-automáticas)
16. [Centro de Reportes](#16-centro-de-reportes)
17. [Configuración y Gestión de Usuarios](#17-configuración-y-gestión-de-usuarios)
18. [Datos Maestros — Tipos de CI](#18-datos-maestros--tipos-de-ci)
19. [Datos Maestros — Métricas y Tipos de Licencia](#19-datos-maestros--métricas-y-tipos-de-licencia)
20. [Mapa de Dependencias](#20-mapa-de-dependencias)
21. [Registro de Auditoría](#21-registro-de-auditoría)
22. [Campos de Resiliencia NIS2 / GDPR](#22-campos-de-resiliencia-nis2--gdpr)
23. [Asistente IA — búsqueda inteligente de documentos](#23-asistente-ia--búsqueda-inteligente-de-documentos)

---

## 1. Primer Acceso

### Acceso a la plataforma

Abre tu navegador y dirígete a la URL que te haya proporcionado tu equipo de sistemas. Normalmente será algo como:

```
https://cmdb-server
```

La plataforma utiliza HTTPS en el puerto estándar 443 (no es necesario indicar el puerto en la URL).

### Credenciales por defecto

Tras la instalación inicial, el sistema crea estos usuarios de ejemplo:

| Email | Contraseña | Rol |
|-------|-----------|-----|
| `admin@cmdb.local` | `Admin1234!` | ADMIN |
| `auditor@cmdb.local` | `Audit1234!` | AUDITOR |

> **IMPORTANTE:** Cambia las contraseñas inmediatamente tras el primer inicio de sesión.

### Autenticación de doble factor (MFA) en el primer acceso

#### Usuarios Administrador (ADMIN) — MFA obligatorio

La plataforma exige configurar el doble factor antes de acceder a ninguna sección. Esto protege el acceso a datos sensibles.

1. Introduce tu email y contraseña. La pantalla cambia al asistente de configuración MFA.
2. Abre tu aplicación de autenticación (Google Authenticator, Microsoft Authenticator, Aegis, Authy…) y escanea el código QR que aparece en pantalla.
3. Si prefieres introducir la clave manualmente, haz clic en el icono del ojo para mostrarla y cópiala en tu app.
4. Haz clic en **"Ya lo escaneé — Continuar"**.
5. Introduce el código de 6 dígitos que genera tu app para confirmar que la vinculación es correcta.
6. Si vas a usar este ordenador habitualmente, activa **"Confiar en este dispositivo durante N días"**. En futuros accesos desde este equipo no se pedirá el código.
7. Haz clic en **"Activar MFA y entrar"**. Ya tienes acceso completo.

> Este paso no se puede omitir para administradores. Es obligatorio por política de seguridad.

#### Usuarios Estándar (AUDITOR / VIEWER) — MFA recomendado

1. Introduce tu email y contraseña. Se te concede el acceso inmediatamente.
2. La plataforma muestra una sugerencia para activar MFA. Puedes elegir **"Configurar MFA ahora"** (sigue el mismo asistente) o **"Omitir por ahora"**.
3. Esta sugerencia solo aparece una vez. En accesos posteriores no vuelve a mostrarse.

### Inicio de sesión cuando ya tienes MFA activado

Si tu cuenta tiene MFA activo y el dispositivo no es de confianza:

1. Introduce tu email y contraseña.
2. La pantalla cambia al paso de verificación. Abre tu app de autenticación y copia el código de 6 dígitos.
3. Si quieres que este equipo no vuelva a pedir el código, activa **"Confiar en este dispositivo durante N días"**.
4. Haz clic en **"Verificar código"**.

> El código cambia cada 30 segundos. Introdúcelo antes de que caduque.

### Dispositivos de confianza

Cuando marcas un equipo como de confianza, la plataforma recuerda ese dispositivo durante el periodo configurado (por defecto, 30 días). Durante ese tiempo, el paso MFA se omite automáticamente en ese equipo. Al cerrar sesión, el token de confianza se elimina del navegador.

### Inicio de sesión con credenciales corporativas (LDAP/Active Directory)

Si tu organización tiene la integración con el directorio corporativo activada, verás el mensaje **"Soporta credenciales corporativas"** en la pantalla de inicio de sesión.

1. Introduce tu email y contraseña corporativa (las mismas que usas en el ordenador del trabajo).
2. El sistema verifica tu identidad contra el directorio de empresa.
3. Si es tu primer acceso, se crea automáticamente una cuenta con rol **VIEWER**.
4. Un administrador puede elevar tu rol desde **Configuración → Usuarios**.
5. Si tu cuenta tiene MFA activado, se pedirá el código en un segundo paso.

> Si el servidor de directorio no está disponible, el sistema recurre automáticamente a la autenticación local sin ninguna demora. Las cuentas con dominio `@cmdb.local` o `@cmdb.internal` siempre se autentican de forma local.

---

## 2. Cambio de Idioma

La plataforma está disponible en **6 idiomas**: Español (ES), Inglés (EN), Alemán (DE), Portugués (PT), Francés (FR) e Italiano (IT). Para cambiar el idioma:

1. Mira en la parte inferior del menú lateral izquierdo.
2. Verás los botones de idioma: **ES**, **EN**, **DE**, **PT**, **FR**, **IT**.
3. Haz clic en el idioma que prefieras.
4. La interfaz cambia de inmediato, sin necesidad de recargar la página.
5. Tu preferencia se guarda automáticamente en el navegador.

La traducción es completa en toda la interfaz: páginas, modales (añadir/editar CI, contratos, licencias, relaciones, detalle de CI) y mensajes de error.

> El cambio de idioma solo afecta a los textos de la interfaz. Los datos que hayas introducido (nombres de activos, contratos, etc.) se muestran tal como fueron escritos.

---

## 3. Gestión del Perfil y MFA

### Acceder a tu perfil

Haz clic en **"Mi Perfil"** en la parte superior del menú lateral izquierdo.

### Cambiar la contraseña (solo cuentas locales)

> Esta opción no está disponible para cuentas corporativas (LDAP/Active Directory). Si usas credenciales de empresa, cambia tu contraseña en el sistema de gestión de tu organización.

1. Ve a **Mi Perfil → Cambiar Contraseña**.
2. Introduce tu contraseña actual.
3. Escribe la nueva contraseña. El indicador de fortaleza te muestra en tiempo real si cumple los requisitos.
4. Confirma la nueva contraseña.
5. Haz clic en **"Cambiar contraseña"**.

#### Requisitos de contraseña

| Requisito | ADMIN | AUDITOR / VIEWER |
|-----------|:-----:|:----------------:|
| Longitud mínima | 16 caracteres | 12 caracteres |
| Letras mayúsculas | Sí | Sí |
| Letras minúsculas | Sí | Sí |
| Números | Sí | Sí |
| Caracteres especiales | Sí | Sí |
| No puede ser contraseña común | Sí | Sí |
| No puede repetir las últimas 20 contraseñas | Sí | Sí |

El indicador de fortaleza usa un código de colores que va de rojo (muy débil) a verde (muy fuerte).

### Activar el doble factor (MFA) desde el perfil

Si tienes acceso a la aplicación pero aún no has activado MFA, puedes hacerlo en cualquier momento:

1. Ve a **Mi Perfil → Autenticación de Doble Factor**.
2. Haz clic en **"Activar MFA"**.
3. Escanea el código QR con tu app de autenticación.
4. Introduce el código de 6 dígitos para confirmar la vinculación.
5. A partir de ese momento, cada nuevo inicio de sesión desde un dispositivo desconocido pedirá el código.

> Si pierdes acceso a tu app de MFA, contacta con un administrador para que desactive el MFA de tu cuenta.

---

## 4. Matriz de Roles

La plataforma tiene tres niveles de acceso:

| Funcionalidad | ADMIN | AUDITOR | VIEWER |
|---------------|:-----:|:-------:|:------:|
| Ver Dashboard | Sí | Sí | Sí |
| Ver Inventario de CIs | Sí | Sí | Sí |
| Crear/modificar CIs | Sí | No | No |
| Importar CSV masivo | Sí | No | No |
| Crear/eliminar relaciones entre CIs | Sí | No | No |
| Ver Vulnerabilidades | Sí | Sí | Sí |
| Cambiar estado de vulnerabilidades | Sí | No | No |
| Ver Contratos | Sí | Sí | Sí |
| Crear contratos | Sí | No | No |
| Ver Datos Maestros | Sí | No | No |
| Gestionar Datos Maestros | Sí | No | No |
| Ver Integraciones | Sí | No | No |
| Subir informes Greenbone/CrowdStrike | Sí | No | No |
| Ver Reportes | Sí | Sí | Sí |
| Ver/descargar documentos | Sí | Sí | Sí |
| Subir/editar/eliminar documentos | Sí | No | No |
| Gestionar Tipos de Documento | Sí | No | No |
| Configuración y Usuarios | Sí | No | No |
| Ver Registro de Auditoría | Sí | Sí | No |
| Enviar correo de prueba | Sí | No | No |
| Cambiar rol de usuarios | Sí | No | No |
| MFA en el primer acceso | Obligatorio | Recomendado | Recomendado |

**AUDITOR** es el rol diseñado para responsables de cumplimiento normativo, equipos de auditoría interna o externa y revisiones ISO 27001. Tiene acceso de solo lectura al inventario, vulnerabilidades, contratos y reportes, y además acceso exclusivo al Registro de Auditoría, donde puede consultar el historial completo de todas las acciones realizadas en la plataforma.

**VIEWER** es el rol de solo lectura para usuarios que necesitan consultar información sin modificar nada. No tiene acceso al Registro de Auditoría ni a la configuración del sistema.

---

## 5. Flujo de Gobernanza: Orden de Registro

Para aprovechar al máximo la plataforma y evitar activos huérfanos (sin sede, sin fabricante, sin contrato), te recomendamos seguir este orden al empezar a registrar información:

```
Paso 1: Datos Maestros (solo ADMIN)
│
├── 1.1 Tipos de CI (opcional — el sistema incluye tipos predefinidos)
│   Ve a Datos Maestros → Tipos de CI para añadir o editar tipos personalizados.
│
├── 1.2 Áreas de Soporte
│   Ej: "Zona Centro", "Datacenter Madrid", "Soporte LATAM"
│
├── 1.3 Sedes
│   Ej: "Sede Madrid (MAD)", "Oficina Barcelona (BCN)"
│   Cada sede se asocia a un Área de Soporte.
│
├── 1.4 Fabricantes
│   Ej: Dell, HP, Cisco, Microsoft
│   Usa "Sugerir Populares" para añadir 30 fabricantes de TI de una sola vez.
│
├── 1.5 Modelos de Dispositivo
│   Ej: "PowerEdge R740" (Dell), "ProLiant DL380 Gen10" (HP)
│   Cada modelo se asocia a un Fabricante.
│
└── 1.6 Proveedores
    Ej: Telefónica, AWS, Microsoft Azure
    Se usarán al registrar contratos.

Paso 2: Contratos (solo ADMIN)
│
└── Registra los contratos con tus proveedores.
    Incluye fecha de inicio, fecha de fin y proveedor.
    Las Adendas son contratos vinculados a un contrato padre.

Paso 3: Configuration Items / CIs (solo ADMIN)
│
└── Registra cada activo tecnológico.
    Selecciona Tipo, Entorno, Criticidad, Sede y Modelo.
    Vincula el activo a sus contratos correspondientes.

Paso 4: Integraciones (solo ADMIN)
│
├── Sube el informe de Greenbone (JSON) para importar vulnerabilidades CVE.
└── Sube el informe de CrowdStrike (JSON) para actualizar el estado del agente Falcon.
```

**¿Por qué este orden?** Los activos dependen de sedes, modelos y contratos. Si registras activos antes de tener los maestros configurados, no podrás vincularlos correctamente y la información quedará incompleta.

---

## 6. Navegación: el menú lateral

El menú lateral izquierdo es el punto de partida para acceder a todas las secciones de la plataforma. Está organizado en dos grupos separados por una línea divisoria.

### Primer grupo — Uso diario (disponible para todos los roles)

| Sección | Para qué sirve |
|---------|---------------|
| **Mi Perfil** | Cambiar contraseña, gestionar MFA y ver datos de tu cuenta |
| **Dashboard** | Resumen visual del estado general de la plataforma |
| **Inventario** | Lista de todos los activos tecnológicos registrados |
| **Contratos** | Gestión de contratos y adendas con proveedores |
| **Licencias** | Repositorio de licencias de software |
| **Mapa** | Grafo visual de dependencias entre activos |
| **Documentos** | Repositorio centralizado de documentación corporativa |
| **Vulnerabilidades** | Lista de CVEs detectados en los activos |
| **Reportes** | Generación de informes en PDF y Excel |

### Segundo grupo — Administración (restringido por rol)

| Sección | Roles con acceso | Para qué sirve |
|---------|:----------------:|---------------|
| **Conectores** | Solo ADMIN | Importar informes de Greenbone y CrowdStrike |
| **Datos Maestros** | Solo ADMIN | Configurar los catálogos base de la plataforma |
| **Auditoría** | ADMIN y AUDITOR | Consultar el registro inmutable de todas las acciones |
| **Configuración** | Solo ADMIN | Gestionar usuarios, integraciones y ajustes del sistema |

En la parte inferior del menú encontrarás tus datos de usuario, el botón de cierre de sesión y los botones de idioma **ES** / **EN** / **DE** / **PT** / **FR** / **IT**.

---

## 7. Gestión del Inventario de CIs

El Inventario es el núcleo de la plataforma. Aquí se registran y gestionan todos los activos tecnológicos de la organización, llamados **Configuration Items** o CIs.

### Ver el inventario

1. Haz clic en **"Inventario"** en el menú lateral.
2. La tabla muestra todos los activos con su nombre, tipo, entorno, criticidad, estado de soporte (EoL), vulnerabilidades detectadas y estado del agente de seguridad.

### Buscar y filtrar activos

Usa el campo de búsqueda en la parte superior para filtrar por nombre en tiempo real. Cuando exportas a CSV, el fichero descargado solo incluye los registros que coinciden con los filtros activos.

### Crear un nuevo activo (solo ADMIN)

1. Haz clic en el botón azul **"Nuevo CI"** en la esquina superior derecha.
2. Rellena los campos obligatorios:
   - **Nombre** — nombre descriptivo y único del activo (por ejemplo, `srv-prd-web-01`)
   - **Tipo de CI** — elige de la lista agrupada por categoría
   - **Entorno** — Producción, Pre-producción, Testing o Desarrollo
   - **Criticidad** — Baja, Media, Alta o Misión Crítica
3. Rellena también los campos opcionales que correspondan:
   - Fabricante, modelo y número de serie (para activos de hardware)
   - Versión (para activos de software)
   - Fechas de fin de vida y fin de soporte (EoL/EoS)
4. Haz clic en **"Crear CI"**.

### El semáforo de soporte

Cada activo muestra una etiqueta de color que indica el estado de soporte del fabricante:

- Verde — El activo tiene más de 6 meses de soporte restante. Todo correcto.
- Naranja — Quedan menos de 6 meses hasta que finalice el soporte. Planifica la renovación.
- Rojo — El soporte ya ha finalizado. El activo está fuera de soporte oficial.

### Actualización masiva de campos (solo ADMIN)

Cuando necesites cambiar el mismo valor en muchos CIs a la vez (por ejemplo, mover varios servidores de "Testing" a "Producción" o reasignar el responsable técnico de un departamento entero), usa la **actualización masiva**:

1. **Selecciona los CIs**: marca las casillas de la columna izquierda en la tabla del inventario. Usa la casilla del encabezado para **seleccionar todos los activos visibles** (incluyendo los filtrados). Los seleccionados se resaltan en color.
2. En la barra superior aparecerá un contador `"N seleccionados"` y el botón **"Editar seleccionados"**.
3. El modal muestra una lista de campos editables. **Solo los campos que rellenes se aplicarán**; el resto permanece intacto en cada CI.
4. Campos disponibles: criticidad, entorno, estado, tipo de CI, sede, centro de coste, responsables (de negocio y técnico), impacto de negocio, clasificación de datos, PII y SPOF.
5. Para los campos de tipo FK (selección por id) puedes elegir **"Vaciar valor (null)"** además de "Sin cambio" o un valor concreto.
6. Pulsa **"Aplicar a la selección"**. La actualización es atómica: o se aplican a todos los CIs seleccionados, o a ninguno.
7. La acción queda registrada en el Registro de Auditoría con `action=CI_BULK_UPDATE` y la lista de ids afectados.

> Hay un máximo de 500 CIs por operación. Campos únicos por CI (nombre, slug, número de inventario, número de serie, etc.) **no** se pueden cambiar masivamente para evitar conflictos de unicidad.

### Eliminación masiva de CIs (solo ADMIN)

Cuando necesites dar de baja varios activos a la vez (por ejemplo, decomisión de una sala entera), usa la **eliminación masiva**:

1. Selecciona los CIs con las casillas (igual que en la actualización masiva).
2. En la barra superior aparece el botón rojo **"Eliminar seleccionados"**.
3. Confirma en el modal. La acción **no se puede deshacer**.
4. Se eliminan el CI, su hardware/software asociado, sus relaciones y todas las referencias a documentos, contratos y licencias.
5. Cada eliminación genera dos registros de auditoría: uno por CI (`action=DELETE_CI:<nombre>`) y un evento agregado del lote (`action=CI_BULK_DELETE`).

> Máximo **200 CIs por operación** (al ser irreversible). Si necesitas borrar más, divídelo en varias tandas.

---

## 8. Importación Masiva por CSV

Si necesitas registrar muchos activos a la vez, la importación masiva te permite hacerlo desde un fichero Excel o CSV.

### Paso 1: Descargar la plantilla

1. En el Inventario, haz clic en el botón **"Plantilla CSV"**.
2. Se descarga un fichero con los campos y ejemplos ya incluidos.

### Campos del CSV

| Campo | Obligatorio | Descripción | Ejemplo |
|-------|:-----------:|-------------|---------|
| `name` | Sí | Nombre del activo | `srv-prd-web-01` |
| `ciType` | Recomendado | Código del tipo de CI | `PHYSICAL_SERVER` |
| `criticality` | Sí | Nivel de criticidad | `HIGH` |
| `environment` | Sí | Entorno | `PRODUCTION` |
| `manufacturer` | No | Nombre del fabricante (exacto) | `Dell` |
| `serialNumber` | No | Número de serie | `SN-DL-00001` |
| `model` | No | Modelo del dispositivo | `PowerEdge R740` |
| `version` | No | Versión de software | `2.1.0` |
| `licenseType` | No | Tipo de licencia | `subscription` |
| `status` | No | `active` o `inactive` | `active` |

Los valores válidos para `criticality` son: `LOW`, `MEDIUM`, `HIGH`, `MISSION_CRITICAL`.
Los valores válidos para `environment` son: `DEVELOPMENT`, `TESTING`, `STAGING`, `PRODUCTION`.

Para ver los códigos de tipo de CI disponibles en tu instalación, ve a **Datos Maestros → Tipos de CI**.

### Paso 2: Rellenar y subir el fichero

1. Rellena el fichero con tus datos. Puedes editarlo con Excel.
2. Guárdalo como **CSV UTF-8**.
3. Ve a **Inventario → Importar CSV** y selecciona tu fichero.
4. La plataforma muestra cuántos activos se importaron correctamente y cuántos tuvieron errores, con una descripción de cada problema.

### Errores frecuentes

| Error | Causa probable | Solución |
|-------|---------------|----------|
| `Slug already exists` | Ya existe un activo con ese nombre | Cambia el nombre del activo |
| `Invalid criticality` | El valor no es reconocido | Usa exactamente uno de los valores válidos |
| `Invalid environment` | El valor no es reconocido | Usa exactamente uno de los valores válidos |
| `Missing required field` | Falta un campo obligatorio | Rellena `name`, `criticality` y `environment` |

---

## 9. Gestión de Relaciones y Topología

Las relaciones permiten modelar cómo están conectados los activos entre sí: qué servidor aloja qué máquina virtual, de qué base de datos depende una aplicación, etc. Esta información es clave para analizar el impacto de cualquier cambio o incidencia.

### Tipos de relación disponibles

| Tipo | Significado | Ejemplo |
|------|-------------|---------|
| **HOSTS** | El activo origen aloja al activo destino | Servidor físico aloja una máquina virtual |
| **DEPENDS_ON** | El activo origen depende del activo destino | Aplicación web depende de una base de datos |
| **CONNECTED_TO** | El activo origen está conectado al activo destino | Servidor conectado a un switch de red |
| **PROVIDES_SERVICE** | El activo origen provee un servicio al activo destino | Servidor DNS presta servicio a los clientes |
| **BACKED_UP_BY** | El activo origen está respaldado por el activo destino | Servidor de producción respaldado por sistema de backup |

### Crear una nueva relación (solo ADMIN)

Puedes crear relaciones desde dos lugares:

**Desde el Inventario:**
1. Localiza el activo que actuará como origen.
2. Haz clic en el icono de enlace en la columna de acciones (junto a los botones de editar y borrar).
3. En el modal que se abre, selecciona el tipo de relación y busca el activo destino.
4. Haz clic en **"Crear Relación"**.

**Desde el Mapa de Dependencias:**
1. Selecciona un activo en el selector del mapa.
2. Haz clic en **"Nueva Relación"** en la esquina superior derecha del grafo.
3. Completa los mismos pasos anteriores.

### Eliminar una relación (solo ADMIN)

Desde el Mapa de Dependencias puedes eliminar relaciones de dos formas:

- En la **vista de grafo**, haz clic directamente sobre la flecha que une los dos activos. Se pedirá confirmación antes de eliminar.
- En la **vista de tabla**, localiza la relación y haz clic en el icono de papelera de esa fila. Se pedirá confirmación.

El grafo y la tabla se actualizan automáticamente tras la eliminación.

---

## 10. Gestión de Vulnerabilidades

Este módulo centraliza las vulnerabilidades de seguridad detectadas en tus activos, importadas desde herramientas especializadas como Greenbone OpenVAS o CrowdStrike Falcon.

### Ver el panel de vulnerabilidades

Haz clic en **"Vulnerabilidades"** en el menú lateral para ver la lista de todos los activos con vulnerabilidades detectadas.

### Estados de una vulnerabilidad

| Estado | Significado |
|--------|-------------|
| **Nuevo** | Vulnerabilidad recién importada, pendiente de asignar |
| **Asignado** | Asignado a un técnico para su análisis |
| **En Curso** | El técnico está trabajando en la resolución |
| **Parado** | Bloqueado por dependencias externas |
| **Resuelto** | Vulnerabilidad resuelta o mitigada |

### Cambiar el estado de una vulnerabilidad (solo ADMIN)

1. Localiza el CVE en el panel.
2. Usa el selector de estado en la columna "Estado".
3. La interfaz refleja el cambio de forma inmediata. Durante el guardado, la fila muestra un indicador giratorio junto al selector.
4. Si el guardado se confirma en el servidor, aparece una notificación verde en la esquina de la pantalla.
5. Si el guardado falla (error de red o servidor), el estado se revierte automáticamente al valor anterior y aparece una notificación roja. No es necesaria ninguna acción manual.
6. El cambio exitoso queda reflejado en el Registro de Auditoría.

### Importar vulnerabilidades desde Greenbone OpenVAS

1. Exporta el informe desde Greenbone en formato JSON.
2. Ve a **Conectores → Greenbone OpenVAS**.
3. Pega el JSON en el editor o sube el fichero.
4. Haz clic en **"Importar"**.
5. El sistema cruza los nombres de host del informe con los activos existentes y añade las vulnerabilidades nuevas con estado "Nuevo".

### Importar desde CrowdStrike Falcon

1. Exporta el informe en formato JSON desde CrowdStrike.
2. Ve a **Conectores → CrowdStrike Falcon**.
3. Sube el fichero JSON.
4. La plataforma actualiza el estado del agente Falcon en los activos correspondientes.

---

## 11. Repositorio Documental

El Repositorio Documental es el lugar centralizado para almacenar, versionar y consultar toda la documentación corporativa vinculada a activos y contratos. Cumple con los requisitos de trazabilidad documental de ISO 27001 y NIS2.

### Acceder al repositorio

Haz clic en **"Documentos"** en el menú lateral. Todos los usuarios autenticados pueden ver y descargar documentos.

### Ver y descargar documentos

1. La lista principal muestra todos los documentos con su nombre, tipo, versión vigente, tamaño y fecha de subida.
2. Haz clic sobre cualquier documento para abrir su vista de detalle.
3. En la vista de detalle encontrarás los metadatos del documento, los activos y contratos asociados, y el historial de versiones.
4. Haz clic en **"Descargar"** para obtener el fichero.

### Formatos de fichero admitidos

| Categoría | Extensiones permitidas |
|-----------|----------------------|
| Documentos Office | PDF, DOCX, DOC, PPTX, XLSX, ODT, ODS |
| Texto plano | TXT, CSV |
| Imágenes | PNG, JPG |

El tamaño máximo por fichero es de **50 MB**.

### Subir un nuevo documento (solo ADMIN)

1. Haz clic en **"+ Nuevo Documento"**.
2. Selecciona el fichero desde tu equipo.
3. Rellena el nombre, el tipo de documento y una descripción opcional.
4. Si lo deseas, asocia el documento a uno o varios activos y/o contratos.
5. Haz clic en **"Subir"**.

### Carga masiva de documentos con análisis IA (solo ADMIN)

Cuando necesites incorporar muchos documentos de golpe (p. ej. un lote de contratos, adendas y ofertas), usa la **carga masiva**. El asistente de IA analiza cada fichero y propone su clasificación para que la revises antes de crear nada.

1. En el Repositorio Documental, haz clic en **"Carga masiva"**.
2. **Arrastra los ficheros** al área de soltado (o haz clic para seleccionarlos). Puedes subir hasta el número de ficheros y tamaño total que defina tu administrador (por defecto **20 ficheros / 200 MB**; cada fichero mantiene su límite individual).
3. Haz clic en **"Subir y analizar"**. Los ficheros quedan en un área temporal y se abre la **pantalla de revisión**.
4. La pantalla muestra una fila por documento e indica el progreso del análisis. A medida que la IA termina cada fichero, rellena de forma automática:
   - **Tipo de documento** detectado (contrato, adenda, oferta, técnico…).
   - **Fechas de vigencia** (inicio y fin) si aparecen en el documento.
   - **Proveedor** sugerido.
   - **Número** de contrato/licencia.
   - **CIs asociados**: equipos detectados por número de serie o nombre.
5. **Revisa y corrige** cada fila:
   - Elige qué crear en **"Crear como"**: Contrato, Adenda, Licencia o solo Documento.
   - Ajusta tipo, fechas, número y proveedor. Si el proveedor no existe, pulsa **"+"** para crearlo en el momento.
   - Añade o quita CIs asociados (las sugerencias de la IA aparecen resaltadas).
   - Para una **adenda**, selecciona el contrato padre.
6. Pulsa **"Crear"** en cada fila para materializarla, o **"Crear todos"** para procesar el lote completo. Cada confirmación crea el documento real y, si procede, el contrato/adenda/licencia con sus asociaciones.
7. Puedes **descartar** ficheros individuales o el lote entero. Los lotes abandonados se eliminan automáticamente pasado un tiempo (por defecto 24 h).

> El análisis de IA se ejecuta en segundo plano y, sin GPU, puede tardar entre 30 s y varios minutos por documento. Los **documentos escaneados** (sin texto digital) se reconocen automáticamente mediante OCR, lo que añade tiempo de proceso. La pantalla de revisión se va actualizando sola; puedes cerrarla y volver más tarde. Las sugerencias de la IA son orientativas: revisa siempre los datos antes de crear los registros.

#### Estado "Advertencia" — documento sin texto extraído

Cuando la IA no puede extraer texto de un documento (por ejemplo, un PDF escaneado de muy baja calidad en el que el OCR falla, o un fichero corrupto), su estado pasa a **"Advertencia"** (badge amarillo) en lugar de "Listo". El sistema:
- Permite **revisar y confirmar el documento manualmente**: tendrás que clasificar el tipo, fechas y proveedor a mano.
- En la vista **"Mis importaciones"**, los lotes con advertencias se etiquetan como **"Listo con advertencias"** y la columna **"Advertencias"** muestra el contador.
- El sumatorio del lote es: **Ficheros = Creados + Pendientes + Advertencias + Errores**.

Esta señal te ayuda a no perder visibilidad de los documentos que requieren atención adicional.

### Editar metadatos de un documento (solo ADMIN)

1. Abre la vista de detalle del documento.
2. Haz clic en **"Editar"**.
3. Modifica los campos que necesites (nombre, descripción, tipo, asociaciones).
4. Haz clic en **"Guardar"**.

> Editar los metadatos no crea una nueva versión. Solo la subida de un nuevo fichero genera una entrada en el historial de versiones.

### Eliminar un documento (solo ADMIN)

1. Abre la vista de detalle del documento.
2. Haz clic en **"Eliminar"**.
3. Confirma la acción en el diálogo de confirmación.
4. Se eliminan el registro y todas sus versiones almacenadas.

> Esta acción es irreversible.

### Control de versiones

Cada documento mantiene un historial completo de versiones.

Para subir una nueva versión:
1. Abre la vista de detalle del documento.
2. Haz clic en **"Nueva Versión"**.
3. Selecciona el nuevo fichero y confirma.
4. La nueva versión pasa a ser la vigente; las anteriores siguen accesibles en el historial.

Para consultar versiones anteriores, despliega la sección **"Historial de Versiones"** en la vista de detalle. Puedes descargar cualquier versión individual desde esa sección.

### Notas del documento

La sección **"Notas"** en la vista de detalle permite añadir comentarios libres al documento. Cualquier usuario autenticado puede añadir notas, pero nadie puede editarlas ni eliminarlas desde la interfaz — garantizando así la trazabilidad del hilo de comunicación.

Para añadir una nota:
1. Abre la vista de detalle del documento.
2. Desplázate hasta la sección **"Notas"**.
3. Escribe el texto y haz clic en **"Añadir nota"**.

### Asociar documentos con activos y contratos

Los documentos pueden vincularse a activos y contratos para que aparezcan en sus respectivas vistas de detalle. Puedes gestionar estas vinculaciones desde la vista del documento o desde la pestaña **"Documentos"** de cada activo o contrato.

Para vincular desde el documento:
1. Abre la vista de detalle del documento.
2. En la sección **"CIs asociados"**, haz clic en **"Añadir CIs"** y selecciona los activos.
3. En la sección **"Contratos asociados"**, haz clic en **"Añadir Contratos"** y selecciona los contratos.

Las vinculaciones son bidireccionales: el documento aparece automáticamente en la pestaña correspondiente del activo y del contrato.

### Filtros y ordenación en la lista de documentos

Puedes filtrar la lista de documentos por:
- **Título** — búsqueda por texto libre en el nombre
- **Tipo de documento** — selector desplegable
- **Subido por** — búsqueda por el email del usuario que subió el documento

Los tres filtros son independientes entre sí y se pueden combinar libremente. Cuando algún filtro está activo, aparece el botón **"Limpiar filtros"**. Todas las columnas de la tabla son ordenables: haz clic en el encabezado para ordenar, y de nuevo para invertir el orden.

### Visibilidad de documentos en el Asistente IA

Cada documento dispone de tres conmutadores de visibilidad que controlan qué roles pueden consultarlo a través del Asistente IA. Consulta la sección [§23 — Asistente IA](#23-asistente-ia--búsqueda-inteligente-de-documentos) para una descripción completa de su funcionamiento.

---

## 12. Contratos y Adendas

Este módulo centraliza los contratos con proveedores externos y permite vincularlos con los activos que cubren.

### Ver contratos

Haz clic en **"Contratos"** en el menú lateral. La tabla muestra el número de contrato, el proveedor, las fechas, los activos asociados y el estado.

### Estados de los contratos

- Verde — El contrato tiene más de 60 días hasta el vencimiento. Todo correcto.
- Naranja — El contrato vence en menos de 60 días. Conviene gestionar la renovación.
- Rojo — El contrato ya ha vencido.

### Crear un contrato (solo ADMIN)

1. Haz clic en **"Nuevo Contrato"**.
2. Rellena el número de contrato, el proveedor, la fecha de inicio y la fecha de fin.
3. Asocia los activos cubiertos por el contrato.
4. Para crear una **Adenda** (una modificación o anexo vinculado a un contrato principal), selecciona el contrato padre en el campo **"Contrato padre"**.

### Eliminar un contrato o adenda (solo ADMIN)

1. Expande la fila del contrato y pulsa el icono de papelera 🗑 junto al lápiz de editar.
2. Confirma en el panel rojo que aparece debajo.
3. **Bloqueo de seguridad:** si el contrato tiene adendas vinculadas, no se puede eliminar — primero hay que borrar las adendas. El sistema mostrará el mensaje correspondiente.
4. Al eliminar, se desasocian automáticamente los CIs y documentos vinculados (estos **no** se borran, solo deja de existir la relación con el contrato).
5. La acción queda registrada en el Registro de Auditoría con `action=DELETE` y `entity=Contract`.

### Desasociar un documento de un contrato (solo ADMIN)

Dentro de la fila expandida, en la sección **"Documentos adjuntos"**, junto a cada documento aparece un icono ✕ rojo. Al pulsarlo, se elimina la relación entre el documento y este contrato (sin borrar el documento). Se solicita confirmación antes de proceder.

### Exportar contratos a CSV

1. Aplica los filtros que necesites en la tabla.
2. Haz clic en **"Exportar CSV"**.
3. Se descarga un fichero con solo los registros que coinciden con los filtros activos.

---

## 13. Repositorio de Licencias

El Repositorio de Licencias centraliza el inventario de licencias de software de la organización. Asocia cada licencia con su proveedor, tipo, métrica de uso, coste, activos cubiertos, documentos adjuntos y usuarios asignados.

### Acceder al módulo

Haz clic en **"Licencias"** en el menú lateral.

La tabla muestra todas las licencias registradas con las siguientes columnas:

| Columna | Descripción |
|---------|-------------|
| **Licencia** | Nombre y número de licencia |
| **Proveedor** | Empresa que provee la licencia |
| **Tipo / Métrica** | Categoría de licencia y unidad de medida (p. ej. Usuario nominal, Zócalo de CPU) |
| **Estado / Vencimiento** | Estado actual y fecha de fin |
| **Coste** | Importe y moneda |
| **CIs** | Número de activos asociados |

### Estados de las licencias

- **Activa** — La licencia está vigente (más de 60 días hasta el vencimiento, o sin fecha de fin).
- **Por vencer** — Vence en los próximos 60 días.
- **Vencida** — La fecha de fin ya ha pasado.
- **Borrador** — Licencia en proceso de registro, aún no activa en producción.

### Crear una nueva licencia (solo ADMIN)

1. Haz clic en **"Nueva Licencia"**.
2. Rellena los campos del formulario:
   - **Nombre** — denominación interna de la licencia (obligatorio)
   - **Número de licencia** — clave o identificador proporcionado por el fabricante
   - **Proveedor** — selecciona del catálogo de proveedores
   - **Tipo de licencia** — elige entre las categorías disponibles (p. ej. Perpetua, Suscripción anual, OEM)
   - **Métrica de licencia** — unidad de medida del uso (p. ej. Usuario nominal, Núcleo de procesador, Dispositivo gestionado)
   - **Valor de métrica / Unidad** — cantidad y descripción de la unidad
   - **Fecha de inicio / Fecha de fin** — periodo de vigencia
   - **Coste / Moneda** — importe económico de la licencia
   - **Estado** — estado inicial (Borrador o Activa)
   - **Notas** — comentarios adicionales
   - **Licencia padre** — si es una sublicencia, selecciona la licencia principal
3. Haz clic en **"Crear Licencia"**.

### Ver el detalle y las asociaciones de una licencia

Haz clic en la fila de una licencia para desplegar su panel de detalle, que tiene tres pestañas:

**CIs asociados**
- Lista los activos cubiertos por esta licencia.
- Para añadir un activo, haz clic en **"Asociar CI"** y búscalo en el selector.
- Para desvincularlo, haz clic en el botón de eliminar junto al activo.

**Documentos adjuntos**
- Muestra los documentos vinculados (contratos, certificados, etc.).
- Para asociar un documento existente del repositorio, haz clic en **"Asociar Documento"**.
- Para ver el documento, haz clic en su nombre y se abrirá el visor integrado.
- Para desvincularlo, haz clic en el botón de eliminar junto al documento.

**Usuarios de licencia**
Registra los usuarios finales asignados a esta licencia. No tienen que ser usuarios del sistema CMDB.

- Para añadir un usuario, rellena el nombre, el identificador y el email, y haz clic en **"Añadir Usuario"**.
- Para eliminarlo, haz clic en el icono de papelera junto al usuario.

> Solo los usuarios con rol ADMIN pueden crear, editar o eliminar licencias, y gestionar sus asociaciones. Los usuarios con rol AUDITOR o VIEWER solo pueden consultar.

---

## 14. Centro de Consulta de Ciclo de Vida (EOL/EoS)

Este centro permite verificar las fechas de fin de soporte y fin de vida de hardware y software consultando fuentes externas especializadas.

### Acceder al centro de consulta

1. Ve a **Datos Maestros → Modelos**.
2. Haz clic sobre cualquier fila de modelo para desplegar el panel de consulta.

### Tres fuentes de referencia

**endoflife.date — Software, sistemas operativos y firmware**
Base de datos comunitaria con fechas EOL para Windows, Linux, MySQL, Java, y muchos más. Haz clic en **"Buscar en endoflife.date"** para abrir la página del producto en una nueva pestaña. También puedes hacer clic en **"Importar versiones"** para traer directamente las versiones disponibles como modelos en la plataforma.

**Park Place Technologies — Hardware enterprise**
Especializado en servidores, almacenamiento y equipamiento de red de marcas como Dell, HP, Cisco, IBM y NetApp. Haz clic en **"Buscar en Park Place"** para abrir el buscador de fin de vida oficial de ese fabricante.

**Cloud-Shelf — Hardware general**
Buscador general con información de ciclo de vida y disponibilidad de hardware multimarca. Haz clic en **"Buscar en Cloud-Shelf"**.

### Sugerir fechas estándar

Cuando las fuentes externas no tienen datos claros para un modelo:
1. En el formulario **Nuevo Modelo**, selecciona el tipo: Software o Hardware.
2. Haz clic en **"Sugerir Fechas Estándar"**.
3. La plataforma calcula una fecha orientativa: para software, EoL = hoy + 2 años; para hardware, EoL = hoy + 5 años.
4. Usa estas fechas como punto de partida y ajústalas cuando tengas información oficial.

### Sincronizar EOL con endoflife.date

Una vez confirmadas las fechas con las fuentes externas:
1. En la lista de modelos, haz clic en el botón **"EOL"** junto al modelo.
2. La plataforma consulta endoflife.date automáticamente y actualiza las fechas de todos los activos que usan ese modelo.

---

## 15. Alertas Diarias Automáticas

La plataforma envía automáticamente un informe diario por email con los activos que requieren atención.

### ¿Cuándo llega el email?

Por defecto, el informe se envía todos los días a las **08:30** (hora de Madrid). Tu administrador de sistemas puede cambiar este horario si es necesario.

### ¿Qué contiene el informe?

El email incluye hasta tres secciones, según lo que haya que reportar:

1. **Fin de Soporte / Fin de Vida** — Activos cuya fecha de EoL o EoS vence en los próximos 30 días.
2. **Contratos próximos a vencer** — Contratos que vencen en los próximos 30 días.
3. **Vulnerabilidades críticas y altas pendientes** — Activos con CVEs de severidad CRÍTICA o ALTA sin resolver.

### Código de colores del informe

| Color | Significado |
|-------|-------------|
| Rojo intenso | Ya venció — acción inmediata requerida |
| Rojo-naranja | Vence en menos de 7 días |
| Naranja | Vence en 8 a 30 días |

### No recibes el informe

Si no recibes el informe diario, comprueba primero la carpeta de spam. Si el problema persiste, contacta con tu administrador para que verifique la configuración del servidor de correo y envíe un correo de prueba desde **Configuración → Integraciones**.

---

## 16. Centro de Reportes

El Centro de Reportes permite generar y descargar informes ejecutivos e informes detallados sobre el estado de los activos, contratos y vulnerabilidades.

### Acceder

Haz clic en **"Reportes"** en el menú lateral.

### Informes disponibles

**Informe EoL/EoS**
Lista todos los activos con fecha de fin de vida próxima o ya vencida. Incluye un semáforo visual (rojo, naranja, verde) y se puede descargar en PDF o Excel.

**Informe de Contratos**
Consolida todos los contratos y adendas con su estado actual. Destaca los contratos que vencen en los próximos 60 días e incluye el proveedor, número de contrato, fechas y activos asociados.

**Informe Ejecutivo de Seguridad**
Resumen gráfico del estado general de los activos, con los cinco servidores con mayor número de vulnerabilidades críticas y la cobertura del agente de seguridad CrowdStrike Falcon.

### Exportar datos desde las tablas

En las páginas de Inventario, Vulnerabilidades y Contratos, puedes exportar los datos directamente a CSV. Aplica los filtros que necesites y haz clic en **"Exportar CSV"**. El fichero exportado incluye solo los registros que coinciden con los filtros activos.

---

## 17. Configuración y Gestión de Usuarios

> Esta sección solo está disponible para usuarios con rol **ADMIN**.

### Acceder

Haz clic en **"Configuración"** en el menú lateral.

### Pestaña: Gestión de Usuarios

Muestra todos los usuarios del sistema con su nombre, email, origen (corporativo o local), estado de MFA, rol y si la cuenta está activa.

**Cambiar el rol de un usuario**
1. En la columna "Rol", despliega el selector.
2. Selecciona **ADMIN**, **AUDITOR** o **VIEWER**.
3. El cambio se aplica de inmediato y queda registrado en el Registro de Auditoría.

**Activar o desactivar una cuenta**
1. Usa el interruptor en la columna "Activo".
2. Confirma la acción en el diálogo.
3. Una cuenta desactivada no puede iniciar sesión.
4. No puedes desactivar tu propia cuenta (medida de seguridad).

**Restablecer la contraseña de un usuario**
Esta operación solo está disponible para cuentas locales y debe realizarse por tu administrador de sistemas. Las cuentas corporativas (LDAP/Active Directory) no se ven afectadas.

### Pestaña: Integraciones y Sistema

Muestra el estado de los servicios del sistema: el servidor de la plataforma, la integración con el directorio corporativo y el motor de correo electrónico. Desde aquí, el administrador puede enviar un correo de prueba para verificar que las alertas funcionan correctamente.

El panel de **Información del Sistema** muestra el stack tecnológico completo de la plataforma con datos en tiempo real. Cada fila muestra el nombre del componente, versión instalada, fecha de fin de soporte (obtenida de endoflife.date, actualizada cada 24 horas), licencia de software y un indicador de estado:
- **Activo** (verde): con soporte, fin de soporte a más de 90 días
- **Próximo EOL** (ámbar): fin de soporte en 90 días o menos
- **Sin soporte** (rojo): fecha de fin de soporte superada
- **Comunidad** (gris): mantenido por la comunidad sin política de EOL formal

### Pestaña: Apariencia (solo ADMIN)

La pestaña **Apariencia** permite personalizar el aspecto de la plataforma sin necesidad de reiniciar la aplicación.

**Logo de empresa**
- Formatos admitidos: PNG, JPEG, WebP (máx. 2 MB)
- Haz clic en el campo de archivo para seleccionar la imagen; aparecerá una vista previa
- Haz clic en "Subir logo" para aplicarlo
- El logo aparece en la barra lateral y en la pantalla de inicio de sesión
- Si ya existe un logo, el botón "Eliminar logo" lo elimina y vuelve al icono predeterminado

**Colores**
- **Color de sidebar**: fondo de la barra de navegación lateral
- **Color de acento**: color de los elementos activos, botones primarios y bordes de enfoque
- Los cambios se aplican en tiempo real al hacer clic en "Aplicar cambios"
- Una mini vista previa muestra el resultado antes de guardar

**Nombre de empresa**
- El nombre aparece en la parte superior de la barra lateral y en la pantalla de inicio de sesión
- Se guarda junto con los colores al hacer clic en "Aplicar cambios"

Todos los cambios quedan registrados en el Registro de Auditoría.

---

## 18. Datos Maestros — Tipos de CI

> Esta sección solo está disponible para usuarios con rol **ADMIN**.

### Acceder

Haz clic en **"Datos Maestros"** en el menú lateral. En la barra de navegación izquierda, selecciona **"Tipos de CI"**.

### ¿Para qué sirven los tipos de CI?

Los tipos de CI son las categorías que se asignan a cada activo al crearlo, por ejemplo "Servidor Físico", "Laptop" o "Aplicación Web". La plataforma incluye un catálogo predefinido, pero puedes añadir tipos personalizados para adaptarlos a las necesidades de tu organización.

### Añadir un nuevo tipo

1. Haz clic en **"+ Tipo"** junto a la categoría en la que quieres añadirlo.
2. Introduce el nombre del nuevo tipo (por ejemplo, `Firewall`).
3. Haz clic en **"Crear"**.
4. El nuevo tipo estará disponible de inmediato en el selector de tipo al crear o editar activos.

### Editar un tipo existente

1. Pasa el cursor sobre la fila del tipo que quieres editar.
2. Haz clic en el icono de lápiz que aparece al fondo derecho de la fila.
3. Modifica el nombre y haz clic en el icono de check para guardar.

### Eliminar un tipo

1. Pasa el cursor sobre la fila del tipo.
2. Haz clic en el icono de papelera.
3. Confirma la eliminación.

Si existen activos con ese tipo asignado, la eliminación se bloquea y se muestra cuántos activos están afectados. Deberás reasignarlos o eliminarlos antes de poder borrar el tipo.

### Categorías disponibles

| Categoría | Qué incluye |
|-----------|------------|
| **Infraestructura** | Servidores, bases de datos, red, almacenamiento, backup |
| **Dispositivos Usuario** | Equipos de trabajo individuales (laptops, sobremesas, impresoras) |
| **Movilidad/IoT** | Teléfonos, tabletas, sensores conectados |
| **Salas de Reunión** | Proyectores, pantallas, sistemas de videoconferencia |
| **Software** | Aplicaciones web, microservicios, contenedores |
| **Licencias** | Licencias de software |

---

## 19. Datos Maestros — Métricas y Tipos de Licencia

> Esta sección solo está disponible para usuarios con rol **ADMIN**.

### Acceder

Haz clic en **"Datos Maestros"** en el menú lateral. En la barra de navegación izquierda, selecciona **"Métricas de Licencia"** o **"Tipos de Licencia"** según lo que quieras gestionar.

### ¿Qué son las métricas de licencia?

Una **métrica de licencia** es la unidad de medida que define cómo se cuenta el uso de una licencia. Por ejemplo:

- **Usuario nominal** — la licencia se cuenta por persona nombrada.
- **Zócalo de CPU** — la licencia se cuenta por procesador físico del servidor.
- **Dispositivo gestionado** — la licencia se cuenta por equipo registrado.

La plataforma incluye 25 métricas estándar en el catálogo inicial. Puedes añadir las que necesite tu organización.

### ¿Qué son los tipos de licencia?

Un **tipo de licencia** es la categoría comercial o modelo de distribución de la licencia. Por ejemplo:

- **SaaS** — servicio en la nube con suscripción.
- **Perpetua** — licencia de compra única, sin vencimiento.
- **OEM** — licencia incluida con el hardware.
- **Suscripción anual** — licencia renovable anualmente.

La plataforma incluye 14 tipos estándar. Puedes crear los que necesites.

### Crear una nueva métrica o tipo

Las métricas y los tipos se organizan en categorías. Para añadir un nuevo elemento:

1. Localiza la categoría en la que quieres añadirlo.
2. Haz clic en el botón **"Nueva métrica"** (o **"Nuevo tipo"**) que aparece en la cabecera de esa categoría.
3. Rellena los campos del formulario que aparece al final de la lista:
   - **Código** — identificador interno en mayúsculas (por ejemplo, `NAMED_USER`). Se rellena automáticamente en mayúsculas.
   - **Nombre** — el nombre que verán los usuarios al crear una licencia.
   - **Descripción** — texto opcional que explica cuándo se usa esta métrica o tipo.
4. Haz clic en **"Crear"** para guardarlo.

### Editar una métrica o tipo existente

1. Pasa el cursor sobre la fila que quieres editar. Aparecen los botones de acción al lado derecho.
2. Haz clic en el icono de lápiz.
3. Modifica el nombre y/o la descripción.
4. Haz clic en **"Guardar"** para confirmar.

> El código no se puede cambiar una vez creado, ya que es el identificador interno que usan las licencias para referenciarlo.

### Eliminar una métrica o tipo

1. Pasa el cursor sobre la fila que quieres eliminar.
2. Haz clic en el icono de papelera.
3. Confirma la eliminación en el diálogo.

Si alguna licencia activa utiliza esa métrica o ese tipo, la eliminación se bloqueará y se mostrará un mensaje de error. Primero deberás cambiar la métrica o el tipo en esas licencias antes de poder eliminar el elemento del catálogo.

### El icono de candado

Algunos elementos del catálogo muestran un icono de candado pequeño junto a su nombre. Esto indica que el elemento fue creado por la plataforma durante la instalación inicial (elemento de sistema). Aunque lo veas marcado, puedes editarlo o eliminarlo de la misma forma que los elementos personalizados, siempre que no esté en uso en ninguna licencia activa.

---

## 20. Mapa de Dependencias

El Mapa de Dependencias muestra visualmente cómo están conectados los activos entre sí. Es especialmente útil para analizar el impacto de un mantenimiento o una incidencia: de un vistazo puedes ver qué otros sistemas dependen del activo afectado.

### Acceder

Haz clic en **"Mapa"** en el menú lateral.

### Paso 1 — Seleccionar un activo y la profundidad

Al entrar, verás un formulario con dos opciones:

**Buscador de activo:** escribe parte del nombre del activo que quieres explorar y selecciónalo de la lista.

**Profundidad de dependencia:** determina cuántos saltos se recorren desde el activo seleccionado.

| Opción | Descripción |
|--------|-------------|
| 1 nivel | Solo las relaciones directas del activo |
| 2 niveles | Relaciones directas más las relaciones de los activos vecinos |
| 3 niveles | Hasta 3 saltos desde el activo raíz |

Para activos muy conectados, empieza con 1 nivel y amplía progresivamente.

Haz clic en **"Ver dependencias de…"** para cargar el grafo.

### Paso 2 — Vista de Grafo

El activo seleccionado aparece en el centro del grafo, marcado con un borde de color y la etiqueta "origen". Los demás activos se distribuyen en columnas:

- A la izquierda: activos que apuntan hacia el activo raíz (entradas).
- A la derecha: activos a los que apunta el activo raíz (salidas).
- Con profundidad mayor de 1, se añaden columnas adicionales para cada nivel.

Cada flecha lleva una etiqueta con el tipo de relación, codificada por color (índigo para HOSTS, naranja para DEPENDS_ON, verde azulado para CONNECTED_TO, etc.).

Puedes arrastrar el grafo para desplazarte y usar la rueda del ratón para hacer zoom.

### Paso 2 — Vista de Tabla

Haz clic en el botón **"Tabla"** en la cabecera del mapa para ver las mismas relaciones en formato tabular. Las columnas muestran la dirección de la relación, el activo de origen, el tipo de relación, el activo de destino y el nivel de profundidad.

Haz clic en **"Exportar Excel"** para descargar un fichero `.xlsx` con todas las relaciones visibles.

### Controles de la cabecera

| Control | Función |
|---------|---------|
| Cambiar activo | Vuelve al formulario de selección |
| Grafo / Tabla | Alterna entre los dos modos de visualización |
| Botón de refresco | Recarga las relaciones sin cambiar la selección |
| Nueva Relación | Abre el formulario para crear una relación (solo ADMIN) |

---

## 21. Registro de Auditoría

> Solo disponible para usuarios con rol **ADMIN** y **AUDITOR**.

El Registro de Auditoría es el historial inmutable de todas las acciones realizadas en la plataforma: quién hizo qué, cuándo y sobre qué activo o elemento. Es esencial para cumplir con los requisitos de trazabilidad de ISO 27001 y para el trabajo de auditoría interna y externa.

### Acceder

Haz clic en **"Auditoría"** en el menú lateral.

### ¿Qué queda registrado?

La plataforma registra automáticamente las acciones más relevantes:

| Tipo de acción | Cuándo ocurre |
|----------------|---------------|
| **CI Creado** | Se registra un nuevo activo |
| **Relación creada** | Se crea una relación entre dos activos |
| **Vulnerabilidad actualizada** | Se cambia el estado de una vulnerabilidad |
| **Verificación EOL** | Se actualizan las fechas de fin de vida verificadas |
| **Cambio de rol** | Se cambia el rol de un usuario |
| **Cuenta activada** | Se activa una cuenta de usuario |
| **Cuenta desactivada** | Se desactiva una cuenta de usuario |
| **Actualización** | Se edita un documento u otro objeto |
| **Eliminación** | Se borra un objeto del sistema |

### Las columnas de la tabla

La tabla muestra 6 columnas para cada registro:

| Columna | Qué contiene |
|---------|--------------|
| **Fecha / Hora** | Día y hora exacta del evento |
| **Usuario** | Email del usuario que realizó la acción |
| **Acción** | Etiqueta de color que identifica el tipo de acción |
| **Entidad** | El tipo de objeto afectado (activo, vulnerabilidad, documento, usuario…) |
| **Nombre / Detalle** | El nombre legible del objeto afectado: nombre del activo, título del documento, email del usuario, código del CVE junto al nombre del activo, etc. |
| **ID Afectado** | El identificador interno del objeto, útil para consultas técnicas |

### Filtrar los registros

La fila de filtros en la cabecera de la tabla te permite acotar los resultados de cuatro formas:

1. **Rango de fechas** — dos campos de fecha (desde / hasta) que consultan el servidor y cargan solo los eventos del periodo indicado. El sistema muestra un máximo de 500 eventos por consulta.
2. **Búsqueda libre** — un campo de texto que filtra en tiempo real los eventos ya cargados. Busca en todas las columnas: acción, entidad, usuario, nombre/detalle e identificador.
3. **Acción** — un selector desplegable para ver solo un tipo de acción específico.
4. **Entidad** — un selector desplegable para ver solo los eventos que afectan a un tipo de objeto concreto.

El contador de filtros activos aparece junto al botón **"Limpiar"**, que elimina todos los filtros de una sola vez.

### Exportar a Excel

Haz clic en el botón verde **"Excel"** en la esquina superior derecha para descargar un fichero `.xlsx` con los registros actualmente visibles (respetando todos los filtros activos). El fichero se llamará `auditoria_AAAA-MM-DD.xlsx` y contendrá las mismas seis columnas que la tabla.

El botón se desactiva automáticamente cuando no hay registros para exportar.

> Los registros de auditoría son de solo adición: no se pueden editar ni eliminar desde la interfaz. Esto garantiza la integridad del historial y cumple con el control A.12.4 de ISO 27001.

---

## 22. Campos de Resiliencia NIS2 / GDPR

> Disponible en los formularios de creación y edición de activos para usuarios con rol **ADMIN**.

La plataforma incluye un bloque de campos de cumplimiento normativo alineados con la Directiva NIS2, la norma ISO 22301 de continuidad de negocio y el Reglamento General de Protección de Datos (GDPR).

### Campos disponibles

| Campo | Tipo | Para qué sirve |
|-------|------|----------------|
| **Impacto de Negocio (NIS2)** | Bajo / Medio / Alto / Crítico | Clasifica el impacto del activo si falla |
| **Clasificación de Datos (GDPR)** | Público / Interno / Confidencial / Restringido | Indica el nivel de sensibilidad de los datos que maneja |
| **Prioridad de Recuperación** | Número del 1 al 5 | Define el orden de restauración en un plan de contingencia (1 = primero) |
| **RTO (minutos)** | Número | Tiempo máximo tolerable de interrupción del servicio |
| **RPO (minutos)** | Tiempo máximo tolerable de pérdida de datos |
| **Punto Único de Fallo (SPOF)** | Sí / No | Marca el activo como punto único de fallo según ISO 22301 |
| **Contiene Datos Personales (PII)** | Sí / No | Indica si el activo procesa o almacena datos personales sujetos a GDPR |

### Indicadores visuales en el Inventario

Los activos con alguno de estos flags activos muestran etiquetas de colores en la columna de nombre:

| Etiqueta | Color | Significado |
|----------|-------|-------------|
| `SPOF` | Rojo | El activo es un punto único de fallo |
| `PII` | Morado | El activo maneja datos personales (GDPR) |
| `NIS2 Crítico` | Naranja | El activo tiene impacto de negocio crítico |

### Indicadores visuales en el Mapa de Dependencias

Los activos marcados como SPOF aparecen con un borde rojo y la etiqueta `SPOF` en el grafo de dependencias, facilitando la identificación visual de riesgos en la topología de la infraestructura.

### Para qué sirve cada normativa

**NIS2 (Directiva de Seguridad de Redes y Sistemas de Información):**
Clasifica los activos por impacto de negocio para priorizar su protección. Facilita la notificación obligatoria de incidentes al identificar qué sistemas están afectados.

**ISO 22301 (Continuidad de Negocio):**
Los campos RTO y RPO alimentan directamente el Plan de Recuperación ante Desastres. La marca SPOF ayuda a identificar cuellos de botella en la topología que requieren redundancia. La prioridad de recuperación define el orden de restauración en el Plan de Continuidad de Negocio.

**GDPR (Reglamento General de Protección de Datos):**
La clasificación de datos permite inventariar los tratamientos de datos personales, cumpliendo con el artículo 30 del RGPD. El flag PII facilita el mantenimiento del Registro de Actividades de Tratamiento.

---

## 23. Asistente IA — búsqueda inteligente de documentos

### ¿Qué es y para qué sirve?

El Asistente IA es un chat conversacional integrado en la plataforma que permite realizar preguntas en lenguaje natural sobre el contenido de los documentos almacenados — contratos, procedimientos, fichas técnicas, políticas, etc. — y obtener respuestas fundamentadas con citas a las fuentes originales. Todo el procesamiento se realiza en la infraestructura propia del servidor: no se envía ningún documento ni dato personal a servicios externos o a Internet.

### Cómo acceder

En el menú lateral, haz clic en la entrada **"Asistente IA"**. Esto abre la interfaz de chat en `/chat`.

### Hacer una pregunta

1. Haz clic en **"Nueva consulta"** para iniciar una sesión de conversación vacía.
2. Escribe tu pregunta en el campo de texto (máximo 2 000 caracteres) y pulsa **Intro** o haz clic en **"Enviar"**.
3. La respuesta aparece de forma progresiva: los tokens llegan uno a uno mientras el modelo genera la respuesta (streaming).
4. Al final de la respuesta encontrarás citas numeradas (`[1]`, `[2]`…) que enlazan directamente a la página de detalle de los documentos fuente.
5. Cada sesión de conversación queda guardada automáticamente. En el panel izquierdo aparecen todas tus sesiones anteriores; haz clic en cualquiera de ellas para retomarla.

### Reglas del asistente

- El asistente responde **únicamente** a partir de los documentos a los que tu rol tiene acceso. No utiliza conocimiento externo ni Internet.
- Si no encuentra información suficiente en los documentos disponibles, lo indica explícitamente en lugar de inventar una respuesta.
- Las citas `[1]`, `[2]`… corresponden a los fragmentos de texto recuperados que se muestran debajo de la respuesta.
- El asistente ignora instrucciones embebidas en el contenido de los documentos para proteger contra ataques de inyección de prompts.

### Visibilidad de documentos por rol

Cada documento dispone de tres conmutadores de visibilidad que solo el rol **ADMIN** puede editar, accesibles desde la vista de detalle del documento:

| Conmutador | Qué controla |
|------------|-------------|
| **Visible para ADMIN** | Los usuarios con rol ADMIN pueden encontrar este documento en el Asistente IA |
| **Visible para AUDITOR** | Los usuarios con rol AUDITOR pueden encontrar este documento en el Asistente IA |
| **Visible para VIEWER** | Los usuarios con rol VIEWER pueden encontrar este documento en el Asistente IA |

Los tres conmutadores están activos por defecto para todos los documentos existentes en el momento de la actualización. El asistente aplica estos flags en la recuperación: un usuario con rol VIEWER nunca recibirá fragmentos de un documento que tenga el conmutador "Visible para VIEWER" desactivado, aunque el documento sea visible en el repositorio documental para descarga directa.

### Estado de indexación

Para que el Asistente IA pueda responder preguntas sobre un documento, su contenido debe estar indexado en la base de conocimiento local. Cada documento muestra un indicador de estado en su página de detalle:

| Estado | Significado |
|--------|-------------|
| **En cola** | El documento está en espera de procesamiento |
| **Indexando** | El documento se está procesando en este momento |
| **Indexado** | El contenido está disponible para el Asistente IA |
| **Error** | Ocurrió un problema durante la indexación (ver notas del documento) |
| **Sin indexar** | El documento todavía no ha sido enviado al proceso de indexación |

Los documentos se indexan automáticamente en segundo plano al ser subidos. Un usuario con rol **ADMIN** puede forzar el reproceso de cualquier documento haciendo clic en **"Re-indexar"** en la vista de detalle.

Para volver a poner en cola todos los documentos en bloque (por ejemplo, tras una actualización del modelo), un administrador puede usar la operación de reindexación masiva disponible en la sección de administración (`POST /api/admin/rag/backfill`). Consulta el Manual del Administrador §19 para más detalles.

### Limitaciones

- **OCR automático:** los PDFs escaneados (sin capa de texto) se indexan automáticamente mediante Tesseract OCR. El proceso es transparente — el documento aparecerá como **Indexado** una vez completado (puede tardar varios minutos según el número de páginas).
- **Tiempo de primera respuesta (TTFT):** aproximadamente 1–2 segundos desde que se envía la pregunta hasta que aparece el primer token.
- **Duración de la respuesta completa:** entre 10 y 18 segundos para una respuesta de unos 250 tokens, dependiendo de la carga del servidor.
- **Modelo local:** el sistema utiliza un modelo de lenguaje local (Ollama). No se realiza ninguna transferencia de datos a Internet ni a servicios de terceros.

### Filtrar las fuentes de búsqueda

Bajo el cuadro de pregunta se muestran cinco "chips" de tipo de fuente: **Documentos**, **CIs**, **Contratos**, **Licencias** y **Vulnerabilidades**. El asistente puede consultar cualquiera de ellas además de los documentos textuales tradicionales.

- Sin ningún chip seleccionado, el asistente busca en **todas** las fuentes disponibles.
- Al pulsar uno o varios chips, la consulta se limita a esos tipos. La selección es multi-respuesta (puedes activar varios) y se conserva durante la sesión del navegador (al cerrar la pestaña, vuelve al estado por defecto).
- El botón **Limpiar** restablece la selección a "todas las fuentes".
- **Chip Contratos:** cuando está activo, el asistente busca no solo en los registros de contratos, sino también en los documentos PDF asociados al contrato y en los activos (CIs) que cubre. Por ejemplo, si seleccionas este chip y preguntas por "condiciones de soporte Oracle", el asistente consultará el contrato, las adendas vinculadas y los CIs relacionados.
- **Chip Licencias:** comportamiento análogo: incluye los documentos y CIs asociados a las licencias.
- Si recientemente se ha activado el subsistema RAG por primera vez, algunas categorías pueden aparecer vacías hasta que el proceso de indexación en segundo plano las procese. El administrador puede acelerarlo con un reindex completo (ver Manual del Administrador §19.10).

Las citas que devuelve el asistente incluyen un icono identificativo del tipo de fuente (documento, CI, contrato, licencia o vulnerabilidad) y, al hacer clic, abren la página correspondiente del inventario, contratos, licencias o vulnerabilidades, ya filtrada por el elemento citado.

> El asistente responde siempre en el **idioma de la interfaz** (configurable en tu perfil). Si los documentos están en inglés y la interfaz está en español, las respuestas se generan en español.

> Para los requisitos de hardware del servidor, la configuración de Ollama y las opciones de aceleración GPU, consulta el **Manual del Administrador de Sistemas, §19 y §21**.

> Para los requisitos de hardware del servidor, la configuración de Ollama, la gestión del modelo y los procedimientos de mantenimiento del subsistema RAG, consulta el **Manual del Administrador de Sistemas, §19 — Subsistema RAG**.

---

## 25. Módulo DCIM — Salas técnicas y CPD (v2.6.0)

El módulo DCIM (Data Center Infrastructure Management) permite modelar y visualizar la infraestructura física de los centros de datos de la organización.

### 25.1 Acceso y permisos

| Rol | Dashboard | Admin | Editar plano | Ubicar CIs |
|-----|-----------|-------|--------------|------------|
| ADMIN | ✅ | ✅ | ✅ | ✅ |
| AUDITOR | ✅ | — | — | — |
| VIEWER | — | — | — | — |

### 25.2 Jerarquía física

```
Sede (Branch) → Edificio → Planta → Sala/CPD → Pasillo → Huella → Rack (CI)
```

### 25.3 Dashboard `/dcim`

- **KPIs**: total edificios, salas, racks asignados y alertas activas de potencia.
- **Lista de salas**: haz clic en cualquier sala para acceder a su plano 2D.
- **Widget de alertas de potencia**: racks donde el consumo supera la capacidad máxima configurada.
- **Botón "Gestionar"** (solo ADMIN): accede a `/dcim/admin` para crear la jerarquía.

### 25.4 Administración `/dcim/admin`

Interfaz jerárquica con CRUD inline (expandir/contraer por nivel):

1. Selecciona una **Sede** en el filtro superior.
2. Expande un **Edificio** → añade/edita/elimina plantas.
3. Expande una **Planta** → añade/edita/elimina salas.

### 25.5 Vista de sala `/dcim/rooms/[id]`

- **Plano 2D** (ReactFlow): pan y zoom con ratón/trackpad. Cada celda es una huella del plano.
  - 🟩 Verde: rack slot con rack asignado.
  - ⬜ Blanco con borde verde discontinuo: rack slot libre.
  - 🔲 Gris: infraestructura (PDUs, patches, etc.).
- **Clic en un rack** → abre el panel lateral de **elevación de rack** (vista 2D SVG con slots U).
- **Toggle FRONT/REAR** en el panel de elevación: muestra la cara frontal o trasera del rack.
- **Heatmap de potencia** (botón llama 🔥): colorea los racks según % de consumo vs. capacidad.
- **Modo edición** (ADMIN): activa el botón "Editar plano" para añadir/modificar/eliminar huellas.
- **Editar sala**: modifica nombre, tipo y dimensiones físicas con el botón "Editar sala".

### 25.6 Ubicar un CI en un rack

Desde el detalle de cualquier CI hardware (botón **"Ubicar en rack"** en `CIDetailModal` o `EditCIModal`):

1. Selecciona **Sede → Edificio → Planta → Sala → Rack**.
2. Introduce **Posición U** (desde abajo), **Tamaño U**, **Consumo W** y **Orientación** (FRONT/REAR).
3. El sistema detecta conflictos de slots automáticamente antes de confirmar.
4. Pulsa **Confirmar ubicación**. Se registra un evento de auditoría `CI_PLACEMENT`.

Para quitar un CI del rack, abre el mismo modal y pulsa **"Quitar del rack"**.

### 25.7 Alertas de potencia

El sistema ejecuta un análisis diario a las 04:00 (hora Madrid) que detecta racks sobrecargados y registra eventos `DCIM_POWER_ALERT` en el log de auditoría. Estos eventos son consultables desde **Auditoría** filtrando por acción `DCIM_POWER_ALERT`.

### 25.8 Notas importantes

> ⚠️ No incluyas datos personales (nombres, DNIs, correos) en los campos de notas de edificios, plantas o salas. Estos campos son para descripción técnica, no para datos de personas (GDPR).

> La vista 3D de sala está prevista para **v2.7.0**.

---

## 26. Datos Maestros — Sistema Operativo y Software Base (v2.7.0)

### 26.1 Maestro: Sistema Operativo

Accede desde el menú **Administración → Maestros → Sistema Operativo** (solo ADMIN).

Los sistemas operativos registrados aquí pueden asignarse a cualquier CI desde su ficha de edición (**Editar CI → Campos de infraestructura → Sistema Operativo**).

| Campo | Tipo | Descripción |
|-------|------|-------------|
| Nombre | Texto | Nombre del SO (ej. "Ubuntu Server") |
| Versión | Texto | Versión (ej. "22.04 LTS") |
| Código interno | Auto | Generado automáticamente como slug en mayúsculas |
| Fabricante | Texto | Opcional |
| Fecha EoL | Fecha | End-of-Life; activa alertas automáticas |
| Notas | Texto | Notas técnicas |

### 26.2 Maestro: Software Base

Accede desde **Administración → Maestros → Software Base** (solo ADMIN).

El software base modela middleware y agentes del sistema instalados en servidores físicos, virtuales o cloud (no aplicaciones de negocio, que van en Contratos/Licencias).

| Campo | Tipo | Descripción |
|-------|------|-------------|
| Nombre | Texto | Nombre del software (ej. "Apache Tomcat") |
| Versión | Texto | Versión instalada |
| Tipo | Selección | `MIDDLEWARE`, `AGENT`, `RUNTIME`, `DATABASE`, `OTHER` |
| Vendor | Texto | Fabricante |
| Fecha EoL | Fecha | End-of-Life para alertas |

Para asociar software base a un CI: abre el CI, ve a la pestaña **Software Base** y usa **Añadir software base**. Un CI puede tener múltiples entradas de software base.

---

## 27. Campos de Infraestructura en CI (v2.7.0)

Los CIs de tipo servidor (físico, virtual o cloud) disponen ahora de campos de infraestructura en su ficha:

| Campo | Tipo | Aplicable a |
|-------|------|-------------|
| Nombre de host | Texto | Todos los servidores |
| IP de gestión | IP | Todos los servidores |
| IP de administración | IP | Todos los servidores |
| DNS | Texto | Todos los servidores |
| Sistema Operativo | Selección | Todos los servidores (FK a maestro) |
| Clúster | Texto | Virtual / Cloud |
| vCPUs | Número | Virtual / Cloud (excluyente con Modelo CPU) |
| Modelo CPU | Texto | Servidores físicos (excluyente con vCPUs) |
| RAM (GB) | Número | Todos los servidores |
| Disco (GB) | Número | Todos los servidores |
| Versión firmware | Texto | Servidores físicos |

> **Nota:** `vCPUs` y `Modelo CPU` son mutuamente excluyentes. Si se especifican ambos, el servidor devuelve un error de validación.

Estos campos son visibles en el detalle del CI y exportables en el informe Excel de inventario.

---

## 28. Alta Masiva — Creación en Cascada (v2.7.0)

El importador Excel de **Alta Masiva** ahora admite columnas adicionales para crear registros de datos maestros de forma automática durante la importación:

| Columna Excel | Comportamiento |
|---------------|----------------|
| `os_name` + `os_version` | Crea o reutiliza (idempotente) un Sistema Operativo en el maestro |
| `base_software` (lista separada por `\|`) | Crea o reutiliza cada software base y lo asocia al CI |

Si el sistema operativo o software base ya existe (mismo nombre+versión), se reutiliza sin duplicar. Si no existe, se crea en el mismo lote transaccional.

> Un error en la creación en cascada de maestros no cancela la importación del CI; el CI se crea igualmente y el campo afectado se deja en blanco.

---

## 29. Mapa de Relaciones (v2.7.0)

El **Mapa de Relaciones** (antes "Mapa de Dependencias") ha sido ampliado con 12 nuevos tipos de relación organizados en 4 categorías semánticas.

### 29.1 Categorías y tipos de relación

| Categoría | Color | Tipos de relación |
|-----------|-------|-------------------|
| Estructural | Índigo | `CONTAINS`, `COMPOSED_OF`, `ATTACHED_TO` |
| Red | Teal | `CONNECTS_TO`, `UPLINKS_TO`, `CONNECTED_TO` |
| Eléctrica | Ámbar | `POWERS`, `PROTECTS` |
| Lógica | Naranja | `HOSTS`, `DEPENDS_ON`, `PROVIDES_SERVICE`, `BACKED_UP_BY`, `REPLICATES_TO`, `RUNS_ON`, `QUERIES`, `LICENSES`, `MANAGES` |

### 29.2 Uso del mapa

1. Accede a **Mapa de Relaciones** desde el menú lateral.
2. Selecciona un CI de origen en el selector superior.
3. Ajusta la **profundidad** (1–5) para ampliar o reducir el alcance del grafo.
4. La leyenda de categorías (esquina inferior izquierda) identifica el color de cada arista.
5. Filtra por tipo de relación con el selector de filtro.
6. Exporta el grafo a Excel con el botón de descarga.

### 29.3 Validación de tipo por CI

Al crear una relación desde **Añadir Relación**, el selector filtra automáticamente los tipos permitidos según el tipo de CI en cada extremo. Por ejemplo, `POWERS` solo aparece si el CI origen es de tipo `PDU` o `UPS`.

---

## 30. Registro de Eventos — Mejoras (v2.7.0)

### 30.1 Detalle de evento

Cada entrada del **Registro de Eventos** muestra ahora un campo de descripción que explica la operación realizada (ej. "CI SRV-PROD-01 creado"). Las entradas que incluyen cambios estructurados muestran un detalle de campo→valor anterior→valor nuevo.

### 30.2 Filtro por nombre de entidad

La columna **Entidad** del registro dispone ahora de un campo de búsqueda que filtra en tiempo real por nombre de entidad (nombre del CI, usuario, contrato, etc.).

- La búsqueda es **insensible a mayúsculas/minúsculas**.
- Acepta fragmentos: `SRV` coincide con `SRV-PROD-01`, `SRV-TEST-02`, etc.
- Se combina con los filtros de fecha existentes.

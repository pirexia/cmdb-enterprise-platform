# v2.6.1 — DCIM Rack Placement Full Flow

**Fecha:** 2026-06-10
**Tag:** `v2.6.1` · **Rama:** `main` (merge desde `develop`)
**Release anterior:** [`v2.6.0`](./SPEC_v2.6.0_dcim.md) — DCIM Module 2D MVP

Esta release completa el flujo de colocación de CIs en racks del módulo DCIM, estabiliza el plano 2D de salas (RoomPlan2D / RackElevation2D) y añade endurecimiento de repositorio y documentación de skills.

---

## ✨ Novedades (Features)

### Flujo completo de colocación en rack
- **Botón "Asignar rack"** en el panel de edición de footprint, que abre el flujo de placement completo (`d479e8a`).
- **Validación de solapamiento de slots-U** al colocar un CI: impide ocupar unidades de rack ya usadas (M5), con **UX de placement integrada en `EditCIModal`** (M6) (`602b561`).
- **Sección "Ubicación en rack" en `CIDetailModal`** con pre-relleno de los datos de placement al editar (`6f99b2f`).
- **Flujo de colocación end-to-end** consolidado como candidato de release (`4db4465`).
- **Tipos de footprint (footprint kinds)**, panel de edición inline y **protección de borrado con 409** cuando el footprint tiene dependencias (`e9b1660`).

### API
- Nuevo endpoint **`GET /api/cis/:id`** para obtener un CI individual; corrige además el click sobre un CI en la vista de rack elevation (`d26030c`).

---

## 🐛 Correcciones (Fixes)

### Rack elevation (vista 2D de rack)
- Tooltip/hover con **caja de info de altura fija**, sin saltos de layout (`e0dad1d`).
- Tooltip **sin bucle de render** y altura que rellena el drawer correctamente (`842c2da`).
- Dropdown de selección de CI: **maneja `ciType` tanto como string como objeto** (`31ac1b0`).

### RoomPlan2D (plano 2D de sala)
- **Bug "Añadir huella no guarda":** el esquema Zod aceptaba `aisleId: null` y el error no era visible; corregido + feedback de error al usuario (`5b57ab0`).
- Handler **`onPaneClick` robusto** y nodo `AddCellNode` decorativo (`pointer-events:none`) (`1a2b846`).
- **`className "nopan nodrag"`** en custom nodes — solución oficial de ReactFlow para clicks (`887c2b7`).
- **UI en metros** + `stopPropagation` en nodos para permitir clicks en modo edición (`30ee2c5`).
- **Celdas rectangulares 800×1200 mm** (rack estándar) y pasillos como filas completas (`6cc6873`).
- **Grid ajustado a las dimensiones reales de la sala**; `panOnDrag` con botón medio/derecho en modo edición (`6a096a1`).
- `getRoomPlan` incluye `floor` + `building` en la query — corrige *"Cannot read building of undefined"* (`1fd5607`).
- **Dynamic import `ssr:false`** para `RoomPlan2D` y `RackElevation2D` (APIs de navegador de ReactFlow) (`5fc7531`).
- `error.tsx` en `rooms/[id]` para capturar el error exacto de render (debug) (`49ed0c1`).

---

## 🌐 Internacionalización
- Nuevas claves de DCIM (placement, footprint, rack) añadidas a los **6 idiomas**: `es`, `en`, `de`, `pt`, `fr`, `it`.

---

## 🔧 Mantenimiento y documentación (Chore / Docs)
- **`CLAUDE.md`:** inventario completo de skills (27: globales + de proyecto), tabla de mapeo tarea→skill, y **convención de módulos desde v2.6.0** (`backend/src/modules/<name>/`); corrección de versiones de stack (Prisma 6, otplib, bcrypt 12) y conteo real de `index.ts` (`afef07c`).
- **`.gitignore`:** ignorar uploads de runtime (`document-storage/*.pdf`, `_staging/`) y el grafo generado `graphify-out/` (`394040d`).
- **Untrack de 3 PDFs** subidos en runtime que estaban versionados por error — se mantienen en disco (`0ce8dea`).
- **Hooks de graphify** (`PreToolUse`) añadidos como settings de proyecto compartidos en `.claude/settings.json` (`a628064`).

---

## 📦 Resumen de cambios

```
23 commits · 23 archivos · +916 / −203 líneas
```

**Áreas tocadas:**
- Backend DCIM: `modules/dcim/{router,schemas,queries}.ts`
- Frontend DCIM: `app/dcim/rooms/[id]/page.tsx`, `app/dcim/admin/page.tsx`, `components/dcim/{RoomPlan2D,RackElevation2D}.tsx`
- Modales: `CIDetailModal.tsx`, `EditCIModal.tsx`
- i18n: `locales/{es,en,de,pt,fr,it}.json`
- Repo: `CLAUDE.md`, `.gitignore`, `.claude/settings.json`

---

## 🔒 Seguridad y compliance
- Sin nuevas dependencias ni cambios de superficie de auth.
- Endpoint `GET /api/cis/:id` protegido por la cadena de auth existente (`authenticateToken`).
- Eliminados del control de versiones PDFs de runtime con posible PII (mitigación de fuga de datos — A.8.12 ISO 27001 / GDPR).

> **Nota:** los 3 PDFs untrackeados siguen presentes en el **historial de git** anterior a esta release. Si se requiere borrado total por PII, planificar una reescritura de historial (`git filter-repo`) como tarea aparte.

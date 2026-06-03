# SPEC — DCIM (Data Center Infrastructure Management) module — v2.6.0

> Estado: 🟡 DRAFT — pendiente OK del usuario + respuesta a Open Questions
> Rama: `feature/dcim-3d-rooms` (desde develop, a crear)
> Fecha: 2026-06-03

---

## 1. Visión

Añadir un módulo de gestión visual de salas técnicas y CPD al CMDB Enterprise Platform, permitiendo:
- Modelar la jerarquía física (Sede → Edificio → Planta → Sala/CPD → Pasillo → Huella → Rack → CI).
- Visualizar racks en 2D (elevación) y la sala completa en 3D (vista a vuelo de pájaro + rotación).
- Detectar y alertar sobre sobreconsumo de potencia en racks.
- Auditar todos los movimientos físicos (ISO 27001 A.8.15).
- Cumplir GDPR (sin PII física), NIS2 Art.23 (trazabilidad de cambios), ISO 22301 (recuperación).

**Alcance MVP (v2.6.0):** según respuesta a Q1 (ver § Open Questions).

---

## 2. Investigación de mercado

(Resumen del agente de research — 2026-06-03)

**Software analizado:** NetBox, Device42, Sunbird dcTrack, RackTables, OpenDCIM, Hyperview.

**5 must-haves comunes a todos:**
1. Elevación 2D de rack con posicionamiento U (front/rear, opcional half-U)
2. Modelo de power chain: dispositivo → PDU/outlet → panel → feed, con alertas capacidad vs. consumo
3. Ocupación U + peso por rack con dashboard de capacidad
4. Gestión de cableado (red + power) con trazado de rutas port-to-port
5. Workflow de ciclo de vida (planned → in-inventory → commissioned → decommissioned) atado a audit log

**5 differentiators:**
1. Vista 3D real de sala con calibración de plano (DXF/PDF import)
2. Heatmaps de capacidad sobre el plano (power, temp, peso, densidad)
3. "What-If" placement simulator (busca U libre + power + cooling)
4. Time-lapse ambiental (tendencias térmicas/humedad)
5. Simulación de fault-tolerance (qué CIs caen si falla un feed)

**Recomendación técnica:** react-three-fiber (R3F) + drei sobre three.js. NetBox/Sunbird empiezan con 2D y añaden 3D por encima — ese es el patrón probado.

---

## 3. Modelo de datos (propuesta)

### Jerarquía física

```
Branch (Sede, ya existe en Datos Maestros)
  └─ Building (Edificio) [NUEVO]
       └─ Floor (Planta) [NUEVO]
            └─ Room (Sala / CPD) [NUEVO]
                 └─ Aisle (Pasillo) [NUEVO]   ← TBD según Q2
                      └─ Footprint (Huella) [NUEVO]
                           └─ Rack (CI con CIType="Rack") [EXISTE como CI, nuevo tipo]
                                └─ CI (ocupa N U's desde la posición X)
```

### Nuevas tablas (esquema preliminar)

```prisma
// Prefijo dcim_ para namespace claro.

model DcimBuilding {
  id        String   @id @default(uuid())
  branchId  String   @map("branch_id")    // FK a Branch existente
  name      String                          // "Edificio A", "Torre Norte"
  code      String?                         // opcional para reportes
  notes     String?
  branch    Branch   @relation(...)
  floors    DcimFloor[]
  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")
  @@unique([branchId, name])
  @@index([branchId])
  @@map("dcim_buildings")
}

model DcimFloor {
  id          String   @id @default(uuid())
  buildingId  String   @map("building_id")
  name        String                          // "Planta -1", "Planta 0"
  levelNumber Int                              // -2, -1, 0, 1, 2 (para ordenar)
  notes       String?
  building    DcimBuilding @relation(...)
  rooms       DcimRoom[]
  // ...timestamps
  @@unique([buildingId, levelNumber])
  @@map("dcim_floors")
}

model DcimRoom {
  id              String   @id @default(uuid())
  floorId         String   @map("floor_id")
  name            String                       // "CPD Principal", "Sala Técnica RNA"
  kind            String                       // "CPD" | "TECHNICAL_ROOM"
  widthMm         Int?     @map("width_mm")    // dimensiones físicas (opcional)
  depthMm         Int?     @map("depth_mm")
  notes           String?
  floor           DcimFloor @relation(...)
  aisles          DcimAisle[]
  footprints      DcimFootprint[]
  // ...timestamps
  @@unique([floorId, name])
  @@map("dcim_rooms")
}

model DcimAisle {
  id        String   @id @default(uuid())
  roomId    String   @map("room_id")
  name      String                              // "Pasillo A", "Hot Aisle 1"
  kind      String?                              // "HOT" | "COLD" | "MIXED"
  orderIdx  Int                                  // orden visual en el plano
  room      DcimRoom @relation(...)
  footprints DcimFootprint[]
  @@unique([roomId, name])
  @@map("dcim_aisles")
}

model DcimFootprint {
  id          String   @id @default(uuid())
  roomId      String   @map("room_id")
  aisleId     String?  @map("aisle_id")         // null si no se modela en pasillo
  label       String                               // "A1", "B3", "P-12"
  kind        String                               // "RACK_SLOT" | "INFRASTRUCTURE" | "EMPTY"
  active      Boolean  @default(true)              // huellas inactivas no aceptan racks
  gridX       Int                                   // coordenada en el plano 2D
  gridY       Int
  // Si kind="RACK_SLOT" y active=true → puede asociarse a un CI rack
  rackCiId    String?  @unique @map("rack_ci_id") // FK al CI rack (1:1)
  rackCi      CI?      @relation(...)
  // ...timestamps
  @@unique([roomId, gridX, gridY])                  // una huella por celda
  @@index([roomId])
  @@map("dcim_footprints")
}
```

### Extensiones a `HardwareCI`

```prisma
model HardwareCI {
  // ...existente
  sizeU            Int?      @map("size_u")            // ocupación en U (1, 2, 4...)
  powerW           Int?      @map("power_w")           // consumo en watts
  // Para racks específicamente:
  rackTotalU       Int?      @map("rack_total_u")      // 42, 48...
  rackPowerMaxW    Int?      @map("rack_power_max_w")  // capacidad total
  rackWidthMm      Int?      @map("rack_width_mm")     // 600 (clásico), 800...
  rackDepthMm      Int?      @map("rack_depth_mm")     // 1000, 1200...
  // Posicionamiento del CI dentro de su rack:
  parentRackCiId   String?   @map("parent_rack_ci_id") // FK al CI rack contenedor
  uPosition        Int?      @map("u_position")         // posición U (1 = bottom)
  orientation      String?                                // "FRONT" | "REAR"  (Q4 ✅)
  // Lifecycle workflow (Q4 ✅):
  lifecycleStatus  String?   @map("lifecycle_status")    // PLANNED | IN_INVENTORY | COMMISSIONED | DECOMMISSIONED
}
```

### Lifecycle workflow

`lifecycleStatus` aplica tanto a racks como a CIs hardware ubicados. Transiciones permitidas:
```
PLANNED ─────────► IN_INVENTORY ──► COMMISSIONED ──► DECOMMISSIONED
                       ▲                                     │
                       └─────────────────────────────────────┘   (re-deploy)
```
Cada transición emite audit log `CI_LIFECYCLE_CHANGE` con `{ from, to, reason? }`.

### Nuevo CIType

Insertar fila en `ci_types`: `name = "Rack"`, `category = HARDWARE`, `isSystem = true`. Seed en la migración.

---

## 4. API surface (preliminar)

```
# Buildings
GET    /api/dcim/buildings
POST   /api/dcim/buildings       (ADMIN)
PATCH  /api/dcim/buildings/:id   (ADMIN)
DELETE /api/dcim/buildings/:id   (ADMIN)

# Floors / Rooms / Aisles / Footprints — patrón idéntico
GET    /api/dcim/floors / rooms / aisles / footprints
POST   /api/dcim/...     (ADMIN)
PATCH  /api/dcim/...     (ADMIN)
DELETE /api/dcim/...     (ADMIN)

# Rack assignment (asociar huella ↔ rack CI)
POST   /api/dcim/footprints/:id/assign-rack   { ciId }   (ADMIN)
DELETE /api/dcim/footprints/:id/assign-rack             (ADMIN)

# CI placement (posicionar CI dentro de rack)
PATCH  /api/cis/:id/placement    { parentRackCiId, uPosition, orientation, sizeU, powerW }   (ADMIN)

# Dashboard / views
GET    /api/dcim/dashboard                    (AUDITOR+)
GET    /api/dcim/rooms/:id/plan               (AUDITOR+)   — devuelve grid + footprints + racks
GET    /api/dcim/racks/:ciId/elevation        (AUDITOR+)   — devuelve U slots + CIs ocupantes
GET    /api/dcim/alerts                       (AUDITOR+)   — overpower racks, capacity issues
```

**RBAC:**
- AUDITOR + ADMIN: read (GET)
- ADMIN: write (POST/PATCH/DELETE)
- VIEWER: NO acceso (el usuario lo pidió explícitamente)

**Audit logs:** todos los writes producen `CREATE_DCIM_*` / `UPDATE_DCIM_*` / `DELETE_DCIM_*` con detalles.

---

## 5. UI/UX

### Nueva entrada de menú
- "Salas técnicas y CPD" en el sidebar (sólo visible para ADMIN+AUDITOR).
- Icono: `Server` o `Building` de lucide-react.

### Páginas
1. `/dcim` — Dashboard
   - KPIs: total CPDs/salas, total racks, % U ocupada global, alertas activas
   - Lista de salas con click-through
   - Widget de alertas: racks con `powerW_sum > rack_power_max_w`
   - Widget de capacidad: top 5 racks más llenos

2. `/dcim/rooms/[id]` — Vista de sala
   - Toggle 2D / 3D (R3F)
   - Vista 2D: grid SVG con huellas (rack=verde, infra=gris, libre=blanco), click rack → drawer
   - Vista 3D: `<Canvas>` R3F con InstancedMesh de boxes por footprint, OrbitControls
   - Drawer al clicar rack: muestra elevación 2D del rack (SVG) con CIs en sus U slots

3. `/dcim/rooms/[id]/edit` — Editor de plano (ADMIN)
   - Define grid (filas × columnas), añade/elimina pasillos, marca footprints como activos/infra/rack_slot
   - Drag&drop opcional (v2.7)

4. `/admin/masters` — Extender con tabs:
   - "Edificios", "Plantas", "Salas/CPD" (CRUD básico, alternativa a editar desde `/dcim`)

### i18n
- Nuevo namespace `dcim.*` en `frontend/locales/{es,en,de,pt,fr,it}.json`
- ~40-50 claves nuevas

---

## 6. Tecnología y dependencias nuevas

| Paquete | Versión | Propósito |
|---------|---------|-----------|
| `three` | ^0.169 | Engine WebGL |
| `@react-three/fiber` | ^9.0 | Renderer React para Three |
| `@react-three/drei` | ^9.x | Helpers (OrbitControls, Bounds, etc.) |
| Opcional: `troika-three-text` | ^0.49 | Labels 3D suaves |

Bundle frontend crecerá ~250-400 KB gzipped. Aceptable.

---

## 7. Cálculo de requerimientos

### CPU/RAM
- Backend: nuevos endpoints son CRUD ligero + queries SQL no más caras que las existentes. **Sin impacto.**
- Frontend: rendering R3F en cliente; el backend no renderiza. **Sin impacto.**
- Postgres: tablas DCIM tienen <10k filas en una instalación típica. **Sin impacto.**

### Disco
- Nuevas tablas: <50 MB en una instalación grande. **Sin impacto significativo.**

### Red
- Endpoint `GET /api/dcim/rooms/:id/plan` devuelve ~10-50 KB JSON (grid + footprints). OK.
- Modelos 3D opcionales en una iteración futura (no en MVP).

**Conclusión:** **no se requieren ajustes de infraestructura.** El módulo es CRUD + frontend pesado en cliente.

---

## 8. Seguridad y Compliance

### OWASP (preview)
- A01: nuevos endpoints `requireAdmin` para writes, `requireAuditor` para reads. VIEWER bloqueado.
- A03: todas las queries con Prisma o `$queryRaw` tagged. No string concat.
- A04: validación Zod en todos los bodies. UUIDs validados.
- A05: helmet ya cubre headers. CSP no requiere cambios (R3F es WebGL puro, sin eval).
- A08: `width_mm` y `depth_mm` tienen `CHECK (value > 0 AND value < 100000)` para evitar overflow.
- A09: audit log en cada write DCIM.
- A10: no se hacen llamadas salientes desde el módulo DCIM.

### ISO 27001
- A.8.15: audit logs insert-only (ya garantizado por el patrón existente).
- A.9.2: RBAC estricto (sólo ADMIN escribe).
- A.5.37: este SPEC documenta procedimientos operativos.

### GDPR
- Sin PII: footprints, racks, salas no contienen datos personales. ✅
- Notas free-text (`notes` field) podrían contener PII por error → política: no incluir datos personales (documentar en User Manual).

### NIS2
- Art.23: audit trail completa permite reconstruir movimientos físicos. ✅
- Supply chain: nuevas dependencias (`three`, R3F) → `npm audit` antes del merge.

### ISO 22301
- Rollback de cada migración documentado en `migration.sql` (comentario).
- Recuperación: DCIM data está en Postgres principal → backup ya existente.

---

## 9. Open Questions — RESUELTAS (2026-06-03)

### Q1: Alcance MVP — ✅ A) 2D primero
v2.6.0 entrega elevaciones 2D de rack + plano 2D de sala. **M7 (3D view) se mueve a v2.7.0**. Toggle 2D/3D presente en UI con 3D marcado como "Coming soon". Tiempo estimado 3-4 semanas.

### Q2: Pasillos (Aisle) — ✅ A) Aisle explícito (6 niveles)
`DcimAisle` es una entidad con CRUD propio. Las huellas se asignan a un Aisle. Soporta `kind = HOT | COLD | MIXED`.

### Q3: Floor plan — ✅ A) Generado por código
Editor define grid N×M, cada celda se marca como `RACK_SLOT | INFRASTRUCTURE | EMPTY | AISLE`. DXF/PDF import → backlog v2.7+.

### Q4: Features extras — ✅ SELECCIONADAS
- ✅ **Front/Rear positioning**: campo `orientation` en HardwareCI (FRONT | REAR). Render diferenciado.
- ✅ **Heatmap power overlay**: capa visual sobre el plano de sala (gradiente color por consumo % vs capacidad por rack).
- ✅ **Lifecycle workflow**: nuevo campo `lifecycleStatus` para racks y CIs físicos (`PLANNED | IN_INVENTORY | COMMISSIONED | DECOMMISSIONED`). Audit log en cada transición.
- ❌ Weight tracking — fuera de scope, queda en backlog.
- ❌ Cable management, half-U, what-if simulator — fuera de scope (no seleccionados).

---

## 10. Plan de implementación (alto nivel)

Detallado en `docs/PLAN_v2.6.0.md`. Resumen:

1. Schema + migraciones (M1)
2. Backend CRUD + audit (M2)
3. Frontend masters extensions (M3)
4. Frontend /dcim dashboard + room list (M4)
5. 2D rack elevation (M5)
6. 2D room plan (M6)
7. 3D room view (M7) — sujeto a Q1
8. Power alerts engine (M8)
9. CI placement UI (M9)
10. OWASP + Compliance (M10)
11. Release v2.6.0 (M11)

---

## 11. Backlog / fuera de scope para v2.6.0

- Floor plan DXF import (Q3 = A)
- Environmental sensors integration
- AR mode
- Time-lapse playback
- Multi-tenant (sólo si el cliente lo pide)
- Fault-tolerance simulator
- 3D models GLTF de servidores específicos (MVP usa boxes parametrizados)

---

## 12. Cambios al spec

> Cualquier cambio al spec posterior a la aprobación se documenta aquí con fecha + razón.

_(vacío)_

# Plan Status — v3.1.0 · Módulo Línea de Tiempo (Gantt)

> Branch: `develop` | Inicio: 2026-06-22 | Alcance: parar en develop (no tocar main sin orden explícita)

## Estado de tareas

| # | Tarea | Estado | Notas |
|---|-------|--------|-------|
| T1 | Plan y diseño (Opus) | ✅ Completada | Plan aprobado por usuario; librería: react-modern-gantt |
| T2 | Backend módulo timeline | ✅ Completada | `backend/src/modules/timeline/` — 3 endpoints OK, tsc limpio, smoke test OK |
| T3 | Frontend Gantt | ⏳ Pendiente | |
| T4 | Panel de filtros | ⏳ Pendiente | |
| T5 | Visualización fina | ⏳ Pendiente | |
| T6 | Sidebar + nav | ⏳ Pendiente | |
| T7 | i18n 6 idiomas | ⏳ Pendiente | |
| T8 | Tests y validación manual | ⏳ Pendiente | |
| T9 | Documentación | ⏳ Pendiente | |
| T10 | Release a main | ⏸️ Fuera de alcance | Parar en develop; ejecutar solo con orden explícita |

## Decisiones arquitectónicas

- **Librería Gantt:** `react-modern-gantt@^0.9.0` (peerDep react ^17||^18||^19 ✅). Fallback: SVG custom (patrón decommission/[id]) si falla restyling bajo Next 16.
- **Ruta:** `/timeline` | **Label i18n:** `sidebar.timeline` → "Línea de Tiempo"
- **Backend mount:** `app.use('/api/timeline', authenticateToken, createTimelineRouter(prisma))` — VIEWER permitido (read-only)
- **Sin AuditLog:** módulo 100% read-only; A.8.15 aplica solo a mutaciones
- **Color:** derivado en frontend `lib/timelineColor.ts`; backend devuelve fechas + status crudos
- **CI→BaseSoftware:** M:M vía `CIBaseSoftware`; `/legacy/:ciId` agrega de todos los registros
- **Contract sin status:** estado derivado de `endDate` en el frontend

## Modelo de datos unificado (TimelineItem)

```ts
type TimelineKind = 'ci' | 'contract' | 'license' | 'decommission' | 'os' | 'software' | 'model';
interface TimelineMilestone {
  type: 'eol'|'eos'|'lastCheck'|'end'|'completed'|'custom';
  date: string;       // ISO yyyy-mm-dd
  label: string;
  inherited?: boolean;
  inheritedFrom?: 'os'|'software'|'model';
}
interface TimelineItem {
  id: string; kind: TimelineKind; name: string;
  subType?: string;
  status?: string;
  startDate?: string; endDate?: string;
  milestones: TimelineMilestone[];
}
```

## Endpoints

- `GET /api/timeline/items?types=&ciTypeId=&status=&dateTypes=&search=&limit=&offset=`
- `GET /api/timeline/filters`
- `GET /api/timeline/legacy/:ciId`

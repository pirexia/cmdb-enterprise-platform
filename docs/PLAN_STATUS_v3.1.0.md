# Plan Status — v3.1.0 · Módulo Línea de Tiempo (Gantt)

> Branch: `develop` | Inicio: 2026-06-22 | Alcance: parar en develop (no tocar main sin orden explícita)

## Estado de tareas

| # | Tarea | Estado | Notas |
|---|-------|--------|-------|
| T1 | Plan y diseño (Opus) | ✅ Completada | Plan aprobado por usuario; librería: react-modern-gantt |
| T2 | Backend módulo timeline | ✅ Completada | `backend/src/modules/timeline/` — 3 endpoints OK, tsc limpio, smoke test OK |
| T3 | Frontend Gantt | ✅ Completada | SVG Gantt custom con forwardRef centerToday; build Next.js limpio |
| T4 | Panel de filtros | ✅ Completada | `TimelineFilters.tsx` + `useTimelineFilters` con localStorage persistence |
| T5 | Visualización fina | ✅ Completada | Tooltips SVG, leyenda, codificación color, hitos heredados punteados |
| T6 | Sidebar + nav | ✅ Completada | `CalendarClock` entre map y documents; VIEWER+ (sin roles restriction) |
| T7 | i18n 6 idiomas | ✅ Completada | 6 archivos JSON actualizados (es/en/de/fr/it/pt) con bloque `timeline.*` |
| T8 | Tests y validación manual | ✅ Completada | API: 401 sin token, /items 277 total, /filters 31 CITypes + 19 DateTypes, /legacy/:ciId 400 UUID inválido; tsc 0 errores nuevos |
| T9 | Documentación | ✅ Completada | `docs/TIMELINE.md`, ARCHITECTURE.md §timeline, USER_MANUAL.md §33, USER_MANUAL.en.md §33 |
| T10 | Release a main | ⏸️ Fuera de alcance | Parar en develop; ejecutar solo con orden explícita |

## Decisiones arquitectónicas

- **Librería Gantt:** SVG custom (fallback activado — react-modern-gantt descartado: no soporta diamantes custom, herencia punteada ni Ctrl+scroll zoom sin conflicto con DnD interno).
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

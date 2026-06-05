import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import {
  DcimBuildingCreateSchema, DcimBuildingUpdateSchema,
  DcimFloorCreateSchema,    DcimFloorUpdateSchema,
  DcimRoomCreateSchema,     DcimRoomUpdateSchema,
  DcimAisleCreateSchema,    DcimAisleUpdateSchema,
  DcimFootprintCreateSchema, DcimFootprintUpdateSchema,
  AssignRackSchema,
} from './schemas.js';
import { dcimAudit } from './audit.js';
import { requireUuidParam, requireDcimAccess, requireAdmin } from './middleware.js';
import {
  getDashboardKpis,
  getOverpowerAlerts,
  getRoomPlan,
  getRackElevation,
  getRoomHeatmap,
} from './queries.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

export function createDcimRouter(prisma: PrismaClient): Router {
  const router = Router();

  // All DCIM routes require auth + non-VIEWER role (applied via app.use in index.ts).
  // Individual write routes additionally require ADMIN.

  // ─── Dashboard ─────────────────────────────────────────────────────────────

  // GET /api/dcim/dashboard
  router.get('/dashboard', async (_req: Request, res: Response) => {
    try {
      const kpis = await getDashboardKpis(prisma);
      res.json(kpis);
    } catch (err) {
      console.error('[DCIM] dashboard error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/dcim/alerts
  router.get('/alerts', async (_req: Request, res: Response) => {
    try {
      const alerts = await getOverpowerAlerts(prisma);
      res.json(alerts);
    } catch (err) {
      console.error('[DCIM] alerts error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ─── Buildings ─────────────────────────────────────────────────────────────

  // GET /api/dcim/buildings
  router.get('/buildings', async (_req: Request, res: Response) => {
    try {
      const buildings = await prisma.dcimBuilding.findMany({
        include : { branch: { select: { id: true, name: true } } },
        orderBy : { name: 'asc' },
      });
      res.json(buildings);
    } catch (err) {
      console.error('[DCIM] buildings list error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/dcim/buildings  (ADMIN)
  router.post('/buildings', requireAdmin, async (req: Request, res: Response) => {
    const parsed = DcimBuildingCreateSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
    try {
      const building = await prisma.dcimBuilding.create({ data: parsed.data });
      await dcimAudit(prisma, 'CREATE_DCIM_BUILDING', 'DcimBuilding', building.id, req.user!.email);
      res.status(201).json(building);
    } catch (err: any) {
      if (err?.code === 'P2002') { res.status(409).json({ error: 'Building name already exists in this branch' }); return; }
      if (err?.code === 'P2003') { res.status(400).json({ error: 'Branch not found' }); return; }
      console.error('[DCIM] building create error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // PATCH /api/dcim/buildings/:id  (ADMIN)
  router.patch('/buildings/:id', requireAdmin, requireUuidParam('id'), async (req: Request, res: Response) => {
    const parsed = DcimBuildingUpdateSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
    try {
      const building = await prisma.dcimBuilding.update({ where: { id: req.params.id as string }, data: parsed.data });
      await dcimAudit(prisma, 'UPDATE_DCIM_BUILDING', 'DcimBuilding', building.id, req.user!.email);
      res.json(building);
    } catch (err: any) {
      if (err?.code === 'P2025') { res.status(404).json({ error: 'Building not found' }); return; }
      if (err?.code === 'P2002') { res.status(409).json({ error: 'Building name already exists in this branch' }); return; }
      console.error('[DCIM] building update error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // DELETE /api/dcim/buildings/:id  (ADMIN)
  router.delete('/buildings/:id', requireAdmin, requireUuidParam('id'), async (req: Request, res: Response) => {
    try {
      await prisma.dcimBuilding.delete({ where: { id: req.params.id as string } });
      await dcimAudit(prisma, 'DELETE_DCIM_BUILDING', 'DcimBuilding', req.params.id as string, req.user!.email);
      res.status(204).end();
    } catch (err: any) {
      if (err?.code === 'P2025') { res.status(404).json({ error: 'Building not found' }); return; }
      if (err?.code === 'P2003') { res.status(409).json({ error: 'Cannot delete building with floors' }); return; }
      console.error('[DCIM] building delete error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ─── Floors ────────────────────────────────────────────────────────────────

  // GET /api/dcim/floors?buildingId=<uuid>
  router.get('/floors', async (req: Request, res: Response) => {
    const buildingId = req.query.buildingId as string | undefined;
    if (buildingId && !isUuid(buildingId)) { res.status(400).json({ error: 'Invalid buildingId: must be a UUID' }); return; }
    try {
      const floors = await prisma.dcimFloor.findMany({
        where   : buildingId ? { buildingId } : undefined,
        include : { building: { select: { id: true, name: true } } },
        orderBy : { levelNumber: 'asc' },
      });
      res.json(floors);
    } catch (err) {
      console.error('[DCIM] floors list error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/dcim/floors  (ADMIN)
  router.post('/floors', requireAdmin, async (req: Request, res: Response) => {
    const parsed = DcimFloorCreateSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
    try {
      const floor = await prisma.dcimFloor.create({ data: parsed.data });
      await dcimAudit(prisma, 'CREATE_DCIM_FLOOR', 'DcimFloor', floor.id, req.user!.email);
      res.status(201).json(floor);
    } catch (err: any) {
      if (err?.code === 'P2002') { res.status(409).json({ error: 'Floor level already exists in this building' }); return; }
      if (err?.code === 'P2003') { res.status(400).json({ error: 'Building not found' }); return; }
      console.error('[DCIM] floor create error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // PATCH /api/dcim/floors/:id  (ADMIN)
  router.patch('/floors/:id', requireAdmin, requireUuidParam('id'), async (req: Request, res: Response) => {
    const parsed = DcimFloorUpdateSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
    try {
      const floor = await prisma.dcimFloor.update({ where: { id: req.params.id as string }, data: parsed.data });
      await dcimAudit(prisma, 'UPDATE_DCIM_FLOOR', 'DcimFloor', floor.id, req.user!.email);
      res.json(floor);
    } catch (err: any) {
      if (err?.code === 'P2025') { res.status(404).json({ error: 'Floor not found' }); return; }
      console.error('[DCIM] floor update error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // DELETE /api/dcim/floors/:id  (ADMIN)
  router.delete('/floors/:id', requireAdmin, requireUuidParam('id'), async (req: Request, res: Response) => {
    try {
      await prisma.dcimFloor.delete({ where: { id: req.params.id as string } });
      await dcimAudit(prisma, 'DELETE_DCIM_FLOOR', 'DcimFloor', req.params.id as string, req.user!.email);
      res.status(204).end();
    } catch (err: any) {
      if (err?.code === 'P2025') { res.status(404).json({ error: 'Floor not found' }); return; }
      console.error('[DCIM] floor delete error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ─── Rooms ─────────────────────────────────────────────────────────────────

  // GET /api/dcim/rooms?floorId=<uuid>
  router.get('/rooms', async (req: Request, res: Response) => {
    const floorId = req.query.floorId as string | undefined;
    if (floorId && !isUuid(floorId)) { res.status(400).json({ error: 'Invalid floorId: must be a UUID' }); return; }
    try {
      const rooms = await prisma.dcimRoom.findMany({
        where   : floorId ? { floorId } : undefined,
        include : {
          floor    : { select: { id: true, name: true, levelNumber: true, building: { select: { id: true, name: true } } } },
          _count   : { select: { footprints: true } },
        },
        orderBy : { name: 'asc' },
      });
      res.json(rooms);
    } catch (err) {
      console.error('[DCIM] rooms list error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/dcim/rooms/:id/plan
  router.get('/rooms/:id/plan', requireUuidParam('id'), async (req: Request, res: Response) => {
    try {
      const plan = await getRoomPlan(prisma, req.params.id as string);
      if (!plan) { res.status(404).json({ error: 'Room not found' }); return; }
      res.json(plan);
    } catch (err) {
      console.error('[DCIM] room plan error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/dcim/rooms/:id/heatmap
  router.get('/rooms/:id/heatmap', requireUuidParam('id'), async (req: Request, res: Response) => {
    try {
      const heatmap = await getRoomHeatmap(prisma, req.params.id as string);
      res.json(heatmap);
    } catch (err) {
      console.error('[DCIM] heatmap error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/dcim/rooms  (ADMIN)
  router.post('/rooms', requireAdmin, async (req: Request, res: Response) => {
    const parsed = DcimRoomCreateSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
    try {
      const room = await prisma.dcimRoom.create({ data: parsed.data });
      await dcimAudit(prisma, 'CREATE_DCIM_ROOM', 'DcimRoom', room.id, req.user!.email);
      res.status(201).json(room);
    } catch (err: any) {
      if (err?.code === 'P2002') { res.status(409).json({ error: 'Room name already exists on this floor' }); return; }
      if (err?.code === 'P2003') { res.status(400).json({ error: 'Floor not found' }); return; }
      console.error('[DCIM] room create error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // PATCH /api/dcim/rooms/:id  (ADMIN)
  router.patch('/rooms/:id', requireAdmin, requireUuidParam('id'), async (req: Request, res: Response) => {
    const parsed = DcimRoomUpdateSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
    try {
      const room = await prisma.dcimRoom.update({ where: { id: req.params.id as string }, data: parsed.data });
      await dcimAudit(prisma, 'UPDATE_DCIM_ROOM', 'DcimRoom', room.id, req.user!.email);
      res.json(room);
    } catch (err: any) {
      if (err?.code === 'P2025') { res.status(404).json({ error: 'Room not found' }); return; }
      console.error('[DCIM] room update error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // DELETE /api/dcim/rooms/:id  (ADMIN)
  router.delete('/rooms/:id', requireAdmin, requireUuidParam('id'), async (req: Request, res: Response) => {
    try {
      await prisma.dcimRoom.delete({ where: { id: req.params.id as string } });
      await dcimAudit(prisma, 'DELETE_DCIM_ROOM', 'DcimRoom', req.params.id as string, req.user!.email);
      res.status(204).end();
    } catch (err: any) {
      if (err?.code === 'P2025') { res.status(404).json({ error: 'Room not found' }); return; }
      console.error('[DCIM] room delete error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ─── Aisles ────────────────────────────────────────────────────────────────

  // GET /api/dcim/aisles?roomId=<uuid>
  router.get('/aisles', async (req: Request, res: Response) => {
    const roomId = req.query.roomId as string | undefined;
    if (roomId && !isUuid(roomId)) { res.status(400).json({ error: 'Invalid roomId: must be a UUID' }); return; }
    try {
      const aisles = await prisma.dcimAisle.findMany({
        where   : roomId ? { roomId } : undefined,
        orderBy : { orderIdx: 'asc' },
      });
      res.json(aisles);
    } catch (err) {
      console.error('[DCIM] aisles list error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/dcim/aisles  (ADMIN)
  router.post('/aisles', requireAdmin, async (req: Request, res: Response) => {
    const parsed = DcimAisleCreateSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
    try {
      const aisle = await prisma.dcimAisle.create({ data: parsed.data });
      await dcimAudit(prisma, 'CREATE_DCIM_AISLE', 'DcimAisle', aisle.id, req.user!.email);
      res.status(201).json(aisle);
    } catch (err: any) {
      if (err?.code === 'P2002') { res.status(409).json({ error: 'Aisle name already exists in this room' }); return; }
      if (err?.code === 'P2003') { res.status(400).json({ error: 'Room not found' }); return; }
      console.error('[DCIM] aisle create error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // PATCH /api/dcim/aisles/:id  (ADMIN)
  router.patch('/aisles/:id', requireAdmin, requireUuidParam('id'), async (req: Request, res: Response) => {
    const parsed = DcimAisleUpdateSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
    try {
      const aisle = await prisma.dcimAisle.update({ where: { id: req.params.id as string }, data: parsed.data });
      await dcimAudit(prisma, 'UPDATE_DCIM_AISLE', 'DcimAisle', aisle.id, req.user!.email);
      res.json(aisle);
    } catch (err: any) {
      if (err?.code === 'P2025') { res.status(404).json({ error: 'Aisle not found' }); return; }
      console.error('[DCIM] aisle update error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // DELETE /api/dcim/aisles/:id  (ADMIN)
  router.delete('/aisles/:id', requireAdmin, requireUuidParam('id'), async (req: Request, res: Response) => {
    try {
      await prisma.dcimAisle.delete({ where: { id: req.params.id as string } });
      await dcimAudit(prisma, 'DELETE_DCIM_AISLE', 'DcimAisle', req.params.id as string, req.user!.email);
      res.status(204).end();
    } catch (err: any) {
      if (err?.code === 'P2025') { res.status(404).json({ error: 'Aisle not found' }); return; }
      console.error('[DCIM] aisle delete error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ─── Footprints ────────────────────────────────────────────────────────────

  // GET /api/dcim/footprints?roomId=<uuid>
  router.get('/footprints', async (req: Request, res: Response) => {
    const roomId = req.query.roomId as string | undefined;
    if (roomId && !isUuid(roomId)) { res.status(400).json({ error: 'Invalid roomId: must be a UUID' }); return; }
    try {
      const footprints = await prisma.dcimFootprint.findMany({
        where   : roomId ? { roomId } : undefined,
        include : { aisle: { select: { id: true, name: true } } },
        orderBy : [{ gridY: 'asc' }, { gridX: 'asc' }],
      });
      res.json(footprints);
    } catch (err) {
      console.error('[DCIM] footprints list error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/dcim/footprints  (ADMIN)
  router.post('/footprints', requireAdmin, async (req: Request, res: Response) => {
    const parsed = DcimFootprintCreateSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
    try {
      const fp = await prisma.dcimFootprint.create({ data: parsed.data });
      await dcimAudit(prisma, 'CREATE_DCIM_FOOTPRINT', 'DcimFootprint', fp.id, req.user!.email);
      res.status(201).json(fp);
    } catch (err: any) {
      if (err?.code === 'P2002') { res.status(409).json({ error: 'Grid position already occupied in this room' }); return; }
      if (err?.code === 'P2003') { res.status(400).json({ error: 'Room or aisle not found' }); return; }
      console.error('[DCIM] footprint create error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // PATCH /api/dcim/footprints/:id  (ADMIN)
  router.patch('/footprints/:id', requireAdmin, requireUuidParam('id'), async (req: Request, res: Response) => {
    const parsed = DcimFootprintUpdateSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
    try {
      const fp = await prisma.dcimFootprint.update({ where: { id: req.params.id as string }, data: parsed.data });
      await dcimAudit(prisma, 'UPDATE_DCIM_FOOTPRINT', 'DcimFootprint', fp.id, req.user!.email);
      res.json(fp);
    } catch (err: any) {
      if (err?.code === 'P2025') { res.status(404).json({ error: 'Footprint not found' }); return; }
      if (err?.code === 'P2002') { res.status(409).json({ error: 'Grid position already occupied' }); return; }
      console.error('[DCIM] footprint update error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // DELETE /api/dcim/footprints/:id  (ADMIN)
  router.delete('/footprints/:id', requireAdmin, requireUuidParam('id'), async (req: Request, res: Response) => {
    try {
      await prisma.dcimFootprint.delete({ where: { id: req.params.id as string } });
      await dcimAudit(prisma, 'DELETE_DCIM_FOOTPRINT', 'DcimFootprint', req.params.id as string, req.user!.email);
      res.status(204).end();
    } catch (err: any) {
      if (err?.code === 'P2025') { res.status(404).json({ error: 'Footprint not found' }); return; }
      console.error('[DCIM] footprint delete error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ─── Rack assignment ───────────────────────────────────────────────────────

  // POST /api/dcim/footprints/:id/assign-rack  { ciId }  (ADMIN)
  router.post('/footprints/:id/assign-rack', requireAdmin, requireUuidParam('id'), async (req: Request, res: Response) => {
    const parsed = AssignRackSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
    try {
      const fp = await prisma.dcimFootprint.update({
        where : { id: req.params.id as string },
        data  : { rackCiId: parsed.data.ciId },
      });
      await dcimAudit(prisma, 'ASSIGN_RACK', 'DcimFootprint', fp.id, req.user!.email);
      res.json(fp);
    } catch (err: any) {
      if (err?.code === 'P2025') { res.status(404).json({ error: 'Footprint not found' }); return; }
      if (err?.code === 'P2002') { res.status(409).json({ error: 'Rack CI already assigned to another footprint' }); return; }
      if (err?.code === 'P2003') { res.status(400).json({ error: 'CI not found' }); return; }
      console.error('[DCIM] assign-rack error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // DELETE /api/dcim/footprints/:id/assign-rack  (ADMIN)
  router.delete('/footprints/:id/assign-rack', requireAdmin, requireUuidParam('id'), async (req: Request, res: Response) => {
    try {
      const fp = await prisma.dcimFootprint.update({
        where : { id: req.params.id as string },
        data  : { rackCiId: null },
      });
      await dcimAudit(prisma, 'UNASSIGN_RACK', 'DcimFootprint', fp.id, req.user!.email);
      res.json(fp);
    } catch (err: any) {
      if (err?.code === 'P2025') { res.status(404).json({ error: 'Footprint not found' }); return; }
      console.error('[DCIM] unassign-rack error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ─── Rack elevation ────────────────────────────────────────────────────────

  // GET /api/dcim/racks/:ciId/elevation
  router.get('/racks/:ciId/elevation', requireUuidParam('ciId'), async (req: Request, res: Response) => {
    try {
      const elevation = await getRackElevation(prisma, req.params.ciId as string);
      if (!elevation) { res.status(404).json({ error: 'Rack CI not found' }); return; }
      res.json(elevation);
    } catch (err) {
      console.error('[DCIM] rack elevation error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

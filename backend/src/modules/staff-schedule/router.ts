import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import {
  DepartmentSchema, DepartmentUpdateSchema,
  DeptConfigSchema,
  SummerSchema,
  ScheduleCreateSchema,
  EntriesUpdateSchema,
  ManagerAssignSchema,
  UserDeptAssignSchema,
  CloneScheduleSchema,
  UserWeeklyHoursSchema,
  UserTeleworkQuotaSchema,
} from './schemas.js';
import { requireUuidParam, requireAdmin, requireDeptEditAccess } from './middleware.js';
import { buildScheduleVisibilityFilter, loadManagedDepartmentIds, loadDepartmentManagers, loadDepartmentMembers } from './queries.js';
import { auditStaffSchedule } from './audit.js';
import {
  createSchedule,
  updateEntries,
  runValidation,
  publish,
  unpublish,
  deleteSchedule,
  syncScheduleMembers,
  cloneToWeek,
  buildScheduleView,
  getMonthlySummary,
  ScheduleServiceError,
} from './service.js';
import { exportScheduleCsv, exportScheduleXlsx } from './export.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

function handleServiceError(err: unknown, res: Response, logTag: string): void {
  if (err instanceof ScheduleServiceError) {
    res.status(err.statusCode).json({ error: err.message });
    return;
  }
  console.error(`[StaffSchedule] ${logTag} error:`, err);
  res.status(500).json({ error: 'Internal server error' });
}

export function createStaffScheduleRouter(prisma: PrismaClient): Router {
  const router = Router();

  // ─── Departments ────────────────────────────────────────────────────────

  // GET /api/staff-schedule/departments
  router.get('/departments', async (_req: Request, res: Response) => {
    try {
      const departments = await prisma.department.findMany({ orderBy: { name: 'asc' } });
      res.json(departments);
    } catch (err) {
      console.error('[StaffSchedule] departments list error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/staff-schedule/departments  (ADMIN) — creates dept + default config (D13)
  router.post('/departments', requireAdmin, async (req: Request, res: Response) => {
    const parsed = DepartmentSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
    try {
      const department = await prisma.$transaction(async (tx) => {
        const dept = await tx.department.create({ data: parsed.data });
        await tx.departmentScheduleConfig.create({ data: { departmentId: dept.id } });
        await auditStaffSchedule(tx, { action: 'CREATE_DEPARTMENT', entity: 'DEPARTMENT', entityId: dept.id, userEmail: req.user!.email });
        return dept;
      });
      res.status(201).json(department);
    } catch (err: any) {
      if (err?.code === 'P2002') { res.status(409).json({ error: 'Department code already exists' }); return; }
      console.error('[StaffSchedule] department create error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // PUT /api/staff-schedule/departments/:id  (ADMIN)
  router.put('/departments/:id', requireAdmin, requireUuidParam('id'), async (req: Request, res: Response) => {
    const parsed = DepartmentUpdateSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
    try {
      const department = await prisma.$transaction(async (tx) => {
        const d = await tx.department.update({ where: { id: req.params.id as string }, data: parsed.data });
        await auditStaffSchedule(tx, { action: 'UPDATE_DEPARTMENT', entity: 'DEPARTMENT', entityId: d.id, userEmail: req.user!.email });
        return d;
      });
      res.json(department);
    } catch (err: any) {
      if (err?.code === 'P2025') { res.status(404).json({ error: 'Department not found' }); return; }
      if (err?.code === 'P2002') { res.status(409).json({ error: 'Department code already exists' }); return; }
      console.error('[StaffSchedule] department update error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ─── Department schedule config ────────────────────────────────────────

  // GET /api/staff-schedule/departments/:id/config
  router.get('/departments/:id/config', requireUuidParam('id'), async (req: Request, res: Response) => {
    try {
      const config = await prisma.departmentScheduleConfig.findUnique({ where: { departmentId: req.params.id as string } });
      if (!config) { res.status(404).json({ error: 'Config not found' }); return; }
      res.json(config);
    } catch (err) {
      console.error('[StaffSchedule] config get error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // PUT /api/staff-schedule/departments/:id/config  (ADMIN)
  router.put('/departments/:id/config', requireAdmin, requireUuidParam('id'), async (req: Request, res: Response) => {
    const parsed = DeptConfigSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
    try {
      const config = await prisma.$transaction(async (tx) => {
        const c = await tx.departmentScheduleConfig.upsert({
          where: { departmentId: req.params.id as string },
          create: { departmentId: req.params.id as string, ...parsed.data },
          update: parsed.data,
        });
        await auditStaffSchedule(tx, { action: 'UPDATE_DEPARTMENT_CONFIG', entity: 'DEPARTMENT', entityId: req.params.id as string, userEmail: req.user!.email });
        return c;
      });
      res.json(config);
    } catch (err: any) {
      if (err?.code === 'P2003') { res.status(400).json({ error: 'Department not found' }); return; }
      console.error('[StaffSchedule] config update error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ─── Managers (D3 row-level authorization) ─────────────────────────────

  // GET /api/staff-schedule/departments/:id/managers — v3.5.10 refinamiento.
  // Lectura pura: cualquiera con acceso al módulo (requireScheduleAccess, ya
  // aplicado por el montaje del router) puede ver quién gestiona un
  // departamento. Antes no existía ningún GET; el panel de configuración
  // solo podía añadir/quitar a ciegas.
  router.get('/departments/:id/managers', requireUuidParam('id'), async (req: Request, res: Response) => {
    try {
      const managers = await loadDepartmentManagers(prisma, req.params.id as string);
      res.json(managers);
    } catch (err) {
      console.error('[StaffSchedule] managers list error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/staff-schedule/departments/:id/members — v3.5.10 refinamiento.
  // Lectura pura, mismo criterio de acceso que arriba.
  router.get('/departments/:id/members', requireUuidParam('id'), async (req: Request, res: Response) => {
    try {
      const members = await loadDepartmentMembers(prisma, req.params.id as string);
      res.json(members);
    } catch (err) {
      console.error('[StaffSchedule] members list error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/staff-schedule/departments/:id/managers  (ADMIN)  { userId }
  router.post('/departments/:id/managers', requireAdmin, requireUuidParam('id'), async (req: Request, res: Response) => {
    const parsed = ManagerAssignSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
    try {
      const manager = await prisma.$transaction(async (tx) => {
        const m = await tx.departmentManager.create({
          data: { departmentId: req.params.id as string, userId: parsed.data.userId },
        });
        await auditStaffSchedule(tx, { action: 'ASSIGN_DEPARTMENT_MANAGER', entity: 'DEPARTMENT_MANAGER', entityId: m.id, userEmail: req.user!.email });
        return m;
      });
      res.status(201).json(manager);
    } catch (err: any) {
      if (err?.code === 'P2002') { res.status(409).json({ error: 'User is already a manager of this department' }); return; }
      if (err?.code === 'P2003') { res.status(400).json({ error: 'Department or user not found' }); return; }
      console.error('[StaffSchedule] manager assign error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // DELETE /api/staff-schedule/departments/:id/managers/:userId  (ADMIN)
  router.delete('/departments/:id/managers/:userId', requireAdmin, requireUuidParam('id'), requireUuidParam('userId'), async (req: Request, res: Response) => {
    try {
      const removed = await prisma.$transaction(async (tx) => {
        const result = await tx.departmentManager.deleteMany({
          where: { departmentId: req.params.id as string, userId: req.params.userId as string },
        });
        if (result.count === 0) return 0;
        await auditStaffSchedule(tx, { action: 'REMOVE_DEPARTMENT_MANAGER', entity: 'DEPARTMENT_MANAGER', entityId: req.params.id as string, userEmail: req.user!.email });
        return result.count;
      });
      if (removed === 0) { res.status(404).json({ error: 'Manager assignment not found' }); return; }
      res.status(204).end();
    } catch (err) {
      console.error('[StaffSchedule] manager remove error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ─── User-department assignment (D13) ──────────────────────────────────

  // PUT /api/staff-schedule/users/:userId/department  (ADMIN)  { departmentId }
  router.put('/users/:userId/department', requireAdmin, requireUuidParam('userId'), async (req: Request, res: Response) => {
    const parsed = UserDeptAssignSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
    try {
      const user = await prisma.$transaction(async (tx) => {
        const u = await tx.user.update({
          where: { id: req.params.userId as string },
          data: { departmentId: parsed.data.departmentId },
          select: { id: true, username: true, departmentId: true },
        });
        await auditStaffSchedule(tx, { action: 'ASSIGN_USER_DEPARTMENT', entity: 'DEPARTMENT', entityId: u.departmentId ?? (req.params.userId as string), userEmail: req.user!.email });
        return u;
      });
      res.json(user);
    } catch (err: any) {
      if (err?.code === 'P2025') { res.status(404).json({ error: 'User not found' }); return; }
      if (err?.code === 'P2003') { res.status(400).json({ error: 'Department not found' }); return; }
      console.error('[StaffSchedule] user department assign error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // PUT /api/staff-schedule/users/:userId/weekly-hours  (ADMIN)  { weeklyTargetHours }
  router.put('/users/:userId/weekly-hours', requireAdmin, requireUuidParam('userId'), async (req: Request, res: Response) => {
    const parsed = UserWeeklyHoursSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
    try {
      const user = await prisma.$transaction(async (tx) => {
        const u = await tx.user.update({
          where: { id: req.params.userId as string },
          data: { weeklyTargetHours: parsed.data.weeklyTargetHours },
          select: { id: true, username: true, weeklyTargetHours: true },
        });
        await auditStaffSchedule(tx, { action: 'SET_USER_WEEKLY_HOURS', entity: 'DEPARTMENT', entityId: req.params.userId as string, userEmail: req.user!.email });
        return u;
      });
      res.json(user);
    } catch (err: any) {
      if (err?.code === 'P2025') { res.status(404).json({ error: 'User not found' }); return; }
      console.error('[StaffSchedule] user weekly-hours update error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // PUT /api/staff-schedule/users/:userId/telework-quota  (ADMIN)
  // { teleworkFull, teleworkQuotaDays, teleworkQuotaPct }
  router.put('/users/:userId/telework-quota', requireAdmin, requireUuidParam('userId'), async (req: Request, res: Response) => {
    const parsed = UserTeleworkQuotaSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
    try {
      const user = await prisma.$transaction(async (tx) => {
        const u = await tx.user.update({
          where: { id: req.params.userId as string },
          data: {
            teleworkFull: parsed.data.teleworkFull,
            teleworkQuotaDays: parsed.data.teleworkQuotaDays,
            teleworkQuotaPct: parsed.data.teleworkQuotaPct,
          },
          select: { id: true, username: true, teleworkFull: true, teleworkQuotaDays: true, teleworkQuotaPct: true },
        });
        await auditStaffSchedule(tx, { action: 'SET_USER_TELEWORK_QUOTA', entity: 'DEPARTMENT', entityId: req.params.userId as string, userEmail: req.user!.email });
        return u;
      });
      res.json(user);
    } catch (err: any) {
      if (err?.code === 'P2025') { res.status(404).json({ error: 'User not found' }); return; }
      console.error('[StaffSchedule] user telework-quota update error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ─── Summer schedule (global period, D7) ────────────────────────────────

  // GET /api/staff-schedule/summer?year=
  router.get('/summer', async (req: Request, res: Response) => {
    const year = Number(req.query.year);
    if (!Number.isInteger(year)) { res.status(400).json({ error: 'year query param is required' }); return; }
    try {
      const summer = await prisma.summerSchedule.findUnique({ where: { year } });
      res.json(summer ?? null);
    } catch (err) {
      console.error('[StaffSchedule] summer get error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/staff-schedule/summer  (ADMIN) — upsert by year
  router.post('/summer', requireAdmin, async (req: Request, res: Response) => {
    const parsed = SummerSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
    try {
      const { year, startDate, endDate } = parsed.data;
      const summer = await prisma.$transaction(async (tx) => {
        const s = await tx.summerSchedule.upsert({
          where: { year },
          create: { year, startDate: new Date(startDate), endDate: new Date(endDate) },
          update: { startDate: new Date(startDate), endDate: new Date(endDate) },
        });
        await auditStaffSchedule(tx, { action: 'UPSERT_SUMMER_SCHEDULE', entity: 'DEPARTMENT', entityId: s.id, userEmail: req.user!.email });
        return s;
      });
      res.json(summer);
    } catch (err) {
      console.error('[StaffSchedule] summer upsert error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ─── Schedules ───────────────────────────────────────────────────────────

  // GET /api/staff-schedule?departmentId=&weekStart=
  router.get('/', async (req: Request, res: Response) => {
    const departmentId = req.query.departmentId as string | undefined;
    const weekStart = req.query.weekStart as string | undefined;
    if (departmentId && !isUuid(departmentId)) { res.status(400).json({ error: 'Invalid departmentId' }); return; }
    try {
      const where: any = {};
      if (departmentId) where.departmentId = departmentId;
      if (weekStart && !Number.isNaN(Date.parse(weekStart))) where.weekStart = new Date(weekStart);

      // v3.5.10 — Visibilidad por rol aplicada en la propia cláusula WHERE
      // (A01: los controles de acceso a filas son filtros de BD, nunca
      // post-filtrado). VIEWER/AUDITOR solo ven publicados; MANAGER además
      // cualquier estado de los departamentos que gestiona; ADMIN todo.
      const managed = req.user!.role === 'ADMIN'
        ? []
        : await loadManagedDepartmentIds(prisma, req.user!.id);
      where.AND = [buildScheduleVisibilityFilter(req.user!.role, managed)];

      const schedules = await prisma.staffSchedule.findMany({
        where,
        orderBy: { weekStart: 'desc' },
        include: { department: { select: { id: true, name: true } } },
      });
      res.json(schedules);
    } catch (err) {
      console.error('[StaffSchedule] schedules list error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/staff-schedule/:id — masked view (D4)
  router.get('/:id', requireUuidParam('id'), async (req: Request, res: Response) => {
    try {
      const view = await buildScheduleView(prisma, req.params.id as string, { id: req.user!.id, role: req.user!.role });
      if (!view) { res.status(404).json({ error: 'Schedule not found' }); return; }
      res.json(view);
    } catch (err) {
      console.error('[StaffSchedule] schedule view error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/staff-schedule  (deptEdit)
  router.post('/', requireDeptEditAccess(prisma), async (req: Request, res: Response) => {
    const parsed = ScheduleCreateSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
    try {
      const schedule = await prisma.$transaction(async (tx) => {
        const s = await createSchedule(tx, {
          departmentId: parsed.data.departmentId,
          weekStart: parsed.data.weekStart,
          createdBy: req.user!.email,
        });
        await auditStaffSchedule(tx, { action: 'CREATE_STAFF_SCHEDULE', entity: 'STAFF_SCHEDULE', entityId: s.id, userEmail: req.user!.email });
        return s;
      }, { timeout: 20000 });
      res.status(201).json(schedule);
    } catch (err: any) {
      if (err?.code === 'P2002') { res.status(409).json({ error: 'A schedule already exists for this department and week' }); return; }
      if (err?.code === 'P2003') { res.status(400).json({ error: 'Department not found' }); return; }
      console.error('[StaffSchedule] schedule create error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // PUT /api/staff-schedule/:id  (deptEdit) — only while DRAFT (D10)
  router.put('/:id', requireUuidParam('id'), requireDeptEditAccess(prisma), async (req: Request, res: Response) => {
    const parsed = EntriesUpdateSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
    try {
      await prisma.$transaction(async (tx) => {
        await updateEntries(tx, req.params.id as string, parsed.data.entries);
        await auditStaffSchedule(tx, { action: 'UPDATE_SCHEDULE_ENTRIES', entity: 'SCHEDULE_ENTRY', entityId: req.params.id as string, userEmail: req.user!.email });
      }, { timeout: 20000 });
      res.status(204).end();
    } catch (err) {
      handleServiceError(err, res, 'entries update');
    }
  });

  // POST /api/staff-schedule/:id/validate  (deptEdit)
  router.post('/:id/validate', requireUuidParam('id'), requireDeptEditAccess(prisma), async (req: Request, res: Response) => {
    try {
      const alerts = await prisma.$transaction(async (tx) => {
        const a = await runValidation(tx, req.params.id as string);
        await auditStaffSchedule(tx, { action: 'VALIDATE_STAFF_SCHEDULE', entity: 'STAFF_SCHEDULE', entityId: req.params.id as string, userEmail: req.user!.email });
        return a;
      }, { timeout: 20000 });
      res.json({ alerts });
    } catch (err) {
      handleServiceError(err, res, 'validate');
    }
  });

  // POST /api/staff-schedule/:id/publish  (deptEdit) — rejects 409 if unresolved ERROR alerts (D10)
  router.post('/:id/publish', requireUuidParam('id'), requireDeptEditAccess(prisma), async (req: Request, res: Response) => {
    try {
      const schedule = await prisma.$transaction(async (tx) => {
        const s = await publish(tx, req.params.id as string);
        await auditStaffSchedule(tx, { action: 'PUBLISH_STAFF_SCHEDULE', entity: 'STAFF_SCHEDULE', entityId: s.id, userEmail: req.user!.email });
        return s;
      });
      res.json(schedule);
    } catch (err) {
      handleServiceError(err, res, 'publish');
    }
  });

  // POST /api/staff-schedule/:id/unpublish  (ADMIN only, D10)
  router.post('/:id/unpublish', requireAdmin, requireUuidParam('id'), async (req: Request, res: Response) => {
    try {
      const schedule = await prisma.$transaction(async (tx) => {
        const s = await unpublish(tx, req.params.id as string);
        await auditStaffSchedule(tx, { action: 'UNPUBLISH_STAFF_SCHEDULE', entity: 'STAFF_SCHEDULE', entityId: s.id, userEmail: req.user!.email });
        return s;
      });
      res.json(schedule);
    } catch (err) {
      handleServiceError(err, res, 'unpublish');
    }
  });

  // DELETE /api/staff-schedule/:id  (deptEdit, DRAFT only — D10) — v3.5.10
  // refinamiento: permite descartar un horario creado/clonado con una
  // membresía de departamento desactualizada, para poder re-clonar la semana.
  router.delete('/:id', requireUuidParam('id'), requireDeptEditAccess(prisma), async (req: Request, res: Response) => {
    try {
      await prisma.$transaction(async (tx) => {
        await deleteSchedule(tx, req.params.id as string);
        await auditStaffSchedule(tx, { action: 'DELETE_STAFF_SCHEDULE', entity: 'STAFF_SCHEDULE', entityId: req.params.id as string, userEmail: req.user!.email });
      });
      res.status(204).end();
    } catch (err) {
      handleServiceError(err, res, 'delete');
    }
  });

  // POST /api/staff-schedule/:id/sync-members  (deptEdit, DRAFT only) — v3.5.10
  // refinamiento: añade entradas base para miembros del departamento que
  // todavía no tengan ninguna en este horario. No destructivo — nunca toca
  // entradas existentes. Cubre tanto un horario vacío (creado/clonado antes de
  // que el departamento tuviera su membresía final) como un trabajador nuevo
  // que se incorpora a un departamento con horarios ya planificados.
  router.post('/:id/sync-members', requireUuidParam('id'), requireDeptEditAccess(prisma), async (req: Request, res: Response) => {
    try {
      const result = await prisma.$transaction(async (tx) => {
        const r = await syncScheduleMembers(tx, req.params.id as string);
        await auditStaffSchedule(tx, { action: 'SYNC_STAFF_SCHEDULE_MEMBERS', entity: 'STAFF_SCHEDULE', entityId: req.params.id as string, userEmail: req.user!.email });
        return r;
      });
      res.json(result);
    } catch (err) {
      handleServiceError(err, res, 'sync members');
    }
  });

  // POST /api/staff-schedule/:id/clone  (deptEdit) — { targetWeekStart } clones
  // entries onto a caller-chosen future, empty Monday. Reused by "Import
  // previous week" (frontend calls this with scheduleId = previous week's
  // schedule and targetWeekStart = the currently-viewed week).
  router.post('/:id/clone', requireUuidParam('id'), requireDeptEditAccess(prisma), async (req: Request, res: Response) => {
    const parsed = CloneScheduleSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
    try {
      const created = await prisma.$transaction(async (tx) => {
        const c = await cloneToWeek(tx, req.params.id as string, parsed.data.targetWeekStart, req.user!.email);
        await auditStaffSchedule(tx, { action: 'CLONE_STAFF_SCHEDULE', entity: 'STAFF_SCHEDULE', entityId: c.id, userEmail: req.user!.email });
        return c;
      }, { timeout: 20000 });
      res.status(201).json(created);
    } catch (err: any) {
      if (err?.code === 'P2002') { res.status(409).json({ error: 'A schedule already exists for the target week' }); return; }
      handleServiceError(err, res, 'clone');
    }
  });

  // GET /api/staff-schedule/:id/export?format=csv|xlsx  — masked (D4)
  router.get('/:id/export', requireUuidParam('id'), async (req: Request, res: Response) => {
    const format = (req.query.format as string | undefined)?.toLowerCase() === 'xlsx' ? 'xlsx' : 'csv';
    try {
      const view = await buildScheduleView(prisma, req.params.id as string, { id: req.user!.id, role: req.user!.role });
      if (!view) { res.status(404).json({ error: 'Schedule not found' }); return; }

      await auditStaffSchedule(prisma, { action: 'EXPORT_STAFF_SCHEDULE', entity: 'STAFF_SCHEDULE', entityId: req.params.id as string, userEmail: req.user!.email });

      if (format === 'xlsx') {
        const buf = await exportScheduleXlsx(view);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="schedule-${req.params.id}.xlsx"`);
        res.send(buf);
      } else {
        const csv = exportScheduleCsv(view);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="schedule-${req.params.id}.csv"`);
        res.send(csv);
      }
    } catch (err) {
      console.error('[StaffSchedule] export error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/staff-schedule/user/:userId/monthly?year=&month=
  // AUDITOR/manager see a masked summary (no healthLeaveDays field); the
  // user themselves and ADMIN see the full summary.
  router.get('/user/:userId/monthly', requireUuidParam('userId'), async (req: Request, res: Response) => {
    const year = Number(req.query.year);
    const month = Number(req.query.month);
    if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
      res.status(400).json({ error: 'year and month query params are required' });
      return;
    }
    try {
      const summary = await getMonthlySummary(prisma, req.params.userId as string, year, month, {
        id: req.user!.id,
        role: req.user!.role,
      });
      res.json(summary);
    } catch (err) {
      console.error('[StaffSchedule] monthly summary error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

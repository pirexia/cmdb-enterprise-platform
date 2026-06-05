import { PrismaClient } from '@prisma/client';

// Dashboard KPIs — single round-trip, no N+1.
export async function getDashboardKpis(prisma: PrismaClient) {
  const [buildings, rooms, racks, alerts] = await Promise.all([
    prisma.dcimBuilding.count(),
    prisma.dcimRoom.count(),
    prisma.dcimFootprint.count({ where: { kind: 'RACK_SLOT', rackCiId: { not: null } } }),
    getOverpowerAlerts(prisma),
  ]);
  return { buildings, rooms, racks, alerts: alerts.length };
}

// Racks where sum(power_w of occupants) > rack_power_max_w.
// Uses a single SQL query with LATERAL JOIN — no N+1.
export async function getOverpowerAlerts(prisma: PrismaClient) {
  const rows = await prisma.$queryRaw<
    { rack_ci_id: string; rack_name: string; sum_power_w: number; rack_power_max_w: number }[]
  >`
    SELECT
      hw.ci_id           AS rack_ci_id,
      ci.name            AS rack_name,
      COALESCE(agg.sum_power_w, 0) AS sum_power_w,
      hw.rack_power_max_w
    FROM hardware_cis hw
    JOIN configuration_items ci ON ci.id = hw.ci_id
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(occ.power_w), 0)::int AS sum_power_w
      FROM hardware_cis occ
      WHERE occ.parent_rack_ci_id = hw.ci_id
    ) agg ON true
    WHERE hw.rack_power_max_w IS NOT NULL
      AND COALESCE(agg.sum_power_w, 0) > hw.rack_power_max_w
  `;
  return rows.map(r => ({
    rackCiId     : r.rack_ci_id,
    rackName     : r.rack_name,
    sumPowerW    : Number(r.sum_power_w),
    maxPowerW    : Number(r.rack_power_max_w),
    usagePct     : Math.round((Number(r.sum_power_w) / Number(r.rack_power_max_w)) * 100),
  }));
}

// Room plan — grid of footprints with associated rack CI info.
export async function getRoomPlan(prisma: PrismaClient, roomId: string) {
  const room = await prisma.dcimRoom.findUnique({
    where   : { id: roomId },
    include : {
      floor  : { include: { building: { include: { branch: { select: { id: true, name: true } } } } } },
      aisles : { orderBy: { orderIdx: 'asc' } },
      footprints : {
        orderBy : [{ gridY: 'asc' }, { gridX: 'asc' }],
        include : {
          rackCi : {
            select : {
              id       : true,
              name     : true,
              status   : true,
              hardware : { select: { rackTotalU: true, rackPowerMaxW: true, rackWidthMm: true, rackDepthMm: true } },
            },
          },
        },
      },
    },
  });
  return room;
}

// Rack elevation — U-slot occupancy from bottom (1) to top (rackTotalU).
export async function getRackElevation(prisma: PrismaClient, rackCiId: string) {
  const rack = await prisma.cI.findUnique({
    where   : { id: rackCiId },
    include : { hardware: true },
  });
  if (!rack || !rack.hardware) return null;

  const occupants = await prisma.hardwareCI.findMany({
    where   : { parentRackCiId: rackCiId },
    include : {
      ci : {
        select : {
          id          : true,
          name        : true,
          status      : true,
          criticality : true,
          ciTypeDef   : { select: { name: true } },
        },
      },
    },
    orderBy : { uPosition: 'asc' },
  });

  return {
    rack,
    totalU    : rack.hardware.rackTotalU,
    maxPowerW : rack.hardware.rackPowerMaxW,
    occupants : occupants.map(hw => ({
      ciId        : hw.ciId,
      name        : hw.ci.name,
      status      : hw.ci.status,
      criticality : hw.ci.criticality,
      ciType      : hw.ci.ciTypeDef?.name,
      uPosition   : hw.uPosition,
      sizeU       : hw.sizeU,
      powerW      : hw.powerW,
      orientation : hw.orientation,
    })),
  };
}

// Power heatmap — per-rack power usage ratio for all racks in a room.
export async function getRoomHeatmap(prisma: PrismaClient, roomId: string) {
  const rows = await prisma.$queryRaw<
    { rack_ci_id: string; sum_power_w: number; rack_power_max_w: number; grid_x: number; grid_y: number }[]
  >`
    SELECT
      fp.rack_ci_id,
      fp.grid_x,
      fp.grid_y,
      COALESCE(agg.sum_power_w, 0)::int AS sum_power_w,
      hw.rack_power_max_w
    FROM dcim_footprints fp
    JOIN hardware_cis hw ON hw.ci_id = fp.rack_ci_id
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(occ.power_w), 0) AS sum_power_w
      FROM hardware_cis occ
      WHERE occ.parent_rack_ci_id = fp.rack_ci_id
    ) agg ON true
    WHERE fp.room_id = ${roomId}::uuid
      AND fp.rack_ci_id IS NOT NULL
      AND hw.rack_power_max_w IS NOT NULL
  `;
  return rows.map(r => ({
    rackCiId  : r.rack_ci_id,
    gridX     : Number(r.grid_x),
    gridY     : Number(r.grid_y),
    sumPowerW : Number(r.sum_power_w),
    maxPowerW : Number(r.rack_power_max_w),
    usagePct  : Number(r.rack_power_max_w) > 0
      ? Math.round((Number(r.sum_power_w) / Number(r.rack_power_max_w)) * 100)
      : 0,
  }));
}

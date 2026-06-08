import { z } from 'zod';

// ─── Buildings ────────────────────────────────────────────────────────────────

export const DcimBuildingCreateSchema = z.object({
  branchId : z.string().uuid(),
  name     : z.string().min(1).max(255),
  code     : z.string().max(50).optional(),
  notes    : z.string().optional(),
});

export const DcimBuildingUpdateSchema = DcimBuildingCreateSchema.partial();

// ─── Floors ───────────────────────────────────────────────────────────────────

export const DcimFloorCreateSchema = z.object({
  buildingId  : z.string().uuid(),
  name        : z.string().min(1).max(255),
  levelNumber : z.number().int(),
  notes       : z.string().optional(),
});

export const DcimFloorUpdateSchema = DcimFloorCreateSchema.partial();

// ─── Rooms ────────────────────────────────────────────────────────────────────

export const DCIM_ROOM_KINDS = ['CPD', 'TECHNICAL_ROOM'] as const;

export const DcimRoomCreateSchema = z.object({
  floorId  : z.string().uuid(),
  name     : z.string().min(1).max(255),
  kind     : z.enum(DCIM_ROOM_KINDS),
  widthMm  : z.number().int().positive().max(99999).optional(),
  depthMm  : z.number().int().positive().max(99999).optional(),
  notes    : z.string().optional(),
});

export const DcimRoomUpdateSchema = DcimRoomCreateSchema.partial();

// ─── Aisles ───────────────────────────────────────────────────────────────────

export const DCIM_AISLE_KINDS = ['HOT', 'COLD', 'MIXED'] as const;

export const DcimAisleCreateSchema = z.object({
  roomId   : z.string().uuid(),
  name     : z.string().min(1).max(255),
  kind     : z.enum(DCIM_AISLE_KINDS).optional(),
  orderIdx : z.number().int().min(0),
});

export const DcimAisleUpdateSchema = DcimAisleCreateSchema.partial();

// ─── Footprints ───────────────────────────────────────────────────────────────

export const DCIM_FOOTPRINT_KINDS = ['RACK_SLOT', 'INFRASTRUCTURE', 'EMPTY'] as const;

export const DcimFootprintCreateSchema = z.object({
  roomId   : z.string().uuid(),
  aisleId  : z.string().uuid().nullable().optional(),
  label    : z.string().min(1).max(50),
  kind     : z.enum(DCIM_FOOTPRINT_KINDS),
  active   : z.boolean().default(true),
  gridX    : z.number().int().min(0).max(999),
  gridY    : z.number().int().min(0).max(999),
});

export const DcimFootprintUpdateSchema = DcimFootprintCreateSchema.partial();

// ─── Rack assignment ─────────────────────────────────────────────────────────

export const AssignRackSchema = z.object({
  ciId: z.string().uuid(),
});

// ─── CI Placement ─────────────────────────────────────────────────────────────

export const CIPlacementSchema = z.object({
  parentRackCiId : z.string().uuid().nullable(),
  uPosition      : z.number().int().min(1).max(1000).nullable(),
  orientation    : z.enum(['FRONT', 'REAR']).nullable(),
  sizeU          : z.number().int().min(1).max(100).nullable(),
  powerW         : z.number().int().min(0).max(1_000_000).nullable(),
});

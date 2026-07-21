import { Prisma, DateTypeCategory } from '@prisma/client';

// ─── Date Types ───────────────────────────────────────────────────────────────

export function dtQueries(prisma: Prisma.TransactionClient) {
  return {
    list: (category?: DateTypeCategory) =>
      prisma.dateType.findMany({
        where  : category ? { category } : undefined,
        orderBy: [{ category: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
      }),

    findById: (id: string) =>
      prisma.dateType.findUnique({ where: { id } }),

    findByCode: (code: string) =>
      prisma.dateType.findUnique({ where: { code } }),

    create: (data: {
      code        : string;
      name        : string;
      description?: string | null;
      category    : DateTypeCategory;
      sortOrder?  : number;
      isSystem?   : boolean;
    }) =>
      prisma.dateType.create({ data }),

    update: (
      id   : string,
      data : {
        code?       : string;
        name?       : string;
        description?: string | null;
        category?   : DateTypeCategory;
        sortOrder?  : number;
      },
    ) =>
      prisma.dateType.update({ where: { id }, data }),

    delete: (id: string) =>
      prisma.dateType.delete({ where: { id } }),

    countUsage: async (id: string) => {
      // After T5 migration runs, these counts will reflect real associations.
      // Returns 0 until T5 association tables exist.
      try {
        const [cis, oss, bsws, dms] = await Promise.all([
          prisma.cIDate.count({ where: { dateTypeId: id } }),
          prisma.operatingSystemDate.count({ where: { dateTypeId: id } }),
          prisma.baseSoftwareDate.count({ where: { dateTypeId: id } }),
          prisma.deviceModelDate.count({ where: { dateTypeId: id } }),
        ]);
        return cis + oss + bsws + dms;
      } catch {
        return 0;
      }
    },
  };
}

// ─── Entity Lifecycle Date Queries ───────────────────────────────────────────

function parseDateValue(v: string): Date {
  return new Date(`${v}T00:00:00.000Z`);
}

export function ciDateQueries(prisma: Prisma.TransactionClient) {
  return {
    list: (ciId: string) =>
      prisma.cIDate.findMany({
        where  : { ciId },
        include: { dateType: true },
        orderBy: [{ dateType: { sortOrder: 'asc' } }, { dateType: { name: 'asc' } }],
      }),

    findById: (id: string) =>
      prisma.cIDate.findUnique({ where: { id }, include: { dateType: true } }),

    create: (ciId: string, data: { dateTypeId: string; dateValue: string; notes?: string | null }) =>
      prisma.cIDate.create({
        data   : { ciId, dateTypeId: data.dateTypeId, dateValue: parseDateValue(data.dateValue), notes: data.notes ?? null },
        include: { dateType: true },
      }),

    update: (id: string, data: { dateValue?: string; notes?: string | null }) =>
      prisma.cIDate.update({
        where  : { id },
        data   : {
          ...(data.dateValue !== undefined ? { dateValue: parseDateValue(data.dateValue) } : {}),
          ...(data.notes     !== undefined ? { notes: data.notes }                         : {}),
        },
        include: { dateType: true },
      }),

    delete: (id: string) => prisma.cIDate.delete({ where: { id } }),
  };
}

export function osDateQueries(prisma: Prisma.TransactionClient) {
  return {
    list: (operatingSystemId: string) =>
      prisma.operatingSystemDate.findMany({
        where  : { operatingSystemId },
        include: { dateType: true },
        orderBy: [{ dateType: { sortOrder: 'asc' } }, { dateType: { name: 'asc' } }],
      }),

    findById: (id: string) =>
      prisma.operatingSystemDate.findUnique({ where: { id }, include: { dateType: true } }),

    create: (operatingSystemId: string, data: { dateTypeId: string; dateValue: string; notes?: string | null }) =>
      prisma.operatingSystemDate.create({
        data   : { operatingSystemId, dateTypeId: data.dateTypeId, dateValue: parseDateValue(data.dateValue), notes: data.notes ?? null },
        include: { dateType: true },
      }),

    update: (id: string, data: { dateValue?: string; notes?: string | null }) =>
      prisma.operatingSystemDate.update({
        where  : { id },
        data   : {
          ...(data.dateValue !== undefined ? { dateValue: parseDateValue(data.dateValue) } : {}),
          ...(data.notes     !== undefined ? { notes: data.notes }                         : {}),
        },
        include: { dateType: true },
      }),

    delete: (id: string) => prisma.operatingSystemDate.delete({ where: { id } }),
  };
}

export function bswDateQueries(prisma: Prisma.TransactionClient) {
  return {
    list: (baseSoftwareId: string) =>
      prisma.baseSoftwareDate.findMany({
        where  : { baseSoftwareId },
        include: { dateType: true },
        orderBy: [{ dateType: { sortOrder: 'asc' } }, { dateType: { name: 'asc' } }],
      }),

    findById: (id: string) =>
      prisma.baseSoftwareDate.findUnique({ where: { id }, include: { dateType: true } }),

    create: (baseSoftwareId: string, data: { dateTypeId: string; dateValue: string; notes?: string | null }) =>
      prisma.baseSoftwareDate.create({
        data   : { baseSoftwareId, dateTypeId: data.dateTypeId, dateValue: parseDateValue(data.dateValue), notes: data.notes ?? null },
        include: { dateType: true },
      }),

    update: (id: string, data: { dateValue?: string; notes?: string | null }) =>
      prisma.baseSoftwareDate.update({
        where  : { id },
        data   : {
          ...(data.dateValue !== undefined ? { dateValue: parseDateValue(data.dateValue) } : {}),
          ...(data.notes     !== undefined ? { notes: data.notes }                         : {}),
        },
        include: { dateType: true },
      }),

    delete: (id: string) => prisma.baseSoftwareDate.delete({ where: { id } }),
  };
}

export function dmDateQueries(prisma: Prisma.TransactionClient) {
  return {
    list: (deviceModelId: string) =>
      prisma.deviceModelDate.findMany({
        where  : { deviceModelId },
        include: { dateType: true },
        orderBy: [{ dateType: { sortOrder: 'asc' } }, { dateType: { name: 'asc' } }],
      }),

    findById: (id: string) =>
      prisma.deviceModelDate.findUnique({ where: { id }, include: { dateType: true } }),

    create: (deviceModelId: string, data: { dateTypeId: string; dateValue: string; notes?: string | null }) =>
      prisma.deviceModelDate.create({
        data   : { deviceModelId, dateTypeId: data.dateTypeId, dateValue: parseDateValue(data.dateValue), notes: data.notes ?? null },
        include: { dateType: true },
      }),

    update: (id: string, data: { dateValue?: string; notes?: string | null }) =>
      prisma.deviceModelDate.update({
        where  : { id },
        data   : {
          ...(data.dateValue !== undefined ? { dateValue: parseDateValue(data.dateValue) } : {}),
          ...(data.notes     !== undefined ? { notes: data.notes }                         : {}),
        },
        include: { dateType: true },
      }),

    delete: (id: string) => prisma.deviceModelDate.delete({ where: { id } }),
  };
}

// ─── Operating Systems ────────────────────────────────────────────────────────

export function osQueries(prisma: Prisma.TransactionClient) {
  return {
    list: () =>
      prisma.operatingSystem.findMany({
        include: { manufacturer: { select: { id: true, name: true } } },
        orderBy: [{ name: 'asc' }, { version: 'asc' }],
      }),

    findById: (id: string) =>
      prisma.operatingSystem.findUnique({
        where: { id },
        include: { manufacturer: { select: { id: true, name: true } } },
      }),

    findByCode: (code: string) =>
      prisma.operatingSystem.findUnique({ where: { code } }),

    create: (data: {
      code           : string;
      name           : string;
      version?       : string | null;
      manufacturerId?: string | null;
      isSystem?      : boolean;
    }) =>
      prisma.operatingSystem.create({
        data,
        include: { manufacturer: { select: { id: true, name: true } } },
      }),

    update: (
      id   : string,
      data : {
        code?          : string;
        name?          : string;
        version?       : string | null;
        manufacturerId?: string | null;
        isSystem?      : boolean;
      },
    ) =>
      prisma.operatingSystem.update({
        where  : { id },
        data,
        include: { manufacturer: { select: { id: true, name: true } } },
      }),

    delete: (id: string) =>
      prisma.operatingSystem.delete({ where: { id } }),

    countUsage: async (id: string) => {
      const [cis, docs, lics] = await Promise.all([
        prisma.cI.count({ where: { operatingSystemId: id } }),
        prisma.documentOperatingSystem.count({ where: { operatingSystemId: id } }),
        prisma.licenseOperatingSystem.count({ where: { operatingSystemId: id } }),
      ]);
      return cis + docs + lics;
    },
  };
}

export function bswQueries(prisma: Prisma.TransactionClient) {
  return {
    list: () =>
      prisma.baseSoftware.findMany({
        include: { manufacturer: { select: { id: true, name: true } } },
        orderBy: [{ name: 'asc' }, { version: 'asc' }],
      }),

    findById: (id: string) =>
      prisma.baseSoftware.findUnique({
        where: { id },
        include: { manufacturer: { select: { id: true, name: true } } },
      }),

    create: (data: {
      code           : string;
      name           : string;
      version?       : string | null;
      manufacturerId?: string | null;
      isSystem?      : boolean;
    }) =>
      prisma.baseSoftware.create({
        data,
        include: { manufacturer: { select: { id: true, name: true } } },
      }),

    update: (
      id   : string,
      data : {
        code?          : string;
        name?          : string;
        version?       : string | null;
        manufacturerId?: string | null;
        isSystem?      : boolean;
      },
    ) =>
      prisma.baseSoftware.update({
        where  : { id },
        data,
        include: { manufacturer: { select: { id: true, name: true } } },
      }),

    delete: (id: string) =>
      prisma.baseSoftware.delete({ where: { id } }),

    countUsage: async (id: string) => {
      const [cis, docs, lics] = await Promise.all([
        prisma.cIBaseSoftware.count({ where: { baseSoftwareId: id } }),
        prisma.documentBaseSoftware.count({ where: { baseSoftwareId: id } }),
        prisma.licenseBaseSoftware.count({ where: { baseSoftwareId: id } }),
      ]);
      return cis + docs + lics;
    },

    // CI ↔ BaseSoftware association
    listForCI: (ciId: string) =>
      prisma.cIBaseSoftware.findMany({
        where  : { ciId },
        include: {
          baseSoftware: {
            include: { manufacturer: { select: { id: true, name: true } } },
          },
        },
        orderBy: { baseSoftware: { name: 'asc' } },
      }),

    associate: (ciId: string, baseSoftwareId: string) =>
      prisma.cIBaseSoftware.create({ data: { ciId, baseSoftwareId } }),

    dissociate: (ciId: string, baseSoftwareId: string) =>
      prisma.cIBaseSoftware.delete({
        where: { ciId_baseSoftwareId: { ciId, baseSoftwareId } },
      }),

    getCiTypeCode: async (ciId: string) => {
      const ci = await prisma.cI.findUnique({
        where : { id: ciId },
        select: { id: true, ciTypeDef: { select: { code: true } } },
      });
      return ci === null ? null : (ci.ciTypeDef?.code ?? '');
    },
  };
}

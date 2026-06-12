import { PrismaClient } from '@prisma/client';

export function osQueries(prisma: PrismaClient) {
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
      const [docs, lics] = await Promise.all([
        prisma.documentOperatingSystem.count({ where: { operatingSystemId: id } }),
        prisma.licenseOperatingSystem.count({ where: { operatingSystemId: id } }),
      ]);
      return docs + lics;
    },
  };
}

export function bswQueries(prisma: PrismaClient) {
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

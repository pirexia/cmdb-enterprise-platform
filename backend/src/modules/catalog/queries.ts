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

import { PrismaClient } from '@prisma/client';

// Single shared Prisma client. On the 768MB VPS we keep the connection pool
// small so Neon's free-tier limits and the box's memory are both respected.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

export async function checkDbConnection(): Promise<void> {
  await prisma.$queryRaw`SELECT 1`;
}

export * from '@prisma/client';

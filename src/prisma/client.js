import { PrismaClient } from '@prisma/client';

const client = globalThis.__prismaClient ?? new PrismaClient();
if (process.env.NODE_ENV !== 'production') {
  globalThis.__prismaClient = client;
}

export default client;

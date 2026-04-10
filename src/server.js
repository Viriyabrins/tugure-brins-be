import Fastify from 'fastify';
import fastifyAutoload from '@fastify/autoload';
import cors from '@fastify/cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import config from './config/index.js';
import { startDBChannel, stopDBChannel } from './services/DBChannel.js';
import { sendError } from './utils/response.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default async function buildServer() {
  const fastify = Fastify({
    logger: {
      level: config.logLevel
    }
  });

  await fastify.register(cors, {
    origin: true,
    allowedHeaders: ['Authorization', 'Content-Type', 'X-App-Id'],
    credentials: true
  });

  await fastify.register(fastifyAutoload, {
    dir: path.join(__dirname, 'plugins')
  });

  await fastify.register(fastifyAutoload, {
    dir: path.join(__dirname, 'routes'),
    options: { prefix: '/api' }
  });

  fastify.setNotFoundHandler((request, reply) => {
    return sendError(reply, { message: `Route ${request.routerPath || request.url} not found` }, 404);
  });

  fastify.setErrorHandler((error, request, reply) => {
    fastify.log.error(error);
    return sendError(reply, error, error.statusCode || 500);
  });

  await startDBChannel();

  fastify.addHook('onClose', async () => {
    await stopDBChannel();
  });

  return fastify;
}

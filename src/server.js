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
    allowedHeaders: [
      'Authorization',
      'Content-Type',
      'X-App-Id',
      'X-Signature',
      'X-Signature-Timestamp',
      'X-Signature-UUID',
    ],
    credentials: true
  });

  await fastify.register(fastifyAutoload, {
    dir: path.join(__dirname, 'plugins')
  });

  // Global signature validation — applies to every /api/* route.
  // verifySignature decorator is registered by plugins/signature.js (via fastify-plugin).
  // Routes that the frontend legitimately calls WITHOUT a signature are not exempted here
  // because the browser always attaches X-Signature headers via withSignatureHeaders().
  // The /api/db-channel/stream SSE route is exempted because it uses a long-lived
  // connection that cannot be re-signed per-request.
  fastify.addHook('onRequest', async (request, reply) => {
    // Only validate routes under the /api prefix
    if (!request.url?.startsWith('/api')) return;
    // Exempt server-time endpoint (bootstrap for client clock-sync; no signature available yet).
    // Normalize path (strip query string and trailing slashes) before comparison so
    // requests like `/api/time/` or `/api/time?foo=bar` are properly exempted.
    const requestPath = String(request.url).split('?')[0].replace(/\/+$/, '');
    if (requestPath === '/api/time') return;
    // Exempt SSE streaming (long-lived connection, cannot carry per-request signature)
    if (request.url.includes('/db-channel/stream')) return;
    await fastify.verifySignature(request, reply);
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

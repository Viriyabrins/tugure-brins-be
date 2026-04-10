import eventBus from '../utils/eventBus.js';

function attachQueryToken(request) {
  const queryToken = request.query?.token || request.query?.access_token;

  if (!request.headers.authorization && queryToken) {
    request.headers.authorization = `Bearer ${queryToken}`;
  }
}

export default async function dbChannelStreamRoute(fastify) {
  fastify.get(
    '/db-channel/stream',
    {
      preHandler: [attachQueryToken, fastify.authenticate]
    },
    async (request, reply) => {
      reply.hijack();

      reply.raw.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
      reply.raw.setHeader('Connection', 'keep-alive');
      reply.raw.setHeader('X-Accel-Buffering', 'no');
      reply.raw.flushHeaders?.();

      reply.raw.write(`event: connected\ndata: ${JSON.stringify({ ok: true })}\n\n`);

      const onDbChannel = (payload) => {
        reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
      };

      const keepAlive = setInterval(() => {
        reply.raw.write(': keep-alive\n\n');
      }, 25000);

      let closed = false;

      const cleanup = () => {
        if (closed) {
          return;
        }

        closed = true;
        clearInterval(keepAlive);
        eventBus.off('db-channel', onDbChannel);
        if (!reply.raw.writableEnded) {
          reply.raw.end();
        }
      };

      eventBus.on('db-channel', onDbChannel);
      request.raw.on('close', cleanup);
      request.raw.on('aborted', cleanup);
    }
  );
}
/**
 * GET /api/time — returns the authoritative server time.
 * Used by the frontend to compute a clock-offset for synced timestamps
 * (offset-sync approach). This route is exempted from signature validation
 * because it is the bootstrap call that enables accurate signature creation.
 *
 * Response: { serverTime: "<ISO 8601 UTC string>" }
 */
export default async function (fastify) {
  fastify.get('/time', async (_request, reply) => {
    return reply.send({ serverTime: new Date().toISOString() });
  });
}

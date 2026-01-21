import { sendSuccess, sendError } from '../utils/response.js';

export default async function (fastify) {
  fastify.post(
    '/apps/:appId/integration-endpoints/Core/:endpointName',
    { preHandler: fastify.authenticate },
    async (request, reply) => {
      const endpoint = request.params.endpointName;
      if (endpoint !== 'SendEmail') {
        return sendError(reply, { message: `Endpoint ${endpoint} not implemented` }, 404);
      }

      const payload = request.body;
      fastify.log.info({ recipient: payload?.to }, 'Sending templated email via integration stub');
      return sendSuccess(reply, { status: 'queued', payload }, 'Email queued');
    }
  );
}

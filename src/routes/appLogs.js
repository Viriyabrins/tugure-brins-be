import { sendSuccess } from '../utils/response.js';

export default async function (fastify) {
  fastify.post(
    '/app-logs/:appId/log-user-in-app/:pageName',
    { preHandler: fastify.authenticate },
    async (request, reply) => {
      const user = request.user;
      fastify.log.info({ user: user?.email, page: request.params.pageName }, 'Captured navigation event');
      return sendSuccess(reply, { status: 'logged' }, 'Page log recorded');
    }
  );
}

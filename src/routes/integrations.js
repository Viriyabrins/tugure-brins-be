import { sendSuccess, sendError } from '../utils/response.js';
import emailService from '../services/EmailService.js';

export default async function (fastify) {
  fastify.post(
    '/apps/:appId/integration-endpoints/Core/:endpointName',
    { preHandler: fastify.authenticate },
    async (request, reply) => {
      const endpoint = request.params.endpointName;
      if (endpoint !== 'SendEmail') {
        return sendError(reply, { message: `Endpoint ${endpoint} not implemented` }, 404);
      }

      const { to, subject, body, cc, bcc } = request.body || {};

      if (!to || !subject || !body) {
        return sendError(reply, { message: 'Missing required fields: to, subject, body' }, 400);
      }

      try {
        const result = await emailService.sendEmail({ to, subject, body, cc, bcc });
        fastify.log.info({ recipient: to, messageId: result.messageId }, 'Email sent successfully');
        return sendSuccess(reply, { status: 'sent', messageId: result.messageId }, 'Email sent');
      } catch (error) {
        fastify.log.error({ recipient: to, error: error.message }, 'Failed to send email');
        return sendError(reply, { message: `Failed to send email: ${error.message}` }, 500);
      }
    }
  );
}

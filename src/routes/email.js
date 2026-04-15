import { sendSuccess, sendError } from '../utils/response.js';
import emailService from '../services/EmailService.js';
import { getUsersByRole } from '../utils/keycloakUtils.js';

// Re-export getUsersByRole so existing imports from this module still work
export { getUsersByRole };

export default async function (fastify) {
  /**
   * GET /api/users-by-role/:realm/:roleName
   * Returns all users assigned to the given client role in the specified realm.
   */
  fastify.get(
    '/users-by-role/:realm/:roleName',
    { preHandler: fastify.authenticate },
    async (request, reply) => {
      const { realm, roleName } = request.params;

      if (!realm || !roleName) {
        return sendError(reply, { message: 'realm and roleName parameters are required' }, 400);
      }

      if (realm !== 'brins' && realm !== 'tugure') {
        return sendError(reply, { message: 'realm must be "brins" or "tugure"' }, 400);
      }

      try {
        const users = await getUsersByRole(realm, roleName);
        return sendSuccess(reply, users, `Found ${users.length} users with role "${roleName}" in realm "${realm}"`);
      } catch (error) {
        fastify.log.error({ realm, roleName, error: error.message }, 'Failed to get users by role');
        return sendError(reply, { message: `Failed to get users by role: ${error.message}` }, 500);
      }
    }
  );

  /**
   * POST /api/send-email
   * Direct email sending endpoint.
   * Body: { to, subject, body, cc?, bcc? }
   */
  fastify.post(
    '/send-email',
    { preHandler: fastify.authenticate },
    async (request, reply) => {
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


import AuthController from '../controllers/AuthController.js';
import AuthService from '../services/AuthService.js';
import config from '../config/index.js';

export default async function (fastify) {
  const authService = new AuthService(config);
  const controller = new AuthController({ authService });

  fastify.post('/auth/keycloak/refresh', async (request, reply) => {
    try {
      const tokens = await authService.refresh({
        refreshToken: request.body?.refreshToken,
        idToken: request.body?.idToken,
      });
      return reply.send({ success: true, data: tokens });
    } catch (error) {
      return reply.status(error.statusCode || 401).send({
        success: false,
        message: error.message,
      });
    }
  });

  fastify.post('/auth/keycloak/logout', async (request, reply) => {
    try {
      const { refreshToken, idToken } = request.body || {};
      await authService.logout({ refreshToken, idToken });
      return reply.send({ success: true });
    } catch (error) {
      return reply.status(error.statusCode || 500).send({
        success: false,
        message: error.message,
      });
    }
  });

  fastify.post('/auth/keycloak/change-password', { preHandler: fastify.authenticate }, async (request, reply) => {
    try {
      const { currentPassword, newPassword } = request.body || {};
      const userId = request.user?.id;
      const username =
        request.user?.preferredUsername ||
        request.user?.preferred_username ||
        request.user?.email;

      await authService.changePassword({
        userAccessToken: request.user?.token,
        userId,
        username,
        currentPassword,
        newPassword,
      });

      return reply.send({ success: true, message: 'Password changed successfully' });
    } catch (error) {
      return reply.status(error.statusCode || 500).send({
        success: false,
        message: error.message,
      });
    }
  });

  fastify.post('/apps/:appId/auth/login', controller.login.bind(controller));
  fastify.get('/apps/:appId/entities/User/me', { preHandler: fastify.authenticate }, controller.me.bind(controller));
}

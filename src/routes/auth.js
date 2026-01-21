import AuthController from '../controllers/AuthController.js';
import AuthService from '../services/AuthService.js';
import config from '../config/index.js';

export default async function (fastify) {
  const authService = new AuthService(config);
  const controller = new AuthController({ authService });

  fastify.post('/apps/:appId/auth/login', controller.login.bind(controller));
  fastify.get('/apps/:appId/entities/User/me', { preHandler: fastify.authenticate }, controller.me.bind(controller));
}

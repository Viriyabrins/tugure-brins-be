import fp from 'fastify-plugin';
import config from '../config/index.js';
import AuthService from '../services/AuthService.js';

export default fp(async (fastify) => {
  const authService = new AuthService(config);

  fastify.decorate('authenticate', async (request, reply) => {
    const authHeader = request.headers.authorization || '';
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();

    // If no token provided, allow demo bypass in non-production for development convenience
    if (!token) {
      if (config.env !== 'production') {
        // Attach a lightweight demo user for development
        request.user = {
          id: 'dev-user',
          full_name: 'Dev Demo User',
          email: 'dev@local',
          role: 'ADMIN',
          token: null
        };
        return;
      }

      const err = new Error('Authorization header missing');
      err.statusCode = 401;
      throw err;
    }

    try {
      const user = await authService.me(token);
      request.user = { ...user, token };
    } catch (error) {
      // If auth failed and we're in development, attach a demo user instead of failing
      if (config.env !== 'production') {
        request.user = {
          id: 'dev-user',
          full_name: 'Dev Demo User',
          email: 'dev@local',
          role: 'ADMIN',
          token: token || null
        };
        return;
      }

      const err = new Error(error.message || 'Unauthorized');
      err.statusCode = 401;
      throw err;
    }
  });
});

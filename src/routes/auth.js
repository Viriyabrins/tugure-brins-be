import AuthController from '../controllers/AuthController.js';
import AuthService from '../services/AuthService.js';
import KeycloakBrokerService from '../services/KeycloakBrokerService.js';
import config from '../config/index.js';

export default async function (fastify) {
  const authService = new AuthService(config);
  const keycloakBroker = new KeycloakBrokerService(config);
  const controller = new AuthController({ authService });

  // Use the frontend origin for the callback URI because the browser always
  // reaches the backend through the frontend proxy (/api → backend).
  // Keycloak's Valid Redirect URIs only lists the frontend origin.
  const getCallbackUri = () => {
    try {
      const frontendOrigin = new URL(config.frontendUrl).origin;
      return `${frontendOrigin}/api/auth/keycloak/callback`;
    } catch {
      // Fallback: if frontendUrl is not a valid URL, build from parts
      return `http://localhost:5173/api/auth/keycloak/callback`;
    }
  };

  fastify.get('/auth/keycloak/login', async (request, reply) => {
    try {
      const loginUrl = keycloakBroker.buildLoginRedirect({
        frontendRedirectUri: request.query?.redirect_uri,
        callbackUri: getCallbackUri(),
      });
      return reply.redirect(loginUrl);
    } catch (error) {
      return reply.status(error.statusCode || 500).send({
        success: false,
        message: error.message,
      });
    }
  });

  fastify.get('/auth/keycloak/callback', async (request, reply) => {
    try {
      try {
        console.log('[AuthCallback] incoming query:', JSON.stringify(request.query));
      } catch (err) {}
      const authError = request.query?.error;
      const authErrorDescription = request.query?.error_description;
      const code = request.query?.code;
      const state = request.query?.state;

      if (authError) {
        return reply.status(400).send({
          success: false,
          message: authErrorDescription || authError,
          error: authError,
        });
      }

      if (!code || !state) {
        return reply.status(400).send({
          success: false,
          message: 'Missing code/state from Keycloak callback',
        });
      }

      const { frontendRedirectUri, tokens } = await keycloakBroker.exchangeCode({
        code,
        state,
        callbackUri: getCallbackUri(),
      });

      const frontendCallbackUrl = keycloakBroker.buildFrontendCallbackUrl(frontendRedirectUri, tokens);
      return reply.redirect(frontendCallbackUrl);
    } catch (error) {
      return reply.status(error.statusCode || 500).send({
        success: false,
        message: error.message,
      });
    }
  });

  fastify.post('/auth/keycloak/refresh', async (request, reply) => {
    try {
      const tokens = await keycloakBroker.refresh({
        refreshToken: request.body?.refreshToken,
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
      await keycloakBroker.logout({
        refreshToken: request.body?.refreshToken,
        idTokenHint: request.body?.idToken,
        postLogoutRedirectUri: request.body?.redirectUri || `${request.protocol}://${request.headers.host}/`,
      });
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

      // user.id comes from the JWT "sub" claim set during authentication
      const userId = request.user?.id;
      // preferred_username is typically the Keycloak login name
      const username =
        request.user?.preferredUsername ||
        request.user?.preferred_username ||
        request.user?.email;

      await keycloakBroker.changePassword({
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

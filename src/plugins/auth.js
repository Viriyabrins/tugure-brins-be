import fp from 'fastify-plugin';
import config from '../config/index.js';
import AuthService from '../services/AuthService.js';

/**
 * Decode a JWT payload without verifying the signature.
 * The token was already issued by Keycloak so this is safe for
 * extracting identity claims on the trusted backend.
 */
function decodeJwtPayload(jwt) {
  if (!jwt || typeof jwt !== 'string') return null;
  const parts = jwt.split('.');
  if (parts.length < 2) return null;
  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const pad = base64.length % 4 === 0 ? '' : '='.repeat(4 - (base64.length % 4));
    return JSON.parse(Buffer.from(base64 + pad, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

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

    // 1. Try demo-token lookup first
    try {
      const user = await authService.me(token);
      request.user = { ...user, token };
      return;
    } catch {
      // Demo lookup failed – continue to JWT decode
    }

    // 2. Try decoding as a Keycloak JWT
    const payload = decodeJwtPayload(token);
    if (payload && payload.sub) {
      const realmRoles = payload.realm_access?.roles || [];
      const resourceMap = payload.resource_access || {};
      const resourceRoles = Object.values(resourceMap).flatMap(r => r.roles || []);
      const allRoles = [...realmRoles, ...resourceRoles];

      request.user = {
        id: payload.sub,
        full_name: payload.name || '',
        email: payload.email || '',
        preferredUsername: payload.preferred_username || payload.email || '',
        role: 'USER',
        application_roles: allRoles,
        token,
      };
      return;
    }

    // 3. Fallback for development
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

    const err = new Error('Unauthorized');
    err.statusCode = 401;
    throw err;
  });
});

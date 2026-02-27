import { sendSuccess, sendError } from '../utils/response.js';
import emailService from '../services/EmailService.js';
import config from '../config/index.js';

/**
 * Get a Keycloak Admin API access token using client credentials grant.
 */
async function getKeycloakAdminToken() {
  const tokenUrl = `${config.keycloakUrl.replace(/\/$/, '')}/realms/${encodeURIComponent(config.keycloakRealm)}/protocol/openid-connect/token`;

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: config.keycloakClientId,
    client_secret: config.keycloakClientSecret,
  });

  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Keycloak token request failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  return data.access_token;
}

/**
 * Fetch all users who have a specific client role in Keycloak.
 */
async function getUsersByRole(roleName) {
  const adminToken = await getKeycloakAdminToken();
  const baseUrl = config.keycloakUrl.replace(/\/$/, '');
  const realm = encodeURIComponent(config.keycloakRealm);
  const clientId = config.keycloakClientId;

  // First, find the internal client UUID for our client_id
  const clientsUrl = `${baseUrl}/admin/realms/${realm}/clients?clientId=${encodeURIComponent(clientId)}`;
  const clientsRes = await fetch(clientsUrl, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });

  if (!clientsRes.ok) {
    // Fallback: try realm-level roles
    return getUsersByRealmRole(adminToken, baseUrl, realm, roleName);
  }

  const clients = await clientsRes.json();
  if (!Array.isArray(clients) || clients.length === 0) {
    // Fallback: try realm-level roles
    return getUsersByRealmRole(adminToken, baseUrl, realm, roleName);
  }

  const clientUuid = clients[0].id;

  // Get users with this client role
  const roleUsersUrl = `${baseUrl}/admin/realms/${realm}/clients/${clientUuid}/roles/${encodeURIComponent(roleName)}/users?max=100`;
  const roleUsersRes = await fetch(roleUsersUrl, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });

  if (!roleUsersRes.ok) {
    // If client role not found, try realm-level role
    return getUsersByRealmRole(adminToken, baseUrl, realm, roleName);
  }

  const users = await roleUsersRes.json();
  return (users || [])
    .filter(u => u.email)
    .map(u => ({ email: u.email, name: u.firstName ? `${u.firstName} ${u.lastName || ''}`.trim() : u.username }));
}

/**
 * Fallback: fetch users by realm-level role.
 */
async function getUsersByRealmRole(adminToken, baseUrl, realm, roleName) {
  const url = `${baseUrl}/admin/realms/${realm}/roles/${encodeURIComponent(roleName)}/users?max=100`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });

  if (!res.ok) {
    console.warn(`[email] Failed to get users for realm role "${roleName}": ${res.status}`);
    return [];
  }

  const users = await res.json();
  return (users || [])
    .filter(u => u.email)
    .map(u => ({ email: u.email, name: u.firstName ? `${u.firstName} ${u.lastName || ''}`.trim() : u.username }));
}

export default async function (fastify) {
  /**
   * GET /api/users-by-role/:roleName
   * Returns all users who have the given role, with their emails.
   */
  fastify.get(
    '/users-by-role/:roleName',
    { preHandler: fastify.authenticate },
    async (request, reply) => {
      const { roleName } = request.params;

      if (!roleName) {
        return sendError(reply, { message: 'roleName parameter is required' }, 400);
      }

      try {
        const users = await getUsersByRole(roleName);
        return sendSuccess(reply, users, `Found ${users.length} users with role "${roleName}"`);
      } catch (error) {
        fastify.log.error({ roleName, error: error.message }, 'Failed to get users by role');
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

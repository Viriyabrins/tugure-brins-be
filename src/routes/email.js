import { sendSuccess, sendError } from '../utils/response.js';
import emailService from '../services/EmailService.js';
import config from '../config/index.js';

/**
 * Get a Keycloak Admin API access token using client credentials grant.
 * Uses the BRINS realm client as the system service account for email operations.
 */
async function getKeycloakAdminToken() {
  const realm = config.keycloakRealmBrins;
  const clientId = config.keycloakClientIdBrins;
  const clientSecret = config.keycloakClientSecretBrins;

  if (!config.keycloakUrl || !realm || !clientId || !clientSecret) {
    throw new Error('Keycloak admin credentials not configured (BRINS realm)');
  }

  const tokenUrl = `${config.keycloakUrl.replace(/\/$/, '')}/realms/${encodeURIComponent(realm)}/protocol/openid-connect/token`;
  const bodyParams = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
  });

  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: bodyParams,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Keycloak token request failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  console.log('[Email] Keycloak admin access_token acquired (masked)');
  return data.access_token;
}

/**
 * Fetch all users in a Keycloak group by group name.
 * 1. GET /admin/realms/{realm}/groups → find group by name → get its id
 * 2. GET /admin/realms/{realm}/groups/{groupId}/members → get users
 */
async function getUsersByGroup(groupName) {
  let adminToken;
  try {
    adminToken = await getKeycloakAdminToken();
  } catch (err) {
    console.warn('[Email] Could not obtain Keycloak admin token, skipping group lookup:', err.message);
    return [];
  }
  const baseUrl = config.keycloakUrl.replace(/\/$/, '');
  const realm = encodeURIComponent(config.keycloakRealmBrins);

  // Step 1: Find the group by name
  const groupsUrl = `${baseUrl}/admin/realms/${realm}/groups?search=${encodeURIComponent(groupName)}`;
  console.log(`[Email] Fetching groups from: ${groupsUrl}`);

  const groupsRes = await fetch(groupsUrl, {
    headers: { Authorization: `bearer ${adminToken}` },
  });

  if (!groupsRes.ok) {
    const text = await groupsRes.text();
    console.error(`[Email] Failed to fetch groups (${groupsRes.status}):`, text);
    return [];
  }

  const groups = await groupsRes.json();
  console.log(`[Email] Groups found:`, groups.map(g => ({ id: g.id, name: g.name })));

  // Find exact match (search is partial, so we need to filter)
  const group = groups.find(g => g.name === groupName);
  if (!group) {
    console.warn(`[Email] No group found with name "${groupName}"`);
    return [];
  }

  console.log(`[Email] Found group "${groupName}" with id: ${group.id}`);

  // Step 2: Get members of the group
  const membersUrl = `${baseUrl}/admin/realms/${realm}/groups/${group.id}/members?max=200`;
  console.log(`[Email] Fetching group members from: ${membersUrl}`);

  const membersRes = await fetch(membersUrl, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });

  if (!membersRes.ok) {
    const text = await membersRes.text();
    console.error(`[Email] Failed to fetch group members (${membersRes.status}):`, text);
    return [];
  }

  const members = await membersRes.json();
  const users = (members || [])
    .filter(u => u.email)
    .map(u => ({
      email: u.email,
      name: u.firstName ? `${u.firstName} ${u.lastName || ''}`.trim() : u.username,
    }));

  console.log(`[Email] Group "${groupName}" has ${users.length} member(s) with emails:`, users.map(u => u.email));
  return users;
}

export default async function (fastify) {
  /**
   * GET /api/users-by-group/:groupName
   * Returns all users in the given Keycloak group, with their emails.
   */
  fastify.get(
    '/users-by-group/:groupName',
    { preHandler: fastify.authenticate },
    async (request, reply) => {
      const { groupName } = request.params;

      if (!groupName) {
        return sendError(reply, { message: 'groupName parameter is required' }, 400);
      }

      try {
        const users = await getUsersByGroup(groupName);
        return sendSuccess(reply, users, `Found ${users.length} users in group "${groupName}"`);
      } catch (error) {
        fastify.log.error({ groupName, error: error.message }, 'Failed to get users by group');
        return sendError(reply, { message: `Failed to get users by group: ${error.message}` }, 500);
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

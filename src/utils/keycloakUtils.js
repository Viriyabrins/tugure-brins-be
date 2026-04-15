import https from 'https';
import { URL } from 'url';
import config from '../config/index.js';

/**
 * Helper: Make HTTPS requests with SSL validation disabled for self-signed certs
 */
function httpsRequest(options) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({
            status: res.statusCode,
            statusText: res.statusMessage,
            data: data ? JSON.parse(data) : null,
            text: data,
          });
        } catch (e) {
          resolve({
            status: res.statusCode,
            statusText: res.statusMessage,
            data: null,
            text: data,
          });
        }
      });
    });

    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

/**
 * Get a Keycloak Admin API access token using client credentials grant.
 * Supports both BRINS and TUGURE realms.
 * @param {'brins'|'tugure'} realm - The target realm
 */
export async function getKeycloakAdminToken(realm = 'brins') {
  const requestId = `KCTOKEN_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const isTugure = realm === 'tugure';
  const realmName = isTugure ? config.keycloakRealmTugure : config.keycloakRealmBrins;
  const clientId = isTugure ? config.keycloakClientIdTugure : config.keycloakClientIdBrins;
  const clientSecret = isTugure ? config.keycloakClientSecretTugure : config.keycloakClientSecretBrins;

  console.log(`[${requestId}][KeycloakToken] ════════════════════════════════════════`);
  console.log(`[${requestId}][KeycloakToken] Token Request Initiated`);
  console.log(`[${requestId}][KeycloakToken] Target Realm: "${realm}" (isTugure: ${isTugure})`);
  console.log(`[${requestId}][KeycloakToken] Configuration Check:`, {
    keycloakUrl: config.keycloakUrl ? `✓ Set (${config.keycloakUrl.substring(0, 30)}...)` : '✗ Missing',
    realmName: realmName ? `✓ "${realmName}"` : '✗ Missing',
    clientId: clientId ? `✓ "${clientId.substring(0, 20)}..."` : '✗ Missing',
    clientSecret: clientSecret ? `✓ Length: ${clientSecret.length}` : '✗ Missing',
  });

  if (!config.keycloakUrl || !realmName || !clientId || !clientSecret) {
    console.error(`[${requestId}][KeycloakToken] ✗ Configuration incomplete. Cannot proceed.`);
    throw new Error(`Keycloak admin credentials not configured (${realm} realm)`);
  }

  const tokenUrl = `${config.keycloakUrl.replace(/\/$/, '')}/realms/${encodeURIComponent(realmName)}/protocol/openid-connect/token`;
  console.log(`[${requestId}][KeycloakToken] Token URL: ${tokenUrl}`);

  const bodyParams = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
  });

  console.log(`[${requestId}][KeycloakToken] Request Body Params:`, {
    grant_type: 'client_credentials',
    client_id: `${clientId.substring(0, 15)}...`,
    client_secret: `(masked, length: ${clientSecret.length})`,
  });

  console.log(`[${requestId}][KeycloakToken] Sending POST request to Keycloak...`);

  const bodyStr = bodyParams.toString();
  const parsedUrl = new URL(tokenUrl);

  let res;
  try {
    res = await httpsRequest({
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: parsedUrl.pathname + (parsedUrl.search || ''),
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(bodyStr),
      },
      rejectUnauthorized: false,
      body: bodyStr,
    });
  } catch (err) {
    console.error(`[${requestId}][KeycloakToken] ✗ Request error:`, err.message);
    throw err;
  }

  console.log(`[${requestId}][KeycloakToken] Response Status: ${res.status} ${res.statusText}`);

  if (res.status !== 200) {
    console.error(`[${requestId}][KeycloakToken] ✗ Token Request Failed`);
    console.error(`[${requestId}][KeycloakToken] Response Body:`, res.text.substring(0, 500));
    console.log(`[${requestId}][KeycloakToken] ════════════════════════════════════════\n`);
    throw new Error(`Keycloak token request failed for ${realm} (${res.status})`);
  }

  const data = res.data;
  const tokenType = data.token_type || 'Bearer';
  const tokenLength = (data.access_token || '').length;
  const expiresIn = data.expires_in || 'unknown';

  console.log(`[${requestId}][KeycloakToken] ✓ Token Acquired Successfully`);
  console.log(`[${requestId}][KeycloakToken] Token Details:`, {
    type: tokenType,
    length: tokenLength,
    expiresIn: expiresIn,
    scope: data.scope || 'N/A',
  });
  console.log(`[${requestId}][KeycloakToken] Token Value (first 50 chars): ${data.access_token.substring(0, 50)}...`);
  console.log(`[${requestId}][KeycloakToken] ════════════════════════════════════════\n`);

  return data.access_token;
}

/**
 * Fetch all users assigned to a specific client role in the given Keycloak realm.
 * 1. GET /admin/realms/{realm}/clients?clientId={clientId} → find client UUID
 * 2. GET /admin/realms/{realm}/clients/{clientUUID}/roles/{roleName}/users → get users
 *
 * @param {'brins'|'tugure'} realm - The target realm
 * @param {string} roleName - The client role name (e.g. 'maker-brins-role', 'tugure-checker-role')
 * @returns {Promise<Array<{email: string, name: string}>>}
 */
export async function getUsersByRole(realm, roleName) {
  const requestId = `USERSBYROLE_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  console.log(`[${requestId}][UsersByRole] ════════════════════════════════════════`);
  console.log(`[${requestId}][UsersByRole] Get Users by Role Request`);
  console.log(`[${requestId}][UsersByRole] Realm: "${realm}", Role: "${roleName}"`);

  let adminToken;
  try {
    console.log(`[${requestId}][UsersByRole] Step 1: Acquiring Keycloak admin token...`);
    adminToken = await getKeycloakAdminToken(realm);
    console.log(`[${requestId}][UsersByRole] ✓ Admin token acquired (length: ${adminToken.length})`);
  } catch (err) {
    console.error(`[${requestId}][UsersByRole] ✗ Failed to obtain Keycloak admin token:`, err.message);
    console.log(`[${requestId}][UsersByRole] ════════════════════════════════════════\n`);
    return [];
  }

  const isTugure = realm === 'tugure';
  const baseUrl = config.keycloakUrl.replace(/\/$/, '');
  const realmName = encodeURIComponent(isTugure ? config.keycloakRealmTugure : config.keycloakRealmBrins);
  const clientIdString = isTugure ? config.keycloakClientIdTugure : config.keycloakClientIdBrins;

  // Step 1: Find the client UUID by clientId string
  const clientsUrl = `${baseUrl}/admin/realms/${realmName}/clients?clientId=${encodeURIComponent(clientIdString)}`;
  console.log(`[${requestId}][UsersByRole] Step 2: Looking up client UUID for "${clientIdString}"`);
  console.log(`[${requestId}][UsersByRole] Clients URL: ${clientsUrl}`);

  let clientsRes;
  try {
    const parsedUrl = new URL(clientsUrl);
    clientsRes = await httpsRequest({
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: parsedUrl.pathname + (parsedUrl.search || ''),
      method: 'GET',
      headers: { Authorization: `Bearer ${adminToken}` },
      rejectUnauthorized: false,
    });
  } catch (err) {
    console.error(`[${requestId}][UsersByRole] ✗ Failed to fetch clients:`, err.message);
    console.log(`[${requestId}][UsersByRole] ════════════════════════════════════════\n`);
    return [];
  }

  console.log(`[${requestId}][UsersByRole] Clients Response Status: ${clientsRes.status} ${clientsRes.statusText}`);

  if (clientsRes.status !== 200) {
    console.error(`[${requestId}][UsersByRole] ✗ Failed to fetch clients (${clientsRes.status}):`);
    console.error(`[${requestId}][UsersByRole] Response Body:`, clientsRes.text.substring(0, 500));
    console.log(`[${requestId}][UsersByRole] ════════════════════════════════════════\n`);
    return [];
  }

  const clients = clientsRes.data;
  if (!clients || clients.length === 0) {
    console.warn(`[${requestId}][UsersByRole] ✗ No client found with clientId "${clientIdString}" in realm "${realm}"`);
    console.log(`[${requestId}][UsersByRole] ════════════════════════════════════════\n`);
    return [];
  }

  const clientUUID = clients[0].id;
  console.log(`[${requestId}][UsersByRole] ✓ Found client UUID: ${clientUUID}`);

  // Step 2: Fetch users assigned to the role
  const roleUsersUrl = `${baseUrl}/admin/realms/${realmName}/clients/${clientUUID}/roles/${encodeURIComponent(roleName)}/users?max=200`;
  console.log(`[${requestId}][UsersByRole] Step 3: Fetching users with role "${roleName}"`);
  console.log(`[${requestId}][UsersByRole] Role Users URL: ${roleUsersUrl}`);

  let roleUsersRes;
  try {
    const parsedUrl = new URL(roleUsersUrl);
    roleUsersRes = await httpsRequest({
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: parsedUrl.pathname + (parsedUrl.search || ''),
      method: 'GET',
      headers: { Authorization: `Bearer ${adminToken}` },
      rejectUnauthorized: false,
    });
  } catch (err) {
    console.error(`[${requestId}][UsersByRole] ✗ Failed to fetch role users:`, err.message);
    console.log(`[${requestId}][UsersByRole] ════════════════════════════════════════\n`);
    return [];
  }

  console.log(`[${requestId}][UsersByRole] Role Users Response Status: ${roleUsersRes.status} ${roleUsersRes.statusText}`);

  if (roleUsersRes.status !== 200) {
    console.error(`[${requestId}][UsersByRole] ✗ Failed to fetch role users (${roleUsersRes.status}):`);
    console.error(`[${requestId}][UsersByRole] Response Body:`, roleUsersRes.text.substring(0, 500));
    console.log(`[${requestId}][UsersByRole] ════════════════════════════════════════\n`);
    return [];
  }

  const members = roleUsersRes.data;
  const users = (members || [])
    .filter(u => u.email)
    .map(u => ({
      email: u.email,
      name: u.firstName ? `${u.firstName} ${u.lastName || ''}`.trim() : u.username,
    }));

  console.log(`[${requestId}][UsersByRole] ✓ Retrieved ${members.length} total member(s), ${users.length} with email(s)`);
  users.forEach((u, idx) => {
    console.log(`[${requestId}][UsersByRole]   [${idx + 1}] ${u.email} (${u.name})`);
  });
  console.log(`[${requestId}][UsersByRole] ════════════════════════════════════════\n`);

  return users;
}

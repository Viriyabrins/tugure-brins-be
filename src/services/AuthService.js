import { Agent, fetch as undiciFetch } from 'undici';

/**
 * Decode a JWT payload without verifying the signature.
 * Works for both access tokens and refresh tokens (when they are JWTs).
 */
const decodeJwtPayload = (jwt) => {
  if (!jwt || typeof jwt !== 'string') return null;
  const parts = jwt.split('.');
  if (parts.length < 2) return null;
  try {
    const b = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const pad = b.length % 4 === 0 ? '' : '='.repeat(4 - (b.length % 4));
    return JSON.parse(Buffer.from(b + pad, 'base64').toString('utf8'));
  } catch {
    return null;
  }
};

const DOMAIN_REALM_MAP = {
  'brins.co.id': 'brins',
  'tugure.co.id': 'tugure',
};

export default class AuthService {
  constructor(config) {
    this.config = config;
    this.userMap = new Map(
      (config.demoUsers || []).map((user) => [user.token, user])
    );

    this._dispatcher = config.keycloakCaCert
      ? new Agent({ connect: { ca: config.keycloakCaCert } })
      : null;
  }

  _fetch(url, options = {}) {
    if (this._dispatcher) {
      return undiciFetch(url, { ...options, dispatcher: this._dispatcher });
    }
    return fetch(url, options);
  }

  async me(token) {
    const user = this.userMap.get(token);
    if (!user) {
      const error = new Error('Invalid or missing token');
      error.statusCode = 401;
      throw error;
    }
    return this.formatUser(user);
  }

  /**
   * Resolve Keycloak realm and client credentials from email domain.
   * @param {string} email
   * @returns {{ realm: string, clientId: string, clientSecret: string }}
   */
  resolveRealm(email) {
    const domain = email.toLowerCase().split('@')[1];
    const realmKey = DOMAIN_REALM_MAP[domain] || 'brins'; // Default to 'brins' realm if domain not mapped

    // Domain validation disabled for testing
    // if (!realmKey) {
    //   const error = new Error(`Unsupported email domain: ${domain}`);
    //   error.statusCode = 400;
    //   throw error;
    // }

    let realm, clientId, clientSecret;

    if (realmKey === 'brins') {
      realm = this.config.keycloakRealmBrins;
      clientId = this.config.keycloakClientIdBrins;
      clientSecret = this.config.keycloakClientSecretBrins;
    } else if (realmKey === 'tugure') {
      realm = this.config.keycloakRealmTugure;
      clientId = this.config.keycloakClientIdTugure;
      clientSecret = this.config.keycloakClientSecretTugure;
    }

    if (!realm || !clientId || !clientSecret) {
      const error = new Error(`Missing Keycloak configuration for realm: ${realmKey}`);
      error.statusCode = 500;
      throw error;
    }

    return { realm, clientId, clientSecret };
  }

  async login({ email, password }) {
    if (!email || !password) {
      const error = new Error('email and password are required');
      error.statusCode = 400;
      throw error;
    }

    const normalizedEmail = email.toLowerCase().trim();

    if (!normalizedEmail.includes('@')) {
      const error = new Error('Invalid email format');
      error.statusCode = 400;
      throw error;
    }

    const keycloakUrl = this.config.keycloakUrl;
    if (!keycloakUrl) {
      const error = new Error('KEYCLOAK_URL is not configured');
      error.statusCode = 500;
      throw error;
    }

    const { realm, clientId, clientSecret } = this.resolveRealm(normalizedEmail);
    const scope = this.config.keycloakScope || 'openid';

    const tokenUrl = `${keycloakUrl.replace(/\/$/, '')}/realms/${encodeURIComponent(realm)}/protocol/openid-connect/token`;

    const body = new URLSearchParams({
      grant_type: 'password',
      client_id: clientId,
      client_secret: clientSecret,
      username: normalizedEmail,
      password,
      scope,
    });

    let response;
    try {
      response = await this._fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
    } catch (err) {
      console.error('[AuthService] Keycloak token request failed:', err?.message || err);
      const error = new Error(`Failed to contact Keycloak: ${err?.message || 'network error'}`);
      error.statusCode = 502;
      throw error;
    }

    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      const message = payload.error_description || payload.error || 'Authentication failed';
      const error = new Error(message);
      error.statusCode = response.status === 401 ? 401 : (response.status || 500);
      throw error;
    }

    return {
      access_token: payload.access_token,
      refresh_token: payload.refresh_token,
      id_token: payload.id_token,
      expires_in: payload.expires_in,
      token_type: payload.token_type || 'Bearer',
      scope: payload.scope,
      resolved_realm: realm,
    };
  }

  /**
   * Shared realm resolver from any JWT (refresh token or id token).
   * Returns the realm, clientId, and clientSecret for the correct realm.
   * @param {string|undefined} tokenA
   * @param {string|undefined} tokenB
   */
  _resolveRealmFromToken(tokenA, tokenB) {
    const payload = decodeJwtPayload(tokenA) || decodeJwtPayload(tokenB);
    const iss = payload?.iss || '';
    const realmMatch = iss.match(/\/realms\/([^/]+)$/);
    const detectedRealm = realmMatch?.[1];

    if (detectedRealm === this.config.keycloakRealmBrins) {
      return {
        realm: this.config.keycloakRealmBrins,
        clientId: this.config.keycloakClientIdBrins,
        clientSecret: this.config.keycloakClientSecretBrins,
      };
    }
    if (detectedRealm === this.config.keycloakRealmTugure) {
      return {
        realm: this.config.keycloakRealmTugure,
        clientId: this.config.keycloakClientIdTugure,
        clientSecret: this.config.keycloakClientSecretTugure,
      };
    }
    // No matching realm found — return nulls so callers can throw a clear error
    return { realm: null, clientId: null, clientSecret: null };
  }

  /**
   * Obtain a service-account (client_credentials) token for the given realm.
   * The confidential client must have "Service Accounts Enabled" and the
   * service-account user must hold the `manage-users` role from realm-management.
   */
  async _getAdminToken({ realm, clientId, clientSecret }) {
    const tokenUrl = `${this.config.keycloakUrl.replace(/\/$/, '')}/realms/${encodeURIComponent(realm)}/protocol/openid-connect/token`;
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    });
    const response = await this._fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.access_token) {
      const error = new Error(payload.error_description || payload.error || 'Failed to obtain admin token');
      error.statusCode = 500;
      throw error;
    }
    return payload.access_token;
  }

  /**
   * Verify a user's current password via a direct-access (password) grant.
   * Returns true when credentials are valid, false otherwise.
   */
  async _verifyUserPassword({ realm, clientId, clientSecret, username, password }) {
    const tokenUrl = `${this.config.keycloakUrl.replace(/\/$/, '')}/realms/${encodeURIComponent(realm)}/protocol/openid-connect/token`;
    const body = new URLSearchParams({
      grant_type: 'password',
      client_id: clientId,
      client_secret: clientSecret,
      username,
      password,
      scope: 'openid',
    });
    const response = await this._fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    }).catch(() => null);
    return Boolean(response?.ok);
  }

  /**
   * Change a Keycloak user's password.
   * Detects the realm from the user's current access token so the correct
   * realm admin API is called — works for both brins and tugure users.
   *
   * @param {{ userAccessToken: string, userId: string, username: string, currentPassword: string, newPassword: string }} param0
   */
  async changePassword({ userAccessToken, userId, username, currentPassword, newPassword }) {
    if (!userId || !username) {
      const error = new Error('User identity is required');
      error.statusCode = 400;
      throw error;
    }
    if (!currentPassword) {
      const error = new Error('Current password is required');
      error.statusCode = 400;
      throw error;
    }
    if (!newPassword || newPassword.length < 6) {
      const error = new Error('New password must be at least 6 characters');
      error.statusCode = 400;
      throw error;
    }

    const keycloakUrl = this.config.keycloakUrl;
    if (!keycloakUrl) {
      const error = new Error('KEYCLOAK_URL is not configured');
      error.statusCode = 500;
      throw error;
    }

    const { realm, clientId, clientSecret } = this._resolveRealmFromToken(userAccessToken);
    if (!realm || !clientId || !clientSecret) {
      const error = new Error('Unable to determine realm from user token');
      error.statusCode = 500;
      throw error;
    }

    // 1. Verify the current password
    const isValid = await this._verifyUserPassword({ realm, clientId, clientSecret, username, password: currentPassword });
    if (!isValid) {
      const error = new Error('Current password is incorrect');
      error.statusCode = 400;
      throw error;
    }

    // 2. Get admin token
    const adminToken = await this._getAdminToken({ realm, clientId, clientSecret });

    // 3. Reset password via Admin REST API
    const resetUrl = `${keycloakUrl.replace(/\/$/, '')}/admin/realms/${encodeURIComponent(realm)}/users/${encodeURIComponent(userId)}/reset-password`;
    const response = await this._fetch(resetUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ type: 'password', value: newPassword, temporary: false }),
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      const error = new Error(payload.errorMessage || payload.error || 'Failed to change password in Keycloak');
      error.statusCode = response.status || 500;
      throw error;
    }

    return true;
  }

  /**
   * Refresh tokens using the correct realm detected from the token iss claim.
   * Handles both multi-realm direct-login tokens and OIDC broker tokens.
   *
   * @param {{ refreshToken: string, idToken?: string }} param0
   */
  async refresh({ refreshToken, idToken }) {
    if (!refreshToken) {
      const error = new Error('refresh_token is required');
      error.statusCode = 400;
      throw error;
    }

    const keycloakUrl = this.config.keycloakUrl;
    if (!keycloakUrl) {
      const error = new Error('KEYCLOAK_URL is not configured');
      error.statusCode = 500;
      throw error;
    }

    // Detect realm from refresh token first, fall back to id token
    const { realm, clientId, clientSecret } = this._resolveRealmFromToken(refreshToken, idToken);

    // Debug log for refresh attempts (mask tokens)
    try {
      console.log('[AuthService] refresh called', {
        realm,
        tokenEndpoint: `${this.config.keycloakUrl.replace(/\/$/, '')}/realms/${encodeURIComponent(realm)}/protocol/openid-connect/token`,
        refreshTokenHint: refreshToken ? `${String(refreshToken).slice(0,8)}...` : null,
        idTokenHint: idToken ? `${String(idToken).slice(0,8)}...` : null,
      });
    } catch (e) {
      // ignore logging failures
    }

    if (!realm || !clientId || !clientSecret) {
      const error = new Error('Unable to resolve Keycloak realm for token refresh');
      error.statusCode = 500;
      throw error;
    }

    const tokenUrl = `${keycloakUrl.replace(/\/$/, '')}/realms/${encodeURIComponent(realm)}/protocol/openid-connect/token`;

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    });

    let response;
    try {
      response = await this._fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
    } catch (err) {
      console.error('[AuthService] token refresh request failed:', err?.message || err);
      const error = new Error(`Failed to contact Keycloak: ${err?.message || 'network error'}`);
      error.statusCode = 502;
      throw error;
    }

    const payload = await response.json().catch(() => ({}));
    try {
      console.log('[AuthService] refresh response', { status: response.status, ok: response.ok, payload });
    } catch (e) {}

    if (!response.ok) {
      const message = payload.error_description || payload.error || 'Token refresh failed';
      const error = new Error(message);
      error.statusCode = response.status === 401 ? 401 : (response.status || 500);
      throw error;
    }

    return {
      accessToken: payload.access_token || null,
      refreshToken: payload.refresh_token || refreshToken,
      idToken: payload.id_token || null,
      expiresIn: payload.expires_in || null,
      refreshExpiresIn: payload.refresh_expires_in || null,
      tokenType: payload.token_type || 'Bearer',
    };
  }

  /**
   * Terminate the Keycloak session for direct-login (password-grant) tokens.
   * Detects the realm from the idToken or refreshToken `iss` claim so the
   * correct realm endpoint and client credentials are used.
   * Falls back to the single-realm (OIDC broker) config when detection fails.
   *
   * @param {{ refreshToken?: string, idToken?: string }} param0
   */
  async logout({ refreshToken, idToken }) {
    if (!refreshToken && !idToken) return;

    const keycloakUrl = this.config.keycloakUrl;
    if (!keycloakUrl) return;

    // Extract realm from the `iss` claim, e.g. "https://host/realms/brins" → "brins"
    const { realm, clientId, clientSecret } = this._resolveRealmFromToken(idToken, refreshToken);

    if (!realm || !clientId || !clientSecret) {
      console.warn('[AuthService] logout: missing client config for realm');
      return;
    }

    const logoutUrl = `${keycloakUrl.replace(/\/$/, '')}/realms/${encodeURIComponent(realm)}/protocol/openid-connect/logout`;

    const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret });
    if (refreshToken) body.set('refresh_token', refreshToken);

    await this._fetch(logoutUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    }).catch((err) => {
      console.warn('[AuthService] logout request failed:', err?.message || err);
    });
  }

  formatUser(user) {
    return {
      id: user.token,
      full_name: user.fullName,
      email: user.email,
      role: user.role,
      app_id: this.config.appId
    };
  }
}

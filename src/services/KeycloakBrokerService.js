import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Agent, fetch as undiciFetch } from 'undici';

const STATE_TTL_MS = 5 * 60 * 1000;

const base64UrlDecode = (value = '') => {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
    return Buffer.from(normalized + padding, 'base64').toString('utf8');
};

const decodeJwtPayload = (jwt) => {
    if (!jwt || typeof jwt !== 'string') return null;
    const parts = jwt.split('.');
    if (parts.length < 2) return null;
    try {
        return JSON.parse(base64UrlDecode(parts[1]));
    } catch {
        return null;
    }
};

const toBase64Url = (buffer) =>
    buffer
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');

const generatePkcePair = () => {
    const codeVerifier = toBase64Url(randomBytes(64));
    const codeChallenge = toBase64Url(createHash('sha256').update(codeVerifier).digest());
    return { codeVerifier, codeChallenge };
};

export default class KeycloakBrokerService {
    constructor(config) {
        this.config = config;
        this.pendingStates = new Map();

        // Jika ada CA cert (untuk Keycloak dengan sertifikat self-signed / internal CA),
        // buat satu Agent yang dipakai ulang untuk semua request ke Keycloak.
        // Di production dengan CA publik, config.keycloakCaCert = null → pakai global fetch biasa.
        this._dispatcher = config.keycloakCaCert
            ? new Agent({ connect: { ca: config.keycloakCaCert } })
            : null;
    }

    ensureConfigured() {
        if (!this.config.keycloakUrl || !this.config.keycloakRealm || !this.config.keycloakClientId || !this.config.keycloakClientSecret) {
            const error = new Error('Keycloak confidential settings are missing on backend');
            error.statusCode = 500;
            throw error;
        }
    }

    /**
     * Wrapper fetch yang menggunakan undici Agent dengan custom CA cert
     * ketika Keycloak memakai sertifikat self-signed / internal CA.
     * Di production (CA publik, tanpa KEYCLOAK_CA_CERT_PATH), pakai global fetch biasa.
     */
    _fetch(url, options = {}) {
        if (this._dispatcher) {
            return undiciFetch(url, { ...options, dispatcher: this._dispatcher });
        }
        return fetch(url, options);
    }

    get issuerBaseUrl() {
        const root = this.config.keycloakUrl.replace(/\/$/, '');
        const realm = encodeURIComponent(this.config.keycloakRealm);
        return `${root}/realms/${realm}`;
    }

    get authEndpoint() {
        return `${this.issuerBaseUrl}/protocol/openid-connect/auth`;
    }

    get tokenEndpoint() {
        return `${this.issuerBaseUrl}/protocol/openid-connect/token`;
    }

    get logoutEndpoint() {
        return `${this.issuerBaseUrl}/protocol/openid-connect/logout`;
    }

    normalizeFrontendRedirect(redirectUri) {
        return redirectUri || this.config.frontendUrl || 'http://localhost:5173/Dashboard';
    }

    cleanupExpiredStates() {
        const now = Date.now();
        for (const [state, entry] of this.pendingStates.entries()) {
            if (now - entry.createdAt > STATE_TTL_MS) {
                this.pendingStates.delete(state);
            }
        }
    }

    buildLoginRedirect({ frontendRedirectUri, callbackUri }) {
        this.ensureConfigured();
        this.cleanupExpiredStates();

        const state = randomUUID();
        const { codeVerifier, codeChallenge } = generatePkcePair();
        this.pendingStates.set(state, {
            frontendRedirectUri: this.normalizeFrontendRedirect(frontendRedirectUri),
            codeVerifier,
            createdAt: Date.now(),
        });

        try {
            console.log(`[KeycloakBroker] buildLoginRedirect stored state=${state} frontendRedirectUri=${this.normalizeFrontendRedirect(frontendRedirectUri)} code_challenge=${codeChallenge.slice(0,8)}...`);
        } catch (err) {
            // ignore logging failures
        }

        const params = new URLSearchParams({
            client_id: this.config.keycloakClientId,
            response_type: 'code',
            scope: 'openid profile email brin-apps', 
            redirect_uri: callbackUri,
            state,
            code_challenge: codeChallenge,
            code_challenge_method: 'S256',
        });

        return `${this.authEndpoint}?${params.toString()}`;
    }

    async exchangeCode({ code, state, callbackUri }) {
        this.ensureConfigured();

        try {
            console.log(`[KeycloakBroker] exchangeCode called state=${state} code=${String(code).slice(0,8)} callbackUri=${callbackUri} pendingStates=${this.pendingStates.size}`);
        } catch (err) {
            // ignore logging failures
        }

        const stateEntry = this.pendingStates.get(state);
        if (!stateEntry) {
            try {
                console.warn(`[KeycloakBroker] missing state entry for state=${state}`);
            } catch (err) {}
            const error = new Error('Invalid or expired OAuth state');
            error.statusCode = 400;
            throw error;
        }
        this.pendingStates.delete(state);

        const body = new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            redirect_uri: callbackUri,
            client_id: this.config.keycloakClientId,
            client_secret: this.config.keycloakClientSecret,
            code_verifier: stateEntry.codeVerifier,
        });

        let response;
        try {
            response = await this._fetch(this.tokenEndpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body,
            });
        } catch (err) {
            console.error('[KeycloakBroker] token request failed', err?.message || err);
            const error = new Error(`Failed to contact token endpoint: ${err?.message || 'network error'}`);
            error.statusCode = 502;
            throw error;
        }

        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
            const error = new Error(payload.error_description || payload.error || 'Token exchange failed');
            error.statusCode = response.status || 500;
            throw error;
        }

        return {
            frontendRedirectUri: stateEntry.frontendRedirectUri,
            tokens: {
                accessToken: payload.access_token || null,
                refreshToken: payload.refresh_token || null,
                idToken: payload.id_token || null,
                expiresIn: payload.expires_in || null,
                refreshExpiresIn: payload.refresh_expires_in || null,
                tokenType: payload.token_type || 'Bearer',
            },
        };
    }

    async refresh({ refreshToken }) {
        this.ensureConfigured();

        if (!refreshToken) {
            const error = new Error('refresh_token is required');
            error.statusCode = 400;
            throw error;
        }

        const body = new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: this.config.keycloakClientId,
            client_secret: this.config.keycloakClientSecret,
        });

        const response = await this._fetch(this.tokenEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body,
        });

        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
            const error = new Error(payload.error_description || payload.error || 'Refresh token failed');
            error.statusCode = response.status || 401;
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

    async logout({ refreshToken, idTokenHint, postLogoutRedirectUri }) {
        this.ensureConfigured();

        const body = new URLSearchParams({
            client_id: this.config.keycloakClientId,
            client_secret: this.config.keycloakClientSecret,
            post_logout_redirect_uri: postLogoutRedirectUri,
        });

        if (refreshToken) body.set('refresh_token', refreshToken);
        if (idTokenHint) body.set('id_token_hint', idTokenHint);

        await this._fetch(this.logoutEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body,
        }).catch(() => null);

        return true;
    }

    /**
     * Obtain a service-account (client_credentials) token so we can call the
     * Keycloak Admin REST API.  The confidential client must have the
     * "Service Accounts Enabled" toggle ON and its service-account user must
     * hold the `manage-users` role from the `realm-management` client.
     */
    async _getAdminToken() {
        const body = new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: this.config.keycloakClientId,
            client_secret: this.config.keycloakClientSecret,
        });

        const response = await this._fetch(this.tokenEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body,
        });

        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload.access_token) {
            const error = new Error(
                payload.error_description || payload.error || 'Failed to obtain admin token',
            );
            error.statusCode = 500;
            throw error;
        }

        return payload.access_token;
    }

    /**
     * Verify a user's current password by attempting a Resource Owner
     * Password Credentials (direct-access) grant against Keycloak.
     * Returns true when the credentials are valid, false otherwise.
     *
     * NOTE: The Keycloak client must have "Direct Access Grants Enabled".
     */
    async _verifyUserPassword(username, password) {
        const body = new URLSearchParams({
            grant_type: 'password',
            client_id: this.config.keycloakClientId,
            client_secret: this.config.keycloakClientSecret,
            username,
            password,
            scope: 'openid',
        });

        const response = await this._fetch(this.tokenEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body,
        });

        return response.ok;
    }

    /**
     * Change a Keycloak user's password.
     *
     * Flow:
     *  1. Verify the current password via direct-access grant.
     *  2. Obtain an admin (service-account) token.
     *  3. Call the Admin REST API to reset the user's password.
     *
     * @param {object} params
     * @param {string} params.userId        – Keycloak user ID (sub)
     * @param {string} params.username       – Keycloak username / preferred_username
     * @param {string} params.currentPassword
     * @param {string} params.newPassword
     */
    async changePassword({ userId, username, currentPassword, newPassword }) {
        this.ensureConfigured();

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

        // 1. Verify the current password
        const isValid = await this._verifyUserPassword(username, currentPassword);
        if (!isValid) {
            const error = new Error('Current password is incorrect');
            error.statusCode = 400;
            throw error;
        }

        // 2. Get admin token
        const adminToken = await this._getAdminToken();

        // 3. Reset password via Admin REST API
        const root = this.config.keycloakUrl.replace(/\/$/, '');
        const realm = encodeURIComponent(this.config.keycloakRealm);
        const resetUrl = `${root}/admin/realms/${realm}/users/${encodeURIComponent(userId)}/reset-password`;

        const response = await this._fetch(resetUrl, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${adminToken}`,
            },
            body: JSON.stringify({
                type: 'password',
                value: newPassword,
                temporary: false,
            }),
        });

        if (!response.ok) {
            const payload = await response.json().catch(() => ({}));
            const error = new Error(
                payload.errorMessage || payload.error || 'Failed to change password in Keycloak',
            );
            error.statusCode = response.status || 500;
            throw error;
        }

        return true;
    }

    buildFrontendCallbackUrl(frontendRedirectUri, tokens) {
        const payload = decodeJwtPayload(tokens.accessToken) || {};
        const params = new URLSearchParams({
            kc_access_token: tokens.accessToken || '',
            kc_refresh_token: tokens.refreshToken || '',
            kc_id_token: tokens.idToken || '',
            kc_expires_in: String(tokens.expiresIn || ''),
            kc_token_type: tokens.tokenType || 'Bearer',
            kc_email: payload.email || '',
            kc_name: payload.name || '',
            kc_sub: payload.sub || '',
        });

        return `${frontendRedirectUri}#${params.toString()}`;
    }
}

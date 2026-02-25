import { createHash, randomBytes, randomUUID } from 'node:crypto';

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
    }

    ensureConfigured() {
        if (!this.config.keycloakUrl || !this.config.keycloakRealm || !this.config.keycloakClientId || !this.config.keycloakClientSecret) {
            const error = new Error('Keycloak confidential settings are missing on backend');
            error.statusCode = 500;
            throw error;
        }
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

        const stateEntry = this.pendingStates.get(state);
        if (!stateEntry) {
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

        const response = await fetch(this.tokenEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body,
        });

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

        const response = await fetch(this.tokenEndpoint, {
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

        await fetch(this.logoutEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body,
        }).catch(() => null);

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

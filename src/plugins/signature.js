import fp from 'fastify-plugin';
import crypto from 'node:crypto';
import config from '../config/index.js';

/**
 * In-memory UUID store with TTL-based expiry (= tolerance window = 5 seconds).
 * For multi-instance deployments, replace with a shared Redis store using
 * key format: sig:uuid:<uuid> with TTL = toleranceMs.
 */
class NonceStore {
    constructor() {
        this._store = new Map(); // key -> expiresAt (epoch ms)
    }

    has(key) {
        const exp = this._store.get(key);
        if (exp === undefined) return false;
        if (Date.now() > exp) {
            this._store.delete(key);
            return false;
        }
        return true;
    }

    set(key, ttlMs) {
        this._store.set(key, Date.now() + ttlMs);
    }

    cleanup() {
        const now = Date.now();
        for (const [key, exp] of this._store) {
            if (now > exp) this._store.delete(key);
        }
    }
}

export default fp(async (fastify) => {
    const toleranceMs = config.signatureToleranceMs;
    const secret = config.signatureSecret;

    const nonceStore = new NonceStore();

    // Periodic cleanup to prevent unbounded memory growth
    const cleanupInterval = setInterval(() => nonceStore.cleanup(), 60_000);
    fastify.addHook('onClose', () => clearInterval(cleanupInterval));

    /**
     * Fastify preHandler — validates HMAC-SHA256 request signatures.
     *
     * Required headers:
    *   X-Signature           — hex HMAC-SHA256 of canonical payload
    *   X-Signature-Timestamp — ISO 8601 UTC timestamp sent by frontend
    *   X-Signature-UUID      — UUID v4 unique per request
    *
    * Canonical payload (must match frontend exactly): `<uuid>|<timestamp>|<METHOD>|<path>`
    * Expiry: 10 seconds (configurable via SIGNATURE_MAX_AGE_MS / SIGNATURE_TOLERANCE_MS)
     */
    fastify.decorate('verifySignature', async (request, reply) => {
        const sig = request.headers['x-signature'];
        const timestamp = request.headers['x-signature-timestamp'];
        const uuid = request.headers['x-signature-uuid'];

        // Step 1: Ensure all required headers are present
        if (!sig || !timestamp || !uuid) {
            fastify.log.warn({ path: request.url }, 'Signature rejected: missing headers');
            const err = new Error('Missing signature headers');
            err.statusCode = 401;
            throw err;
        }

        // Step 2: Validate timestamp format (must be parseable ISO-8601).
        // Supports both UTC ("Z") and offset-aware ("+07:00") formats.
        const tsUtcMs = new Date(timestamp).getTime();
        if (isNaN(tsUtcMs)) {
            fastify.log.warn({ path: request.url }, 'Signature rejected: invalid timestamp format');
            const err = new Error('Invalid signature timestamp');
            err.statusCode = 401;
            throw err;
        }

        // Step 3: Check timestamp age using UTC epoch on both sides.
        // new Date(timestamp).getTime() returns UTC epoch regardless of any timezone
        // offset in the ISO string, so comparing directly with Date.now() is always
        // correct and timezone-agnostic.
        const age = Math.abs(Date.now() - tsUtcMs);
        if (age > toleranceMs) {
            fastify.log.warn({ path: request.url, ageMs: age, toleranceMs }, 'Signature rejected: timestamp expired');
            const err = new Error(`Signature expired. Age: ${age}ms, max: ${toleranceMs}ms. Please ensure your device clock is accurate.`);
            err.statusCode = 401;
            throw err;
        }

        // Step 4: Enforce UUID uniqueness (replay protection)
        const uuidKey = `sig:uuid:${uuid}`;
        if (nonceStore.has(uuidKey)) {
            fastify.log.warn({ path: request.url }, 'Signature rejected: uuid replay detected');
            const err = new Error('Signature UUID already used');
            err.statusCode = 401;
            throw err;
        }

        // Step 4: Reconstruct canonical payload (must match client exactly)
        const method = request.method.toUpperCase();
        const urlPath = request.url.split('?')[0]; // strip query string
        const canonical = `${uuid}|${timestamp}|${method}|${urlPath}`;

        // Step 5: Compute HMAC-SHA256 and compare with constant-time equality
        if (!secret) {
            fastify.log.warn({ path: request.url }, 'Signature rejected: SIGNATURE_SECRET not configured');
            const err = new Error('Signature validation not configured');
            err.statusCode = 500;
            throw err;
        }

        const expected = crypto.createHmac('sha256', secret).update(canonical).digest();
        let received;
        try {
            received = Buffer.from(sig, 'hex');
        } catch {
            fastify.log.warn({ path: request.url }, 'Signature rejected: invalid hex format');
            const err = new Error('Invalid signature format');
            err.statusCode = 401;
            throw err;
        }

        if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) {
            fastify.log.warn({ path: request.url }, 'Signature rejected: HMAC mismatch');
            const err = new Error('Invalid signature');
            err.statusCode = 401;
            throw err;
        }

        // Step 6: Mark UUID as used (replay protection window = toleranceMs)
        nonceStore.set(uuidKey, toleranceMs);
    });
});

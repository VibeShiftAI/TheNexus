/**
 * Authenticate the human behind a chat turn, independently of the legacy
 * local_user/admin stub. Only the pinned Cloudflare Access application's
 * identity-provider token for the configured operator counts. Service tokens,
 * bridge credentials, email headers and request JSON never establish identity.
 *
 * Narrow JWT profile: RS256, public RSA signing keys from the configured team
 * URL only, exact issuer/audience, app/user claims, mandatory validity times.
 * https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/
 */
const { createPublicKey, verify } = require('node:crypto');

function createOperatorAuthenticator() {
    const issuer = (process.env.NEXUS_OPERATOR_ACCESS_ISSUER || '').trim();
    const audience = (process.env.NEXUS_OPERATOR_ACCESS_AUD || '').trim();
    const email = (process.env.NEXUS_OPERATOR_EMAIL || '').trim().toLowerCase();
    // No token-controlled issuer, URL, key, or key-discovery endpoint.
    const configured = /^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer) && audience && email;
    let cachedKeys = [];
    let expiresAt = 0;
    let retryAfter = 0;
    let pending;
    let keyFetchFailed = false;
    const warningTimes = new Map();
    function reject(category) {
        const now = Date.now();
        // Separate windows ensure malformed requests cannot hide an Access outage.
        if (!warningTimes.has(category) || now - warningTimes.get(category) >= 30_000) {
            warningTimes.set(category, now);
            console.warn(`[OperatorAccess] ${category}: operator authority withheld`);
        }
        return false;
    }

    async function signingKey(kid) {
        const now = Date.now();
        const cached = cachedKeys.find(key => key.kid === kid);
        if (cached && now < expiresAt) return cached;
        if (!pending && now >= retryAfter) {
            retryAfter = now + 30_000; // bound misses/outages; do not fetch per forged kid
            pending = (async () => {
                const response = await fetch(`${issuer}/cdn-cgi/access/certs`, {
                    redirect: 'error', signal: AbortSignal.timeout(5000),
                });
                if (!response.ok) throw new Error('Access signing keys unavailable');
                const data = await response.json();
                if (!Array.isArray(data.keys)) throw new Error('Invalid Access signing keys');
                cachedKeys = data.keys.filter(key => key && key.kty === 'RSA'
                    && key.alg === 'RS256' && key.use === 'sig' && typeof key.kid === 'string');
                expiresAt = Date.now() + 5 * 60_000;
                keyFetchFailed = false;
            })().catch(error => {
                keyFetchFailed = true;
                throw error;
            }).finally(() => { pending = undefined; });
        }
        if (pending) await pending;
        return Date.now() < expiresAt ? cachedKeys.find(key => key.kid === kid) : undefined;
    }

    return async function authenticateOperatorRequest(req) {
        if (!configured) return reject('config-missing');
        if (req.get('x-praxis-bridge-token') || req.get('cf-access-client-id')
            || req.get('cf-access-client-secret')) return reject('claim-rejected');
        const token = req.get('cf-access-jwt-assertion');
        if (typeof token !== 'string' || token.length > 16_384) return reject('claim-rejected');
        let failureCategory = 'claim-rejected';
        try {
            const parts = token.split('.');
            if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) return reject('claim-rejected');
            const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
            const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
            if (header?.alg !== 'RS256' || header.typ !== 'JWT' || typeof header.kid !== 'string'
                || header.crit !== undefined || header.b64 !== undefined) return reject('claim-rejected');
            const now = Math.floor(Date.now() / 1000);
            // Array-only aud deliberately pins the Cloudflare application-token profile.
            if (claims?.iss !== issuer || !Array.isArray(claims.aud) || !claims.aud.includes(audience)
                || claims.type !== 'app' || typeof claims.sub !== 'string' || !claims.sub
                || typeof claims.email !== 'string' || claims.email.toLowerCase() !== email
                || claims.common_name !== undefined
                || !Number.isSafeInteger(claims.exp) || claims.exp <= now
                || !Number.isSafeInteger(claims.iat) || claims.iat > now
                || !Number.isSafeInteger(claims.nbf) || claims.nbf > now
                || claims.exp <= claims.iat || claims.exp <= claims.nbf) return reject('claim-rejected');
            failureCategory = 'key-fetch-failed';
            const jwk = await signingKey(header.kid);
            if (!jwk) return reject(keyFetchFailed ? 'key-fetch-failed' : 'claim-rejected');
            const key = createPublicKey({ key: jwk, format: 'jwk' });
            failureCategory = 'claim-rejected';
            // Key retrieval can outlast a token's remaining validity.
            const checkedAt = Math.floor(Date.now() / 1000);
            const valid = claims.nbf <= checkedAt && claims.iat <= checkedAt && claims.exp > checkedAt
                && verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`, 'utf8'), key,
                Buffer.from(parts[2], 'base64url'));
            return valid || reject('claim-rejected');
        } catch {
            // Network/key/parser failures deny authority, while ordinary chat survives.
            // Never log the identity token or copy it to the Praxis payload/history.
            return reject(failureCategory);
        }
    };
}

module.exports = { createOperatorAuthenticator };

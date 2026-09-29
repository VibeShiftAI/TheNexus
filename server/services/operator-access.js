/**
 * Authenticate the human behind a chat turn, independently of the legacy
 * local_user/admin stub. Two sessions of the pinned Cloudflare Access
 * application count, and nothing else:
 *
 *   user    the identity-provider (one-time PIN) session of the configured
 *           operator email: what a browser holds after the Access login.
 *   device  the service-token session the Windows travel shell plants at
 *           launch (desktop/src-tauri/src/main.rs, exchange_and_inject), pinned
 *           by that token's Client ID (the JWT `common_name` claim) in
 *           NEXUS_OPERATOR_DEVICE_IDS. That laptop never sees an Access login
 *           page, so this session is Robert's only identity there (2026-09-25).
 *           The shell's updater and roster pulls ride the same token, but only
 *           an interactive chat POST reaches this authenticator.
 *
 * Service tokens presented as request headers, bridge credentials, email
 * headers, cookies and request JSON never establish identity. Every refusal
 * is logged as a fixed category plus a fixed check name; claims and token
 * values are never logged or returned.
 *
 * Narrow JWT profile: RS256, public RSA signing keys from the configured team
 * URL only, exact issuer/audience, `type: app`, mandatory exp/iat. User tokens
 * also need nbf, a subject and the operator email; device tokens need the
 * pinned common_name, no email, and honor nbf when Cloudflare includes it.
 * The audience is the pinned application AUD tag in either form RFC 7519
 * allows: the array Cloudflare documents (`["<aud>"]`) or the single string
 * (`"<aud>"`). 2026-09-26: the array-only rule refused every turn of the
 * travel shell's service-token session at `check=audience` although the pin
 * equals the AUD of the one Access application on the host (task 5fbeff4a);
 * a different audience value is still refused in both forms.
 * https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/
 */
const { createPublicKey, verify } = require('node:crypto');

// A Cloudflare service-token Client ID looks like `<32 hex>.access`; the shape
// check only rejects obvious garbage so a typo is reported, not trusted.
const DEVICE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;

function createOperatorAuthenticator() {
    const issuer = (process.env.NEXUS_OPERATOR_ACCESS_ISSUER || '').trim();
    const audience = (process.env.NEXUS_OPERATOR_ACCESS_AUD || '').trim();
    const email = (process.env.NEXUS_OPERATOR_EMAIL || '').trim().toLowerCase();
    // No token-controlled issuer, URL, key, or key-discovery endpoint.
    const configIssues = [
        !issuer ? 'NEXUS_OPERATOR_ACCESS_ISSUER=missing'
            : !/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer) ? 'NEXUS_OPERATOR_ACCESS_ISSUER=invalid' : null,
        !audience ? 'NEXUS_OPERATOR_ACCESS_AUD=missing' : null,
        !email ? 'NEXUS_OPERATOR_EMAIL=missing' : null,
    ].filter(Boolean);
    const configured = configIssues.length === 0;
    // Optional trusted devices: service-token Client IDs, comma or space separated.
    // A malformed entry is dropped (fail closed for that device), never trusted.
    const deviceEntries = (process.env.NEXUS_OPERATOR_DEVICE_IDS || '').split(/[\s,]+/).filter(Boolean);
    const deviceIds = deviceEntries.filter(id => DEVICE_ID_PATTERN.test(id));
    const droppedDeviceIds = deviceEntries.length - deviceIds.length;
    let cachedKeys = [];
    let expiresAt = 0;
    let retryAfter = 0;
    let pending;
    let keyFetchFailed = false;
    const warningTimes = new Map();
    function warn(category, check) {
        // Only fixed setting names/states and check names, never configured
        // values, claims or request data.
        const detail = category === 'config-missing'
            ? ` (${configIssues.join(', ')}; configure trusted values and reload Nexus)`
            : check ? ` (check=${check})` : '';
        console.warn(`[OperatorAccess] ${category}: operator authority withheld${detail}`);
    }
    function reject(category, check) {
        const now = Date.now();
        const window = check ? `${category}:${check}` : category;
        // Separate windows per category and check ensure malformed requests
        // cannot hide an Access outage, and one failing check cannot hide another.
        if (!warningTimes.has(window) || now - warningTimes.get(window) >= 30_000) {
            warningTimes.set(window, now);
            warn(category, check);
        }
        return false;
    }

    // These pins are immutable for this router. Surface an incomplete deployment
    // at boot, before a human discovers it by asking for a guarded action.
    // ai-chat currently constructs one authenticator. Keep this per-instance so
    // a future router's configuration failure is visible too; boot warnings do
    // not consume the request-time rate limit, including the first rejection.
    if (!configured) warn('config-missing');
    if (droppedDeviceIds > 0) {
        console.warn(`[OperatorAccess] config-invalid: NEXUS_OPERATOR_DEVICE_IDS dropped ${droppedDeviceIds} malformed entr${droppedDeviceIds === 1 ? 'y' : 'ies'}; trusted devices=${deviceIds.length}`);
    }
    // Counts only: the activation check reads this line after a reload.
    if (configured) console.log(`[OperatorAccess] configured: operator user pinned; trusted devices=${deviceIds.length}`);

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

    const rejected = check => ({ ok: false, category: 'claim-rejected', check });

    /**
     * Decide one request without logging. Every outcome is a fixed category
     * (`ok`, `config-missing`, `assertion-missing`, `claim-rejected`,
     * `key-fetch-failed`) and, for a rejected claim, the fixed name of the
     * first check that failed. Nothing from the token is ever copied out.
     */
    async function evaluate(req) {
        if (!configured) return { ok: false, category: 'config-missing' };
        // Executor-style credentials never ride with a human session; a request
        // carrying them is machine traffic even when a session token is present.
        if (req.get('x-praxis-bridge-token') || req.get('cf-access-client-id')
            || req.get('cf-access-client-secret')) return rejected('executor-headers');
        const token = req.get('cf-access-jwt-assertion');
        if (token === undefined || token === null || token === '') return { ok: false, category: 'assertion-missing' };
        if (typeof token !== 'string' || token.length > 16_384) return rejected('token-shape');
        let stage = 'token-shape';
        try {
            const parts = token.split('.');
            if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) return rejected('token-shape');
            const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
            const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
            if (!claims || typeof claims !== 'object' || Array.isArray(claims)) return rejected('token-shape');
            if (header?.alg !== 'RS256' || header.typ !== 'JWT' || typeof header.kid !== 'string'
                || header.crit !== undefined || header.b64 !== undefined) return rejected('header-profile');
            if (claims.iss !== issuer) return rejected('issuer');
            // Exact pinned AUD tag, as the documented array or the RFC 7519 single
            // string; any other value or type is refused.
            const audienceOk = Array.isArray(claims.aud) ? claims.aud.includes(audience) : claims.aud === audience;
            if (!audienceOk) return rejected('audience');
            if (claims.type !== 'app') return rejected('token-type');
            const now = Math.floor(Date.now() / 1000);
            if (!Number.isSafeInteger(claims.exp) || claims.exp <= now
                || !Number.isSafeInteger(claims.iat) || claims.iat > now
                || claims.exp <= claims.iat) return rejected('validity');
            const nbfInvalid = !Number.isSafeInteger(claims.nbf) || claims.nbf > now || claims.exp <= claims.nbf;
            let identity;
            if (claims.common_name === undefined) {
                // User session: the identity provider verified the operator email.
                if (nbfInvalid) return rejected('validity');
                if (typeof claims.sub !== 'string' || !claims.sub) return rejected('subject');
                if (typeof claims.email !== 'string' || claims.email.toLowerCase() !== email) return rejected('identity-email');
                identity = 'user';
            } else {
                // Device session: Cloudflare issued this token to a service token
                // (no identity provider, empty subject, no email). Only the pinned
                // Client IDs count, and never one that also claims to be a person.
                if (claims.nbf !== undefined && nbfInvalid) return rejected('validity');
                if (claims.email !== undefined || typeof claims.sub !== 'string') return rejected('service-identity');
                if (typeof claims.common_name !== 'string' || !deviceIds.includes(claims.common_name)) return rejected('service-identity');
                identity = 'device';
            }
            stage = 'key-fetch';
            const jwk = await signingKey(header.kid);
            if (!jwk) return keyFetchFailed ? { ok: false, category: 'key-fetch-failed' } : rejected('unknown-key');
            stage = 'signature';
            const key = createPublicKey({ key: jwk, format: 'jwk' });
            // Key retrieval can outlast a token's remaining validity: re-check the
            // window at verification time and report an aged-out token as `validity`,
            // reserving `signature` for an actual key or signature mismatch.
            const checkedAt = Math.floor(Date.now() / 1000);
            if ((claims.nbf !== undefined && claims.nbf > checkedAt) || claims.iat > checkedAt
                || claims.exp <= checkedAt) return rejected('validity');
            const valid = verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`, 'utf8'), key,
                Buffer.from(parts[2], 'base64url'));
            return valid ? { ok: true, identity } : rejected('signature');
        } catch {
            // Network/key/parser failures deny authority, while ordinary chat survives.
            // Never log the identity token or copy it to the Praxis payload/history.
            return stage === 'key-fetch' ? { ok: false, category: 'key-fetch-failed' } : rejected(stage);
        }
    }

    async function authenticateOperatorRequest(req) {
        const outcome = await evaluate(req);
        if (outcome.ok) {
            // One line per accepted human turn, so the live path is attributable.
            console.log(`[OperatorAccess] operator verified (identity=${outcome.identity})`);
            return true;
        }
        return reject(outcome.category, outcome.check);
    }

    /**
     * Redacted self-check of the caller's own session for the diagnostics
     * route: reason codes, identity kind and presence booleans only. Logs
     * nothing and confers nothing.
     */
    authenticateOperatorRequest.inspect = async function inspectOperatorRequest(req) {
        const outcome = await evaluate(req);
        const assertion = req.get('cf-access-jwt-assertion');
        return {
            operator: outcome.ok,
            identity: outcome.ok ? outcome.identity : null,
            reason: outcome.ok ? 'ok' : outcome.category,
            ...(outcome.check ? { check: outcome.check } : {}),
            assertionPresent: typeof assertion === 'string' && assertion !== '',
            configured: {
                issuer: !configIssues.some(issue => issue.startsWith('NEXUS_OPERATOR_ACCESS_ISSUER')),
                audience: !!audience,
                operatorEmail: !!email,
                trustedDevices: deviceIds.length,
            },
        };
    };

    return authenticateOperatorRequest;
}

module.exports = { createOperatorAuthenticator };

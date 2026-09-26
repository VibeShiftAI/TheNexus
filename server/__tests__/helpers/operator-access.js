const crypto = require('node:crypto');

// Test-only issuer: the private key never belongs to Nexus in production.
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const issuer = 'https://operator-test.cloudflareaccess.com';
const audience = 'nexus-test-audience';
const email = 'robert@example.test';
const kid = 'test-access-key';
const jwks = { keys: [{ ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' }] };

// Client ID of the fixture service token "installed" on the travel laptop
// (shape of a Cloudflare service-token Client ID; not a real one).
const deviceId = '0123456789abcdef0123456789abcdef.access';

function token(claims = {}, header = {}) {
    const now = Math.floor(Date.now() / 1000);
    const encode = value => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
    const input = `${encode({ alg: 'RS256', kid, typ: 'JWT', ...header })}.${encode({
        iss: issuer, aud: [audience], email, sub: 'operator-user', type: 'app',
        iat: now, nbf: now, exp: now + 300, ...claims,
    })}`;
    return `${input}.${crypto.sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')}`;
}

/** The application token Cloudflare forwards for a service-token session
 *  (what the Windows travel shell's planted CF_Authorization cookie yields):
 *  common_name, empty subject, no email, and no nbf. */
function serviceToken(claims = {}, header = {}) {
    return token({ sub: '', email: undefined, nbf: undefined, common_name: deviceId, ...claims }, header);
}

/** Pin the fixture issuer, audience and operator email; `deviceIds` (a raw
 *  NEXUS_OPERATOR_DEVICE_IDS value) is unset unless given. */
function configure({ deviceIds = '' } = {}) {
    const values = { NEXUS_OPERATOR_ACCESS_ISSUER: issuer, NEXUS_OPERATOR_ACCESS_AUD: audience, NEXUS_OPERATOR_EMAIL: email,
        NEXUS_OPERATOR_DEVICE_IDS: deviceIds };
    const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
    Object.assign(process.env, values);
    return () => {
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
    };
}

module.exports = { issuer, audience, email, deviceId, jwks, token, serviceToken, configure };

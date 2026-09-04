/**
 * Fleet-shared secrets (ticket P3-33).
 *
 * Keys that more than one repo on this machine needs — GOOGLE_API_KEY,
 * CORTEX_GATEWAY_KEY — live ONCE in /Volumes/Projects/.fleet-env (outside every
 * repo; template in /Volumes/Projects/.fleet-env.example). Praxis (src/config.ts)
 * and TheCortex (config.py) load the same file.
 *
 * Call this BEFORE the repo's own `require('dotenv').config(...)`. dotenv never
 * overwrites a var that is already set, so precedence is:
 *   process env > fleet file > repo .env
 * Override the location with FLEET_ENV_PATH; a missing file is silently skipped.
 * Values are never logged.
 */
const fs = require('fs');

const DEFAULT_FLEET_ENV_PATH = '/Volumes/Projects/.fleet-env';

function fleetEnvPath() {
    return process.env.FLEET_ENV_PATH || DEFAULT_FLEET_ENV_PATH;
}

/** Load the fleet env file into process.env (no override). Returns true if a file was loaded. */
function loadFleetEnv() {
    const p = fleetEnvPath();
    if (!fs.existsSync(p)) return false;
    require('dotenv').config({ path: p, quiet: true });
    return true;
}

module.exports = { loadFleetEnv, fleetEnvPath };

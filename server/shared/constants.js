/**
 * Shared Constants
 * 
 * Centralizes configuration values used across route modules.
 */
const path = require('path');
const { resolveEndpoints } = require('@praxis/contract');

const PROJECT_ROOT = process.env.PROJECT_ROOT || path.resolve(process.env.USERPROFILE || process.env.HOME, 'Projects');

const ALLOWED_ORIGINS = [
    'http://localhost:3000',
    'http://localhost:4000',
    'https://nexus.vibeshiftai.com'
];

const SCAN_CACHE_TTL = 5000;   // 5 seconds
const MODELS_CACHE_TTL = 60000; // 1 minute

// ─── Canonical service endpoints ─────────────────────────────────────────
// The contract supplies both CJS and ESM builds. Resolve local service calls
// through the same loopback normalization as Praxis.
const serviceEndpoints = resolveEndpoints(process.env);
const PRAXIS_URL = serviceEndpoints.praxis;
// Praxis's full-scope tool-bridge token (agent-bridge-policy.ts mints it on
// first use and persists it at <praxis data>/agent-bridge-token). The Nexus
// relay presents it on /agent-tool calls made on the operator's behalf
// (Council Chamber summon / problem intake) — without it the bridge serves
// the read-only executor subset and refuses spawn_council with 403 (the
// Chamber's Summon button had been silently broken since the 2026-08-04
// bridge hardening).
const PRAXIS_BRIDGE_TOKEN_FILE = process.env.PRAXIS_BRIDGE_TOKEN_FILE
    || path.resolve(PROJECT_ROOT, 'Praxis', 'data', 'agent-bridge-token');
const CORTEX_URL = serviceEndpoints.cortex;
const DASHBOARD_URL = process.env.DASHBOARD_URL || 'http://localhost:3000';

module.exports = {
    PROJECT_ROOT,
    ALLOWED_ORIGINS,
    SCAN_CACHE_TTL,
    MODELS_CACHE_TTL,
    PRAXIS_URL,
    PRAXIS_BRIDGE_TOKEN_FILE,
    CORTEX_URL,
    DASHBOARD_URL
};

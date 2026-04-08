/**
 * Shared Constants
 * 
 * Centralizes configuration values used across route modules.
 */
const path = require('path');

const PROJECT_ROOT = process.env.PROJECT_ROOT || path.resolve(process.env.USERPROFILE || process.env.HOME, 'Projects');

const ALLOWED_ORIGINS = [
    'http://localhost:3000',
    'http://localhost:4000',
    'http://localhost:8000',
    'https://nexus.vibeshiftai.com'
];

const SCAN_CACHE_TTL = 5000;   // 5 seconds
const MODELS_CACHE_TTL = 60000; // 1 minute

module.exports = {
    PROJECT_ROOT,
    ALLOWED_ORIGINS,
    SCAN_CACHE_TTL,
    MODELS_CACHE_TTL
};

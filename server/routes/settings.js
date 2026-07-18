/**
 * Settings Routes
 * 
 * GET  /api/settings/env — Read current env values
 * POST /api/settings/env — Write env values
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

/**
 * Parse a .env file into a key→value map (ignores comments and blank lines)
 */
function parseEnvFile(filePath) {
    const result = {};
    if (!fs.existsSync(filePath)) return result;
    const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) continue;
        const key = trimmed.substring(0, eqIdx).trim();
        const value = trimmed.substring(eqIdx + 1).trim();
        result[key] = value;
    }
    return result;
}

/**
 * Write key→value updates to a .env file, preserving ALL existing content.
 */
function writeEnvFile(filePath, updates, templatePath) {
    if (!fs.existsSync(filePath)) {
        if (templatePath && fs.existsSync(templatePath)) {
            fs.copyFileSync(templatePath, filePath);
        } else {
            const lines = Object.entries(updates).map(([k, v]) => `${k}=${v}`);
            fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8');
            return;
        }
    }

    const existingLines = fs.readFileSync(filePath, 'utf-8').split('\n');
    const updatedKeys = new Set();
    const outputLines = [];

    for (const line of existingLines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) {
            outputLines.push(line);
            continue;
        }
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) { outputLines.push(line); continue; }
        const key = trimmed.substring(0, eqIdx).trim();
        if (key in updates) {
            outputLines.push(`${key}=${updates[key]}`);
            updatedKeys.add(key);
        } else {
            outputLines.push(line);
        }
    }

    for (const [key, value] of Object.entries(updates)) {
        if (!updatedKeys.has(key)) {
            outputLines.push(`${key}=${value}`);
        }
    }

    fs.writeFileSync(filePath, outputLines.join('\n'), 'utf-8');
}

// Whitelist of keys the dashboard is allowed to read/write
const ENV_EDITABLE_KEYS = [
    'PROJECT_ROOT',
    'GOOGLE_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'XAI_API_KEY',
    'NEXUS_SERVICE_KEY'
];

// ─── Cross-project key rotation ─────────────────────────────────────────────
// One place to rotate a credential everywhere it appears. We scan every
// project's env files under PROJECT_ROOT, group secret-shaped keys by name,
// and rotation rewrites the SAME key in every file that already has it
// (never adds a key to a file that didn't).

const SECRET_KEY_PATTERN = /(KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIALS)/i;
const ENV_BASENAMES = ['.env', '.env.local'];
const SCAN_SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'venv', '.venv', '_archive']);

function projectRootDir() {
    return process.env.PROJECT_ROOT || '/Volumes/Projects';
}

/** Mask a secret for display: first 4 + last 4, never the middle. */
function maskSecret(value) {
    if (!value) return '';
    if (value.length <= 8) return '••••••••';
    return value.slice(0, 4) + '…' + value.slice(-4);
}

/**
 * Env files for one project: the project root and one directory level deep
 * (catches dashboard/.env.local, nexus-builder/.env — not node_modules).
 */
function findProjectEnvFiles(projectDir) {
    const found = [];
    const addFrom = (dir) => {
        for (const base of ENV_BASENAMES) {
            const p = path.join(dir, base);
            if (fs.existsSync(p) && fs.statSync(p).isFile()) found.push(p);
        }
    };
    addFrom(projectDir);
    let entries = [];
    try {
        entries = fs.readdirSync(projectDir, { withFileTypes: true });
    } catch { return found; }
    for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.') || SCAN_SKIP_DIRS.has(entry.name)) continue;
        addFrom(path.join(projectDir, entry.name));
    }
    return found;
}

/** Scan all projects → [{ name, locations: [{ project, file, masked }] }], sorted by usage. */
function scanProjectKeys() {
    const root = projectRootDir();
    const byName = new Map();
    let projects = [];
    try {
        projects = fs.readdirSync(root, { withFileTypes: true })
            .filter(e => e.isDirectory() && !e.name.startsWith('.'))
            .map(e => e.name);
    } catch { return []; }
    for (const project of projects) {
        for (const file of findProjectEnvFiles(path.join(root, project))) {
            const values = parseEnvFile(file);
            for (const [name, value] of Object.entries(values)) {
                if (!SECRET_KEY_PATTERN.test(name)) continue;
                if (!byName.has(name)) byName.set(name, []);
                byName.get(name).push({
                    project,
                    file: path.relative(root, file),
                    masked: maskSecret(value)
                });
            }
        }
    }
    return [...byName.entries()]
        .map(([name, locations]) => ({ name, locations }))
        .sort((a, b) => b.locations.length - a.locations.length || a.name.localeCompare(b.name));
}

function createSettingsRouter() {
    const router = express.Router();

    // Auto-generate NEXUS_SERVICE_KEY if missing
    (function ensureServiceKey() {
        const rootEnvPath = path.resolve(__dirname, '..', '..', '.env');
        if (!fs.existsSync(rootEnvPath)) return;
        const existing = parseEnvFile(rootEnvPath);
        if (!existing.NEXUS_SERVICE_KEY || existing.NEXUS_SERVICE_KEY.startsWith('your-')) {
            const generated = 'nxs_' + crypto.randomBytes(24).toString('hex');
            writeEnvFile(rootEnvPath, { NEXUS_SERVICE_KEY: generated });
            const pyEnvPath = path.resolve(__dirname, '..', '..', 'nexus-builder', '.env');
            writeEnvFile(pyEnvPath, { NEXUS_SERVICE_KEY: generated });
            process.env.NEXUS_SERVICE_KEY = generated;
            console.log('[Settings] 🔑 Auto-generated NEXUS_SERVICE_KEY');
        }
    })();

    // GET /api/settings/env — Read current env values (only editable keys)
    router.get('/env', (req, res) => {
        try {
            const rootEnvPath = path.resolve(__dirname, '..', '..', '.env');
            const rootValues = parseEnvFile(rootEnvPath);

            const result = {};
            for (const key of ENV_EDITABLE_KEYS) {
                result[key] = rootValues[key] || '';
            }
            res.json(result);
        } catch (error) {
            console.error('[Settings] Error reading .env:', error);
            res.status(500).json({ error: 'Failed to read environment configuration' });
        }
    });

    // POST /api/settings/env — Write env values to both root and Python .env
    router.post('/env', (req, res) => {
        try {
            const updates = req.body;

            const filtered = {};
            for (const key of ENV_EDITABLE_KEYS) {
                if (key in updates) filtered[key] = updates[key];
            }

            if (Object.keys(filtered).length === 0) {
                return res.status(400).json({ error: 'No valid keys provided' });
            }

            const rootEnvPath = path.resolve(__dirname, '..', '..', '.env');
            const rootTemplatePath = path.resolve(__dirname, '..', '..', '.env.example');
            writeEnvFile(rootEnvPath, filtered, rootTemplatePath);

            const pyEnvPath = path.resolve(__dirname, '..', '..', 'nexus-builder', '.env');
            const pyTemplatePath = path.resolve(__dirname, '..', '..', 'nexus-builder', '.env.example');
            const pySharedKeys = ['GOOGLE_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'XAI_API_KEY', 'NEXUS_SERVICE_KEY'];
            const pyFiltered = {};
            for (const key of pySharedKeys) {
                if (key in filtered) pyFiltered[key] = filtered[key];
            }
            writeEnvFile(pyEnvPath, pyFiltered, pyTemplatePath);

            console.log(`[Settings] Updated .env files (keys: ${Object.keys(filtered).join(', ')})`);
            res.json({ success: true, updated: Object.keys(filtered) });
        } catch (error) {
            console.error('[Settings] Error writing .env:', error);
            res.status(500).json({ error: 'Failed to save environment configuration' });
        }
    });

    // GET /api/settings/project-keys — every secret-shaped key across all
    // project env files, grouped by key name. Values are always masked.
    router.get('/project-keys', (req, res) => {
        try {
            res.json({ root: projectRootDir(), keys: scanProjectKeys() });
        } catch (error) {
            console.error('[Settings] Error scanning project keys:', error);
            res.status(500).json({ error: 'Failed to scan project env files' });
        }
    });

    // POST /api/settings/project-keys/rotate — write a new value for one key
    // name in every env file that already contains it (or a caller-provided
    // subset of files). Never adds the key to new files; never echoes values.
    router.post('/project-keys/rotate', (req, res) => {
        try {
            const { name, value, files } = req.body || {};
            if (typeof name !== 'string' || !name.trim() || !SECRET_KEY_PATTERN.test(name)) {
                return res.status(400).json({ error: 'name must be a secret-style env key' });
            }
            if (typeof value !== 'string' || !value.trim()) {
                return res.status(400).json({ error: 'value is required' });
            }
            if (/[\r\n]/.test(value)) {
                return res.status(400).json({ error: 'value must be a single line' });
            }
            const root = projectRootDir();
            const known = scanProjectKeys().find(k => k.name === name);
            if (!known) {
                return res.status(404).json({ error: `${name} not found in any project env file` });
            }
            // Restrict writes to files the scan itself found holding this key —
            // the client can narrow the set but never point us at a new path.
            const knownFiles = known.locations.map(l => l.file);
            const targets = Array.isArray(files) && files.length > 0
                ? knownFiles.filter(f => files.includes(f))
                : knownFiles;
            if (targets.length === 0) {
                return res.status(400).json({ error: 'No matching env files to update' });
            }
            const updated = [];
            for (const rel of targets) {
                writeEnvFile(path.join(root, rel), { [name]: value.trim() });
                updated.push(rel);
            }
            console.log(`[Settings] 🔑 Rotated ${name} in ${updated.length} file(s): ${updated.join(', ')}`);
            res.json({ success: true, name, updated });
        } catch (error) {
            console.error('[Settings] Error rotating key:', error);
            res.status(500).json({ error: 'Failed to rotate key' });
        }
    });

    return router;
}

module.exports = createSettingsRouter;

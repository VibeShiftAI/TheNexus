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

    return router;
}

module.exports = createSettingsRouter;

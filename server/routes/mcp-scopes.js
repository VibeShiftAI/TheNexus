/**
 * MCP Server Scopes API Routes
 * 
 * Manage OAuth-style scopes and permissions for MCP tool servers
 */

const express = require('express');
const router = express.Router();

let db;
try {
    db = require('../../db');
} catch (e) {
    console.log('[mcp-scopes] DB module not available');
}

// Predefined scope templates for common MCP servers
const SCOPE_TEMPLATES = {
    'github': [
        { scope_name: 'repo:read', description: 'Read repository contents', is_dangerous: false },
        { scope_name: 'repo:write', description: 'Push commits and create branches', is_dangerous: true },
        { scope_name: 'issues:read', description: 'Read issues and comments', is_dangerous: false },
        { scope_name: 'issues:write', description: 'Create and modify issues', is_dangerous: false },
        { scope_name: 'pr:read', description: 'Read pull requests', is_dangerous: false },
        { scope_name: 'pr:write', description: 'Create and merge pull requests', is_dangerous: true, requires_confirmation: true },
    ],
    'google-workspace': [
        { scope_name: 'gmail:read', description: 'Read emails', is_dangerous: false },
        { scope_name: 'gmail:send', description: 'Send emails', is_dangerous: true, requires_confirmation: true },
        { scope_name: 'calendar:read', description: 'View calendar events', is_dangerous: false },
        { scope_name: 'calendar:write', description: 'Create and modify events', is_dangerous: false },
        { scope_name: 'drive:read', description: 'Read files from Drive', is_dangerous: false },
        { scope_name: 'drive:write', description: 'Create and modify files', is_dangerous: true },
    ],
    'slack': [
        { scope_name: 'channels:read', description: 'Read channel messages', is_dangerous: false },
        { scope_name: 'channels:write', description: 'Post messages to channels', is_dangerous: false },
        { scope_name: 'dm:read', description: 'Read direct messages', is_dangerous: true },
        { scope_name: 'dm:write', description: 'Send direct messages', is_dangerous: true, requires_confirmation: true },
    ],
    'filesystem': [
        { scope_name: 'read', description: 'Read files and directories', is_dangerous: false },
        { scope_name: 'write', description: 'Create and modify files', is_dangerous: true },
        { scope_name: 'delete', description: 'Delete files and directories', is_dangerous: true, requires_confirmation: true },
    ],
    'terminal': [
        { scope_name: 'execute', description: 'Execute shell commands', is_dangerous: true, requires_confirmation: true },
    ],
};

/**
 * GET /api/mcp/:serverId/scopes
 * Get scopes for an MCP server
 */
router.get('/:serverId/scopes', async (req, res) => {
    try {
        const { serverId } = req.params;

        if (!db?.isDatabaseEnabled()) {
            // Return template scopes if no DB
            return res.json({ scopes: [], templates: SCOPE_TEMPLATES });
        }

        const allScopes = await db.getMcpScopes();
        const scopes = allScopes.filter(s => s.server_name === serverId);

        res.json({ scopes, templates: SCOPE_TEMPLATES });
    } catch (e) {
        console.error('[mcp-scopes] Error:', e);
        res.status(500).json({ error: 'Failed to fetch scopes' });
    }
});

/**
 * POST /api/mcp/:serverId/scopes
 * Add a scope to an MCP server
 */
router.post('/:serverId/scopes', async (req, res) => {
    try {
        const { serverId } = req.params;
        const { scope_name, description, is_dangerous, requires_confirmation, max_calls_per_minute, max_calls_per_hour } = req.body;

        if (!scope_name) {
            return res.status(400).json({ error: 'scope_name is required' });
        }

        if (!db?.isDatabaseEnabled()) {
            return res.status(500).json({ error: 'Database not available' });
        }

        const result = await db.upsertMcpScope({
            server_name: serverId,
            allowed_tools: [scope_name],
            is_enabled: true,
        });

        res.status(201).json(result);
    } catch (e) {
        console.error('[mcp-scopes] Error:', e);
        res.status(500).json({ error: 'Failed to add scope' });
    }
});

/**
 * POST /api/mcp/:serverId/scopes/apply-template
 * Apply a predefined scope template to a server
 */
router.post('/:serverId/scopes/apply-template', async (req, res) => {
    try {
        const { serverId } = req.params;
        const { templateName } = req.body;

        const template = SCOPE_TEMPLATES[templateName];
        if (!template) {
            return res.status(404).json({ error: `Template '${templateName}' not found` });
        }

        if (!db?.isDatabaseEnabled()) {
            return res.status(500).json({ error: 'Database not available' });
        }

        const toolNames = template.map(t => t.scope_name);
        const result = await db.upsertMcpScope({
            server_name: serverId,
            allowed_tools: toolNames,
            is_enabled: true,
        });

        res.json({ applied: toolNames.length, scopes: result });
    } catch (e) {
        console.error('[mcp-scopes] Error:', e);
        res.status(500).json({ error: 'Failed to apply template' });
    }
});

/**
 * DELETE /api/mcp/:serverId/scopes/:scopeId
 * Remove a scope
 */
router.delete('/:serverId/scopes/:scopeId', async (req, res) => {
    try {
        const { serverId } = req.params;

        if (!db?.isDatabaseEnabled()) {
            return res.status(500).json({ error: 'Database not available' });
        }

        const success = await db.deleteMcpScope(serverId);
        if (!success) {
            return res.status(500).json({ error: 'Failed to delete scope' });
        }

        res.json({ success: true });
    } catch (e) {
        console.error('[mcp-scopes] Error:', e);
        res.status(500).json({ error: 'Failed to delete scope' });
    }
});

module.exports = router;

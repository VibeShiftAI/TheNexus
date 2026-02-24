/**
 * MCP Routes (Inline version for CommonJS compatibility)
 * 
 * API endpoints for MCP server management per The Nexus Protocol.
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');

const router = express.Router();

// In-memory storage (production will use database)
const mcpServers = new Map();

// === Routes ===

/**
 * GET /api/mcp/servers
 * List all configured MCP servers
 */
router.get('/servers', (req, res) => {
    const servers = Array.from(mcpServers.values());
    res.json({ servers });
});

/**
 * POST /api/mcp/servers
 * Add a new MCP server configuration
 */
router.post('/servers', (req, res) => {
    const { id, name, description, url, transport, command, args } = req.body;

    if (!name) {
        return res.status(400).json({ error: 'Server name is required' });
    }

    const server = {
        id: id || uuidv4(),
        name,
        description,
        url: url || '',
        transport: transport || 'stdio',
        command,
        args,
        status: 'disconnected',
        capabilities: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };

    mcpServers.set(server.id, server);
    console.log(`[MCP] Added server: ${server.name} (${server.id})`);
    res.status(201).json({ server });
});

/**
 * GET /api/mcp/servers/:id
 */
router.get('/servers/:id', (req, res) => {
    const server = mcpServers.get(req.params.id);
    if (!server) {
        return res.status(404).json({ error: 'Server not found' });
    }
    res.json({ server });
});

/**
 * DELETE /api/mcp/servers/:id
 */
router.delete('/servers/:id', (req, res) => {
    const server = mcpServers.get(req.params.id);
    if (!server) {
        return res.status(404).json({ error: 'Server not found' });
    }

    mcpServers.delete(req.params.id);
    console.log(`[MCP] Removed server: ${server.name}`);
    res.json({ success: true });
});

/**
 * POST /api/mcp/servers/:id/connect
 * Connect and discover tools
 */
router.post('/servers/:id/connect', async (req, res) => {
    const server = mcpServers.get(req.params.id);
    if (!server) {
        return res.status(404).json({ error: 'Server not found' });
    }

    try {
        server.status = 'connecting';
        mcpServers.set(server.id, server);

        // Simulated tool discovery - in production use @modelcontextprotocol/sdk
        const tools = await discoverTools(server);

        server.status = 'connected';
        server.capabilities = tools;
        server.updatedAt = new Date().toISOString();
        mcpServers.set(server.id, server);

        console.log(`[MCP] Connected to ${server.name}, discovered ${tools.length} tools`);
        res.json({ success: true, tools });

    } catch (err) {
        server.status = 'error';
        server.error = err.message || 'Connection failed';
        mcpServers.set(server.id, server);

        console.error(`[MCP] Connection failed for ${server.name}:`, err);
        res.status(500).json({ error: server.error });
    }
});

/**
 * POST /api/mcp/servers/:id/disconnect
 */
router.post('/servers/:id/disconnect', (req, res) => {
    const server = mcpServers.get(req.params.id);
    if (!server) {
        return res.status(404).json({ error: 'Server not found' });
    }

    server.status = 'disconnected';
    server.updatedAt = new Date().toISOString();
    mcpServers.set(server.id, server);

    console.log(`[MCP] Disconnected from ${server.name}`);
    res.json({ success: true });
});

// === Helper: Simulated Tool Discovery ===

async function discoverTools(server) {
    const knownServerTools = {
        'github': [
            { name: 'create_issue', description: 'Create a GitHub issue' },
            { name: 'create_pull_request', description: 'Create a pull request' },
            { name: 'get_file_contents', description: 'Get file contents from repo' },
            { name: 'list_commits', description: 'List repository commits' },
            { name: 'search_code', description: 'Search code in repositories' },
        ],
        'google-workspace': [
            { name: 'send_email', description: 'Send an email via Gmail' },
            { name: 'create_calendar_event', description: 'Create a calendar event' },
            { name: 'list_drive_files', description: 'List files in Google Drive' },
            { name: 'create_document', description: 'Create a Google Doc' },
        ],
        'filesystem': [
            { name: 'read_file', description: 'Read a file from disk' },
            { name: 'write_file', description: 'Write content to a file' },
            { name: 'list_directory', description: 'List directory contents' },
            { name: 'search_files', description: 'Search for files by pattern' },
        ],
        'brave-search': [
            { name: 'web_search', description: 'Search the web via Brave' },
            { name: 'news_search', description: 'Search news articles' },
        ],
        'postgres': [
            { name: 'query', description: 'Execute a SQL query' },
            { name: 'list_tables', description: 'List database tables' },
            { name: 'describe_table', description: 'Get table schema' },
        ],
        'terminal': [
            { name: 'execute_command', description: 'Run a shell command' },
            { name: 'read_output', description: 'Read command output' },
        ],
    };

    // Match known servers
    for (const [prefix, tools] of Object.entries(knownServerTools)) {
        if (server.id.startsWith(prefix) || server.name.toLowerCase().includes(prefix)) {
            await new Promise(resolve => setTimeout(resolve, 500));
            return tools;
        }
    }

    // Default for unknown servers
    await new Promise(resolve => setTimeout(resolve, 500));
    return [
        { name: 'discover_tools', description: 'Run to see available tools' }
    ];
}

module.exports = router;

"use client"

/**
 * MCP Tool Dock - Dynamic MCP Server Discovery and Tool Binding
 * 
 * Per The Nexus Protocol, this component provides:
 * 1. MCP Server connection management
 * 2. Tool capability browsing by server
 * 3. Drag-and-drop tool binding to workflow nodes
 * 4. Community Gallery of popular MCP servers
 */

import { useState, useEffect } from "react";
import {
    Server, Plus, Unplug, Plug, Wrench, ChevronDown, ChevronRight,
    Loader2, Search, ExternalLink, GripVertical, Settings, Trash2,
    Globe, Github, Calendar, FileText, Database, Terminal, AlertCircle
} from "lucide-react";

// === Type Definitions ===

interface MCPTool {
    name: string;
    description: string;
    inputSchema?: Record<string, unknown>;
}

interface MCPServer {
    id: string;
    name: string;
    description?: string;
    url: string;
    transport: 'stdio' | 'sse';
    command?: string;
    args?: string[];
    status: 'connected' | 'disconnected' | 'connecting' | 'error';
    capabilities: MCPTool[];
    error?: string;
}

interface MCPServerPreset {
    id: string;
    name: string;
    description: string;
    icon: React.ReactNode;
    url: string;
    transport: 'stdio' | 'sse';
    command?: string;
    args?: string[];
    category: string;
}

// === Community Gallery Presets ===

const COMMUNITY_SERVERS: MCPServerPreset[] = [
    {
        id: 'github',
        name: 'GitHub',
        description: 'Repository management, PRs, issues',
        icon: <Github size={18} />,
        url: 'npx',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        category: 'DevOps'
    },
    {
        id: 'google-workspace',
        name: 'Google Workspace',
        description: 'Gmail, Calendar, Drive access',
        icon: <Calendar size={18} />,
        url: 'npx',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-google-workspace'],
        category: 'Productivity'
    },
    {
        id: 'filesystem',
        name: 'Filesystem',
        description: 'Read/write local files',
        icon: <FileText size={18} />,
        url: 'npx',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem'],
        category: 'Utility'
    },
    {
        id: 'brave-search',
        name: 'Brave Search',
        description: 'Web search with Brave API',
        icon: <Search size={18} />,
        url: 'npx',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-brave-search'],
        category: 'Research'
    },
    {
        id: 'postgres',
        name: 'PostgreSQL',
        description: 'Database queries and schema',
        icon: <Database size={18} />,
        url: 'npx',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-postgres'],
        category: 'Data'
    },
    {
        id: 'terminal',
        name: 'Terminal',
        description: 'Execute shell commands',
        icon: <Terminal size={18} />,
        url: 'npx',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@anthropic/mcp-server-terminal'],
        category: 'DevOps'
    },
];

// === Sub-Components ===

function ServerCard({
    server,
    expanded,
    onToggle,
    onConnect,
    onDisconnect,
    onRemove,
    onToolDragStart
}: {
    server: MCPServer;
    expanded: boolean;
    onToggle: () => void;
    onConnect: () => void;
    onDisconnect: () => void;
    onRemove: () => void;
    onToolDragStart: (tool: MCPTool, server: MCPServer, event: React.DragEvent) => void;
}) {
    const statusColors = {
        connected: 'bg-emerald-500',
        disconnected: 'bg-slate-500',
        connecting: 'bg-amber-500 animate-pulse',
        error: 'bg-red-500'
    };

    return (
        <div className="rounded-lg border border-slate-700 bg-slate-900/50 overflow-hidden">
            {/* Server Header */}
            <div
                className="flex items-center justify-between px-3 py-2.5 cursor-pointer hover:bg-slate-800/50 transition-colors"
                onClick={onToggle}
            >
                <div className="flex items-center gap-2.5">
                    <div className={`w-2 h-2 rounded-full ${statusColors[server.status]}`} />
                    <Server size={16} className="text-slate-400" />
                    <span className="text-sm font-medium text-white truncate max-w-[120px]">
                        {server.name}
                    </span>
                </div>
                <div className="flex items-center gap-1">
                    <span className="text-xs text-slate-500">
                        {server.capabilities.length} tools
                    </span>
                    {expanded ? (
                        <ChevronDown size={14} className="text-slate-400" />
                    ) : (
                        <ChevronRight size={14} className="text-slate-400" />
                    )}
                </div>
            </div>

            {/* Expanded Content */}
            {expanded && (
                <div className="border-t border-slate-700/50">
                    {/* Server Controls */}
                    <div className="flex items-center justify-between px-3 py-2 bg-slate-800/30">
                        <div className="flex items-center gap-1">
                            {server.status === 'connected' ? (
                                <button
                                    onClick={(e) => { e.stopPropagation(); onDisconnect(); }}
                                    className="p-1.5 rounded text-amber-400 hover:bg-amber-500/20 transition-colors"
                                    title="Disconnect"
                                >
                                    <Unplug size={14} />
                                </button>
                            ) : server.status === 'connecting' ? (
                                <Loader2 size={14} className="animate-spin text-amber-400 mx-1.5" />
                            ) : (
                                <button
                                    onClick={(e) => { e.stopPropagation(); onConnect(); }}
                                    className="p-1.5 rounded text-emerald-400 hover:bg-emerald-500/20 transition-colors"
                                    title="Connect"
                                >
                                    <Plug size={14} />
                                </button>
                            )}
                        </div>
                        <button
                            onClick={(e) => { e.stopPropagation(); onRemove(); }}
                            className="p-1.5 rounded text-red-400 hover:bg-red-500/20 transition-colors"
                            title="Remove server"
                        >
                            <Trash2 size={14} />
                        </button>
                    </div>

                    {/* Error Message */}
                    {server.error && (
                        <div className="px-3 py-2 bg-red-500/10 border-t border-red-500/30 flex items-center gap-2">
                            <AlertCircle size={12} className="text-red-400 flex-shrink-0" />
                            <span className="text-xs text-red-400 truncate">{server.error}</span>
                        </div>
                    )}

                    {/* Tool List */}
                    {server.capabilities.length > 0 ? (
                        <div className="px-2 py-2 space-y-1 max-h-[200px] overflow-y-auto">
                            {server.capabilities.map((tool) => (
                                <div
                                    key={tool.name}
                                    draggable
                                    onDragStart={(e) => onToolDragStart(tool, server, e)}
                                    className="flex items-center gap-2 px-2 py-1.5 rounded bg-slate-800/50 hover:bg-indigo-500/20 hover:border-indigo-500/50 border border-transparent cursor-grab transition-all group"
                                >
                                    <GripVertical size={12} className="text-slate-600 group-hover:text-indigo-400" />
                                    <Wrench size={12} className="text-slate-500 group-hover:text-indigo-400" />
                                    <div className="flex-1 min-w-0">
                                        <p className="text-xs text-white truncate">{tool.name}</p>
                                        {tool.description && (
                                            <p className="text-[10px] text-slate-500 truncate">{tool.description}</p>
                                        )}
                                    </div>
                                </div>
                            ))}
                        </div>
                    ) : server.status === 'connected' ? (
                        <div className="px-3 py-4 text-center text-xs text-slate-500">
                            No tools available
                        </div>
                    ) : (
                        <div className="px-3 py-4 text-center text-xs text-slate-500">
                            Connect to discover tools
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

function AddServerModal({
    isOpen,
    onClose,
    onAdd
}: {
    isOpen: boolean;
    onClose: () => void;
    onAdd: (server: Partial<MCPServer>) => void;
}) {
    const [tab, setTab] = useState<'gallery' | 'custom'>('gallery');
    const [customName, setCustomName] = useState('');
    const [customUrl, setCustomUrl] = useState('');
    const [customTransport, setCustomTransport] = useState<'stdio' | 'sse'>('stdio');
    const [customCommand, setCustomCommand] = useState('');
    const [filterCategory, setFilterCategory] = useState<string>('all');

    if (!isOpen) return null;

    const categories = ['all', ...new Set(COMMUNITY_SERVERS.map(s => s.category))];
    const filteredServers = filterCategory === 'all'
        ? COMMUNITY_SERVERS
        : COMMUNITY_SERVERS.filter(s => s.category === filterCategory);

    const handleAddPreset = (preset: MCPServerPreset) => {
        onAdd({
            id: `${preset.id}-${Date.now()}`,
            name: preset.name,
            description: preset.description,
            url: preset.url,
            transport: preset.transport,
            command: preset.command,
            args: preset.args,
            status: 'disconnected',
            capabilities: []
        });
        onClose();
    };

    const handleAddCustom = () => {
        if (!customName) return;
        onAdd({
            id: `custom-${Date.now()}`,
            name: customName,
            url: customUrl,
            transport: customTransport,
            command: customTransport === 'stdio' ? customCommand : undefined,
            status: 'disconnected',
            capabilities: []
        });
        onClose();
    };

    return (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
            <div className="bg-slate-900 border border-slate-700 rounded-xl w-[500px] max-h-[80vh] overflow-hidden shadow-2xl">
                {/* Header */}
                <div className="px-5 py-4 border-b border-slate-700">
                    <h3 className="text-lg font-semibold text-white">Add MCP Server</h3>
                    <p className="text-sm text-slate-400 mt-1">Connect to tools via Model Context Protocol</p>
                </div>

                {/* Tabs */}
                <div className="flex border-b border-slate-700">
                    <button
                        onClick={() => setTab('gallery')}
                        className={`flex-1 px-4 py-2.5 text-sm font-medium transition-colors ${tab === 'gallery'
                            ? 'text-indigo-400 border-b-2 border-indigo-500 bg-indigo-500/10'
                            : 'text-slate-400 hover:text-white hover:bg-slate-800'
                            }`}
                    >
                        <Globe size={14} className="inline mr-2" />
                        Community Gallery
                    </button>
                    <button
                        onClick={() => setTab('custom')}
                        className={`flex-1 px-4 py-2.5 text-sm font-medium transition-colors ${tab === 'custom'
                            ? 'text-indigo-400 border-b-2 border-indigo-500 bg-indigo-500/10'
                            : 'text-slate-400 hover:text-white hover:bg-slate-800'
                            }`}
                    >
                        <Settings size={14} className="inline mr-2" />
                        Custom Server
                    </button>
                </div>

                {/* Content */}
                <div className="p-4 max-h-[400px] overflow-y-auto">
                    {tab === 'gallery' ? (
                        <div>
                            {/* Category Filter */}
                            <div className="flex gap-2 mb-4 flex-wrap">
                                {categories.map(cat => (
                                    <button
                                        key={cat}
                                        onClick={() => setFilterCategory(cat)}
                                        className={`px-3 py-1 text-xs rounded-full transition-colors ${filterCategory === cat
                                            ? 'bg-indigo-500 text-white'
                                            : 'bg-slate-800 text-slate-400 hover:text-white'
                                            }`}
                                    >
                                        {cat.charAt(0).toUpperCase() + cat.slice(1)}
                                    </button>
                                ))}
                            </div>

                            {/* Server Grid */}
                            <div className="grid grid-cols-2 gap-3">
                                {filteredServers.map(preset => (
                                    <button
                                        key={preset.id}
                                        onClick={() => handleAddPreset(preset)}
                                        className="flex items-start gap-3 p-3 rounded-lg bg-slate-800/50 border border-slate-700 hover:border-indigo-500/50 hover:bg-indigo-500/10 transition-all text-left group"
                                    >
                                        <div className="p-2 rounded-lg bg-slate-700/50 text-slate-400 group-hover:text-indigo-400 group-hover:bg-indigo-500/20 transition-colors">
                                            {preset.icon}
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <h4 className="text-sm font-medium text-white">{preset.name}</h4>
                                            <p className="text-xs text-slate-500 mt-0.5 line-clamp-2">{preset.description}</p>
                                        </div>
                                    </button>
                                ))}
                            </div>
                        </div>
                    ) : (
                        <div className="space-y-4">
                            <div>
                                <label className="block text-sm text-slate-400 mb-1.5">Server Name</label>
                                <input
                                    type="text"
                                    value={customName}
                                    onChange={(e) => setCustomName(e.target.value)}
                                    placeholder="My MCP Server"
                                    className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
                                />
                            </div>

                            <div>
                                <label className="block text-sm text-slate-400 mb-1.5">Transport</label>
                                <select
                                    value={customTransport}
                                    onChange={(e) => setCustomTransport(e.target.value as 'stdio' | 'sse')}
                                    className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white focus:border-indigo-500 focus:outline-none"
                                >
                                    <option value="stdio">Stdio (Local Process)</option>
                                    <option value="sse">SSE (Remote Server)</option>
                                </select>
                            </div>

                            {customTransport === 'stdio' ? (
                                <div>
                                    <label className="block text-sm text-slate-400 mb-1.5">Command</label>
                                    <input
                                        type="text"
                                        value={customCommand}
                                        onChange={(e) => setCustomCommand(e.target.value)}
                                        placeholder="npx -y @org/mcp-server"
                                        className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none font-mono text-sm"
                                    />
                                </div>
                            ) : (
                                <div>
                                    <label className="block text-sm text-slate-400 mb-1.5">Server URL</label>
                                    <input
                                        type="text"
                                        value={customUrl}
                                        onChange={(e) => setCustomUrl(e.target.value)}
                                        placeholder="https://mcp.example.com/sse"
                                        className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
                                    />
                                </div>
                            )}
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div className="flex justify-end gap-3 px-5 py-4 border-t border-slate-700 bg-slate-800/30">
                    <button
                        onClick={onClose}
                        className="px-4 py-2 text-sm text-slate-400 hover:text-white transition-colors"
                    >
                        Cancel
                    </button>
                    {tab === 'custom' && (
                        <button
                            onClick={handleAddCustom}
                            disabled={!customName}
                            className="px-4 py-2 text-sm bg-indigo-500 text-white rounded-lg hover:bg-indigo-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                        >
                            Add Server
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}

// === Main Component ===

interface ToolDockProps {
    onToolSelect?: (tool: MCPTool, server: MCPServer) => void;
    className?: string;
}

export function ToolDock({ onToolSelect, className = '' }: ToolDockProps) {
    const [servers, setServers] = useState<MCPServer[]>([]);
    const [expandedServers, setExpandedServers] = useState<Set<string>>(new Set());
    const [showAddModal, setShowAddModal] = useState(false);
    const [loading, setLoading] = useState(true);
    const [searchQuery, setSearchQuery] = useState('');

    // Load saved servers on mount
    useEffect(() => {
        async function loadServers() {
            try {
                const response = await fetch('/api/mcp/servers');
                if (response.ok) {
                    const data = await response.json();
                    setServers(data.servers || []);
                }
            } catch (err) {
                console.log('[ToolDock] Using empty server list (API unavailable)');
            } finally {
                setLoading(false);
            }
        }
        loadServers();
    }, []);

    const toggleServer = (serverId: string) => {
        setExpandedServers(prev => {
            const next = new Set(prev);
            if (next.has(serverId)) {
                next.delete(serverId);
            } else {
                next.add(serverId);
            }
            return next;
        });
    };

    const addServer = async (serverData: Partial<MCPServer>) => {
        const newServer: MCPServer = {
            id: serverData.id || `server-${Date.now()}`,
            name: serverData.name || 'New Server',
            description: serverData.description,
            url: serverData.url || '',
            transport: serverData.transport || 'stdio',
            command: serverData.command,
            args: serverData.args,
            status: 'disconnected',
            capabilities: []
        };

        setServers(prev => [...prev, newServer]);
        setExpandedServers(prev => new Set(prev).add(newServer.id));

        // Persist to backend
        try {
            await fetch('/api/mcp/servers', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(newServer)
            });
        } catch (err) {
            console.error('[ToolDock] Failed to save server:', err);
        }
    };

    const connectServer = async (serverId: string) => {
        setServers(prev => prev.map(s =>
            s.id === serverId ? { ...s, status: 'connecting' as const, error: undefined } : s
        ));

        try {
            const response = await fetch(`/api/mcp/servers/${serverId}/connect`, {
                method: 'POST'
            });

            if (response.ok) {
                const data = await response.json();
                setServers(prev => prev.map(s =>
                    s.id === serverId
                        ? { ...s, status: 'connected' as const, capabilities: data.tools || [] }
                        : s
                ));
            } else {
                const error = await response.text();
                setServers(prev => prev.map(s =>
                    s.id === serverId
                        ? { ...s, status: 'error' as const, error }
                        : s
                ));
            }
        } catch (err) {
            setServers(prev => prev.map(s =>
                s.id === serverId
                    ? { ...s, status: 'error' as const, error: 'Connection failed' }
                    : s
            ));
        }
    };

    const disconnectServer = async (serverId: string) => {
        try {
            await fetch(`/api/mcp/servers/${serverId}/disconnect`, { method: 'POST' });
        } catch (err) {
            console.error('[ToolDock] Disconnect error:', err);
        }
        setServers(prev => prev.map(s =>
            s.id === serverId ? { ...s, status: 'disconnected' as const } : s
        ));
    };

    const removeServer = async (serverId: string) => {
        try {
            await fetch(`/api/mcp/servers/${serverId}`, { method: 'DELETE' });
        } catch (err) {
            console.error('[ToolDock] Remove error:', err);
        }
        setServers(prev => prev.filter(s => s.id !== serverId));
    };

    // TODO: Phase 2 - Tool Drag-to-Node Binding (Test 2.5)
    // When dragging a tool onto a workflow node:
    // 1. Accept the drop on the node (need onDrop handler in workflow-builder)
    // 2. Bind the tool to the node's configuration (store in node.data.tools[])
    // 3. Highlight compatible nodes during drag (nodes with 'tools' property)
    // 4. Persist tool bindings when saving template
    // 5. Execute bound tools during node execution in Python backend
    const handleToolDragStart = (tool: MCPTool, server: MCPServer, event: React.DragEvent) => {
        // Set drag data for workflow builder to consume
        event.dataTransfer.setData('application/mcp-tool', JSON.stringify({
            tool,
            server: { id: server.id, name: server.name }
        }));
        event.dataTransfer.effectAllowed = 'copy';
    };

    // Filter servers/tools by search query
    const filteredServers = servers.filter(server => {
        if (!searchQuery) return true;
        const query = searchQuery.toLowerCase();
        if (server.name.toLowerCase().includes(query)) return true;
        return server.capabilities.some(t => t.name.toLowerCase().includes(query));
    });

    return (
        <div className={`flex flex-col h-full bg-slate-900/50 border-l border-slate-700 ${className}`}>
            {/* Header */}
            <div className="px-3 py-3 border-b border-slate-700">
                <div className="flex items-center justify-between mb-3">
                    <h4 className="text-sm font-semibold text-white flex items-center gap-2">
                        <Wrench size={14} className="text-indigo-400" />
                        Tool Dock
                    </h4>
                    <button
                        onClick={() => setShowAddModal(true)}
                        className="p-1.5 rounded-lg bg-indigo-500/20 text-indigo-400 hover:bg-indigo-500/30 transition-colors"
                        title="Add MCP Server"
                    >
                        <Plus size={14} />
                    </button>
                </div>

                {/* Search */}
                <div className="relative">
                    <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
                    <input
                        type="text"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder="Search tools..."
                        className="w-full pl-8 pr-3 py-1.5 text-xs rounded-lg bg-slate-800 border border-slate-600 text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
                    />
                </div>
            </div>

            {/* Server List */}
            <div className="flex-1 overflow-y-auto p-2 space-y-2">
                {loading ? (
                    <div className="flex items-center justify-center py-8">
                        <Loader2 size={20} className="animate-spin text-slate-500" />
                    </div>
                ) : filteredServers.length === 0 ? (
                    <div className="text-center py-8">
                        <Server size={24} className="mx-auto text-slate-600 mb-2" />
                        <p className="text-xs text-slate-500">No MCP servers</p>
                        <button
                            onClick={() => setShowAddModal(true)}
                            className="mt-2 text-xs text-indigo-400 hover:text-indigo-300"
                        >
                            + Add your first server
                        </button>
                    </div>
                ) : (
                    filteredServers.map(server => (
                        <ServerCard
                            key={server.id}
                            server={server}
                            expanded={expandedServers.has(server.id)}
                            onToggle={() => toggleServer(server.id)}
                            onConnect={() => connectServer(server.id)}
                            onDisconnect={() => disconnectServer(server.id)}
                            onRemove={() => removeServer(server.id)}
                            onToolDragStart={handleToolDragStart}
                        />
                    ))
                )}
            </div>

            {/* Footer hint */}
            <div className="px-3 py-2 border-t border-slate-700 bg-slate-800/50">
                <p className="text-[10px] text-slate-500 text-center">
                    Drag tools onto workflow nodes
                </p>
            </div>

            {/* Add Server Modal */}
            <AddServerModal
                isOpen={showAddModal}
                onClose={() => setShowAddModal(false)}
                onAdd={addServer}
            />
        </div>
    );
}

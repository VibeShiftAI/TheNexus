"use client";

/**
 * Agent Registry - Read-Only Atomic Node Viewer (Table View)
 * 
 * Displays all built-in agents in a table with category groupings.
 * Shows descriptions, node types, and workflow usage.
 */

import { useEffect, useState, useMemo } from "react";
import {
    Brain, Search, Loader2, AlertCircle,
    Layers, Zap, Shield, GitBranch, Activity,
} from "lucide-react";

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

interface AtomicAgent {
    id: string;
    name: string;
    description: string;
    category: string;
    icon: string;
    node_type: string;
    isSystem?: boolean;
    source?: string;
    version?: number;
    source_file?: string;
}


interface AgentsResponse {
    agents: Record<string, AtomicAgent>;
    error?: string;
    source?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// CATEGORY CONFIG
// ═══════════════════════════════════════════════════════════════════════════


const CATEGORY_CONFIG: Record<string, { label: string; color: string; bgColor: string; icon: React.ReactNode }> = {
    orchestration: {
        label: "Orchestration",
        color: "text-indigo-400",
        bgColor: "bg-indigo-500/20",
        icon: <Brain className="w-4 h-4" />
    },
    planning: {
        label: "Planning",
        color: "text-purple-400",
        bgColor: "bg-purple-500/20",
        icon: <Layers className="w-4 h-4" />
    },
    review: {
        label: "Review",
        color: "text-emerald-400",
        bgColor: "bg-emerald-500/20",
        icon: <Shield className="w-4 h-4" />
    },
    research: {
        label: "Research",
        color: "text-cyan-400",
        bgColor: "bg-cyan-500/20",
        icon: <Search className="w-4 h-4" />
    },
    utility: {
        label: "Utility",
        color: "text-slate-400",
        bgColor: "bg-slate-500/20",
        icon: <GitBranch className="w-4 h-4" />
    },
};

// Category display order
const CATEGORY_ORDER = [
    "orchestration",
    "planning",
    "review",
    "research",
    "utility",
];

// Map Font Awesome icon names to emojis
const FA_ICON_MAP: Record<string, string> = {
    "fa:database": "🗄️",
    "fa:brain": "🧠",
    "fa:search": "🔍",
    "fa:cogs": "⚙️",
    "fa:code": "💻",
    "fa:check": "✅",
    "fa:tasks": "📋",
    "fa:robot": "🤖",
    "fa:network": "🌐",
    "fa:folder": "📁",
    "fa:file": "📄",
    "fa:memory": "💾",
    "fa:git": "📦",
    "fa:sitemap": "🗺️",
};

// Node type badge configuration
const NODE_TYPE_CONFIG: Record<string, { label: string; color: string; bgColor: string }> = {
    orchestrator: {
        label: "Orchestrator",
        color: "text-purple-300",
        bgColor: "bg-purple-500/20 border-purple-500/30"
    },
    planner: {
        label: "Planner",
        color: "text-amber-300",
        bgColor: "bg-amber-500/20 border-amber-500/30"
    },
    voter: {
        label: "Reviewer",
        color: "text-emerald-300",
        bgColor: "bg-emerald-500/20 border-emerald-500/30"
    },
    utility: {
        label: "Utility",
        color: "text-slate-300",
        bgColor: "bg-slate-500/20 border-slate-500/30"
    },
    fleet: {
        label: "Fleet",
        color: "text-blue-300",
        bgColor: "bg-blue-500/20 border-blue-500/30"
    },
    atomic: {
        label: "Atomic",
        color: "text-cyan-300",
        bgColor: "bg-cyan-500/20 border-cyan-500/30"
    },
};

// Helper function to resolve icon strings
function resolveIcon(icon: string): string {
    if (!icon) return "🤖";
    // If it starts with "fa:", map it to emoji
    if (icon.startsWith("fa:")) {
        return FA_ICON_MAP[icon] || "🤖";
    }
    // Otherwise return as-is (already an emoji)
    return icon;
}

// ═══════════════════════════════════════════════════════════════════════════
// TYPES FOR WORKFLOW TEMPLATES
// ═══════════════════════════════════════════════════════════════════════════

interface WorkflowTemplateNode {
    type?: string;
    data?: { type?: string };
}

interface WorkflowTemplate {
    id: string;
    name: string;
    nodes?: WorkflowTemplateNode[];
}

interface TemplatesResponse {
    templates: WorkflowTemplate[];
    error?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════════════

export function AgentManager() {
    const [agents, setAgents] = useState<AtomicAgent[]>([]);
    const [workflowUsage, setWorkflowUsage] = useState<Record<string, string[]>>({});
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [searchQuery, setSearchQuery] = useState("");
    const [selectedCategory, setSelectedCategory] = useState<string | null>(null);

    // Fetch agents and workflow templates on mount
    useEffect(() => {
        async function fetchData() {
            try {
                // Fetch agents
                const res = await fetch("/api/agents");
                const data: AgentsResponse = await res.json();

                if (!res.ok || data.error) {
                    setError(data.error || `Failed to fetch agents: ${res.status}`);
                } else {
                    const agentList = Object.values(data.agents || {});
                    setAgents(agentList);
                }

                // Fetch workflow templates to calculate usage
                try {
                    const templatesRes = await fetch("/api/langgraph/templates");
                    if (templatesRes.ok) {
                        const templatesData: TemplatesResponse = await templatesRes.json();
                        const usage: Record<string, string[]> = {};

                        // Parse each template to find which nodes it uses
                        for (const template of templatesData.templates || []) {
                            for (const node of template.nodes || []) {
                                // Node type can be in node.type or node.data.type
                                const nodeType = node.type || node.data?.type;
                                if (nodeType) {
                                    if (!usage[nodeType]) usage[nodeType] = [];
                                    if (!usage[nodeType].includes(template.name)) {
                                        usage[nodeType].push(template.name);
                                    }
                                }
                            }
                        }
                        setWorkflowUsage(usage);
                    }
                } catch {
                    // Templates endpoint may fail, that's okay - usage will be empty
                    console.log('[AgentManager] Could not fetch workflow templates');
                }
            } catch (err) {
                setError("Network error - ensure Python backend is running");
            } finally {
                setLoading(false);
            }
        }

        fetchData();
    }, []);


    // Filter agents
    const filteredAgents = useMemo(() => {
        return agents.filter(agent => {
            const name = agent.name || '';
            const desc = agent.description || '';
            const matchesSearch =
                name.toLowerCase().includes(searchQuery.toLowerCase()) ||
                desc.toLowerCase().includes(searchQuery.toLowerCase()) ||
                agent.id?.toLowerCase().includes(searchQuery.toLowerCase());
            const matchesCategory = !selectedCategory || agent.category === selectedCategory;
            return matchesSearch && matchesCategory;
        });
    }, [agents, searchQuery, selectedCategory]);

    // Group by category with custom order
    const categories = useMemo(() => {
        const cats = new Map<string, AtomicAgent[]>();

        // Initialize in order
        CATEGORY_ORDER.forEach(cat => {
            const matching = filteredAgents.filter(a => a.category === cat);
            if (matching.length > 0) {
                cats.set(cat, matching);
            }
        });

        // Add any categories not in the order
        filteredAgents.forEach(agent => {
            if (!cats.has(agent.category)) {
                const list = cats.get(agent.category) || [];
                list.push(agent);
                cats.set(agent.category, list);
            }
        });

        return cats;
    }, [filteredAgents]);

    // Get unique categories for filter
    const availableCategories = useMemo(() => {
        const cats = [...new Set(agents.map(a => a.category))];
        return cats.sort((a, b) => {
            const aIdx = CATEGORY_ORDER.indexOf(a);
            const bIdx = CATEGORY_ORDER.indexOf(b);
            if (aIdx === -1 && bIdx === -1) return a.localeCompare(b);
            if (aIdx === -1) return 1;
            if (bIdx === -1) return -1;
            return aIdx - bIdx;
        });
    }, [agents]);

    return (
        <div className="bg-slate-900/50 rounded-2xl border border-slate-800 p-6">
            {/* Header */}
            <div className="flex items-center justify-between mb-6">
                <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-purple-500 to-indigo-600 flex items-center justify-center">
                        <Brain className="w-5 h-5 text-white" />
                    </div>
                    <div>
                        <h2 className="text-xl font-bold text-white">Agent Registry</h2>
                        <p className="text-sm text-slate-400">
                            {agents.length} registered agents
                        </p>
                    </div>
                </div>
            </div>

            {/* Search & Filters */}
            <div className="flex gap-4 mb-6">
                <div className="flex-1 relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                    <input
                        type="text"
                        placeholder="Search agents by name, description, or ID..."
                        value={searchQuery}
                        onChange={e => setSearchQuery(e.target.value)}
                        className="w-full pl-10 pr-4 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-purple-500/50"
                    />
                </div>

                <select
                    value={selectedCategory || ""}
                    onChange={e => setSelectedCategory(e.target.value || null)}
                    className="px-4 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-purple-500/50"
                >
                    <option value="">All Categories</option>
                    {availableCategories.map(cat => (
                        <option key={cat} value={cat}>
                            {CATEGORY_CONFIG[cat]?.label || cat}
                        </option>
                    ))}
                </select>
            </div>

            {/* Loading State */}
            {loading && (
                <div className="flex items-center justify-center py-12">
                    <Loader2 className="w-8 h-8 animate-spin text-purple-500" />
                </div>
            )}

            {/* Error State */}
            {error && (
                <div className="flex items-center gap-3 p-4 bg-red-500/20 border border-red-500/30 rounded-lg">
                    <AlertCircle className="w-5 h-5 text-red-500" />
                    <span className="text-red-400">{error}</span>
                </div>
            )}

            {/* Agent Tables by Category */}
            {!loading && !error && (
                <div className="space-y-8">
                    {[...categories.entries()].map(([category, categoryAgents]) => {
                        const config = CATEGORY_CONFIG[category] || CATEGORY_CONFIG.utility;

                        return (
                            <div key={category}>
                                {/* Category Header */}
                                <div className="flex items-center gap-2 mb-3">
                                    <span className={`w-7 h-7 rounded-lg ${config.bgColor} ${config.color} flex items-center justify-center`}>
                                        {config.icon}
                                    </span>
                                    <h3 className={`font-semibold ${config.color}`}>
                                        {config.label}
                                    </h3>
                                    <span className="text-sm text-slate-500">
                                        ({categoryAgents.length})
                                    </span>
                                </div>

                                {/* Table */}
                                <div className="overflow-hidden rounded-lg border border-slate-700/50">
                                    <table className="w-full">
                                        <thead className="bg-slate-800/50">
                                            <tr>
                                                <th className="px-4 py-3 text-left text-xs font-medium text-slate-400 uppercase tracking-wider w-48">
                                                    Agent
                                                </th>
                                                <th className="px-4 py-3 text-left text-xs font-medium text-slate-400 uppercase tracking-wider w-28">
                                                    Type
                                                </th>
                                                <th className="px-4 py-3 text-left text-xs font-medium text-slate-400 uppercase tracking-wider">
                                                    Description
                                                </th>
                                                <th className="px-4 py-3 text-left text-xs font-medium text-slate-400 uppercase tracking-wider w-40">
                                                    Used In
                                                </th>
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y divide-slate-700/30">
                                            {categoryAgents.map(agent => (
                                                <tr key={agent.id} className="hover:bg-slate-800/30 transition-colors">
                                                    <td className="px-4 py-3">
                                                        <div className="flex items-center gap-2">
                                                            <span className="text-xl">{resolveIcon(agent.icon)}</span>
                                                            <div>
                                                                <div className="font-medium text-white">{agent.name}</div>
                                                                <div className="text-xs text-slate-500 font-mono">{agent.id}</div>
                                                            </div>
                                                        </div>
                                                    </td>
                                                    <td className="px-4 py-3">
                                                        {(() => {
                                                            const typeConfig = NODE_TYPE_CONFIG[agent.node_type] || NODE_TYPE_CONFIG.utility;
                                                            return (
                                                                <span className={`inline-flex px-2 py-0.5 text-xs font-medium rounded-full border ${typeConfig.bgColor} ${typeConfig.color}`}>
                                                                    {typeConfig.label}
                                                                </span>
                                                            );
                                                        })()}
                                                    </td>
                                                    <td className="px-4 py-3">
                                                        <p className="text-sm text-slate-300 leading-relaxed">
                                                            {agent.description}
                                                        </p>
                                                    </td>
                                                    <td className="px-4 py-3">
                                                        {workflowUsage[agent.id]?.length > 0 ? (
                                                            <div className="flex flex-wrap gap-1">
                                                                {workflowUsage[agent.id].map((wf: string) => (
                                                                    <span
                                                                        key={wf}
                                                                        className="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-full bg-purple-500/20 text-purple-300"
                                                                    >
                                                                        <Activity className="w-3 h-3" />
                                                                        {wf}
                                                                    </span>
                                                                ))}
                                                            </div>
                                                        ) : (
                                                            <span className="text-xs text-slate-500">—</span>
                                                        )}
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        );
                    })}

                    {filteredAgents.length === 0 && (
                        <div className="text-center py-12 text-slate-500">
                            No agents match your search.
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

export default AgentManager;

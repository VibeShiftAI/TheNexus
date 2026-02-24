"use client"

import { useState, useEffect, useCallback } from "react";
import {
    Brain,
    BookOpen,
    Shield,
    Plus,
    Trash2,
    ToggleLeft,
    ToggleRight,
    RefreshCw,
    AlertCircle,
    CheckCircle,
    Sparkles
} from "lucide-react";
import {
    getMemoryPreferences,
    getMemoryRules,
    addMemoryRule,
    deleteMemoryRule,
    toggleMemoryRule,
    deleteMemoryPreference,
    getMemoryStats,
    getMemoryContext,
    MemoryPreference,
    MemoryRule,
    MemoryStats
} from "@/lib/nexus";

interface MemoryManagerProps {
    projectId?: string;
}

export function MemoryManager({ projectId }: MemoryManagerProps) {
    const [activeTab, setActiveTab] = useState<'preferences' | 'rules' | 'context'>('preferences');
    const [preferences, setPreferences] = useState<Record<string, Record<string, MemoryPreference>>>({});
    const [rules, setRules] = useState<MemoryRule[]>([]);
    const [stats, setStats] = useState<MemoryStats | null>(null);
    const [context, setContext] = useState<string>('');
    const [newRule, setNewRule] = useState('');
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const loadData = useCallback(async () => {
        setIsLoading(true);
        setError(null);
        try {
            const [prefsData, rulesData, statsData] = await Promise.all([
                getMemoryPreferences(),
                getMemoryRules(),
                getMemoryStats()
            ]);
            setPreferences(prefsData);
            setRules(rulesData);
            setStats(statsData);
        } catch (err) {
            console.error('Failed to load memory data:', err);
            setError('Failed to load memory data. Make sure the server is running.');
        } finally {
            setIsLoading(false);
        }
    }, []);

    const loadContext = useCallback(async () => {
        try {
            const ctx = await getMemoryContext();
            setContext(ctx);
        } catch (err) {
            console.error('Failed to load context:', err);
        }
    }, []);

    useEffect(() => {
        loadData();
    }, [loadData]);

    useEffect(() => {
        if (activeTab === 'context') {
            loadContext();
        }
    }, [activeTab, loadContext]);

    const handleAddRule = async () => {
        if (!newRule.trim()) return;
        try {
            await addMemoryRule(newRule.trim());
            setNewRule('');
            loadData();
        } catch (err) {
            console.error('Failed to add rule:', err);
        }
    };

    const handleDeleteRule = async (id: string) => {
        try {
            await deleteMemoryRule(id);
            loadData();
        } catch (err) {
            console.error('Failed to delete rule:', err);
        }
    };

    const handleToggleRule = async (id: string, currentEnabled: boolean) => {
        try {
            await toggleMemoryRule(id, !currentEnabled);
            loadData();
        } catch (err) {
            console.error('Failed to toggle rule:', err);
        }
    };

    const handleDeletePreference = async (category: string, key: string) => {
        try {
            await deleteMemoryPreference(category, key);
            loadData();
        } catch (err) {
            console.error('Failed to delete preference:', err);
        }
    };

    const getConfidenceColor = (confidence: number) => {
        if (confidence >= 0.8) return 'text-green-400';
        if (confidence >= 0.5) return 'text-yellow-400';
        return 'text-red-400';
    };

    const getSourceBadge = (source: string) => {
        switch (source) {
            case 'user-explicit':
                return <span className="px-2 py-0.5 text-xs rounded-full bg-purple-500/20 text-purple-400">User Set</span>;
            case 'project-detected':
                return <span className="px-2 py-0.5 text-xs rounded-full bg-blue-500/20 text-blue-400">From Project</span>;
            default:
                return <span className="px-2 py-0.5 text-xs rounded-full bg-gray-500/20 text-gray-400">Inferred</span>;
        }
    };

    if (isLoading) {
        return (
            <div className="flex items-center justify-center h-64">
                <RefreshCw className="w-8 h-8 animate-spin text-purple-400" />
            </div>
        );
    }

    if (error) {
        return (
            <div className="flex flex-col items-center justify-center h-64 gap-4">
                <AlertCircle className="w-12 h-12 text-red-400" />
                <p className="text-red-400">{error}</p>
                <button
                    onClick={loadData}
                    className="px-4 py-2 bg-purple-600 hover:bg-purple-700 rounded-lg flex items-center gap-2"
                >
                    <RefreshCw className="w-4 h-4" />
                    Retry
                </button>
            </div>
        );
    }

    return (
        <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
            {/* Header */}
            <div className="p-4 border-b border-gray-800 flex items-center justify-between">
                <div className="flex items-center gap-3">
                    <div className="p-2 bg-purple-500/20 rounded-lg">
                        <Brain className="w-5 h-5 text-purple-400" />
                    </div>
                    <div>
                        <h2 className="font-semibold text-white">Global Context Memory</h2>
                        <p className="text-sm text-gray-400">
                            {stats ? `${stats.preferenceCount} preferences • ${stats.ruleCount} rules` : 'Loading...'}
                        </p>
                    </div>
                </div>
                <button
                    onClick={loadData}
                    className="p-2 hover:bg-gray-800 rounded-lg transition-colors"
                    title="Refresh"
                >
                    <RefreshCw className="w-4 h-4 text-gray-400" />
                </button>
            </div>

            {/* Tabs */}
            <div className="flex border-b border-gray-800">
                <button
                    onClick={() => setActiveTab('preferences')}
                    className={`flex-1 px-4 py-3 text-sm font-medium flex items-center justify-center gap-2 transition-colors ${activeTab === 'preferences'
                            ? 'text-purple-400 border-b-2 border-purple-400 bg-purple-500/5'
                            : 'text-gray-400 hover:text-gray-300'
                        }`}
                >
                    <BookOpen className="w-4 h-4" />
                    Preferences
                </button>
                <button
                    onClick={() => setActiveTab('rules')}
                    className={`flex-1 px-4 py-3 text-sm font-medium flex items-center justify-center gap-2 transition-colors ${activeTab === 'rules'
                            ? 'text-purple-400 border-b-2 border-purple-400 bg-purple-500/5'
                            : 'text-gray-400 hover:text-gray-300'
                        }`}
                >
                    <Shield className="w-4 h-4" />
                    Rules
                </button>
                <button
                    onClick={() => setActiveTab('context')}
                    className={`flex-1 px-4 py-3 text-sm font-medium flex items-center justify-center gap-2 transition-colors ${activeTab === 'context'
                            ? 'text-purple-400 border-b-2 border-purple-400 bg-purple-500/5'
                            : 'text-gray-400 hover:text-gray-300'
                        }`}
                >
                    <Sparkles className="w-4 h-4" />
                    Context Preview
                </button>
            </div>

            {/* Content */}
            <div className="p-4 max-h-96 overflow-y-auto">
                {/* Preferences Tab */}
                {activeTab === 'preferences' && (
                    <div className="space-y-4">
                        {Object.keys(preferences).length === 0 ? (
                            <div className="text-center py-8 text-gray-500">
                                <BookOpen className="w-12 h-12 mx-auto mb-3 opacity-50" />
                                <p>No preferences learned yet.</p>
                                <p className="text-sm">Use &quot;Learn from Project&quot; to analyze a project.</p>
                            </div>
                        ) : (
                            Object.entries(preferences).map(([category, categoryPrefs]) => (
                                <div key={category} className="bg-gray-800/50 rounded-lg p-3">
                                    <h3 className="text-sm font-medium text-purple-400 mb-2 capitalize">{category}</h3>
                                    <div className="space-y-2">
                                        {Object.entries(categoryPrefs).map(([key, pref]) => (
                                            <div key={key} className="flex items-center justify-between py-2 px-3 bg-gray-900/50 rounded-lg">
                                                <div className="flex items-center gap-3">
                                                    <span className="text-gray-300">{key}:</span>
                                                    <code className="text-sm bg-gray-800 px-2 py-0.5 rounded text-green-400">
                                                        {JSON.stringify(pref.value)}
                                                    </code>
                                                    {getSourceBadge(pref.source)}
                                                </div>
                                                <div className="flex items-center gap-3">
                                                    <span className={`text-xs ${getConfidenceColor(pref.confidence)}`}>
                                                        {Math.round(pref.confidence * 100)}%
                                                    </span>
                                                    <button
                                                        onClick={() => handleDeletePreference(category, key)}
                                                        className="p-1 hover:bg-red-500/20 rounded text-red-400"
                                                        title="Delete preference"
                                                    >
                                                        <Trash2 className="w-4 h-4" />
                                                    </button>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            ))
                        )}
                    </div>
                )}

                {/* Rules Tab */}
                {activeTab === 'rules' && (
                    <div className="space-y-4">
                        {/* Add Rule Form */}
                        <div className="flex gap-2">
                            <input
                                type="text"
                                value={newRule}
                                onChange={(e) => setNewRule(e.target.value)}
                                onKeyDown={(e) => e.key === 'Enter' && handleAddRule()}
                                placeholder="Add a new rule (e.g., 'Always use TypeScript')"
                                className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
                            />
                            <button
                                onClick={handleAddRule}
                                disabled={!newRule.trim()}
                                className="px-4 py-2 bg-purple-600 hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg flex items-center gap-2"
                            >
                                <Plus className="w-4 h-4" />
                                Add
                            </button>
                        </div>

                        {/* Rules List */}
                        {rules.length === 0 ? (
                            <div className="text-center py-8 text-gray-500">
                                <Shield className="w-12 h-12 mx-auto mb-3 opacity-50" />
                                <p>No rules defined yet.</p>
                                <p className="text-sm">Add rules to guide AI behavior.</p>
                            </div>
                        ) : (
                            <div className="space-y-2">
                                {rules.map((rule) => (
                                    <div
                                        key={rule.id}
                                        className={`flex items-center justify-between py-3 px-4 rounded-lg transition-colors ${rule.enabled ? 'bg-gray-800/50' : 'bg-gray-800/20 opacity-60'
                                            }`}
                                    >
                                        <div className="flex items-center gap-3">
                                            {rule.enabled ? (
                                                <CheckCircle className="w-4 h-4 text-green-400" />
                                            ) : (
                                                <AlertCircle className="w-4 h-4 text-gray-500" />
                                            )}
                                            <span className={rule.enabled ? 'text-gray-200' : 'text-gray-500'}>
                                                {rule.rule}
                                            </span>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <button
                                                onClick={() => handleToggleRule(rule.id, rule.enabled)}
                                                className="p-1 hover:bg-gray-700 rounded"
                                                title={rule.enabled ? 'Disable rule' : 'Enable rule'}
                                            >
                                                {rule.enabled ? (
                                                    <ToggleRight className="w-5 h-5 text-green-400" />
                                                ) : (
                                                    <ToggleLeft className="w-5 h-5 text-gray-500" />
                                                )}
                                            </button>
                                            <button
                                                onClick={() => handleDeleteRule(rule.id)}
                                                className="p-1 hover:bg-red-500/20 rounded text-red-400"
                                                title="Delete rule"
                                            >
                                                <Trash2 className="w-4 h-4" />
                                            </button>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                )}

                {/* Context Preview Tab */}
                {activeTab === 'context' && (
                    <div className="space-y-4">
                        <p className="text-sm text-gray-400">
                            This is the context that gets injected into AI prompts based on your preferences and rules.
                        </p>
                        {context ? (
                            <pre className="bg-gray-800 rounded-lg p-4 text-sm text-gray-300 whitespace-pre-wrap overflow-x-auto">
                                {context}
                            </pre>
                        ) : (
                            <div className="text-center py-8 text-gray-500">
                                <Sparkles className="w-12 h-12 mx-auto mb-3 opacity-50" />
                                <p>No context to inject yet.</p>
                                <p className="text-sm">Add preferences or rules to generate context.</p>
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}

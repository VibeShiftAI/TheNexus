"use client"

import { useState, useEffect } from "react";
import { Zap, Brain, Sparkles, Loader2, Check } from "lucide-react";

interface ReasoningLevel {
    name: string;
    description: string;
    reflectionEnabled: boolean;
    thinkingLevel: string;
    estimatedLatency: string;
    maxTurns: number;
    icon: string;
}

interface ReasoningConfig {
    currentLevel: string;
    levels: Record<string, ReasoningLevel>;
}

const LEVEL_ICONS: Record<string, React.ReactNode> = {
    'vibe': <Zap size={24} />,
    'standard': <Brain size={24} />,
    'deep': <Sparkles size={24} />,
};

const LEVEL_COLORS: Record<string, { bg: string; border: string; text: string; glow: string }> = {
    'vibe': {
        bg: 'bg-emerald-500/20',
        border: 'border-emerald-500',
        text: 'text-emerald-400',
        glow: 'shadow-emerald-500/20'
    },
    'standard': {
        bg: 'bg-cyan-500/20',
        border: 'border-cyan-500',
        text: 'text-cyan-400',
        glow: 'shadow-cyan-500/20'
    },
    'deep': {
        bg: 'bg-purple-500/20',
        border: 'border-purple-500',
        text: 'text-purple-400',
        glow: 'shadow-purple-500/20'
    },
};

export function ReasoningModeSelector() {
    const [config, setConfig] = useState<ReasoningConfig | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [changing, setChanging] = useState(false);
    const [justChanged, setJustChanged] = useState(false);

    useEffect(() => {
        fetch('/api/reasoning/config')
            .then(r => {
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                return r.json();
            })
            .then(data => {
                console.log('[ReasoningModeSelector] Loaded config:', data);
                setConfig(data);
            })
            .catch(err => {
                console.error('[ReasoningModeSelector] Error:', err);
                setError(err.message);
            })
            .finally(() => setLoading(false));
    }, []);

    const handleLevelChange = async (level: string) => {
        if (config?.currentLevel === level || changing) return;

        setChanging(true);
        try {
            const response = await fetch('/api/reasoning/level', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ level }),
            });

            if (response.ok) {
                setConfig(prev => prev ? { ...prev, currentLevel: level } : prev);
                setJustChanged(true);
                setTimeout(() => setJustChanged(false), 2000);
            } else {
                console.error('[ReasoningModeSelector] Failed to set level:', await response.text());
            }
        } catch (err) {
            console.error('Failed to change reasoning level:', err);
        } finally {
            setChanging(false);
        }
    };

    if (loading) {
        return (
            <div className="rounded-xl border border-slate-700 bg-slate-900/50 p-6">
                <div className="flex items-center justify-center h-32">
                    <Loader2 className="animate-spin text-slate-500" size={24} />
                </div>
            </div>
        );
    }

    if (error) {
        return (
            <div className="rounded-xl border border-red-500/50 bg-red-500/10 p-4 text-red-400">
                <p className="font-bold">Reasoning config error</p>
                <p className="text-sm">{error}</p>
                <p className="text-xs mt-2 opacity-70">Make sure the backend server is running.</p>
            </div>
        );
    }

    const levels = config?.levels || {};
    const currentLevel = config?.currentLevel || 'standard';

    return (
        <div className="rounded-xl border border-slate-700 bg-slate-900/50 overflow-hidden">
            {/* Header */}
            <div className="px-6 py-4 border-b border-slate-700/50">
                <div className="flex items-center justify-between">
                    <div>
                        <h3 className="text-lg font-semibold text-white flex items-center gap-2">
                            <Brain className="text-purple-400" size={20} />
                            Reasoning Mode
                        </h3>
                        <p className="text-sm text-slate-400 mt-1">
                            Control how deeply the AI thinks before acting
                        </p>
                    </div>
                    {justChanged && (
                        <div className="flex items-center gap-2 text-emerald-400 text-sm">
                            <Check size={16} />
                            Saved
                        </div>
                    )}
                </div>
            </div>

            {/* Level Cards */}
            <div className="p-4 grid grid-cols-1 md:grid-cols-3 gap-4">
                {Object.entries(levels).map(([levelId, level]) => {
                    const isActive = currentLevel === levelId;
                    const colors = LEVEL_COLORS[levelId] || LEVEL_COLORS.standard;
                    const icon = LEVEL_ICONS[levelId] || <Brain size={24} />;

                    return (
                        <button
                            key={levelId}
                            onClick={() => handleLevelChange(levelId)}
                            disabled={changing}
                            className={`relative p-4 rounded-xl border-2 transition-all text-left ${isActive
                                ? `${colors.bg} ${colors.border} shadow-lg ${colors.glow}`
                                : 'border-slate-700 hover:border-slate-600 hover:bg-slate-800/50'
                                } ${changing ? 'opacity-50 cursor-wait' : 'cursor-pointer'}`}
                        >
                            {/* Active indicator */}
                            {isActive && (
                                <div className={`absolute top-3 right-3 w-2 h-2 rounded-full ${colors.text.replace('text-', 'bg-')} animate-pulse`} />
                            )}

                            {/* Icon */}
                            <div className={`mb-3 ${isActive ? colors.text : 'text-slate-500'}`}>
                                {icon}
                            </div>

                            {/* Title & Description */}
                            <h4 className={`font-semibold mb-1 ${isActive ? 'text-white' : 'text-slate-300'}`}>
                                {level.name}
                            </h4>
                            <p className="text-xs text-slate-400 mb-3">
                                {level.description}
                            </p>

                            {/* Stats */}
                            <div className="flex items-center gap-3 text-xs">
                                <span className={`px-2 py-0.5 rounded-full ${isActive ? colors.bg : 'bg-slate-800'} ${isActive ? colors.text : 'text-slate-400'}`}>
                                    {level.estimatedLatency}
                                </span>
                                <span className="text-slate-500">
                                    {level.maxTurns} turns max
                                </span>
                            </div>

                            {/* Reflection indicator */}
                            {level.reflectionEnabled && (
                                <div className="mt-2 text-xs text-slate-500 flex items-center gap-1">
                                    <Check size={12} />
                                    Critic enabled
                                </div>
                            )}
                        </button>
                    );
                })}
            </div>
        </div>
    );
}

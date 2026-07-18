"use client";

import { useState, useEffect } from "react";
import { Loader2, RefreshCw, ChevronDown, ChevronRight, CheckCircle2, Eye, EyeOff } from "lucide-react";
import { getProjectKeys, rotateProjectKey, ProjectKeyGroup } from "@/lib/nexus";

/**
 * "API Key Rotation" section of the settings modal: every secret-shaped env
 * key across all project .env files, grouped by name. Paste a new value once
 * and it rewrites the key in every file that already carries it.
 */
export function KeyRotationPanel({ reloadKey }: { reloadKey: boolean }) {
    const [keys, setKeys] = useState<ProjectKeyGroup[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [expanded, setExpanded] = useState<string | null>(null);
    const [drafts, setDrafts] = useState<Record<string, string>>({});
    const [showDraft, setShowDraft] = useState<Record<string, boolean>>({});
    const [rotating, setRotating] = useState<string | null>(null);
    const [rotated, setRotated] = useState<Record<string, number>>({});

    const load = () => {
        setError(null);
        getProjectKeys()
            .then(data => setKeys(data.keys))
            .catch(err => setError(err instanceof Error ? err.message : "Failed to scan project keys"));
    };

    useEffect(() => {
        if (reloadKey) load();
    }, [reloadKey]);

    const rotate = async (name: string) => {
        const value = (drafts[name] || "").trim();
        if (!value) return;
        setRotating(name);
        setError(null);
        try {
            const result = await rotateProjectKey(name, value);
            setRotated(prev => ({ ...prev, [name]: result.updated.length }));
            setDrafts(prev => ({ ...prev, [name]: "" }));
            load(); // refresh masked previews
        } catch (err) {
            setError(err instanceof Error ? err.message : `Failed to rotate ${name}`);
        } finally {
            setRotating(null);
        }
    };

    if (!keys) {
        return error ? (
            <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm">{error}</div>
        ) : (
            <div className="flex items-center gap-2 text-sm text-slate-500 py-2">
                <Loader2 size={14} className="animate-spin" /> Scanning project env files…
            </div>
        );
    }

    return (
        <div className="space-y-2">
            <p className="text-xs text-slate-500">
                {keys.length} credential{keys.length === 1 ? "" : "s"} found across all project env files.
                Rotating rewrites the key in every file that already has it — running services pick up
                new values on their next restart.
            </p>

            {keys.map(group => {
                const isOpen = expanded === group.name;
                const justRotated = rotated[group.name];
                return (
                    <div key={group.name} className="rounded-lg border border-slate-700 bg-slate-800/50 overflow-hidden">
                        <button
                            onClick={() => setExpanded(isOpen ? null : group.name)}
                            className="w-full flex items-center justify-between px-3 py-2.5 hover:bg-slate-800 transition-colors"
                        >
                            <span className="flex items-center gap-2 text-sm font-mono text-slate-200">
                                {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                                {group.name}
                            </span>
                            <span className="flex items-center gap-2">
                                {justRotated != null && (
                                    <span className="flex items-center gap-1 text-xs text-emerald-400">
                                        <CheckCircle2 size={12} /> {justRotated} file{justRotated === 1 ? "" : "s"}
                                    </span>
                                )}
                                <span className="text-xs px-1.5 py-0.5 rounded bg-slate-700 text-slate-400">
                                    {group.locations.length} file{group.locations.length === 1 ? "" : "s"}
                                </span>
                            </span>
                        </button>

                        {isOpen && (
                            <div className="px-3 pb-3 space-y-2 border-t border-slate-700/50">
                                <table className="w-full text-xs mt-2">
                                    <tbody>
                                        {group.locations.map(loc => (
                                            <tr key={loc.file} className="text-slate-400">
                                                <td className="py-1 pr-2">{loc.project}</td>
                                                <td className="py-1 pr-2 font-mono text-slate-500">{loc.file}</td>
                                                <td className="py-1 font-mono text-right text-slate-500">{loc.masked}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                                <div className="flex gap-2">
                                    <div className="relative flex-1">
                                        <input
                                            type={showDraft[group.name] ? "text" : "password"}
                                            value={drafts[group.name] || ""}
                                            onChange={(e) => setDrafts(prev => ({ ...prev, [group.name]: e.target.value }))}
                                            placeholder="New value"
                                            className="w-full px-3 py-2 pr-9 rounded-lg bg-slate-900 border border-slate-700 text-white text-xs placeholder:text-slate-500 focus:outline-none focus:border-cyan-500 transition-all font-mono"
                                        />
                                        <button
                                            type="button"
                                            onClick={() => setShowDraft(prev => ({ ...prev, [group.name]: !prev[group.name] }))}
                                            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 transition-colors"
                                        >
                                            {showDraft[group.name] ? <EyeOff size={14} /> : <Eye size={14} />}
                                        </button>
                                    </div>
                                    <button
                                        onClick={() => rotate(group.name)}
                                        disabled={rotating === group.name || !(drafts[group.name] || "").trim()}
                                        className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium bg-cyan-500/15 border border-cyan-500/40 text-cyan-300 hover:bg-cyan-500/25 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
                                    >
                                        {rotating === group.name
                                            ? <Loader2 size={13} className="animate-spin" />
                                            : <RefreshCw size={13} />}
                                        Rotate
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                );
            })}

            {error && (
                <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm">{error}</div>
            )}
        </div>
    );
}

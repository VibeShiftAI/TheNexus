"use client";

import { useState, useEffect, useCallback } from "react";
import { Loader2, MessageSquare, CheckCircle2 } from "lucide-react";
import {
    getChatConfig, saveChatConfig, ChatConfig,
    ChatBackend, CHAT_BACKENDS, CHAT_BACKEND_LABELS,
    ChatThinkingLevel, LEGACY_CHAT_THINKING_LEVELS, CHAT_THINKING_LABELS,
    formatClaudeModelName,
} from "@/lib/model-control";

/** Suggested slugs per backend — free text is still allowed. */
const MODEL_SUGGESTIONS: Record<Exclude<ChatBackend, "off">, string[]> = {
    "claude-code": ["claude-fable-5", "claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5-20251001"],
    codex: ["gpt-5.5", "gpt-5-codex"],
};

const MODEL_PLACEHOLDER: Record<Exclude<ChatBackend, "off">, string> = {
    "claude-code": "Default (follows dispatch claude-default)",
    codex: "Default (dispatch codex-default / CLI default)",
};

/**
 * "Praxis Terminal" section of the settings modal: who fronts the chat
 * (Claude Code / Codex / legacy loop), which model, and the thinking level.
 * Every change saves immediately — the next chat turn picks it up within
 * Praxis's 60s settings cache.
 */
export function ChatSettingsSection({ reloadKey }: { reloadKey: boolean }) {
    const [config, setConfig] = useState<ChatConfig | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [savedAt, setSavedAt] = useState(0);
    const [modelDraft, setModelDraft] = useState("");

    useEffect(() => {
        if (!reloadKey) return;
        setError(null);
        getChatConfig()
            .then(cfg => {
                setConfig(cfg);
                setModelDraft(cfg.backend === "codex" ? cfg.codexModel : cfg.claudeModel);
            })
            .catch(err => setError(err instanceof Error ? err.message : "Failed to load chat config"));
    }, [reloadKey]);

    const apply = useCallback(async (update: Partial<ChatConfig>) => {
        setError(null);
        try {
            const next = await saveChatConfig(update);
            setConfig(next);
            setSavedAt(Date.now());
            setTimeout(() => setSavedAt(0), 2000);
            return next;
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to save chat config");
            return null;
        }
    }, []);

    const pickBackend = async (backend: ChatBackend) => {
        const next = await apply({ backend });
        if (next) setModelDraft(backend === "codex" ? next.codexModel : next.claudeModel);
    };

    const commitModel = () => {
        if (!config || config.backend === "off") return;
        const field = config.backend === "codex" ? "codexModel" : "claudeModel";
        if (modelDraft.trim() === config[field]) return;
        apply({ [field]: modelDraft.trim() });
    };

    if (!config) {
        return error ? (
            <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm">{error}</div>
        ) : (
            <div className="flex items-center gap-2 text-sm text-slate-500 py-2">
                <Loader2 size={14} className="animate-spin" /> Loading chat config…
            </div>
        );
    }

    const activeBackend = config.backend;

    // Server-supplied per-model tiers. A server old enough to omit the field is
    // also old enough to reject anything beyond the legacy four, so fall back to
    // those — NOT to the full union, which would render options that 400.
    const thinkingTiers = config.thinkingTiers?.length ? config.thinkingTiers : LEGACY_CHAT_THINKING_LEVELS;

    // Executor labels reflect the configured chat model, not a hardcoded name.
    const backendLabel = (backend: ChatBackend): string => {
        if (backend === "claude-code" && config.claudeModel.trim()) {
            return `Claude session (${formatClaudeModelName(config.claudeModel)}, Claude subscription)`;
        }
        if (backend === "codex" && config.codexModel.trim()) {
            return `Codex session (${config.codexModel.trim()}, ChatGPT subscription)`;
        }
        return CHAT_BACKEND_LABELS[backend];
    };

    return (
        <div className="space-y-4">
            <div className="flex items-center justify-between">
                <label className="flex items-center gap-2 text-sm font-medium text-slate-300">
                    <MessageSquare size={14} className="text-cyan-400" />
                    Chat Executor
                </label>
                {savedAt > 0 && (
                    <span className="flex items-center gap-1 text-xs text-emerald-400">
                        <CheckCircle2 size={12} /> Saved
                    </span>
                )}
            </div>

            {/* Executor picker */}
            <div className="grid grid-cols-3 gap-2">
                {CHAT_BACKENDS.map(backend => (
                    <button
                        key={backend}
                        onClick={() => pickBackend(backend)}
                        className={`px-3 py-2 rounded-lg text-sm border transition-all ${
                            activeBackend === backend
                                ? "bg-cyan-500/15 border-cyan-500/50 text-cyan-300 font-medium"
                                : "bg-slate-800 border-slate-700 text-slate-400 hover:border-slate-500"
                        }`}
                    >
                        {backendLabel(backend)}
                    </button>
                ))}
            </div>

            {activeBackend !== "off" ? (
                <>
                    {/* Model override for the active backend */}
                    <div>
                        <label className="block text-sm font-medium text-slate-300 mb-2">
                            {activeBackend === "codex" ? "Codex Model" : "Claude Model"}
                        </label>
                        <input
                            type="text"
                            list="chat-model-suggestions"
                            value={modelDraft}
                            onChange={(e) => setModelDraft(e.target.value)}
                            onBlur={commitModel}
                            onKeyDown={(e) => { if (e.key === "Enter") commitModel(); }}
                            placeholder={MODEL_PLACEHOLDER[activeBackend]}
                            className="w-full px-3 py-2.5 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm placeholder:text-slate-500 focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500/30 transition-all font-mono"
                        />
                        <datalist id="chat-model-suggestions">
                            {MODEL_SUGGESTIONS[activeBackend].map(m => <option key={m} value={m} />)}
                        </datalist>
                        <p className="mt-1 text-xs text-slate-500">
                            Chat-only override — leave empty to follow the dispatch default model.
                        </p>
                    </div>

                    {/* Thinking level — tiers come from the server's per-model
                        capability map, so Fable 5 exposes xhigh/max while a
                        model capped at High simply never renders them. */}
                    <div>
                        <label className="block text-sm font-medium text-slate-300 mb-2">Thinking Level</label>
                        <div
                            className="grid gap-2"
                            style={{ gridTemplateColumns: `repeat(${Math.min(thinkingTiers.length, 4)}, minmax(0, 1fr))` }}
                        >
                            {thinkingTiers.map(level => (
                                <button
                                    key={level}
                                    onClick={() => apply({ thinkingLevel: level })}
                                    className={`px-2 py-1.5 rounded-lg text-xs border transition-all ${
                                        config.thinkingLevel === level
                                            ? "bg-purple-500/15 border-purple-500/50 text-purple-300 font-medium"
                                            : "bg-slate-800 border-slate-700 text-slate-400 hover:border-slate-500"
                                    }`}
                                >
                                    {CHAT_THINKING_LABELS[level]}
                                </button>
                            ))}
                        </div>
                        <p className="mt-1 text-xs text-slate-500">
                            Claude: <code>--effort</code> · Codex: reasoning effort. Only tiers the selected model
                            supports are shown. Default leaves the CLI untouched.
                        </p>
                    </div>
                </>
            ) : (
                <p className="text-xs text-slate-500">
                    Chat uses the legacy in-process routed-LLM loop (no CLI session).
                </p>
            )}

            {error && (
                <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm">{error}</div>
            )}
        </div>
    );
}

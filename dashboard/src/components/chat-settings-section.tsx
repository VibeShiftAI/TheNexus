"use client";

import { useState, useEffect } from "react";
import { Loader2, MessageSquare, CheckCircle2, AlertTriangle } from "lucide-react";
import { ChatBackend, CHAT_BACKENDS, CHAT_THINKING_LABELS } from "@/lib/model-control";
import { useChatConfig } from "@/hooks/use-chat-config";
import {
    CHAT_BACKEND_SWITCH_WARNING,
    CHAT_CONFIG_APPLY_NOTICE,
    CHAT_MODEL_PLACEHOLDER,
    CHAT_MODEL_SUGGESTIONS,
    chatBackendOptionLabel,
    chatModelField,
    chatThinkingTiers,
} from "@/lib/chat-config-store";

/**
 * "Praxis Terminal" section of the settings modal: who fronts the chat
 * (Claude Code / Codex / legacy loop), which model, and the thinking level.
 * Every change saves immediately — the next chat turn picks it up within
 * Praxis's 60s settings cache.
 *
 * The state, option lists and save path all come from the shared chat-config
 * store, which the MAIN VIEWER header's ChatModelControl also consumes — this
 * is the full-detail view of one setting, not a second switch, and it is the
 * surface where an arbitrary model slug can be typed by hand.
 */
export function ChatSettingsSection({ reloadKey }: { reloadKey: boolean }) {
    const { config, saving, error, savedAt, apply } = useChatConfig(reloadKey);
    const [modelDraft, setModelDraft] = useState("");
    const [pendingBackend, setPendingBackend] = useState<ChatBackend | null>(null);

    // Keep the free-text field in step with whatever the store holds — either
    // this section's own save, or one made from the header control.
    const activeField = config ? chatModelField(config.backend) : null;
    const activeModel = config && activeField ? config[activeField] : "";
    useEffect(() => {
        setModelDraft(activeModel);
    }, [activeModel]);

    // Changing the executor restarts the CLI session behind the chat, so it is
    // confirmed here exactly as it is in the header control. Changing the model
    // inside one executor keeps the session and saves straight away.
    const pickBackend = (backend: ChatBackend) => {
        if (!config || backend === config.backend) return;
        setPendingBackend(backend);
    };

    const confirmBackend = () => {
        if (!pendingBackend) return;
        const target = pendingBackend;
        setPendingBackend(null);
        void apply({ backend: target });
    };

    // A rejected save must not leave this field showing a model the server never
    // accepted: the store deliberately keeps the last CONFIRMED config, so
    // `activeModel` doesn't change and the effect above won't fire. Restore the
    // confirmed slug by hand, or this surface would claim a model as active
    // while the header indicator (same store) still shows the real one.
    const commitModel = async () => {
        // Disabling a focused input blurs it, which re-enters this handler while
        // the first write is still in flight — without this guard that queues a
        // duplicate PUT of the same slug.
        if (!config || !activeField || saving) return;
        const confirmed = config[activeField];
        const next = modelDraft.trim();
        if (next === confirmed) return;
        const saved = await apply({ [activeField]: next });
        if (!saved) setModelDraft(confirmed);
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
                        disabled={saving}
                        className={`px-3 py-2 rounded-lg text-sm border transition-all disabled:opacity-60 ${
                            activeBackend === backend
                                ? "bg-cyan-500/15 border-cyan-500/50 text-cyan-300 font-medium"
                                : "bg-slate-800 border-slate-700 text-slate-400 hover:border-slate-500"
                        }`}
                    >
                        {chatBackendOptionLabel(backend, config)}
                    </button>
                ))}
            </div>

            {pendingBackend && (
                <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 space-y-2">
                    <p className="flex gap-2 text-xs leading-snug text-amber-200">
                        <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                        <span>
                            Switch the chat executor to {chatBackendOptionLabel(pendingBackend, config)}?{" "}
                            {CHAT_BACKEND_SWITCH_WARNING}
                        </span>
                    </p>
                    <div className="flex gap-2">
                        <button
                            onClick={confirmBackend}
                            className="px-3 py-1.5 rounded-lg text-xs border border-amber-500/50 bg-amber-500/15 text-amber-200 hover:bg-amber-500/25"
                        >
                            Switch anyway
                        </button>
                        <button
                            onClick={() => setPendingBackend(null)}
                            className="px-3 py-1.5 rounded-lg text-xs border border-slate-700 bg-slate-800 text-slate-300 hover:border-slate-500"
                        >
                            Cancel
                        </button>
                    </div>
                </div>
            )}

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
                            onBlur={() => void commitModel()}
                            onKeyDown={(e) => { if (e.key === "Enter") void commitModel(); }}
                            disabled={saving}
                            placeholder={CHAT_MODEL_PLACEHOLDER[activeBackend]}
                            className="w-full px-3 py-2.5 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm placeholder:text-slate-500 focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500/30 transition-all font-mono disabled:opacity-60"
                        />
                        <datalist id="chat-model-suggestions">
                            {CHAT_MODEL_SUGGESTIONS[activeBackend].map(m => <option key={m} value={m} />)}
                        </datalist>
                        <p className="mt-1 text-xs text-slate-500">
                            Chat-only override — leave empty to follow the dispatch default model. Any slug is
                            accepted here; the viewer header offers the common ones.
                        </p>
                    </div>

                    {/* Thinking level — tiers come from the server's per-model
                        capability map, so Fable 5 exposes xhigh/max while a
                        model capped at High simply never renders them. */}
                    <div>
                        <label className="block text-sm font-medium text-slate-300 mb-2">Thinking Level</label>
                        <div
                            className="grid gap-2"
                            style={{ gridTemplateColumns: `repeat(${Math.min(chatThinkingTiers(config).length, 4)}, minmax(0, 1fr))` }}
                        >
                            {chatThinkingTiers(config).map(level => (
                                <button
                                    key={level}
                                    onClick={() => void apply({ thinkingLevel: level })}
                                    disabled={saving}
                                    className={`px-2 py-1.5 rounded-lg text-xs border transition-all disabled:opacity-60 ${
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

            <p className="text-xs text-slate-500">{CHAT_CONFIG_APPLY_NOTICE}</p>

            {error && (
                <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm">{error}</div>
            )}
        </div>
    );
}

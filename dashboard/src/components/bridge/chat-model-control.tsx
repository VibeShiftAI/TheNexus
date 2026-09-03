/**
 * ChatModelControl — the MAIN VIEWER header's live "who is answering as
 * Praxis" readout, and a compact picker for changing it without leaving the
 * chat.
 *
 * This is a SECOND VIEW of the chat config, not a second switch: it reads and
 * writes the same shared store as the settings modal's ChatSettingsSection
 * (`@/lib/chat-config-store` → /api/model-control/chat-config), so the two
 * surfaces can never disagree and a change in either repaints the other with
 * no page reload. The settings modal remains the full-detail surface — free
 * text model slugs live there.
 *
 * The picker tells two truths the state alone doesn't: a change lands on the
 * NEXT turn (Praxis caches settings ~60s), and switching the BACKEND restarts
 * the CLI session, so that one asks for confirmation first.
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Check, ChevronDown, Cpu, Loader2 } from "lucide-react";

import { useChatConfig } from "@/hooks/use-chat-config";
import {
    CHAT_BACKEND_SHORT_LABELS,
    CHAT_BACKEND_SWITCH_WARNING,
    CHAT_CONFIG_APPLY_NOTICE,
    CHAT_MODEL_SUGGESTIONS,
    activeChatModel,
    chatModelField,
    chatModelIndicatorLabel,
    chatThinkingTiers,
    formatChatModelName,
} from "@/lib/chat-config-store";
import { CHAT_BACKENDS, CHAT_THINKING_LABELS, type ChatBackend, type ChatConfig } from "@/lib/model-control";

const OPTION_BASE = "rounded border px-1.5 py-1 text-[10px] transition-colors disabled:opacity-60";
const OPTION_ON = "border-cyan-500/50 bg-cyan-500/15 text-cyan-200";
const OPTION_OFF = "border-slate-800 bg-slate-900/60 text-slate-400 hover:border-slate-600 hover:text-slate-200";

/** Suggestions for a backend, plus the configured slug when it isn't one of them. */
function modelChoices(config: ChatConfig): string[] {
    if (config.backend === "off") return [];
    const suggestions = CHAT_MODEL_SUGGESTIONS[config.backend];
    const current = activeChatModel(config);
    return current && !suggestions.includes(current) ? [current, ...suggestions] : suggestions;
}

export function ChatModelControl() {
    const { config, loading, saving, error, savedAt, apply, reload } = useChatConfig();
    const [open, setOpen] = useState(false);
    const [pendingBackend, setPendingBackend] = useState<ChatBackend | null>(null);
    const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const popoverRef = useRef<HTMLDivElement>(null);

    const close = useCallback(() => {
        setOpen(false);
        setPendingBackend(null);
    }, []);

    // The panel this lives in is `overflow-hidden`, so the popover is
    // portalled to the body and positioned against the trigger instead of
    // being clipped by the header.
    const toggle = () => {
        if (open) {
            close();
            return;
        }
        const box = triggerRef.current?.getBoundingClientRect();
        if (box) {
            setAnchor({
                top: box.bottom + 6,
                right: Math.max(8, (globalThis.window?.innerWidth ?? 0) - box.right),
            });
        }
        // The trigger says "click to retry" when the config failed to load, so
        // honor that: without it the picker opens onto "unavailable" with no
        // way back short of a page reload. `loadChatConfig` de-dupes, so this
        // cannot pile up requests.
        if (!config && !loading) void reload();
        setOpen(true);
    };

    // Escape closes, and so does a click outside — the popover is a transient
    // surface over a dense header, never a mode you can get stuck in.
    useEffect(() => {
        if (!open) return;
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                event.stopPropagation();
                close();
                triggerRef.current?.focus();
            }
        };
        const onPointerDown = (event: Event) => {
            const target = event.target as Node | null;
            if (!target) return;
            if (popoverRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
            close();
        };
        document.addEventListener("keydown", onKeyDown, true);
        document.addEventListener("mousedown", onPointerDown, true);
        return () => {
            document.removeEventListener("keydown", onKeyDown, true);
            document.removeEventListener("mousedown", onPointerDown, true);
        };
    }, [open, close]);

    const label = chatModelIndicatorLabel(config);
    const backendLabel = config ? CHAT_BACKEND_SHORT_LABELS[config.backend] : "—";
    const title = config
        ? `Praxis chat: ${backendLabel} · ${activeChatModel(config) || "executor default"} — click to change`
        : loading
        ? "Loading chat model…"
        : "Chat model unavailable — click to retry";

    const pickBackend = (backend: ChatBackend) => {
        if (!config || backend === config.backend) return;
        // Restarting the CLI session is destructive to the conversation, so it
        // never happens on a single click.
        setPendingBackend(backend);
    };

    const confirmBackend = async () => {
        if (!pendingBackend) return;
        const target = pendingBackend;
        setPendingBackend(null);
        await apply({ backend: target });
    };

    const pickModel = (slug: string) => {
        if (!config) return;
        const field = chatModelField(config.backend);
        // Same backend, same CLI session: no confirmation needed.
        if (!field || config[field].trim() === slug) return;
        void apply({ [field]: slug } as Partial<ChatConfig>);
    };

    return (
        <>
            <button
                ref={triggerRef}
                type="button"
                onClick={toggle}
                aria-haspopup="dialog"
                aria-expanded={open}
                aria-label={`Praxis chat model: ${label}. Change chat model`}
                title={title}
                className="flex max-w-[10rem] items-center gap-1 rounded-md border border-slate-800 bg-slate-900/60 px-1.5 py-1 text-[10px] text-slate-400 transition-colors hover:bg-slate-800 hover:text-cyan-300"
            >
                {saving ? (
                    <Loader2 size={11} className="shrink-0 animate-spin text-cyan-400" />
                ) : error ? (
                    <AlertTriangle size={11} className="shrink-0 text-red-400" />
                ) : (
                    <Cpu size={11} className="shrink-0" />
                )}
                <span className="truncate font-medium tabular-nums" data-testid="chat-model-indicator">
                    {label}
                </span>
                <ChevronDown size={10} className="hidden shrink-0 opacity-70 sm:block" />
            </button>

            {open &&
                typeof document !== "undefined" &&
                createPortal(
                    <div
                        ref={popoverRef}
                        role="dialog"
                        aria-label="Praxis chat model"
                        style={{ top: anchor?.top ?? 64, right: anchor?.right ?? 16 }}
                        className="fixed z-[80] w-[248px] rounded-lg border border-slate-700 bg-slate-950/95 p-2.5 shadow-2xl backdrop-blur-sm"
                    >
                        <div className="mb-2 flex items-baseline justify-between gap-2">
                            <span className="text-[10px] font-semibold uppercase tracking-wide text-cyan-400">
                                Answering as Praxis
                            </span>
                            {saving ? (
                                <span className="flex items-center gap-1 text-[10px] text-cyan-300">
                                    <Loader2 size={10} className="animate-spin" /> Saving…
                                </span>
                            ) : savedAt > 0 ? (
                                <span className="flex items-center gap-1 text-[10px] text-emerald-400">
                                    <Check size={10} /> Saved
                                </span>
                            ) : null}
                        </div>

                        {!config ? (
                            <p className="py-1 text-[11px] text-slate-500">
                                {loading ? "Loading chat config…" : "Chat config unavailable."}
                            </p>
                        ) : pendingBackend ? (
                            <div className="space-y-2">
                                <p className="flex gap-1.5 text-[11px] leading-snug text-amber-200">
                                    <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                                    <span>
                                        Switch to {CHAT_BACKEND_SHORT_LABELS[pendingBackend]}?{" "}
                                        {CHAT_BACKEND_SWITCH_WARNING}
                                    </span>
                                </p>
                                <div className="flex gap-1.5">
                                    <button
                                        type="button"
                                        onClick={confirmBackend}
                                        className="flex-1 rounded border border-amber-500/50 bg-amber-500/15 px-2 py-1 text-[10px] text-amber-200 hover:bg-amber-500/25"
                                    >
                                        Switch anyway
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setPendingBackend(null)}
                                        className="flex-1 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-[10px] text-slate-300 hover:border-slate-500"
                                    >
                                        Keep {CHAT_BACKEND_SHORT_LABELS[config.backend]}
                                    </button>
                                </div>
                            </div>
                        ) : (
                            <div className="space-y-2">
                                <div>
                                    <div className="mb-1 text-[9px] uppercase tracking-wide text-slate-500">Executor</div>
                                    <div className="grid grid-cols-3 gap-1">
                                        {CHAT_BACKENDS.map((backend) => (
                                            <button
                                                key={backend}
                                                type="button"
                                                data-backend={backend}
                                                aria-pressed={config.backend === backend}
                                                onClick={() => pickBackend(backend)}
                                                disabled={saving}
                                                className={`${OPTION_BASE} ${
                                                    config.backend === backend ? OPTION_ON : OPTION_OFF
                                                }`}
                                            >
                                                {CHAT_BACKEND_SHORT_LABELS[backend]}
                                            </button>
                                        ))}
                                    </div>
                                </div>

                                {config.backend !== "off" && (
                                    <div>
                                        <div className="mb-1 text-[9px] uppercase tracking-wide text-slate-500">Model</div>
                                        <div className="grid grid-cols-2 gap-1">
                                            {modelChoices(config).map((slug) => (
                                                <button
                                                    key={slug}
                                                    type="button"
                                                    data-model={slug}
                                                    aria-pressed={activeChatModel(config) === slug}
                                                    onClick={() => pickModel(slug)}
                                                    disabled={saving}
                                                    title={slug}
                                                    className={`${OPTION_BASE} truncate ${
                                                        activeChatModel(config) === slug ? OPTION_ON : OPTION_OFF
                                                    }`}
                                                >
                                                    {formatChatModelName(slug)}
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                )}

                                <div>
                                    <div className="mb-1 text-[9px] uppercase tracking-wide text-slate-500">Thinking</div>
                                    <div className="flex flex-wrap gap-1">
                                        {chatThinkingTiers(config).map((level) => (
                                            <button
                                                key={level}
                                                type="button"
                                                data-thinking={level}
                                                aria-pressed={config.thinkingLevel === level}
                                                onClick={() => void apply({ thinkingLevel: level })}
                                                disabled={saving}
                                                className={`${OPTION_BASE} ${
                                                    config.thinkingLevel === level ? OPTION_ON : OPTION_OFF
                                                }`}
                                            >
                                                {CHAT_THINKING_LABELS[level]}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            </div>
                        )}

                        {error && (
                            <p role="alert" className="mt-2 rounded border border-red-500/40 bg-red-500/10 px-1.5 py-1 text-[10px] text-red-300">
                                {error}
                            </p>
                        )}

                        <p className="mt-2 border-t border-slate-800 pt-1.5 text-[10px] leading-snug text-slate-500">
                            {CHAT_CONFIG_APPLY_NOTICE} Settings → Praxis Terminal for a custom model slug.
                        </p>
                    </div>,
                    document.body,
                )}
        </>
    );
}

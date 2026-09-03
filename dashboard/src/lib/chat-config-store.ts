/**
 * Shared chat-config state — ONE source of truth for every surface that shows
 * or changes who answers as Praxis in the chat.
 *
 * Two components read this: the settings modal's ChatSettingsSection (full
 * detail, free-text model slug) and the MAIN VIEWER header's ChatModelControl
 * (glanceable indicator + compact picker). They are two views of the same
 * state, not two switches: both go through `applyChatConfig`, which is the
 * only writer, and both re-render from the same snapshot the moment either one
 * saves — no page reload, no second endpoint, no duplicated model list.
 *
 * Transport stays in `@/lib/model-control` (`getChatConfig`/`saveChatConfig`
 * → /api/model-control/chat-config); this module owns the cached snapshot,
 * the option lists, and the label formatting.
 */
import {
    getChatConfig,
    saveChatConfig,
    formatClaudeModelName,
    LEGACY_CHAT_THINKING_LEVELS,
    CHAT_BACKEND_LABELS,
    type ChatConfig,
    type ChatBackend,
    type ChatThinkingLevel,
} from "@/lib/model-control";

/** Backends that actually run a CLI session (i.e. everything but "off"). */
export type ChatCliBackend = Exclude<ChatBackend, "off">;

/**
 * Suggested slugs per backend — the ONLY list; both surfaces render from it.
 * Free text stays possible in the settings modal, so an unlisted slug is never
 * unreachable.
 *
 * `claude-fable-5-1` is the dash form the Claude CLI accepts; the dotted
 * `claude-fable-5.1` is OpenRouter-only and the CLI rejects it. `claude-fable-5`
 * is kept because it has not been shown to be dead.
 */
export const CHAT_MODEL_SUGGESTIONS: Record<ChatCliBackend, string[]> = {
    "claude-code": [
        "claude-fable-5-1",
        "claude-fable-5",
        "claude-opus-5",
        "claude-opus-4-8",
        "claude-sonnet-5",
        "claude-haiku-4-5-20251001",
    ],
    codex: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"],
};

export const CHAT_MODEL_PLACEHOLDER: Record<ChatCliBackend, string> = {
    "claude-code": "Default (follows dispatch claude-default)",
    codex: "Default (dispatch codex-default / CLI default)",
};

/** Compact backend names for the header popover, where the full label is too wide. */
export const CHAT_BACKEND_SHORT_LABELS: Record<ChatBackend, string> = {
    "claude-code": "Claude",
    codex: "Codex",
    off: "Routed",
};

/**
 * Praxis reads chat settings through a 60s cache, and the turn already in
 * flight keeps the model it started with. Both surfaces say this out loud.
 */
export const CHAT_CONFIG_APPLY_NOTICE =
    "Applies on the next chat turn — Praxis caches settings for ~60s.";

/**
 * Backend switches restart the CLI session (chat-cli-session.ts resumes a
 * standing conversation per backend), so the current conversation's continuity
 * is lost. Model switches inside one backend do not restart it.
 */
export const CHAT_BACKEND_SWITCH_WARNING =
    "Switching the chat executor starts a FRESH CLI session — this conversation's continuity is lost.";

/** Which ChatConfig field holds the model override for a backend. */
export function chatModelField(backend: ChatBackend): "claudeModel" | "codexModel" | null {
    if (backend === "codex") return "codexModel";
    if (backend === "claude-code") return "claudeModel";
    return null;
}

/** The model slug actually in force for the config's active backend ("" = executor default). */
export function activeChatModel(config: ChatConfig): string {
    const field = chatModelField(config.backend);
    return field ? config[field].trim() : "";
}

/** Human name for a slug: claude-* through `formatClaudeModelName`, others verbatim. */
export function formatChatModelName(slug: string): string {
    const trimmed = slug.trim();
    if (!trimmed) return "Default";
    return trimmed.startsWith("claude-") ? formatClaudeModelName(trimmed) : trimmed;
}

/** Short glanceable label for the header indicator: "Opus 5", "gpt-5.6-sol", "Routed LLM". */
export function chatModelIndicatorLabel(config: ChatConfig | null): string {
    if (!config) return "…";
    if (config.backend === "off") return "Routed LLM";
    return formatChatModelName(activeChatModel(config));
}

/** Executor button label in the settings modal — reflects the configured model, not a hardcoded name. */
export function chatBackendOptionLabel(backend: ChatBackend, config: ChatConfig): string {
    if (backend === "claude-code" && config.claudeModel.trim()) {
        return `Claude session (${formatClaudeModelName(config.claudeModel)}, Claude subscription)`;
    }
    if (backend === "codex" && config.codexModel.trim()) {
        return `Codex session (${config.codexModel.trim()}, ChatGPT subscription)`;
    }
    return CHAT_BACKEND_LABELS[backend];
}

/**
 * Tiers to offer for the configured model. A server old enough to omit
 * `thinkingTiers` is also old enough to reject anything beyond the legacy four,
 * so fall back to those — NOT to the full union, which would render options
 * that 400.
 */
export function chatThinkingTiers(config: ChatConfig): ChatThinkingLevel[] {
    return config.thinkingTiers?.length ? config.thinkingTiers : LEGACY_CHAT_THINKING_LEVELS;
}

// ─── The store ────────────────────────────────────────────────────────────

export interface ChatConfigState {
    /** Last snapshot the server confirmed. Never optimistic: a failed save leaves it untouched. */
    config: ChatConfig | null;
    loading: boolean;
    saving: boolean;
    error: string | null;
    /** Timestamp of the last successful save; 0 once the "Saved" flash expires. */
    savedAt: number;
}

/** How long the "Saved" confirmation stays up. */
export const CHAT_CONFIG_SAVED_FLASH_MS = 2000;

const INITIAL_STATE: ChatConfigState = {
    config: null,
    loading: false,
    saving: false,
    error: null,
    savedAt: 0,
};

let state: ChatConfigState = INITIAL_STATE;
const listeners = new Set<() => void>();
let inFlightLoad: Promise<ChatConfig | null> | null = null;
let savedFlashTimer: ReturnType<typeof setTimeout> | null = null;
/** Tail of the write queue — see `applyChatConfig`. Never rejects. */
let writeQueue: Promise<void> = Promise.resolve();

function emit(patch: Partial<ChatConfigState>) {
    state = { ...state, ...patch };
    for (const listener of [...listeners]) listener();
}

function messageOf(err: unknown, fallback: string): string {
    return err instanceof Error && err.message ? err.message : fallback;
}

function clearSavedFlash() {
    if (savedFlashTimer) {
        clearTimeout(savedFlashTimer);
        savedFlashTimer = null;
    }
}

export function subscribeChatConfig(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

/** Stable snapshot for useSyncExternalStore — replaced wholesale on every change. */
export function getChatConfigState(): ChatConfigState {
    return state;
}

/**
 * Fetch the config into the store. Concurrent callers share one request, so
 * the header control and the settings modal mounting together issue one GET.
 */
export function loadChatConfig(): Promise<ChatConfig | null> {
    if (inFlightLoad) return inFlightLoad;
    emit({ loading: true, error: null });
    inFlightLoad = getChatConfig()
        .then((config) => {
            emit({ config, loading: false, error: null });
            return config;
        })
        .catch((err) => {
            emit({ loading: false, error: messageOf(err, "Failed to load chat config") });
            return null;
        })
        .finally(() => {
            inFlightLoad = null;
        });
    return inFlightLoad;
}

/**
 * The ONLY writer. Saves through /api/model-control/chat-config and publishes
 * the server's response to every subscriber, so a change made in one surface
 * shows up in the other without a reload. Returns null when the write failed —
 * and on failure `config` is left exactly as it was, so nothing can render an
 * un-saved model as the active one.
 */
export function applyChatConfig(update: Partial<ChatConfig>): Promise<ChatConfig | null> {
    // Writes are SERIALIZED, not just de-duplicated: two quick picks (executor
    // then model) would otherwise race, and the slower PUT's response would
    // land last and publish a snapshot that silently undoes the newer choice.
    // Queueing keeps request order == response order == what the user clicked.
    const queued = writeQueue.then(() => performChatConfigWrite(update));
    writeQueue = queued.then(
        () => undefined,
        () => undefined,
    );
    return queued;
}

/** One save, start to finish. Only ever called from the `applyChatConfig` queue. */
async function performChatConfigWrite(update: Partial<ChatConfig>): Promise<ChatConfig | null> {
    clearSavedFlash();
    emit({ saving: true, error: null, savedAt: 0 });
    try {
        const next = await saveChatConfig(update);
        emit({ config: next, saving: false, error: null, savedAt: Date.now() });
        savedFlashTimer = setTimeout(() => {
            savedFlashTimer = null;
            emit({ savedAt: 0 });
        }, CHAT_CONFIG_SAVED_FLASH_MS);
        // Don't hold the process open for a cosmetic flash (node test runs).
        (savedFlashTimer as unknown as { unref?: () => void })?.unref?.();
        return next;
    } catch (err) {
        emit({ saving: false, error: messageOf(err, "Failed to save chat config") });
        return null;
    }
}

/** Test seam: drop the cached snapshot, listeners and pending flash timer. */
export function resetChatConfigStore() {
    clearSavedFlash();
    inFlightLoad = null;
    writeQueue = Promise.resolve();
    listeners.clear();
    state = INITIAL_STATE;
}

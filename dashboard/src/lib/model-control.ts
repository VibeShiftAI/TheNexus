import { getAuthHeader } from "@/lib/auth";

export interface ModelControlOption {
    value: string;
    label: string;
    description?: string;
    resolvedLabel?: string;
    source?: string;
}

export interface ResolvedModelControl {
    requestedAssignment?: string | null;
    resolvedModelId?: string;
    provider?: string;
    apiModelId?: string;
    label?: string;
    source?: string;
    localOnlyActive?: boolean;
    localOnlyReason?: string | null;
    fallbackUsed?: boolean;
    fallbackReason?: string | null;
}

export interface ModelControlProbeResult {
    mode: "resolve" | "live";
    live: boolean;
    resolved: ResolvedModelControl;
    response?: string;
    usage?: Record<string, unknown> | null;
    snapshot?: ModelExecutionSnapshot | null;
}

export interface ModelControlAlias {
    alias: string;
    target: string;
    description?: string | null;
    is_active?: boolean;
    project_id?: string;
}

export interface ModelControlModel {
    id: string;
    name?: string;
    display_name?: string;
    provider?: string;
    api_model_id?: string;
    apiModelId?: string;
    capabilities?: Record<string, boolean>;
    parameters?: Record<string, unknown>;
    default_parameters?: Record<string, unknown>;
    family?: string;
    version_sort?: string;
    availability_status?: string;
    discovered_at?: string;
    last_seen_at?: string;
    is_active?: boolean;
}

export interface ModelControlOptionsResponse {
    models?: ModelControlModel[];
    aliases?: ModelControlAlias[];
    projectAliases?: ModelControlAlias[];
    localOnly?: { enabled: boolean; reason: string | null };
    policy?: ModelControlPolicy | null;
    projectPolicy?: ModelControlPolicy | null;
    /** Default model for Praxis claude-code dispatches (api model id). */
    claudeDefault?: string;
    /** Default model for Praxis codex dispatches ("" = codex CLI default). */
    codexDefault?: string;
    /** Default model for Praxis antigravity dispatches — an `agy models` display name ("" = agy CLI default). */
    antigravityDefault?: string;
    /** Backend chain for Praxis's autonomous system-agent runs. */
    agentBackend?: AgentBackendConfig;
    /** Backend fronting Praxis interactive chat (permanent CLI session or legacy loop). */
    chatBackend?: ChatBackend;
}

export type AgentBackend = "codex" | "claude-code" | "gemini";
export const AGENT_BACKENDS: AgentBackend[] = ["codex", "claude-code", "gemini"];
export const AGENT_BACKEND_LABELS: Record<AgentBackend, string> = {
    codex: "Codex CLI (ChatGPT subscription)",
    "claude-code": "Claude Code CLI (Claude subscription)",
    gemini: "Gemini API (per-token)",
};

export interface AgentBackendConfig {
    backend: AgentBackend;
    fallbacks: AgentBackend[];
}

export type ChatBackend = "claude-code" | "codex" | "off";
export const CHAT_BACKENDS: ChatBackend[] = ["claude-code", "codex", "off"];
export const CHAT_BACKEND_LABELS: Record<ChatBackend, string> = {
    "claude-code": "Claude session (Claude subscription)",
    codex: "Codex session (ChatGPT subscription)",
    off: "Legacy routed LLM (per-token)",
};

/** Human name for a claude-* slug: "claude-fable-5" → "Fable 5", "claude-haiku-4-5-20251001" → "Haiku 4.5". */
export function formatClaudeModelName(slug: string): string {
    const match = slug.trim().match(/^claude-([a-z]+)-(\d+(?:-\d+)?)/);
    if (!match) return slug.trim();
    return `${match[1][0].toUpperCase()}${match[1].slice(1)} ${match[2].replace("-", ".")}`;
}

export interface ModelControlPolicy {
    enabled: boolean;
    requiredCapabilities: string[];
    fallbackChain: string[];
    budget?: {
        dailyTokenLimit?: number | null;
        dailyCostLimit?: number | null;
        autoLocalOnly?: boolean;
        providerLimits?: Record<string, {
            dailyTokenLimit?: number | null;
            dailyCostLimit?: number | null;
        }>;
    };
}

export interface ModelBudgetProviderStatus {
    dailyTokensUsed: number;
    dailyCostUsed: number;
    dailyTokenLimit?: number | null;
    dailyCostLimit?: number | null;
    exceeded: boolean;
    reason?: string | null;
}

export interface ModelBudgetStatus extends ModelBudgetProviderStatus {
    byProvider: Record<string, ModelBudgetProviderStatus>;
}

export interface ModelExecutionSnapshot {
    id: string;
    requested_assignment?: string | null;
    resolved_model_id?: string | null;
    provider?: string | null;
    api_model_id?: string | null;
    parameters_summary?: Record<string, unknown> | null;
    source?: string | null;
    local_only_active?: boolean;
    local_only_reason?: string | null;
    fallback_used?: boolean;
    fallback_reason?: string | null;
    project_id?: string | null;
    task_id?: string | null;
    calendar_event_id?: string | null;
    workflow_id?: string | null;
    workflow_run_id?: string | null;
    node_id?: string | null;
    conversation_id?: string | null;
    message_id?: string | null;
    command_id?: string | null;
    created_at?: string | null;
}

export interface ModelExecutionResponse {
    snapshots: ModelExecutionSnapshot[];
    total: number;
    limit: number;
    offset: number;
}

export interface ModelDiscoveryProviderStatus {
    provider: string;
    status: "ok" | "skipped" | "error" | string;
    rawCount: number;
    modelCount: number;
    message?: string;
}

export interface ModelDiscoveryResult {
    models: ModelControlModel[];
    providers: ModelDiscoveryProviderStatus[];
    summary: Record<string, string>;
    elapsedMs: number;
    discoveredAt: string;
}

export async function getModelControlState(projectId?: string | null): Promise<ModelControlOptionsResponse> {
    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
    const response = await fetch(`/api/model-control/options${query}`, {
        credentials: "include",
        headers: { ...getAuthHeader() as any },
    });
    if (!response.ok) throw new Error(`Failed to load model-control state: ${response.status}`);
    return response.json();
}

/** Anthropic entries from the discovered roster, for Claude model dropdowns. */
export function filterClaudeModels(models: ModelControlModel[] | undefined): ModelControlModel[] {
    return (models || []).filter(m => (m.provider || "").toLowerCase() === "anthropic");
}

/** OpenAI entries from the discovered roster, for Codex model dropdowns. */
export function filterCodexModels(models: ModelControlModel[] | undefined): ModelControlModel[] {
    return (models || []).filter(m => (m.provider || "").toLowerCase() === "openai");
}

/**
 * Model names the antigravity selector can offer — the local `agy models`
 * output served by the Nexus API. These are display names ("Gemini 3.1 Pro
 * (High)"); slug ids do NOT pin in the agy CLI.
 */
export async function getAntigravityModels(): Promise<string[]> {
    const response = await fetch(`/api/model-control/antigravity-models`, {
        credentials: "include",
        headers: { ...getAuthHeader() as any },
    });
    if (!response.ok) throw new Error(`Failed to load antigravity models: ${response.status}`);
    const data = await response.json();
    return Array.isArray(data.models) ? data.models : [];
}

/** API model id for a roster entry (dropdown value used for dispatch). */
export function apiModelIdOf(model: ModelControlModel): string {
    return model.api_model_id || model.apiModelId || model.id;
}

export async function getClaudeDefaultModel(): Promise<string> {
    const response = await fetch(`/api/model-control/claude-default`, {
        credentials: "include",
        headers: { ...getAuthHeader() as any },
    });
    if (!response.ok) throw new Error(`Failed to load claude default: ${response.status}`);
    const data = await response.json();
    return data.model || "claude-opus-4-8";
}

export async function setClaudeDefaultModel(model: string): Promise<string> {
    const response = await fetch(`/api/model-control/claude-default`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...getAuthHeader() as any },
        body: JSON.stringify({ model }),
    });
    if (!response.ok) throw new Error(`Failed to update claude default: ${response.status}`);
    const data = await response.json();
    return data.model;
}

/** Set the codex-dispatch default model ("" = codex CLI default). */
export async function setCodexDefaultModel(model: string): Promise<string> {
    const response = await fetch(`/api/model-control/codex-default`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...getAuthHeader() as any },
        body: JSON.stringify({ model }),
    });
    if (!response.ok) throw new Error(`Failed to update codex default: ${response.status}`);
    const data = await response.json();
    return data.model ?? "";
}

/** Set the antigravity-dispatch default model — an `agy models` display name ("" = agy CLI default). */
export async function setAntigravityDefaultModel(model: string): Promise<string> {
    const response = await fetch(`/api/model-control/antigravity-default`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...getAuthHeader() as any },
        body: JSON.stringify({ model }),
    });
    if (!response.ok) throw new Error(`Failed to update antigravity default: ${response.status}`);
    const data = await response.json();
    return data.model ?? "";
}

export async function setAgentBackend(config: AgentBackendConfig): Promise<AgentBackendConfig> {
    const response = await fetch(`/api/model-control/agent-backend`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...getAuthHeader() as any },
        body: JSON.stringify(config),
    });
    if (!response.ok) throw new Error(`Failed to update agent backend: ${response.status}`);
    return response.json();
}

export async function setChatBackend(backend: ChatBackend): Promise<ChatBackend> {
    const response = await fetch(`/api/model-control/chat-backend`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...getAuthHeader() as any },
        body: JSON.stringify({ backend }),
    });
    if (!response.ok) throw new Error(`Failed to update chat backend: ${response.status}`);
    const data = await response.json();
    return data.backend as ChatBackend;
}

// ─── Praxis Terminal chat config (backend + model + thinking level) ────────

export type ChatThinkingLevel = "default" | "low" | "medium" | "high";
export const CHAT_THINKING_LEVELS: ChatThinkingLevel[] = ["default", "low", "medium", "high"];
export const CHAT_THINKING_LABELS: Record<ChatThinkingLevel, string> = {
    default: "Default",
    low: "Low",
    medium: "Medium",
    high: "High",
};

export interface ChatConfig {
    backend: ChatBackend;
    /** Chat-only model overrides; empty string = the executor's default-model chain. */
    claudeModel: string;
    codexModel: string;
    thinkingLevel: ChatThinkingLevel;
}

export async function getChatConfig(): Promise<ChatConfig> {
    const response = await fetch(`/api/model-control/chat-config`, {
        credentials: "include",
        headers: { ...getAuthHeader() as any },
    });
    if (!response.ok) throw new Error(`Failed to load chat config: ${response.status}`);
    return response.json();
}

export async function saveChatConfig(update: Partial<ChatConfig>): Promise<ChatConfig> {
    const response = await fetch(`/api/model-control/chat-config`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...getAuthHeader() as any },
        body: JSON.stringify(update),
    });
    if (!response.ok) throw new Error(`Failed to update chat config: ${response.status}`);
    return response.json();
}

export async function getModelControlOptions(projectId?: string | null): Promise<ModelControlOption[]> {
    const data = await getModelControlState(projectId);

    const projectAliases = (data.projectAliases || []).map(alias => ({
        value: `alias:${alias.alias}`,
        label: alias.alias,
        description: alias.description || alias.target,
        source: "project"
    }));
    const globalAliases = (data.aliases || []).map(alias => ({
        value: `alias:${alias.alias}`,
        label: alias.alias,
        description: alias.description || alias.target,
        source: "global"
    }));
    const models = (data.models || []).map(model => ({
        value: `model:${model.id}`,
        label: model.display_name || model.name || model.id,
        description: `${model.provider || "model"} / ${model.api_model_id || model.apiModelId || model.id}`,
        source: "model"
    }));

    const seen = new Set<string>();
    return [...projectAliases, ...globalAliases, ...models].filter(option => {
        if (seen.has(option.value)) return false;
        seen.add(option.value);
        return true;
    });
}

export async function resolveModelAssignment(input: { model_assignment?: string | null; projectId?: string | null; role?: string }): Promise<ResolvedModelControl> {
    const response = await fetch("/api/model-control/resolve", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...getAuthHeader() as any },
        body: JSON.stringify(input),
    });
    if (!response.ok) throw new Error(`Failed to resolve model assignment: ${response.status}`);
    return response.json();
}

export async function runModelControlProbe(input: {
    mode: "resolve" | "live";
    model_assignment?: string | null;
    projectId?: string | null;
    role?: string;
    prompt?: string;
}): Promise<ModelControlProbeResult> {
    const response = await fetch("/api/model-control/probe", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...getAuthHeader() as any },
        body: JSON.stringify(input),
    });
    if (!response.ok) throw new Error(`Failed to run model-control probe: ${response.status}`);
    return response.json();
}

export async function getModelExecutionSnapshots(filters: {
    projectId?: string | null;
    taskId?: string | null;
    calendarEventId?: string | null;
    workflowId?: string | null;
    provider?: string | null;
    resolvedModelId?: string | null;
    fallbackUsed?: boolean;
    localOnlyActive?: boolean;
    limit?: number;
    offset?: number;
} = {}): Promise<ModelExecutionResponse> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
        if (value !== undefined && value !== null && value !== "") {
            params.set(key, String(value));
        }
    }
    const query = params.toString() ? `?${params.toString()}` : "";
    const response = await fetch(`/api/model-control/executions${query}`, {
        credentials: "include",
        headers: { ...getAuthHeader() as any },
        cache: "no-store",
    });
    if (!response.ok) throw new Error(`Failed to load model execution snapshots: ${response.status}`);
    return response.json();
}

export async function runModelDiscovery(): Promise<ModelDiscoveryResult> {
    const response = await fetch("/api/model-control/discover", {
        method: "POST",
        credentials: "include",
        headers: { ...getAuthHeader() as any },
    });
    if (!response.ok) throw new Error(`Failed to run model discovery: ${response.status}`);
    return response.json();
}

export async function getModelBudgetStatus(projectId?: string | null): Promise<ModelBudgetStatus> {
    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
    const response = await fetch(`/api/model-control/budget-status${query}`, {
        credentials: "include",
        headers: { ...getAuthHeader() as any },
        cache: "no-store",
    });
    if (!response.ok) throw new Error(`Failed to load model budget status: ${response.status}`);
    return response.json();
}

export async function setLocalOnlyMode(enabled: boolean, reason?: string | null): Promise<{ enabled: boolean; reason: string | null }> {
    const response = await fetch("/api/model-control/local-only", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...getAuthHeader() as any },
        body: JSON.stringify({ enabled, reason: reason || null }),
    });
    if (!response.ok) throw new Error(`Failed to update local-only mode: ${response.status}`);
    return response.json();
}

export async function setGlobalModelPolicy(policy: ModelControlPolicy): Promise<ModelControlPolicy> {
    const response = await fetch("/api/model-control/policy", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...getAuthHeader() as any },
        body: JSON.stringify(policy),
    });
    if (!response.ok) throw new Error(`Failed to update model policy: ${response.status}`);
    return response.json();
}

export async function setProjectModelPolicy(projectId: string, policy: ModelControlPolicy): Promise<ModelControlPolicy> {
    const response = await fetch(`/api/model-control/projects/${encodeURIComponent(projectId)}/policy`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...getAuthHeader() as any },
        body: JSON.stringify(policy),
    });
    if (!response.ok) throw new Error(`Failed to update project model policy: ${response.status}`);
    return response.json();
}

export async function getLocalOnlyMode(projectId?: string | null): Promise<{ enabled: boolean; reason: string | null }> {
    const data = await getModelControlState(projectId);
    return data.localOnly || { enabled: false, reason: null };
}

export async function upsertGlobalModelAlias(alias: string, input: { target: string; description?: string | null; is_active?: boolean }): Promise<ModelControlAlias> {
    const response = await fetch(`/api/model-control/aliases/${encodeURIComponent(alias)}`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...getAuthHeader() as any },
        body: JSON.stringify(input),
    });
    if (!response.ok) throw new Error(`Failed to save global alias: ${response.status}`);
    return response.json();
}

export async function upsertProjectModelAlias(projectId: string, alias: string, input: { target: string; description?: string | null }): Promise<ModelControlAlias> {
    const response = await fetch(`/api/model-control/projects/${encodeURIComponent(projectId)}/aliases/${encodeURIComponent(alias)}`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...getAuthHeader() as any },
        body: JSON.stringify(input),
    });
    if (!response.ok) throw new Error(`Failed to save project alias: ${response.status}`);
    return response.json();
}

export interface ModelControlRole {
    role: string;
    assignment: string;
    description?: string | null;
    is_active?: boolean;
    resolvedProvider?: string | null;
    resolvedModel?: string | null;
    resolvedLabel?: string | null;
    source?: string | null;
}

export async function getModelRoles(): Promise<ModelControlRole[]> {
    const response = await fetch(`/api/model-control/roles`, {
        credentials: "include",
        headers: { ...getAuthHeader() as any },
        cache: "no-store",
    });
    if (!response.ok) throw new Error(`Failed to load model roles: ${response.status}`);
    const data = await response.json();
    return data.roles || [];
}

export async function upsertModelRole(role: string, input: { assignment: string; description?: string | null; is_active?: boolean }): Promise<ModelControlRole> {
    const response = await fetch(`/api/model-control/roles/${encodeURIComponent(role)}`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...getAuthHeader() as any },
        body: JSON.stringify(input),
    });
    if (!response.ok) throw new Error(`Failed to save model role: ${response.status}`);
    return response.json();
}

export function formatResolvedModel(resolved?: ResolvedModelControl | null): string {
    if (!resolved) return "";
    const label = resolved.label || resolved.apiModelId || resolved.resolvedModelId || "model";
    if (resolved.localOnlyActive) return `${label} (local only)`;
    if (resolved.fallbackUsed) return `${label} (fallback)`;
    return label;
}

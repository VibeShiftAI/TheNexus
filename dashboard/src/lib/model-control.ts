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

export async function getModelControlState(projectId?: string | null): Promise<ModelControlOptionsResponse> {
    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
    const response = await fetch(`/api/model-control/options${query}`, {
        credentials: "include",
        headers: { ...getAuthHeader() as any },
    });
    if (!response.ok) throw new Error(`Failed to load model-control state: ${response.status}`);
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

export function formatResolvedModel(resolved?: ResolvedModelControl | null): string {
    if (!resolved) return "";
    const label = resolved.label || resolved.apiModelId || resolved.resolvedModelId || "model";
    if (resolved.localOnlyActive) return `${label} (local only)`;
    if (resolved.fallbackUsed) return `${label} (fallback)`;
    return label;
}

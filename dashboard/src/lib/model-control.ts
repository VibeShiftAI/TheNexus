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

interface ModelControlOptionsResponse {
    models?: Array<{ id: string; name?: string; display_name?: string; provider?: string; api_model_id?: string; apiModelId?: string }>;
    aliases?: Array<{ alias: string; target: string; description?: string }>;
    projectAliases?: Array<{ alias: string; target: string; description?: string }>;
}

export async function getModelControlOptions(projectId?: string | null): Promise<ModelControlOption[]> {
    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
    const response = await fetch(`/api/model-control/options${query}`, {
        credentials: "include",
        headers: { ...getAuthHeader() as any },
    });
    if (!response.ok) throw new Error(`Failed to load model options: ${response.status}`);
    const data = await response.json() as ModelControlOptionsResponse;

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
    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
    const response = await fetch(`/api/model-control/options${query}`, {
        credentials: "include",
        headers: { ...getAuthHeader() as any },
    });
    if (!response.ok) throw new Error(`Failed to load local-only mode: ${response.status}`);
    const data = await response.json();
    return data.localOnly || { enabled: false, reason: null };
}

export function formatResolvedModel(resolved?: ResolvedModelControl | null): string {
    if (!resolved) return "";
    const label = resolved.label || resolved.apiModelId || resolved.resolvedModelId || "model";
    if (resolved.localOnlyActive) return `${label} (local only)`;
    if (resolved.fallbackUsed) return `${label} (fallback)`;
    return label;
}

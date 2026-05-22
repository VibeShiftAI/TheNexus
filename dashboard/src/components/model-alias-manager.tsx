"use client";

import { useEffect, useMemo, useState } from "react";
import { GitBranch, Loader2, Plus } from "lucide-react";
import {
    getModelControlState,
    upsertGlobalModelAlias,
    upsertProjectModelAlias,
    type ModelControlAlias,
    type ModelControlOptionsResponse,
} from "@/lib/model-control";

interface ModelAliasManagerProps {
    projectId?: string | null;
    compact?: boolean;
}

export function ModelAliasManager({ projectId = null, compact = false }: ModelAliasManagerProps) {
    const [state, setState] = useState<ModelControlOptionsResponse>({});
    const [alias, setAlias] = useState("coder");
    const [target, setTarget] = useState("");
    const [description, setDescription] = useState("");
    const [scope, setScope] = useState(projectId ? "project" : "global");
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const load = async () => {
        const next = await getModelControlState(projectId);
        setState(next);
        const defaultTarget = next.models?.[0]?.id ? `model:${next.models[0].id}` : next.aliases?.[0]?.target || "";
        if (!target && defaultTarget) setTarget(defaultTarget);
    };

    useEffect(() => {
        load().catch(err => setError(err.message));
    }, [projectId]);

    const targetOptions = useMemo(() => {
        const models = (state.models || []).map(model => ({
            value: `model:${model.id}`,
            label: model.display_name || model.name || model.id,
        }));
        const aliases = (state.aliases || []).map(item => ({
            value: `alias:${item.alias}`,
            label: `alias:${item.alias}`,
        }));
        return [...models, ...aliases.filter(item => item.value !== `alias:${alias}`)];
    }, [state, alias]);

    const projectAliases = state.projectAliases || [];
    const globalAliases = state.aliases || [];

    const saveAlias = async () => {
        if (!alias.trim() || !target) return;
        setSaving(true);
        setError(null);
        try {
            if (scope === "project" && projectId) {
                await upsertProjectModelAlias(projectId, alias.trim(), { target, description: description.trim() || null });
            } else {
                await upsertGlobalModelAlias(alias.trim(), { target, description: description.trim() || null, is_active: true });
            }
            setDescription("");
            await load();
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to save alias");
        } finally {
            setSaving(false);
        }
    };

    const renderAlias = (item: ModelControlAlias, prefix?: string) => (
        <div key={`${prefix || "global"}-${item.alias}`} className="flex items-center justify-between gap-2 rounded border border-slate-800 bg-slate-950/40 px-2 py-1.5">
            <div className="min-w-0">
                <div className="truncate text-xs font-medium text-slate-200">{prefix ? `${prefix}:` : ""}{item.alias}</div>
                <div className="truncate text-[11px] text-slate-500">{item.target}</div>
            </div>
            {item.description && <div className="hidden max-w-24 truncate text-[10px] text-slate-500 sm:block">{item.description}</div>}
        </div>
    );

    return (
        <div className={`rounded-lg border border-slate-800 bg-slate-950/40 ${compact ? "p-3" : "p-4"}`}>
            <div className="mb-3 flex items-center gap-2">
                <GitBranch size={14} className="text-cyan-400" />
                <h3 className="text-sm font-semibold text-slate-200">Model Aliases</h3>
            </div>

            <div className="space-y-2">
                {projectId && projectAliases.length > 0 && (
                    <div className="space-y-1">
                        {projectAliases.map(item => renderAlias(item, "project"))}
                    </div>
                )}
                {globalAliases.length > 0 && (
                    <div className="space-y-1">
                        {globalAliases.slice(0, compact ? 3 : 8).map(item => renderAlias(item))}
                    </div>
                )}
            </div>

            <div className="mt-3 grid gap-2">
                <div className="grid grid-cols-2 gap-2">
                    <input
                        value={alias}
                        onChange={event => setAlias(event.target.value)}
                        className="min-w-0 rounded border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-white outline-none focus:border-cyan-500"
                        placeholder="alias"
                    />
                    <select
                        value={scope}
                        onChange={event => setScope(event.target.value)}
                        className="rounded border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-white outline-none focus:border-cyan-500"
                    >
                        <option value="global">Global</option>
                        {projectId && <option value="project">Project</option>}
                    </select>
                </div>
                <select
                    value={target}
                    onChange={event => setTarget(event.target.value)}
                    className="rounded border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-white outline-none focus:border-cyan-500"
                >
                    {targetOptions.map(option => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                </select>
                {!compact && (
                    <input
                        value={description}
                        onChange={event => setDescription(event.target.value)}
                        className="rounded border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-white outline-none focus:border-cyan-500"
                        placeholder="description"
                    />
                )}
                {error && <div className="text-[11px] text-red-400">{error}</div>}
                <button
                    type="button"
                    onClick={saveAlias}
                    disabled={saving || !alias.trim() || !target}
                    className="flex items-center justify-center gap-1.5 rounded border border-cyan-500/30 bg-cyan-500/10 px-2 py-1.5 text-xs font-medium text-cyan-300 transition-colors hover:bg-cyan-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                >
                    {saving ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
                    Save Alias
                </button>
            </div>
        </div>
    );
}

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import Link from "next/link";
import {
    AlertTriangle,
    ArrowLeft,
    Bot,
    Brain,
    CheckCircle2,
    Clock,
    Cpu,
    GitBranch,
    History,
    Loader2,
    RefreshCw,
    Route,
    Shield,
    Sparkles,
    WifiOff,
} from "lucide-react";
import { ModelAliasManager } from "@/components/model-alias-manager";
import {
    getModelControlState,
    getModelExecutionSnapshots,
    resolveModelAssignment,
    setLocalOnlyMode,
    type ModelControlModel,
    type ModelControlOptionsResponse,
    type ModelExecutionSnapshot,
    type ResolvedModelControl,
} from "@/lib/model-control";
import { getProjects, type Project } from "@/lib/nexus";

const ROLE_ALIASES = ["local_default", "coder", "planner", "researcher", "reviewer", "summarizer"];

function formatDate(value?: string | null) {
    if (!value) return "unknown";
    return new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
    }).format(new Date(value));
}

function formatTarget(value?: string | null) {
    if (!value) return "unassigned";
    return value.replace(/^model:/, "").replace(/^alias:/, "@");
}

function modelLabel(model: ModelControlModel) {
    return model.display_name || model.name || model.api_model_id || model.id;
}

function providerTone(provider?: string | null) {
    const normalized = String(provider || "unknown").toLowerCase();
    if (normalized === "local") return "border-teal-500/30 bg-teal-500/10 text-teal-200";
    if (normalized === "anthropic") return "border-amber-500/30 bg-amber-500/10 text-amber-200";
    if (normalized === "openai") return "border-emerald-500/30 bg-emerald-500/10 text-emerald-200";
    if (normalized === "google") return "border-blue-500/30 bg-blue-500/10 text-blue-200";
    if (normalized === "xai") return "border-pink-500/30 bg-pink-500/10 text-pink-200";
    return "border-slate-700 bg-slate-800/70 text-slate-300";
}

function destinationLabel(snapshot: ModelExecutionSnapshot) {
    if (snapshot.task_id) return `task ${snapshot.task_id}`;
    if (snapshot.node_id) return `node ${snapshot.node_id}`;
    if (snapshot.workflow_id) return `workflow ${snapshot.workflow_id}`;
    if (snapshot.calendar_event_id) return `calendar ${snapshot.calendar_event_id}`;
    if (snapshot.command_id) return `command ${snapshot.command_id}`;
    if (snapshot.conversation_id) return `terminal ${snapshot.conversation_id}`;
    return "system";
}

function StatCard({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
    return (
        <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-4">
            <div className="mb-3 text-slate-500">{icon}</div>
            <div className="text-2xl font-semibold text-white">{value}</div>
            <div className="mt-1 text-xs text-slate-500">{label}</div>
        </div>
    );
}

function ExecutionRow({ snapshot }: { snapshot: ModelExecutionSnapshot }) {
    return (
        <div className="grid gap-3 border-b border-slate-900 px-4 py-3 text-sm last:border-0 lg:grid-cols-[150px_minmax(0,1.3fr)_minmax(0,1fr)_120px_110px]">
            <div className="flex items-center gap-2 text-slate-500">
                <Clock size={14} />
                {formatDate(snapshot.created_at)}
            </div>
            <div className="min-w-0">
                <div className="truncate font-medium text-slate-200">{snapshot.api_model_id || snapshot.resolved_model_id || "unresolved"}</div>
                <div className="truncate text-xs text-slate-500">{formatTarget(snapshot.requested_assignment)} to {formatTarget(snapshot.resolved_model_id)}</div>
            </div>
            <div className="truncate text-slate-400">{destinationLabel(snapshot)}</div>
            <div>
                <span className={`inline-flex rounded border px-2 py-0.5 text-xs ${providerTone(snapshot.provider)}`}>
                    {snapshot.provider || "unknown"}
                </span>
            </div>
            <div className="flex gap-2">
                {snapshot.fallback_used && <span className="rounded border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-xs text-amber-200">fallback</span>}
                {snapshot.local_only_active && <span className="rounded border border-teal-500/30 bg-teal-500/10 px-2 py-0.5 text-xs text-teal-200">local</span>}
            </div>
            {(snapshot.fallback_reason || snapshot.local_only_reason) && (
                <div className="text-xs text-slate-500 lg:col-span-5">
                    {snapshot.fallback_reason || snapshot.local_only_reason}
                </div>
            )}
        </div>
    );
}

export default function ModelControlPage() {
    const [state, setState] = useState<ModelControlOptionsResponse>({});
    const [projects, setProjects] = useState<Project[]>([]);
    const [projectId, setProjectId] = useState<string>("");
    const [history, setHistory] = useState<ModelExecutionSnapshot[]>([]);
    const [roleResolutions, setRoleResolutions] = useState<Record<string, ResolvedModelControl>>({});
    const [localReason, setLocalReason] = useState("manual_override");
    const [loading, setLoading] = useState(true);
    const [savingLocal, setSavingLocal] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const [controlState, projectList, executions] = await Promise.all([
                getModelControlState(projectId || null),
                getProjects().catch(() => []),
                getModelExecutionSnapshots({ projectId: projectId || null, limit: 60 }),
            ]);
            setState(controlState);
            setProjects(projectList);
            setHistory(executions.snapshots || []);
            setLocalReason(controlState.localOnly?.reason || "manual_override");

            const resolutions: Record<string, ResolvedModelControl> = {};
            await Promise.all(ROLE_ALIASES.map(async (alias) => {
                try {
                    resolutions[alias] = await resolveModelAssignment({
                        model_assignment: `alias:${alias}`,
                        projectId: projectId || null,
                        role: alias,
                    });
                } catch (_err) {
                    resolutions[alias] = { requestedAssignment: `alias:${alias}`, fallbackUsed: true, fallbackReason: "unresolved" };
                }
            }));
            setRoleResolutions(resolutions);
            setError(null);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to load model control center");
        } finally {
            setLoading(false);
        }
    }, [projectId]);

    useEffect(() => {
        load();
    }, [load]);

    const stats = useMemo(() => {
        const models = state.models || [];
        const providers = new Set(models.map(model => model.provider).filter(Boolean));
        return {
            models: models.length,
            providers: providers.size,
            aliases: (state.aliases || []).length + (state.projectAliases || []).length,
            fallbacks: history.filter(item => item.fallback_used).length,
        };
    }, [state, history]);

    const toggleLocalOnly = async () => {
        const enabled = !(state.localOnly?.enabled);
        setSavingLocal(true);
        try {
            const updated = await setLocalOnlyMode(enabled, enabled ? localReason : null);
            setState(prev => ({ ...prev, localOnly: updated }));
            setLocalReason(updated.reason || "manual_override");
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to update local-only mode");
        } finally {
            setSavingLocal(false);
        }
    };

    return (
        <main className="min-h-screen bg-[#090d14] text-slate-200">
            <div className="mx-auto max-w-7xl px-5 py-6">
                <header className="mb-6 flex flex-col gap-4 border-b border-slate-800 pb-5 lg:flex-row lg:items-center lg:justify-between">
                    <div className="flex items-center gap-3">
                        <Link href="/" className="rounded border border-slate-800 bg-slate-950/60 p-2 text-slate-400 hover:text-white" aria-label="Back to dashboard">
                            <ArrowLeft size={18} />
                        </Link>
                        <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-cyan-500/30 bg-cyan-500/10 text-cyan-300">
                            <Route size={20} />
                        </div>
                        <div>
                            <h1 className="text-2xl font-semibold tracking-tight text-white">Model Control Center</h1>
                            <div className="text-sm text-slate-500">Assignments, aliases, local policy, and execution decisions</div>
                        </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        <select
                            value={projectId}
                            onChange={(event) => setProjectId(event.target.value)}
                            className="rounded border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-cyan-500"
                        >
                            <option value="">Global scope</option>
                            {projects.map(project => (
                                <option key={project.id} value={project.id}>{project.name}</option>
                            ))}
                        </select>
                        <button
                            type="button"
                            onClick={load}
                            disabled={loading}
                            className="inline-flex items-center gap-2 rounded border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-300 hover:border-slate-600 hover:text-white disabled:opacity-50"
                        >
                            <RefreshCw size={15} className={loading ? "animate-spin" : ""} />
                            Refresh
                        </button>
                    </div>
                </header>

                {error && (
                    <div className="mb-4 flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
                        <AlertTriangle size={16} />
                        {error}
                    </div>
                )}

                <section className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <StatCard icon={<Brain size={18} />} label="Active models" value={String(stats.models)} />
                    <StatCard icon={<Cpu size={18} />} label="Providers" value={String(stats.providers)} />
                    <StatCard icon={<GitBranch size={18} />} label="Role aliases" value={String(stats.aliases)} />
                    <StatCard icon={<Shield size={18} />} label="Recent fallbacks" value={String(stats.fallbacks)} />
                </section>

                <section className="mb-6 grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
                    <div className={`rounded-lg border p-4 ${state.localOnly?.enabled ? "border-amber-500/40 bg-amber-500/10" : "border-slate-800 bg-slate-950/50"}`}>
                        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                            <div className="flex items-center gap-3">
                                {state.localOnly?.enabled ? <WifiOff size={22} className="text-amber-300" /> : <CheckCircle2 size={22} className="text-emerald-300" />}
                                <div>
                                    <div className="text-base font-semibold text-white">Global Local Only</div>
                                    <div className="text-sm text-slate-500">{state.localOnly?.enabled ? (state.localOnly.reason || "manual_override") : "Cloud providers are eligible"}</div>
                                </div>
                            </div>
                            <div className="flex flex-col gap-2 sm:flex-row">
                                <input
                                    value={localReason}
                                    onChange={(event) => setLocalReason(event.target.value)}
                                    disabled={state.localOnly?.enabled}
                                    className="rounded border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-cyan-500 disabled:opacity-50"
                                    placeholder="reason"
                                />
                                <button
                                    type="button"
                                    onClick={toggleLocalOnly}
                                    disabled={savingLocal}
                                    className={`inline-flex items-center justify-center gap-2 rounded border px-3 py-2 text-sm font-medium ${state.localOnly?.enabled ? "border-amber-500/40 bg-amber-500/20 text-amber-100" : "border-teal-500/30 bg-teal-500/10 text-teal-200"} disabled:opacity-50`}
                                >
                                    {savingLocal ? <Loader2 size={15} className="animate-spin" /> : <WifiOff size={15} />}
                                    {state.localOnly?.enabled ? "Disable" : "Enable"}
                                </button>
                            </div>
                        </div>

                        <div className="mt-5 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                            {ROLE_ALIASES.map(alias => {
                                const resolved = roleResolutions[alias];
                                return (
                                    <div key={alias} className="rounded border border-slate-800 bg-slate-950/50 p-3">
                                        <div className="mb-2 flex items-center justify-between gap-2">
                                            <span className="font-mono text-xs text-cyan-300">@{alias}</span>
                                            {resolved?.fallbackUsed && <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-200">fallback</span>}
                                        </div>
                                        <div className="truncate text-sm font-medium text-white">{resolved?.label || resolved?.apiModelId || "unresolved"}</div>
                                        <div className="truncate text-xs text-slate-500">{resolved?.provider || resolved?.fallbackReason || "no resolution"}</div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>

                    <ModelAliasManager projectId={projectId || null} />
                </section>

                <section className="mb-6 rounded-lg border border-slate-800 bg-slate-950/50">
                    <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
                        <div className="flex items-center gap-2">
                            <Bot size={16} className="text-cyan-300" />
                            <h2 className="font-semibold text-white">Model Inventory</h2>
                        </div>
                        <span className="text-xs text-slate-500">{stats.models} active</span>
                    </div>
                    <div className="grid gap-0 md:grid-cols-2 xl:grid-cols-3">
                        {(state.models || []).map(model => {
                            const caps = Object.entries(model.capabilities || {}).filter(([, enabled]) => enabled).map(([key]) => key);
                            return (
                                <div key={model.id} className="border-b border-r border-slate-900 p-4">
                                    <div className="mb-2 flex items-start justify-between gap-3">
                                        <div className="min-w-0">
                                            <div className="truncate font-medium text-white">{modelLabel(model)}</div>
                                            <div className="truncate text-xs text-slate-500">{model.api_model_id || model.apiModelId || model.id}</div>
                                        </div>
                                        <span className={`shrink-0 rounded border px-2 py-0.5 text-xs ${providerTone(model.provider)}`}>{model.provider || "model"}</span>
                                    </div>
                                    <div className="flex flex-wrap gap-1.5">
                                        {(caps.length ? caps : ["chat"]).slice(0, 5).map(capability => (
                                            <span key={capability} className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400">{capability}</span>
                                        ))}
                                    </div>
                                    <div className="mt-3 flex items-center gap-2 text-[11px] text-slate-600">
                                        <Sparkles size={12} />
                                        {model.last_seen_at ? `seen ${formatDate(model.last_seen_at)}` : model.availability_status || "registered"}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                    {!loading && (state.models || []).length === 0 && (
                        <div className="px-4 py-8 text-center text-sm text-slate-500">No active models registered</div>
                    )}
                </section>

                <section className="rounded-lg border border-slate-800 bg-slate-950/50">
                    <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
                        <div className="flex items-center gap-2">
                            <History size={16} className="text-cyan-300" />
                            <h2 className="font-semibold text-white">Execution Audit Trail</h2>
                        </div>
                        <span className="text-xs text-slate-500">{history.length} shown</span>
                    </div>
                    <div>
                        {history.map(snapshot => <ExecutionRow key={snapshot.id} snapshot={snapshot} />)}
                        {!loading && history.length === 0 && (
                            <div className="px-4 py-8 text-center text-sm text-slate-500">No model executions recorded for this scope</div>
                        )}
                        {loading && (
                            <div className="flex items-center justify-center gap-2 px-4 py-8 text-sm text-slate-500">
                                <Loader2 size={16} className="animate-spin" />
                                Loading model control state
                            </div>
                        )}
                    </div>
                </section>
            </div>
        </main>
    );
}

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
import { ModelRoleManager } from "@/components/model-role-manager";
import { UsageRoutingPanel } from "@/components/usage-routing-panel";
import { ModelStatusPanel } from "@/components/model-status-panel";
import {
    getModelControlState,
    getModelBudgetStatus,
    getModelExecutionSnapshots,
    resolveModelAssignment,
    runModelControlProbe,
    runModelDiscovery,
    setLocalOnlyMode,
    setGlobalModelPolicy,
    setProjectModelPolicy,
    setClaudeDefaultModel,
    setCodexDefaultModel,
    setAntigravityDefaultModel,
    setThinkingLevel,
    filterClaudeModels,
    filterCodexModels,
    getAntigravityModels,
    apiModelIdOf,
    setAgentBackend,
    setChatBackend,
    AGENT_BACKENDS,
    AGENT_BACKEND_LABELS,
    CHAT_BACKENDS,
    CHAT_BACKEND_LABELS,
    type AgentBackend,
    type AgentBackendConfig,
    type ChatBackend,
    type ModelDiscoveryResult,
    type ModelDiscoveryProviderStatus,
    type ModelControlPolicy,
    type ModelBudgetStatus,
    type ModelControlProbeResult,
    type ModelControlModel,
    type ModelControlOptionsResponse,
    type ModelExecutionSnapshot,
    type ResolvedModelControl,
} from "@/lib/model-control";
import { getProjects, type Project } from "@/lib/nexus";

const ROLE_ALIASES = ["local_default", "coder", "planner", "researcher", "reviewer", "summarizer"];
const CAPABILITY_OPTIONS = ["chat", "coding", "reasoning", "vision", "local"];
const DEFAULT_POLICY: ModelControlPolicy = { enabled: false, requiredCapabilities: [], fallbackChain: [], budget: {} };
const PROVIDERS = ["anthropic", "openai", "google", "xai", "openrouter", "local"];

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

function ageInHours(value?: string | null) {
    if (!value) return Number.POSITIVE_INFINITY;
    const time = new Date(value).getTime();
    if (Number.isNaN(time)) return Number.POSITIVE_INFINITY;
    return (Date.now() - time) / (1000 * 60 * 60);
}

function isNewModel(model: ModelControlModel) {
    return ageInHours(model.discovered_at) <= 72;
}

function isStaleModel(model: ModelControlModel) {
    return ageInHours(model.last_seen_at) > 24 * 14;
}

function providerTone(provider?: string | null) {
    const normalized = String(provider || "unknown").toLowerCase();
    if (normalized === "local") return "border-teal-500/30 bg-teal-500/10 text-teal-200";
    if (normalized === "anthropic") return "border-amber-500/30 bg-amber-500/10 text-amber-200";
    if (normalized === "openai") return "border-emerald-500/30 bg-emerald-500/10 text-emerald-200";
    if (normalized === "google") return "border-blue-500/30 bg-blue-500/10 text-blue-200";
    if (normalized === "xai") return "border-pink-500/30 bg-pink-500/10 text-pink-200";
    // Violet matches the openrouter series colour on the llm-activity chart.
    if (normalized === "openrouter") return "border-violet-500/30 bg-violet-500/10 text-violet-200";
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

/**
 * Thinking levels a model's CLI will actually accept. Mirrors the server's
 * per-slug rules (server/services/model-discovery.js OPENAI_MODEL_EFFORT_TIERS
 * and `claude --effort`); the PUT re-validates, this only shapes the dropdown.
 * "ultra" is deliberately not offered — it is an agentic mode, not an effort.
 */
function thinkingLevelOptions(modelId: string): string[] {
    const slug = (modelId || "").trim().toLowerCase();
    if (slug.startsWith("gpt-5.6")) return ["low", "medium", "high", "xhigh", "max"];
    if (slug.startsWith("gpt-")) return ["low", "medium", "high", "xhigh"];
    if (slug.includes("claude")) return ["low", "medium", "high", "xhigh", "max"];
    return ["low", "medium", "high"];
}

export default function ModelControlPage() {
    const [state, setState] = useState<ModelControlOptionsResponse>({});
    const [projects, setProjects] = useState<Project[]>([]);
    const [projectId, setProjectId] = useState<string>("");
    const [history, setHistory] = useState<ModelExecutionSnapshot[]>([]);
    const [roleResolutions, setRoleResolutions] = useState<Record<string, ResolvedModelControl>>({});
    const [budgetStatus, setBudgetStatus] = useState<ModelBudgetStatus | null>(null);
    const [probeResult, setProbeResult] = useState<ModelControlProbeResult | null>(null);
    const [discovery, setDiscovery] = useState<ModelDiscoveryResult | null>(null);
    const [probeAssignment, setProbeAssignment] = useState("alias:coder");
    const [probePrompt, setProbePrompt] = useState("Reply with exactly: model control probe ok");
    const [localReason, setLocalReason] = useState("manual_override");
    const [loading, setLoading] = useState(true);
    const [savingLocal, setSavingLocal] = useState(false);
    const [savingThinkingModel, setSavingThinkingModel] = useState<string | null>(null);
    const [savingClaudeDefault, setSavingClaudeDefault] = useState(false);
    const [savingCodexDefault, setSavingCodexDefault] = useState(false);
    const [savingAntigravityDefault, setSavingAntigravityDefault] = useState(false);
    const [antigravityModels, setAntigravityModels] = useState<string[]>([]);
    const [savingAgentBackend, setSavingAgentBackend] = useState(false);
    const [savingChatBackend, setSavingChatBackend] = useState(false);
    const [discovering, setDiscovering] = useState(false);
    const [probing, setProbing] = useState<"resolve" | "live" | null>(null);
    const [savingPolicy, setSavingPolicy] = useState(false);
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
            getModelBudgetStatus(projectId || null)
                .then(setBudgetStatus)
                .catch(() => setBudgetStatus(null));

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

    // The agy CLI's model roster (display names) — loaded once; independent of
    // the project filter.
    useEffect(() => {
        getAntigravityModels().then(setAntigravityModels).catch(() => setAntigravityModels([]));
    }, []);

    const stats = useMemo(() => {
        const models = state.models || [];
        const providers = new Set(models.map(model => model.provider).filter(Boolean));
        return {
            models: models.length,
            providers: providers.size,
            aliases: (state.aliases || []).length + (state.projectAliases || []).length,
            fallbacks: history.filter(item => item.fallback_used).length,
            stale: models.filter(isStaleModel).length,
            fresh: models.filter(isNewModel).length,
            lastSeen: models
                .map(model => model.last_seen_at)
                .filter(Boolean)
                .sort()
                .at(-1) || null,
        };
    }, [state, history]);

    const providerStatuses: ModelDiscoveryProviderStatus[] = discovery?.providers || ["google", "openai", "anthropic", "xai"].map(provider => ({
        provider,
        status: (state.models || []).some(model => model.provider === provider) ? "registry" : "unknown",
        rawCount: 0,
        modelCount: (state.models || []).filter(model => model.provider === provider).length,
    }));

    const activePolicy = projectId
        ? (state.projectPolicy || state.policy || DEFAULT_POLICY)
        : (state.policy || DEFAULT_POLICY);
    const fallbackText = (activePolicy.fallbackChain || []).join("\n");
    const budget = activePolicy.budget || {};
    const providerLimits = budget.providerLimits || {};

    const updateAgentBackend = async (primary: AgentBackend, fallback: AgentBackend | "") => {
        setSavingAgentBackend(true);
        setError(null);
        try {
            // Chain: primary → chosen fallback → the rest; gemini is always
            // the implicit last resort server-side.
            const fallbacks = [
                ...(fallback && fallback !== primary ? [fallback] : []),
                ...AGENT_BACKENDS.filter(b => b !== primary && b !== fallback),
            ];
            const saved = await setAgentBackend({ backend: primary, fallbacks });
            setState(prev => ({ ...prev, agentBackend: saved }));
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to update agent backend");
        } finally {
            setSavingAgentBackend(false);
        }
    };

    const updateChatBackend = async (backend: ChatBackend) => {
        setSavingChatBackend(true);
        setError(null);
        try {
            const saved = await setChatBackend(backend);
            setState(prev => ({ ...prev, chatBackend: saved }));
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to update chat backend");
        } finally {
            setSavingChatBackend(false);
        }
    };

    /**
     * Per-model default thinking level. Praxis applies this to any dispatch
     * (task, QA, correction, chat) whose resolved model matches and that
     * carries no explicit level of its own.
     */
    const updateThinkingLevel = async (model: string, level: string) => {
        setSavingThinkingModel(model);
        setError(null);
        try {
            const levels = await setThinkingLevel(model, level);
            setState(prev => ({ ...prev, thinkingLevels: levels }));
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to update thinking level");
        } finally {
            setSavingThinkingModel(null);
        }
    };

    const updateClaudeDefault = async (model: string) => {
        setSavingClaudeDefault(true);
        setError(null);
        try {
            const saved = await setClaudeDefaultModel(model);
            setState(prev => ({ ...prev, claudeDefault: saved }));
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to update Claude default model");
        } finally {
            setSavingClaudeDefault(false);
        }
    };

    const updateCodexDefault = async (model: string) => {
        setSavingCodexDefault(true);
        setError(null);
        try {
            const saved = await setCodexDefaultModel(model);
            setState(prev => ({ ...prev, codexDefault: saved }));
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to update Codex default model");
        } finally {
            setSavingCodexDefault(false);
        }
    };

    const updateAntigravityDefault = async (model: string) => {
        setSavingAntigravityDefault(true);
        setError(null);
        try {
            const saved = await setAntigravityDefaultModel(model);
            setState(prev => ({ ...prev, antigravityDefault: saved }));
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to update Antigravity default model");
        } finally {
            setSavingAntigravityDefault(false);
        }
    };

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

    const runDiscovery = async () => {
        setDiscovering(true);
        try {
            const result = await runModelDiscovery();
            setDiscovery(result);
            await load();
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to run model discovery");
        } finally {
            setDiscovering(false);
        }
    };

    const runProbe = async (mode: "resolve" | "live") => {
        setProbing(mode);
        try {
            const result = await runModelControlProbe({
                mode,
                model_assignment: probeAssignment,
                projectId: projectId || null,
                role: "model_control_probe",
                prompt: probePrompt,
            });
            setProbeResult(result);
            setError(null);
            if (mode === "live") await load();
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to run model-control probe");
        } finally {
            setProbing(null);
        }
    };

    const updatePolicy = async (next: ModelControlPolicy) => {
        setSavingPolicy(true);
        try {
            const saved = projectId
                ? await setProjectModelPolicy(projectId, next)
                : await setGlobalModelPolicy(next);
            setState(prev => projectId ? { ...prev, projectPolicy: saved } : { ...prev, policy: saved });
            setError(null);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to update model policy");
        } finally {
            setSavingPolicy(false);
        }
    };

    const toggleCapability = (capability: string) => {
        const current = new Set(activePolicy.requiredCapabilities || []);
        if (current.has(capability)) current.delete(capability);
        else current.add(capability);
        updatePolicy({
            ...activePolicy,
            requiredCapabilities: Array.from(current),
        });
    };

    const saveFallbackChain = (value: string) => {
        updatePolicy({
            ...activePolicy,
            fallbackChain: value.split(/\r?\n|,/).map(item => item.trim()).filter(Boolean),
        });
    };

    const saveBudget = (patch: Partial<NonNullable<ModelControlPolicy["budget"]>>) => {
        updatePolicy({
            ...activePolicy,
            budget: {
                ...(activePolicy.budget || {}),
                ...patch,
            },
        });
    };

    const saveProviderBudget = (provider: string, patch: { dailyTokenLimit?: number | null; dailyCostLimit?: number | null }) => {
        saveBudget({
            providerLimits: {
                ...providerLimits,
                [provider]: {
                    ...(providerLimits[provider] || {}),
                    ...patch,
                },
            },
        });
    };

    const formatMoney = (value?: number | null) => {
        if (!value) return "$0.00";
        return `$${value.toFixed(value < 1 ? 4 : 2)}`;
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

                <ModelStatusPanel />

                <section className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <StatCard icon={<Brain size={18} />} label="Active models" value={String(stats.models)} />
                    <StatCard icon={<Cpu size={18} />} label="Providers" value={String(stats.providers)} />
                    <StatCard icon={<GitBranch size={18} />} label="Role aliases" value={String(stats.aliases)} />
                    <StatCard icon={<Shield size={18} />} label="Recent fallbacks" value={String(stats.fallbacks)} />
                </section>

                <section className="mb-6 rounded-lg border border-slate-800 bg-slate-950/50 p-4">
                    <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                        <div className="flex items-start gap-3">
                            <div className="rounded-lg border border-cyan-500/30 bg-cyan-500/10 p-2 text-cyan-300">
                                <Sparkles size={18} />
                            </div>
                            <div>
                                <div className="font-semibold text-white">Model Discovery</div>
                                <div className="text-sm text-slate-500">
                                    {discovery
                                        ? `Last manual scan ${formatDate(discovery.discoveredAt)} in ${discovery.elapsedMs}ms`
                                        : stats.lastSeen
                                            ? `Registry last saw a model ${formatDate(stats.lastSeen)}`
                                            : "Registry has not recorded a discovery scan"}
                                </div>
                            </div>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                            {stats.fresh > 0 && <span className="rounded border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-xs text-emerald-200">{stats.fresh} new</span>}
                            {stats.stale > 0 && <span className="rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-xs text-amber-200">{stats.stale} stale</span>}
                            <button
                                type="button"
                                onClick={runDiscovery}
                                disabled={discovering || loading}
                                className="inline-flex items-center gap-2 rounded border border-cyan-500/30 bg-cyan-500/10 px-3 py-2 text-sm font-medium text-cyan-200 hover:bg-cyan-500/20 disabled:opacity-50"
                            >
                                {discovering ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
                                Discover Now
                            </button>
                        </div>
                    </div>
                    <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                        {providerStatuses.map(provider => (
                            <div key={provider.provider} className="rounded border border-slate-800 bg-slate-950/70 px-3 py-2">
                                <div className="flex items-center justify-between gap-2">
                                    <span className="text-sm font-medium text-slate-200">{provider.provider}</span>
                                    <span className={`rounded px-1.5 py-0.5 text-[10px] ${provider.status === "ok" || provider.status === "registry" ? "bg-emerald-500/10 text-emerald-200" : provider.status === "skipped" ? "bg-slate-800 text-slate-400" : "bg-red-500/10 text-red-200"}`}>
                                        {provider.status}
                                    </span>
                                </div>
                                <div className="mt-1 text-xs text-slate-500">
                                    {provider.modelCount} models{provider.rawCount ? ` from ${provider.rawCount} raw` : ""}
                                </div>
                                {provider.message && <div className="mt-1 truncate text-[11px] text-slate-600">{provider.message}</div>}
                            </div>
                        ))}
                    </div>
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
                                    <div className="mb-2 flex flex-wrap gap-1.5">
                                        {model.family && <span className="rounded bg-cyan-500/10 px-1.5 py-0.5 text-[10px] text-cyan-200">latest {model.family}</span>}
                                        {isNewModel(model) && <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-200">new</span>}
                                        {isStaleModel(model) && <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-200">stale</span>}
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

                {/* Praxis Chat Backend — which engine fronts Robert's
                    interactive chat: a PERMANENT CLI session (Claude/Codex,
                    resumed per message, auto-compacted after 2h idle) or the
                    legacy in-process routed-LLM loop. Praxis falls back to the
                    legacy loop per-message on any CLI failure. */}
                <section className="mb-6 rounded-lg border border-slate-800 bg-slate-950/50 p-4">
                    <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                        <div className="flex items-center gap-3">
                            <Bot size={22} className="text-cyan-300" />
                            <div>
                                <div className="text-base font-semibold text-white">Praxis Chat Backend</div>
                                <div className="text-sm text-slate-500">
                                    Your primary chat responder: a permanent CLI session with the full toolset (resumes across messages, compacts after 2h idle), or the legacy routed LLM. CLI failures fall back to the legacy loop automatically.
                                </div>
                            </div>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                            <label className="text-xs text-slate-400">Session</label>
                            <select
                                value={state.chatBackend || "claude-code"}
                                onChange={(event) => void updateChatBackend(event.target.value as ChatBackend)}
                                disabled={savingChatBackend || loading}
                                className="rounded border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-cyan-500 disabled:opacity-50"
                            >
                                {CHAT_BACKENDS.map(backend => (
                                    <option key={backend} value={backend}>{CHAT_BACKEND_LABELS[backend]}</option>
                                ))}
                            </select>
                            {savingChatBackend && <Loader2 size={15} className="animate-spin text-slate-400" />}
                        </div>
                    </div>
                </section>

                {/* Praxis Agent Backend — which engine runs autonomous system
                    agent tasks (wakeups, morning routine, HITL resumes). CLI
                    backends run on signed-in subscriptions; Gemini API is the
                    always-available last resort. */}
                <section className="mb-6 rounded-lg border border-slate-800 bg-slate-950/50 p-4">
                    <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                        <div className="flex items-center gap-3">
                            <Brain size={22} className="text-cyan-300" />
                            <div>
                                <div className="text-base font-semibold text-white">Praxis Agent Backend</div>
                                <div className="text-sm text-slate-500">
                                    Runs autonomous system tasks (wakeups, morning routine, HITL resumes). Falls through automatically on usage limits; Gemini API is always the final fallback.
                                </div>
                            </div>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                            <label className="text-xs text-slate-400">Primary</label>
                            <select
                                value={state.agentBackend?.backend || "codex"}
                                onChange={(event) =>
                                    void updateAgentBackend(
                                        event.target.value as AgentBackend,
                                        state.agentBackend?.fallbacks?.[0] ?? "",
                                    )
                                }
                                disabled={savingAgentBackend || loading}
                                className="rounded border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-cyan-500 disabled:opacity-50"
                            >
                                {AGENT_BACKENDS.map(backend => (
                                    <option key={backend} value={backend}>{AGENT_BACKEND_LABELS[backend]}</option>
                                ))}
                            </select>
                            <label className="text-xs text-slate-400">Fallback</label>
                            <select
                                value={state.agentBackend?.fallbacks?.[0] || ""}
                                onChange={(event) =>
                                    void updateAgentBackend(
                                        (state.agentBackend?.backend || "codex") as AgentBackend,
                                        event.target.value as AgentBackend | "",
                                    )
                                }
                                disabled={savingAgentBackend || loading}
                                className="rounded border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-cyan-500 disabled:opacity-50"
                            >
                                <option value="">(straight to Gemini API)</option>
                                {AGENT_BACKENDS.filter(b => b !== (state.agentBackend?.backend || "codex")).map(backend => (
                                    <option key={backend} value={backend}>{AGENT_BACKEND_LABELS[backend]}</option>
                                ))}
                            </select>
                            {savingAgentBackend && <Loader2 size={15} className="animate-spin text-slate-400" />}
                        </div>
                    </div>
                </section>

                {/* Claude Code default — the model Praxis's claude-code executor
                    uses when a task/slot has no explicit model override. Runs on
                    the Claude subscription, so higher tiers cost usage window,
                    not API dollars. */}
                <section className="mb-6 rounded-lg border border-slate-800 bg-slate-950/50 p-4">
                    <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                        <div className="flex items-center gap-3">
                            <Bot size={22} className="text-purple-300" />
                            <div>
                                <div className="text-base font-semibold text-white">Claude Code Default Model</div>
                                <div className="text-sm text-slate-500">
                                    Used for claude-code dispatches without a per-task or per-slot model override. Billed to the Claude subscription.
                                </div>
                            </div>
                        </div>
                        <div className="flex items-center gap-2">
                            <select
                                value={state.claudeDefault || "claude-opus-5"}
                                onChange={(event) => void updateClaudeDefault(event.target.value)}
                                disabled={savingClaudeDefault || loading}
                                className="rounded border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-purple-500 disabled:opacity-50"
                            >
                                {filterClaudeModels(state.models).map(model => (
                                    <option key={model.id} value={apiModelIdOf(model)}>
                                        {model.display_name || model.name || model.id}
                                    </option>
                                ))}
                                {/* Keep the current value selectable even if discovery hasn't listed it */}
                                {state.claudeDefault &&
                                    !filterClaudeModels(state.models).some(m => apiModelIdOf(m) === state.claudeDefault) && (
                                        <option value={state.claudeDefault}>{state.claudeDefault}</option>
                                    )}
                            </select>
                            {savingClaudeDefault && <Loader2 size={15} className="animate-spin text-slate-400" />}
                        </div>
                    </div>
                </section>

                {/* Codex default — the model Praxis's codex executor uses when a
                    task/slot has no explicit model override. Empty = the codex
                    CLI's own default. Billed to the ChatGPT subscription. */}
                <section className="mb-6 rounded-lg border border-slate-800 bg-slate-950/50 p-4">
                    <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                        <div className="flex items-center gap-3">
                            <Bot size={22} className="text-emerald-300" />
                            <div>
                                <div className="text-base font-semibold text-white">Codex Default Model</div>
                                <div className="text-sm text-slate-500">
                                    Used for codex dispatches without a per-task or per-slot model override. Billed to the ChatGPT subscription.
                                </div>
                            </div>
                        </div>
                        <div className="flex items-center gap-2">
                            <select
                                value={state.codexDefault || ""}
                                onChange={(event) => void updateCodexDefault(event.target.value)}
                                disabled={savingCodexDefault || loading}
                                className="rounded border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-emerald-500 disabled:opacity-50"
                            >
                                <option value="">CLI default</option>
                                {filterCodexModels(state.models).map(model => (
                                    <option key={model.id} value={apiModelIdOf(model)}>
                                        {model.display_name || model.name || model.id}
                                    </option>
                                ))}
                                {/* Keep the current value selectable even if discovery hasn't listed it */}
                                {state.codexDefault &&
                                    !filterCodexModels(state.models).some(m => apiModelIdOf(m) === state.codexDefault) && (
                                        <option value={state.codexDefault}>{state.codexDefault}</option>
                                    )}
                            </select>
                            {savingCodexDefault && <Loader2 size={15} className="animate-spin text-slate-400" />}
                        </div>
                    </div>
                </section>

                {/* Antigravity default — the model Praxis's antigravity executor
                    pins via `agy --model`. Options are the `agy models` display
                    names (slug ids silently fail to pin). Empty = the agy CLI's
                    own default. Billed to the Google subscription. */}
                <section className="mb-6 rounded-lg border border-slate-800 bg-slate-950/50 p-4">
                    <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                        <div className="flex items-center gap-3">
                            <Bot size={22} className="text-sky-300" />
                            <div>
                                <div className="text-base font-semibold text-white">Antigravity Default Model</div>
                                <div className="text-sm text-slate-500">
                                    Used for antigravity (agy) dispatches without a per-task or per-slot model override. Billed to the Google subscription.
                                </div>
                            </div>
                        </div>
                        <div className="flex items-center gap-2">
                            <select
                                value={state.antigravityDefault || ""}
                                onChange={(event) => void updateAntigravityDefault(event.target.value)}
                                disabled={savingAntigravityDefault || loading}
                                className="rounded border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-sky-500 disabled:opacity-50"
                            >
                                <option value="">CLI default</option>
                                {antigravityModels.map(model => (
                                    <option key={model} value={model}>{model}</option>
                                ))}
                                {/* Keep the current value selectable even if the agy roster changed */}
                                {state.antigravityDefault &&
                                    !antigravityModels.includes(state.antigravityDefault) && (
                                        <option value={state.antigravityDefault}>{state.antigravityDefault}</option>
                                    )}
                            </select>
                            {savingAntigravityDefault && <Loader2 size={15} className="animate-spin text-slate-400" />}
                        </div>
                    </div>
                </section>

                {/* Per-model thinking level — the default reasoning effort
                    Praxis applies to a dispatch whose RESOLVED model is this
                    one and that carries no explicit level of its own
                    (claude --effort / codex model_reasoning_effort). */}
                <section className="mb-6 rounded-lg border border-slate-800 bg-slate-950/50 p-4">
                    <div className="mb-3 flex items-center gap-3">
                        <Bot size={22} className="text-amber-300" />
                        <div>
                            <div className="text-base font-semibold text-white">Per-Model Thinking Level</div>
                            <div className="text-sm text-slate-500">
                                Default reasoning effort per model, applied by every Praxis executor flow (task dispatch, QA, corrections, chat)
                                when the dispatch has no explicit level. Antigravity has no thinking-level knob — its effort is baked into the
                                model display name (&ldquo;Gemini 3.1 Pro (High)&rdquo;), so it is not listed here.
                            </div>
                        </div>
                    </div>
                    <div className="grid gap-2 sm:grid-cols-2">
                        {[...filterClaudeModels(state.models), ...filterCodexModels(state.models)].map(model => {
                            const id = apiModelIdOf(model);
                            const current = state.thinkingLevels?.[id] || "";
                            return (
                                <div key={`thinking-${model.id}`} className="flex items-center justify-between gap-2 rounded border border-slate-800 bg-slate-900/40 px-3 py-2">
                                    <span className="truncate text-sm text-slate-300" title={id}>
                                        {model.display_name || model.name || id}
                                    </span>
                                    <div className="flex items-center gap-2">
                                        <select
                                            value={current}
                                            onChange={(event) => void updateThinkingLevel(id, event.target.value)}
                                            disabled={savingThinkingModel === id || loading}
                                            className="rounded border border-slate-700 bg-slate-950 px-2 py-1 text-sm text-slate-200 outline-none focus:border-amber-500 disabled:opacity-50"
                                        >
                                            <option value="">CLI default</option>
                                            {thinkingLevelOptions(id).map(level => (
                                                <option key={level} value={level}>{level}</option>
                                            ))}
                                            {/* Keep a stored value selectable even if the roster shifted */}
                                            {current && !thinkingLevelOptions(id).includes(current) && (
                                                <option value={current}>{current}</option>
                                            )}
                                        </select>
                                        {savingThinkingModel === id && <Loader2 size={15} className="animate-spin text-slate-400" />}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
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
                    <div className="mt-4">
                        <ModelRoleManager />
                    </div>
                </section>

                <section className="mb-6 rounded-lg border border-slate-800 bg-slate-950/50 p-4">
                    <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                        <div>
                            <div className="flex items-center gap-2">
                                <Route size={16} className="text-cyan-300" />
                                <h2 className="font-semibold text-white">Live Routing Test</h2>
                            </div>
                            <div className="mt-1 text-sm text-slate-500">
                                Resolve uses the real control plane. Live probe also performs a tiny model call and records the execution.
                            </div>
                        </div>
                        <div className="flex gap-2">
                            <button
                                type="button"
                                onClick={() => runProbe("resolve")}
                                disabled={!!probing}
                                className="inline-flex items-center justify-center gap-2 rounded border border-slate-700 bg-slate-900 px-3 py-2 text-sm font-medium text-slate-200 hover:border-cyan-500/50 disabled:opacity-50"
                            >
                                {probing === "resolve" ? <Loader2 size={15} className="animate-spin" /> : <Route size={15} />}
                                Resolve
                            </button>
                            <button
                                type="button"
                                onClick={() => runProbe("live")}
                                disabled={!!probing}
                                className="inline-flex items-center justify-center gap-2 rounded border border-cyan-500/30 bg-cyan-500/10 px-3 py-2 text-sm font-medium text-cyan-200 hover:bg-cyan-500/20 disabled:opacity-50"
                            >
                                {probing === "live" ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />}
                                Live Probe
                            </button>
                        </div>
                    </div>
                    <div className="grid gap-3 lg:grid-cols-[minmax(220px,320px)_minmax(0,1fr)]">
                        <div className="space-y-3">
                            <label className="block">
                                <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-500">Assignment</span>
                                <input
                                    value={probeAssignment}
                                    onChange={(event) => setProbeAssignment(event.target.value)}
                                    className="w-full rounded border border-slate-800 bg-slate-950 px-3 py-2 font-mono text-sm text-slate-200 outline-none focus:border-cyan-500"
                                    placeholder="alias:coder"
                                />
                            </label>
                            <label className="block">
                                <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-500">Probe Prompt</span>
                                <textarea
                                    value={probePrompt}
                                    onChange={(event) => setProbePrompt(event.target.value)}
                                    className="min-h-20 w-full rounded border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-cyan-500"
                                />
                            </label>
                        </div>
                        <div className="rounded border border-slate-800 bg-slate-950/70 p-3">
                            {probeResult ? (
                                <div className="space-y-3">
                                    <div className="flex flex-wrap items-center gap-2">
                                        <span className={`rounded border px-2 py-0.5 text-xs ${providerTone(probeResult.resolved.provider)}`}>
                                            {probeResult.resolved.provider || "unknown"}
                                        </span>
                                        <span className="font-mono text-sm text-slate-200">{probeResult.resolved.apiModelId || probeResult.resolved.resolvedModelId}</span>
                                        {probeResult.resolved.fallbackUsed && <span className="rounded bg-amber-500/10 px-2 py-0.5 text-xs text-amber-200">fallback</span>}
                                        {probeResult.resolved.localOnlyActive && <span className="rounded bg-teal-500/10 px-2 py-0.5 text-xs text-teal-200">local only</span>}
                                    </div>
                                    <div className="text-xs text-slate-500">
                                        {formatTarget(probeResult.resolved.requestedAssignment)} to {formatTarget(probeResult.resolved.resolvedModelId)} via {probeResult.resolved.source || "resolver"}
                                    </div>
                                    {probeResult.resolved.fallbackReason && (
                                        <div className="rounded border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">{probeResult.resolved.fallbackReason}</div>
                                    )}
                                    {probeResult.response && (
                                        <div className="rounded border border-slate-800 bg-slate-900/70 px-3 py-2 text-sm text-slate-200">{probeResult.response}</div>
                                    )}
                                    {probeResult.snapshot?.id && (
                                        <div className="text-[11px] text-slate-600">snapshot {probeResult.snapshot.id}</div>
                                    )}
                                </div>
                            ) : (
                                <div className="flex h-full min-h-32 items-center justify-center text-sm text-slate-500">No probe run yet</div>
                            )}
                        </div>
                    </div>
                </section>

                <section className="mb-6 rounded-lg border border-slate-800 bg-slate-950/50 p-4">
                    <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                        <div>
                            <div className="flex items-center gap-2">
                                <Shield size={16} className="text-cyan-300" />
                                <h2 className="font-semibold text-white">Execution Policy</h2>
                                <span className="rounded bg-slate-800 px-2 py-0.5 text-[11px] text-slate-400">{projectId ? "project" : "global"}</span>
                            </div>
                            <div className="mt-1 text-sm text-slate-500">
                                Required capabilities are enforced by the resolver before an API call is made.
                            </div>
                        </div>
                        <button
                            type="button"
                            onClick={() => updatePolicy({ ...activePolicy, enabled: !activePolicy.enabled })}
                            disabled={savingPolicy}
                            className={`inline-flex items-center justify-center gap-2 rounded border px-3 py-2 text-sm font-medium ${activePolicy.enabled ? "border-cyan-500/40 bg-cyan-500/10 text-cyan-200" : "border-slate-700 bg-slate-900 text-slate-300"} disabled:opacity-50`}
                        >
                            {savingPolicy ? <Loader2 size={15} className="animate-spin" /> : <Shield size={15} />}
                            {activePolicy.enabled ? "Policy On" : "Policy Off"}
                        </button>
                    </div>

                    <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(280px,420px)]">
                        <div>
                            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">Required Capabilities</div>
                            <div className="flex flex-wrap gap-2">
                                {CAPABILITY_OPTIONS.map(capability => {
                                    const active = activePolicy.requiredCapabilities?.includes(capability);
                                    return (
                                        <button
                                            key={capability}
                                            type="button"
                                            onClick={() => toggleCapability(capability)}
                                            disabled={savingPolicy}
                                            className={`rounded border px-3 py-1.5 text-xs font-medium ${active ? "border-cyan-500/40 bg-cyan-500/10 text-cyan-200" : "border-slate-800 bg-slate-900 text-slate-400 hover:text-slate-200"} disabled:opacity-50`}
                                        >
                                            {capability}
                                        </button>
                                    );
                                })}
                            </div>
                            <div className="mt-4 grid gap-3 sm:grid-cols-2">
                                <label className="block">
                                    <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-500">Daily Tokens</span>
                                    <input
                                        type="number"
                                        min="0"
                                        defaultValue={budget.dailyTokenLimit || ""}
                                        onBlur={(event) => saveBudget({ dailyTokenLimit: event.target.value ? Number(event.target.value) : null })}
                                        className="w-full rounded border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-cyan-500"
                                        placeholder="4000000"
                                    />
                                </label>
                                <label className="block">
                                    <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-500">Daily Cost USD</span>
                                    <input
                                        type="number"
                                        min="0"
                                        step="0.01"
                                        defaultValue={budget.dailyCostLimit || ""}
                                        onBlur={(event) => saveBudget({ dailyCostLimit: event.target.value ? Number(event.target.value) : null })}
                                        className="w-full rounded border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-cyan-500"
                                        placeholder="25.00"
                                    />
                                </label>
                            </div>
                            <label className="mt-3 flex items-center gap-2 text-sm text-slate-300">
                                <input
                                    type="checkbox"
                                    checked={!!budget.autoLocalOnly}
                                    onChange={(event) => saveBudget({ autoLocalOnly: event.target.checked })}
                                    className="h-4 w-4 rounded border-slate-700 bg-slate-950"
                                />
                                Force local when budget is exceeded
                            </label>
                            <div className="mt-4 rounded border border-slate-800 bg-slate-950/60 p-3">
                                <div className="mb-2 flex items-center justify-between">
                                    <span className="text-xs font-medium uppercase tracking-wide text-slate-500">Today</span>
                                    {budgetStatus?.exceeded && <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-200">over budget</span>}
                                </div>
                                <div className="grid grid-cols-2 gap-2 text-xs">
                                    <div>
                                        <div className="text-slate-500">Tokens</div>
                                        <div className="font-mono text-slate-200">{budgetStatus?.dailyTokensUsed?.toLocaleString() || "0"}</div>
                                    </div>
                                    <div>
                                        <div className="text-slate-500">Cost</div>
                                        <div className="font-mono text-slate-200">{formatMoney(budgetStatus?.dailyCostUsed)}</div>
                                    </div>
                                </div>
                            </div>
                        </div>
                        <div>
                            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">Fallback Chain</div>
                            <textarea
                                key={`${projectId || "global"}-${fallbackText}`}
                                defaultValue={fallbackText}
                                onBlur={(event) => saveFallbackChain(event.target.value)}
                                className="min-h-24 w-full rounded border border-slate-800 bg-slate-950 px-3 py-2 font-mono text-xs text-slate-200 outline-none focus:border-cyan-500"
                                placeholder={"alias:coder\nfamily_latest:anthropic/Claude Sonnet\nalias:local_default"}
                            />
                        </div>
                    </div>
                    <div className="mt-4">
                        <div className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">Provider Caps</div>
                        <div className="grid gap-2 lg:grid-cols-5">
                            {PROVIDERS.map(provider => {
                                const current = providerLimits[provider] || {};
                                const status = budgetStatus?.byProvider?.[provider];
                                return (
                                    <div key={provider} className={`rounded border p-3 ${status?.exceeded ? "border-amber-500/40 bg-amber-500/10" : "border-slate-800 bg-slate-950/60"}`}>
                                        <div className="mb-2 flex items-center justify-between gap-2">
                                            <span className="text-sm font-medium text-slate-200">{provider}</span>
                                            {status?.exceeded && <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-200">cap</span>}
                                        </div>
                                        <div className="mb-2 text-[11px] text-slate-500">
                                            {(status?.dailyTokensUsed || 0).toLocaleString()} tokens · {formatMoney(status?.dailyCostUsed)}
                                        </div>
                                        <input
                                            type="number"
                                            min="0"
                                            defaultValue={current.dailyTokenLimit || ""}
                                            onBlur={(event) => saveProviderBudget(provider, { dailyTokenLimit: event.target.value ? Number(event.target.value) : null })}
                                            className="mb-2 w-full rounded border border-slate-800 bg-slate-950 px-2 py-1.5 text-xs text-slate-200 outline-none focus:border-cyan-500"
                                            placeholder="token cap"
                                        />
                                        <input
                                            type="number"
                                            min="0"
                                            step="0.01"
                                            defaultValue={current.dailyCostLimit || ""}
                                            onBlur={(event) => saveProviderBudget(provider, { dailyCostLimit: event.target.value ? Number(event.target.value) : null })}
                                            className="w-full rounded border border-slate-800 bg-slate-950 px-2 py-1.5 text-xs text-slate-200 outline-none focus:border-cyan-500"
                                            placeholder="cost cap"
                                        />
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                </section>

                <UsageRoutingPanel />

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

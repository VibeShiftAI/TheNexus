"use client";

import { useCallback, useMemo, useState } from "react";
import { useLiveRefetch } from "@/components/live-board-state";

import Link from "next/link";
import {
    ArrowLeft,
    BookOpen,
    BrainCircuit,
    Check,
    Database,
    Lightbulb,
    Loader2,
    Moon,
    Network,
    Plus,
    RefreshCw,
    Search,
    Sparkles,
    Trash2,
    X,
    Youtube,
} from "lucide-react";
import { getGlobalNotes, type Note } from "@/lib/nexus";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { normalizeMarkdown } from "@/lib/normalizeMarkdown";
import KnowledgeGraphForce from "@/components/knowledge-graph-force";
import TopicMapForce from "@/components/topic-map-force";
import {
    acceptRecommendation,
    addIngestionSource,
    dismissRecommendation,
    expandKnowledgeNode,
    getCommunities,
    getIngestionOverview,
    getIngestionRunDetail,
    getIngestionRuns,
    getKnowledgeView,
    getRecommendations,
    getTopicMap,
    ingestYouTubeVideo,
    rebuildCommunities,
    refreshRecommendations,
    removeIngestionSource,
    toggleIngestionSource,
    type IngestionOverview,
    type IngestionSource,
    type KnowledgeCommunity,
    type KnowledgeView,
    type RecommendationStore,
    type RunDetail,
    type RunSummary,
    type SourceType,
    type TopicMapData,
    type TopicMapNode,
} from "@/lib/ingestion-control";

const SOURCE_TYPE_CLASS: Record<string, string> = {
    web_search: "border-cyan-500/30 bg-cyan-500/10 text-cyan-200",
    rss: "border-amber-500/30 bg-amber-500/10 text-amber-200",
    youtube: "border-rose-500/30 bg-rose-500/10 text-rose-200",
    academic: "border-violet-500/30 bg-violet-500/10 text-violet-200",
    google_docs: "border-emerald-500/30 bg-emerald-500/10 text-emerald-200",
};

const OUTCOME_CLASS: Record<string, string> = {
    succeeded: "text-emerald-300",
    skipped: "text-slate-400",
    failed: "text-red-300",
    pending: "text-sky-300",
};

function formatDate(value?: string | null): string {
    if (!value) return "never";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString();
}

const ORIGIN_CLASS: Record<string, string> = {
    hunt: "bg-violet-500/20 text-violet-200",
    gap: "bg-emerald-500/20 text-emerald-200",
    need: "bg-amber-500/20 text-amber-200",
    manual: "bg-slate-700 text-slate-300",
};

function originTitle(s: { origin?: { kind: string; tag?: string; need_id?: string } }): string {
    const o = s.origin;
    if (!o) return "";
    if (o.kind === "hunt") return "Council HUNT row — rotates out after 14 days without a kept item";
    if (o.kind === "gap") return `Project knowledge gap${o.tag ? ` (${o.tag})` : ""} — retires when the gap fills`;
    if (o.kind === "need") return `Open project need${o.need_id ? ` ${o.need_id}` : ""} — retires when the need closes`;
    return "Added by hand";
}

function ageLabel(iso?: string | null): string {
    if (!iso) return "";
    const ms = Date.now() - Date.parse(iso);
    if (!Number.isFinite(ms) || ms < 0) return "";
    const days = Math.floor(ms / 86_400_000);
    if (days < 1) return "today";
    if (days < 30) return `${days}d`;
    return `${Math.floor(days / 30)}mo`;
}

function confidenceDots(confidence: number): string {
    return "●".repeat(Math.max(1, Math.min(5, confidence))) + "○".repeat(5 - Math.max(1, Math.min(5, confidence)));
}

export default function KnowledgeIngestionPage() {
    const [overview, setOverview] = useState<IngestionOverview | null>(null);
    const [runs, setRuns] = useState<RunSummary[]>([]);
    const [reports, setReports] = useState<Note[]>([]);
    const [detailTab, setDetailTab] = useState<"report" | "details">("report");
    const [selectedRun, setSelectedRun] = useState<RunDetail | null>(null);
    const [recommendations, setRecommendations] = useState<RecommendationStore | null>(null);
    const [communities, setCommunities] = useState<KnowledgeCommunity[]>([]);
    const [topicsView, setTopicsView] = useState<"cards" | "map">("cards");
    const [topicMap, setTopicMap] = useState<TopicMapData | null>(null);
    const [topicMapLoading, setTopicMapLoading] = useState(false);
    const [knowledge, setKnowledge] = useState<KnowledgeView | null>(null);
    const [knowledgeLoading, setKnowledgeLoading] = useState(false);
    const [exploreTerm, setExploreTerm] = useState("");
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [busy, setBusy] = useState<string | null>(null);

    // Add-source form
    const [showAddForm, setShowAddForm] = useState<"term" | "source" | null>(null);
    const [formName, setFormName] = useState("");
    const [formType, setFormType] = useState<SourceType>("rss");
    const [formUrl, setFormUrl] = useState("");
    const [videoUrl, setVideoUrl] = useState("");

    const loadAll = useCallback(async () => {
        try {
            const [ov, runList, recs, comms, notesData] = await Promise.all([
                getIngestionOverview(),
                getIngestionRuns(14),
                getRecommendations(),
                getCommunities(60).catch(() => ({ communities: [] })),
                getGlobalNotes().catch(() => []),
            ]);
            setOverview(ov);
            setRuns(runList.runs);
            setRecommendations(recs);
            setCommunities(comms.communities);

            const filteredReports = notesData
                .filter((n: Note) => (n.category as string) === "ingestion-report")
                .sort((a: Note, b: Note) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
            setReports(filteredReports);

            setError(null);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to load ingestion state");
        } finally {
            setLoading(false);
        }
    }, []);

    // D-1: ingestion runs, recommendations and communities are Praxis-side and
    // emit no stream frame — poll only, through the shared mechanism.
    useLiveRefetch([], loadAll, { fallbackPollMs: 30_000 });

    const flash = (message: string) => {
        setNotice(message);
        setTimeout(() => setNotice(null), 5000);
    };

    const runMutation = async (key: string, fn: () => Promise<unknown>) => {
        setBusy(key);
        try {
            const result = await fn();
            const message =
                result && typeof result === "object" && "message" in result ? (result as { message?: string }).message : undefined;
            if (message) flash(message);
            await loadAll();
        } catch (err) {
            flash(err instanceof Error ? err.message : "Operation failed");
        } finally {
            setBusy(null);
        }
    };

    const explore = useCallback(async (term: string) => {
        const trimmed = term.trim();
        if (!trimmed) return;
        setExploreTerm(trimmed);
        setKnowledgeLoading(true);
        try {
            setKnowledge(await getKnowledgeView(trimmed));
        } catch (err) {
            setKnowledge(null);
            setNotice(err instanceof Error ? err.message : "Knowledge lookup failed");
        } finally {
            setKnowledgeLoading(false);
        }
    }, []);

    // Double-click expansion: fetch a node's neighbors and merge them into the
    // current graph (dedup by node id / edge identity).
    const expandNode = useCallback(async (nodeId: string, knownIds: string[]) => {
        try {
            const result = await expandKnowledgeNode(nodeId, knownIds);
            setKnowledge((prev) => {
                if (!prev) return prev;
                const nodeIds = new Set(prev.graph.nodes.map((n) => n.id));
                const newNodes = result.nodes.filter((n) => !nodeIds.has(n.id));
                const edgeKeys = new Set(prev.graph.edges.map((e) => `${e.source}|${e.label}|${e.target}`));
                const newEdges = result.edges.filter((e) => !edgeKeys.has(`${e.source}|${e.label}|${e.target}`));
                if (newNodes.length === 0 && newEdges.length === 0) return prev;
                return {
                    ...prev,
                    graph: {
                        nodes: [...prev.graph.nodes, ...newNodes],
                        edges: [...prev.graph.edges, ...newEdges],
                    },
                };
            });
        } catch (err) {
            setNotice(err instanceof Error ? err.message : "Expansion failed");
        }
    }, []);

    const showTopicMap = useCallback(async () => {
        setTopicsView("map");
        if (topicMap) return;
        setTopicMapLoading(true);
        try {
            setTopicMap(await getTopicMap());
        } catch (err) {
            setNotice(err instanceof Error ? err.message : "Topic map failed to load");
            setTopicsView("cards");
        } finally {
            setTopicMapLoading(false);
        }
    }, [topicMap]);

    const getLocalDateString = (isoString?: string | null) => {
        if (!isoString) return "";
        try {
            return new Date(isoString).toISOString().split("T")[0];
        } catch {
            return "";
        }
    };

    const matchingReport = useMemo(() => {
        if (!selectedRun) return null;
        const runDate = getLocalDateString(selectedRun.created_at);
        
        // 1. Try YYYY-MM-DD match
        const byDate = reports.find(r => getLocalDateString(r.created_at) === runDate);
        if (byDate) return byDate;
        
        // 2. Proximity fallback (within 12 hours)
        const runTime = new Date(selectedRun.created_at).getTime();
        let bestMatch: Note | null = null;
        let minDiff = Infinity;
        for (const r of reports) {
            const diff = Math.abs(new Date(r.created_at).getTime() - runTime);
            if (diff < minDiff && diff < 12 * 60 * 60 * 1000) {
                minDiff = diff;
                bestMatch = r;
            }
        }
        return bestMatch;
    }, [selectedRun, reports]);

    const openRun = useCallback(async (runId: string) => {
        try {
            const runDetail = await getIngestionRunDetail(runId);
            setSelectedRun(runDetail);

            const runDate = getLocalDateString(runDetail.created_at);
            const byDate = reports.find(r => getLocalDateString(r.created_at) === runDate);
            let hasMatchingReport = !!byDate;
            
            if (!hasMatchingReport) {
                const runTime = new Date(runDetail.created_at).getTime();
                let minDiff = Infinity;
                for (const r of reports) {
                    const diff = Math.abs(new Date(r.created_at).getTime() - runTime);
                    if (diff < minDiff && diff < 12 * 60 * 60 * 1000) {
                        minDiff = diff;
                        hasMatchingReport = true;
                    }
                }
            }
            
            setDetailTab(hasMatchingReport ? "report" : "details");
        } catch (err) {
            setNotice(err instanceof Error ? err.message : "Failed to load run");
        }
    }, [reports]);

    const submitAdd = async () => {
        const isTerm = showAddForm === "term";
        const name = formName.trim() || formUrl.trim();
        if (!name || !formUrl.trim()) return;
        await runMutation("add", () =>
            addIngestionSource({
                name,
                type: isTerm ? "web_search" : formType,
                url: formUrl.trim(),
            }),
        );
        setShowAddForm(null);
        setFormName("");
        setFormUrl("");
    };

    const submitVideo = async () => {
        const trimmed = videoUrl.trim();
        if (!trimmed) return;
        await runMutation("youtube-video", async () => {
            const result = await ingestYouTubeVideo(trimmed);
            return {
                message: `Queued YouTube video ingestion (${result.ingestion.itemsEnqueued} item${result.ingestion.itemsEnqueued === 1 ? "" : "s"}) in ${result.ingestion.runId}.`,
            };
        });
        setVideoUrl("");
    };

    const termSources = useMemo(
        () => (overview?.sources ?? []).filter((s) => s.type === "web_search" && s.url !== "tavily"),
        [overview],
    );
    // Retired terms (no-yield, rotated-out, gap-filled, project-parked) used to
    // render as struck-through chips in the same row as the live ones — 119 of
    // them by 2026-09-02, burying the 74 that actually run. Split them out.
    const liveTerms = useMemo(() => termSources.filter((s) => !s.retired_at), [termSources]);
    const retiredTerms = useMemo(
        () => termSources.filter((s) => Boolean(s.retired_at)).sort((a, b) => (b.retired_at ?? "").localeCompare(a.retired_at ?? "")),
        [termSources],
    );
    const contentSources = useMemo(
        () => (overview?.sources ?? []).filter((s) => s.type !== "web_search" || s.url === "tavily"),
        [overview],
    );
    const suggested = useMemo(
        () =>
            (recommendations?.items ?? [])
                .filter((r) => r.status === "suggested")
                .sort((a, b) => b.created_at.localeCompare(a.created_at)),
        [recommendations],
    );

    const lastRun = overview?.latest_run ?? null;

    return (
        <main className="min-h-screen bg-slate-950 text-slate-200">
            <header className="sticky top-0 z-50 border-b border-slate-800 bg-slate-950/80 backdrop-blur-md">
                <div className="container mx-auto flex h-16 items-center justify-between px-6">
                    <div className="flex items-center gap-4">
                        <Link href="/" className="rounded-full p-2 text-slate-400 transition-colors hover:bg-slate-800 hover:text-white">
                            <ArrowLeft size={20} />
                        </Link>
                        <div>
                            <h1 className="text-xl font-bold tracking-tight text-white">KNOWLEDGE INGESTION</h1>
                            <p className="text-xs text-slate-500">Nightly sweep terms, sources, run history, and the knowledge they build.</p>
                        </div>
                    </div>
                    <button
                        onClick={loadAll}
                        className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-slate-700 text-slate-300 hover:border-cyan-500 hover:text-cyan-300"
                        title="Refresh"
                    >
                        <RefreshCw size={16} />
                    </button>
                </div>
            </header>

            <div className="container mx-auto space-y-6 p-6">
                {error && <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">{error}</div>}
                {notice && <div className="rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-4 py-3 text-sm text-cyan-200">{notice}</div>}

                {/* ── Stat cards ─────────────────────────────────────── */}
                <section className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
                    <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
                        <div className="mb-2 flex items-center gap-2 text-slate-400">
                            <Database size={16} />
                            <span className="text-xs font-semibold uppercase tracking-wide">Sources</span>
                        </div>
                        <div className="text-2xl font-semibold text-white">
                            {(overview?.sources ?? []).filter((s) => s.enabled).length}
                            <span className="text-base text-slate-500"> / {overview?.sources.length ?? 0}</span>
                        </div>
                        <p className="text-sm text-slate-500">enabled for tonight&apos;s sweep</p>
                    </div>
                    <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
                        <div className="mb-2 flex items-center gap-2 text-slate-400">
                            <Search size={16} />
                            <span className="text-xs font-semibold uppercase tracking-wide">Search terms</span>
                        </div>
                        <div className="text-2xl font-semibold text-white">
                            {(overview?.default_search_queries.length ?? 0) + termSources.filter((s) => s.enabled).length}
                        </div>
                        <p className="text-sm text-slate-500">
                            {overview?.default_search_queries.length ?? 0} built-in + {liveTerms.filter((s) => s.enabled).length} custom
                            {retiredTerms.length > 0 ? ` · ${retiredTerms.length} retired` : ""}
                        </p>
                    </div>
                    <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
                        <div className="mb-2 flex items-center gap-2 text-slate-400">
                            <Moon size={16} />
                            <span className="text-xs font-semibold uppercase tracking-wide">Last run</span>
                        </div>
                        <div className="text-2xl font-semibold text-white">
                            {lastRun ? `${lastRun.outcomes.succeeded}/${lastRun.deduped_count}` : "—"}
                        </div>
                        <p className="text-sm text-slate-500">
                            {lastRun ? `${lastRun.status} · ${formatDate(lastRun.created_at)}` : "no runs yet"}
                        </p>
                    </div>
                    <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
                        <div className="mb-2 flex items-center gap-2 text-slate-400">
                            <BrainCircuit size={16} />
                            <span className="text-xs font-semibold uppercase tracking-wide">Knowledge written</span>
                        </div>
                        <div className="text-2xl font-semibold text-white">{lastRun?.totals.vectors_written ?? 0}</div>
                        <p className="text-sm text-slate-500">
                            vectors · {lastRun?.totals.entities_new ?? 0} entities · {lastRun?.totals.relations_new ?? 0} relations
                        </p>
                    </div>
                </section>

                {/* ── Nightly search terms ───────────────────────────── */}
                <section className="rounded-lg border border-slate-800 bg-slate-900/40">
                    <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
                        <div className="flex items-center gap-2">
                            <Search size={18} className="text-cyan-300" />
                            <h2 className="font-semibold text-white">Nightly Search Terms</h2>
                        </div>
                        <button
                            onClick={() => { setShowAddForm(showAddForm === "term" ? null : "term"); setFormType("web_search"); }}
                            className="inline-flex items-center gap-1 rounded-md border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:border-cyan-500 hover:text-cyan-300"
                        >
                            <Plus size={14} /> Add term
                        </button>
                    </div>
                    <div className="space-y-3 p-4">
                        <p className="text-xs text-slate-500">
                            Click any term to explore what the knowledge bases already hold for it. Built-in terms ship with the default
                            Tavily sweep; custom terms are sources you control.
                        </p>
                        <div className="flex flex-wrap gap-2">
                            {(overview?.default_search_queries ?? []).map((q) => (
                                <button
                                    key={q}
                                    onClick={() => explore(q)}
                                    className="inline-flex items-center gap-1.5 rounded-full border border-slate-700 bg-slate-800/60 px-3 py-1.5 text-xs text-slate-300 hover:border-cyan-500 hover:text-cyan-200"
                                    title="Built-in default query — explore its knowledge"
                                >
                                    {q}
                                    <span className="rounded bg-slate-700 px-1 text-[10px] uppercase text-slate-400">built-in</span>
                                </button>
                            ))}
                            {liveTerms.map((s) => (
                                <span
                                    key={s.name}
                                    className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs ${
                                        s.enabled
                                            ? "border-cyan-500/40 bg-cyan-500/10 text-cyan-200"
                                            : "border-slate-700 bg-slate-900 text-slate-500 line-through"
                                    }`}
                                >
                                    <button onClick={() => explore(s.url)} className="hover:underline" title="Explore knowledge for this term">
                                        {s.url}
                                    </button>
                                    {s.origin?.kind && (
                                        <span
                                            className={`rounded px-1 text-[10px] uppercase ${ORIGIN_CLASS[s.origin.kind] ?? "bg-slate-800 text-slate-400"}`}
                                            title={originTitle(s)}
                                        >
                                            {s.origin.kind}
                                        </span>
                                    )}
                                    <span className="text-[10px] text-slate-500" title={`Added ${formatDate(s.added_at)}`}>
                                        {ageLabel(s.added_at)}
                                    </span>
                                    <button
                                        onClick={() => runMutation(`toggle-${s.name}`, () => toggleIngestionSource(s.name))}
                                        disabled={busy !== null}
                                        className="text-slate-400 hover:text-amber-300"
                                        title={s.enabled ? "Disable for nightly sweep" : "Enable for nightly sweep"}
                                    >
                                        {busy === `toggle-${s.name}` ? <Loader2 size={12} className="animate-spin" /> : s.enabled ? "⏸" : "▶"}
                                    </button>
                                    <button
                                        onClick={() => runMutation(`remove-${s.name}`, () => removeIngestionSource(s.name))}
                                        disabled={busy !== null}
                                        className="text-slate-400 hover:text-red-300"
                                        title="Remove term"
                                    >
                                        <Trash2 size={12} />
                                    </button>
                                </span>
                            ))}
                        </div>
                        {retiredTerms.length > 0 && (
                            <details className="mt-3 rounded-md border border-slate-800 bg-slate-950/40">
                                <summary className="cursor-pointer px-3 py-2 text-xs text-slate-400 hover:text-slate-200">
                                    Retired terms ({retiredTerms.length}) — rotated out by the nightly lifecycle; a re-proposal revives one
                                </summary>
                                <ul className="max-h-72 space-y-1 overflow-y-auto px-3 pb-3 text-xs">
                                    {retiredTerms.map((s) => (
                                        <li key={s.name} className="flex flex-wrap items-center gap-2 text-slate-500">
                                            <button onClick={() => explore(s.url)} className="text-left hover:text-slate-300 hover:underline">
                                                {s.url}
                                            </button>
                                            {s.origin?.kind && <span className="rounded bg-slate-800 px-1 text-[10px] uppercase">{s.origin.kind}</span>}
                                            <span className="rounded border border-slate-800 px-1 text-[10px]">{s.retire_reason ?? "retired"}</span>
                                            <span className="text-[10px]">{formatDate(s.retired_at)}</span>
                                            <button
                                                onClick={() => runMutation(`remove-${s.name}`, () => removeIngestionSource(s.name))}
                                                disabled={busy !== null}
                                                className="ml-auto text-slate-600 hover:text-red-300"
                                                title="Delete permanently"
                                            >
                                                <Trash2 size={11} />
                                            </button>
                                        </li>
                                    ))}
                                </ul>
                            </details>
                        )}
                        {showAddForm === "term" && (
                            <div className="flex flex-wrap items-center gap-2 rounded-md border border-slate-800 bg-slate-900/60 p-3">
                                <input
                                    value={formUrl}
                                    onChange={(e) => setFormUrl(e.target.value)}
                                    placeholder="Search query, e.g. 'multi-agent orchestration news'"
                                    className="min-w-64 flex-1 rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm text-slate-200 placeholder:text-slate-600 focus:border-cyan-500 focus:outline-none"
                                />
                                <input
                                    value={formName}
                                    onChange={(e) => setFormName(e.target.value)}
                                    placeholder="Display name (optional)"
                                    className="w-52 rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm text-slate-200 placeholder:text-slate-600 focus:border-cyan-500 focus:outline-none"
                                />
                                <button
                                    onClick={submitAdd}
                                    disabled={busy !== null || !formUrl.trim()}
                                    className="inline-flex items-center gap-1 rounded-md border border-cyan-500/50 bg-cyan-500/10 px-3 py-1.5 text-xs text-cyan-200 hover:bg-cyan-500/20 disabled:opacity-50"
                                >
                                    {busy === "add" ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Add to nightly sweep
                                </button>
                            </div>
                        )}
                    </div>
                </section>

                {/* ── Single video intake ───────────────────────────── */}
                <section className="rounded-lg border border-slate-800 bg-slate-900/40">
                    <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
                        <div className="flex items-center gap-2">
                            <Youtube size={18} className="text-rose-300" />
                            <h2 className="font-semibold text-white">Single YouTube Video</h2>
                        </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 p-3">
                        <input
                            value={videoUrl}
                            onChange={(e) => setVideoUrl(e.target.value)}
                            placeholder="YouTube video URL or ID"
                            className="min-w-64 flex-1 rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm text-slate-200 placeholder:text-slate-600 focus:border-rose-500 focus:outline-none"
                        />
                        <button
                            onClick={submitVideo}
                            disabled={busy !== null || !videoUrl.trim()}
                            className="inline-flex items-center gap-1 rounded-md border border-rose-500/50 bg-rose-500/10 px-3 py-1.5 text-xs text-rose-200 hover:bg-rose-500/20 disabled:opacity-50"
                        >
                            {busy === "youtube-video" ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Ingest video
                        </button>
                    </div>
                </section>

                {/* ── Content sources ────────────────────────────────── */}
                <section className="rounded-lg border border-slate-800 bg-slate-900/40">
                    <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
                        <div className="flex items-center gap-2">
                            <Database size={18} className="text-amber-300" />
                            <h2 className="font-semibold text-white">Content Sources</h2>
                        </div>
                        <button
                            onClick={() => { setShowAddForm(showAddForm === "source" ? null : "source"); setFormType("rss"); }}
                            className="inline-flex items-center gap-1 rounded-md border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:border-cyan-500 hover:text-cyan-300"
                        >
                            <Plus size={14} /> Add source
                        </button>
                    </div>
                    {showAddForm === "source" && (
                        <div className="flex flex-wrap items-center gap-2 border-b border-slate-800 bg-slate-900/60 p-3">
                            <input
                                value={formName}
                                onChange={(e) => setFormName(e.target.value)}
                                placeholder="Name"
                                className="w-48 rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm text-slate-200 placeholder:text-slate-600 focus:border-cyan-500 focus:outline-none"
                            />
                            <select
                                value={formType}
                                onChange={(e) => setFormType(e.target.value as SourceType)}
                                className="rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm text-slate-200 focus:border-cyan-500 focus:outline-none"
                            >
                                <option value="rss">RSS feed</option>
                                <option value="youtube">YouTube channel</option>
                                <option value="academic">Academic API</option>
                                <option value="web_search">Web search query</option>
                            </select>
                            <input
                                value={formUrl}
                                onChange={(e) => setFormUrl(e.target.value)}
                                placeholder={formType === "youtube" ? "Channel URL, @handle, or channel ID" : "Feed URL / folder ID / query"}
                                className="min-w-64 flex-1 rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm text-slate-200 placeholder:text-slate-600 focus:border-cyan-500 focus:outline-none"
                            />
                            <button
                                onClick={submitAdd}
                                disabled={busy !== null || !formUrl.trim() || (formType !== "youtube" && !formName.trim())}
                                className="inline-flex items-center gap-1 rounded-md border border-cyan-500/50 bg-cyan-500/10 px-3 py-1.5 text-xs text-cyan-200 hover:bg-cyan-500/20 disabled:opacity-50"
                            >
                                {busy === "add" ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Add
                            </button>
                        </div>
                    )}
                    <div className="divide-y divide-slate-800">
                        {contentSources.map((s: IngestionSource) => (
                            <div key={s.name} className="flex flex-wrap items-center gap-3 px-4 py-3">
                                <span className={`rounded border px-2 py-0.5 text-[10px] uppercase ${SOURCE_TYPE_CLASS[s.type] ?? ""}`}>
                                    {s.type}
                                </span>
                                <span className={`font-medium ${s.enabled ? "text-white" : "text-slate-500 line-through"}`}>{s.name}</span>
                                <span className="max-w-md truncate font-mono text-xs text-slate-500">{s.url}</span>
                                {s.max_items !== undefined && (
                                    <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400">cap {s.max_items}</span>
                                )}
                                <span className="ml-auto flex items-center gap-2">
                                    <button
                                        onClick={() => runMutation(`toggle-${s.name}`, () => toggleIngestionSource(s.name))}
                                        disabled={busy !== null}
                                        className={`rounded border px-2 py-1 text-xs ${
                                            s.enabled
                                                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/20"
                                                : "border-slate-700 bg-slate-800 text-slate-400 hover:text-white"
                                        }`}
                                    >
                                        {busy === `toggle-${s.name}` ? <Loader2 size={12} className="animate-spin" /> : s.enabled ? "enabled" : "disabled"}
                                    </button>
                                    <button
                                        onClick={() => runMutation(`remove-${s.name}`, () => removeIngestionSource(s.name))}
                                        disabled={busy !== null}
                                        className="rounded border border-slate-700 p-1.5 text-slate-400 hover:border-red-500/50 hover:text-red-300"
                                        title="Remove source"
                                    >
                                        <Trash2 size={13} />
                                    </button>
                                </span>
                            </div>
                        ))}
                        {contentSources.length === 0 && !loading && (
                            <div className="p-6 text-center text-sm text-slate-500">No content sources configured.</div>
                        )}
                    </div>
                </section>

                {/* ── Recommendations ────────────────────────────────── */}
                <section className="rounded-lg border border-slate-800 bg-slate-900/40">
                    <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
                        <div className="flex items-center gap-2">
                            <Lightbulb size={18} className="text-yellow-300" />
                            <h2 className="font-semibold text-white">Recommended Terms &amp; Sources</h2>
                            {suggested.length > 0 && (
                                <span className="rounded-full border border-yellow-500/40 bg-yellow-500/10 px-2 py-0.5 text-xs text-yellow-200">
                                    {suggested.length} pending
                                </span>
                            )}
                            <span className="text-xs text-slate-500">
                                {recommendations?.generated_at ? `generated ${formatDate(recommendations.generated_at)}` : "not generated yet"}
                                {" · newest first · the nightly rotation accepts a project's newest gap terms itself and expires the rest after 45 days"}
                            </span>
                        </div>
                        <button
                            onClick={() =>
                                runMutation("recs", async () => {
                                    const result = await refreshRecommendations();
                                    return {
                                        message:
                                            result.mode === "queued"
                                                ? `Recommendation refresh queued on the local LLM queue (job ${result.job?.id ?? "?"}). It analyzes your projects and recent runs — check back in a few minutes.`
                                                : "Recommendations refreshed.",
                                    };
                                })
                            }
                            disabled={busy !== null}
                            className="inline-flex items-center gap-1 rounded-md border border-yellow-500/40 bg-yellow-500/10 px-3 py-1.5 text-xs text-yellow-200 hover:bg-yellow-500/20 disabled:opacity-50"
                        >
                            {busy === "recs" ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />} Generate suggestions
                        </button>
                    </div>
                    <div className="p-4">
                        {recommendations?.context_note && (
                            <p className="mb-3 text-xs text-slate-500">Context used: {recommendations.context_note}</p>
                        )}
                        {suggested.length === 0 ? (
                            <p className="text-sm text-slate-500">
                                No pending suggestions. Generate to have the local model scan your active projects, recent run health, and
                                knowledge-graph activity for terms and sources worth adding.
                            </p>
                        ) : (
                            <div className="grid gap-3 lg:grid-cols-2">
                                {suggested.map((rec) => (
                                    <div key={rec.id} className="rounded-lg border border-slate-800 bg-slate-950/50 p-4">
                                        <div className="mb-2 flex flex-wrap items-center gap-2">
                                            <span className={`rounded border px-2 py-0.5 text-[10px] uppercase ${SOURCE_TYPE_CLASS[rec.source_type] ?? ""}`}>
                                                {rec.kind === "term" ? "search term" : rec.source_type}
                                            </span>
                                            <span className="font-medium text-white">{rec.name}</span>
                                            {rec.origin?.kind && (
                                                <span className={`rounded px-1 text-[10px] uppercase ${ORIGIN_CLASS[rec.origin.kind] ?? "bg-slate-800 text-slate-400"}`}>
                                                    {rec.origin.kind}
                                                </span>
                                            )}
                                            <span className="text-[10px] text-slate-500" title={formatDate(rec.created_at)}>
                                                {ageLabel(rec.created_at)}
                                            </span>
                                            <span className="ml-auto text-xs text-yellow-300/80" title={`Confidence ${rec.confidence}/5`}>
                                                {confidenceDots(rec.confidence)}
                                            </span>
                                        </div>
                                        <p className="mb-1 font-mono text-xs text-slate-400">{rec.target}</p>
                                        <p className="mb-2 text-sm text-slate-300">{rec.rationale}</p>
                                        {rec.related_to && <p className="mb-3 text-xs text-cyan-300/70">↳ {rec.related_to}</p>}
                                        <div className="flex gap-2">
                                            <button
                                                onClick={() => runMutation(`accept-${rec.id}`, () => acceptRecommendation(rec.id))}
                                                disabled={busy !== null}
                                                className="inline-flex items-center gap-1 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-xs text-emerald-200 hover:bg-emerald-500/20 disabled:opacity-50"
                                            >
                                                {busy === `accept-${rec.id}` ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                                                Add to sweep
                                            </button>
                                            <button
                                                onClick={() => runMutation(`dismiss-${rec.id}`, () => dismissRecommendation(rec.id))}
                                                disabled={busy !== null}
                                                className="inline-flex items-center gap-1 rounded-md border border-slate-700 px-3 py-1.5 text-xs text-slate-400 hover:border-red-500/40 hover:text-red-300 disabled:opacity-50"
                                            >
                                                <X size={13} /> Dismiss
                                            </button>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </section>

                {/* ── Knowledge topics (community layer) ─────────────── */}
                <section className="rounded-lg border border-slate-800 bg-slate-900/40">
                    <div className="flex flex-wrap items-center gap-3 border-b border-slate-800 px-4 py-3">
                        <div className="flex items-center gap-2">
                            <Network size={18} className="text-emerald-300" />
                            <h2 className="font-semibold text-white">Knowledge Topics</h2>
                            <span className="text-xs text-slate-500">{communities.length} clusters</span>
                        </div>
                        {overview?.graph_health && (
                            <span className="text-xs text-slate-500">
                                {overview.graph_health.entities.toLocaleString()} entities · {overview.graph_health.entity_entity_edges.toLocaleString()} direct links
                                · avg degree {overview.graph_health.avg_entity_degree}
                                · {overview.graph_health.communities_summarized}/{overview.graph_health.communities} summarized
                            </span>
                        )}
                        <div className="ml-auto flex items-center gap-2">
                            <div className="flex overflow-hidden rounded-md border border-slate-700 text-xs">
                                <button
                                    onClick={() => setTopicsView("cards")}
                                    className={`px-3 py-1.5 ${topicsView === "cards" ? "bg-emerald-500/20 text-emerald-200" : "text-slate-400 hover:text-slate-200"}`}
                                >
                                    Cards
                                </button>
                                <button
                                    onClick={showTopicMap}
                                    className={`px-3 py-1.5 ${topicsView === "map" ? "bg-emerald-500/20 text-emerald-200" : "text-slate-400 hover:text-slate-200"}`}
                                >
                                    Map
                                </button>
                            </div>
                            <button
                                onClick={() =>
                                    runMutation("topics", async () => {
                                        const result = await rebuildCommunities();
                                        setTopicMap(null);
                                        return {
                                            message: `Topic clusters rebuilt (${result.rebuild?.communities_created ?? "?"} communities). Summaries ${result.summaries_job ? `queued on the local LLM (job ${result.summaries_job.id})` : "updated"} — titles appear as the job processes them.`,
                                        };
                                    })
                                }
                                disabled={busy !== null}
                                className="inline-flex items-center gap-1 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-xs text-emerald-200 hover:bg-emerald-500/20 disabled:opacity-50"
                            >
                                {busy === "topics" ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} Rebuild topics
                            </button>
                        </div>
                    </div>
                    <div className="p-4">
                        {topicsView === "map" ? (
                            topicMapLoading ? (
                                <div className="p-10 text-center text-slate-500">Computing the topic map…</div>
                            ) : topicMap ? (
                                <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-2">
                                    <TopicMapForce
                                        data={topicMap}
                                        onTopicClick={(t: TopicMapNode) => {
                                            const target = t.top_entities?.[0] ?? t.title;
                                            if (target) explore(target);
                                        }}
                                    />
                                </div>
                            ) : (
                                <p className="text-sm text-slate-500">Topic map unavailable.</p>
                            )
                        ) : communities.length === 0 ? (
                            <p className="text-sm text-slate-500">
                                No topic clusters yet. Rebuild runs Leiden community detection over the knowledge graph and queues
                                local-LLM summaries for each topic.
                            </p>
                        ) : (
                            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                                {communities.slice(0, 18).map((c) => (
                                    <div key={c.community_id} className="rounded-lg border border-slate-800 bg-slate-950/50 p-3">
                                        <div className="mb-1 flex items-center gap-2">
                                            <span className="font-medium text-white">{c.title ?? `Topic #${c.community_id}`}</span>
                                            <span className="ml-auto rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400">{c.size} entities</span>
                                        </div>
                                        <p className="mb-2 text-xs text-slate-400">
                                            {c.summary ?? <span className="italic text-slate-600">summary pending…</span>}
                                        </p>
                                        <div className="flex flex-wrap gap-1">
                                            {(c.top_entities ?? []).slice(0, 5).map((name) => (
                                                <button
                                                    key={name}
                                                    onClick={() => explore(name)}
                                                    className="rounded-full border border-slate-700 px-2 py-0.5 text-[10px] text-slate-400 hover:border-emerald-500/40 hover:text-emerald-200"
                                                >
                                                    {name}
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </section>

                {/* ── Knowledge explorer ─────────────────────────────── */}
                <section className="rounded-lg border border-slate-800 bg-slate-900/40">
                    <div className="flex flex-wrap items-center gap-3 border-b border-slate-800 px-4 py-3">
                        <div className="flex items-center gap-2">
                            <BrainCircuit size={18} className="text-violet-300" />
                            <h2 className="font-semibold text-white">Knowledge Explorer</h2>
                        </div>
                        <form
                            className="ml-auto flex items-center gap-2"
                            onSubmit={(e) => { e.preventDefault(); explore(exploreTerm); }}
                        >
                            <input
                                value={exploreTerm}
                                onChange={(e) => setExploreTerm(e.target.value)}
                                placeholder="Explore any term…"
                                className="w-72 rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm text-slate-200 placeholder:text-slate-600 focus:border-violet-500 focus:outline-none"
                            />
                            <button
                                type="submit"
                                disabled={knowledgeLoading || !exploreTerm.trim()}
                                className="inline-flex items-center gap-1 rounded-md border border-violet-500/40 bg-violet-500/10 px-3 py-1.5 text-xs text-violet-200 hover:bg-violet-500/20 disabled:opacity-50"
                            >
                                {knowledgeLoading ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />} Explore
                            </button>
                        </form>
                    </div>
                    {knowledgeLoading ? (
                        <div className="p-10 text-center text-slate-500">Querying Pinecone + Neo4j via Cortex…</div>
                    ) : knowledge ? (
                        <div className="grid gap-4 p-4 lg:grid-cols-[2fr_1fr]">
                            <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-2">
                                {knowledge.linked_entities && knowledge.linked_entities.length > 0 && (
                                    <div className="flex flex-wrap items-center gap-1.5 px-2 pt-1 pb-2 text-xs">
                                        <span className="text-slate-500">&ldquo;{knowledge.term}&rdquo; lit up:</span>
                                        {knowledge.linked_entities.map((name) => (
                                            <button
                                                key={name}
                                                onClick={() => explore(name)}
                                                className="rounded-full border border-violet-500/30 bg-violet-500/10 px-2 py-0.5 text-violet-200 hover:bg-violet-500/20"
                                            >
                                                {name}
                                            </button>
                                        ))}
                                    </div>
                                )}
                                {knowledge.topics && knowledge.topics.length > 0 && (
                                    <div className="flex flex-wrap items-center gap-1.5 px-2 pb-2 text-xs">
                                        <span className="text-slate-500">topics:</span>
                                        {knowledge.topics.map((t) => (
                                            <span
                                                key={t.community_id}
                                                className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-emerald-200"
                                                title={`${t.size} entities in this topic cluster`}
                                            >
                                                {t.title ?? `Topic #${t.community_id}`} · {t.size}
                                            </span>
                                        ))}
                                    </div>
                                )}
                                <KnowledgeGraphForce
                                    term={knowledge.term}
                                    nodes={knowledge.graph.nodes}
                                    edges={knowledge.graph.edges}
                                    onNodeClick={explore}
                                    onNodeExpand={expandNode}
                                />
                            </div>
                            <div className="space-y-4">
                                {knowledge.cortex && (
                                    <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-4 text-sm">
                                        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Cortex totals</h3>
                                        <p className="text-slate-300">
                                            {knowledge.cortex.pinecone_vectors?.toLocaleString() ?? "?"} vectors ·{" "}
                                            {knowledge.cortex.neo4j_nodes?.toLocaleString() ?? "?"} graph nodes
                                        </p>
                                        {knowledge.cortex.pinecone_namespaces && (
                                            <ul className="mt-2 space-y-1 text-xs text-slate-500">
                                                {Object.entries(knowledge.cortex.pinecone_namespaces).map(([ns, count]) => (
                                                    <li key={ns} className="flex justify-between">
                                                        <span className="font-mono">{ns}</span>
                                                        <span>{count.toLocaleString()}</span>
                                                    </li>
                                                ))}
                                            </ul>
                                        )}
                                    </div>
                                )}
                                {knowledge.facts.length > 0 && (
                                    <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-4">
                                        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
                                            Graph facts ({knowledge.facts.length}, newest first)
                                        </h3>
                                        <ul className="max-h-64 space-y-1.5 overflow-y-auto text-xs text-slate-400">
                                            {knowledge.facts.map((f, i) => (
                                                <li key={i} className={`border-l-2 pl-2 ${f.is_current === false ? "border-slate-700 opacity-60" : "border-violet-500/30"}`}>
                                                    {f.fact}
                                                    <span className="ml-1.5 whitespace-nowrap text-[10px] text-slate-600">
                                                        {f.observed_at ? new Date(f.observed_at).toLocaleDateString() : ""}
                                                        {f.is_current === false ? " · superseded" : ""}
                                                    </span>
                                                </li>
                                            ))}
                                        </ul>
                                    </div>
                                )}
                                {knowledge.semantic_context && (
                                    <details className="rounded-lg border border-slate-800 bg-slate-950/60 p-4">
                                        <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-slate-400">
                                            Semantic memory context
                                        </summary>
                                        <pre className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap text-xs text-slate-400">
                                            {knowledge.semantic_context}
                                        </pre>
                                    </details>
                                )}
                            </div>
                        </div>
                    ) : (
                        <div className="p-10 text-center text-sm text-slate-500">
                            Click a search term above, or type any concept, to see what the knowledge databases hold for it.
                        </div>
                    )}
                </section>

                {/* ── Run history ────────────────────────────────────── */}
                <section className="rounded-lg border border-slate-800 bg-slate-900/40">
                    <div className="flex items-center gap-2 border-b border-slate-800 px-4 py-3">
                        <Moon size={18} className="text-sky-300" />
                        <h2 className="font-semibold text-white">Nightly Run History</h2>
                        <span className="text-sm text-slate-500">{runs.length} recent runs</span>
                    </div>
                    {loading ? (
                        <div className="p-8 text-center text-slate-500">Loading…</div>
                    ) : runs.length === 0 ? (
                        <div className="p-8 text-center text-slate-500">No ingestion runs recorded yet.</div>
                    ) : (
                        <div className="grid gap-0 lg:grid-cols-[280px_1fr]">
                            <div className="max-h-[520px] divide-y divide-slate-800 overflow-y-auto border-r border-slate-800">
                                {runs.map((run) => (
                                    <button
                                        key={run.run_id}
                                        onClick={() => openRun(run.run_id)}
                                        className={`block w-full px-4 py-3 text-left hover:bg-slate-800/50 ${
                                            selectedRun?.run_id === run.run_id ? "bg-slate-800/70" : ""
                                        }`}
                                    >
                                        <div className="flex items-center justify-between">
                                            <span className="font-mono text-xs text-slate-300">{run.run_id.replace("run_", "")}</span>
                                            <span
                                                className={`rounded border px-1.5 py-0.5 text-[10px] ${
                                                    run.status === "finalized"
                                                        ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
                                                        : "border-amber-500/30 bg-amber-500/10 text-amber-200"
                                                }`}
                                            >
                                                {run.status}
                                            </span>
                                        </div>
                                        <p className="mt-1 text-xs text-slate-500">
                                            {run.outcomes.succeeded} ok · {run.outcomes.skipped} skipped · {run.outcomes.failed} failed ·{" "}
                                            {run.totals.vectors_written} vectors
                                        </p>
                                    </button>
                                ))}
                            </div>
                            <div className="max-h-[520px] overflow-y-auto p-4">
                                {selectedRun ? (
                                    <div className="space-y-4">
                                        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-3">
                                            <div className="flex flex-wrap items-center gap-3 text-sm text-slate-400">
                                                <span className="font-mono text-white">{selectedRun.run_id}</span>
                                                <span>trigger: {selectedRun.trigger}</span>
                                                <span>{formatDate(selectedRun.created_at)}</span>
                                                <span>
                                                    {selectedRun.deduped_count}/{selectedRun.discovered_count} after dedup
                                                </span>
                                            </div>
                                            <div className="flex overflow-hidden rounded-md border border-slate-700 text-xs">
                                                <button
                                                    onClick={() => setDetailTab("report")}
                                                    className={`px-3 py-1.5 ${
                                                        detailTab === "report" ? "bg-sky-500/20 text-sky-200" : "text-slate-400 hover:text-slate-200"
                                                    }`}
                                                >
                                                    Intake Report
                                                </button>
                                                <button
                                                    onClick={() => setDetailTab("details")}
                                                    className={`px-3 py-1.5 ${
                                                        detailTab === "details" ? "bg-sky-500/20 text-sky-200" : "text-slate-400 hover:text-slate-200"
                                                    }`}
                                                >
                                                    Ingestion Details
                                                </button>
                                            </div>
                                        </div>

                                        {detailTab === "report" ? (
                                            matchingReport ? (
                                                <div className="prose prose-invert prose-sm max-w-none text-left
                                                    prose-headings:text-white prose-headings:font-bold prose-headings:mt-4 prose-headings:mb-2
                                                    prose-p:text-slate-300 prose-p:leading-relaxed prose-p:mb-3
                                                    prose-a:text-cyan-400 hover:prose-a:underline
                                                    prose-code:text-cyan-300 prose-code:bg-slate-800/80 prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:text-xs
                                                    prose-pre:bg-slate-950 prose-pre:border prose-pre:border-slate-800
                                                    prose-ul:list-disc prose-ul:pl-5 prose-ul:mb-3 prose-ul:text-slate-300
                                                    prose-ol:list-decimal prose-ol:pl-5 prose-ol:mb-3 prose-ol:text-slate-300
                                                    prose-strong:text-white
                                                    prose-table:w-full prose-table:border-collapse prose-table:my-4
                                                    prose-th:border prose-th:border-slate-800 prose-th:px-3 prose-th:py-2 prose-th:bg-slate-900/50 prose-th:text-white prose-th:font-semibold
                                                    prose-td:border prose-td:border-slate-800 prose-td:px-3 prose-td:py-2 prose-td:text-slate-300
                                                    prose-blockquote:border-l-4 prose-blockquote:border-cyan-500/50 prose-blockquote:pl-4 prose-blockquote:italic prose-blockquote:text-slate-400
                                                ">
                                                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                                                        {normalizeMarkdown(matchingReport.content)}
                                                    </ReactMarkdown>
                                                </div>
                                            ) : (
                                                <div className="p-8 text-center text-slate-500 italic text-xs border border-dashed border-slate-800 rounded-lg bg-slate-950/20">
                                                    No daily intake report was recorded around this run's timestamp.
                                                </div>
                                            )
                                        ) : (
                                            <>
                                                {selectedRun.search_terms.length > 0 && (
                                                    <div>
                                                        <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">
                                                            Terms searched this run
                                                        </h3>
                                                        <div className="flex flex-wrap gap-1.5">
                                                            {selectedRun.search_terms.map((t) => (
                                                                <button
                                                                    key={t}
                                                                    onClick={() => explore(t)}
                                                                    className="rounded-full border border-cyan-500/30 bg-cyan-500/10 px-2.5 py-1 text-xs text-cyan-200 hover:bg-cyan-500/20"
                                                                >
                                                                    {t}
                                                                </button>
                                                            ))}
                                                        </div>
                                                    </div>
                                                )}
                                                <div>
                                                    <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">Per source</h3>
                                                    <div className="space-y-1.5">
                                                        {selectedRun.sources.map((src) => {
                                                            const total = Math.max(src.discovered, 1);
                                                            return (
                                                                <div key={src.source_name} className="rounded-md border border-slate-800 bg-slate-950/50 px-3 py-2">
                                                                    <div className="flex flex-wrap items-center gap-2 text-xs">
                                                                        <span className={`rounded border px-1.5 py-0.5 text-[10px] uppercase ${SOURCE_TYPE_CLASS[src.source_type] ?? ""}`}>
                                                                            {src.source_type}
                                                                        </span>
                                                                        <span className="font-medium text-slate-200">{src.source_name}</span>
                                                                        <span className="ml-auto text-slate-500">
                                                                            {src.succeeded} ok · {src.skipped} skipped · {src.failed} failed
                                                                            {src.pending > 0 ? ` · ${src.pending} pending` : ""} · {src.vectors_written} vec
                                                                        </span>
                                                                    </div>
                                                                    <div className="mt-1.5 flex h-1.5 overflow-hidden rounded-full bg-slate-800">
                                                                        <div className="bg-emerald-500/70" style={{ width: `${(src.succeeded / total) * 100}%` }} />
                                                                        <div className="bg-slate-600" style={{ width: `${(src.skipped / total) * 100}%` }} />
                                                                        <div className="bg-red-500/70" style={{ width: `${(src.failed / total) * 100}%` }} />
                                                                        <div className="bg-sky-500/50" style={{ width: `${(src.pending / total) * 100}%` }} />
                                                                    </div>
                                                                </div>
                                                            );
                                                        })}
                                                    </div>
                                                </div>
                                                <details>
                                                    <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-slate-400">
                                                        Items ({selectedRun.items.length})
                                                    </summary>
                                                    <div className="mt-2 space-y-1">
                                                        {selectedRun.items.map((item) => (
                                                            <div key={item.hash} className="rounded border border-slate-800/60 px-3 py-2 text-xs">
                                                                <div className="flex flex-wrap items-center gap-2">
                                                                    <span className={OUTCOME_CLASS[item.outcome.status] ?? "text-slate-400"}>
                                                                        {item.outcome.status}
                                                                    </span>
                                                                    <a
                                                                        href={item.url}
                                                                        target="_blank"
                                                                        rel="noreferrer"
                                                                        className="truncate text-slate-300 hover:text-cyan-300 hover:underline"
                                                                    >
                                                                        {item.title}
                                                                    </a>
                                                                    <span className="ml-auto text-slate-600">{item.source_name}</span>
                                                                </div>
                                                                {item.search_query && (
                                                                    <p className="mt-0.5 text-slate-500">query: {item.search_query}</p>
                                                                )}
                                                                {item.outcome.skip_reason && (
                                                                    <p className="mt-0.5 text-slate-500">skip: {item.outcome.skip_reason}</p>
                                                                )}
                                                                {item.outcome.error && <p className="mt-0.5 text-red-300/80">{item.outcome.error}</p>}
                                                            </div>
                                                        ))}
                                                    </div>
                                                </details>
                                            </>
                                        )}
                                    </div>
                                ) : (
                                    <p className="p-6 text-center text-sm text-slate-500">Select a run to see its breakdown.</p>
                                )}
                            </div>
                        </div>
                    )}
                </section>
            </div>
        </main>
    );
}

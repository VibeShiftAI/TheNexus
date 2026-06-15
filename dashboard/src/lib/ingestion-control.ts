/**
 * Knowledge Ingestion control API client — talks to the Node backend's
 * /api/ingestion-control/* routes, which proxy Praxis's ingestion control
 * surface on :54322.
 */

const API_BASE = "/api/ingestion-control";

export type SourceType = "youtube" | "rss" | "academic" | "web_search" | "google_docs";

export interface IngestionSource {
    name: string;
    type: SourceType;
    url: string;
    enabled: boolean;
    added_at: string;
    max_items?: number;
}

export interface RunSourceBreakdown {
    source_name: string;
    source_type: string;
    discovered: number;
    succeeded: number;
    skipped: number;
    failed: number;
    pending: number;
    vectors_written: number;
    entities_new: number;
    relations_new: number;
    search_terms: string[];
}

export interface RunSummary {
    run_id: string;
    trigger: string;
    status: string;
    created_at: string;
    updated_at: string;
    discovered_count: number;
    deduped_count: number;
    outcomes: { succeeded: number; skipped: number; failed: number; pending: number };
    totals: { vectors_written: number; entities_new: number; entities_merged: number; relations_new: number };
    search_terms: string[];
    sources: RunSourceBreakdown[];
}

export interface RunItem {
    hash: string;
    title: string;
    url: string;
    source_name: string;
    source_type: string;
    published_at: string;
    search_query?: string;
    outcome: {
        status: string;
        skip_reason?: string;
        error?: string;
        pinecone_written?: number;
        entities_new?: number;
        relations_new?: number;
    };
    refinement?: { status: string; skip_reason?: string };
}

export interface DiscoveredIngestionItem {
    hash: string;
    title: string;
    url: string;
    content: string;
    source_name: string;
    source_type: string;
    published_at: string;
    metadata?: Record<string, unknown>;
}

export interface RunDetail extends RunSummary {
    items: RunItem[];
}

export interface GraphHealth {
    entities: number;
    factoids: number;
    entity_entity_edges: number;
    promoted_edges: number;
    avg_entity_degree: number;
    orphan_entities: number;
    communities: number;
    communities_summarized: number;
    computed_at: string;
}

export interface IngestionOverview {
    sources: IngestionSource[];
    default_search_queries: string[];
    config: Record<string, unknown>;
    editable_config_keys: string[];
    latest_run: RunSummary | null;
    recommendations_pending: number;
    recommendations_generated_at: string | null;
    graph_health?: GraphHealth | null;
}

export interface KnowledgeGraphNode {
    id: string;
    label: string;
    kind: "entity" | "neighbor";
    degree?: number;
    community_id?: number;
    topic?: string | null;
}

export interface KnowledgeGraphEdge {
    source: string;
    target: string;
    label: string;
    observed_at?: string | null;
}

export interface TopicMapNode {
    id: number;
    title: string | null;
    size: number;
    top_entities: string[];
}

export interface TopicMapData {
    nodes: TopicMapNode[];
    links: Array<{ source: number; target: number; weight: number }>;
    computed_at: string;
}

export interface KnowledgeFact {
    fact: string;
    observed_at: string | null;
    is_current: boolean | null;
}

export interface KnowledgeTopic {
    community_id: number;
    title: string | null;
    size: number;
}

export interface KnowledgeView {
    term: string;
    linked_entities?: string[];
    topics?: KnowledgeTopic[];
    cortex: {
        status: string;
        neo4j_nodes?: number;
        pinecone_vectors?: number;
        pinecone_namespaces?: Record<string, number>;
    } | null;
    semantic_context: string | null;
    facts: KnowledgeFact[];
    graph: { nodes: KnowledgeGraphNode[]; edges: KnowledgeGraphEdge[] };
}

export interface KnowledgeCommunity {
    community_id: number;
    title: string | null;
    summary: string | null;
    size: number;
    top_entities: string[];
    updated_at: string | null;
    summary_updated_at: string | null;
}

export interface IngestionRecommendation {
    id: string;
    kind: "term" | "source";
    source_type: SourceType;
    name: string;
    target: string;
    rationale: string;
    related_to?: string;
    confidence: number;
    status: "suggested" | "accepted" | "dismissed";
    created_at: string;
    resolved_at?: string;
}

export interface RecommendationStore {
    generated_at: string | null;
    last_job_id?: string;
    last_error?: string;
    context_note?: string;
    items: IngestionRecommendation[];
}

export interface MutationResult {
    ok: boolean;
    message: string;
    sources?: IngestionSource[];
    initial_ingestion?: {
        runId: string;
        discovered: number;
        deduped: number;
        itemsEnqueued: number;
        finalizerJobId: string;
    };
}

export interface YouTubeVideoIngestionResult {
    ok: boolean;
    item: DiscoveredIngestionItem;
    ingestion: {
        runId: string;
        discovered: number;
        deduped: number;
        itemsEnqueued: number;
        finalizerJobId: string;
    };
}

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
    const res = await fetch(`${API_BASE}${path}`, {
        credentials: "include",
        ...options,
        headers: {
            ...(options.body ? { "Content-Type": "application/json" } : {}),
            ...options.headers,
        },
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
        const message =
            (data && typeof data === "object" && "error" in data && String((data as { error: unknown }).error)) ||
            (data && typeof data === "object" && "message" in data && String((data as { message: unknown }).message)) ||
            `Request failed (${res.status})`;
        throw new Error(message);
    }
    return data as T;
}

export function getIngestionOverview(): Promise<IngestionOverview> {
    return api("/overview");
}

export function getIngestionRuns(limit = 14): Promise<{ runs: RunSummary[] }> {
    return api(`/runs?limit=${limit}`);
}

export function getIngestionRunDetail(runId: string): Promise<RunDetail> {
    return api(`/runs/${encodeURIComponent(runId)}`);
}

export function addIngestionSource(input: {
    name: string;
    type: SourceType;
    url: string;
    max_items?: number;
}): Promise<MutationResult> {
    return api("/sources", { method: "POST", body: JSON.stringify(input) });
}

export function ingestYouTubeVideo(url: string): Promise<YouTubeVideoIngestionResult> {
    return api("/youtube/video", { method: "POST", body: JSON.stringify({ url }) });
}

export function toggleIngestionSource(name: string): Promise<MutationResult> {
    return api(`/sources/${encodeURIComponent(name)}/toggle`, { method: "POST" });
}

export function removeIngestionSource(name: string): Promise<MutationResult> {
    return api(`/sources/${encodeURIComponent(name)}`, { method: "DELETE" });
}

export function setIngestionSourceCap(name: string, maxItems: number | null): Promise<MutationResult> {
    return api(`/sources/${encodeURIComponent(name)}/cap`, {
        method: "POST",
        body: JSON.stringify({ max_items: maxItems }),
    });
}

export function getKnowledgeView(term: string): Promise<KnowledgeView> {
    return api(`/knowledge?term=${encodeURIComponent(term)}`);
}

export function getCommunities(limit = 100): Promise<{ communities: KnowledgeCommunity[] }> {
    return api(`/communities?limit=${limit}`);
}

export function expandKnowledgeNode(
    eid: string,
    knownEids: string[],
): Promise<{ nodes: KnowledgeGraphNode[]; edges: KnowledgeGraphEdge[] }> {
    return api("/knowledge/expand", { method: "POST", body: JSON.stringify({ eid, known_eids: knownEids }) });
}

export function getTopicMap(): Promise<TopicMapData> {
    return api("/topic-map");
}

export function rebuildCommunities(): Promise<{ ok: boolean; rebuild: Record<string, number>; summaries_job?: { id: string } }> {
    return api("/communities/rebuild", { method: "POST", body: JSON.stringify({}) });
}

export function getRecommendations(): Promise<RecommendationStore> {
    return api("/recommendations");
}

export function refreshRecommendations(): Promise<{ ok: boolean; mode: string; job?: { id: string } }> {
    return api("/recommendations/refresh", { method: "POST", body: JSON.stringify({}) });
}

export function acceptRecommendation(id: string): Promise<MutationResult & { recommendation: IngestionRecommendation }> {
    return api(`/recommendations/${encodeURIComponent(id)}/accept`, { method: "POST" });
}

export function dismissRecommendation(id: string): Promise<{ ok: boolean; recommendation: IngestionRecommendation }> {
    return api(`/recommendations/${encodeURIComponent(id)}/dismiss`, { method: "POST" });
}

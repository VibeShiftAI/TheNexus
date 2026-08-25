/**
 * Council session API client for the Council Chamber page.
 *
 * Sessions live in Praxis's data/council-sessions store (written live by
 * CouncilSessionTracker as seats report) and are relayed through the Nexus
 * server: dashboard /api/praxis/council/* → :4000 → Praxis :54322
 * /api/council/*.
 */

export type CouncilPhase = "setup" | "deliberation" | "synthesis" | "refinement" | "complete";

export type CouncilVoiceStatus = "pending" | "running" | "success" | "parse_error" | "error" | "timeout";

export interface CouncilVoice {
    name: string;
    model: string;
    status: CouncilVoiceStatus;
    elapsedMs?: number;
    tokensUsed?: number;
    tokens_used?: number;
    registeredAt: number;
}

export interface CouncilThesis {
    voice: string;
    model: string;
    status: "success" | "parse_error" | "error" | "timeout";
    parsed?: unknown;
    raw?: string;
    error?: string;
    elapsedMs: number;
    tokensUsed?: number;
    tokens_used?: number;
    recordedAt: number;
}

export interface CouncilStats {
    voiceCount: number;
    thesisCount: number;
    successCount: number;
    failureCount: number;
    hasSynthesis: boolean;
    elapsedMs: number;
}

export interface CouncilSessionSummary {
    sessionId: string;
    topic: string;
    phase: CouncilPhase;
    createdAt: number;
    metadata: Record<string, unknown>;
    voices: CouncilVoice[];
    stats: CouncilStats;
    /** Honest duration: fixed at completion for finished sessions, running for live ones. */
    durationMs: number;
    hasSynthesis: boolean;
}

export interface CouncilSessionDetail extends Omit<CouncilSessionSummary, "hasSynthesis" | "durationMs"> {
    theses: CouncilThesis[];
    synthesis: string | null;
    refinement: string | null;
    sharedFindings: string[];
    consensusTracking: Record<string, unknown>;
    finalRecommendations: string[];
}

/** A session still moving: not complete, and convened within the last 3h.
 *  Older incomplete sessions were interrupted (Praxis restarts kill the
 *  in-flight deliberation) and will never finish. */
export const LIVE_WINDOW_MS = 3 * 60 * 60 * 1000;

export function isLiveSession(session: { phase: CouncilPhase; createdAt: number }): boolean {
    return session.phase !== "complete" && Date.now() - session.createdAt < LIVE_WINDOW_MS;
}

export function isInterruptedSession(session: { phase: CouncilPhase; createdAt: number }): boolean {
    return session.phase !== "complete" && Date.now() - session.createdAt >= LIVE_WINDOW_MS;
}

export async function getCouncilSessions(
    limit = 40,
): Promise<{ sessions: CouncilSessionSummary[]; inFlight: string | null }> {
    const res = await fetch(`/api/praxis/council/sessions?limit=${limit}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`Council sessions request failed (${res.status})`);
    const data = await res.json();
    return {
        sessions: Array.isArray(data.sessions) ? data.sessions : [],
        inFlight: typeof data.inFlight === "string" ? data.inFlight : null,
    };
}

export async function getCouncilSession(sessionId: string): Promise<CouncilSessionDetail> {
    const res = await fetch(`/api/praxis/council/sessions/${encodeURIComponent(sessionId)}`, {
        cache: "no-store",
    });
    if (!res.ok) throw new Error(`Council session ${sessionId} request failed (${res.status})`);
    return res.json();
}

// ── Problem council (two rounds on the same CLI sessions) ────────────────

/** Round-2 twin voices are named "<seat> (round 2)" (Praxis problem-council.ts). */
export function isRound2Voice(voice: { name: string }): boolean {
    return /\(round 2\)\s*$/.test(voice.name);
}

export function roundOfVoice(voice: { name: string }): 1 | 2 {
    return isRound2Voice(voice) ? 2 : 1;
}

/** "cli:codex/gpt-5.6-sol (round 2)" / "… (aggregator)" → "cli:codex/gpt-5.6-sol". */
export function baseSeatName(name: string): string {
    return name.replace(/\s*\(round 2\)\s*$/, "").replace(/\s*\(aggregator\)\s*$/, "");
}

/** Reference seats as the chamber shows them: no aggregator, no round-2 twins. */
export function referenceVoices(voices: CouncilVoice[]): CouncilVoice[] {
    return voices.filter((v) => !isAggregatorVoice(v) && !isRound2Voice(v));
}

/**
 * Reference seats with the LATEST round's status folded in — while round 2
 * runs, a seat's round-2 twin is what is deliberating, and the chamber should
 * light the seat from that. Non-problem sessions have no twins (identity).
 */
export function effectiveReferenceVoices(voices: CouncilVoice[]): CouncilVoice[] {
    return referenceVoices(voices).map((v) => {
        const twin = voices.find((t) => isRound2Voice(t) && baseSeatName(t.name) === v.name);
        if (!twin || twin.status === "pending") return v;
        return { ...v, status: twin.status, elapsedMs: twin.elapsedMs ?? v.elapsedMs };
    });
}

export function isProblemCouncil(metadata: Record<string, unknown> | undefined): boolean {
    return metadata?.kind === "problem-council";
}

export interface ProblemIdea {
    id: string;
    seat: string;
    seatLabel: string;
    title: string;
    what: string;
    why: string;
}

export interface ProblemRankingRow {
    id: string;
    title: string;
    seat: string;
    seatLabel: string;
    score: number;
    positions: Record<string, number | null>;
    topThree: number;
    dropped: number;
    rankedBy: number;
    reasons: Record<string, string>;
}

export interface ProblemBallot {
    seat: string;
    ranking: string[];
    drops: Array<{ id: string; reason: string }>;
    merges: Array<[string, string]>;
    setupNote?: string;
}

export interface ProblemSetupView {
    seat: string;
    restatement?: string;
    classification?: string;
    classReason?: string;
    solved?: string;
    needs: Array<{ kind: string; description: string }>;
}

export interface ProblemCouncilConsensus {
    ideas: ProblemIdea[];
    ballots: ProblemBallot[];
    ranking: ProblemRankingRow[];
    agreement: number;
    maxScore: number;
    merges: Array<[string, string]>;
    setups: ProblemSetupView[];
    sourceIdeas: string[][];
}

/** The problem council's aggregate record (consensusTracking), or null when absent/malformed. */
export function problemConsensus(detail: { consensusTracking: Record<string, unknown> }): ProblemCouncilConsensus | null {
    const c = detail.consensusTracking;
    if (!c || !Array.isArray(c.ranking) || !Array.isArray(c.ideas)) return null;
    return {
        ideas: c.ideas as ProblemIdea[],
        ballots: Array.isArray(c.ballots) ? (c.ballots as ProblemBallot[]) : [],
        ranking: c.ranking as ProblemRankingRow[],
        agreement: typeof c.agreement === "number" ? c.agreement : 0,
        maxScore: typeof c.maxScore === "number" ? c.maxScore : 0,
        merges: Array.isArray(c.merges) ? (c.merges as Array<[string, string]>) : [],
        setups: Array.isArray(c.setups) ? (c.setups as ProblemSetupView[]) : [],
        sourceIdeas: Array.isArray(c.sourceIdeas) ? (c.sourceIdeas as string[][]) : [],
    };
}

export interface ProblemCharter {
    name: string;
    description: string;
    end_state: string;
    needs: Array<{ kind: string; description: string }>;
    tasks: Array<{ title: string; what?: string; why?: string; headsup?: string }>;
    end_state_criteria?: Array<{ kind: string; description: string }>;
    classification?: string;
    protocol?: string;
}

export function problemCharter(metadata: Record<string, unknown>): ProblemCharter | null {
    const c = metadata?.charter;
    if (!c || typeof c !== "object") return null;
    const obj = c as Record<string, unknown>;
    if (typeof obj.name !== "string" || typeof obj.end_state !== "string") return null;
    return {
        name: obj.name,
        description: typeof obj.description === "string" ? obj.description : "",
        end_state: obj.end_state,
        needs: Array.isArray(obj.needs) ? (obj.needs as ProblemCharter["needs"]) : [],
        tasks: Array.isArray(obj.tasks) ? (obj.tasks as ProblemCharter["tasks"]) : [],
        end_state_criteria: Array.isArray(obj.end_state_criteria) ? (obj.end_state_criteria as ProblemCharter["end_state_criteria"]) : [],
        classification: typeof obj.classification === "string" ? obj.classification : undefined,
        protocol: typeof obj.protocol === "string" ? obj.protocol : undefined,
    };
}

export interface ProblemCouncilRequest {
    problem: string;
    name?: string;
    type?: string;
    context?: string;
    preset?: string;
    dry_run?: boolean;
}

/** Hand Praxis a problem from the Chamber → problem council → project (dry_run: charter only). */
export async function summonProblemCouncil(input: ProblemCouncilRequest): Promise<CouncilSummonResponse> {
    const res = await fetch("/api/praxis/council/problem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        throw new Error(typeof data.error === "string" ? data.error : `Problem intake failed (${res.status})`);
    }
    if (data?.ok === false) {
        throw new Error(typeof data.error === "string" ? data.error : "Problem intake failed");
    }
    return data;
}

export type CouncilDeliverable = "analysis" | "project_plan" | "task_series";
export type CouncilDomain = "engineering" | "research" | "strategy";

export interface CouncilSummonRequest {
    topic: string;
    context?: string;
    deliverable?: CouncilDeliverable;
    project?: string;
    domain?: CouncilDomain;
    preset?: string;
    focus?: boolean;
    consultations?: string[];
    include_consultations?: boolean;
}

export interface CouncilSummonResponse {
    ok: boolean;
    result?: string;
    error?: string;
}

export async function summonCouncil(input: CouncilSummonRequest): Promise<CouncilSummonResponse> {
    const res = await fetch("/api/praxis/council/summon", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        throw new Error(typeof data.error === "string" ? data.error : `Council summon failed (${res.status})`);
    }
    if (data?.ok === false) {
        throw new Error(typeof data.error === "string" ? data.error : "Council summon failed");
    }
    return data;
}

export function sessionIdFromCouncilAck(text: string | undefined): string | null {
    const match =
        text?.match(/\bsession\s+`(council-[^`]+)`/i) ??
        text?.match(/\bsession\s+(council-[A-Za-z0-9_-]+)/i);
    return match?.[1] ?? null;
}

/** Duration for a full snapshot — mirrors the server's list computation. */
export function detailDurationMs(detail: CouncilSessionDetail): number {
    const last = Math.max(detail.createdAt, ...detail.theses.map((t) => t.recordedAt ?? 0));
    return detail.phase === "complete" ? last - detail.createdAt : Date.now() - detail.createdAt;
}

export function tokenUsageForCouncilResponse(item: {
    tokensUsed?: number | null;
    tokens_used?: number | null;
}): number | null {
    const value = item.tokensUsed ?? item.tokens_used;
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// ── Council arbiter (bridge Ops control) ────────────────────────────────

export type ArbiterSeat = "cli:claude-code" | "cli:codex";
export type ArbiterPreference = ArbiterSeat | "auto";

export interface CouncilArbiterState {
    preference: ArbiterPreference;
    /** The seat that would write the verdict for a council convened now. */
    next: ArbiterSeat;
}

export async function getCouncilArbiter(): Promise<CouncilArbiterState> {
    const res = await fetch("/api/praxis/council/arbiter", { cache: "no-store" });
    if (!res.ok) throw new Error(`Council arbiter request failed (${res.status})`);
    return res.json();
}

export async function setCouncilArbiter(preference: ArbiterPreference): Promise<CouncilArbiterState> {
    const res = await fetch("/api/praxis/council/arbiter", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preference }),
    });
    if (!res.ok) throw new Error(`Council arbiter update failed (${res.status})`);
    return res.json();
}

// ── Display helpers ─────────────────────────────────────────────────────

const SEAT_NAMES: Record<string, string> = {
    "cli:codex": "Codex",
    "cli:antigravity": "Antigravity",
    "cli:claude-code": "Claude Code",
};

/** "cli:claude-code" → "Claude Code"; "cli:claude-code (aggregator)" / "… (round 2)" → "Claude Code". */
export function seatDisplayName(voiceNameOrModel: string): string {
    const base = baseSeatName(voiceNameOrModel);
    if (SEAT_NAMES[base]) return SEAT_NAMES[base];
    const cli = base.match(/^cli:([\w-]+)(?:\/(.+))?$/);
    if (cli) {
        const backend = SEAT_NAMES[`cli:${cli[1]}`] ?? cli[1];
        return cli[2] ? `${backend} · ${cli[2]}` : backend;
    }
    return base;
}

export function isAggregatorVoice(voice: CouncilVoice): boolean {
    // New sessions suffix the NAME ("cli:claude-code (aggregator)"); sessions
    // recorded before 2026-07-10 suffixed the model instead.
    return /\(aggregator\)\s*$/.test(voice.name) || /\(aggregator\)\s*$/.test(voice.model);
}

export interface SessionKindInfo {
    label: string;
    accent: "violet" | "amber" | "cyan" | "emerald";
}

export function sessionKind(metadata: Record<string, unknown>): SessionKindInfo {
    const kind = metadata?.kind ?? (metadata?.deliverable ? "summoned" : undefined);
    if (kind === "knowledge-council") return { label: "Morning Council", accent: "amber" };
    if (kind === "morning-council") return { label: "Day-Plan Vote", accent: "amber" };
    if (kind === "status-report") return { label: "Status Report", accent: "cyan" };
    if (kind === "problem-council") return { label: "Problem Council", accent: "emerald" };
    return { label: "Summoned Council", accent: "violet" };
}

// ── Council benches (who sits on each council) ──────────────────────────
// Backed by Praxis's router-config.json moa.presets, relayed through
// /api/praxis/council/benches. Praxis validates every seat for REACHABILITY
// before writing — a paid OpenRouter model, an unknown CLI backend, a
// duplicated voice or an empty bench all come back as a 400 whose message is
// written for a human and should be shown verbatim.

export type BenchSeatKind = "cli" | "openrouter";

export interface BenchSeat {
    id: string;
    kind: BenchSeatKind;
    label: string;
    model?: string;
    contextWindow?: number;
    /** Lineage undisclosed. A label, not a warning — cloaked models are seated. */
    cloaked?: boolean;
}

export interface CouncilBench {
    name: string;
    isDefault: boolean;
    references: BenchSeat[];
    aggregator: BenchSeat;
    referenceMaxTokens?: number;
    aggregatorMaxTokens?: number;
    timeoutSeconds?: number;
}

export interface CouncilBenchCatalog {
    cli: BenchSeat[];
    openrouter: BenchSeat[];
}

export interface CouncilBenchState {
    benches: CouncilBench[];
    catalog: CouncilBenchCatalog;
    defaultPreset: string;
}

/** Human title for a bench id — "council-problem" reads as "Problem Solver". */
export function benchTitle(name: string): string {
    if (name === "council-default") return "Default Bench";
    if (name === "council-problem") return "Problem Solver";
    return name
        .replace(/^council-/, "")
        .split("-")
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" ");
}

export async function getCouncilBenches(): Promise<CouncilBenchState> {
    const res = await fetch("/api/praxis/council/benches", { cache: "no-store" });
    if (!res.ok) throw new Error(`Council benches request failed (${res.status})`);
    return (await res.json()) as CouncilBenchState;
}

export async function saveCouncilBench(
    name: string,
    update: { references: string[]; aggregator: string },
): Promise<CouncilBenchState> {
    const res = await fetch(`/api/praxis/council/benches/${encodeURIComponent(name)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(update),
    });
    const body = (await res.json().catch(() => ({}))) as Partial<CouncilBenchState> & { error?: string };
    // Praxis's validation message is written for the operator; surfacing a
    // generic "save failed" instead would hide which seat was the problem.
    if (!res.ok) throw new Error(body.error || `Bench update failed (${res.status})`);
    return body as CouncilBenchState;
}

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

/** Duration for a full snapshot — mirrors the server's list computation. */
export function detailDurationMs(detail: CouncilSessionDetail): number {
    const last = Math.max(detail.createdAt, ...detail.theses.map((t) => t.recordedAt ?? 0));
    return detail.phase === "complete" ? last - detail.createdAt : Date.now() - detail.createdAt;
}

// ── Display helpers ─────────────────────────────────────────────────────

const SEAT_NAMES: Record<string, string> = {
    "cli:codex": "Codex",
    "cli:antigravity": "Antigravity",
    "cli:claude-code": "Claude Code",
};

/** "cli:claude-code" → "Claude Code"; "cli:claude-code (aggregator)" → "Claude Code". */
export function seatDisplayName(voiceNameOrModel: string): string {
    const base = voiceNameOrModel.replace(/\s*\(aggregator\)\s*$/, "");
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
    accent: "violet" | "amber" | "cyan";
}

export function sessionKind(metadata: Record<string, unknown>): SessionKindInfo {
    const kind = metadata?.kind ?? (metadata?.deliverable ? "summoned" : undefined);
    if (kind === "knowledge-council") return { label: "Morning Council", accent: "amber" };
    if (kind === "status-report") return { label: "Status Report", accent: "cyan" };
    return { label: "Summoned Council", accent: "violet" };
}

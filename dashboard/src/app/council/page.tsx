"use client";

/**
 * The Council Chamber — live + historical multi-model deliberations.
 *
 * Data: Praxis data/council-sessions via /api/praxis/council/* (relayed by
 * the Nexus server). A live session (phase !== complete, < 3h old) renders
 * the animated chamber: reference seats around the table light up as their
 * theses land, then the aggregator drafts the verdict. History below;
 * clicking any session opens the full transcript — every seat's thesis and
 * the final verdict.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
    AlertTriangle,
    ArrowLeft,
    CheckCircle2,
    ChevronDown,
    ChevronRight,
    Clock,
    ExternalLink,
    Gavel,
    Landmark,
    Lightbulb,
    Loader2,
    RefreshCw,
    ScrollText,
    Send,
    Users,
    X,
    XCircle,
} from "lucide-react";
import { normalizeMarkdown } from "@/lib/normalizeMarkdown";
import { CouncilBenchControls } from "@/components/council-bench-controls";
import {
    baseSeatName,
    effectiveReferenceVoices,
    getCouncilSession,
    getCouncilSessions,
    isInterruptedSession,
    isLiveSession,
    isAggregatorVoice,
    isProblemCouncil,
    isRound2Voice,
    problemCharter,
    problemConsensus,
    referenceVoices,
    seatDisplayName,
    sessionIdFromCouncilAck,
    sessionKind,
    summonCouncil,
    summonProblemCouncil,
    detailDurationMs,
    tokenUsageForCouncilResponse,
    type CouncilSessionDetail,
    type CouncilSessionSummary,
    type CouncilVoice,
    type ProblemCouncilConsensus,
} from "@/lib/council";

// ── Small helpers ─────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
    if (!Number.isFinite(ms) || ms < 0) return "—";
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${s % 60}s`;
    return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function formatWhen(ts: number): string {
    const date = new Date(ts);
    const sameDay = date.toDateString() === new Date().toDateString();
    const time = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    if (sameDay) return `Today ${time}`;
    return `${date.toLocaleDateString("en-US", { month: "short", day: "numeric" })} ${time}`;
}

function formatTokens(tokens: number): string {
    return new Intl.NumberFormat("en-US").format(tokens);
}

function providerLabel(model: string): string {
    const normalized = model.replace(/\s*\(aggregator\)\s*$/, "");
    if (normalized.startsWith("cli:")) return "CLI subscription";
    const vendor = normalized.includes("/") ? normalized.split("/")[0].toLowerCase() : "";
    const lower = normalized.toLowerCase();
    if (vendor === "google" || lower.startsWith("gemini")) return "Google";
    if (vendor === "openai" || lower.startsWith("gpt") || lower.startsWith("o1") || lower.startsWith("o3")) return "OpenAI";
    if (vendor === "anthropic" || lower.startsWith("claude")) return "Anthropic";
    if (vendor === "xai" || lower.startsWith("grok")) return "xAI";
    if (vendor === "deepseek" || lower.startsWith("deepseek")) return "DeepSeek";
    if (vendor === "openrouter") return "OpenRouter";
    return vendor ? vendor.charAt(0).toUpperCase() + vendor.slice(1) : "Provider unknown";
}

function tokenLabel(status: CouncilVoice["status"], tokens: number | null): string {
    if (tokens !== null) return `${formatTokens(tokens)} tokens`;
    if (status === "pending" || status === "running") return "tokens pending";
    return "tokens not reported";
}

const ACCENT_STYLES: Record<string, string> = {
    amber: "bg-amber-500/15 border-amber-500/40 text-amber-300",
    violet: "bg-violet-500/15 border-violet-500/40 text-violet-300",
    cyan: "bg-cyan-500/15 border-cyan-500/40 text-cyan-300",
    emerald: "bg-emerald-500/15 border-emerald-500/40 text-emerald-300",
};

/** Phase label for the live banner — round-aware for the problem council. */
function livePhaseLabel(session: { phase: string; metadata: Record<string, unknown> }): string {
    if (isProblemCouncil(session.metadata)) {
        if (session.phase === "synthesis" || session.phase === "refinement") return "Aggregator is drafting the charter";
        if (session.phase === "deliberation") {
            return session.metadata.round === 2
                ? "Round 2 — the same sessions rank every idea"
                : "Round 1 — seats critique the setup and propose ideas";
        }
        return "Convening the problem council";
    }
    if (session.phase === "deliberation") return "Seats are deliberating";
    if (session.phase === "synthesis" || session.phase === "refinement") return "Aggregator is drafting the verdict";
    return "Convening";
}

function KindBadge({ metadata }: { metadata: Record<string, unknown> }) {
    const kind = sessionKind(metadata);
    return (
        <span
            className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${ACCENT_STYLES[kind.accent]}`}
        >
            {kind.label}
        </span>
    );
}

type SeatVisual = "waiting" | "speaking" | "reported" | "failed";

function seatVisual(voice: CouncilVoice): SeatVisual {
    if (voice.status === "success") return "reported";
    if (voice.status === "running") return "speaking";
    if (voice.status === "pending") return "waiting";
    return "failed";
}

// ── The Chamber (animated round table) ────────────────────────────────────

const SEAT_COLORS: Record<SeatVisual, { ring: string; fill: string; text: string }> = {
    waiting: { ring: "#334155", fill: "#0f172a", text: "#64748b" },
    speaking: { ring: "#f59e0b", fill: "#1e1305", text: "#fbbf24" },
    reported: { ring: "#22d3ee", fill: "#062a30", text: "#67e8f9" },
    failed: { ring: "#f87171", fill: "#2a0c0c", text: "#fca5a5" },
};

function Chamber({
    voices,
    phase,
    live,
}: {
    voices: CouncilVoice[];
    phase: string;
    live: boolean;
}) {
    const refs = effectiveReferenceVoices(voices);
    const aggregator = voices.find(isAggregatorVoice);
    const W = 560;
    const H = 330;
    const cx = W / 2;
    const cy = 235;
    const radius = 155;

    // Seats spread across the top arc, 150° → 30°.
    const seats = refs.map((voice, i) => {
        const t = refs.length === 1 ? 0.5 : i / (refs.length - 1);
        const deg = 150 - t * 120;
        const rad = (deg * Math.PI) / 180;
        return {
            voice,
            x: cx + radius * Math.cos(rad),
            y: cy - radius * Math.sin(rad),
        };
    });

    const aggregatorState: SeatVisual = aggregator
        ? seatVisual(aggregator)
        : phase === "complete"
          ? "reported"
          : "waiting";
    const deliberating = live && phase === "deliberation";
    const synthesizing = live && (phase === "synthesis" || phase === "refinement");

    return (
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full max-w-2xl mx-auto" role="img" aria-label="Council chamber">
            <defs>
                <radialGradient id="chamber-glow" cx="50%" cy="50%" r="50%">
                    <stop offset="0%" stopColor="#f59e0b" stopOpacity="0.35" />
                    <stop offset="100%" stopColor="#f59e0b" stopOpacity="0" />
                </radialGradient>
                <linearGradient id="sweep-grad" x1="0%" y1="0%" x2="100%" y2="0%">
                    <stop offset="0%" stopColor="#22d3ee" stopOpacity="0" />
                    <stop offset="100%" stopColor="#22d3ee" stopOpacity="0.5" />
                </linearGradient>
            </defs>

            {/* Table arc */}
            <circle cx={cx} cy={cy} r={radius} fill="none" stroke="#1e293b" strokeWidth="1.5" strokeDasharray="3 5" />
            <circle cx={cx} cy={cy} r={radius - 38} fill="none" stroke="#1e293b" strokeWidth="1" strokeDasharray="2 6" opacity="0.6" />

            {/* Radar sweep while seats deliberate */}
            {deliberating && (
                <g className="council-sweep" style={{ transformOrigin: `${cx}px ${cy}px` }}>
                    <line x1={cx} y1={cy} x2={cx + radius} y2={cy} stroke="url(#sweep-grad)" strokeWidth="2.5" />
                </g>
            )}

            {/* Spokes seat → aggregator; flowing dashes once a seat reports */}
            {seats.map(({ voice, x, y }) => {
                const v = seatVisual(voice);
                const flowing = v === "reported" && (deliberating || synthesizing);
                return (
                    <line
                        key={`spoke-${voice.name}`}
                        x1={x}
                        y1={y}
                        x2={cx}
                        y2={cy}
                        stroke={v === "reported" ? "#155e6b" : "#1e293b"}
                        strokeWidth="1.5"
                        strokeDasharray={flowing ? "4 6" : v === "reported" ? "none" : "2 6"}
                        className={flowing ? "council-flow" : undefined}
                        opacity={v === "waiting" ? 0.4 : 0.9}
                    />
                );
            })}

            {/* Reference seats */}
            {seats.map(({ voice, x, y }) => {
                const v = seatVisual(voice);
                const c = SEAT_COLORS[v];
                return (
                    <g key={voice.name}>
                        {v === "speaking" && (
                            <>
                                <circle cx={x} cy={y} r="26" fill="none" stroke={c.ring} strokeWidth="1.5" className="council-pulse" />
                                <circle cx={x} cy={y} r="26" fill="none" stroke={c.ring} strokeWidth="1" className="council-pulse council-pulse-delay" />
                            </>
                        )}
                        <circle cx={x} cy={y} r="22" fill={c.fill} stroke={c.ring} strokeWidth="2" />
                        <text x={x} y={y + 1} textAnchor="middle" dominantBaseline="middle" fontSize="13" fill={c.text}>
                            {v === "reported" ? "✓" : v === "failed" ? "✕" : v === "speaking" ? "…" : "·"}
                        </text>
                        <text x={x} y={y - 32} textAnchor="middle" fontSize="11" fontWeight="600" fill={c.text}>
                            {seatDisplayName(voice.name)}
                        </text>
                        <text x={x} y={y + 38} textAnchor="middle" fontSize="9" fill="#64748b">
                            {v === "speaking"
                                ? "deliberating"
                                : v === "reported"
                                  ? `reported${voice.elapsedMs ? ` · ${formatDuration(voice.elapsedMs)}` : ""}`
                                  : v === "failed"
                                    ? voice.status
                                    : "waiting"}
                        </text>
                    </g>
                );
            })}

            {/* Aggregator at the head of the table */}
            {synthesizing && <circle cx={cx} cy={cy} r="52" fill="url(#chamber-glow)" className="council-breathe" />}
            <circle
                cx={cx}
                cy={cy}
                r="30"
                fill={synthesizing ? "#1e1305" : SEAT_COLORS[aggregatorState].fill}
                stroke={synthesizing ? "#f59e0b" : SEAT_COLORS[aggregatorState].ring}
                strokeWidth="2.5"
                className={synthesizing ? "council-breathe" : undefined}
            />
            <text x={cx} y={cy + 1} textAnchor="middle" dominantBaseline="middle" fontSize="15">
                ⚖️
            </text>
            <text x={cx} y={cy + 48} textAnchor="middle" fontSize="11" fontWeight="600" fill={synthesizing ? "#fbbf24" : SEAT_COLORS[aggregatorState].text}>
                {aggregator ? seatDisplayName(aggregator.name) : "Aggregator"}
            </text>
            <text x={cx} y={cy + 61} textAnchor="middle" fontSize="9" fill="#64748b">
                {synthesizing
                    ? "drafting the verdict"
                    : aggregatorState === "reported"
                      ? "verdict delivered"
                      : aggregatorState === "failed"
                        ? "failed"
                        : "awaiting theses"}
            </text>
        </svg>
    );
}

// ── Live session banner ───────────────────────────────────────────────────

function LiveSessionPanel({ session, onOpen }: { session: CouncilSessionSummary; onOpen: () => void }) {
    const [now, setNow] = useState(Date.now());
    useEffect(() => {
        const t = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(t);
    }, []);

    const refs = effectiveReferenceVoices(session.voices);
    const reported = refs.filter((v) => v.status === "success" || v.status === "error" || v.status === "timeout").length;
    const phaseLabel = livePhaseLabel(session);

    return (
        <section className="relative overflow-hidden rounded-2xl border border-amber-500/30 bg-gradient-to-b from-slate-900 to-slate-950">
            <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-amber-400/60 to-transparent" />
            <div className="flex flex-col lg:flex-row">
                <div className="flex-1 p-4 lg:p-6">
                    <Chamber voices={session.voices} phase={session.phase} live />
                </div>
                <div className="lg:w-80 shrink-0 border-t lg:border-t-0 lg:border-l border-slate-800/60 p-5 space-y-4">
                    <div className="flex items-center gap-2">
                        <span className="relative flex h-2.5 w-2.5">
                            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-60" />
                            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-amber-400" />
                        </span>
                        <span className="text-xs font-bold uppercase tracking-widest text-amber-300">Council in session</span>
                    </div>
                    <KindBadge metadata={session.metadata} />
                    <h2 className="text-sm font-semibold text-white leading-snug">{session.topic}</h2>
                    <div className="space-y-2 text-xs text-slate-400">
                        <div className="flex items-center gap-2">
                            <Clock size={12} className="text-slate-500" />
                            <span>
                                Elapsed{" "}
                                <span className="font-mono text-amber-200">{formatDuration(now - session.createdAt)}</span>
                            </span>
                        </div>
                        <div className="flex items-center gap-2">
                            <Users size={12} className="text-slate-500" />
                            <span>
                                {reported}/{refs.length} seats reported
                            </span>
                        </div>
                        <div className="flex items-center gap-2">
                            <Gavel size={12} className="text-slate-500" />
                            <span className="text-slate-300">
                                {phaseLabel}
                                <span className="council-dots" aria-hidden />
                            </span>
                        </div>
                    </div>
                    <button
                        onClick={onOpen}
                        className="w-full rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs font-semibold text-amber-200 hover:bg-amber-500/20 transition-colors"
                    >
                        Watch the transcript so far →
                    </button>
                </div>
            </div>
        </section>
    );
}

// ── Summon panel ─────────────────────────────────────────────────────────

function SummonCouncilPanel({ onSummoned }: { onSummoned: (sessionId: string | null) => void }) {
    const [mode, setMode] = useState<"deliberation" | "problem">("deliberation");
    const [topic, setTopic] = useState("");
    const [context, setContext] = useState("");
    const [domain, setDomain] = useState<"" | "engineering" | "research" | "strategy">("");
    const [focus, setFocus] = useState(false);
    const [problemName, setProblemName] = useState("");
    const [dryRun, setDryRun] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [ack, setAck] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const canSubmit = topic.trim().length > 0 && !submitting;

    async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (!canSubmit) return;
        setSubmitting(true);
        setAck(null);
        setError(null);
        try {
            const response =
                mode === "problem"
                    ? await summonProblemCouncil({
                          problem: topic.trim(),
                          ...(problemName.trim() ? { name: problemName.trim() } : {}),
                          ...(context.trim() ? { context: context.trim() } : {}),
                          ...(dryRun ? { dry_run: true } : {}),
                      })
                    : await summonCouncil({
                          topic: topic.trim(),
                          ...(context.trim() ? { context: context.trim() } : {}),
                          deliverable: "analysis",
                          ...(domain ? { domain } : {}),
                          focus,
                      });
            const message = response.result || (mode === "problem" ? "Problem council convened." : "Council convened.");
            setAck(message);
            onSummoned(sessionIdFromCouncilAck(message));
        } catch (err) {
            setError(err instanceof Error ? err.message : mode === "problem" ? "Problem intake failed" : "Council summon failed");
        } finally {
            setSubmitting(false);
        }
    }

    const tab = (value: "deliberation" | "problem", label: string) => (
        <button
            type="button"
            onClick={() => {
                setMode(value);
                setAck(null);
                setError(null);
            }}
            className={`rounded-md border px-3 py-1.5 text-xs font-semibold transition-colors ${
                mode === value
                    ? value === "problem"
                        ? "border-emerald-500/60 bg-emerald-500/15 text-emerald-200"
                        : "border-amber-500/60 bg-amber-500/15 text-amber-200"
                    : "border-slate-700 bg-slate-900/60 text-slate-400 hover:border-slate-600 hover:text-slate-200"
            }`}
        >
            {label}
        </button>
    );

    return (
        <section className="rounded-2xl border border-amber-500/25 bg-slate-900/50 overflow-hidden">
            <div className="border-b border-slate-800 px-5 py-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                        <Gavel size={15} className="text-amber-300" />
                        <h2 className="text-xs font-bold uppercase tracking-widest text-amber-300">
                            {mode === "problem" ? "Hand Praxis a problem" : "Summon the Cabinet"}
                        </h2>
                    </div>
                    <div className="flex items-center gap-2">
                        {tab("deliberation", "Deliberation")}
                        {tab("problem", "Problem → project")}
                    </div>
                </div>
                <p className="mt-1 text-xs text-slate-500">
                    {mode === "problem"
                        ? "Three top-tier seats (Codex GPT-5.6 Sol, Antigravity Gemini 3.1 Pro, Claude Fable 5) critique the setup and propose ideas, the same sessions resume to rank every idea, the ranks are aggregated, and the aggregator drafts the charter that sets the project up. 10–25 minutes on subscription capacity."
                        : "Runs the configured council seats and may use paid API or subscription capacity."}
                </p>
            </div>
            <form onSubmit={handleSubmit} className="p-5 space-y-4">
                <textarea
                    value={topic}
                    onChange={(event) => setTopic(event.target.value)}
                    rows={mode === "problem" ? 5 : 3}
                    placeholder={mode === "problem" ? "Describe the problem in your own words — what's wrong, what solved would look like, what you already know" : "Question for the Cortex Council"}
                    className="w-full resize-y rounded-lg border border-slate-700 bg-slate-950/70 px-3 py-2 text-sm text-slate-100 outline-none transition-colors placeholder:text-slate-600 focus:border-amber-500/70"
                />
                <textarea
                    value={context}
                    onChange={(event) => setContext(event.target.value)}
                    rows={2}
                    placeholder={mode === "problem" ? "Optional research, notes, or constraints the seats should see verbatim" : "Optional context, constraints, or notes"}
                    className="w-full resize-y rounded-lg border border-slate-800 bg-slate-950/50 px-3 py-2 text-xs text-slate-200 outline-none transition-colors placeholder:text-slate-600 focus:border-slate-600"
                />
                {mode === "problem" ? (
                    <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                        <input
                            value={problemName}
                            onChange={(event) => setProblemName(event.target.value)}
                            placeholder="Preferred project name (optional)"
                            className="w-full md:max-w-xs rounded-lg border border-slate-800 bg-slate-950/50 px-3 py-2 text-xs text-slate-200 outline-none transition-colors placeholder:text-slate-600 focus:border-slate-600"
                        />
                        <div className="flex items-center gap-3">
                            <label className="inline-flex items-center gap-2 text-xs text-slate-400" title="Deliberate and draft the charter, but create nothing">
                                <input
                                    type="checkbox"
                                    checked={dryRun}
                                    onChange={(event) => setDryRun(event.target.checked)}
                                    className="h-4 w-4 rounded border-slate-700 bg-slate-950 accent-emerald-500"
                                />
                                Dry run (charter only)
                            </label>
                            <button
                                type="submit"
                                disabled={!canSubmit}
                                className="inline-flex items-center gap-2 rounded-lg border border-emerald-500/50 bg-emerald-500/15 px-4 py-2 text-xs font-bold uppercase tracking-wider text-emerald-100 transition-colors hover:bg-emerald-500/25 disabled:cursor-not-allowed disabled:border-slate-700 disabled:bg-slate-800 disabled:text-slate-500"
                            >
                                {submitting ? <Loader2 size={14} className="animate-spin" /> : <Lightbulb size={14} />}
                                Convene the problem council
                            </button>
                        </div>
                    </div>
                ) : (
                    <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                        <div className="flex flex-wrap items-center gap-2">
                            {(["", "engineering", "research", "strategy"] as const).map((value) => (
                                <button
                                    key={value || "general"}
                                    type="button"
                                    onClick={() => setDomain(value)}
                                    className={`rounded-md border px-3 py-1.5 text-xs font-semibold transition-colors ${
                                        domain === value
                                            ? "border-amber-500/60 bg-amber-500/15 text-amber-200"
                                            : "border-slate-700 bg-slate-900/60 text-slate-400 hover:border-slate-600 hover:text-slate-200"
                                    }`}
                                >
                                    {value || "General"}
                                </button>
                            ))}
                        </div>
                        <div className="flex items-center gap-3">
                            <label className="inline-flex items-center gap-2 text-xs text-slate-400">
                                <input
                                    type="checkbox"
                                    checked={focus}
                                    onChange={(event) => setFocus(event.target.checked)}
                                    className="h-4 w-4 rounded border-slate-700 bg-slate-950 accent-amber-500"
                                />
                                Focused bench
                            </label>
                            <button
                                type="submit"
                                disabled={!canSubmit}
                                className="inline-flex items-center gap-2 rounded-lg border border-amber-500/50 bg-amber-500/15 px-4 py-2 text-xs font-bold uppercase tracking-wider text-amber-100 transition-colors hover:bg-amber-500/25 disabled:cursor-not-allowed disabled:border-slate-700 disabled:bg-slate-800 disabled:text-slate-500"
                            >
                                {submitting ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
                                Summon
                            </button>
                        </div>
                    </div>
                )}
                {ack && (
                    <div className="rounded-lg border border-cyan-500/25 bg-cyan-500/10 px-3 py-2 text-xs text-cyan-100 whitespace-pre-wrap">
                        {ack}
                    </div>
                )}
                {error && (
                    <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">
                        {error}
                    </div>
                )}
            </form>
        </section>
    );
}

// ── Session detail (transcript) ───────────────────────────────────────────

const MARKDOWN_CLASSES =
    "prose prose-invert prose-sm max-w-none prose-headings:text-white prose-headings:font-semibold prose-p:text-slate-300 prose-strong:text-slate-200 prose-li:text-slate-300 prose-a:text-cyan-400 prose-hr:border-slate-800 prose-code:text-cyan-300 prose-code:bg-slate-800/60 prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-pre:bg-slate-900 prose-pre:border prose-pre:border-slate-800";

function ThesisCard({ voice, detail, cliSession }: { voice: CouncilVoice; detail: CouncilSessionDetail; cliSession?: string | null }) {
    const [open, setOpen] = useState(false);
    const thesis = detail.theses.find((t) => t.voice === voice.name || t.model === voice.name);
    const v = seatVisual(voice);
    const c = SEAT_COLORS[v];
    const tokens = thesis ? tokenUsageForCouncilResponse(thesis) : tokenUsageForCouncilResponse(voice);
    const text =
        (typeof thesis?.parsed === "string" && thesis.parsed) || thesis?.raw || "";

    return (
        <div className="rounded-xl border border-slate-800 bg-slate-900/40 overflow-hidden">
            <button
                onClick={() => setOpen(!open)}
                className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-slate-800/30 transition-colors"
            >
                <div className="flex items-center gap-3 min-w-0">
                    <span
                        className="inline-flex h-7 w-7 items-center justify-center rounded-full border text-[11px] shrink-0"
                        style={{ borderColor: c.ring, backgroundColor: c.fill, color: c.text }}
                    >
                        {v === "reported" ? <CheckCircle2 size={13} /> : v === "failed" ? <XCircle size={13} /> : v === "speaking" ? <Loader2 size={13} className="animate-spin" /> : "·"}
                    </span>
                    <div className="min-w-0">
                        <div className="text-xs font-semibold text-slate-200">{seatDisplayName(voice.name)}</div>
                        <div className="text-[10px] text-slate-500 font-mono truncate">
                            {providerLabel(voice.model)} · {baseSeatName(voice.model)}
                            {thesis ? ` · ${formatDuration(thesis.elapsedMs)}` : ""}
                            {` · ${tokenLabel(voice.status, tokens)}`}
                            {thesis && thesis.status !== "success" ? ` · ${thesis.status}` : ""}
                            {cliSession ? ` · CLI session ${cliSession}` : ""}
                        </div>
                    </div>
                </div>
                <span className="text-slate-500">{open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</span>
            </button>
            {open && (
                <div className="border-t border-slate-800/60 px-4 py-3">
                    {text ? (
                        <div className={MARKDOWN_CLASSES}>
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>{normalizeMarkdown(text)}</ReactMarkdown>
                        </div>
                    ) : thesis?.error ? (
                        <p className="text-xs text-red-300">
                            <AlertTriangle size={12} className="inline mr-1" />
                            {thesis.error}
                        </p>
                    ) : (
                        <p className="text-xs text-slate-500 italic">No thesis recorded{voice.status === "running" ? " yet — the seat is still deliberating." : "."}</p>
                    )}
                </div>
            )}
        </div>
    );
}

function RankingTable({ consensus }: { consensus: ProblemCouncilConsensus }) {
    const seats = Array.from(new Set(consensus.ranking.flatMap((r) => Object.keys(r.positions))));
    const ideaById = new Map(consensus.ideas.map((i) => [i.id, i]));
    return (
        <div className="overflow-x-auto">
            <table className="w-full text-xs">
                <thead>
                    <tr className="text-[10px] uppercase tracking-wider text-slate-500">
                        <th className="px-2 py-1 text-left">#</th>
                        <th className="px-2 py-1 text-left">Idea</th>
                        <th className="px-2 py-1 text-left">From</th>
                        <th className="px-2 py-1 text-right">Score</th>
                        {seats.map((s) => (
                            <th key={s} className="px-2 py-1 text-center" title={s}>
                                {seatDisplayName(s).replace(/ · .*$/, "")}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {consensus.ranking.map((r, i) => {
                        const idea = ideaById.get(r.id);
                        return (
                            <tr key={r.id} className={`border-t border-slate-800/60 ${i === 0 ? "bg-emerald-500/5" : ""}`}>
                                <td className="px-2 py-1.5 font-mono text-slate-500">{i + 1}</td>
                                <td className="px-2 py-1.5 text-slate-200" title={idea ? `${idea.what}\n\n${idea.why}` : undefined}>
                                    <span className="font-mono text-emerald-300">{r.id}</span> {r.title}
                                    {r.dropped > 0 && <span className="ml-1 text-[10px] text-red-300">dropped ×{r.dropped}</span>}
                                </td>
                                <td className="px-2 py-1.5 text-slate-500">{r.seatLabel}</td>
                                <td className="px-2 py-1.5 text-right font-mono text-slate-300">
                                    {r.score}/{consensus.maxScore}
                                </td>
                                {seats.map((s) => {
                                    const p = r.positions[s];
                                    const reason = r.reasons[s];
                                    return (
                                        <td key={s} className="px-2 py-1.5 text-center font-mono text-slate-400" title={reason}>
                                            {p ? `#${p}` : reason?.startsWith("DROP") ? "drop" : "—"}
                                        </td>
                                    );
                                })}
                            </tr>
                        );
                    })}
                </tbody>
            </table>
        </div>
    );
}

function ProblemCouncilDetail({ detail, live }: { detail: CouncilSessionDetail; live: boolean }) {
    const meta = detail.metadata;
    const consensus = problemConsensus(detail);
    const charter = problemCharter(meta);
    const projectId = typeof meta.projectId === "string" ? meta.projectId : null;
    const projectName = typeof meta.project === "string" ? meta.project : charter?.name ?? null;
    const round1 = referenceVoices(detail.voices);
    const round2 = detail.voices.filter(isRound2Voice);
    const aggregator = detail.voices.find(isAggregatorVoice);
    const r1Sessions = (meta.round1Sessions ?? {}) as Record<string, string | null>;
    const r2Sessions = (meta.round2Sessions ?? {}) as Record<string, string | null>;
    const seatCards = (voices: CouncilVoice[], sessions: Record<string, string | null>) =>
        voices.map((voice) => <ThesisCard key={voice.name} voice={voice} detail={detail} cliSession={sessions[baseSeatName(voice.name)] ?? null} />);

    return (
        <div className="space-y-4 px-5 py-4">
            {/* The problem + the outcome */}
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-4">
                    <h3 className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-2">The problem (Robert&apos;s words)</h3>
                    <p className="text-sm text-slate-200 whitespace-pre-wrap leading-relaxed">{String(meta.problem ?? detail.topic)}</p>
                    {typeof meta.context === "string" && meta.context && (
                        <p className="mt-2 text-xs text-slate-500 whitespace-pre-wrap">{meta.context}</p>
                    )}
                </div>
                <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/5 p-4">
                    <h3 className="text-[10px] font-bold uppercase tracking-widest text-emerald-300 mb-2">
                        {meta.dryRun ? "Charter (dry run — nothing created)" : projectId ? "Project created" : live ? "Charter pending" : "Charter"}
                    </h3>
                    {charter ? (
                        <div className="space-y-1.5 text-xs text-slate-300">
                            <div className="flex items-center gap-2 flex-wrap">
                                <span className="text-sm font-semibold text-white">{projectName ?? charter.name}</span>
                                {projectId && (
                                    <Link href={`/project/${projectId}`} className="inline-flex items-center gap-1 text-[11px] text-cyan-300 hover:text-cyan-200">
                                        open project <ExternalLink size={11} />
                                    </Link>
                                )}
                                {typeof meta.charterSource === "string" && meta.charterSource === "mechanical" && (
                                    <span className="text-[10px] uppercase tracking-wider text-amber-300 border border-amber-500/40 rounded-full px-2 py-0.5">mechanical charter</span>
                                )}
                            </div>
                            <p className="text-slate-400">{charter.description}</p>
                            <p><span className="text-slate-500">End state:</span> {charter.end_state}</p>
                            <p>
                                <span className="text-slate-500">Triage:</span> {charter.classification ?? "—"} → <span className="font-mono">{charter.protocol ?? "—"}</span>
                            </p>
                            {charter.needs.length > 0 && (
                                <p>
                                    <span className="text-slate-500">Needs:</span> {charter.needs.map((n) => `${n.kind} — ${n.description}`).join("; ")}
                                </p>
                            )}
                            {charter.tasks.length > 0 && (
                                <ol className="list-decimal pl-4 space-y-0.5 text-slate-200">
                                    {charter.tasks.map((t, i) => (
                                        <li key={i}>
                                            {t.title}
                                            {Array.isArray(meta.taskIds) && typeof (meta.taskIds as unknown[])[i] === "string" && (
                                                <Link href={`/task/${(meta.taskIds as string[])[i]}`} className="ml-1 font-mono text-[10px] text-cyan-400 hover:text-cyan-300">
                                                    {(meta.taskIds as string[])[i].slice(0, 8)}
                                                </Link>
                                            )}
                                        </li>
                                    ))}
                                </ol>
                            )}
                            {typeof meta.intakeError === "string" && (
                                <p className="text-red-300"><AlertTriangle size={12} className="inline mr-1" />{meta.intakeError}</p>
                            )}
                        </div>
                    ) : (
                        <p className="text-xs text-slate-500 italic">
                            {live ? "The aggregator hasn't drafted the charter yet." : typeof meta.error === "string" ? meta.error : "No charter was recorded."}
                        </p>
                    )}
                </div>
            </div>

            {/* Aggregate ranking */}
            {consensus && (
                <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
                    <div className="flex items-center justify-between gap-3 mb-2 flex-wrap">
                        <h3 className="text-[10px] font-bold uppercase tracking-widest text-slate-300">
                            Aggregate ranking — Borda across {consensus.ballots.length} ballot(s), {consensus.ideas.length} idea(s)
                        </h3>
                        <span className="text-[10px] text-slate-500">
                            {Math.round(consensus.agreement * 100)}% of seats had #1 in their top 3
                            {typeof meta.quorum === "string" && meta.quorum !== "full" ? ` · quorum ${meta.quorum}` : ""}
                        </span>
                    </div>
                    <RankingTable consensus={consensus} />
                    {consensus.merges.length > 0 && (
                        <p className="mt-2 text-[11px] text-slate-500">Flagged duplicates: {consensus.merges.map(([a, b]) => `${a}≈${b}`).join(", ")}</p>
                    )}
                </div>
            )}

            {/* Verdict markdown + the debate by round */}
            <div className="grid grid-cols-1 xl:grid-cols-5 gap-4">
                <div className="xl:col-span-3 rounded-xl border border-slate-800 bg-slate-900/40 p-4">
                    <div className="flex items-center gap-2 mb-3">
                        <Gavel size={14} className="text-amber-400" />
                        <h3 className="text-xs font-bold uppercase tracking-widest text-amber-300">Verdict</h3>
                    </div>
                    {detail.synthesis ? (
                        <div className={`${MARKDOWN_CLASSES} max-h-[640px] overflow-y-auto pr-2`}>
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>{normalizeMarkdown(detail.synthesis)}</ReactMarkdown>
                        </div>
                    ) : (
                        <p className="text-xs text-slate-500 italic">{live ? "Not yet — the council is still in session." : "No verdict was recorded for this session."}</p>
                    )}
                </div>
                <div className="xl:col-span-2 space-y-4">
                    <div className="space-y-2">
                        <div className="flex items-center gap-2">
                            <Lightbulb size={14} className="text-slate-400" />
                            <h3 className="text-xs font-bold uppercase tracking-widest text-slate-300">Round 1 — setup critique &amp; ideas</h3>
                        </div>
                        {seatCards(round1, r1Sessions)}
                    </div>
                    <div className="space-y-2">
                        <div className="flex items-center gap-2">
                            <Users size={14} className="text-slate-400" />
                            <h3 className="text-xs font-bold uppercase tracking-widest text-slate-300">Round 2 — rankings (same sessions, resumed)</h3>
                        </div>
                        {round2.length > 0 ? seatCards(round2, r2Sessions) : <p className="text-xs text-slate-500 italic">{live ? "Round 2 hasn't opened yet." : "Round 2 never ran."}</p>}
                    </div>
                    {aggregator && (
                        <div className="space-y-2">
                            <div className="flex items-center gap-2">
                                <Gavel size={14} className="text-slate-400" />
                                <h3 className="text-xs font-bold uppercase tracking-widest text-slate-300">Aggregator — charter draft</h3>
                            </div>
                            <ThesisCard voice={aggregator} detail={detail} />
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

function SessionDetailPanel({
    sessionId,
    live,
    onClose,
}: {
    sessionId: string;
    live: boolean;
    onClose: () => void;
}) {
    const [detail, setDetail] = useState<CouncilSessionDetail | null>(null);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(() => {
        getCouncilSession(sessionId)
            .then((d) => {
                setDetail(d);
                setError(null);
            })
            .catch((err) => setError(err instanceof Error ? err.message : String(err)));
    }, [sessionId]);

    useEffect(() => {
        setDetail(null);
        load();
    }, [load]);

    // Live transcript: refresh while the session is in flight.
    useEffect(() => {
        if (!live) return;
        const t = setInterval(load, 5000);
        return () => clearInterval(t);
    }, [live, load]);

    const refs = detail ? referenceVoices(detail.voices) : [];
    const interrupted = detail ? isInterruptedSession(detail) : false;
    const problem = detail ? isProblemCouncil(detail.metadata) : false;
    const reportedSeats = detail
        ? problem
            ? effectiveReferenceVoices(detail.voices).filter((v) => v.status === "success").length
            : detail.stats.successCount
        : 0;

    return (
        <section className="rounded-2xl border border-slate-700 bg-slate-900/60 overflow-hidden">
            <div className="flex items-start justify-between gap-4 border-b border-slate-800 px-5 py-4">
                <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                        {detail && <KindBadge metadata={detail.metadata} />}
                        {detail?.metadata?.domain ? (
                            <span className="text-[10px] uppercase tracking-wider text-slate-400 border border-slate-700 rounded-full px-2 py-0.5">
                                {String(detail.metadata.domain)}
                            </span>
                        ) : null}
                        {problem && detail?.metadata?.dryRun ? (
                            <span className="text-[10px] uppercase tracking-wider text-slate-400 border border-slate-700 rounded-full px-2 py-0.5">dry run</span>
                        ) : null}
                        {interrupted && (
                            <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider text-red-300 border border-red-500/40 bg-red-500/10 rounded-full px-2 py-0.5">
                                <AlertTriangle size={10} /> interrupted
                            </span>
                        )}
                    </div>
                    <h2 className="mt-1.5 text-base font-semibold text-white leading-snug">{detail?.topic ?? sessionId}</h2>
                    {detail && (
                        <p className="mt-1 text-[11px] text-slate-500 font-mono">
                            {formatWhen(detail.createdAt)} · {formatDuration(detailDurationMs(detail))} ·{" "}
                            {reportedSeats}/{refs.length} seats{problem ? " × 2 rounds" : ""} · session {detail.sessionId}
                        </p>
                    )}
                </div>
                <button onClick={onClose} className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-800 hover:text-white transition-colors shrink-0">
                    <X size={16} />
                </button>
            </div>

            {error && <div className="px-5 py-4 text-sm text-red-300">{error}</div>}
            {!detail && !error && (
                <div className="flex items-center justify-center py-12">
                    <Loader2 size={20} className="animate-spin text-slate-500" />
                </div>
            )}

            {detail && problem && <ProblemCouncilDetail detail={detail} live={live} />}

            {detail && !problem && (
                <div className="grid grid-cols-1 xl:grid-cols-5 gap-0">
                    {/* Verdict */}
                    <div className="xl:col-span-3 px-5 py-4 border-b xl:border-b-0 xl:border-r border-slate-800/60">
                        <div className="flex items-center gap-2 mb-3">
                            <Gavel size={14} className="text-amber-400" />
                            <h3 className="text-xs font-bold uppercase tracking-widest text-amber-300">Verdict</h3>
                        </div>
                        {detail.synthesis ? (
                            <div className={`${MARKDOWN_CLASSES} max-h-[520px] overflow-y-auto pr-2`}>
                                <ReactMarkdown remarkPlugins={[remarkGfm]}>{normalizeMarkdown(detail.synthesis)}</ReactMarkdown>
                            </div>
                        ) : (
                            <p className="text-xs text-slate-500 italic">
                                {live ? "The aggregator hasn't delivered the verdict yet." : "No verdict was recorded for this session."}
                            </p>
                        )}
                        {detail.finalRecommendations.length > 0 && (
                            <div className="mt-4 rounded-lg border border-cyan-500/20 bg-cyan-500/5 p-3">
                                <h4 className="text-[10px] font-bold uppercase tracking-widest text-cyan-300 mb-2">Recommendations</h4>
                                <ul className="space-y-1.5">
                                    {detail.finalRecommendations.map((r, i) => (
                                        <li key={i} className="text-xs text-slate-300 flex gap-2">
                                            <span className="text-cyan-400 shrink-0">▸</span>
                                            <span>{r}</span>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        )}
                    </div>

                    {/* Seat theses */}
                    <div className="xl:col-span-2 px-5 py-4 space-y-2.5">
                        <div className="flex items-center gap-2 mb-1">
                            <Users size={14} className="text-slate-400" />
                            <h3 className="text-xs font-bold uppercase tracking-widest text-slate-300">The debate — seat theses</h3>
                        </div>
                        {refs.map((voice) => (
                            <ThesisCard key={voice.name} voice={voice} detail={detail} />
                        ))}
                        {refs.length === 0 && <p className="text-xs text-slate-500 italic">No seats recorded.</p>}
                    </div>
                </div>
            )}
        </section>
    );
}

// ── History list ──────────────────────────────────────────────────────────

function HistoryRow({
    session,
    selected,
    onSelect,
}: {
    session: CouncilSessionSummary;
    selected: boolean;
    onSelect: () => void;
}) {
    const refs = referenceVoices(session.voices);
    const reported = isProblemCouncil(session.metadata)
        ? effectiveReferenceVoices(session.voices).filter((v) => v.status === "success").length
        : session.stats.successCount;
    const interrupted = isInterruptedSession(session);
    const live = isLiveSession(session);
    return (
        <button
            onClick={onSelect}
            className={`w-full text-left rounded-xl border px-4 py-3 transition-all ${
                selected
                    ? "border-amber-500/50 bg-amber-500/5"
                    : "border-slate-800 bg-slate-900/40 hover:border-slate-700 hover:bg-slate-900/70"
            }`}
        >
            <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2.5 min-w-0">
                    {live ? (
                        <Loader2 size={14} className="animate-spin text-amber-400 shrink-0" />
                    ) : interrupted ? (
                        <AlertTriangle size={14} className="text-red-400 shrink-0" />
                    ) : reported > 0 ? (
                        <CheckCircle2 size={14} className="text-cyan-400 shrink-0" />
                    ) : (
                        <XCircle size={14} className="text-slate-600 shrink-0" />
                    )}
                    <span className="text-sm font-medium text-slate-200 truncate">{session.topic}</span>
                </div>
                <KindBadge metadata={session.metadata} />
            </div>
            <div className="mt-1.5 flex items-center gap-3 text-[10px] text-slate-500 font-mono pl-6">
                <span>{formatWhen(session.createdAt)}</span>
                <span>
                    {reported}/{refs.length || session.stats.voiceCount} seats
                </span>
                <span>{formatDuration(session.durationMs)}</span>
                <span className="uppercase tracking-wider">{live ? "in session" : interrupted ? "interrupted" : session.phase}</span>
            </div>
        </button>
    );
}

// ── Page ──────────────────────────────────────────────────────────────────

export default function CouncilPage() {
    const [sessions, setSessions] = useState<CouncilSessionSummary[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const detailRef = useRef<HTMLDivElement | null>(null);

    const load = useCallback(async () => {
        try {
            const data = await getCouncilSessions();
            setSessions(data.sessions);
            setError(null);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to reach the council archive");
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        load();
    }, [load]);

    const liveSession = useMemo(() => sessions.find(isLiveSession) ?? null, [sessions]);

    // Poll fast while a council sits, lazily otherwise.
    useEffect(() => {
        const t = setInterval(load, liveSession ? 5000 : 30000);
        return () => clearInterval(t);
    }, [load, liveSession]);

    const openDetail = useCallback((id: string) => {
        setSelectedId(id);
        setTimeout(() => detailRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
    }, []);

    // Deep link: /council?session=<id> opens that transcript (chat cards, the
    // Ops console and the bridge link here). Read once on mount; keep the URL
    // in step so a transcript can be shared by copying the address.
    useEffect(() => {
        if (typeof window === "undefined") return;
        const fromUrl = new URLSearchParams(window.location.search).get("session");
        if (fromUrl && /^[A-Za-z0-9_-]+$/.test(fromUrl)) openDetail(fromUrl);
    }, [openDetail]);
    useEffect(() => {
        if (typeof window === "undefined") return;
        const url = new URL(window.location.href);
        if (selectedId) url.searchParams.set("session", selectedId);
        else url.searchParams.delete("session");
        window.history.replaceState(null, "", url.toString());
    }, [selectedId]);

    const handleSummoned = useCallback(
        async (sessionId: string | null) => {
            setLoading(true);
            await load();
            if (sessionId) openDetail(sessionId);
        },
        [load, openDetail],
    );

    return (
        <main className="min-h-screen bg-slate-950 text-slate-200">
            {/* Custom chamber animations */}
            <style>{`
                .council-sweep { animation: council-sweep 6s linear infinite; }
                @keyframes council-sweep { to { transform: rotate(360deg); } }
                .council-flow { animation: council-flow 1.2s linear infinite; }
                @keyframes council-flow { to { stroke-dashoffset: -20; } }
                .council-pulse { animation: council-pulse 2s ease-out infinite; transform-box: fill-box; transform-origin: center; }
                .council-pulse-delay { animation-delay: 1s; }
                @keyframes council-pulse { 0% { transform: scale(0.85); opacity: 0.9; } 100% { transform: scale(1.5); opacity: 0; } }
                .council-breathe { animation: council-breathe 2.4s ease-in-out infinite; transform-box: fill-box; transform-origin: center; }
                @keyframes council-breathe { 0%, 100% { opacity: 0.65; } 50% { opacity: 1; } }
                .council-dots::after { content: ''; animation: council-dots 1.5s steps(4, end) infinite; }
                @keyframes council-dots { 0% { content: ''; } 25% { content: '.'; } 50% { content: '..'; } 75% { content: '...'; } }
            `}</style>

            {/* Header */}
            <header className="sticky top-0 z-50 border-b border-slate-800 bg-slate-950/80 backdrop-blur-md">
                <div className="container mx-auto flex h-16 items-center justify-between px-6">
                    <div className="flex items-center gap-4">
                        <Link href="/" className="rounded-full p-2 text-slate-400 transition-colors hover:bg-slate-800 hover:text-white">
                            <ArrowLeft size={20} />
                        </Link>
                        <div className="flex items-center gap-3">
                            <div className="p-2 rounded-xl bg-gradient-to-br from-amber-500/20 to-violet-500/20 border border-amber-500/20">
                                <Landmark size={20} className="text-amber-300" />
                            </div>
                            <div>
                                <h1 className="text-xl font-bold tracking-tight text-white">THE COUNCIL CHAMBER</h1>
                                <p className="text-xs text-slate-500">
                                    Multi-model deliberations — live debates, seat theses, and final verdicts
                                </p>
                            </div>
                        </div>
                    </div>
                    <button
                        onClick={() => {
                            setLoading(true);
                            load();
                        }}
                        className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-slate-700 text-slate-300 hover:border-amber-500 hover:text-amber-300 transition-colors"
                        title="Refresh"
                    >
                        <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
                    </button>
                </div>
            </header>

            <div className="container mx-auto p-6 space-y-6">
                {error && (
                    <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">{error}</div>
                )}

                <SummonCouncilPanel onSummoned={handleSummoned} />

                <CouncilBenchControls />

                {/* Live chamber, or the dark chamber idle state */}
                {liveSession ? (
                    <LiveSessionPanel session={liveSession} onOpen={() => openDetail(liveSession.sessionId)} />
                ) : (
                    !loading && (
                        <section className="relative overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/30 py-8 text-center">
                            <div className="opacity-40">
                                <Chamber
                                    voices={
                                        sessions[0]?.voices?.length
                                            ? sessions[0].voices.map((v) => ({ ...v, status: "pending" as const }))
                                            : []
                                    }
                                    phase="setup"
                                    live={false}
                                />
                            </div>
                            <p className="text-sm text-slate-400 font-medium -mt-4">The chamber is dark — no council in session.</p>
                            <p className="text-xs text-slate-600 mt-1">
                                Ask Praxis to summon a council, or wait for the 6:15 AM morning deliberation.
                            </p>
                        </section>
                    )
                )}

                {/* Selected transcript */}
                {selectedId && (
                    <div ref={detailRef}>
                        <SessionDetailPanel
                            sessionId={selectedId}
                            live={liveSession?.sessionId === selectedId}
                            onClose={() => setSelectedId(null)}
                        />
                    </div>
                )}

                {/* History */}
                <section>
                    <div className="flex items-center gap-2 mb-3">
                        <ScrollText size={14} className="text-slate-400" />
                        <h2 className="text-xs font-bold uppercase tracking-widest text-slate-300">Deliberation record</h2>
                        {!loading && <span className="text-[10px] text-slate-600 font-mono">{sessions.length} sessions</span>}
                    </div>
                    {loading ? (
                        <div className="flex items-center justify-center py-12">
                            <Loader2 size={22} className="animate-spin text-slate-500" />
                        </div>
                    ) : sessions.length === 0 ? (
                        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-slate-800 py-14 text-center bg-slate-900/20">
                            <div className="p-3 rounded-xl bg-slate-800/40 text-slate-500 mb-4">
                                <Landmark size={26} />
                            </div>
                            <p className="text-sm text-slate-400 font-medium">No deliberations yet</p>
                            <p className="text-xs text-slate-600 mt-1 max-w-sm">
                                Council sessions appear here the moment one convenes — the morning knowledge council, status
                                report panels, and any council Robert summons.
                            </p>
                        </div>
                    ) : (
                        <div className="space-y-2">
                            {sessions.map((s) => (
                                <HistoryRow
                                    key={s.sessionId}
                                    session={s}
                                    selected={selectedId === s.sessionId}
                                    onSelect={() => openDetail(s.sessionId)}
                                />
                            ))}
                        </div>
                    )}
                </section>
            </div>
        </main>
    );
}

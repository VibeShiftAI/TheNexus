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
    Gavel,
    Landmark,
    Loader2,
    RefreshCw,
    ScrollText,
    Send,
    Users,
    X,
    XCircle,
} from "lucide-react";
import { normalizeMarkdown } from "@/lib/normalizeMarkdown";
import {
    getCouncilSession,
    getCouncilSessions,
    isInterruptedSession,
    isLiveSession,
    isAggregatorVoice,
    seatDisplayName,
    sessionIdFromCouncilAck,
    sessionKind,
    summonCouncil,
    detailDurationMs,
    tokenUsageForCouncilResponse,
    type CouncilSessionDetail,
    type CouncilSessionSummary,
    type CouncilVoice,
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
};

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
    const refs = voices.filter((v) => !isAggregatorVoice(v));
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

    const refs = session.voices.filter((v) => !isAggregatorVoice(v));
    const reported = refs.filter((v) => v.status === "success" || v.status === "error" || v.status === "timeout").length;
    const phaseLabel =
        session.phase === "deliberation"
            ? "Seats are deliberating"
            : session.phase === "synthesis" || session.phase === "refinement"
              ? "Aggregator is drafting the verdict"
              : "Convening";

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
    const [topic, setTopic] = useState("");
    const [context, setContext] = useState("");
    const [domain, setDomain] = useState<"" | "engineering" | "research" | "strategy">("");
    const [focus, setFocus] = useState(false);
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
            const response = await summonCouncil({
                topic: topic.trim(),
                ...(context.trim() ? { context: context.trim() } : {}),
                deliverable: "analysis",
                ...(domain ? { domain } : {}),
                focus,
            });
            const message = response.result || "Council convened.";
            setAck(message);
            onSummoned(sessionIdFromCouncilAck(message));
        } catch (err) {
            setError(err instanceof Error ? err.message : "Council summon failed");
        } finally {
            setSubmitting(false);
        }
    }

    return (
        <section className="rounded-2xl border border-amber-500/25 bg-slate-900/50 overflow-hidden">
            <div className="border-b border-slate-800 px-5 py-4">
                <div className="flex items-center gap-2">
                    <Gavel size={15} className="text-amber-300" />
                    <h2 className="text-xs font-bold uppercase tracking-widest text-amber-300">Summon the Cabinet</h2>
                </div>
                <p className="mt-1 text-xs text-slate-500">
                    Runs the configured council seats and may use paid API or subscription capacity.
                </p>
            </div>
            <form onSubmit={handleSubmit} className="p-5 space-y-4">
                <textarea
                    value={topic}
                    onChange={(event) => setTopic(event.target.value)}
                    rows={3}
                    placeholder="Question for the Cortex Council"
                    className="w-full resize-y rounded-lg border border-slate-700 bg-slate-950/70 px-3 py-2 text-sm text-slate-100 outline-none transition-colors placeholder:text-slate-600 focus:border-amber-500/70"
                />
                <textarea
                    value={context}
                    onChange={(event) => setContext(event.target.value)}
                    rows={2}
                    placeholder="Optional context, constraints, or notes"
                    className="w-full resize-y rounded-lg border border-slate-800 bg-slate-950/50 px-3 py-2 text-xs text-slate-200 outline-none transition-colors placeholder:text-slate-600 focus:border-slate-600"
                />
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
                {ack && (
                    <div className="rounded-lg border border-cyan-500/25 bg-cyan-500/10 px-3 py-2 text-xs text-cyan-100">
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

function ThesisCard({ voice, detail }: { voice: CouncilVoice; detail: CouncilSessionDetail }) {
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
                            {providerLabel(voice.model)} · {voice.model.replace(/\s*\(aggregator\)\s*$/, "")}
                            {thesis ? ` · ${formatDuration(thesis.elapsedMs)}` : ""}
                            {` · ${tokenLabel(voice.status, tokens)}`}
                            {thesis && thesis.status !== "success" ? ` · ${thesis.status}` : ""}
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

    const refs = detail?.voices.filter((v) => !isAggregatorVoice(v)) ?? [];
    const interrupted = detail ? isInterruptedSession(detail) : false;

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
                            {detail.stats.successCount}/{refs.length} seats · session {detail.sessionId}
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

            {detail && (
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
    const refs = session.voices.filter((v) => !isAggregatorVoice(v));
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
                    ) : session.stats.successCount > 0 ? (
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
                    {session.stats.successCount}/{refs.length || session.stats.voiceCount} seats
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

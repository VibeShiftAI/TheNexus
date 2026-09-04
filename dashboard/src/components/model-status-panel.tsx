"use client";

/**
 * Model Status panel — the top-of-page answer to "can Praxis dispatch right
 * now, and if not, what do I click?"
 *
 * Three layers, coarse to fine:
 *   1. A headline verdict (all clear / N models held).
 *   2. The Dispatch Ladder graphic — what each tier will ACTUALLY run on,
 *      read from the router rather than from its ladder table. That
 *      distinction is the whole value: with Fable's credits out the table
 *      still says claude-fable-5 at tiers 4-5, while dispatch really sends
 *      tier 4 to Opus 5 at max and tier 5 to Sol. A rung drawn from the table
 *      would confidently name a model that cannot run.
 *   3. Per-model rows with the reason in words, the clock the hold lifts on,
 *      and a Release button wired to Praxis's quota-restore.
 *
 * Release is the reason this panel exists. A usage limit fans out into four
 * independent holds with clocks days apart on a weekly window; when Robert
 * tops the plan back up there has to be one button that lifts all of them.
 */

import { useCallback, useState } from "react";
import { useLiveRefetch } from "@/components/live-board-state";
import {
    AlertTriangle,
    CheckCircle2,
    Gauge,
    Loader2,
    RefreshCw,
    RotateCcw,
    ShieldAlert,
    Sparkles,
} from "lucide-react";
import {
    getModelStatusBoard,
    ladderFromBoard,
    releaseModelHold,
    shortModel,
    untilLabel,
    STATE_LABEL,
    STATE_STYLE,
    type LadderRung,
    type ModelStatusBoard,
    type ModelStatusRow,
} from "@/lib/model-status";

const POLL_MS = 30_000;

/**
 * The Dispatch Ladder. One row per router tier (5 = architecture work at the
 * top, 1 = trivial at the floor), each naming the model that tier will
 * actually run on and at what thinking level, with the ladder's nominal pick
 * beside it — struck through when pressure displaced it.
 *
 * Amber means substituted, red means the tier cannot dispatch at all. Red is
 * the only thing on the page that means "this class of work cannot go out".
 */
function DispatchLadder({ rungs }: { rungs: LadderRung[] }) {
    if (!rungs.length) return null;
    const ROW_H = 36;
    const H = rungs.length * ROW_H + 26;
    const NOMINAL_X = 250;

    return (
        <div className="overflow-x-auto">
            <svg
                viewBox={`0 0 470 ${H}`}
                width="100%"
                style={{ maxWidth: 470, minWidth: 380 }}
                role="img"
                aria-label="Dispatch ladder: what each router tier will actually run on right now"
            >
                <text x={0} y={12} fill="#64748b" fontSize={9} letterSpacing={1.2}>
                    TIER
                </text>
                <text x={52} y={12} fill="#64748b" fontSize={9} letterSpacing={1.2}>
                    DISPATCHES TO
                </text>
                <text x={NOMINAL_X} y={12} fill="#64748b" fontSize={9} letterSpacing={1.2}>
                    LADDER SAYS
                </text>

                {rungs.map((rung, i) => {
                    const y = 26 + i * ROW_H;
                    const ok = rung.dispatchable;
                    const accent = !ok ? "#f87171" : rung.substituted ? "#fbbf24" : "#22d3ee";
                    const anthropic = rung.executor === "claude-code";
                    return (
                        <g key={rung.tier}>
                            <rect x={0} y={y + 9} width={470} height={1} fill={ok ? "#1e293b" : "#7f1d1d"} />
                            <circle cx={6} cy={y + 5} r={4} fill={accent} />
                            <text x={18} y={y + 9} fill={ok ? "#cbd5e1" : "#fca5a5"} fontSize={12} fontWeight={600}>
                                {rung.tier}
                            </text>

                            {ok ? (
                                <>
                                    <rect
                                        x={52}
                                        y={y - 4}
                                        width={190}
                                        height={20}
                                        rx={3}
                                        fill={anthropic ? "rgba(34,211,238,0.10)" : "rgba(167,139,250,0.10)"}
                                        stroke={accent}
                                        strokeOpacity={0.45}
                                    />
                                    <circle cx={62} cy={y + 6} r={3} fill={anthropic ? "#22d3ee" : "#a78bfa"} />
                                    <text x={71} y={y + 10} fill="#e2e8f0" fontSize={10.5}>
                                        {shortModel(rung.model)}
                                    </text>
                                    <text x={232} y={y + 10} fill="#64748b" fontSize={9} textAnchor="end">
                                        {rung.thinkingLevel}
                                    </text>
                                </>
                            ) : (
                                <text x={52} y={y + 10} fill="#f87171" fontSize={10.5}>
                                    cannot dispatch — both families blocked
                                </text>
                            )}

                            {/* What the ladder nominally says, when it is not what runs. */}
                            {rung.substituted ? (
                                <text x={NOMINAL_X} y={y + 10} fill="#64748b" fontSize={10}>
                                    <tspan textDecoration="line-through">{shortModel(rung.nominal.claude)}</tspan>
                                    <tspan fill="#fbbf24" dx={6}>
                                        substituted
                                    </tspan>
                                </text>
                            ) : (
                                <text x={NOMINAL_X} y={y + 10} fill="#334155" fontSize={10}>
                                    {shortModel(rung.nominal.claude)} / {shortModel(rung.nominal.codex)}
                                </text>
                            )}
                        </g>
                    );
                })}
            </svg>
        </div>
    );
}

function ModelRow({
    row,
    onRelease,
    releasing,
}: {
    row: ModelStatusRow;
    onRelease: (target: string, label: string) => void;
    releasing: string | null;
}) {
    const style = STATE_STYLE[row.state];
    const until = untilLabel(row.releasesAt);
    const busy = releasing === row.releaseTarget;

    return (
        <div className="flex flex-col gap-2 border-b border-slate-900 px-4 py-3 last:border-0 lg:flex-row lg:items-center lg:justify-between">
            <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                    <span className={`h-2 w-2 shrink-0 rounded-full ${style.dot}`} />
                    <span className="font-medium text-slate-200">{row.model}</span>
                    {row.tiers.length > 0 && (
                        <span className="rounded border border-slate-700 px-1.5 py-0.5 text-[10px] text-slate-400">
                            tier {row.tiers.join("/")}
                        </span>
                    )}
                    {row.isScorer && (
                        <span className="inline-flex items-center gap-1 rounded border border-cyan-500/30 bg-cyan-500/10 px-1.5 py-0.5 text-[10px] text-cyan-200">
                            <Sparkles size={9} />
                            complexity scorer
                        </span>
                    )}
                    <span className={`rounded border px-1.5 py-0.5 text-[10px] ${style.chip}`}>
                        {STATE_LABEL[row.state]}
                    </span>
                </div>
                {row.reason ? (
                    <div className="mt-1 text-xs text-slate-400">{row.reason}</div>
                ) : (
                    <div className="mt-1 text-xs text-slate-600">
                        {row.todayEvents > 0
                            ? `${row.todayEvents} calls today`
                            : "no activity today"}
                    </div>
                )}
            </div>

            <div className="flex shrink-0 items-center gap-3">
                {until && <span className="text-xs text-slate-500">lifts {until}</span>}
                {row.releaseTarget ? (
                    <button
                        type="button"
                        onClick={() => onRelease(row.releaseTarget!, row.releaseIsFamilyWide ? `the ${row.family} family` : row.model)}
                        disabled={busy}
                        title={
                            row.releaseIsFamilyWide
                                ? `Releases the whole ${row.family} family — this hold is provider-wide`
                                : `Releases ${row.model} only`
                        }
                        className="inline-flex items-center gap-1.5 rounded border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-xs font-medium text-amber-200 hover:bg-amber-500/20 disabled:opacity-50"
                    >
                        {busy ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} />}
                        {row.releaseIsFamilyWide ? `Release ${row.family}` : "Release"}
                    </button>
                ) : row.state === "credits-out" ? (
                    <span className="text-xs text-slate-500">restore credits in model control</span>
                ) : null}
            </div>
        </div>
    );
}

export function ModelStatusPanel() {
    const [board, setBoard] = useState<ModelStatusBoard | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [releasing, setReleasing] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);

    const load = useCallback(async () => {
        try {
            setBoard(await getModelStatusBoard());
            setError(null);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Model status unavailable");
        } finally {
            setLoading(false);
        }
    }, []);

    // D-1: usage holds are set by the Praxis usage monitor, which publishes no
    // stream frame — poll only, through the shared mechanism.
    useLiveRefetch([], load, { fallbackPollMs: POLL_MS });

    const handleRelease = useCallback(
        async (target: string, label: string) => {
            // Releasing re-opens autonomous dispatch to a provider, so it asks
            // first — the honest failure here is a wasted run against a provider
            // that is still actually out.
            if (!window.confirm(`Release the usage hold on ${label}? This re-opens autonomous dispatch to it immediately.`)) {
                return;
            }
            setReleasing(target);
            setNotice(null);
            try {
                const result = await releaseModelHold(target);
                setNotice(result.summary || `Released ${target}`);
                await load();
            } catch (err) {
                setError(err instanceof Error ? err.message : "Release failed");
            } finally {
                setReleasing(null);
            }
        },
        [load],
    );

    const held = board ? board.models.filter((r) => r.state !== "ready") : [];
    const rungs = board ? ladderFromBoard(board) : [];
    const blockedTiers = rungs.filter((r) => !r.dispatchable).map((r) => r.tier);

    return (
        <section className="mb-6 rounded-lg border border-slate-800 bg-slate-950/50">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 px-4 py-3">
                <div className="flex items-center gap-2">
                    <Gauge size={16} className="text-cyan-300" />
                    <h2 className="font-semibold text-white">Model Status</h2>
                    {board && (
                        <span
                            className={`inline-flex items-center gap-1.5 rounded border px-2 py-0.5 text-xs ${
                                board.anySuspended
                                    ? "border-amber-500/30 bg-amber-500/10 text-amber-200"
                                    : "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
                            }`}
                        >
                            {board.anySuspended ? <AlertTriangle size={11} /> : <CheckCircle2 size={11} />}
                            {board.anySuspended
                                ? `${held.length} held`
                                : "All models available"}
                        </span>
                    )}
                </div>
                <button
                    type="button"
                    onClick={load}
                    disabled={loading}
                    className="inline-flex items-center gap-2 rounded border border-slate-700 bg-slate-950 px-3 py-1.5 text-xs text-slate-300 hover:border-slate-600 hover:text-white disabled:opacity-50"
                >
                    <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
                    Refresh
                </button>
            </div>

            {error && (
                <div className="flex items-center gap-2 border-b border-red-500/20 bg-red-500/5 px-4 py-2.5 text-sm text-red-200">
                    <AlertTriangle size={14} />
                    {error}
                </div>
            )}
            {notice && (
                <div className="flex items-center gap-2 border-b border-emerald-500/20 bg-emerald-500/5 px-4 py-2.5 text-sm text-emerald-200">
                    <CheckCircle2 size={14} />
                    {notice}
                </div>
            )}

            {!board && loading && (
                <div className="flex items-center gap-2 px-4 py-8 text-sm text-slate-500">
                    <Loader2 size={15} className="animate-spin" />
                    Reading model status…
                </div>
            )}

            {board && (
                <div className="grid gap-0 lg:grid-cols-[minmax(0,480px)_minmax(0,1fr)]">
                    <div className="border-b border-slate-900 p-4 lg:border-b-0 lg:border-r">
                        <div className="mb-3 flex items-center justify-between gap-2">
                            <div className="text-xs uppercase tracking-wide text-slate-500">Dispatch ladder</div>
                            {blockedTiers.length > 0 && (
                                <span className="rounded border border-red-500/30 bg-red-500/10 px-1.5 py-0.5 text-[10px] text-red-200">
                                    tier {blockedTiers.join("/")} cannot dispatch
                                </span>
                            )}
                        </div>
                        <DispatchLadder rungs={rungs} />
                        <div className="mt-3 space-y-1 text-[11px] text-slate-600">
                            <div>Each rung names what that tier dispatches to right now — amber where pressure displaced the ladder&apos;s pick.</div>
                            <div>
                                Complexity scorer: {board.scorer.model}
                                {board.scorer.mode === "heuristic" && " (LLM scoring off — keyword heuristic)"}
                                {board.scorer.mode === "cli" && !board.scorer.reachable && " (held — routing falls back to the heuristic)"}
                            </div>
                        </div>

                        <div className="mt-4 space-y-2">
                            {board.families.map((fam) => (
                                <div
                                    key={fam.family}
                                    className="rounded border border-slate-800 bg-slate-950/70 px-3 py-2"
                                >
                                    <div className="flex items-center justify-between gap-2">
                                        <span className="text-sm font-medium text-slate-200">{fam.executor}</span>
                                        <div className="flex items-center gap-2">
                                            {fam.usedPercent !== null && (
                                                <span className="text-[11px] text-slate-500">
                                                    {fam.usedPercent}% used
                                                    {fam.windowMinutes ? ` (${fam.windowMinutes >= 10080 ? "weekly" : `${Math.round(fam.windowMinutes / 60)}h`})` : ""}
                                                </span>
                                            )}
                                            <span
                                                className={`rounded px-1.5 py-0.5 text-[10px] ${
                                                    fam.available
                                                        ? "bg-emerald-500/10 text-emerald-200"
                                                        : "bg-red-500/10 text-red-200"
                                                }`}
                                            >
                                                {fam.available ? "available" : "suspended"}
                                            </span>
                                        </div>
                                    </div>
                                    {!fam.available && (
                                        <div className="mt-1.5 flex items-start justify-between gap-2">
                                            <div className="flex items-start gap-1.5 text-[11px] text-red-200/80">
                                                <ShieldAlert size={12} className="mt-0.5 shrink-0" />
                                                <span>{fam.reason}</span>
                                            </div>
                                            <button
                                                type="button"
                                                onClick={() => handleRelease(fam.releaseTarget, `the ${fam.family} family`)}
                                                disabled={releasing === fam.releaseTarget}
                                                className="inline-flex shrink-0 items-center gap-1.5 rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[11px] font-medium text-amber-200 hover:bg-amber-500/20 disabled:opacity-50"
                                            >
                                                {releasing === fam.releaseTarget ? (
                                                    <Loader2 size={11} className="animate-spin" />
                                                ) : (
                                                    <RotateCcw size={11} />
                                                )}
                                                Release
                                            </button>
                                        </div>
                                    )}
                                </div>
                            ))}
                        </div>
                    </div>

                    <div>
                        {board.models.map((row) => (
                            <ModelRow key={row.model} row={row} onRelease={handleRelease} releasing={releasing} />
                        ))}
                    </div>
                </div>
            )}
        </section>
    );
}

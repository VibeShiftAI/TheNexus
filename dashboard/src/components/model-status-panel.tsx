"use client";

/**
 * Model Status panel — the top-of-page answer to "can Praxis dispatch right
 * now, and if not, what do I click?"
 *
 * Three layers, coarse to fine:
 *   1. A headline verdict (all clear / N models held).
 *   2. The Dispatch Ladder graphic — the router's capability ladder with each
 *      rung lit by whether EITHER family can still take that tier of work.
 *      This is the question a bare per-model list can't answer: Fable going
 *      out looks alarming until you see tiers 4-5 still lit on the Sol side.
 *   3. Per-model rows with the reason in words, the clock the hold lifts on,
 *      and a Release button wired to Praxis's quota-restore.
 *
 * Release is the reason this panel exists. A usage limit fans out into four
 * independent holds with clocks days apart on a weekly window; when Robert
 * tops the plan back up there has to be one button that lifts all of them.
 */

import { useCallback, useEffect, useState } from "react";
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
 * The Dispatch Ladder. Rows are the router's tiers (5 = architecture work at
 * the top, 1 = trivial at the floor); columns are the two provider families.
 * A rung's spine glows while at least one side can still take the work and
 * goes red when both are blocked — that red is the only thing on the page
 * that means "this class of work cannot go out right now".
 */
function DispatchLadder({ rungs }: { rungs: LadderRung[] }) {
    if (!rungs.length) return null;
    const ROW_H = 34;
    const H = rungs.length * ROW_H + 26;
    const CLAUDE_X = 120;
    const CODEX_X = 300;
    const CELL_W = 150;

    return (
        <div className="overflow-x-auto">
            <svg
                viewBox={`0 0 470 ${H}`}
                width="100%"
                style={{ maxWidth: 470, minWidth: 380 }}
                role="img"
                aria-label="Dispatch ladder: router tiers by provider family, colored by availability"
            >
                <text x={0} y={12} fill="#64748b" fontSize={9} letterSpacing={1.2}>
                    TIER
                </text>
                <text x={CLAUDE_X} y={12} fill="#64748b" fontSize={9} letterSpacing={1.2}>
                    ANTHROPIC
                </text>
                <text x={CODEX_X} y={12} fill="#64748b" fontSize={9} letterSpacing={1.2}>
                    OPENAI
                </text>

                {rungs.map((rung, i) => {
                    const y = 26 + i * ROW_H;
                    const spine = rung.dispatchable ? "#22d3ee" : "#f87171";
                    return (
                        <g key={rung.tier}>
                            {/* Rung spine: the "can this tier dispatch at all" signal. */}
                            <rect x={0} y={y + 6} width={470} height={1} fill={rung.dispatchable ? "#1e293b" : "#7f1d1d"} />
                            <circle cx={6} cy={y + 6} r={4} fill={spine} />
                            <text x={18} y={y + 10} fill={rung.dispatchable ? "#cbd5e1" : "#fca5a5"} fontSize={12} fontWeight={600}>
                                {rung.tier}
                            </text>
                            {!rung.dispatchable && (
                                <text x={32} y={y + 10} fill="#f87171" fontSize={9}>
                                    blocked
                                </text>
                            )}
                            <LadderCell row={rung.claude} x={CLAUDE_X} y={y} w={CELL_W} />
                            <LadderCell row={rung.codex} x={CODEX_X} y={y} w={CELL_W} />
                        </g>
                    );
                })}
            </svg>
        </div>
    );
}

function LadderCell({ row, x, y, w }: { row: ModelStatusRow | null; x: number; y: number; w: number }) {
    if (!row) {
        return (
            <text x={x} y={y + 10} fill="#334155" fontSize={10}>
                —
            </text>
        );
    }
    const style = STATE_STYLE[row.state];
    const ready = row.state === "ready";
    return (
        <g>
            <rect
                x={x}
                y={y - 3}
                width={w}
                height={19}
                rx={3}
                fill={ready ? "rgba(52,211,153,0.10)" : "rgba(248,113,113,0.10)"}
                stroke={style.hex}
                strokeOpacity={ready ? 0.35 : 0.55}
                strokeWidth={1}
            />
            <circle cx={x + 10} cy={y + 6} r={3} fill={style.hex} />
            <text x={x + 19} y={y + 10} fill={ready ? "#cbd5e1" : "#fca5a5"} fontSize={10.5}>
                {shortModel(row.model)}
            </text>
        </g>
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

    useEffect(() => {
        load();
        const t = setInterval(load, POLL_MS);
        return () => clearInterval(t);
    }, [load]);

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
                            <div>A rung stays lit while either family can still take that tier of work.</div>
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

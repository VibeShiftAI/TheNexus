"use client";

/**
 * Usage & Routing panel — quota runway per model family plus the model
 * router's recent decisions. Data comes from Praxis's usage monitor via the
 * /api/usage-monitor node proxy, so it works identically at home and through
 * the tunnel.
 */

import { useCallback, useEffect, useState } from "react";
import { useLiveRefetch } from "@/components/live-board-state";
import { Activity, Gauge, Loader2, RefreshCw, Route } from "lucide-react";
import {
    getUsageMonitorState,
    type UsageFamilyState,
    type UsageMonitorState,
} from "@/lib/nexus";

function formatTokens(n: number): string {
    if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
    return `${n}`;
}

function formatCountdown(untilMs: number, now: number): string {
    const remaining = untilMs - now;
    if (remaining <= 0) return "now";
    const h = Math.floor(remaining / 3_600_000);
    const m = Math.round((remaining % 3_600_000) / 60_000);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function windowLabel(minutes: number): string {
    if (minutes >= 10080) return "weekly";
    if (minutes >= 240 && minutes <= 360) return "5h";
    return `${Math.round(minutes / 60)}h`;
}

function FamilyCard({
    name,
    accent,
    family,
    now,
}: {
    name: string;
    accent: string;
    family: UsageFamilyState;
    now: number;
}) {
    const { today, window: win, rateLimits, limit } = family;
    return (
        <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
            <div className="mb-3 flex items-center justify-between">
                <span className={`text-sm font-semibold ${accent}`}>{name}</span>
                {limit.coolingDown ? (
                    <span className="rounded bg-red-500/15 px-2 py-0.5 text-xs text-red-400">
                        limit hit{limit.resetAt ? ` — resets in ${formatCountdown(limit.resetAt, now)}` : ""}
                    </span>
                ) : (
                    <span className="rounded bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-400">available</span>
                )}
            </div>

            <div className="grid grid-cols-3 gap-3 text-center">
                <div>
                    <div className="text-lg font-semibold text-slate-100">{formatTokens(today.inputTokens + today.outputTokens)}</div>
                    <div className="text-xs text-slate-500">tokens today</div>
                </div>
                <div>
                    <div className="text-lg font-semibold text-slate-100">{formatTokens(today.outputTokens)}</div>
                    <div className="text-xs text-slate-500">output today</div>
                </div>
                <div>
                    <div className="text-lg font-semibold text-slate-100">${today.estCostUsd.toFixed(2)}</div>
                    <div className="text-xs text-slate-500">est. API value</div>
                </div>
            </div>

            {win ? (
                <div className="mt-3 rounded border border-slate-800 bg-slate-950/60 p-2 text-xs text-slate-400">
                    <span className="text-slate-300">5h window:</span> {formatTokens(win.inputTokens + win.outputTokens)} tokens
                    {" · "}resets in <span className="text-slate-200">{formatCountdown(win.endsAt, now)}</span>
                </div>
            ) : (
                <div className="mt-3 rounded border border-slate-800 bg-slate-950/60 p-2 text-xs text-slate-500">
                    no open 5h window — next message starts one
                </div>
            )}

            {rateLimits.map((rl) => (
                <div key={rl.windowMinutes} className="mt-2">
                    <div className="mb-1 flex justify-between text-xs text-slate-400">
                        <span>{windowLabel(rl.windowMinutes)} quota ({rl.planType ?? "plan"})</span>
                        <span>
                            {rl.usedPercent.toFixed(0)}%
                            {rl.resetsAt ? ` · resets in ${formatCountdown(rl.resetsAt, now)}` : ""}
                        </span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded bg-slate-800">
                        <div
                            className={`h-full ${rl.usedPercent >= 85 ? "bg-red-500" : rl.usedPercent >= 60 ? "bg-amber-500" : "bg-emerald-500"}`}
                            style={{ width: `${Math.min(100, rl.usedPercent)}%` }}
                        />
                    </div>
                </div>
            ))}

            {Object.keys(today.byModel).length > 0 && (
                <div className="mt-3 space-y-1 text-xs">
                    {Object.entries(today.byModel)
                        .sort((a, b) => b[1].inputTokens + b[1].outputTokens - (a[1].inputTokens + a[1].outputTokens))
                        .slice(0, 4)
                        .map(([model, m]) => (
                            <div key={model} className="flex justify-between text-slate-500">
                                <span className="truncate pr-2">{model}</span>
                                <span className="shrink-0 text-slate-400">{formatTokens(m.inputTokens + m.outputTokens)}</span>
                            </div>
                        ))}
                </div>
            )}
        </div>
    );
}

export function UsageRoutingPanel() {
    const [state, setState] = useState<UsageMonitorState | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [now, setNow] = useState(() => Date.now());

    const refresh = useCallback(async () => {
        setLoading(true);
        try {
            setState(await getUsageMonitorState());
            setError(null);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to load usage state");
        } finally {
            setLoading(false);
        }
    }, []);

    // D-1: provider quota/routing state has no stream frame — poll only,
    // through the shared mechanism.
    useLiveRefetch([], () => void refresh(), { fallbackPollMs: 60_000 });

    // Clock tick only (relative "resets in" labels) — touches no network, so
    // it is not a poller and stays as it is.
    useEffect(() => {
        const tick = setInterval(() => setNow(Date.now()), 30_000);
        return () => clearInterval(tick);
    }, []);

    return (
        <section className="mb-6 rounded-lg border border-slate-800 bg-slate-950/50 p-4">
            <div className="mb-4 flex items-center justify-between">
                <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-200">
                    <Gauge className="h-4 w-4 text-cyan-400" />
                    Usage &amp; Routing
                </h2>
                <button
                    onClick={() => void refresh()}
                    className="flex items-center gap-1 rounded border border-slate-700 px-2 py-1 text-xs text-slate-400 hover:text-slate-200"
                    disabled={loading}
                >
                    {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                    Refresh
                </button>
            </div>

            {error && (
                <div className="mb-3 rounded border border-red-900/50 bg-red-950/30 p-2 text-xs text-red-400">{error}</div>
            )}

            {state ? (
                <>
                    <div className="grid gap-4 md:grid-cols-2">
                        <FamilyCard name="Claude (Anthropic)" accent="text-orange-300" family={state.families.claude} now={now} />
                        <FamilyCard name="Codex (OpenAI)" accent="text-sky-300" family={state.families.codex} now={now} />
                    </div>

                    <div className="mt-4">
                        <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                            <Route className="h-3.5 w-3.5" />
                            Recent routing decisions
                        </h3>
                        {state.recentDecisions.length === 0 ? (
                            <p className="text-xs text-slate-500">
                                No routed dispatches yet — decisions appear here as autonomous tasks go out.
                            </p>
                        ) : (
                            <div className="max-h-64 overflow-y-auto rounded border border-slate-800">
                                <table className="w-full text-left text-xs">
                                    <thead className="sticky top-0 bg-slate-900 text-slate-500">
                                        <tr>
                                            <th className="px-2 py-1.5 font-medium">Time</th>
                                            <th className="px-2 py-1.5 font-medium">Task</th>
                                            <th className="px-2 py-1.5 font-medium">Cx</th>
                                            <th className="px-2 py-1.5 font-medium">Model @ thinking</th>
                                            <th className="px-2 py-1.5 font-medium">Applied</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-slate-800/70 text-slate-400">
                                        {state.recentDecisions.map((d, i) => (
                                            <tr key={`${d.ts}-${i}`} title={d.rationale ?? undefined}>
                                                <td className="whitespace-nowrap px-2 py-1.5">
                                                    {new Date(d.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                                                </td>
                                                <td className="max-w-[220px] truncate px-2 py-1.5 text-slate-300">{d.task_title ?? d.task_id ?? "—"}</td>
                                                <td className="px-2 py-1.5">
                                                    {d.complexity ?? "—"}
                                                    {d.scorer === "heuristic" ? <span className="text-slate-600">*</span> : null}
                                                </td>
                                                <td className="whitespace-nowrap px-2 py-1.5">
                                                    {d.model ?? "—"}
                                                    {d.thinking_level ? <span className="text-slate-500"> @ {d.thinking_level}</span> : null}
                                                </td>
                                                <td className="px-2 py-1.5">{d.applied ? "✓" : "suggested"}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                        <p className="mt-1 text-[10px] text-slate-600">
                            * heuristic fallback score (Fable scorer unavailable). Hover a row for the full rationale.
                        </p>
                    </div>
                </>
            ) : !error ? (
                <div className="flex items-center gap-2 py-6 text-xs text-slate-500">
                    <Activity className="h-4 w-4 animate-pulse" /> Loading usage state…
                </div>
            ) : null}
        </section>
    );
}

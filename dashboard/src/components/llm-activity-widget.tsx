"use client";

import { useState, useCallback } from "react";
import { useLiveRefetch } from "@/components/live-board-state";

import Link from "next/link";
import { Brain, ArrowUpRight, Activity } from "lucide-react";
import { fmtTokens } from "@/lib/token-usage";

interface CallerAgg { caller: string; calls: number; tokens: number | null; failures: number }
interface LogResponse {
  aggregates: {
    by_caller: CallerAgg[];
    by_provider: { provider: string; calls: number }[];
    total_calls: number;
    since_hours: number;
    /** Calls in the window that left no usage record — the coverage caveat. */
    missing_usage_calls?: number;
  };
}

const CALLER_COLOR: Record<string, string> = {
  "mcp.claude": "bg-orange-500",
  "mcp.codex": "bg-green-500",
  "mcp.antigravity": "bg-blue-500",
  "praxis.agent": "bg-cyan-500",
};
function barColor(caller: string) {
  if (CALLER_COLOR[caller]) return CALLER_COLOR[caller];
  if (caller.startsWith("mcp.")) return "bg-violet-500";
  return "bg-slate-500";
}
function shortName(caller: string) {
  return caller.replace(/^praxis\./, "").replace(/^mcp\./, "🤖 ");
}

export function LLMActivityWidget() {
  const [data, setData] = useState<LogResponse | null>(null);
  const [err, setErr] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/praxis/llm-log?hours=1", { cache: "no-store" });
      if (!res.ok) throw new Error();
      setData(await res.json());
      setErr(false);
    } catch {
      setErr(true);
    }
  }, []);

  // D-1: LLM-log rollups have no stream frame — poll only, shared mechanism.
  useLiveRefetch([], load, { fallbackPollMs: 10_000 });

  const agg = data?.aggregates;
  const callers = (agg?.by_caller ?? []).slice(0, 5);
  const max = Math.max(1, ...callers.map((c) => c.calls));

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Brain size={16} className="text-orange-400" />
          <h3 className="text-sm font-bold tracking-tight text-white">LLM ACTIVITY</h3>
          <span className="text-[10px] text-slate-500">last 1h</span>
        </div>
        <Link href="/llm-activity" className="flex items-center gap-1 text-[11px] text-cyan-400 hover:text-cyan-300">
          details <ArrowUpRight size={12} />
        </Link>
      </div>

      {err ? (
        <div className="py-4 text-center text-xs text-slate-500">Praxis usage log unavailable</div>
      ) : !agg ? (
        <div className="flex h-20 items-center justify-center">
          <Activity className="animate-spin text-slate-600" size={18} />
        </div>
      ) : agg.total_calls === 0 ? (
        <div className="py-4 text-center text-xs text-slate-500">No LLM calls in the last hour.</div>
      ) : (
        <>
          <div className="mb-3 flex items-baseline gap-2">
            <span className="text-2xl font-bold text-white">{agg.total_calls}</span>
            <span className="text-xs text-slate-400">calls across {agg.by_provider.length} provider{agg.by_provider.length === 1 ? "" : "s"}</span>
          </div>
          {/* The details page qualifies these rollups with their usage coverage;
              this widget showed the same numbers without it, so a partial
              sample read as a complete one. Carry the caveat here too. */}
          {!!agg.missing_usage_calls && (
            <div
              className="mb-2 text-[10px] text-amber-400/90"
              title={`${agg.missing_usage_calls} of ${agg.total_calls} calls in this window left no usage record, so token figures below are a partial sample — not the whole hour.`}
            >
              usage unknown for {agg.missing_usage_calls} of {agg.total_calls} calls
            </div>
          )}
          <div className="space-y-1.5">
            {callers.map((c) => (
              <div key={c.caller} className="flex items-center gap-2">
                <div className="w-28 shrink-0 truncate text-[11px] text-slate-300" title={c.caller}>
                  {shortName(c.caller)}
                </div>
                <div className="relative h-4 flex-1 overflow-hidden rounded bg-slate-800/60">
                  <div
                    className={`h-full ${barColor(c.caller)} opacity-80`}
                    style={{ width: `${(c.calls / max) * 100}%` }}
                  />
                </div>
                <div className="w-8 shrink-0 text-right text-[11px] tabular-nums text-slate-400">{c.calls}</div>
                <div className="w-10 shrink-0 text-right text-[10px] tabular-nums text-slate-500">{fmtTokens(c.tokens)}</div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * PowerStation — "Engineering": who is drawing LLM power right now (caller
 * bars from the Praxis usage log), today's call budget, and the local-only
 * lever promoted from the nav drawer to a proper engineering control.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Zap, ArrowUpRight, WifiOff, Cloud } from "lucide-react";
import { usePraxisStream } from "@/hooks/use-praxis-stream";
import { getLocalOnlyMode, setLocalOnlyMode } from "@/lib/model-control";

interface CallerAgg {
  caller: string;
  calls: number;
  tokens: number;
  failures: number;
}
interface LogResponse {
  aggregates: {
    by_caller: CallerAgg[];
    by_provider: { provider: string; calls: number }[];
    total_calls: number;
  };
}

function shortName(caller: string) {
  return caller.replace(/^praxis\./, "").replace(/^mcp\./, "");
}
function fmtTokens(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(0)}k`;
  return String(n);
}

export function PowerStation() {
  const { presence } = usePraxisStream();
  const [log, setLog] = useState<LogResponse | null>(null);
  const [err, setErr] = useState(false);
  const [localOnly, setLocalOnly] = useState<{ enabled: boolean; reason: string | null }>({
    enabled: false,
    reason: null,
  });
  const [toggling, setToggling] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/praxis/llm-log?hours=1", { cache: "no-store" });
      if (!res.ok) throw new Error();
      setLog(await res.json());
      setErr(false);
    } catch {
      setErr(true);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    getLocalOnlyMode()
      .then(setLocalOnly)
      .catch(() => {});
  }, []);

  const toggleLocalOnly = async () => {
    if (toggling) return;
    setToggling(true);
    try {
      const next = !localOnly.enabled;
      const updated = await setLocalOnlyMode(next, next ? localOnly.reason || "manual_override" : null);
      setLocalOnly(updated);
    } catch {
      /* leave state as-is on failure */
    } finally {
      setToggling(false);
    }
  };

  const agg = log?.aggregates;
  const callers = (agg?.by_caller ?? []).slice(0, 4);
  const max = Math.max(1, ...callers.map((c) => c.calls));
  const used = presence?.budget?.dailyCallsUsed;
  const remaining = presence?.budget?.dailyCallsRemaining;

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Zap size={16} className="text-amber-400" />
          <h3 className="text-sm font-bold tracking-tight text-white">ENGINEERING — POWER</h3>
        </div>
        <Link href="/llm-activity" className="flex items-center gap-1 text-[11px] text-cyan-400 hover:text-cyan-300">
          details <ArrowUpRight size={12} />
        </Link>
      </div>

      <div className="mb-3 flex items-center justify-between gap-3 rounded-md border border-slate-800 bg-slate-950/50 px-2.5 py-2">
        <div className="flex items-center gap-2 text-[11px]">
          {localOnly.enabled ? <WifiOff size={13} className="text-amber-300" /> : <Cloud size={13} className="text-slate-400" />}
          <span className={localOnly.enabled ? "text-amber-200" : "text-slate-300"}>
            {localOnly.enabled ? "Local only" : "Cloud enabled"}
          </span>
          {used != null || remaining != null ? (
            <span className="text-slate-600">
              · {used != null ? `${used} used` : ""}
              {remaining != null ? ` / ${remaining} left today` : ""}
            </span>
          ) : null}
        </div>
        <button
          onClick={toggleLocalOnly}
          disabled={toggling}
          className={`h-5 w-10 shrink-0 rounded-full border p-0.5 transition-colors ${
            localOnly.enabled ? "border-amber-400/50 bg-amber-400/30" : "border-slate-700 bg-slate-800"
          } ${toggling ? "opacity-50" : ""}`}
          aria-pressed={localOnly.enabled}
          aria-label="Toggle local-only mode"
        >
          <span
            className={`block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
              localOnly.enabled ? "translate-x-5" : "translate-x-0"
            }`}
          />
        </button>
      </div>

      {err && !log ? (
        <div className="py-3 text-center text-xs text-slate-500">Usage log unavailable</div>
      ) : !agg ? (
        <div className="py-3 text-center text-xs text-slate-600">Reading power draw…</div>
      ) : agg.total_calls === 0 ? (
        <div className="py-3 text-center text-xs text-slate-500">No LLM calls in the last hour.</div>
      ) : (
        <div className="space-y-1.5">
          {callers.map((c) => (
            <div key={c.caller} className="flex items-center gap-2">
              <div className="w-24 shrink-0 truncate text-[11px] text-slate-300" title={c.caller}>
                {shortName(c.caller)}
              </div>
              <div className="relative h-3.5 flex-1 overflow-hidden rounded bg-slate-800/60">
                <div
                  className="h-full rounded bg-amber-500/70 transition-all duration-500"
                  style={{ width: `${(c.calls / max) * 100}%` }}
                />
              </div>
              <div className="w-7 shrink-0 text-right text-[11px] tabular-nums text-slate-400">{c.calls}</div>
              <div className="w-9 shrink-0 text-right text-[10px] tabular-nums text-slate-600">{fmtTokens(c.tokens)}</div>
            </div>
          ))}
          <div className="pt-0.5 text-[10px] text-slate-600">
            {agg.total_calls} calls / {agg.by_provider.length} provider{agg.by_provider.length === 1 ? "" : "s"} in the
            last hour
          </div>
        </div>
      )}
    </div>
  );
}

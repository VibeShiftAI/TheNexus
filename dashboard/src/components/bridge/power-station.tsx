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
import { HudPanel, HudModal, HudStat } from "@/components/bridge/hud";
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

interface BurnDay {
  day: string;
  calls: number;
}

function arcPath(cx: number, cy: number, r: number, startDeg: number, endDeg: number) {
  const s = (startDeg * Math.PI) / 180;
  const e = (endDeg * Math.PI) / 180;
  const large = endDeg - startDeg > 180 ? 1 : 0;
  return `M ${cx + r * Math.cos(s)} ${cy + r * Math.sin(s)} A ${r} ${r} 0 ${large} 1 ${cx + r * Math.cos(e)} ${
    cy + r * Math.sin(e)
  }`;
}

/** Reactor-style arc gauge for today's cloud-call budget. */
function BudgetGauge({ used, remaining }: { used: number; remaining: number }) {
  const total = Math.max(1, used + remaining);
  const pct = Math.min(1, used / total);
  const SIZE = 96;
  const c = SIZE / 2;
  const r = c - 8;
  const START = 135;
  const SWEEP = 270;
  const color = pct < 0.6 ? "#34d399" : pct < 0.85 ? "#fbbf24" : "#f87171";
  return (
    <div className="relative shrink-0" style={{ width: SIZE, height: SIZE }} title={`${used} used / ${remaining} left today`}>
      <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`}>
        <path d={arcPath(c, c, r, START, START + SWEEP)} fill="none" stroke="#1e293b" strokeWidth="7" strokeLinecap="round" />
        {pct > 0.005 && (
          <path
            d={arcPath(c, c, r, START, START + SWEEP * pct)}
            fill="none"
            stroke={color}
            strokeWidth="7"
            strokeLinecap="round"
            style={{ filter: `drop-shadow(0 0 4px ${color})`, transition: "d 0.6s" }}
          />
        )}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-lg font-bold tabular-nums leading-none text-white">{remaining}</span>
        <span className="mt-0.5 text-[8px] uppercase tracking-wider text-slate-500">calls left</span>
      </div>
    </div>
  );
}

export function PowerStation() {
  const { presence } = usePraxisStream();
  const [log, setLog] = useState<LogResponse | null>(null);
  const [err, setErr] = useState(false);
  const [burn, setBurn] = useState<BurnDay[]>([]);
  const [localOnly, setLocalOnly] = useState<{ enabled: boolean; reason: string | null }>({
    enabled: false,
    reason: null,
  });
  const [toggling, setToggling] = useState(false);
  const [selectedCaller, setSelectedCaller] = useState<CallerAgg | null>(null);

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

  // Daily call burn-down: max sampled daily_call_count per local calendar day.
  // Fleet decommissioned 2026-07-02; stats-history removed.
  useEffect(() => {
    setBurn([]);
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
    <HudPanel
      icon={<Zap size={16} />}
      title="ENGINEERING — POWER"
      accent="amber"
      headerRight={
        <Link href="/llm-activity" className="flex items-center gap-1 text-[11px] text-cyan-400 hover:text-cyan-300">
          details <ArrowUpRight size={12} />
        </Link>
      }
    >
      <div className="mb-3 flex items-center gap-3">
        {used != null && remaining != null && <BudgetGauge used={used} remaining={remaining} />}
        <div className="flex min-w-0 flex-1 items-center justify-between gap-3 rounded-md border border-slate-800 bg-slate-950/50 px-2.5 py-2">
          <div className="flex min-w-0 items-center gap-2 text-[11px]">
            {localOnly.enabled ? <WifiOff size={13} className="shrink-0 text-amber-300" /> : <Cloud size={13} className="shrink-0 text-slate-400" />}
            <span className={`truncate ${localOnly.enabled ? "text-amber-200" : "text-slate-300"}`}>
              {localOnly.enabled ? "Local only" : "Cloud enabled"}
              {used != null ? <span className="text-slate-600"> · {used} used today</span> : null}
            </span>
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
            <button
              key={c.caller}
              onClick={() => setSelectedCaller(c)}
              className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left transition-colors hover:bg-slate-800/50"
              title={`${c.caller} — power draw detail`}
            >
              <div className="w-24 shrink-0 truncate text-[11px] text-slate-300">{shortName(c.caller)}</div>
              <div className="relative h-3.5 flex-1 overflow-hidden rounded bg-slate-800/60">
                <div
                  className="h-full rounded bg-amber-500/70 transition-all duration-500"
                  style={{ width: `${(c.calls / max) * 100}%` }}
                />
              </div>
              <div className="w-7 shrink-0 text-right text-[11px] tabular-nums text-slate-400">{c.calls}</div>
              <div className="w-9 shrink-0 text-right text-[10px] tabular-nums text-slate-600">{fmtTokens(c.tokens)}</div>
            </button>
          ))}
          <div className="pt-0.5 text-[10px] text-slate-600">
            {agg.total_calls} calls / {agg.by_provider.length} provider{agg.by_provider.length === 1 ? "" : "s"} in the
            last hour
          </div>
        </div>
      )}

      {burn.length >= 2 && (
        <div className="mt-3 border-t border-slate-800/60 pt-2">
          <div className="mb-1 text-[10px] uppercase tracking-wide text-slate-600">daily cloud-call burn</div>
          <div className="flex h-10 items-end gap-1.5">
            {burn.map((b) => {
              const max = Math.max(1, ...burn.map((x) => x.calls));
              return (
                <div key={b.day} className="flex flex-1 flex-col items-center gap-0.5" title={`${b.day}: ${b.calls} calls`}>
                  <div
                    className="w-full rounded-t bg-amber-500/50"
                    style={{ height: `${Math.max(6, (b.calls / max) * 100)}%` }}
                  />
                  <span className="text-[9px] text-slate-600">{b.day}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {selectedCaller && (
        <HudModal
          title={shortName(selectedCaller.caller)}
          subtitle={`power draw · last hour · ${selectedCaller.caller}`}
          icon={<Zap size={15} />}
          accent="amber"
          onClose={() => setSelectedCaller(null)}
        >
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-2">
              <HudStat label="calls" value={selectedCaller.calls} tone="text-amber-300" />
              <HudStat label="tokens" value={fmtTokens(selectedCaller.tokens)} />
              <HudStat
                label="failures"
                value={selectedCaller.failures}
                tone={selectedCaller.failures > 0 ? "text-red-300" : "text-slate-200"}
              />
            </div>
            {agg && agg.total_calls > 0 && (
              <div>
                <div className="mb-1 flex justify-between text-[10px] text-slate-500">
                  <span>share of hourly power draw</span>
                  <span className="tabular-nums">{Math.round((selectedCaller.calls / agg.total_calls) * 100)}%</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-slate-800">
                  <div
                    className="h-full rounded-full bg-amber-400"
                    style={{ width: `${(selectedCaller.calls / agg.total_calls) * 100}%` }}
                  />
                </div>
              </div>
            )}
            <Link
              href="/llm-activity"
              className="inline-flex items-center gap-1 text-[11px] text-cyan-400 hover:text-cyan-300"
            >
              full usage log <ArrowUpRight size={12} />
            </Link>
          </div>
        </HudModal>
      )}
    </HudPanel>
  );
}

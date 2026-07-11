/**
 * PowerStation — "Engineering": token throughput across every engine (the
 * old daily-call budget is dead — work is dispatched to subscription CLIs
 * now, not billed per call). A multicolor reactor gauge stacks today's
 * tokens by source (claude-code / codex / local / cloud API) against the
 * best day on record, plus who is drawing LLM power right now (caller bars
 * from the Praxis usage log) and the local-only lever.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Zap, ArrowUpRight, WifiOff, Cloud } from "lucide-react";
import { HudPanel, HudModal, HudStat } from "@/components/bridge/hud";
import { getLocalOnlyMode, setLocalOnlyMode } from "@/lib/model-control";
import { fmtTokens, type TokenDay } from "@/lib/token-usage";
import { useTokenUsage } from "@/hooks/use-token-usage";

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

function arcPath(cx: number, cy: number, r: number, startDeg: number, endDeg: number) {
  const s = (startDeg * Math.PI) / 180;
  const e = (endDeg * Math.PI) / 180;
  const large = endDeg - startDeg > 180 ? 1 : 0;
  return `M ${cx + r * Math.cos(s)} ${cy + r * Math.sin(s)} A ${r} ${r} 0 ${large} 1 ${cx + r * Math.cos(e)} ${
    cy + r * Math.sin(e)
  }`;
}

const TOKEN_SOURCES: { key: keyof TokenDay & ("claudeCode" | "codex" | "local" | "cloud"); label: string; color: string }[] = [
  { key: "claudeCode", label: "claude code", color: "#22d3ee" },
  { key: "codex", label: "codex", color: "#a78bfa" },
  { key: "local", label: "local llm", color: "#34d399" },
  { key: "cloud", label: "cloud api", color: "#60a5fa" },
];

/**
 * Reactor-style arc gauge: today's tokens stacked by source, scaled against
 * the single-day record (the pale tick). Full arc = your biggest day ever.
 */
function TokenGauge({ today, record }: { today: TokenDay; record: { date: string; total: number } }) {
  const SIZE = 112;
  const c = SIZE / 2;
  const r = c - 9;
  const START = 135;
  const SWEEP = 270;
  const scale = Math.max(record.total, today.total, 1);

  const segs: { color: string; from: number; to: number }[] = [];
  let acc = 0;
  for (const src of TOKEN_SOURCES) {
    const v = today[src.key];
    if (v <= 0) continue;
    const from = START + SWEEP * (acc / scale);
    acc += v;
    const to = START + SWEEP * (acc / scale);
    segs.push({ color: src.color, from, to: Math.max(to - 0.6, from + 0.05) });
  }
  const recDeg = START + SWEEP * Math.min(1, record.total / scale);
  const recRad = (recDeg * Math.PI) / 180;

  return (
    <div
      className="relative shrink-0"
      style={{ width: SIZE, height: SIZE }}
      title={`${today.total.toLocaleString()} tokens today · day record ${record.total.toLocaleString()} on ${record.date}`}
    >
      <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`}>
        <path d={arcPath(c, c, r, START, START + SWEEP)} fill="none" stroke="#1e293b" strokeWidth="7" strokeLinecap="round" />
        {segs.map((s, i) => (
          <path
            key={i}
            d={arcPath(c, c, r, s.from, s.to)}
            fill="none"
            stroke={s.color}
            strokeWidth="7"
            strokeLinecap="butt"
            style={{ filter: `drop-shadow(0 0 3px ${s.color})` }}
          />
        ))}
        {/* Day-record tick */}
        <line
          x1={c + (r - 6) * Math.cos(recRad)}
          y1={c + (r - 6) * Math.sin(recRad)}
          x2={c + (r + 6) * Math.cos(recRad)}
          y2={c + (r + 6) * Math.sin(recRad)}
          stroke="#e2e8f0"
          strokeWidth="1.5"
          opacity="0.75"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-lg font-bold leading-none tabular-nums text-white">{fmtTokens(today.total)}</span>
        <span className="mt-0.5 text-[8px] uppercase tracking-wider text-slate-500">tokens today</span>
      </div>
    </div>
  );
}

export function PowerStation() {
  const { usage } = useTokenUsage();
  const [log, setLog] = useState<LogResponse | null>(null);
  const [err, setErr] = useState(false);
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
  const recordDate = usage
    ? new Date(`${usage.record.date}T00:00:00`).toLocaleDateString([], { month: "short", day: "numeric" })
    : "";

  return (
    <HudPanel
      icon={<Zap size={16} />}
      title="ENGINEERING — POWER"
      accent="amber"
      className="flex h-full flex-col"
      headerRight={
        <Link href="/llm-activity" className="flex items-center gap-1 text-[11px] text-cyan-400 hover:text-cyan-300">
          details <ArrowUpRight size={12} />
        </Link>
      }
    >
      <div className="mb-3 flex items-center gap-3">
        {usage ? (
          <TokenGauge today={usage.today} record={usage.record} />
        ) : (
          <div className="flex h-[112px] w-[112px] shrink-0 items-center justify-center text-[10px] text-slate-600">
            reading…
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="grid grid-cols-2 gap-x-2 gap-y-1.5">
            {TOKEN_SOURCES.map((src) => (
              <div key={src.key} className="flex min-w-0 items-center gap-1.5">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: src.color }} />
                <span className="min-w-0 flex-1 truncate text-[10px] text-slate-400">{src.label}</span>
                <span className="shrink-0 text-[11px] font-semibold tabular-nums text-slate-200">
                  {usage ? fmtTokens(usage.today[src.key]) : "—"}
                </span>
              </div>
            ))}
            <div
              className="flex min-w-0 items-center gap-1.5"
              title="Antigravity exposes no token telemetry — dispatches tracked, tokens unknown"
            >
              <span className="h-2 w-2 shrink-0 rounded-full bg-slate-700" />
              <span className="min-w-0 flex-1 truncate text-[10px] text-slate-500">antigravity</span>
              <span className="shrink-0 text-[11px] tabular-nums text-slate-600">—</span>
            </div>
          </div>
          {usage && (
            <div className="mt-1.5 border-t border-slate-800/60 pt-1 text-[10px] text-slate-500">
              day record <span className="font-semibold text-slate-300">{fmtTokens(usage.record.total)}</span> · {recordDate}
              {usage.record.total > 0 && (
                <span className="text-slate-600"> · today at {Math.round((usage.today.total / usage.record.total) * 100)}%</span>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="mb-3 flex min-w-0 items-center justify-between gap-3 rounded-md border border-slate-800 bg-slate-950/50 px-2.5 py-2">
        <div className="flex min-w-0 items-center gap-2 text-[11px]">
          {localOnly.enabled ? <WifiOff size={13} className="shrink-0 text-amber-300" /> : <Cloud size={13} className="shrink-0 text-slate-400" />}
          <span className={`truncate ${localOnly.enabled ? "text-amber-200" : "text-slate-300"}`}>
            {localOnly.enabled ? "Local only" : "Cloud enabled"}
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

      {err && !log ? (
        <div className="py-3 text-center text-xs text-slate-500">Usage log unavailable</div>
      ) : !agg ? (
        <div className="py-3 text-center text-xs text-slate-600">Reading power draw…</div>
      ) : agg.total_calls === 0 ? (
        <div className="py-3 text-center text-xs text-slate-500">No LLM calls in the last hour.</div>
      ) : (
        <div className="mt-auto space-y-1.5">
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

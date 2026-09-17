"use client";

import { useState, type CSSProperties } from "react";
import Link from "next/link";
import { ArrowUpRight, Cpu, Gavel, Landmark, ShieldCheck, Sparkles } from "lucide-react";
import { effectiveReferenceVoices, isAggregatorVoice, type ArbiterSeat, type CouncilArbiterState, type CouncilSessionSummary, type CouncilBench } from "@/lib/council";
import { formatDuration, gateStatusLabel, type CliLaneView } from "@/lib/cli-lane";
import { taskActivityHref, type ActivityItem } from "@/lib/bridge-activity";
import type { DispatchStateResponse } from "./dispatch-station";
import type { ExecutorId } from "./executor-detail";
import { CapacityGateDetails } from "./capacity-gate";
import { ChatSessionCore } from "./chat-session-core";
import { deriveChatActivity, type ChatActivityView } from "@/lib/chat-activity";

import { activeModelName } from "@/lib/active-model";

const PROVIDER_STYLE = [
  { id: "antigravity", label: "Antigravity", mark: "A", area: "ag" },
  { id: "codex", label: "Codex", mark: "C", area: "codex" },
  { id: "claude-code", label: "Claude Code", mark: "✳", area: "claude" },
  { id: "openrouter", label: "OpenRouter", mark: "↗", area: "cloud" },
] as const;
const colorStyle = (color: string) => ({ "--module-color": color } as CSSProperties);

export interface DispatchMapProps {
  view: CliLaneView;
  available: boolean;
  activeItems: ActivityItem[];
  /** Recent terminal results only; the owner expires them using the shared clock. */
  recentItems: ActivityItem[];
  council: CouncilSessionSummary | null;
  councilAvailable: boolean;
  bench?: CouncilBench | null;
  memory?: NonNullable<DispatchStateResponse["system"]>["memory"];
  local: { running: number; queued: number; paused: boolean; resident?: number | null; directActive?: boolean };
  arbiter?: CouncilArbiterState | null;
  onSetArbiter?: (seat: ArbiterSeat) => void;
  onInspect: (id: ExecutorId) => void;
  chat?: ChatActivityView;
}

/** One topology: council above, providers around the resource gate, local below. */
export function DispatchMap({ view, available, activeItems, recentItems, council: reportedCouncil, councilAvailable, bench, memory, local, arbiter, onSetArbiter, onInspect, chat = deriveChatActivity({snapshot:null,local:null,conversationId:null,now:0}) }: DispatchMapProps) {
  const [capacityOpen, setCapacityOpen] = useState(false);
  const council = councilAvailable ? reportedCouncil : null;
  const gate = view.gate;
  const mem = available && memory?.availPct != null ? Math.max(0, Math.min(100, memory.availPct)) : null;
  const working = available ? activeItems : [];
  const localBusy = available && (local.running > 0 || local.directActive);
  const councilBusy = Boolean(council);
  const running = available ? gate.active : null;
  const limit = available ? gate.limit : null;
  const gateColor = !available ? "#64748b" : gate.burst === false || gate.saturated ? "#fbbf24" : "#22d3ee";
  const memColor = mem == null ? "#475569" : mem < 10 ? "#fb7185" : mem < 30 ? "#fbbf24" : "#34d399";
  const voices = council ? [...effectiveReferenceVoices(council.voices), ...council.voices.filter(isAggregatorVoice)] : [];
  const reported = voices.filter(v => v.status === "success").length;
  const providerIds = [...new Set([...view.executors.map(e => e.name), ...working.flatMap(r => r.executor ? [r.executor] : [])])];
  providerIds.sort((a, b) => {
    const order = ["antigravity", "codex", "claude-code", "openrouter"];
    return (order.indexOf(a) < 0 ? 99 : order.indexOf(a)) - (order.indexOf(b) < 0 ? 99 : order.indexOf(b));
  });
  const displayVoices = council ? voices.map((v, i) => ({
    key: `${v.name}:${i}`, label: activeModelName(v.model) ?? [...(bench?.references ?? []), ...(bench ? [bench.aggregator] : [])].find(s => s.id === v.model)?.label ?? v.model ?? v.name,
    id: v.name, status: v.status, aggregator: isAggregatorVoice(v),
  })) : bench ? [...bench.references.map(v => ({key: v.id, id: v.id, label: v.label, status: "idle", aggregator: false})), {key: "aggregator", id: bench.aggregator.id, label: bench.aggregator.label, status: "idle", aggregator: true}] : [];
  const pairs = Math.max(2, Math.ceil(providerIds.length / 2));
  const diagramHeight = pairs * 108 + 38, hubY = pairs * 54;
  const nodes = providerIds.map((id, index) => {
    const known = PROVIDER_STYLE.find(p => p.id === id);
    const p = {id, label: known?.label ?? view.executors.find(e => e.name === id)?.label ?? id, mark: known?.mark ?? id.slice(0, 1).toUpperCase(), area: `worker${index}`};
    const runs = working.filter(r => r.executor === p.id);
    const lane = view.executors.find(e => e.name === p.id);
    const seats = voices.filter(v => p.id === "openrouter" ? !v.name.startsWith("cli:") : v.name.match(/^cli:([\w-]+)/)?.[1] === p.id);
    const speaking = seats.some(v => v.status === "running");
    const terminal = available ? recentItems.find(r => r.executor === p.id) : undefined;
    const qa = runs.some(r => r.channel === "qa");
    const failed = lane?.suspended || (!runs.length && terminal?.status === "failed");
    const color = failed ? "#fb7185" : qa ? "#a78bfa" : runs.length ? "#22d3ee" : terminal?.channel === "qa" ? "#a78bfa" : terminal ? "#34d399" : speaking ? "#fbbf24" : "#64748b";
    const models = [...new Set([...runs.map(r => activeModelName(r.model)), ...seats.filter(v => v.status === "running").map(v => activeModelName(v.model))].filter((m): m is string => Boolean(m)))];
    return { ...p, label: models.join(" · ") || p.label, runs, lane, seats, speaking, terminal, qa, color, busy: runs.length > 0 || speaking };
  });

  return (
    <div className="dispatch-map" data-live={available} style={{gridTemplateAreas: `"council council council" ${Array.from({length: pairs}, (_, i) => `"${nodes[i * 2] ? `worker${i * 2}` : "."} hub ${nodes[i * 2 + 1] ? `worker${i * 2 + 1}` : "."}"`).join(" ")} "local local local" "queue queue queue"`, gridTemplateRows: `100px repeat(${pairs}, 108px) 36px 58px`}}>
      <svg aria-hidden="true" className="dispatch-wires" viewBox={`0 0 480 ${diagramHeight}`} style={{top: 100, height: diagramHeight}} preserveAspectRatio="none">
        <defs><radialGradient id="dispatch-field"><stop stopColor="#164e63" stopOpacity=".24" /><stop offset="1" stopColor="#020617" stopOpacity="0" /></radialGradient></defs>
        <ellipse cx="240" cy={hubY} rx="220" ry="140" fill="url(#dispatch-field)" />
        {[56, 88, 116].map(r => <ellipse key={r} cx="240" cy={hubY} rx={r * 1.45} ry={r} fill="none" stroke="#334155" strokeOpacity=".22" strokeDasharray="2 8" />)}
        {nodes.map((n, i) => {
          const x = i % 2 === 0 ? 74 : 406, y = Math.floor(i / 2) * 108 + 54;
          const path = `M240 ${hubY} C${x} ${hubY} 240 ${y} ${x} ${y}`;
          return <g key={n.id}>
            <path d={path} fill="none" stroke={n.busy ? n.color : "#334155"} strokeOpacity={n.busy ? .7 : .55} strokeWidth={n.busy ? 1.5 : 1} />
            {n.busy && <path d={path} fill="none" stroke={n.color} strokeWidth="3" strokeDasharray="2 28" className="module-flow" />}
            <path d={`M240 0 Q${x} 0 ${x} ${y - 28}`} fill="none" stroke={n.speaking ? "#fbbf24" : "#334155"} strokeOpacity={n.speaking ? .6 : .2} strokeDasharray="3 7" className={n.speaking ? "module-flow" : undefined} />
          </g>;
        })}
        <path d={`M240 ${hubY + 60} L240 ${diagramHeight}`} stroke={localBusy ? "#34d399" : "#334155"} strokeDasharray="3 6" className={localBusy ? "module-flow" : undefined} />
      </svg>

      <div className="dispatch-council-wrap">
      <Link href="/council" className="dispatch-council group" data-active={councilBusy} title={council?.topic ?? "Open council sessions and full transcripts"}>
        <Landmark size={15} />
        <span>{!councilAvailable ? "Council signal delayed" : council ? council.phase === "deliberation" ? "Council deliberating" : council.phase === "setup" ? "Council convening" : "Council synthesizing" : "Council chamber"}</span>
        <span className="dispatch-quorum" aria-label={council ? `${reported} of ${voices.length} voices reported` : "Council standing by"}>
          {displayVoices.map((v, i) => <i key={i} data-status={v.status} />)}
        </span>
        <ArrowUpRight size={12} />
      </Link>
      <div className="dispatch-voices" aria-label="Council seats">
        {displayVoices.map(v => <Link key={v.key} href="/council" className="dispatch-voice" data-status={v.status} title={`${v.id}${v.aggregator ? " · verdict writer" : " · council reference"}${council ? ` · ${v.status}` : " · configured seat"}`}>
          {v.aggregator ? <Gavel size={10}/> : <span className="dispatch-voice-gem"/>}<span>{v.label}</span>
        </Link>)}
        {!displayVoices.length && <span className="text-[10px] text-slate-500">Council roster unavailable</span>}
      </div>
      </div>

      {nodes.map(n => {
        const seatId = `cli:${n.id}` as ArbiterSeat;
        const pin = arbiter?.preference === seatId;
        const next = arbiter?.preference === "auto" && arbiter.next === seatId;
        const workLabel = !available ? "Signal delayed" : n.lane?.suspended ? "Suspended" : n.runs.length ? `${n.qa ? "QA · " : ""}${n.runs[0].phase ?? "working"}${n.runs.length > 1 ? ` +${n.runs.length - 1}` : ""}` : n.terminal ? n.terminal.status === "failed" ? "Run failed" : n.terminal.channel === "qa" ? "Review recorded" : "Completed" : "Standing by";
        const councilLabel = n.seats.length ? n.seats.some(isAggregatorVoice) ? "verdict writer" : n.speaking ? "deliberating" : n.seats.every(v => v.status === "success") ? "reported" : "council seat" : null;
        return <div key={n.id} data-provider={n.id} data-active={n.busy} className="dispatch-provider" style={{...colorStyle(n.color), gridArea: n.area}}>
          <button type="button" onClick={() => onInspect(n.id)} className="dispatch-provider-button" aria-label={`Inspect ${n.label}: ${workLabel}${councilLabel ? `; council ${councilLabel}` : ""}`} title={n.runs.map(r => r.title).join("\n") || `Open ${n.label} runs and reports`}>
            <span className="dispatch-chip" aria-hidden="true"><span>{n.qa ? <ShieldCheck size={16} /> : n.id === "claude-code" ? <Sparkles size={16}/> : n.mark}</span></span>
            <span className="dispatch-provider-label" title={n.label}>{n.label}</span>
            <span className="dispatch-phase">{workLabel}</span>
            <span className="dispatch-seat" aria-hidden={!councilLabel}>{councilLabel && <><Landmark size={9} />{councilLabel}</>}</span>
            <span className="dispatch-slots" aria-label={available && n.lane?.slots != null ? `${n.runs.length} working, ${n.lane.slots} configured slots` : "Slots unreported"}>
              {available && n.lane?.slots != null ? Array.from({length: Math.min(8, n.lane.slots)}, (_, i) => <i key={i} data-occupied={i < n.runs.length} />) : <i />}
            </span>
          </button>
          {arbiter && onSetArbiter && (n.id === "codex" || n.id === "claude-code") && <button type="button" className="dispatch-arbiter" data-selected={pin || next} aria-pressed={pin} aria-label={pin ? `Release ${n.label} arbiter pin` : `Pin ${n.label} as council arbiter`} title={pin ? "Pinned verdict writer · click for auto rotation" : next ? "Next verdict writer · click to pin" : "Pin as verdict writer"} onClick={() => onSetArbiter(seatId)}><Gavel size={11} /></button>}
        </div>;
      })}

      <div className="dispatch-hub" style={colorStyle(gateColor)}>
        <svg viewBox="0 0 160 180" aria-hidden="true">
          <circle cx="80" cy="85" r="55" fill="#04111c" stroke="#164e63" strokeWidth=".5" />
          <circle cx="80" cy="85" r="43" fill="none" stroke={gateColor} strokeOpacity=".25" strokeDasharray="1 5" />
          <circle cx="80" cy="85" r="57" fill="none" stroke="#1e293b" strokeWidth="5" />
          {limit != null && Array.from({length: Math.min(12, limit)}, (_, i) => <circle key={i} cx="80" cy="85" r="57" fill="none" stroke={i < (running ?? 0) ? "#67e8f9" : gateColor} strokeOpacity={i < (running ?? 0) ? 1 : .25} strokeWidth="5" strokeLinecap="round" strokeDasharray={`${Math.max(2, 358 / limit - 12)} 358`} transform={`rotate(${-90 + i * 360 / limit} 80 85)`} className={i < (running ?? 0) ? "module-breathe" : undefined} />)}
          <circle cx="80" cy="85" r="70" fill="none" stroke="#1e293b" strokeWidth="2" strokeDasharray="330 440" transform="rotate(135 80 85)" />
          <circle cx="80" cy="85" r="70" fill="none" stroke={memColor} strokeWidth="2.5" strokeLinecap="round" strokeDasharray={`${330 * (mem ?? 0) / 100} 440`} transform="rotate(135 80 85)" />
        </svg>
        <ChatSessionCore chat={chat}/>
        <button type="button" className="dispatch-capacity-readout" onClick={() => setCapacityOpen(true)} aria-haspopup="dialog" aria-expanded={capacityOpen} aria-label={`Inspect executor capacity: ${limit ?? "unknown"} at a time. ${available ? gateStatusLabel(gate) : "Signal delayed"}`}>
          <span>{running ?? "—"}/{limit ?? "—"} lanes · {!available ? "delayed" : gate.burst ? "burst" : limit === 1 ? "serial" : "capacity"}</span>
          <span style={{color:memColor}}>{mem != null ? `${Math.round(mem)}% memory free` : "Memory unreported"}</span>
        </button>
      </div>

      <button type="button" className="dispatch-local" data-active={localBusy} style={colorStyle("#34d399")} onClick={() => onInspect("local-llm")} aria-label="Inspect Local LLM">
        <Cpu size={14} /><span>Local LLM</span><span className="text-slate-400">{!available ? "Signal delayed" : local.paused ? "Queue paused" : local.running > 0 ? `${local.running} working` : local.directActive ? "Direct traffic" : local.resident === null ? "Offline" : local.resident != null ? `${local.resident} resident` : "Standing by"}</span>
        {localBusy && <Sparkles size={11} className="module-breathe" />}
      </button>

      <div className="dispatch-queue" aria-label="Dispatch queue">
        {!available ? <span className="text-slate-500">Dispatch signal delayed — showing last known capacity in details.</span> : <>
          {view.stalledCount > 0 && <Link href="/ops" className="text-rose-300">{view.stalledCount} stalled · inspect</Link>}
          {!view.queue.length && !view.stalledCount && <span className="text-slate-600">Dispatch queue clear</span>}
          {view.queue.slice(0, 2).map(q => <Link key={q.position} href={q.taskId ? taskActivityHref(q.taskId) : "/ops"} title={`${q.executorLabel ?? "Executor pending"} · waiting ${formatDuration(q.waitingMs) ?? "unknown"}`}><span className="text-cyan-400">{String(q.position).padStart(2, "0")}</span><span className="truncate">{q.title ?? "Queued work"}</span><span className="shrink-0 text-slate-500">{formatDuration(q.waitingMs)}</span></Link>)}
          {view.queue.length > 2 && <Link href="/ops">+{view.queue.length - 2} queued · open queue</Link>}
        </>}
      </div>
      {capacityOpen && <CapacityGateDetails gate={gate} onClose={() => setCapacityOpen(false)} />}
    </div>
  );
}

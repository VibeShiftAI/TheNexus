"use client";

import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import Link from "next/link";
import { ArrowUpRight, Clock, Cpu, Gavel, Landmark, Pause, Sparkles, X } from "lucide-react";
import { effectiveReferenceVoices, isAggregatorVoice, type ArbiterSeat, type CouncilArbiterState, type CouncilSessionSummary, type CouncilBench } from "@/lib/council";
import { formatDuration, gateStatusLabel, slotTag, type CliLaneView } from "@/lib/cli-lane";
import { taskActivityHref, type ActivityItem } from "@/lib/bridge-activity";
import type { DispatchStateResponse } from "./dispatch-station";
import type { ExecutorId } from "./executor-detail";
import { CapacityGateDetails } from "./capacity-gate";
import { ChatSessionCore } from "./chat-session-core";
import { deriveChatActivity, type ChatActivityView } from "@/lib/chat-activity";
import { activeModelName } from "@/lib/active-model";
import { ROLE_LABEL, UNKNOWN_MODEL, deriveProviderRuns, modelProvenance, providerTally, type OpsRunNode, type OpsRunRole } from "@/lib/ops-graph";
import { providerLogo } from "@/lib/provider-logos";
import { ProviderLogo } from "./provider-logo";

/**
 * Providers with a fixed place in the reading order. `mark` is the glyph a
 * provider keeps when the repo holds no vendor logo for it (see
 * public/brand/NOTICE.md); the four named vendors draw their logo instead.
 */
const PROVIDER_STYLE = [
  { id: "antigravity", label: "Antigravity", mark: "A" },
  { id: "codex", label: "Codex", mark: "C" },
  { id: "claude-code", label: "Claude Code", mark: "✳" },
  { id: "openrouter", label: "OpenRouter", mark: "↗" },
] as const;
const PROVIDER_ORDER: readonly string[] = PROVIDER_STYLE.map(p => p.id);
const colorStyle = (color: string) => ({ "--module-color": color } as CSSProperties);

const ROLE_COLOR: Record<OpsRunRole, string> = {
  building: "#22d3ee",
  reviewing: "#a78bfa",
  council: "#fbbf24",
  agent: "#2dd4bf",
};

/** Logo edge in px. The octagonal chip it replaces was 35px (globals.css, .dispatch-chip before this change). */
const LOGO_PX = 20;
/** Corner radius of a branch wire where it turns into the trunk and into a run node, in px. */
const WIRE_BEND_PX = 6;

/**
 * Trouble an executor is in, drawn on its logo now that the node carries no
 * status text: a ring and a corner badge (globals.css, .dispatch-logo[data-trouble]).
 * The words stay in the button's aria-label and title.
 */
type ProviderTrouble = "failed" | "suspended" | "delayed";
const TROUBLE_ICON: Record<ProviderTrouble, typeof X> = { failed: X, suspended: Pause, delayed: Clock };
/** The council seat's state on the logo's corner mark (globals.css, .dispatch-seat[data-council]). */
const COUNCIL_MARK: Record<string, string> = { "verdict writer": "writer", deliberating: "deliberating", reported: "reported", "council seat": "seat" };

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
  local: { summary: string; busy: boolean };
  arbiter?: CouncilArbiterState | null;
  onSetArbiter?: (seat: ArbiterSeat) => void;
  onInspect: (id: ExecutorId) => void;
  chat?: ChatActivityView;
  /** Clock for the council seats' elapsed time; the run clocks arrive already derived on `view`. */
  now?: number;
}

interface Point { x: number; y: number }
/** Where the nodes sit, in px from the map's top-left corner. Measured, because a provider's height follows its runs. */
interface Layout {
  hub: Point | null;
  council: Point | null;
  local: Point | null;
  providers: Record<string, { logo: Point; trunkX: number; side: "left" | "right"; runs: Record<string, Point> }>;
}

function sameLayout(a: Layout | null, b: Layout): boolean {
  return a != null && JSON.stringify(a) === JSON.stringify(b);
}

/** Hub to provider: leaves the hub sideways and lands on the logo level. */
function spokePath(hub: Point, logo: Point): string {
  return `M${hub.x} ${hub.y} C${logo.x} ${hub.y} ${hub.x} ${logo.y} ${logo.x} ${logo.y}`;
}

/** Provider to one run node: out to the column's outer edge, down the trunk, into the node. */
function branchPath(logo: Point, trunkX: number, run: Point): string {
  const out = trunkX < logo.x ? 1 : -1; // direction back toward the column from the trunk
  const r = WIRE_BEND_PX;
  return `M${logo.x} ${logo.y} H${trunkX + out * r} Q${trunkX} ${logo.y} ${trunkX} ${logo.y + r} V${run.y - r} Q${trunkX} ${run.y} ${trunkX + out * r} ${run.y} H${run.x}`;
}

/** One topology: council above, providers around the resource gate, each provider's runs beneath it, local below. */
export function DispatchMap({ view, available, activeItems, recentItems, council: reportedCouncil, councilAvailable, bench, memory, local, arbiter, onSetArbiter, onInspect, chat = deriveChatActivity({snapshot:null,local:null,conversationId:null,now:0}), now = Date.now() }: DispatchMapProps) {
  const [capacityOpen, setCapacityOpen] = useState(false);
  const mapRef = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<Layout | null>(null);
  const council = councilAvailable ? reportedCouncil : null;
  const gate = view.gate;
  const mem = available && memory?.availPct != null ? Math.max(0, Math.min(100, memory.availPct)) : null;
  const working = available ? activeItems : [];
  const localBusy = available && local.busy;
  const localSummary = available ? local.summary : "Signal delayed";
  const councilBusy = Boolean(council);
  const running = available ? gate.active : null;
  const limit = available ? gate.limit : null;
  const gateColor = !available ? "#64748b" : gate.burst === false || gate.saturated ? "#fbbf24" : "#22d3ee";
  const memColor = mem == null ? "#475569" : mem < 10 ? "#fb7185" : mem < 30 ? "#fbbf24" : "#34d399";
  const voices = council ? [...effectiveReferenceVoices(council.voices), ...council.voices.filter(isAggregatorVoice)] : [];
  const reported = voices.filter(v => v.status === "success").length;
  const providerIds = [...new Set([...view.executors.map(e => e.name), ...working.flatMap(r => r.executor ? [r.executor] : [])])];
  providerIds.sort((a, b) => {
    const rank = (id: string) => PROVIDER_ORDER.includes(id) ? PROVIDER_ORDER.indexOf(id) : PROVIDER_ORDER.length;
    return rank(a) - rank(b);
  });
  const displayVoices = council ? voices.map((v, i) => ({
    key: `${v.name}:${i}`, label: activeModelName(v.model) ?? [...(bench?.references ?? []), ...(bench ? [bench.aggregator] : [])].find(s => s.id === v.model)?.label ?? v.model ?? v.name,
    id: v.name, status: v.status, aggregator: isAggregatorVoice(v),
  })) : bench ? [...bench.references.map(v => ({key: v.id, id: v.id, label: v.label, status: "idle", aggregator: false})), {key: "aggregator", id: bench.aggregator.id, label: bench.aggregator.label, status: "idle", aggregator: true}] : [];
  const nodes = providerIds.map((id, index) => {
    const known = PROVIDER_STYLE.find(p => p.id === id);
    const p = {id, label: known?.label ?? view.executors.find(e => e.name === id)?.label ?? id, mark: known?.mark ?? id.slice(0, 1).toUpperCase(), side: index % 2 === 0 ? "left" as const : "right" as const};
    const lane = view.executors.find(e => e.name === p.id);
    const seats = voices.filter(v => p.id === "openrouter" ? !v.name.startsWith("cli:") : v.name.match(/^cli:([\w-]+)/)?.[1] === p.id);
    // One child per live run: every registry run on this lane, every stream
    // item the registry has not listed yet, every sitting council seat.
    const runs = deriveProviderRuns({
      laneRuns: available ? lane?.runs ?? [] : [],
      streamRuns: working.filter(r => r.executor === p.id),
      seats,
      council: council ? { topic: council.topic, createdAt: council.createdAt } : null,
      now,
    });
    const speaking = seats.some(v => v.status === "running");
    const terminal = available ? recentItems.find(r => r.executor === p.id) : undefined;
    const work = runs.filter(r => r.role !== "council");
    const qa = work.some(r => r.role === "reviewing");
    const failed = lane?.suspended || (!work.length && terminal?.status === "failed");
    const color = failed ? "#fb7185" : qa ? "#a78bfa" : work.length ? "#22d3ee" : terminal?.channel === "qa" ? "#a78bfa" : terminal ? "#34d399" : speaking ? "#fbbf24" : "#64748b";
    // Same precedence as the status words below: a stale signal outranks what it last said.
    const trouble: ProviderTrouble | null = !available ? "delayed" : lane?.suspended ? "suspended" : failed ? "failed" : null;
    return { ...p, runs, work, lane, seats, speaking, terminal, qa, color, trouble, busy: runs.length > 0 };
  });
  const columns = (["left", "right"] as const).map(side => ({ side, nodes: nodes.filter(n => n.side === side) }));

  // The wires follow the nodes: a provider is as tall as its run list, so the
  // drawing reads positions back from the laid-out DOM instead of assuming rows.
  const layoutKey = nodes.map(n => `${n.id}:${n.runs.map(r => r.key).join(",")}`).join("|");
  useLayoutEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const measure = () => {
      const base = map.getBoundingClientRect();
      const at = (el: Element, fx: number, fy: number): Point => {
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.left - base.left - map.clientLeft + r.width * fx), y: Math.round(r.top - base.top - map.clientTop + r.height * fy) };
      };
      const one = (selector: string, fx: number, fy: number) => { const el = map.querySelector(selector); return el ? at(el, fx, fy) : null; };
      const next: Layout = { hub: one(".dispatch-hub > svg", 0.5, 85 / 180), council: one(".dispatch-council-wrap", 0.5, 1), local: one(".dispatch-local", 0.5, 0), providers: {} };
      for (const el of map.querySelectorAll<HTMLElement>("[data-provider]")) {
        const logo = el.querySelector(".dispatch-logo");
        if (!logo) continue;
        const side = el.dataset.side === "right" ? "right" : "left";
        const box = at(el, side === "left" ? 0 : 1, 0);
        const runs: Record<string, Point> = {};
        for (const run of el.querySelectorAll<HTMLElement>("[data-run]")) runs[run.dataset.run ?? ""] = at(run, side === "left" ? 0 : 1, 0.5);
        // The trunk runs in the gutter the run list leaves on the column's outer edge.
        const first = el.querySelector("[data-run]");
        const inner = first ? at(first, side === "left" ? 0 : 1, 0).x : box.x;
        next.providers[el.dataset.provider ?? ""] = { logo: at(logo, 0.5, 0.5), trunkX: Math.round((box.x + inner) / 2), side, runs };
      }
      setLayout(prev => sameLayout(prev, next) ? prev : next);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(map);
    for (const el of map.querySelectorAll("[data-provider], .dispatch-hub, .dispatch-council-wrap")) observer.observe(el);
    return () => observer.disconnect();
  }, [layoutKey]);

  const hub = layout?.hub ?? null;

  return (
    <div className="dispatch-map-frame">
    <div ref={mapRef} className="dispatch-map" data-live={available} data-runs={nodes.reduce((n, p) => n + p.runs.length, 0)}>
      <svg aria-hidden="true" className="dispatch-wires">
        <defs><radialGradient id="dispatch-field"><stop stopColor="#164e63" stopOpacity=".24" /><stop offset="1" stopColor="#020617" stopOpacity="0" /></radialGradient></defs>
        {hub && <>
          <ellipse cx={hub.x} cy={hub.y} rx="220" ry="140" fill="url(#dispatch-field)" />
          {[56, 88, 116].map(r => <ellipse key={r} cx={hub.x} cy={hub.y} rx={r * 1.45} ry={r} fill="none" stroke="#334155" strokeOpacity=".22" strokeDasharray="2 8" />)}
        </>}
        {hub && nodes.map(n => {
          const at = layout?.providers[n.id];
          if (!at) return null;
          const spoke = spokePath(hub, at.logo);
          const councilFrom = layout?.council;
          return <g key={n.id} data-wires={n.id}>
            <path data-wire="spoke" d={spoke} fill="none" stroke={n.busy ? n.color : "#334155"} strokeOpacity={n.busy ? .7 : .55} strokeWidth={n.busy ? 1.5 : 1} />
            {n.busy && <path data-wire="spoke-flow" d={spoke} fill="none" stroke={n.color} strokeWidth="3" strokeDasharray="2 28" className="module-flow" />}
            {councilFrom && <path data-wire="council" d={`M${councilFrom.x} ${councilFrom.y} Q${at.logo.x} ${councilFrom.y} ${at.logo.x} ${at.logo.y - LOGO_PX}`} fill="none" stroke={n.speaking ? "#fbbf24" : "#334155"} strokeOpacity={n.speaking ? .6 : .2} strokeDasharray="3 7" className={n.speaking ? "module-flow" : undefined} />}
            {n.runs.map(run => {
              const to = at.runs[run.key];
              if (!to) return null;
              const d = branchPath(at.logo, at.trunkX, to);
              return <g key={run.key}>
                <path data-wire="run" d={d} fill="none" stroke={ROLE_COLOR[run.role]} strokeOpacity=".55" strokeWidth="1" />
                <path data-wire="run-flow" d={d} fill="none" stroke={ROLE_COLOR[run.role]} strokeWidth="2.5" strokeLinecap="round" strokeDasharray="2 28" className="module-flow" />
              </g>;
            })}
          </g>;
        })}
        {hub && layout?.local && <path data-wire="local" d={`M${hub.x} ${hub.y + 60} L${layout.local.x} ${layout.local.y}`} stroke={localBusy ? "#34d399" : "#334155"} strokeDasharray="3 6" className={localBusy ? "module-flow" : undefined} />}
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

      {columns.map(column => <div key={column.side} className="dispatch-column" data-side={column.side}>
        {column.nodes.map(n => {
          const seatId = `cli:${n.id}` as ArbiterSeat;
          const pin = arbiter?.preference === seatId;
          const next = arbiter?.preference === "auto" && arbiter.next === seatId;
          const workLabel = !available ? "Signal delayed" : n.lane?.suspended ? "Suspended" : n.work.length ? providerTally(n.work) : n.terminal ? n.terminal.status === "failed" ? "Run failed" : n.terminal.channel === "qa" ? "Review recorded" : "Completed" : "Standing by";
          const councilLabel = n.seats.length ? n.seats.some(isAggregatorVoice) ? "verdict writer" : n.speaking ? "deliberating" : n.seats.every(v => v.status === "success") ? "reported" : "council seat" : null;
          // The node shows the logo alone, so the wire passes straight through
          // it; the name, status and council seat are spoken and on hover.
          const status = `${workLabel}${councilLabel ? `; council ${councilLabel}` : ""}`;
          const TroubleIcon = n.trouble ? TROUBLE_ICON[n.trouble] : null;
          return <div key={n.id} data-provider={n.id} data-side={n.side} data-active={n.busy} data-expanded={n.runs.length > 0} data-trouble={n.trouble ?? undefined} className="dispatch-provider" style={colorStyle(n.color)}>
            <button type="button" onClick={() => onInspect(n.id)} className="dispatch-provider-button" aria-label={`Inspect ${n.label}: ${status}`} title={`${n.label}: ${status}. Open ${n.label} runs and reports`}>
              <span className="dispatch-logo" data-vendor={providerLogo(n.id) != null} data-trouble={n.trouble ?? undefined}>
                {providerLogo(n.id) ? <ProviderLogo provider={n.id} size={LOGO_PX} /> : <span className="dispatch-logo-glyph" aria-hidden="true">{n.mark}</span>}
                {TroubleIcon && <span className="dispatch-logo-badge" data-trouble={n.trouble} aria-hidden="true"><TroubleIcon size={8} strokeWidth={3} /></span>}
                {/* The council seat caption became this corner mark: it costs no height, and its words are in the button's label and title. */}
                <span className="dispatch-seat" data-council={councilLabel ? COUNCIL_MARK[councilLabel] : undefined} aria-hidden="true">{councilLabel && (councilLabel === "verdict writer" ? <Gavel size={8} /> : <Landmark size={8} />)}</span>
              </span>
            </button>
            {arbiter && onSetArbiter && (n.id === "codex" || n.id === "claude-code") && <button type="button" className="dispatch-arbiter" data-selected={pin || next} aria-pressed={pin} aria-label={pin ? `Release ${n.label} arbiter pin` : `Pin ${n.label} as council arbiter`} title={pin ? "Pinned verdict writer · click for auto rotation" : next ? "Next verdict writer · click to pin" : "Pin as verdict writer"} onClick={() => onSetArbiter(seatId)}><Gavel size={11} /></button>}
            {n.runs.length > 0 && <ul className="dispatch-runs" aria-label={`${n.label} runs`}>
              {n.runs.map(run => <li key={run.key}><RunNode run={run} provider={n.label} onOpen={() => onInspect(n.id)} /></li>)}
            </ul>}
          </div>;
        })}
      </div>)}

      <div className="dispatch-hub" style={colorStyle(gateColor)}>
        <svg viewBox="0 0 160 180" aria-hidden="true">
          <circle cx="80" cy="85" r="55" fill="#04111c" stroke="#164e63" strokeWidth=".5" />
          <circle cx="80" cy="85" r="43" fill="none" stroke={gateColor} strokeOpacity=".25" strokeDasharray="1 5" />
          <circle cx="80" cy="85" r="57" fill="none" stroke="#1e293b" strokeWidth="5" />
          {limit != null && limit > 0 && Array.from({length: limit}, (_, i) => <circle key={i} cx="80" cy="85" r="57" fill="none" stroke={i < (running ?? 0) ? "#67e8f9" : gateColor} strokeOpacity={i < (running ?? 0) ? 1 : .25} strokeWidth="5" strokeLinecap="round" strokeDasharray={`${Math.max(1, 358 / limit - Math.min(12, 358 / limit * .4))} 358`} transform={`rotate(${-90 + i * 360 / limit} 80 85)`} className={i < (running ?? 0) ? "module-breathe" : undefined} />)}
          <circle cx="80" cy="85" r="70" fill="none" stroke="#1e293b" strokeWidth="2" strokeDasharray="330 440" transform="rotate(135 80 85)" />
          <circle cx="80" cy="85" r="70" fill="none" stroke={memColor} strokeWidth="2.5" strokeLinecap="round" strokeDasharray={`${330 * (mem ?? 0) / 100} 440`} transform="rotate(135 80 85)" />
        </svg>
        <ChatSessionCore chat={chat}/>
        <button type="button" className="dispatch-capacity-readout" onClick={() => setCapacityOpen(true)} aria-haspopup="dialog" aria-expanded={capacityOpen} aria-label={`Inspect executor capacity: ${limit ?? "unknown"} at a time. ${available ? gateStatusLabel(gate) : "Signal delayed"}`}>
          <span>{running ?? "—"}/{limit ?? "—"} lanes · {!available ? "delayed" : gate.burst ? "burst" : limit === 1 ? "serial" : "capacity"}</span>
          <span style={{color:memColor}}>{mem != null ? `${Math.round(mem)}% memory free` : "Memory unreported"}</span>
        </button>
      </div>

      <button type="button" className="dispatch-local" data-active={localBusy} style={colorStyle("#34d399")}
        onClick={() => onInspect("local-llm")} aria-haspopup="dialog" aria-label={`Inspect Local LLM: ${localSummary}`} title={localSummary}>
        {providerLogo("local-llm") ? <ProviderLogo provider="local-llm" size={14} /> : <Cpu size={14} />}
        <span className="shrink-0">Local LLM</span>
        <span className="min-w-0 text-left text-slate-300">{localSummary}</span>
        {localBusy && <Sparkles size={11} className="shrink-0 module-breathe" />}
      </button>

      <div className="dispatch-queue" aria-label="Dispatch queue">
        {!available ? <span className="text-slate-500">Dispatch signal delayed — showing last known capacity in details.</span> : <>
          {view.stalledCount > 0 && <Link href="/ops" className="text-rose-300">{view.stalledCount} stalled · inspect</Link>}
          {!view.queue.length && !view.stalledCount && <span className="text-slate-600">Dispatch queue clear</span>}
          {view.queue.slice(0, 2).map(q => <Link key={q.position} href={q.taskId ? taskActivityHref(q.taskId) : "/ops"} title={`${q.executorLabel ?? "Executor pending"} · waiting ${formatDuration(q.waitingMs) ?? "unknown"}`}><span className="text-cyan-400">{String(q.position).padStart(2, "0")}</span>{slotTag(q.slotNumber) && <span className="dispatch-run-slot">{slotTag(q.slotNumber)}</span>}<span className="truncate">{q.title ?? "Queued work"}</span><span className="shrink-0 text-slate-500">{formatDuration(q.waitingMs)}</span></Link>)}
          {view.queue.length > 2 && <Link href="/ops">+{view.queue.length - 2} queued · open queue</Link>}
        </>}
      </div>
      {capacityOpen && <CapacityGateDetails gate={gate} onClose={() => setCapacityOpen(false)} />}
    </div>
    </div>
  );
}

/**
 * One live run under its provider: slot tag, model, effort, role, live phase
 * and elapsed time, on one row where the width allows. The task title is not
 * drawn (the slot identifies the work); it stays in the hover title, the
 * aria-label and the drill-down. A run without a slot leads with its role word
 * instead, so the node never opens on an empty head and the role is not said twice.
 */
function RunNode({ run, provider, onOpen }: { run: OpsRunNode; provider: string; onOpen: () => void }) {
  const elapsed = formatDuration(run.elapsedMs);
  const role = ROLE_LABEL[run.role];
  const provenance = modelProvenance(run);
  const spoken = [
    run.slot ? `Slot ${run.slot.slice(1)}` : null,
    run.title,
    `${role} on ${provider}`,
    run.model ? `model ${run.model}${run.effort ? `, effort ${run.effort}` : ""}` : "model unknown",
    elapsed ? `running ${elapsed}` : "just dispatched",
  ].filter(Boolean).join("; ");
  return <button type="button" className="dispatch-run" data-run={run.key} data-role={run.role} style={colorStyle(ROLE_COLOR[run.role])} onClick={onOpen} aria-label={`${spoken}. Open ${provider} runs`} title={[run.title, provenance].join("\n")}>
    {run.slot ? <span className="dispatch-run-slot">{run.slot}</span> : <span className="dispatch-run-standin dispatch-run-role">{role}</span>}
    <span className="dispatch-run-model" data-known={run.model != null}>{run.model ?? UNKNOWN_MODEL}</span>
    {run.effort && <span className="dispatch-run-effort">{run.effort}</span>}
    {run.slot && <span className="dispatch-run-role">{role}</span>}
    {/* The live phase Praxis reports for the run (testing, writing, ...). A council seat has none of its own. */}
    {run.phase && run.role !== "council" && run.phase !== role && <span className="dispatch-run-phase">{run.phase}</span>}
    <span className="dispatch-run-elapsed" title={elapsed ? undefined : "Just dispatched: Praxis has not listed a start time yet"}>{elapsed ?? "new"}</span>
  </button>;
}

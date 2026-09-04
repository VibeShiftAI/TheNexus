/**
 * PraxisCore — the bridge "main viewer": the living core orb (shared with
 * ambient mode via CoreCanvas) with live stat readouts and the thinking
 * trace on the left, and the Praxis terminal embedded as the viewscreen
 * beside it — presence and conversation are one station. The viewscreen is
 * kept dashboard-sized; a maximize toggle blows it up to full screen without
 * losing conversation state. Crew chips click through to executor telemetry.
 */
"use client";

import { useState, useRef } from "react";
import { Radio, Maximize2, Minimize2, Plus, History } from "lucide-react";
import { useLiveBoardState } from "@/components/live-board-state";
import { useCrewActivity } from "@/hooks/use-crew-activity";
import { useActiveWork } from "@/hooks/use-active-work";
import { useCoreState } from "@/hooks/use-core-state";
import { useTokenUsage } from "@/hooks/use-token-usage";
import { fmtTokens } from "@/lib/token-usage";
import { CoreCanvas, EXECUTOR_COLORS } from "@/components/bridge/core-canvas";
import { HudPanel, HudErrorBoundary } from "@/components/bridge/hud";
import { ExecutorDetailModal, type ExecutorId } from "@/components/bridge/executor-detail";
import { AITerminal, type AITerminalHandle } from "@/components/ai-terminal";
import { NowStrip } from "@/components/bridge/now-strip";
import { ChatModelControl } from "@/components/bridge/chat-model-control";

const COUNCIL_PHASE_LABEL: Record<string, string> = {
  setup: "convening",
  deliberation: "deliberating",
  synthesis: "synthesizing",
  refinement: "refining",
  complete: "adjourned",
};

const COUNCIL_ACCENT: Record<string, string> = {
  morning: "border-amber-400/30 bg-amber-400/5 text-amber-200",
  status: "border-cyan-400/30 bg-cyan-400/5 text-cyan-200",
  summoned: "border-violet-400/30 bg-violet-400/5 text-violet-200",
};

function fmtTime(iso?: string) {
  if (!iso) return null;
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function PraxisCore() {
  const { presence, recentEvents, connected } = useLiveBoardState();
  const { crew } = useCrewActivity();
  const core = useCoreState();
  const work = useActiveWork();
  const { usage } = useTokenUsage();
  const [viewscreenMax, setViewscreenMax] = useState(false);
  const [inspecting, setInspecting] = useState<ExecutorId | null>(null);
  const terminalRef = useRef<AITerminalHandle>(null);
  const busyCrew = crew.filter((m) => m.state === "active").length;

  const lastTrace = recentEvents.find((e) => e.type === "thinking.trace");
  const traceText = lastTrace && lastTrace.type === "thinking.trace" ? lastTrace.content : presence?.thinkingTrace;

  const stats = (
    [
      { label: "Scheduled", value: presence?.scheduledTaskCount },
      { label: "Done today", value: presence?.completedTasksToday },
      { label: "Tokens today", value: usage ? fmtTokens(usage.today.total) : undefined },
      { label: "Next wake", value: fmtTime(presence?.nextWakeAt) },
    ] as { label: string; value: number | string | null | undefined }[]
  ).filter((s): s is { label: string; value: number | string } => s.value !== undefined && s.value !== null);

  // Chat controls hoisted out of the terminal so the whole header is one row.
  // ChatModelControl leads: which model is answering as Praxis is a readout
  // first and a control second, and it shares the settings modal's chat-config
  // state rather than owning a switch of its own.
  const chatControls = (
    <>
      <ChatModelControl />
      <button
        onClick={() => terminalRef.current?.newConversation()}
        className="rounded-md border border-slate-800 bg-slate-900/60 p-1 text-slate-400 transition-colors hover:bg-slate-800 hover:text-emerald-300"
        aria-label="New conversation"
        title="New conversation"
      >
        <Plus size={13} />
      </button>
      <button
        onClick={() => terminalRef.current?.toggleHistory()}
        className="rounded-md border border-slate-800 bg-slate-900/60 p-1 text-slate-400 transition-colors hover:bg-slate-800 hover:text-cyan-300"
        aria-label="Conversation history"
        title="Conversation history"
      >
        <History size={13} />
      </button>
    </>
  );

  return (
    <HudPanel
      icon={<Radio size={16} />}
      title="MAIN VIEWER — PRAXIS CORE"
      accent="cyan"
      className="overflow-hidden"
      headerCenter={<NowStrip bare />}
      headerRight={
        <>
          {chatControls}
          <span
            className={`rounded-md border px-1.5 py-0.5 text-[10px] uppercase ${
              connected
                ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-200"
                : "border-amber-400/40 bg-amber-400/10 text-amber-200"
            }`}
          >
            {connected ? "live" : "reconnecting"}
          </span>
          <button
            onClick={() => setViewscreenMax((v) => !v)}
            className="rounded-md border border-slate-800 bg-slate-900/60 p-1 text-slate-400 transition-colors hover:bg-slate-800 hover:text-white"
            aria-label={viewscreenMax ? "Restore viewscreen" : "Maximize viewscreen"}
            title={viewscreenMax ? "Restore viewscreen" : "Maximize viewscreen"}
          >
            {viewscreenMax ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-4 lg:flex-row">
        {/* Core column — presence, vitals, thought stream */}
        <div className="flex w-full shrink-0 flex-col items-center lg:w-[240px]">
          <CoreCanvas state={core} size={150} />

          <div className={`text-lg font-bold tracking-tight ${core.textClass}`}>{core.label}</div>
          {/* Sub-line prefers the dispatch-correlated "what is actually
              running" signal (same source as the NOW strip) over
              presence.summary, which can describe a finished flow until the
              producer hands presence off. */}
          <div
            className="mt-0.5 line-clamp-2 text-center text-[11px] text-slate-400"
            title={work.taskLabel ?? presence?.summary}
          >
            {work.taskLabel ??
              presence?.summary ??
              (connected ? "Connecting…" : "Signal lost — attempting to re-establish link")}
          </div>

          {/* Live deliberation readout — the seats around the orb, named. */}
          {core.council && (
            <div
              className={`mt-1.5 w-full rounded-md border px-2 py-1 text-[10px] ${COUNCIL_ACCENT[core.council.kind]}`}
              title={core.council.topic}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold uppercase tracking-wide">
                  {COUNCIL_PHASE_LABEL[core.council.phase] ?? core.council.phase}
                </span>
                <span className="tabular-nums opacity-80">
                  {core.council.reported}/{core.council.expected} seats
                </span>
              </div>
              <div className="mt-0.5 truncate opacity-70">{core.council.topic}</div>
            </div>
          )}

          {stats.length > 0 && (
            <div className="mt-2.5 grid w-full grid-cols-2 gap-1.5">
              {stats.map((s) => (
                <div key={s.label} className="rounded-md border border-slate-800 bg-slate-950/50 px-2 py-1">
                  <div className="text-[9px] uppercase tracking-wide text-slate-500">{s.label}</div>
                  <div className="text-[13px] font-semibold tabular-nums text-slate-200">{s.value}</div>
                </div>
              ))}
            </div>
          )}

          {/* Crew — the other pairs of hands: CLI executors + local LLM.
              Praxis can be idle while the crew works his dispatched tasks.
              Each chip opens the executor drill-down. */}
          <div className="mt-2.5 w-full">
            <div className="mb-1 flex items-baseline justify-between">
              <span className="text-[10px] uppercase tracking-wide text-slate-600">crew</span>
              {busyCrew > 0 && (
                <span className="text-[10px] font-semibold text-cyan-400">{busyCrew} working</span>
              )}
            </div>
            <div className="grid w-full grid-cols-2 gap-1.5">
              {crew.map((m) => (
                <button
                  key={m.id}
                  onClick={() => setInspecting(m.id as ExecutorId)}
                  className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-left transition-colors hover:border-slate-600 ${
                    m.state === "active"
                      ? "border-cyan-500/30 bg-cyan-500/5"
                      : m.state === "failed"
                      ? "border-red-500/30 bg-red-500/5"
                      : "border-slate-800 bg-slate-950/50"
                  }`}
                  title={`${m.label}${m.detail ? `: ${m.detail}` : ""} — click for telemetry`}
                >
                  {/* Identity dot: same hue as this executor's comet around the
                      orb, so the chip and the sprite read as one being. */}
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                      m.state === "active" ? "motion-safe:animate-pulse" : ""
                    }`}
                    style={{
                      backgroundColor:
                        m.state === "failed" ? "#f87171" : m.state === "done" ? "#34d399" : EXECUTOR_COLORS[m.id] ?? "#64748b",
                      opacity: m.state === "idle" ? 0.35 : 1,
                      boxShadow:
                        m.state === "active"
                          ? `0 0 6px ${EXECUTOR_COLORS[m.id] ?? "#64748b"}`
                          : m.state === "failed"
                          ? "0 0 6px rgba(248,113,113,0.8)"
                          : undefined,
                    }}
                  />
                  <div className="min-w-0">
                    <div className={`truncate text-[10px] font-medium ${m.state === "idle" ? "text-slate-500" : "text-slate-200"}`}>
                      {m.label}
                    </div>
                    <div className={`truncate text-[9px] ${m.state === "active" ? "text-cyan-400" : m.state === "failed" ? "text-red-400" : "text-slate-600"}`}>
                      {m.detail ?? m.state}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>

          {traceText && (core.activity === "thinking" || core.activity === "executing") && (
            <div className="mt-2.5 max-h-16 w-full overflow-hidden rounded-md border border-slate-800/60 bg-slate-950/60 px-2.5 py-1.5">
              <div className="text-[10px] uppercase tracking-wide text-slate-600">thought stream</div>
              <p className="truncate font-mono text-[11px] leading-relaxed text-slate-500" title={traceText}>
                {traceText}
              </p>
            </div>
          )}
        </div>

        {/* Viewscreen — the Praxis terminal, part of the core station. The
            terminal renders frameless in inline mode, so here it's just a
            divided region of the panel; the maximized state supplies its own
            chrome. Same DOM node in both sizes so the conversation survives
            the toggle. */}
        {viewscreenMax && (
          <div
            className="fixed inset-0 z-[70] bg-black/70 backdrop-blur-sm"
            onClick={() => setViewscreenMax(false)}
            aria-hidden
          />
        )}
        <div
          className={
            viewscreenMax
              ? "hud-scanlines fixed inset-4 z-[71] flex flex-col rounded-lg border border-slate-700 bg-slate-950/95 p-4 shadow-2xl"
              : "flex h-[420px] min-w-0 flex-1 flex-col border-t border-slate-800/70 pt-3 lg:border-l lg:border-t-0 lg:pl-4 lg:pt-0"
          }
        >
          <HudErrorBoundary label="viewscreen">
            <AITerminal ref={terminalRef} mode="inline" hideHeader />
          </HudErrorBoundary>
          {viewscreenMax && (
            <div className="absolute -top-3 right-2 flex items-center gap-1.5">
              {chatControls}
              <button
                onClick={() => setViewscreenMax(false)}
                className="rounded-full border border-slate-700 bg-slate-900 p-1.5 text-slate-300 shadow-lg transition-colors hover:bg-slate-800 hover:text-white"
                aria-label="Restore viewscreen"
              >
                <Minimize2 size={14} />
              </button>
            </div>
          )}
        </div>
      </div>

      {inspecting && <ExecutorDetailModal executor={inspecting} onClose={() => setInspecting(null)} />}
    </HudPanel>
  );
}

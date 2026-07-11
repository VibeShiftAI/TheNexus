/**
 * StatusStrip — headline KPI readouts across the top of the bridge:
 * Praxis presence, fleet liveness, crew activity, pending input, call
 * budget and today's completions. Each chip warps (smooth-scrolls) to its
 * station and pings it with a highlight flash, so the strip doubles as
 * deck navigation.
 */
"use client";

import { Activity, Send, Inbox, Zap, CheckCircle2 } from "lucide-react";
import { usePraxisStream } from "@/hooks/use-praxis-stream";
import { useCrewActivity } from "@/hooks/use-crew-activity";
import { useHitlInbox } from "@/hooks/use-hitl-inbox";
import { useTokenUsage } from "@/hooks/use-token-usage";
import { fmtTokens } from "@/lib/token-usage";
import { CORE_STYLES } from "@/components/bridge/core-canvas";
import type { PresenceActivity } from "@praxis/contract";

function flashPanel(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.remove("hud-flash");
  // Force a reflow so re-adding the class restarts the animation.
  void el.offsetWidth;
  el.classList.add("hud-flash");
  window.setTimeout(() => el.classList.remove("hud-flash"), 1700);
}

interface Chip {
  id: string;
  label: string;
  value: string;
  icon: React.ReactNode;
  tone: string;
  /** Optional separate tone for the value text (e.g. gradient) so the icon keeps a solid color. */
  valueTone?: string;
  target: string;
  title: string;
}

export function StatusStrip() {
  const { presence, connected } = usePraxisStream();
  const { crew } = useCrewActivity();
  const { pendingRequests } = useHitlInbox();
  const { usage } = useTokenUsage();

  const activity: PresenceActivity = connected ? (presence?.activity ?? "offline") : "offline";
  const busy = crew.filter((m) => m.state === "active").length;
  const pending = pendingRequests.length;
  const doneToday = presence?.completedTasksToday;

  const chips: Chip[] = [
    {
      id: "praxis",
      label: "PRAXIS",
      value: CORE_STYLES[activity].label,
      icon: <Activity size={13} />,
      tone: CORE_STYLES[activity].textClass,
      target: "station-core",
      title: "Main viewer",
    },
    {
      id: "crew",
      label: "CREW",
      value: busy > 0 ? `${busy} working` : "idle",
      icon: <Send size={13} />,
      tone: busy > 0 ? "text-cyan-300" : "text-slate-400",
      target: "station-dispatch",
      title: "Ops — dispatch lanes",
    },
    {
      id: "inbox",
      label: "INPUT",
      value: pending > 0 ? `${pending} pending` : "clear",
      icon: <Inbox size={13} />,
      tone: pending > 0 ? "text-amber-300" : "text-slate-400",
      target: "panel-inbox",
      title: "Praxis inbox",
    },
    {
      id: "power",
      label: "TOKENS TODAY",
      value: usage ? fmtTokens(usage.today.total) : "—",
      icon: <Zap size={13} />,
      tone: "text-amber-300",
      valueTone: "bg-gradient-to-r from-cyan-300 via-violet-300 to-emerald-300 bg-clip-text text-transparent",
      target: "station-power",
      title: "Engineering — token throughput",
    },
    {
      id: "done",
      label: "DONE TODAY",
      value: doneToday != null ? String(doneToday) : "—",
      icon: <CheckCircle2 size={13} />,
      tone: "text-emerald-300",
      target: "station-taskboard",
      title: "Tactical — task board",
    },
  ];

  return (
    <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
      {chips.map((c) => (
        <button
          key={c.id}
          onClick={() => flashPanel(c.target)}
          className="hud-scanlines group relative flex items-center gap-2.5 rounded-lg border border-slate-800 bg-slate-900/50 px-3 py-2 text-left transition-colors hover:border-cyan-500/40 hover:bg-slate-900"
          title={`Warp to ${c.title}`}
        >
          <span className={`shrink-0 ${c.tone}`}>{c.icon}</span>
          <span className="min-w-0">
            <span className="block text-[9px] font-semibold uppercase tracking-widest text-slate-500">
              {c.label}
            </span>
            <span className={`block truncate text-[13px] font-bold leading-tight ${c.valueTone ?? c.tone}`}>{c.value}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

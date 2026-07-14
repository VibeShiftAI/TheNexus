/**
 * CommsModal — drill-down for the COMMS status chip: the unified feed of
 * external communications (feedback submissions in, Praxis emails out,
 * replies/questionnaire answers back in), newest first, with direction
 * arrows and PX trace tags.
 */
"use client";

import { ArrowDownLeft, ArrowUpRight, Radio } from "lucide-react";
import { HudModal } from "@/components/bridge/hud";
import { timeAgo } from "@/components/pulse-visuals";
import type { CommsFeed } from "@/lib/nexus";
import type { CommsItem } from "@praxis/contract";

const KIND_LABEL: Record<string, string> = {
  feedback: "Feedback",
  email: "Email",
  reply: "Reply",
  answers: "Questionnaire",
  questionnaire: "Questionnaire sent",
};

function statusTone(item: CommsItem): string {
  if (item.status === "unrouted") return "text-amber-300";
  if (item.direction === "in") return "text-cyan-300";
  return "text-violet-300";
}

export function CommsModal({
  feed,
  lastSeen,
  onClose,
}: {
  feed: CommsFeed | null;
  lastSeen: string | null;
  onClose: () => void;
}) {
  const items = feed?.items ?? [];
  const seenTs = lastSeen ? Date.parse(lastSeen) : NaN;

  return (
    <HudModal
      title="External Comms"
      subtitle={`hailing log · ${feed ? `${feed.counts.in} in / ${feed.counts.out} out` : "no signal"}`}
      icon={<Radio size={16} />}
      accent="cyan"
      onClose={onClose}
    >
      {items.length === 0 ? (
        <div className="py-10 text-center text-sm text-slate-500">
          No external communications yet. When family testers use the feedback
          widget — or Praxis emails someone — it shows up here.
        </div>
      ) : (
        <div className="space-y-1.5">
          {items.map((item) => {
            const isNew = Number.isFinite(seenTs) && Date.parse(item.at) > seenTs;
            return (
              <div
                key={item.id}
                className={`flex items-start gap-3 rounded-lg border px-3 py-2 ${
                  isNew
                    ? "border-cyan-500/40 bg-cyan-500/5"
                    : "border-slate-800 bg-slate-900/40"
                }`}
              >
                <span className={`mt-0.5 shrink-0 ${statusTone(item)}`}>
                  {item.direction === "in" ? (
                    <ArrowDownLeft size={15} />
                  ) : (
                    <ArrowUpRight size={15} />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">
                      {KIND_LABEL[item.kind] ?? item.kind}
                      {item.project ? ` · ${item.project}` : ""}
                    </span>
                    {item.tag && (
                      <span className="rounded bg-slate-800/80 px-1.5 font-mono text-[10px] text-cyan-400">
                        {item.tag}
                      </span>
                    )}
                    {isNew && (
                      <span className="rounded bg-cyan-500/20 px-1.5 text-[9px] font-bold uppercase tracking-wider text-cyan-300">
                        new
                      </span>
                    )}
                  </div>
                  <p className="truncate text-[13px] text-slate-200" title={item.summary}>
                    {item.summary}
                  </p>
                  <p className="text-[11px] text-slate-500">
                    {item.direction === "in" ? "from" : "to"}{" "}
                    <span className="text-slate-400">{item.party ?? "unknown"}</span>
                    {item.status ? ` · ${item.status}` : ""}
                  </p>
                </div>
                <span className="shrink-0 font-mono text-[10px] text-slate-600">
                  Δ {timeAgo(item.at) ?? "now"}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </HudModal>
  );
}

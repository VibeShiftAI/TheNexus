"use client";

/**
 * The human brief block: the first thing a person reads on an inbox card, a
 * document review, or anywhere else Praxis asks for a decision. Four lines
 * (project, what happened, the problem, what I need from you) plus the
 * recommendation and consequence when the sender gave them. Rendered the
 * same everywhere so the eye learns where to look.
 */
import { useState } from "react";
import { BRIEF_LABELS, type HumanBrief } from "@/lib/human-brief";

/**
 * Below the small breakpoint the label sits above its text instead of beside
 * it: a 9.5rem label column next to a 375px phone's text column made four
 * short lines stand over 500px tall in the document reviewer (2026-10-24).
 * With `collapsible`, a phone (below the large breakpoint) shows only the ask
 * until "Show details" is tapped; desktop always shows the whole brief.
 */
export function HumanBriefBlock({ brief, compact = false, collapsible = false }: { brief: HumanBrief; compact?: boolean; collapsible?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const foldable = collapsible && !expanded;
  const row = (key: keyof typeof BRIEF_LABELS, value: string | undefined, accent = false) =>
    value ? (
      <div key={key} className={`flex flex-col gap-0.5 sm:flex-row sm:gap-2 ${foldable && !accent ? "max-lg:hidden" : ""}`} data-brief-field={key}>
        <dt className={`shrink-0 text-[length:var(--hitl-fs-11,0.6875rem)] uppercase tracking-wider sm:w-[9.5rem] ${accent ? "text-cyan-300" : "text-slate-500"}`}>
          {BRIEF_LABELS[key]}
        </dt>
        <dd className={`min-w-0 flex-1 ${accent ? "font-semibold text-slate-50" : "text-slate-200"}`}>{value}</dd>
      </div>
    ) : null;
  return (
    <dl
      className={`space-y-1.5 rounded-md border border-cyan-500/20 bg-cyan-500/[0.04] text-[length:var(--hitl-fs-sm,0.875rem)] leading-relaxed ${compact ? "px-2.5 py-2" : "px-3 py-2.5"}`}
      data-human-brief=""
      {...(collapsible ? { "data-brief-collapsed": expanded ? "false" : "true" } : {})}
    >
      {row("project", brief.project)}
      {row("situation", brief.situation, !brief.ask)}
      {row("problem", brief.problem)}
      {row("ask", brief.ask && brief.options?.length ? `${brief.ask} Options: ${brief.options.join(" / ")}.` : brief.ask, true)}
      {row("recommendation", brief.recommendation)}
      {row("ifIgnored", brief.ifIgnored)}
      {collapsible && (
        <div className="lg:hidden">
          <button type="button" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded} className="text-[length:var(--hitl-fs-11,0.6875rem)] font-semibold uppercase tracking-wider text-cyan-300 hover:text-cyan-100" data-brief-toggle="">
            {expanded ? "Hide details" : "Show details"}
          </button>
        </div>
      )}
    </dl>
  );
}

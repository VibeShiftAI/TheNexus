"use client";

/**
 * The human brief block: the first thing a person reads on an inbox card, a
 * document review, or anywhere else Praxis asks for a decision. Four lines
 * (project, what happened, the problem, what I need from you) plus the
 * recommendation and consequence when the sender gave them. Rendered the
 * same everywhere so the eye learns where to look.
 */
import { BRIEF_LABELS, type HumanBrief } from "@/lib/human-brief";

export function HumanBriefBlock({ brief, compact = false }: { brief: HumanBrief; compact?: boolean }) {
  const row = (key: keyof typeof BRIEF_LABELS, value: string | undefined, accent = false) =>
    value ? (
      <div key={key} className="flex gap-2" data-brief-field={key}>
        <dt className={`w-[9.5rem] shrink-0 text-[length:var(--hitl-fs-11,0.6875rem)] uppercase tracking-wider ${accent ? "text-cyan-300" : "text-slate-500"}`}>
          {BRIEF_LABELS[key]}
        </dt>
        <dd className={`min-w-0 flex-1 ${accent ? "font-semibold text-slate-50" : "text-slate-200"}`}>{value}</dd>
      </div>
    ) : null;
  return (
    <dl
      className={`space-y-1.5 rounded-md border border-cyan-500/20 bg-cyan-500/[0.04] text-[length:var(--hitl-fs-sm,0.875rem)] leading-relaxed ${compact ? "px-2.5 py-2" : "px-3 py-2.5"}`}
      data-human-brief=""
    >
      {row("project", brief.project)}
      {row("situation", brief.situation)}
      {row("problem", brief.problem)}
      {row("ask", brief.options?.length ? `${brief.ask} Options: ${brief.options.join(" / ")}.` : brief.ask, true)}
      {row("recommendation", brief.recommendation)}
      {row("ifIgnored", brief.ifIgnored)}
    </dl>
  );
}

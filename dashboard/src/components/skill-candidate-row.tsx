"use client";

/**
 * One row of the skill review card. A row is one of three things, and says
 * which in its badge:
 *
 *   • a NEW skill: "Add to library" installs it, "Reject" drops it;
 *   • a CHANGE to a live skill (kind "skill-amendment"): applied only after a
 *     passing comparison test, and only after the reviewer opens the current
 *     diff and ticks the box;
 *   • any other proposal (split, retirement, protocol change): read-only
 *     here, with "Reject" as the one action.
 *
 * The card's metadata is a hint written when the card was issued. The row
 * always re-reads `/review`, which is the authority on kind, description,
 * test result and diff.
 */

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { operatorFetch } from "@/lib/local-operator-session";
import { skillHref } from "@/lib/skill-wiki";

export interface SkillCandidateMeta {
  id: string;
  name: string;
  category: string;
  summary: string;
  sourceTitle?: string | null;
  sourceUrl?: string | null;
  kind?: string;
  targetSkill?: string | null;
  evalStatus?: string;
  evalVerdict?: string;
}

type Decision = "approve" | "archive" | "apply-amendment";
export type CandidateState = "deciding" | "approved" | "archived" | "applied";

const AMENDMENT_STATES = ["awaiting", "eligible", "regressed", "no-improvement", "stale"] as const;
type AmendmentState = (typeof AMENDMENT_STATES)[number];

interface Amendment {
  state: AmendmentState;
  targetSkill: string;
  targetName?: string;
  summary: string;
  scored: number;
  total: number;
  targetWins: number;
  targetLosses: number;
  regressions: string[];
  regressionDetails?: { id: string; title: string; reason: string }[];
  diff: string;
  reviewId: string | null;
  /** Set when the last comparison used a model that is no longer allowed. */
  policyIssue?: string;
  /** The verdict that excluded comparison reached. */
  evaluatedState?: string;
}

/** What any candidate says about itself. Every field is optional: an older
 * Praxis answers with the kind alone, and the card's own metadata fills in. */
interface Detail {
  name?: string;
  summary?: string;
  document?: string;
  evalStatus?: string;
  evalVerdict?: string;
  sourceTitle?: string;
  sourceUrl?: string;
  relatedSkills?: string[];
  qaLesson?: { label: string; tasks?: number; windowDays?: number };
  targetSkill?: string;
}

type Review = { kind: string; detail: Detail; amendment?: Amendment };

const text = (value: unknown) => (typeof value === "string" && value.trim() ? value : undefined);
const count = (value: unknown) => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined);

function readDetail(body: Record<string, unknown>): Detail {
  const lesson = body.qaLesson as Record<string, unknown> | null | undefined;
  const label = lesson && typeof lesson === "object" ? text(lesson.label) : undefined;
  return {
    name: text(body.name), summary: text(body.summary), document: text(body.document),
    evalStatus: text(body.evalStatus), evalVerdict: text(body.evalVerdict),
    sourceTitle: text(body.sourceTitle), sourceUrl: text(body.sourceUrl), targetSkill: text(body.targetSkill),
    relatedSkills: Array.isArray(body.relatedSkills) ? body.relatedSkills.filter((s): s is string => !!text(s)) : undefined,
    qaLesson: label ? { label, tasks: count(lesson!.tasks), windowDays: count(lesson!.windowDays) } : undefined,
  };
}

function readReview(body: Record<string, unknown>): Review {
  if (!body || typeof body.kind !== "string" || !body.kind) throw new Error("Praxis did not say what kind of candidate this is.");
  if (body.kind !== "skill-amendment") return { kind: body.kind, detail: readDetail(body) };
  const counts = [body.scored, body.total, body.targetWins, body.targetLosses];
  if (
    typeof body.state !== "string" || !(AMENDMENT_STATES as readonly string[]).includes(body.state) ||
    typeof body.targetSkill !== "string" || !body.targetSkill || typeof body.summary !== "string" ||
    typeof body.diff !== "string" || !(body.reviewId === null || typeof body.reviewId === "string") ||
    !counts.every(n => typeof n === "number" && Number.isSafeInteger(n) && n >= 0) ||
    !Array.isArray(body.regressions) || !body.regressions.every(name => typeof name === "string")
  ) throw new Error("Praxis sent an incomplete review of this change. Press Check again.");
  return {
    kind: body.kind, detail: {},
    amendment: {
      ...(body as unknown as Amendment),
      targetName: text(body.targetName), policyIssue: text(body.policyIssue), evaluatedState: text(body.evaluatedState),
    },
  };
}

/** A file slug reads as a file name. Show it as a title. */
function readable(name: string) {
  if (!/^[a-z0-9]+(?:[-_][a-z0-9]+)+$/.test(name)) return name;
  const words = name.replace(/[-_]+/g, " ");
  return words[0].toUpperCase() + words.slice(1);
}

const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

type Tone = "good" | "wait" | "bad";
const toneStyle: Record<Tone, string> = {
  good: "border-emerald-500/50 text-emerald-300",
  wait: "border-amber-500/50 text-amber-300",
  bad: "border-rose-500/50 text-rose-300",
};

/** The trial a new skill went through before it reached the card, in words. */
function trialResult(status?: string, verdict = ""): { tone: Tone; line: string } {
  if (status !== "passed") {
    const reason = verdict.replace(/^eval unavailable\s*[\u2014\u2013-]\s*/i, "").trim();
    const short = reason.length > 170 ? reason.slice(0, 169).replace(/\s+\S*$/, "") + "…" : reason;
    return { tone: "wait", line: `Not tested${short ? ` (${short})` : ""}. Judge it on its text.` };
  }
  const match = /^beat (incumbent|no-skill baseline) (\d+)\/(\d+), tied (\d+)/.exec(verdict);
  if (!match) return { tone: "good", line: `Passed its trial${verdict ? `: ${verdict}` : ""}.` };
  const [wins, scored, ties] = [Number(match[2]), Number(match[3]), Number(match[4])];
  const against = match[1] === "incumbent" ? "the closest existing skill" : "working with no skill";
  const worse = scored - wins - ties;
  return {
    tone: "good",
    line: `Passed its trial: did better than ${against} on ${wins} of ${plural(scored, "test task")}` +
      `${ties > 0 ? `, tied on ${ties}` : ""}${worse > 0 ? `, did worse on ${worse}` : ""}.`,
  };
}

const VERDICT_WORDS: Record<string, string> = {
  eligible: "it passed",
  regressed: "it made protected tasks worse",
  "no-improvement": "it showed no clear improvement",
  awaiting: "it did not finish",
};

/** Where a proposed change stands, and what the reviewer can do about it. */
function changeStatus(change: Amendment, ready: boolean): { tone: Tone; headline: string; meaning: string } {
  const cannot = "It cannot be applied in this state. Reject it, or leave it here.";
  if (change.state === "stale") return {
    tone: "wait", headline: "Out of date",
    meaning: "The live skill or this proposal changed after it was tested, so the result no longer matches. It has to be tested again before it can be applied.",
  };
  if (change.policyIssue) return {
    tone: "wait", headline: "Needs a new test run",
    meaning: `Its last test used a model that is no longer allowed for testing, so that result does not count` +
      `${change.evaluatedState && VERDICT_WORDS[change.evaluatedState] ? ` (in that run ${VERDICT_WORDS[change.evaluatedState]})` : ""}. ` +
      "It cannot be applied until it is tested again with an approved model. You can read it or reject it.",
  };
  if (change.state === "awaiting" && change.total > 0 && change.scored === change.total) return {
    tone: "wait", headline: "Needs a new test run",
    meaning: "Its last test finished, but Praxis does not accept that result. It has to be tested again before it can be applied.",
  };
  if (change.state === "awaiting") return {
    tone: "wait", headline: change.total > 0 ? "Test still running" : "Not tested yet",
    meaning: change.total > 0
      ? `${change.scored} of ${plural(change.total, "test task")} compared so far. It can be applied once the test finishes and passes.`
      : "Praxis has not compared it against the live skill yet. It can be applied once that test runs and passes.",
  };
  if (change.state === "regressed") return {
    tone: "bad", headline: `Blocked: it made ${plural(change.regressions.length, "protected task")} worse`,
    meaning: `On work the live skill already handles, the proposed text did worse than the current text. ${cannot}`,
  };
  if (change.state === "no-improvement") return {
    tone: "bad", headline: "Blocked: no clear improvement",
    meaning: `In testing, the proposed text did not beat the current text. ${cannot}`,
  };
  if (!ready) return {
    tone: "wait", headline: "Not ready to apply",
    meaning: "Praxis marked it as passing, but the test record is incomplete, so it cannot be applied yet.",
  };
  return {
    tone: "good", headline: "Ready to apply",
    meaning: "It passed its test. To apply it: press See what changes, read the change, tick the box, then press Apply to live skill.",
  };
}

const MANUAL_KINDS: Record<string, { badge: string; means: string }> = {
  "skill-split": { badge: "Proposal: split a skill", means: "Praxis suggests splitting this skill into smaller ones." },
  "skill-retirement": { badge: "Proposal: retire a skill", means: "Praxis suggests removing this skill from the library." },
  "protocol-amendment": { badge: "Proposal: change a protocol", means: "Praxis suggests changing one of its own protocols." },
};

const fs11 = "text-[length:var(--hitl-fs-11,0.6875rem)]";
const fs10 = "text-[length:var(--hitl-fs-10,0.625rem)]";
const badgeStyle = `rounded border px-1.5 py-px font-semibold uppercase tracking-wide ${fs10}`;
const quietButton = "rounded border border-slate-600 px-2 py-0.5 text-slate-200 hover:border-violet-400 disabled:cursor-not-allowed disabled:opacity-50";
const primaryButton = "rounded border border-emerald-500/70 bg-emerald-500/15 px-2 py-0.5 font-semibold text-emerald-200 hover:bg-emerald-500/25 disabled:cursor-not-allowed disabled:opacity-50";
const rejectButton = "rounded border border-slate-600 px-2 py-0.5 text-slate-300 hover:border-rose-400 hover:text-rose-200 disabled:cursor-not-allowed disabled:opacity-50";
const disclosure = "cursor-pointer text-cyan-300 hover:underline";

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return <p className="break-words"><span className="text-slate-500">{label}: </span>{children}</p>;
}

function SkillText({ label, markdown }: { label: string; markdown: string }) {
  return <details>
    <summary className={disclosure}>{label}</summary>
    <div className={`prose prose-invert mt-1 max-h-96 max-w-none overflow-auto rounded border border-slate-700/60 bg-slate-950/70 px-3 py-2
      text-[length:var(--hitl-fs-xs,0.75rem)]! prose-headings:text-slate-100 prose-h1:text-[1.15em] prose-h2:text-[1.05em] prose-h3:text-[1em]
      prose-p:text-slate-300 prose-li:text-slate-300 prose-strong:text-white prose-a:text-cyan-300 prose-code:text-cyan-300`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
        a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a>,
      }}>{markdown}</ReactMarkdown>
    </div>
  </details>;
}

/** Unified diff with removed and added lines coloured. The text is unchanged. */
function DiffView({ diff }: { diff: string }) {
  const lines = diff.split("\n");
  return <pre className={`max-h-96 overflow-auto whitespace-pre-wrap break-words rounded border border-slate-700/60 bg-slate-950 p-2 ${fs11}`}>
    {lines.map((line, index) => {
      const tone = /^(\+\+\+|---|@@)/.test(line) ? "text-slate-500"
        : line.startsWith("+") ? "text-emerald-300" : line.startsWith("-") ? "text-rose-300" : "text-slate-400";
      return <span key={index} className={tone}>{line}{index < lines.length - 1 ? "\n" : ""}</span>;
    })}
  </pre>;
}

export function SkillCandidateRow({ candidate, state, onState }: {
  candidate: SkillCandidateMeta;
  state?: CandidateState;
  onState: (state?: CandidateState) => void;
}) {
  const url = `/api/skill-candidates/${encodeURIComponent(candidate.id)}`;
  const [review, setReview] = useState<Review | null>(null);
  const [generation, setGeneration] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [reviewedId, setReviewedId] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch(url + "/review", { cache: "no-store", signal: controller.signal });
        const body = await response.json();
        if (!response.ok) {
          const detail = body.error || `Praxis could not load this candidate (${response.status}).`;
          const stale = body.state === "stale" || response.status === 409 || response.status === 412;
          throw new Error(stale ? detail + " It is out of date and has to be tested again." : detail);
        }
        const current = readReview(body);
        if (candidate.kind && candidate.kind !== current.kind) {
          throw new Error("This candidate is no longer what this card describes. The next review card will show it correctly.");
        }
        if (!controller.signal.aborted) setReview(current);
      } catch (err) {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "Praxis could not load this candidate.");
      }
    }
    void load();
    return () => controller.abort();
  }, [candidate.kind, url, generation]);

  function reload(openDiff = false) {
    setReview(null);
    setReviewedId(null);
    setError("");
    setExpanded(openDiff);
    setGeneration(n => n + 1);
  }

  const change = review?.amendment;
  const complete = change && change.total > 0 && change.scored === change.total;
  const eligible = complete && change.state === "eligible" && !change.regressions.length &&
    change.targetWins > change.targetLosses && change.diff.trim() && change.reviewId?.trim();
  const canApply = !!eligible && expanded && reviewedId === change?.reviewId;
  const decided = state && state !== "deciding";

  async function decide(decision: Decision) {
    if (!review || state || (decision === "approve" && review.kind !== "new") ||
      (decision === "apply-amendment" && !canApply)) return;
    onState("deciding");
    setError("");
    const applying = decision === "apply-amendment";
    try {
      const request = applying ? operatorFetch : fetch;
      const response = await request(url + "/decide", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(applying ? { decision, reviewId: reviewedId } : { decision }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || (applying && body?.ok !== true)) {
        if (applying && change && (response.status === 409 || response.status === 412 || body?.state === "stale")) {
          setReview({ ...review, amendment: { ...change, state: "stale", reviewId: null } });
        }
        throw new Error(body?.error || `Praxis did not confirm this (${response.status}). Nothing was changed.`);
      }
      onState(applying ? "applied" : decision === "approve" ? "approved" : "archived");
    } catch (err) {
      setError(err instanceof Error ? err.message : "The decision failed. Nothing was changed.");
      onState();
    } finally {
      setReviewedId(null);
      setExpanded(false);
    }
  }

  // The live review wins. The card's own metadata covers the moment before it
  // arrives and a Praxis that answers with the kind alone.
  const detail = review?.detail ?? {};
  const sourceTitle = detail.sourceTitle ?? candidate.sourceTitle ?? undefined;
  const sourceUrl = detail.sourceUrl ?? candidate.sourceUrl ?? undefined;
  const summary = detail.summary ?? (candidate.summary?.trim() || undefined);
  // What to call the row while the review loads comes from the card's hint.
  // What the row may DO comes only from the loaded review (see decide()).
  const kind = review?.kind ?? candidate.kind;
  const isChange = kind === "skill-amendment";
  const isNew = review?.kind === "new";
  const manual = kind && kind !== "new" && !isChange ? MANUAL_KINDS[kind] ?? { badge: `Proposal: ${kind}`, means: "" } : null;
  const target = change?.targetSkill ?? detail.targetSkill ?? candidate.targetSkill ?? undefined;
  const title = isChange ? change?.targetName || readable(target ?? candidate.name)
    : manual && target ? readable(target) : readable(detail.name ?? candidate.name);
  const reason = change ? change.summary || candidate.summary || "" : "";
  const firstParagraph = reason.trim().split(/\n\s*\n/, 1)[0] ?? "";
  const reasonPreview = firstParagraph.length > 280 ? firstParagraph.slice(0, 279).replace(/\s+\S*$/, "") + "…" : firstParagraph;
  const status = change ? changeStatus(change, !!eligible) : null;
  const trial = isNew ? trialResult(detail.evalStatus ?? candidate.evalStatus, detail.evalVerdict ?? candidate.evalVerdict) : null;

  const source = sourceTitle && <Fact label="Drafted from">
    {sourceUrl && /^https?:\/\//i.test(sourceUrl)
      ? <a className="text-cyan-300 underline" href={sourceUrl} target="_blank" rel="noreferrer">{sourceTitle}</a>
      : sourceTitle}
  </Fact>;

  const outcome = state === "approved" ? "Added to the skill library. Agents can use it on matching work."
    : state === "applied" ? "Applied. The live skill now has this text; the previous version is kept in the vault's history."
    : state === "archived" ? "Rejected. It is off the review list; the file is kept in the rejected folder."
    : null;

  return (
    <li className={`space-y-1.5 px-2.5 py-2 ${fs11} text-slate-300`}>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className={`${badgeStyle} ${isChange ? "border-sky-500/50 text-sky-300" : manual ? "border-amber-500/50 text-amber-300" : "border-violet-500/50 text-violet-300"}`}>
          {isChange ? "Change to an existing skill" : manual ? manual.badge : kind === "new" ? "New skill" : "Skill candidate"}
        </span>
        <strong className="break-words text-[length:var(--hitl-fs-xs,0.75rem)] text-slate-100">{title}</strong>
        <span className="rounded-full border border-slate-700 px-1.5 text-slate-400">{candidate.category}</span>
        {change && <Link className={`${fs10} text-cyan-300 underline`} href={skillHref(change.targetSkill)} target="_blank">Open the live skill</Link>}
      </div>

      {outcome && <p role="status" className="font-semibold text-emerald-300">{outcome}</p>}

      {isNew && <>
        {summary
          ? <Fact label="What it does">{summary}</Fact>
          : detail.document
            ? <p className="text-amber-300">It has no one-line description. Read the full skill before deciding.</p>
            : <p className="text-slate-500">No description was sent for this skill.</p>}
        {trial && <p className={`border-l-2 pl-2 ${toneStyle[trial.tone]}`} title={detail.evalVerdict ?? candidate.evalVerdict}>{trial.line}</p>}
        {detail.qaLesson && <Fact label="Drafted from">
          QA reviews{detail.qaLesson.tasks !== undefined && `. ${plural(detail.qaLesson.tasks, "task")} ${detail.qaLesson.tasks === 1 ? "was" : "were"} sent back for “${readable(detail.qaLesson.label).toLowerCase()}”`}
          {detail.qaLesson.tasks !== undefined && detail.qaLesson.windowDays !== undefined && ` in the last ${plural(detail.qaLesson.windowDays, "day")}`}.
        </Fact>}
        {source}
        {detail.relatedSkills && detail.relatedSkills.length > 0 && <Fact label="Closest skills already in the library">
          {detail.relatedSkills.map((name, index) => <span key={name}>{index > 0 && " · "}
            <Link className="text-cyan-300 underline" href={skillHref(name)} target="_blank">{readable(name)}</Link></span>)}
        </Fact>}
        {detail.document && <SkillText label="Read the full skill" markdown={detail.document} />}
      </>}

      {manual && review && <>
        <p className="border-l-2 border-amber-500/50 pl-2 text-amber-200">
          {manual.means} This card cannot carry it out: it has to be done by hand. Reject it here to drop it, or leave it.
        </p>
        {summary && <Fact label="Why">{summary}</Fact>}
        {source}
        {detail.document && <SkillText label="Read the full proposal" markdown={detail.document} />}
      </>}

      {change && status && (
        <div className="space-y-1.5 rounded border border-slate-700/60 bg-slate-900/60 px-2 py-1.5">
          {!decided && <div className={`border-l-2 pl-2 ${toneStyle[status.tone]}`}>
            <p className="font-semibold">{status.headline}</p>
            <p className="text-slate-300">{status.meaning}</p>
            {change.policyIssue && <p className={`${fs10} text-slate-500`}>Praxis says: {change.policyIssue}</p>}
          </div>}

          {reasonPreview && <Fact label="What it changes and why">{reasonPreview}</Fact>}
          {(reason.trim().length > reasonPreview.length || source) && <details>
            <summary className={disclosure}>Read the full explanation</summary>
            <p className="whitespace-pre-wrap break-words py-1">{reason}</p>
            {source}
          </details>}

          {change.total > 0 && <div className="space-y-0.5">
            <p className="text-slate-400">
              {change.policyIssue ? "Earlier test (does not count)" : "Test result"}: {change.scored} of {plural(change.total, "test task")} compared.
              <span className="text-slate-500"> Each task is done twice, once with the live text and once with the proposed text, and another model picks the better result.</span>
            </p>
            <ul className="list-disc space-y-0.5 pl-5">
              <li>Tasks this change is meant to improve: better on {change.targetWins}, worse on {change.targetLosses}.</li>
              <li className={change.regressions.length ? "text-rose-300" : ""}>
                Tasks it must not make worse: {change.regressions.length ? `worse on ${change.regressions.length}.` : "none got worse."}
                {change.regressions.length > 0 && <ul className="pl-1">
                  {change.regressions.map(id => {
                    const found = Array.isArray(change.regressionDetails) && change.regressionDetails.find(item =>
                      item?.id === id && typeof item.title === "string" && item.title && typeof item.reason === "string");
                    return <li key={id} className="break-words">
                      {found ? <details>
                        <summary className="cursor-pointer">{found.title}</summary>
                        <p className="whitespace-pre-wrap pl-3 text-slate-300">{found.reason}</p>
                        <p className={`pl-3 ${fs10} text-slate-500`}>The judge saw the two results as A and B. The one it preferred here used the live skill text.</p>
                      </details> : id}
                    </li>;
                  })}
                </ul>}
              </li>
            </ul>
          </div>}

          {expanded && change.diff && <>
            <p className="text-slate-400">Red lines are removed from the live skill. Green lines are added.</p>
            <DiffView diff={change.diff} />
          </>}
          {expanded && eligible && <label className="flex items-center gap-2 text-slate-100">
            <input type="checkbox" disabled={!!state} checked={reviewedId === change.reviewId}
              onChange={event => setReviewedId(event.target.checked ? change.reviewId : null)} />
            I have read this change
          </label>}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {state === "deciding" && <span role="status">Saving…</span>}
        {!decided && isNew && <button type="button" className={primaryButton} disabled={!!state}
          title="Puts this skill in the live library, where agents pick it up for matching work" onClick={() => void decide("approve")}>
          Add to library
        </button>}
        {!decided && change?.diff && <button type="button" className={quietButton} aria-expanded={expanded} disabled={!!state}
          title="Shows exactly which lines of the live skill would change. Nothing is applied by looking."
          onClick={() => { if (expanded) { setExpanded(false); setReviewedId(null); } else reload(true); }}>
          {expanded ? "Hide changes" : "See what changes"}
        </button>}
        {!decided && canApply && <button type="button" className={primaryButton} disabled={!!state}
          title="Replaces the live skill's text with the proposed text" onClick={() => void decide("apply-amendment")}>
          Apply to live skill
        </button>}
        {!decided && review && <button type="button" className={rejectButton} disabled={!!state}
          title="Takes it off the review list. The file is kept in the rejected folder." onClick={() => void decide("archive")}>
          {change ? "Reject change" : "Reject"}
        </button>}
        {!state && (!review || change) && <button type="button" className={`${fs10} text-slate-400 underline hover:text-slate-200`}
          title="Asks Praxis again for the current status and test result" onClick={() => reload()}>Check again</button>}
        {!review && !error && <span role="status">Loading…</span>}
      </div>
      {error && <p role="alert" className="text-rose-300">{error}</p>}
    </li>
  );
}

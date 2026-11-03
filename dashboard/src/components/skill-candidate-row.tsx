"use client";

import { useEffect, useState } from "react";
import { operatorFetch } from "@/lib/local-operator-session";

export interface SkillCandidateMeta {
  id: string;
  name: string;
  category: string;
  summary: string;
  sourceTitle?: string | null;
  sourceUrl?: string | null;
  kind?: string;
}

type Decision = "approve" | "archive" | "apply-amendment";
export type CandidateState = "deciding" | "approved" | "archived" | "applied";

const outcomes = {
  awaiting: "Awaiting evaluation",
  eligible: "Eligible to apply",
  regressed: "Regression detected",
  "no-improvement": "No improvement",
  stale: "Stale review. Re-evaluate the amendment, then reload the review.",
};

interface Amendment {
  state: keyof typeof outcomes;
  targetSkill: string;
  summary: string;
  scored: number;
  total: number;
  targetWins: number;
  targetLosses: number;
  regressions: string[];
  regressionDetails?: { id: string; title: string; reason: string }[];
  diff: string;
  reviewId: string | null;
}

type Review = { kind: string; amendment?: Amendment };

function readReview(body: Record<string, unknown>): Review {
  if (!body || typeof body.kind !== "string" || !body.kind) throw new Error("Candidate kind is unavailable.");
  if (body.kind !== "skill-amendment") return { kind: body.kind };
  const counts = [body.scored, body.total, body.targetWins, body.targetLosses];
  if (
    typeof body.state !== "string" || !Object.hasOwn(outcomes, body.state) ||
    typeof body.targetSkill !== "string" || !body.targetSkill || typeof body.summary !== "string" ||
    typeof body.diff !== "string" || !(body.reviewId === null || typeof body.reviewId === "string") ||
    !counts.every(n => typeof n === "number" && Number.isSafeInteger(n) && n >= 0) ||
    !Array.isArray(body.regressions) || !body.regressions.every(name => typeof name === "string")
  ) throw new Error("Amendment review is incomplete. Reload the review.");
  return { kind: body.kind, amendment: body as unknown as Amendment };
}

const actionStyle = "rounded border border-slate-600 px-2 py-0.5 text-slate-200 hover:border-violet-400 disabled:opacity-50";

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
          const detail = body.error || `Review lookup failed (${response.status}).`;
          const stale = body.state === "stale" || response.status === 409 || response.status === 412;
          throw new Error(stale ? detail + " " + outcomes.stale : detail);
        }
        const current = readReview(body);
        if (candidate.kind && candidate.kind !== current.kind) {
          throw new Error("Candidate kind has changed. Reopen the current candidate.");
        }
        if (!controller.signal.aborted) setReview(current);
      } catch (err) {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "Review lookup failed.");
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

  const amendment = review?.amendment;
  const complete = amendment && amendment.total > 0 && amendment.scored === amendment.total;
  const eligible = complete && amendment.state === "eligible" && !amendment.regressions.length &&
    amendment.targetWins > amendment.targetLosses && amendment.diff.trim() && amendment.reviewId?.trim();
  const canApply = !!eligible && expanded && reviewedId === amendment?.reviewId;
  const decided = state && state !== "deciding";
  const changeSummary = amendment?.summary || candidate.summary;

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
        if (applying && amendment && (response.status === 409 || response.status === 412 || body?.state === "stale")) {
          setReview({ kind: review.kind, amendment: { ...amendment, state: "stale", reviewId: null } });
        }
        throw new Error(body?.error || `Candidate decision was not confirmed (${response.status}).`);
      }
      onState(applying ? "applied" : decision === "approve" ? "approved" : "archived");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Candidate decision failed.");
      onState();
    } finally {
      setReviewedId(null);
      setExpanded(false);
    }
  }

  const source = candidate.sourceTitle && <p className="truncate text-slate-400">From {candidate.sourceUrl
    ? <a className="underline" href={candidate.sourceUrl} target="_blank" rel="noreferrer">{candidate.sourceTitle}</a>
    : candidate.sourceTitle}</p>;

  return (
    <li className="space-y-1 px-2 py-1.5 text-[length:var(--hitl-fs-11,0.6875rem)] text-slate-300">
      <div className="flex flex-wrap items-center gap-1.5">
        <strong className="break-words text-[length:var(--hitl-fs-xs,0.75rem)] text-slate-100">
          {amendment ? `Amends ${amendment.targetSkill}` : candidate.name}
        </strong>
        {amendment && <span className="font-semibold text-violet-300">{state === "applied"
          ? "Amendment applied" : state === "archived" ? "Archived" : outcomes[amendment.state]}</span>}
        <span className="rounded-full border border-slate-700 px-1.5 text-slate-400">{candidate.category}</span>
      </div>
      {review && !amendment && review.kind !== "new" && <p className="text-amber-300">Manual review · {review.kind}</p>}
      {review && !amendment && <p>{candidate.summary}</p>}
      {!amendment && source}
      {amendment && (
        <div className="space-y-1 rounded border-l-2 border-violet-500/60 bg-slate-900/60 px-2 py-1">
          <p>{amendment.scored}/{amendment.total} scored · {amendment.targetWins} target {amendment.targetWins === 1 ? "win" : "wins"} · {amendment.targetLosses} target {amendment.targetLosses === 1 ? "loss" : "losses"}</p>
          {amendment.regressions.length > 0 && (
            <div className="text-rose-300">
              <p>Regressions</p>
              <ul className="pl-2">
                {amendment.regressions.map(id => {
                  const detail = Array.isArray(amendment.regressionDetails) && amendment.regressionDetails.find(item =>
                    item?.id === id && typeof item.title === "string" && item.title && typeof item.reason === "string");
                  return <li key={id} className="break-words">
                    {detail ? <details>
                      <summary className="cursor-pointer">{detail.title}</summary>
                      <p className="whitespace-pre-wrap pl-3 text-slate-300">{detail.reason}</p>
                    </details> : id}
                  </li>;
                })}
              </ul>
            </div>
          )}
          {(changeSummary || source) && <details>
            <summary className="cursor-pointer text-slate-200">Change summary</summary>
            <p className="whitespace-pre-wrap break-words py-1">{changeSummary}</p>
            {source}
          </details>}
          {!decided && amendment.diff && <button type="button" className={actionStyle} aria-expanded={expanded} disabled={!!state}
            onClick={() => { if (expanded) { setExpanded(false); setReviewedId(null); } else reload(true); }}>
            {expanded ? "Hide diff" : "Review diff"}
          </button>}
          {expanded && amendment.diff && <pre className="max-h-72 overflow-auto rounded bg-slate-950 p-2">{amendment.diff}</pre>}
          {expanded && eligible && <label className="flex items-center gap-2">
            <input type="checkbox" disabled={!!state} checked={reviewedId === amendment.reviewId}
              onChange={event => setReviewedId(event.target.checked ? amendment.reviewId : null)} />
            I reviewed this diff
          </label>}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {state === "deciding" && <span role="status">Saving decision…</span>}
        {review?.kind === "new" && <button type="button" className={actionStyle} disabled={!!state}
          title="Install this new skill in the live library" onClick={() => void decide("approve")}>
          {state === "approved" ? "Approved" : "Approve"}
        </button>}
        {canApply && <button type="button" className={actionStyle} disabled={!!state} onClick={() => void decide("apply-amendment")}>Apply amendment</button>}
        {review && <button type="button" className={actionStyle} disabled={!!state} onClick={() => void decide("archive")}>
          {state === "archived" ? "Archived" : "Archive"}
        </button>}
        {!state && (!review || amendment) && <button type="button" className={actionStyle} onClick={() => reload()}>Reload review</button>}
        {!review && !error && <span role="status">Loading candidate review…</span>}
      </div>
      {error && <p role="alert" className="text-rose-300">{error}</p>}
    </li>
  );
}

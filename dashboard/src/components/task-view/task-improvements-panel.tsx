import type { ProgressSource, TaskProgressRecord, TaskImprovement } from '@/lib/task-progress';

const labels: Record<TaskImprovement['status'], string> = { proposed: 'Proposed — awaiting approval', retained: 'Retained — pending evidence or dependency', completed_after_review: 'Completed after review', linked: 'Tracked in follow-up task', review_held: 'Awaiting relevance review', waiting: 'Waiting — not started', running: 'Running', reviewing: 'Reviewing', verified: 'Verified', declined: 'Declined', needs_attention: 'Needs attention', unknown: 'Unknown' };
const colors: Record<TaskImprovement['status'], string> = { proposed: 'text-cyan-200', retained: 'text-amber-200', completed_after_review: 'text-slate-300', linked: 'text-cyan-200', review_held: 'text-amber-200', waiting: 'text-amber-200', running: 'text-cyan-200', reviewing: 'text-violet-200', verified: 'text-emerald-200', declined: 'text-slate-300', needs_attention: 'text-amber-200', unknown: 'text-slate-300' };
const stamp = (value: string | null) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : 'Timestamp unavailable';
/** The same words with different spacing are the same paragraph. */
const paragraphKey = (text: string) => text.replace(/\s+/g, ' ').trim();
/** Paragraphs are the blocks a blank line separates, as in Markdown. */
const paragraphsOf = (text: string) => text.split(/\n\s*\n/).map(paragraph => paragraph.replace(/^\n+|\s+$/g, '')).filter(paragraph => paragraphKey(paragraph));
/** Part of a recorded field: text shown here, or where a repeated paragraph first appeared. */
type Piece = { text: string } | { earlier: string };
/** The text a field shows, paragraphs joined by a blank line; undefined when every one appeared earlier. */
const shown = (pieces: Piece[]) => {
  const texts = pieces.flatMap(piece => 'text' in piece ? [piece.text] : []);
  return texts.length ? texts.join('\n\n') : undefined;
};

export function TaskImprovementsPanel({ source, now }: { source: ProgressSource<TaskProgressRecord>; now: number }) {
  const improvements = source.data?.improvements;
  const stale = source.data !== null && (source.at === null || now - source.at >= 60_000 || Boolean(source.error));
  const items = improvements?.items ?? [];
  return <section id="qa-improvements" aria-label="QA improvements" className="mt-5 rounded-lg border border-slate-700 bg-slate-950/25 p-4">
    <h4 className="text-sm font-semibold text-slate-100">QA improvements</h4>
    {stale && <p className="mt-2 text-xs text-amber-200" role="status">Stale snapshot — last recorded statuses are retained; current improvement activity cannot be confirmed.</p>}
    {!improvements?.available && <p className="mt-2 text-xs text-amber-200">Improvement records are unavailable or incomplete. No completion is inferred.</p>}
    {improvements?.available && items.length === 0 && <p className="mt-3 text-sm text-slate-400">No QA improvement suggestions are recorded in this snapshot.</p>}
    <div className="mt-3 space-y-3">{items.map(item => <ImprovementCard key={item.id} item={item} stale={stale} />)}</div>
  </section>;
}

/**
 * One improvement, with each recorded paragraph shown once. A follow-up review
 * copies its reason into the item reason and often into its only decision, two
 * reviewers can file the same suggestion, and one suggestion can repeat a
 * paragraph of another or of itself. A later copy of a paragraph is left out of
 * the visible prose; inside a disclosure it names where the text already
 * appears. The rest of that field, every suggestion, source, decision and link
 * stays.
 */
function ImprovementCard({ item, stale }: { item: TaskImprovement; stale: boolean }) {
  const firstPlace = new Map<string, { where: string; field: number }>();
  let fields = 0;
  // Called in render order, so the first copy of a paragraph is the one shown.
  const place = (text: string | undefined, where: string): Piece[] => {
    const field = ++fields;
    if (!text || !paragraphKey(text)) return [];
    let repeated = false;
    const pieces = paragraphsOf(text).map((paragraph): Piece => {
      const key = paragraphKey(paragraph);
      const first = firstPlace.get(key);
      if (!first) { firstPlace.set(key, { where, field }); return { text: paragraph }; }
      repeated = true;
      return { earlier: first.field === field ? 'above' : first.where };
    });
    // A field with no repeated paragraph renders exactly as recorded.
    return repeated ? pieces : [{ text }];
  };
  const reason = shown(place(item.reason, 'above'));
  const followup = item.followupReview;
  const followupReason = shown(place(followup?.reason, 'above'));
  const decisionReasons = followup?.decisions.map(decision => shown(place(decision.reason, 'above'))) ?? [];
  const suggestions = item.suggestions.map((suggestion, index) => place(suggestion.text, `suggestion ${index + 1}`));
  const notes = place(item.review?.notes, 'above');
  const evidence = place(item.review?.evidence, 'above');
  return <article className="rounded-md border border-slate-800 p-3">
    <div className="flex flex-wrap items-center gap-2"><span className={`text-sm font-medium ${stale ? 'text-slate-300' : colors[item.status] ?? colors.unknown}`}>{stale ? 'Last recorded status: ' : ''}{labels[item.status] ?? labels.unknown}</span><span className="text-xs text-slate-500">· Updated <time dateTime={item.updatedAt ?? undefined}>{stamp(item.updatedAt)}</time></span></div>
    {item.optionalTaskId && <a className="mt-3 inline-block rounded-md border border-cyan-800 px-3 py-2 text-sm font-medium text-cyan-200 hover:underline" href={`/task/${encodeURIComponent(item.optionalTaskId)}`}>Tracked in follow-up task →</a>}
    {reason && <p className="mt-2 whitespace-pre-wrap break-words text-sm text-slate-300">{reason}</p>}
    {followup && <div className="mt-2 text-sm text-slate-300">
      {followup.priority && <p>Priority {followup.priority}</p>}
      {followupReason && <p>{followupReason}</p>}
      {item.status === 'completed_after_review' && <p>No implementation or independent QA completion is implied.</p>}
      <ul className="mt-2 space-y-2">{followup.decisions.map((decision, index) => <li key={decision.index}>Finding {decision.index + 1} · {({execute: 'Proposed execution', retain: 'Retained', complete: 'Completed after review'})[decision.disposition]}{decisionReasons[index] && <p>{decisionReasons[index]}</p>}{decision.evidence.map((line, lineIndex) => <p key={lineIndex} className="whitespace-pre-wrap break-words text-xs text-slate-400">{line}</p>)}</li>)}</ul>
    </div>}
    {item.status === 'waiting' && <p className="mt-2 text-xs text-slate-400">These findings await review after thirty continuous idle minutes. Proposed execution requires approval. <a className="text-cyan-300 hover:underline" href="/calendar">View the schedule and task details</a>.</p>}
    <p className="mt-2 text-xs text-slate-500">Author: {item.author}</p>
    <details className="mt-3"><summary className="cursor-pointer text-xs text-cyan-300">Full improvement suggestions ({item.suggestions.length})</summary><ol className="mt-2 list-decimal space-y-3 pl-5 text-sm text-slate-300">{item.suggestions.map((suggestion, index) => <li key={index}><p className="text-xs text-slate-500">{suggestion.source || 'Source not recorded'}</p><Paragraphs pieces={suggestions[index]} className="mt-1 whitespace-pre-wrap break-words" /></li>)}</ol></details>
    {item.review && <details className="mt-3"><summary className="cursor-pointer text-xs text-cyan-300">Improvement QA: {item.review.assessment} · {item.review.reviewer || 'Reviewer unavailable'}</summary><Paragraphs pieces={notes} className="mt-2 whitespace-pre-wrap break-words text-sm text-slate-300" /><p className="mt-2 text-xs font-medium text-slate-400">Review evidence</p>{evidence.length ? <Paragraphs pieces={evidence} className="mt-1 whitespace-pre-wrap break-words text-sm text-slate-300" /> : <p className="mt-1 whitespace-pre-wrap break-words text-sm text-slate-300">No review evidence recorded.</p>}</details>}
    {item.commitSha && <p className="mt-2 break-all text-xs text-slate-500">Commit: <code>{item.commitSha}</code></p>}
    {item.dispatchId && <a className="mt-3 inline-block text-xs text-cyan-300 hover:underline" href={`#dispatch-${encodeURIComponent(item.dispatchId)}`}>Open improvement dispatch details</a>}
  </article>;
}

/** Shown paragraphs run together in one block; a repeat names where its text first appeared, once per run. */
function Paragraphs({ pieces, className }: { pieces: Piece[]; className: string }) {
  const runs: Piece[] = [];
  for (const piece of pieces) {
    const last = runs[runs.length - 1];
    if ('text' in piece && last && 'text' in last) runs[runs.length - 1] = { text: `${last.text}\n\n${piece.text}` };
    else if (!('earlier' in piece && last && 'earlier' in last && last.earlier === piece.earlier)) runs.push(piece);
  }
  return <>{runs.map((run, index) => 'text' in run ? <p key={index} className={className}>{run.text}</p> : <p key={index} className="mt-1 text-xs text-slate-500">Same text as {run.earlier}.</p>)}</>;
}

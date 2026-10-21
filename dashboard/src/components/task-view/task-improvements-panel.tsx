import type { ProgressSource, TaskProgressRecord, TaskImprovement } from '@/lib/task-progress';

const labels: Record<TaskImprovement['status'], string> = { proposed: 'Proposed — awaiting approval', retained: 'Retained — pending evidence or dependency', completed_after_review: 'Completed after review', linked: 'Tracked in follow-up task', review_held: 'Awaiting relevance review', waiting: 'Waiting — not started', running: 'Running', reviewing: 'Reviewing', verified: 'Verified', declined: 'Declined', needs_attention: 'Needs attention', unknown: 'Unknown' };
const colors: Record<TaskImprovement['status'], string> = { proposed: 'text-cyan-200', retained: 'text-amber-200', completed_after_review: 'text-slate-300', linked: 'text-cyan-200', review_held: 'text-amber-200', waiting: 'text-amber-200', running: 'text-cyan-200', reviewing: 'text-violet-200', verified: 'text-emerald-200', declined: 'text-slate-300', needs_attention: 'text-amber-200', unknown: 'text-slate-300' };
const stamp = (value: string | null) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : 'Timestamp unavailable';

export function TaskImprovementsPanel({ source, now }: { source: ProgressSource<TaskProgressRecord>; now: number }) {
  const improvements = source.data?.improvements;
  const stale = source.data !== null && (source.at === null || now - source.at >= 60_000 || Boolean(source.error));
  const items = improvements?.items ?? [];
  return <section id="qa-improvements" aria-label="QA improvements" className="mt-5 rounded-lg border border-slate-700 bg-slate-950/25 p-4">
    <h4 className="text-sm font-semibold text-slate-100">QA improvements</h4>
    <p className="mt-1 text-xs text-slate-400">Optional suggestions have their own execution and independent review. Parent task QA does not verify these improvements.</p>
    {stale && <p className="mt-2 text-xs text-amber-200" role="status">Stale snapshot — last recorded statuses are retained; current improvement activity cannot be confirmed.</p>}
    {!improvements?.available && <p className="mt-2 text-xs text-amber-200">Improvement records are unavailable or incomplete. No completion is inferred.</p>}
    {improvements?.available && items.length === 0 && <p className="mt-3 text-sm text-slate-400">No QA improvement suggestions are recorded in this snapshot.</p>}
    <div className="mt-3 space-y-3">{items.map(item => <article key={item.id} className="rounded-md border border-slate-800 p-3">
      <div className="flex flex-wrap items-center gap-2"><span className={`text-sm font-medium ${stale ? 'text-slate-300' : colors[item.status] ?? colors.unknown}`}>{stale ? 'Last recorded status: ' : ''}{labels[item.status] ?? labels.unknown}</span><span className="text-xs text-slate-500">· Updated <time dateTime={item.updatedAt ?? undefined}>{stamp(item.updatedAt)}</time></span></div>
      {item.optionalTaskId && <a className="mt-3 inline-block rounded-md border border-cyan-800 px-3 py-2 text-sm font-medium text-cyan-200 hover:underline" href={`/task/${encodeURIComponent(item.optionalTaskId)}`}>Tracked in follow-up task →</a>}
      <p className="mt-2 whitespace-pre-wrap break-words text-sm text-slate-300">{item.reason}</p>
      {item.followupReview && <div className="mt-2 text-sm text-slate-300">
        {item.followupReview.priority && <p>Priority {item.followupReview.priority}</p>}
        <p>{item.followupReview.reason}</p>
        {item.status === 'completed_after_review' && <p>No implementation or independent QA completion is implied.</p>}
        <ul className="mt-2 space-y-2">{item.followupReview.decisions.map(decision => <li key={decision.index}>Finding {decision.index + 1} · {({execute: 'Proposed execution', retain: 'Retained', complete: 'Completed after review'})[decision.disposition]}<p>{decision.reason}</p>{decision.evidence.map((evidence, index) => <p key={index} className="whitespace-pre-wrap break-words text-xs text-slate-400">{evidence}</p>)}</li>)}</ul>
      </div>}
      {item.status === 'waiting' && <p className="mt-2 text-xs text-slate-400">These findings await review after thirty continuous idle minutes. Proposed execution requires approval. <a className="text-cyan-300 hover:underline" href="/calendar">View the schedule and task details</a>.</p>}
      <p className="mt-2 text-xs text-slate-500">Author: {item.author}</p>
      <details className="mt-3"><summary className="cursor-pointer text-xs text-cyan-300">Full improvement suggestions ({item.suggestions.length})</summary><ol className="mt-2 list-decimal space-y-3 pl-5 text-sm text-slate-300">{item.suggestions.map((suggestion, index) => <li key={index}><p className="text-xs text-slate-500">{suggestion.source || 'Source not recorded'}</p><p className="mt-1 whitespace-pre-wrap break-words">{suggestion.text}</p></li>)}</ol></details>
      {item.review && <details className="mt-3"><summary className="cursor-pointer text-xs text-cyan-300">Improvement QA: {item.review.assessment} · {item.review.reviewer || 'Reviewer unavailable'}</summary><p className="mt-2 whitespace-pre-wrap break-words text-sm text-slate-300">{item.review.notes}</p><p className="mt-2 text-xs font-medium text-slate-400">Review evidence</p><p className="mt-1 whitespace-pre-wrap break-words text-sm text-slate-300">{item.review.evidence || 'No review evidence recorded.'}</p></details>}
      {item.commitSha && <p className="mt-2 break-all text-xs text-slate-500">Commit: <code>{item.commitSha}</code></p>}
      {item.dispatchId && <a className="mt-3 inline-block text-xs text-cyan-300 hover:underline" href={`#dispatch-${encodeURIComponent(item.dispatchId)}`}>Open improvement dispatch details</a>}
    </article>)}</div>
  </section>;
}

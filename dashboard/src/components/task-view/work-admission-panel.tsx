import type { WorkAdmissionReceipt } from '@/lib/nexus/tasks';

const decisions: Record<string, string> = {
  needs_evidence: 'Possible overlap',
  partial_overlap: 'Partial overlap recorded',
  covered_by_open: 'Covered by open work',
  already_delivered: 'Already delivered',
};

export function WorkAdmissionPanel({ receipt }: { receipt: WorkAdmissionReceipt }) {
  const checkedAt = typeof receipt.checked_at === 'string' && Number.isFinite(Date.parse(receipt.checked_at)) ? receipt.checked_at : null;
  const matches = Array.isArray(receipt.matches) ? receipt.matches.filter((match): match is { task_id: string; title?: string } => !!match && typeof match === 'object' && typeof match.task_id === 'string' && !!match.task_id) : [];
  return <section id="work-admission" aria-label="Work admission" data-work-admission className="mt-4 rounded-lg border border-slate-700 bg-slate-800/40 p-4">
    <h4 className="text-sm font-medium text-slate-200">Scope overlap warning · {decisions[receipt.decision] || receipt.decision}</h4>
    <p className="mt-2 whitespace-pre-wrap break-words text-sm text-slate-300">{receipt.reason || 'Possible duplicate or overlapping work was identified; no comparison detail was recorded.'}</p>
    <p className="mt-2 text-sm text-slate-400">This overlap check is advisory. It does not block starting or continuing work. The execution status above reflects the runtime.</p>
    {receipt.decision === 'partial_overlap' && <p className="mt-2 text-sm text-slate-400">Partial overlap is recorded. Compare the remaining scope with the linked work when carrying out this task.</p>}
    <p className="mt-2 text-xs text-slate-500">{checkedAt ? <>Last checked <time dateTime={checkedAt}>{new Date(checkedAt).toLocaleString()}</time></> : 'Check timestamp unavailable'}</p>
    {matches.length > 0 && <div className="mt-3 text-sm"><p className="text-slate-400">Compared tasks</p><ul className="mt-1 space-y-1">{matches.map((match, index) => <li key={`${match.task_id}-${index}`}><a className="break-words text-cyan-300 hover:underline" href={`/task/${encodeURIComponent(match.task_id)}`}>{typeof match.title === 'string' && match.title ? match.title : match.task_id}</a></li>)}</ul></div>}
  </section>;
}

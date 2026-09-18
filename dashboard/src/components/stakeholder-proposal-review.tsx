"use client";
import { useState } from 'react';
import { decideReservedStakeholderProposal, type ReservedStakeholderProposal } from '@/lib/nexus/stakeholders';

const labels: Record<string, string> = {
  proposed: 'Proposed — awaiting Robert', approved: 'Approved — not issued or applied',
  issued: 'Invitation issued — acceptance unknown', accepted: 'Participation accepted',
  applied: 'Scope application recorded', rejected: 'Rejected — cannot execute',
  cancelled: 'Cancelled — cannot execute', duplicate: 'Duplicate — cannot execute',
  deferred: 'Changes requested — cannot execute', invalidated: 'Changed — new revision and approval required',
};
export function StakeholderProposalReview({ name, proposal, onDecided }: {
  name: string; proposal: ReservedStakeholderProposal; onDecided: () => void;
}) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canDecide = ['proposed', 'deferred', 'approved'].includes(proposal.state);
  async function decide(decision: 'approve' | 'reject' | 'defer') {
    setBusy(true); setError(null);
    try {
      await decideReservedStakeholderProposal(proposal, decision, key);
      setKey(''); onDecided();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Decision failed');
    } finally { setBusy(false); }
  }
  return <section className="space-y-2 rounded-lg border border-amber-500/30 bg-slate-900/40 p-3 text-xs text-slate-300">
    <h3 className="font-semibold text-slate-100">{name}</h3>
    <p className="font-semibold text-amber-300">{labels[proposal.state] || proposal.state}</p>
    <p>{proposal.kind === 'invitation' ? 'Invitation' : 'Project scope change'} · Revision {proposal.revision}</p>
    <p className="break-all">Project: {proposal.project_id} · Member: {proposal.member_id || 'Not member-specific'}</p>
    {proposal.member && <p>{proposal.member.name} · {proposal.member.email || 'No email recorded'}</p>}
    <p className="break-all font-mono">Content hash: {proposal.content_hash}</p>
    <pre className="whitespace-pre-wrap break-words rounded bg-slate-950 p-2">{JSON.stringify(proposal.content, null, 2)}</pre>
    <details><summary>Project scope at proposal time</summary><pre className="whitespace-pre-wrap break-words">{JSON.stringify(proposal.project_snapshot, null, 2)}</pre></details>
    <p>Approval authorizes only this revision. Issuance, scope application and member acceptance require separate evidence.</p>
    {canDecide && <div className="space-y-2">
      <label className="block">Robert’s operator approval credential
        <input aria-label="Robert’s operator approval credential" type="password" autoComplete="off" value={key}
          onChange={event => setKey(event.target.value)} className="hud-input mt-1" />
      </label>
      <div className="flex flex-wrap gap-2">
        {(['approve', 'defer', 'reject'] as const).map(decision => <button key={decision} disabled={busy || !key}
          className="rounded border border-slate-600 px-2 py-1 disabled:opacity-50" onClick={() => void decide(decision)}>
          {decision === 'approve' ? 'Robert: approve revision' : decision === 'defer' ? 'Request changes' : 'Reject revision'}
        </button>)}
      </div>
    </div>}
    {error && <p role="alert" className="text-amber-300">{error}</p>}
    <details><summary>Revision, decision and execution history</summary>
      <pre className="whitespace-pre-wrap break-words">{JSON.stringify({ revisions: proposal.revisions, history: proposal.history }, null, 2)}</pre>
    </details>
  </section>;
}

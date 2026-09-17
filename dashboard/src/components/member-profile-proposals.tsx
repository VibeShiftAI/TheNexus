"use client";
import { useCallback, useEffect, useRef, useState } from 'react';
import { getMemberProfileProposals, reviewMemberProfileProposal, ProfileReviewError, type MemberProfileProposal, type MemberProfilePage, type ProfileStatus } from '@/lib/nexus/member-profile-proposals';

const buttonClass = 'rounded border border-slate-500/30 px-2 py-1 text-xs hover:bg-slate-500/10 disabled:opacity-40';
const categories = { preference: 'Preference', goal: 'Goal', expertise: 'Expertise claim', commitment: 'Member commitment' };
const reasons: Record<string, string> = { needs_review: 'Check the wording and context before adding this to memory.', existing_memory: 'There is existing profile history. Acceptance adds an account; use memory corrections to resolve differences.', operator_relay: 'Relayed by an operator; this remains unconfirmed evidence.', unknown_origin: 'The original speaker is not verified.', explicit_preference: 'Added automatically from a complete, explicit member preference.' };

export function MemberProfileProposals({ memberId, projectId, onRefreshMemory }: { memberId: string; projectId: string | null; onRefreshMemory: () => Promise<boolean | void> }) {
  const [status, setStatus] = useState<ProfileStatus>('pending');
  const [page, setPage] = useState<MemberProfilePage | null>(null);
  const [loading, setLoading] = useState(false), [saving, setSaving] = useState(false), [stale, setStale] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const generation = useRef(0), mounted = useRef(true);
  const currentPage = useRef<MemberProfilePage | null>(null);
  const refresh = useCallback(async (before?: number) => {
    const current = ++generation.current; setLoading(true); setError('');
    try {
      const next = await getMemberProfileProposals(memberId, projectId, status, before);
      if (!mounted.current || current !== generation.current) return;
      const previous = currentPage.current;
      if (before && previous && previous.memory_version !== next.memory_version) throw new ProfileReviewError('Memory changed while loading more proposals.', 409);
      if (!before && await onRefreshMemory() === false) throw new Error('Could not refresh current memory. Review remains paused.');
      if (!mounted.current || current !== generation.current) return;
      const merged = before && previous ? { ...next, proposals: [...previous.proposals, ...next.proposals.filter(p => !previous.proposals.some(old => old.id === p.id))] } : next;
      currentPage.current = merged; setPage(merged);
      // Every accepted write rechecks this version transactionally. A fresh page is a fresh review.
      setStale(false);
    } catch (err) {
      if (!mounted.current || current !== generation.current) return;
      setError(err instanceof Error ? err.message : 'Could not load proposals.'); setStale(true);
      if (!before) { currentPage.current = null; setPage(null); }
    } finally { if (mounted.current && current === generation.current) setLoading(false); }
  }, [memberId, projectId, status, onRefreshMemory]);
  useEffect(() => { mounted.current = true; currentPage.current = null; setPage(null); setNotice(''); void refresh(); return () => { mounted.current = false; generation.current++; }; }, [refresh]);
  async function review(p: MemberProfileProposal, decision: 'accept' | 'dismiss') {
    if (!page || saving || stale) return;
    setSaving(true); setError(''); setNotice('');
    try {
      await reviewMemberProfileProposal(memberId, p, decision, page.memory_version);
      if (!mounted.current) return;
      setNotice(decision === 'accept' ? 'Added to memory with its source and evidence label.' : 'Dismissed. The original source stays in history.');
      await refresh();
    } catch (err) {
      if (!mounted.current) return;
      setError(err instanceof Error ? err.message : 'Could not review this update.');
      if (err instanceof ProfileReviewError && err.status === 409) setStale(true);
    } finally { if (mounted.current) setSaving(false); }
  }
  return <section aria-label="Proposed profile updates" className="space-y-2 rounded border border-slate-500/25 p-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h4 className="text-xs font-semibold">Profile updates{page ? ` · ${page.total}` : ''}</h4>
      <select aria-label="Profile update status" className="hud-input max-w-40 text-xs" value={status} disabled={saving} onChange={e => setStatus(e.target.value as ProfileStatus)}>
        <option value="pending">Proposed</option><option value="applied">Added to memory</option><option value="dismissed">Dismissed</option>
      </select>
    </div>
    <p className="text-[11px] text-slate-500">Review what the member said before adding it to their profile. Expertise stays a claim, and commitments do not schedule action.</p>
    <button type="button" className={buttonClass} disabled={saving || loading} onClick={() => void refresh()}>Refresh proposals</button>
    {loading && <p className="text-xs text-slate-500">Loading proposals…</p>}
    {error && <p role="alert" className="break-words text-xs text-red-500">{error}{stale && ' Refresh proposals and review the evidence again.'}</p>}
    {notice && <p role="status" className="text-xs text-emerald-500">{notice}</p>}
    {page?.proposals.length === 0 && <p className="text-xs text-slate-500">{status === 'pending' ? 'No proposed updates in this scope yet.' : 'No updates in this view.'}</p>}
    <ul className="space-y-3">{page?.proposals.map(p => <li key={p.id} className="space-y-2 border-t border-slate-500/20 pt-3">
      <p className="text-xs font-medium">{categories[p.category]} · {p.source_origin === 'member_reply' ? 'Member stated' : 'Unconfirmed account'}</p>
      <blockquote className="whitespace-pre-wrap break-words border-l-2 border-slate-500/40 pl-2 text-xs">{p.quote}</blockquote>
      <p className="text-[11px] text-slate-500">{reasons[p.reason] ?? 'Check the original source before using this account.'}</p>
      <details className="text-xs"><summary className="cursor-pointer">Source and context</summary>
        <p className="mt-2 whitespace-pre-wrap break-words text-slate-500">Question: {p.source_question}</p>
        <p className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words">{p.source_response}</p>
        <p className="mt-2 break-all text-[10px] text-slate-500">{new Date(p.source_occurred_at).toLocaleString()} · Source records: {p.source_event_ids.join(', ')}</p>
      </details>
      {p.status === 'pending' && <div className="flex gap-2"><button type="button" className={buttonClass} disabled={saving || loading || stale} onClick={() => void review(p, 'accept')}>Accept</button>
        <button type="button" className={buttonClass} disabled={saving || loading || stale} onClick={() => void review(p, 'dismiss')}>Dismiss</button></div>}
    </li>)}</ul>
    {page?.next_before_created_seq != null && <button type="button" className={buttonClass} disabled={saving || loading} onClick={() => void refresh(page.next_before_created_seq ?? undefined)}>Load older proposals</button>}
  </section>;
}

"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { MemberMemoryInputSchema, type MemberMemoryEvent, type MemberMemorySnapshot } from '@praxis/contract';
import { appendMemberMemory, getMemberMemory } from '@/lib/nexus/member-memory';
import { MemberProfileProposals } from './member-profile-proposals';

const evidenceLabels: Record<string, string> = {
  self_reported: 'Member stated', operator_confirmed: 'Operator confirmed',
  observed: 'Observed', inferred: 'Inferred', legacy: 'Older note · source unverified',
};
const buttonClass = 'rounded border border-slate-500/30 px-2 py-1 text-xs hover:bg-slate-500/10 disabled:opacity-40';
function topicLabel(key?: string) {
  if (key === 'profile.preference.contact_channel') return 'Communication preference';
  const category = /^profile\.(goal|expertise|preference)\.[a-f0-9]{24}$/.exec(key ?? '')?.[1];
  return category ? ({ goal: 'Goal', expertise: 'Expertise claim', preference: 'Preference' } as Record<string, string>)[category] : key;
}
type Draft = {
  kind: 'observation' | 'fact' | 'commitment' | 'retraction' | 'resolution';
  text: string; factKey: string; evidence: string; sourceRef: string;
  validUntil: string; originalValidUntil?: string; dueAt: string; owner: 'praxis' | 'member';
  supersedesId?: string; targetId?: string; outcome?: 'completed' | 'cancelled';
};
const emptyDraft = (): Draft => ({ kind: 'observation', text: '', factKey: '', evidence: 'observed', sourceRef: '', validUntil: '', dueAt: '', owner: 'praxis' });
function dateLabel(raw: string) { const date = new Date(raw); return Number.isNaN(date.getTime()) ? raw : date.toLocaleString(); }
function localDateInput(raw?: string) {
  if (!raw) return '';
  const date = new Date(raw);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, -1);
}
function Evidence({ event }: { event: MemberMemoryEvent }) {
  return <p className="mt-1 break-words text-[11px] text-slate-500">
    <span className={event.evidence === 'inferred' ? 'text-amber-500' : ''}>{evidenceLabels[event.evidence]}</span>
    {' · '}{event.source}{event.source_ref ? <> · {event.source_ref}</> : ' · Original source not linked'}
    {event.valid_until && <> · Valid until {dateLabel(event.valid_until)}</>}
  </p>;
}

export function MemberMemory({ memberId, projectId }: { memberId: string; projectId: string }) {
  return <MemoryScopeChooser key={`${memberId}:${projectId}`} memberId={memberId} projectId={projectId} />;
}
function MemoryScopeChooser({ memberId, projectId }: { memberId: string; projectId: string }) {
  const [scope, setScope] = useState('project');
  const selectedProject = scope === 'project' ? projectId : null;
  return <section className="mt-4 border-t border-slate-500/20 pt-4" aria-label="Member working memory">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="text-sm font-semibold">Working memory</h3>
      <select aria-label="Memory scope" value={scope} onChange={e => setScope(e.target.value)} className="hud-input max-w-48 text-xs">
        <option value="project">This project</option><option value="general">General member notes</option>
      </select>
    </div>
    <p className="mt-1 text-xs text-slate-500">Evidence and commitments for Praxis and Robert. These notes are not included in the member portal.</p>
    <MemoryScope key={`${memberId}:${selectedProject}`} memberId={memberId} projectId={selectedProject} />
  </section>;
}

function MemoryScope({ memberId, projectId }: { memberId: string; projectId: string | null }) {
  const [memory, setMemory] = useState<MemberMemorySnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [notice, setNotice] = useState('');
  const generation = useRef(0);
  const mounted = useRef(true);
  const request = useRef<{ payload: string; key: string } | null>(null);
  const refresh = useCallback(async (before?: number) => {
    const current = ++generation.current;
    setLoading(true); setError(null);
    try {
      const result = await getMemberMemory(memberId, projectId, before);
      if (!mounted.current || current !== generation.current) return false;
      setMemory(previous => before && previous ? {
        ...result, timeline: [...previous.timeline, ...result.timeline.filter(e => !previous.timeline.some(old => old.id === e.id))],
      } : result);
      return true;
    } catch (err) {
      if (!mounted.current || current !== generation.current) return false;
      if (!before) setMemory(null);
      setError(err instanceof Error ? err.message : 'Could not load member memory.');
      return false;
    } finally { if (mounted.current && current === generation.current) setLoading(false); }
  }, [memberId, projectId]);
  useEffect(() => { mounted.current = true; void refresh(); return () => { mounted.current = false; generation.current++; }; }, [refresh]);
  const edit = (next: Draft) => { request.current = null; setError(null); setNotice(''); setDraft(next); };
  async function save(event: FormEvent) {
    event.preventDefault(); if (!draft || saving) return;
    setSaving(true); setError(null); setNotice('');
    try {
      const input = MemberMemoryInputSchema.parse({
        project_id: projectId, kind: draft.kind, text: draft.text, evidence: draft.evidence, source: 'operator',
        ...(draft.sourceRef.trim() && { source_ref: draft.sourceRef.trim() }),
        ...(draft.kind === 'fact' && { fact_key: draft.factKey, ...(draft.validUntil && { valid_until: draft.originalValidUntil || new Date(draft.validUntil).toISOString() }) }),
        ...(draft.kind === 'commitment' && { owner: draft.owner, ...(draft.dueAt && { due_at: new Date(draft.dueAt).toISOString() }) }),
        ...(draft.supersedesId && { supersedes_id: draft.supersedesId }),
        ...(draft.targetId && { target_id: draft.targetId }), ...(draft.outcome && { outcome: draft.outcome }),
      });
      const payload = JSON.stringify(input);
      if (request.current?.payload !== payload) request.current = { payload, key: crypto.randomUUID() };
      await appendMemberMemory(memberId, { ...input, idempotency_key: request.current.key });
      if (!mounted.current) return;
      setDraft(null); setNotice('Saved to this member’s history.'); request.current = null;
      await refresh();
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : 'Could not save member memory.');
    } finally { if (mounted.current) setSaving(false); }
  }
  const conflicts = new Set(memory?.conflicts.flatMap(c => c.events.map(e => e.id)) ?? []);
  return <div className="mt-3 space-y-3">
    <MemberProfileProposals memberId={memberId} projectId={projectId} onRefreshMemory={refresh} />
    <div className="flex gap-2"><button type="button" className={buttonClass} disabled={saving} onClick={() => edit(emptyDraft())}>Add memory</button>
      <button type="button" className={buttonClass} disabled={loading || saving} onClick={() => void refresh()}>Refresh memory</button></div>
    {error && <p role="alert" className="whitespace-pre-wrap break-words text-xs text-red-500">{error}</p>}
    {notice && <p role="status" className="text-xs text-emerald-500">{notice}</p>}
    {loading && <p className="text-xs text-slate-500">Loading memory…</p>}
    {draft && <form onSubmit={save} className="space-y-2 rounded border border-slate-500/30 p-3">
      <fieldset disabled={saving} className="space-y-2">
        <legend className="mb-2 text-xs font-semibold">{draft.supersedesId ? 'Correct a fact' : draft.kind === 'retraction' ? 'Retract a fact' : draft.kind === 'resolution' ? 'Resolve commitment' : 'Record a memory'}</legend>
        {!draft.targetId && !draft.supersedesId && <label className="block text-xs">Type<select aria-label="Memory type" className="hud-input mt-1" value={draft.kind} onChange={e => setDraft({ ...draft, kind: e.target.value as Draft['kind'] })}>
          <option value="observation">Observation</option><option value="fact">Profile fact</option><option value="commitment">Commitment</option>
        </select></label>}
        {draft.kind === 'fact' && <label className="block text-xs">Topic<input aria-label="Memory topic" required maxLength={160} readOnly={Boolean(draft.supersedesId)} className="hud-input mt-1" value={draft.supersedesId ? topicLabel(draft.factKey) : draft.factKey} onChange={e => setDraft({ ...draft, factKey: e.target.value })} placeholder="e.g. preferred channel" /></label>}
        <label className="block text-xs">{draft.targetId ? 'Reason or outcome' : 'What should Praxis remember?'}<textarea aria-label="Memory text" required maxLength={20000} className="hud-input mt-1 min-h-20" value={draft.text} onChange={e => setDraft({ ...draft, text: e.target.value })} /></label>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="block text-xs">Evidence<select aria-label="Memory evidence" className="hud-input mt-1" value={draft.evidence} onChange={e => setDraft({ ...draft, evidence: e.target.value })}>
            <option value="observed">Observed</option><option value="self_reported">Member stated</option><option value="operator_confirmed">Operator confirmed</option><option value="inferred">Inferred</option>
          </select></label>
          <label className="block text-xs">Source reference (optional)<input aria-label="Memory source reference" maxLength={2000} className="hud-input mt-1" value={draft.sourceRef} onChange={e => setDraft({ ...draft, sourceRef: e.target.value })} placeholder="Meeting, message, or document reference" /></label>
        </div>
        {draft.kind === 'fact' && <label className="block text-xs">Valid until (optional, local time)<input aria-label="Memory expiry" type="datetime-local" step="0.001" className="hud-input mt-1" value={draft.validUntil} onChange={e => setDraft({ ...draft, validUntil: e.target.value, originalValidUntil: undefined })} /></label>}
        {draft.kind === 'commitment' && <div className="grid gap-2 sm:grid-cols-2">
          <label className="block text-xs">Who committed?<select aria-label="Commitment owner" className="hud-input mt-1" value={draft.owner} onChange={e => setDraft({ ...draft, owner: e.target.value as Draft['owner'] })}><option value="praxis">Praxis</option><option value="member">Member</option></select></label>
          <label className="block text-xs">Due (optional, local time)<input aria-label="Commitment deadline" className="hud-input mt-1" type="datetime-local" value={draft.dueAt} onChange={e => setDraft({ ...draft, dueAt: e.target.value })} /></label>
        </div>}
        <div className="flex gap-2"><button type="submit" className={buttonClass}>{saving ? 'Saving…' : 'Save memory'}</button><button type="button" className={buttonClass} onClick={() => setDraft(null)}>Cancel</button></div>
      </fieldset>
    </form>}
    {memory && <>
      {memory.conflicts.length > 0 && <p className="rounded bg-amber-500/10 p-2 text-xs text-amber-600">Conflicting accounts remain below. Check their evidence before choosing which facts to correct or retract.</p>}
      <div><h4 className="mb-2 text-xs font-semibold">Current facts</h4>
        {!memory.current_facts.length && <p className="text-xs text-slate-500">No current facts recorded in this scope.</p>}
        <ul className="space-y-2">{memory.current_facts.map(fact => <li key={fact.id} className={`rounded border p-2 ${conflicts.has(fact.id) ? 'border-amber-500/40' : 'border-slate-500/20'}`}>
          <p className="text-[11px] font-semibold text-slate-500">{topicLabel(fact.fact_key)}{conflicts.has(fact.id) && ' · Conflicting accounts'}</p>
          <p className="whitespace-pre-wrap break-words text-xs">{fact.text}</p><Evidence event={fact} />
          <div className="mt-2 flex gap-2"><button type="button" disabled={saving} className={buttonClass} onClick={() => edit({ ...emptyDraft(), kind: 'fact', text: fact.text, factKey: fact.fact_key ?? '', evidence: fact.evidence === 'legacy' ? 'observed' : fact.evidence, validUntil: localDateInput(fact.valid_until), originalValidUntil: fact.valid_until, supersedesId: fact.id })}>Correct</button>
            <button type="button" disabled={saving} className={buttonClass} onClick={() => edit({ ...emptyDraft(), kind: 'retraction', targetId: fact.id })}>Retract</button></div>
        </li>)}</ul>
      </div>
      <div><h4 className="mb-2 text-xs font-semibold">Open commitments</h4>
        {!memory.open_commitments.length && <p className="text-xs text-slate-500">No open commitments recorded in this scope.</p>}
        <ul className="space-y-2">{memory.open_commitments.map(commitment => <li key={commitment.id} className="rounded border border-slate-500/20 p-2">
          <p className="whitespace-pre-wrap break-words text-xs"><strong>{commitment.owner === 'praxis' ? 'Praxis' : 'Member'}:</strong> {commitment.text}</p>
          {commitment.due_at && <p className="mt-1 text-xs text-slate-500">Due {dateLabel(commitment.due_at)}</p>}<Evidence event={commitment} />
          <div className="mt-2 flex gap-2">{(['completed', 'cancelled'] as const).map(outcome => <button key={outcome} type="button" disabled={saving} className={buttonClass} onClick={() => edit({ ...emptyDraft(), kind: 'resolution', targetId: commitment.id, outcome })}>{outcome === 'completed' ? 'Complete' : 'Cancel commitment'}</button>)}</div>
        </li>)}</ul>
      </div>
      <details><summary className="cursor-pointer text-xs font-semibold">History · {memory.total_events} {memory.total_events === 1 ? 'record' : 'records'}</summary>
        <ul className="mt-2 space-y-2">{memory.timeline.map(event => <li key={event.id} className="border-l-2 border-slate-500/20 pl-2">
          <p className="text-[11px] text-slate-500">{dateLabel(event.occurred_at || event.legacy_at || event.recorded_at)} · {event.kind}{event.supersedes_id && ' · correction'}{event.outcome && ` · ${event.outcome}`}</p>
          <details><summary className="cursor-pointer break-words text-xs">{event.text.slice(0, 160)}{event.text.length > 160 ? '…' : ''}</summary><p className="whitespace-pre-wrap break-words text-xs">{event.text}</p>
            <p className="break-words text-[10px] text-slate-500">Recorded {dateLabel(event.recorded_at)}{event.legacy_source && ` · Original source: ${event.legacy_source}`}</p>
            <p className="break-all text-[10px] text-slate-500">Record: {event.id}{event.target_id && ` · Refers to: ${event.target_id}`}{event.supersedes_id && ` · Corrects: ${event.supersedes_id}`}</p></details>
          <Evidence event={event} />
        </li>)}</ul>
        {memory.next_before_seq !== null && <button type="button" className={`${buttonClass} mt-2`} disabled={loading || saving} onClick={() => void refresh(memory.next_before_seq ?? undefined)}>Load older records</button>}
      </details>
      <p className="text-[10px] text-slate-500">Current as of {dateLabel(memory.as_of)}. Contact settings above still govern outreach.</p>
    </>}
  </div>;
}

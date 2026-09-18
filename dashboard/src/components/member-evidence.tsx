"use client";
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { getMemberEvidence, QUESTION_TYPES, type EvidenceBucket, type EvidenceRecord, type MemberEvidence as Evidence, type QuestionType } from '@/lib/nexus/member-evidence';

const questionLabels: Record<QuestionType, string> = {
  all: 'Everything', contact_channel: 'Contact channel', tone: 'Tone', availability: 'Availability', approval: 'Approval required',
  role: 'Project role', preference: 'Preferences', goal: 'Goals', expertise: 'Expertise', commitment: 'Commitments',
};
const statusText: Record<string, string> = { missing: 'None recorded', not_requested: 'Not looked up for this question', unavailable: 'Unavailable' };
const buttonClass = 'rounded border border-slate-500/30 px-2 py-1 text-xs hover:bg-slate-500/10 disabled:opacity-40';
function dateLabel(raw: string) { const date = new Date(raw); return Number.isNaN(date.getTime()) ? raw : date.toLocaleString(); }
function valueText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) return value.map(item => typeof item === 'string' ? item : JSON.stringify(item)).join(', ');
  return JSON.stringify(value);
}

function Record({ record }: { record: EvidenceRecord }) {
  if (record.source_class === 'directory_setting') {
    return <li className="rounded border border-slate-500/20 p-2">
      <p className="text-xs"><strong>{record.label}:</strong> {valueText(record.value)}</p>
      <p className="break-words text-[11px] text-slate-500">{record.evidence_label} · {record.applies_to === 'all_projects'
        ? 'Applies to all projects by default; not a project statement' : 'Applies to this project (directory link)'} · {record.ref}</p>
    </li>;
  }
  if (record.source_class === 'pending_proposal') {
    return <li className="rounded border border-slate-500/20 p-2">
      <blockquote className="whitespace-pre-wrap break-words border-l-2 border-slate-500/40 pl-2 text-xs">{record.quote}</blockquote>
      <p className="break-words text-[11px] text-slate-500">{record.evidence_label} · {record.category}{record.scope && ` · ${record.scope === 'project' ? 'This project' : 'General'}`}</p>
      <p className="break-all text-[10px] text-slate-500">Proposal: {record.id}</p>
    </li>;
  }
  if (Array.isArray(record.event_ids)) {
    return <li className="rounded border border-amber-500/40 p-2">
      <p className="text-xs"><strong>{record.fact_key}</strong> · {record.scope === 'project' ? 'This project' : 'General'} · {record.status}</p>
      {record.note && <p className="text-[11px] text-slate-500">{record.note}</p>}
      <p className="break-all text-[10px] text-slate-500">Records: {record.event_ids.join(', ')}</p>
    </li>;
  }
  return <li className={`rounded border p-2 ${record.conflicted ? 'border-amber-500/40' : 'border-slate-500/20'}`}>
    <p className="text-[11px] font-semibold text-slate-500">{record.scope === 'project' ? 'This project' : 'General'}{record.fact_key && ` · ${record.fact_key}`}
      {record.conflicted && ' · Conflicting accounts'}{record.history_status && ` · ${record.history_status}`}</p>
    <p className="whitespace-pre-wrap break-words text-xs">{record.owner && <strong>{record.owner === 'praxis' ? 'Praxis' : 'Member'}: </strong>}{record.text}</p>
    <p className="break-words text-[11px] text-slate-500">
      <span className={record.evidence === 'inferred' || record.evidence === 'legacy' || record.source_class === 'completion_claim' ? 'text-amber-500' : ''}>{record.evidence_label}</span>
      {' · '}{record.source}{record.source_ref ? ` · ${record.source_ref}` : ' · Original source not linked'}
      {record.due_at && ` · Due ${dateLabel(record.due_at)}`}{record.valid_until && ` · Valid until ${dateLabel(record.valid_until)}`}
      {record.corrected_by && ` · Corrected by ${record.corrected_by}`}
      {record.retracted_by && ` · Retracted by ${record.retracted_by}${record.retraction_text ? `: ${record.retraction_text}` : ''}`}
      {record.resolution && ` · ${record.source_class === 'completion_claim' ? 'Completion claimed' : 'Completed'}: ${record.resolution.text} (${record.resolution.evidence}${record.resolution.source_ref ? `, ${record.resolution.source_ref}` : ''})`}
    </p>
    <p className="break-all text-[10px] text-slate-500">Record: {record.id}{record.supersedes_id && ` · Corrects: ${record.supersedes_id}`}</p>
  </li>;
}

function Bucket({ bucket, heading }: { bucket: EvidenceBucket; heading?: string }) {
  return <div>
    <h5 className="text-xs font-semibold">{heading ?? bucket.label}{bucket.status === 'partial' && ` · showing ${bucket.records.length} of ${bucket.total}`}</h5>
    {bucket.note && <p className="text-[11px] text-slate-500">{bucket.note}</p>}
    {bucket.status !== 'present' && bucket.status !== 'partial' && <p className="text-xs text-slate-500">{statusText[bucket.status] ?? bucket.status}{bucket.reason ? `: ${bucket.reason}` : ''}</p>}
    {bucket.status === 'partial' && <p className="text-xs text-amber-500">Partial: {bucket.total - bucket.records.length} more not shown. Pick a more specific question, or enter an exact topic key to show only that key.</p>}
    {bucket.external?.council_reputation && <p className="text-[11px] text-slate-500">Council reputation standing: {bucket.external.council_reputation.status}. {bucket.external.council_reputation.reason}</p>}
    {bucket.project_fields && <p className="text-[11px] text-slate-500">Project directory link: {bucket.project_fields.status}. {bucket.project_fields.reason}</p>}
    {bucket.records.length > 0 && <ul className="mt-1 space-y-2">{bucket.records.map((record, index) => <Record key={record.id ?? `${record.field ?? record.fact_key ?? 'record'}-${index}`} record={record} />)}</ul>}
  </div>;
}

/** Evidence lookup for one member and the exact scope shown by the memory panel. Read-only. */
export function MemberEvidence({ memberId, projectId, version, defaultOpen = false }: { memberId: string; projectId: string | null; version: string | null; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const [question, setQuestion] = useState<QuestionType>('all');
  const [factKey, setFactKey] = useState('');
  const [query, setQuery] = useState<{ question: QuestionType; factKey: string }>({ question: 'all', factKey: '' });
  const [evidence, setEvidence] = useState<Evidence | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const generation = useRef(0), mounted = useRef(true);
  const load = useCallback(async () => {
    const current = ++generation.current; setLoading(true); setError('');
    try {
      const result = await getMemberEvidence(memberId, projectId, query.question, query.factKey || undefined);
      if (!mounted.current || current !== generation.current) return;
      setEvidence(result);
    } catch (err) {
      if (!mounted.current || current !== generation.current) return;
      setEvidence(null); setError(err instanceof Error ? err.message : 'Could not look up evidence.');
    } finally { if (mounted.current && current === generation.current) setLoading(false); }
  }, [memberId, projectId, query]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; }; }, []);
  useEffect(() => { if (open) void load(); }, [open, load, version]);
  function submit(event: FormEvent) { event.preventDefault(); setQuery({ question, factKey: factKey.trim() }); }
  return <details className="rounded border border-slate-500/25 p-3" open={open} onToggle={event => setOpen((event.currentTarget as HTMLDetailsElement).open)}>
    <summary className="cursor-pointer text-xs font-semibold">Evidence by question · where each assertion applies</summary>
    <p className="mt-1 text-[11px] text-slate-500">Project assertions, general member assertions and global directory settings are listed separately. A missing project assertion stays missing; the directory default is context, never a project statement.</p>
    <form onSubmit={submit} className="mt-2 flex flex-wrap items-end gap-2">
      <label className="text-xs">Question<select aria-label="Evidence question" className="hud-input mt-1 text-xs" value={question}
        onChange={e => { const next = e.target.value as QuestionType; setQuestion(next); setQuery({ question: next, factKey: factKey.trim() }); }}>
        {QUESTION_TYPES.filter(type => projectId !== null || type !== 'role').map(type => <option key={type} value={type}>{questionLabels[type]}</option>)}
      </select></label>
      <label className="text-xs">Exact topic key (optional, narrows)<input aria-label="Evidence topic key" maxLength={200} className="hud-input mt-1 text-xs" value={factKey} onChange={e => setFactKey(e.target.value)} placeholder="e.g. availability" /></label>
      <button type="submit" className={buttonClass} disabled={loading}>Look up</button>
    </form>
    {loading && <p className="text-xs text-slate-500">Looking up evidence…</p>}
    {error && <p role="alert" className="break-words text-xs text-red-500">{error}</p>}
    {evidence && <div className="mt-2 space-y-3">
      <p className="text-[11px] text-slate-500">{evidence.identity.name ?? 'Member'}{evidence.identity.seat_id && ` · ${evidence.identity.seat_id}`} · Scope: {evidence.scope === 'project' ? 'this project' : 'general'}
        {evidence.project_link && ` · Link: ${evidence.project_link.status}${evidence.project_link.role ? ` (${evidence.project_link.role})` : ''}`} · As of {dateLabel(evidence.as_of)}</p>
      {evidence.identity.ambiguous && <p role="status" className="rounded bg-amber-500/10 p-2 text-xs text-amber-600">Another member record shares this name. This view is for record {evidence.member_id} only; verify the identity before relying on it.</p>}
      {evidence.scope === 'project' && <Bucket bucket={evidence.sources.project_assertions} heading="Project-specific assertions (this project)" />}
      <Bucket bucket={evidence.sources.general_assertions} heading="General member assertions (not project-specific)" />
      <Bucket bucket={evidence.sources.directory_settings} heading="Global directory settings (default context, not a project statement)" />
      <Bucket bucket={evidence.sources.inferred_observations} heading="Inferred records (unconfirmed)" />
      <Bucket bucket={evidence.sources.demonstrated_contributions} heading="Demonstrated outcomes (confirmed or observed completions)" />
      <Bucket bucket={evidence.sources.completion_claims} heading="Completion claims (member-stated or inferred, not demonstrated)" />
      <Bucket bucket={evidence.context.open_commitments} />
      <Bucket bucket={evidence.context.pending_proposals} heading="Pending profile proposals (unreviewed, not evidence)" />
      <Bucket bucket={evidence.context.history.conflicts} heading="Unresolved conflicts" />
      <Bucket bucket={evidence.context.history.corrected} heading="Corrected facts (history)" />
      <Bucket bucket={evidence.context.history.retracted} heading="Retracted facts (history)" />
    </div>}
  </details>;
}

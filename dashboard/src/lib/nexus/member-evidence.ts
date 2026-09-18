import { authFetch } from './shared';

/** Question types accepted by GET /api/members/:id/evidence (server: db/member-evidence.js). */
export const QUESTION_TYPES = ['all', 'contact_channel', 'tone', 'availability', 'approval', 'role', 'preference', 'goal', 'expertise', 'commitment'] as const;
export type QuestionType = typeof QUESTION_TYPES[number];
export type BucketStatus = 'present' | 'missing' | 'partial' | 'not_requested' | 'unavailable';
const BUCKET_STATUSES: readonly string[] = ['present', 'missing', 'partial', 'not_requested', 'unavailable'];

export interface EvidenceResolution { id: string; seq: number; recorded_at: string; text: string; evidence: string; source: string; outcome: string; source_ref?: string }
export interface EvidenceRecord {
  source_class: string;
  id?: string; seq?: number; member_id?: string; project_id?: string | null; scope?: 'general' | 'project';
  kind?: string; text?: string; fact_key?: string; evidence?: string; evidence_label?: string; source?: string; source_ref?: string;
  recorded_at?: string; occurred_at?: string; valid_from?: string; valid_until?: string; owner?: string; due_at?: string;
  supersedes_id?: string; target_id?: string; conflicted?: boolean;
  history_status?: string; corrected_by?: string; corrected_at?: string; retracted_by?: string; retracted_at?: string; retraction_text?: string;
  resolution?: EvidenceResolution;
  field?: string; label?: string; value?: unknown; ref?: string; applies_to?: string; is_project_statement?: boolean; updated_at?: string | null;
  quote?: string; category?: string; reason?: string; is_evidence?: boolean; status?: string; created_at?: string; capture_id?: string; source_event_ids?: string[];
  event_ids?: string[]; note?: string;
}
export interface EvidenceBucket {
  label: string; applies_to: string | string[] | null; status: BucketStatus; total: number; truncated: boolean; records: EvidenceRecord[];
  note?: string; reason?: string; is_project_statement?: boolean;
  external?: { council_reputation: { status: string; seat_id: string | null; reason: string } };
  project_fields?: { status: string; reason: string };
}
export interface MemberEvidence {
  member_id: string; scope: 'general' | 'project'; project_id: string | null;
  question: { type: QuestionType; fact_key: string | null }; as_of: string; directory_updated_at: string | null;
  identity: { member_id: string; name: string | null; seat_id: string | null; kind: string | null; status: string | null; ambiguous: boolean; same_name_member_ids: string[]; note?: string };
  project_link: { project_id: string; status: string; role: string | null; decision_maker: boolean | null } | null;
  sources: { directory_settings: EvidenceBucket; general_assertions: EvidenceBucket; project_assertions: EvidenceBucket; inferred_observations: EvidenceBucket;
    demonstrated_contributions: EvidenceBucket; completion_claims: EvidenceBucket };
  context: { open_commitments: EvidenceBucket; pending_proposals: EvidenceBucket; history: { corrected: EvidenceBucket; retracted: EvidenceBucket; conflicts: EvidenceBucket } };
  coverage: { scopes: string[]; other_projects_included: boolean; observations_included: boolean; contact_details_included: boolean; limit: number };
  usage_guidance: string;
}

const invalid = () => new Error('Member evidence returned an invalid response. Look up again to retry.');
const mismatch = () => new Error('Member evidence scope mismatch; nothing was displayed.');
const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function checkBucket(value: unknown, memberId: string, projectId: string | null, directory: boolean): EvidenceBucket {
  if (!isObject(value) || typeof value.label !== 'string' || !BUCKET_STATUSES.includes(String(value.status)) || !Array.isArray(value.records)
    || typeof value.total !== 'number' || typeof value.truncated !== 'boolean') throw invalid();
  for (const record of value.records) {
    if (!isObject(record) || typeof record.source_class !== 'string') throw invalid();
    // Other members and other projects must never be rendered, whatever the server says.
    if (record.member_id !== undefined && record.member_id !== memberId) throw mismatch();
    if (record.project_id !== undefined && record.project_id !== null && record.project_id !== projectId) throw mismatch();
    if (record.scope === 'project' && (projectId === null || record.project_id !== projectId)) throw mismatch();
    if (record.scope === 'general' && record.project_id !== null) throw mismatch();
    if (directory && (typeof record.ref !== 'string' || !record.ref.startsWith(`/api/members/${memberId}#`))) throw mismatch();
    if ((record.source_class === 'demonstrated_contribution' || record.source_class === 'completion_claim') && !isObject(record.resolution)) throw invalid();
  }
  return value as unknown as EvidenceBucket;
}

export async function getMemberEvidence(memberId: string, projectId: string | null, question: QuestionType, factKey?: string): Promise<MemberEvidence> {
  const params = new URLSearchParams({ scope: projectId === null ? 'general' : 'project', question });
  if (projectId !== null) params.set('project_id', projectId);
  if (factKey) params.set('fact_key', factKey);
  const response = await authFetch(`/api/members/${encodeURIComponent(memberId)}/evidence?${params}`, { cache: 'no-store' });
  const value: unknown = await response.json();
  if (!response.ok) throw new Error(isObject(value) && typeof value.error === 'string' ? value.error : `Member evidence unavailable (${response.status})`);
  if (!isObject(value) || !isObject(value.sources) || !isObject(value.context) || !isObject(value.context.history) || !isObject(value.identity)
    || !isObject(value.coverage) || !isObject(value.question) || typeof value.as_of !== 'string' || typeof value.usage_guidance !== 'string') throw invalid();
  if (value.member_id !== memberId || value.identity.member_id !== memberId || value.scope !== (projectId === null ? 'general' : 'project')
    || value.project_id !== projectId || value.coverage.other_projects_included !== false) throw mismatch();
  if (value.project_link !== null && (!isObject(value.project_link) || value.project_link.project_id !== projectId)) throw mismatch();
  const sources = value.sources, context = value.context, history = value.context.history as Record<string, unknown>;
  for (const key of ['general_assertions', 'project_assertions', 'inferred_observations', 'demonstrated_contributions', 'completion_claims']) checkBucket(sources[key], memberId, projectId, false);
  checkBucket(sources.directory_settings, memberId, projectId, true);
  for (const key of ['open_commitments', 'pending_proposals']) checkBucket(context[key], memberId, projectId, false);
  for (const key of ['corrected', 'retracted', 'conflicts']) checkBucket(history[key], memberId, projectId, false);
  if (!Array.isArray(value.identity.same_name_member_ids) || typeof value.identity.ambiguous !== 'boolean') throw invalid();
  return value as unknown as MemberEvidence;
}

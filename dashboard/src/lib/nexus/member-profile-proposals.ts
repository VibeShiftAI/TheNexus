import { authFetch } from './shared';

export type ProfileStatus = 'pending' | 'applied' | 'dismissed';
export interface MemberProfileProposal {
  id: string; created_seq: number; capture_id: string; category: 'preference' | 'goal' | 'expertise' | 'commitment';
  quote: string; fact_key?: string; source_event_ids: string[]; source_response: string; source_question: string;
  source_origin: string; source_occurred_at: string; status: ProfileStatus; reason: string;
  event_id?: string; created_at: string; reviewed_at?: string;
}
export interface MemberProfilePage {
  member_id: string; project_id: string | null; memory_version: number; proposals: MemberProfileProposal[];
  total: number; next_before_created_seq: number | null;
}
export class ProfileReviewError extends Error { constructor(message: string, public status: number) { super(message); } }
async function body(response: Response): Promise<unknown> {
  const value = await response.json();
  if (!response.ok) throw new ProfileReviewError(typeof value?.error === 'string' ? value.error : `Profile proposals unavailable (${response.status})`, response.status);
  return value;
}
const uuid = (s: unknown): s is string => typeof s === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(s);
const integer = (n: unknown, min = 0): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= min;
const string = (s: unknown, max: number): s is string => typeof s === 'string' && s.length <= max;
function proposal(value: unknown): MemberProfileProposal {
  const p = value as MemberProfileProposal | null;
  if (!p || !uuid(p.id) || !integer(p.created_seq, 1) || !uuid(p.capture_id) || !['preference', 'goal', 'expertise', 'commitment'].includes(p.category)
    || !string(p.quote, 2000) || !p.quote.trim() || !Array.isArray(p.source_event_ids) || !p.source_event_ids.length || p.source_event_ids.length > 32 || !p.source_event_ids.every(uuid)
    || !string(p.source_response, 24000) || !string(p.source_question, 1000000) || !['member_reply', 'operator_relay', 'unknown'].includes(p.source_origin)
    || !string(p.source_occurred_at, 100) || !string(p.created_at, 100) || !['pending', 'applied', 'dismissed'].includes(p.status) || !string(p.reason, 200)
    || (p.fact_key !== undefined && !string(p.fact_key, 200)) || (p.event_id !== undefined && !uuid(p.event_id))
    || (p.category !== 'commitment' && !p.fact_key) || (p.status === 'applied' && (!uuid(p.event_id) || !string(p.reviewed_at, 100)))) throw new Error('Profile proposals returned an invalid response. Refresh proposals to try again.');
  return p;
}
export async function getMemberProfileProposals(memberId: string, projectId: string | null, status: ProfileStatus, before?: number): Promise<MemberProfilePage> {
  const query = new URLSearchParams({ status, limit: '20' });
  if (projectId !== null) query.set('project_id', projectId);
  if (before !== undefined) query.set('before_created_seq', String(before));
  const value = await body(await authFetch(`/api/members/${encodeURIComponent(memberId)}/profile-proposals?${query}`, { cache: 'no-store' })) as MemberProfilePage;
  if (!value || value.member_id !== memberId || value.project_id !== projectId) throw new Error('Profile proposal scope mismatch; no proposals were displayed.');
  if (!integer(value.memory_version) || !integer(value.total) || !(value.next_before_created_seq === null || integer(value.next_before_created_seq, 1)) || !Array.isArray(value.proposals) || value.proposals.length > 50) throw new Error('Profile proposals returned an invalid response.');
  value.proposals = value.proposals.map(proposal);
  if (value.proposals.some(p => p.status !== status)) throw new Error('Profile proposals returned an invalid response.');
  return value;
}
export async function reviewMemberProfileProposal(memberId: string, expected: MemberProfileProposal, decision: 'accept' | 'dismiss', version: number): Promise<MemberProfileProposal> {
  const result = await body(await authFetch(`/api/members/${encodeURIComponent(memberId)}/profile-proposals/${encodeURIComponent(expected.id)}/review`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision, expected_memory_version: version }),
  })) as { proposal: unknown };
  const reviewed = proposal(result?.proposal);
  if (reviewed.id !== expected.id || reviewed.capture_id !== expected.capture_id || reviewed.quote !== expected.quote || reviewed.status !== (decision === 'accept' ? 'applied' : 'dismissed')) throw new Error('Profile review returned an unexpected result. Refresh proposals before retrying.');
  return reviewed;
}

import {
  MemberMemoryEventSchema, MemberMemoryInputSchema, MemberMemorySnapshotSchema,
  type MemberMemoryInput, type MemberMemorySnapshot,
} from '@praxis/contract';
import { authFetch } from './shared';

async function body(response: Response): Promise<unknown> {
  const result = await response.json();
  if (!response.ok) throw new Error(typeof result?.error === 'string' ? result.error : `Member memory unavailable (${response.status})`);
  return result;
}

export async function getMemberMemory(memberId: string, projectId: string | null, before?: number): Promise<MemberMemorySnapshot> {
  const params = new URLSearchParams({ limit: '20' });
  if (projectId) params.set('project_id', projectId);
  if (before !== undefined) params.set('before_seq', String(before));
  const parsed = MemberMemorySnapshotSchema.safeParse(await body(await authFetch(
    `/api/members/${encodeURIComponent(memberId)}/memory?${params}`, { cache: 'no-store' },
  )));
  if (!parsed.success) throw new Error('Member memory returned an invalid response. Refresh memory to try again.');
  const memory = parsed.data;
  const events = [...memory.current_facts, ...memory.open_commitments, ...memory.timeline, ...memory.conflicts.flatMap(c => c.events)];
  if (memory.member_id !== memberId || memory.project_id !== projectId || events.some(e => e.member_id !== memberId || e.project_id !== projectId)) {
    throw new Error('Member memory scope mismatch; no notes were displayed.');
  }
  return memory;
}

export async function appendMemberMemory(memberId: string, input: MemberMemoryInput) {
  const parsed = MemberMemoryInputSchema.parse(input);
  const result = await body(await authFetch(`/api/members/${encodeURIComponent(memberId)}/memory`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parsed),
  })) as { event?: unknown };
  const verified = MemberMemoryEventSchema.safeParse(result.event);
  if (!verified.success) throw new Error('The memory service returned an invalid response. Refresh history before retrying.');
  const event = verified.data;
  if (event.member_id !== memberId || event.project_id !== parsed.project_id) {
    throw new Error('Memory write returned a different scope. Refresh before retrying.');
  }
  return event;
}

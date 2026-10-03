import type { StreamEvent } from '@praxis/contract';

export type BlockedEvent = Extract<StreamEvent, { type: 'task.blocked' }>;
type QuestionEvent = Extract<StreamEvent, { type: 'hitl.created' }>;
export const ALERT_PAIR_WAIT_MS = 10_000;
export type VoiceAlert = { event: StreamEvent; blocked?: BlockedEvent; ids: string[]; readyAt: number };

/** Only legacy task-question producers may be correlated without an explicit ID. */
function taskQuestion(event: StreamEvent): event is QuestionEvent {
  return event.type === 'hitl.created' && !!event.request?.taskId && event.request.metadata?.kind === 'task-question';
}

/** One-to-one matching keeps a second question on the same task independently audible. */
export function pairVoiceAlerts(events: StreamEvent[]): VoiceAlert[] {
  const blocks = events.filter((e): e is BlockedEvent => e.type === 'task.blocked');
  const questions = events.filter((e): e is QuestionEvent => e.type === 'hitl.created');
  const matches = blocks.flatMap(block => questions.flatMap(question => {
    const distance = Math.abs(Date.parse(block.at) - Date.parse(question.at));
    const exact = !!block.blockedOnHitlId && block.blockedOnHitlId === question.request.id;
    if (block.taskId !== question.request.taskId) return [];
    if (block.blockedOnHitlId ? !exact : !taskQuestion(question) || distance > ALERT_PAIR_WAIT_MS) return [];
    return [{ block, question, distance, exact }];
  })).sort((a, b) => Number(b.exact) - Number(a.exact) || a.distance - b.distance
    || Date.parse(a.question.at) - Date.parse(b.question.at) || a.question.eventId.localeCompare(b.question.eventId));
  const pairs = new Map<string, VoiceAlert>();
  for (const { block, question } of matches) {
    if (pairs.has(block.eventId) || pairs.has(question.eventId)) continue;
    const pair = { event: question, blocked: block, ids: [block.eventId, question.eventId], readyAt: 0 };
    pairs.set(block.eventId, pair); pairs.set(question.eventId, pair);
  }
  const seen = new Set<string>();
  return [...events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).flatMap(event => {
    const alert = pairs.get(event.eventId) ?? { event, ids: [event.eventId],
      readyAt: Date.parse(event.at) + (event.type === 'task.blocked' || taskQuestion(event) ? ALERT_PAIR_WAIT_MS : 0) };
    if (seen.has(alert.event.eventId)) return [];
    seen.add(alert.event.eventId);
    return [alert];
  });
}

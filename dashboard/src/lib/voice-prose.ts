import { voiceChatRequest } from './voice-chat';
import type { VoiceSession } from './voice-speech';

export interface VoiceProseInput {
  kind: 'command-result' | 'alert' | 'voice-test' | 'schedule-approved' | 'morning-prep' | 'status-ready' | 'chat-reply' | 'demo-mode' | 'away-briefing';
  facts: Record<string, unknown> | string;
  maxWords?: number;
}

/** Each trigger requests new prose. The writer owns no actions or playback. */
export async function composeVoiceProse(session: VoiceSession, input: VoiceProseInput): Promise<string> {
  const check = () => { if (!session.owns()) throw new DOMException('Voice ended', 'AbortError'); };
  check();
  const result = await voiceChatRequest<{ text?: string }>('/api/praxis/voice-prose', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  }, { signal: session.signal, requestTimeoutMs: 35_000 });
  check();
  if (!result.ok || typeof result.data.text !== 'string' || !result.data.text.trim()) throw new Error('Spoken wording unavailable');
  return result.data.text;
}

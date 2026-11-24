import { playAnnouncementCue } from './announcement-cue';
import { voiceChatRequest } from './voice-chat';
import type { OutcomeAlert } from './voice-alerts';
import type { VoiceSession, VoiceSpeech } from './voice-speech';

const endpoint = '/api/voice/outcomes';

export async function pendingOutcomeSpeech(signal: AbortSignal) {
  const res = await voiceChatRequest<{ id: string; speech: string; deliveredAt: string }[]>(endpoint, { cache: 'no-store' }, { signal });
  if (!res.ok || !Array.isArray(res.data)) throw new Error('Outcome queue unavailable');
  return res.data;
}

/** Acquire global ownership after synthesis and eligibility checks, immediately before audio. */
export async function playOutcomeSpeech(event: OutcomeAlert, speech: VoiceSpeech, session: VoiceSession,
  canPlay: () => Promise<boolean>, onStart: () => void, notice: (message: string) => void): Promise<boolean> {
  let attempted = false, started = false;
  const token = crypto.randomUUID();
  const url = endpoint + '/' + encodeURIComponent(event.eventId);
  const post = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) };
  let release: Promise<unknown> | undefined;
  const releaseUnheard = () => {
    if (attempted && !started) release ??= voiceChatRequest(url + '/release', { ...post, keepalive: true }, {}).catch(() => {});
    return release;
  };
  const pageHide = () => { speech.finish(session); void releaseUnheard(); };
  if (typeof window !== 'undefined') window.addEventListener('pagehide', pageHide);
  try {
    await speech.speak(session, event.speech, undefined, notice, false, async () => {
      if (!await canPlay()) return false;
      attempted = true;
      const claim = await voiceChatRequest<{ claimed: boolean }>(url + '/claim', post, { signal: session.signal });
      if (claim.ok && !claim.data.claimed) { attempted = false; return false; }
      if (!claim.ok || !await canPlay()) return false;
      return await playAnnouncementCue(session.signal) && await canPlay();
    }, () => { started = true; onStart(); });
    return started;
  } finally {
    if (typeof window !== 'undefined') window.removeEventListener('pagehide', pageHide);
    speech.finish(session);
    await releaseUnheard();
  }
}

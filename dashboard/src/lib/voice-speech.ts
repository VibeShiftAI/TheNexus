import { speechOwner, type SpeechLease, type SpeechOwner } from './speech-ownership';
export type SpeechOutcome = 'completed' | 'canceled' | 'failed' | 'empty' | 'limited';
export type VoiceState = 'idle' | 'recording' | 'transcribing' | 'working' | 'speaking';
export const MAX_SPOKEN_CHARS = 24_000;
export const SPEECH_CHUNK_CHARS = 1600;
class SpeechDeliveryError extends Error {}
function synthesisStatusMessage(status: number): string {
  if (status === 401 || status === 403) return `Speech access was denied (HTTP ${status}). Reload the app and complete any sign-in prompt.`;
  if (status === 429) return 'The speech service is busy (HTTP 429). Try again shortly.';
  if (status === 504 || status === 524) return `Speech preparation timed out (HTTP ${status}). Try again.`;
  return `Speech could not be prepared (HTTP ${status}). Try again when the service is available.`;
}

export function speechChunks(text: string): string[] {
  const chunks: string[] = [];
  while (text.length > SPEECH_CHUNK_CHARS) {
    const window = text.slice(0, SPEECH_CHUNK_CHARS);
    const boundaries = [...window.matchAll(/[.!?](?:["'”’])?\s+|\n+/g)];
    const last = boundaries.at(-1);
    let end = last ? last.index! + last[0].length : window.lastIndexOf(' ') + 1;
    if (end < SPEECH_CHUNK_CHARS / 3) end = SPEECH_CHUNK_CHARS;
    // Do not bisect a surrogate pair at a forced boundary.
    if (/[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    chunks.push(text.slice(0, end)); text = text.slice(end);
  }
  if (text) chunks.push(text);
  return chunks;
}
export interface VoiceSession {
  epoch: number; signal: AbortSignal; owns: () => boolean; cleanup: Set<() => void>; lease: SpeechLease;
}
export class VoiceSpeech {
  private epoch = 0;
  private current: { session: VoiceSession; controller: AbortController } | null = null;
  constructor(private options: {
    owner?: SpeechOwner; fetch?: typeof fetch; createAudio?: (src: string) => HTMLAudioElement;
    onState: (state: VoiceState) => void;
  }) {}
  begin(automatic = false): VoiceSession | null {
    if (automatic && (this.options.owner ?? speechOwner).busy()) return null;
    this.cancel();
    const epoch = ++this.epoch; const controller = new AbortController();
    const lease = (this.options.owner ?? speechOwner).claim(automatic ? 'alert' : 'voice', () => this.cancel(), !automatic);
    if (!lease) return null;
    const session: VoiceSession = { epoch, signal: controller.signal, cleanup: new Set(), lease,
      owns: () => this.current?.session === session && epoch === this.epoch && !controller.signal.aborted && lease.owns() };
    this.current = { session, controller }; return session;
  }
  setState(session: VoiceSession, state: VoiceState) { if (session.owns()) this.options.onState(state); }
  finish(session: VoiceSession) { if (session.owns()) this.cancel(); }
  cancel() {
    const current = this.current; this.current = null; ++this.epoch;
    if (!current) return;
    current.controller.abort();
    for (const cleanup of current.session.cleanup) cleanup();
    current.session.cleanup.clear(); current.session.lease.release(); this.options.onState('idle');
  }
  async speak(session: VoiceSession, text: string, voiceData?: { audio: string; mimeType: string }[], notice?: (text: string) => void, retainSession = false, beforePlayback?: () => Promise<boolean>, onPlaybackStarted?: () => void): Promise<SpeechOutcome> {
    if (!session.owns()) return 'canceled';
    let outcome: SpeechOutcome = 'empty';
    let playbackStarted = false;
    const started = () => {
      if (!session.owns()) return;
      if (!playbackStarted) onPlaybackStarted?.();
      playbackStarted = true;
    };
    this.setState(session, 'speaking');
    let prepared = false;
    const preparePlayback = async () => {
      if (!session.owns()) return false;
      if (!prepared && beforePlayback) {
        if (!await beforePlayback()) return false;
      }
      prepared = true;
      return session.owns();
    };
    try {
      const provided = voiceData?.filter(v => typeof v.audio === 'string' && v.audio);
      if (provided?.length) {
        for (const voice of provided) {
          if (!session.owns()) return 'canceled';
          if (!await preparePlayback()) return 'canceled';
          await this.play(session, voice.audio, voice.mimeType, started);
          if (!session.owns()) return 'canceled';
        }
        outcome = 'completed';
      } else if (text.trim()) {
        const limited = text.length > MAX_SPOKEN_CHARS;
        if (limited) notice?.('Spoken reply limited to 24,000 characters. The full response remains in the voice panel.');
        for (const chunk of speechChunks(text.slice(0, MAX_SPOKEN_CHARS))) {
          if (!session.owns()) return 'canceled';
          const res = await (this.options.fetch ?? fetch)('/api/praxis/speak', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: session.signal, body: JSON.stringify({ text: chunk }),
          });
          if (!session.owns()) return 'canceled';
          if (!res.ok) throw new SpeechDeliveryError(synthesisStatusMessage(res.status));
          if (/text\/html/i.test(res.headers?.get('content-type') ?? '')) {
            throw new SpeechDeliveryError('Speech received a web page instead of audio. Reload the app and complete any sign-in prompt.');
          }
          const data = await res.json().catch(() => { throw new SpeechDeliveryError('The speech response could not be read. Check the connection and try again.'); });
          if (!session.owns()) return 'canceled';
          if (typeof data.audio !== 'string' || !data.audio) throw new SpeechDeliveryError('The speech service returned no audio. Try again.');
          if (!await preparePlayback()) return 'canceled';
          await this.play(session, data.audio, data.mime || 'audio/mpeg', started);
          if (!session.owns()) return 'canceled';
        }
        outcome = limited ? 'limited' : 'completed';
      }
      return outcome;
    } catch (error) {
      outcome = session.owns() ? 'failed' : 'canceled';
      if (session.owns()) {
        const reason = error instanceof SpeechDeliveryError ? error.message : playbackStarted
          ? 'Audio stopped before the reply finished.'
          : 'Audio could not start because the speech request failed. Check the connection and try again.';
        notice?.(`${reason} The full response remains in the voice panel.`);
      }
      return outcome;
    } finally {
      // A conversational turn keeps its lease through the settling delay.
      // Failure and cancellation always release it and disarm follow-up.
      if (retainSession && outcome === 'completed' && session.owns()) this.setState(session, 'idle');
      else this.finish(session);
    }
  }
  private play(session: VoiceSession, audio: string, mime: string, onStarted: () => void): Promise<void> {
    if (!session.owns()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const el = (this.options.createAudio ?? (src => new Audio(src)))(`data:${mime};base64,${audio}`);
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        el.onended = null; el.onerror = null; el.onpause = null;
        el.pause(); el.removeAttribute('src'); el.load(); session.cleanup.delete(cleanup);
        if (error) reject(error); else resolve();
      };
      const cleanup = () => finish();
      session.cleanup.add(cleanup); el.onended = cleanup;
      // Native completion queues pause before ended; only an early pause
      // interrupts the reply. Keep ownership until the ended event arrives.
      el.onpause = () => { if (!el.ended) finish(new Error('Playback interrupted')); };
      el.onerror = () => {
        const code = el.error?.code;
        const detail = code === 3 ? 'The app could not decode the speech audio (media error 3).'
          : code === 4 ? 'The app cannot play this audio format (media error 4).'
          : code === 2 ? 'Audio delivery failed during playback (media error 2). Check the connection.'
          : 'The app reported an audio playback failure.';
        finish(new SpeechDeliveryError(detail));
      };
      void el.play().then(() => { if (!settled && session.owns()) onStarted(); }).catch(error => {
        const name = error?.name;
        finish(new SpeechDeliveryError(name === 'NotAllowedError'
          ? 'The app blocked audio playback (NotAllowedError). Click inside the app, then try Test Praxis voice in Voice settings.'
          : name === 'NotSupportedError' ? 'The app cannot play the supplied audio (NotSupportedError).'
          : 'The app could not start audio playback. Try Test Praxis voice in Voice settings.'));
      });
    });
  }
}

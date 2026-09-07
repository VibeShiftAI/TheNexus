import { speechOwner, type SpeechLease, type SpeechOwner } from './speech-ownership';
export type SpeechOutcome = 'completed' | 'canceled' | 'failed' | 'empty' | 'limited';
export type VoiceState = 'idle' | 'recording' | 'transcribing' | 'working' | 'speaking';
export const MAX_SPOKEN_CHARS = 24_000;
export const SPEECH_CHUNK_CHARS = 1600;
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
  async speak(session: VoiceSession, text: string, voiceData?: { audio: string; mimeType: string }[], notice?: (text: string) => void, retainSession = false): Promise<SpeechOutcome> {
    if (!session.owns()) return 'canceled';
    let outcome: SpeechOutcome = 'empty';
    this.setState(session, 'speaking');
    try {
      const provided = voiceData?.filter(v => typeof v.audio === 'string' && v.audio);
      if (provided?.length) {
        for (const voice of provided) {
          if (!session.owns()) return 'canceled';
          await this.play(session, voice.audio, voice.mimeType);
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
          if (!res.ok) throw new Error('Speech unavailable');
          const data = await res.json(); if (!session.owns()) return 'canceled';
          if (!data.audio) throw new Error('Speech unavailable');
          await this.play(session, data.audio, data.mime || 'audio/mpeg');
          if (!session.owns()) return 'canceled';
        }
        outcome = limited ? 'limited' : 'completed';
      }
      return outcome;
    } catch {
      outcome = session.owns() ? 'failed' : 'canceled';
      if (session.owns()) notice?.('Audio stopped before the reply finished. The full response remains in the voice panel.');
      return outcome;
    } finally {
      // A conversational turn keeps its lease through the settling delay.
      // Failure and cancellation always release it and disarm follow-up.
      if (retainSession && outcome === 'completed' && session.owns()) this.setState(session, 'idle');
      else this.finish(session);
    }
  }
  private play(session: VoiceSession, audio: string, mime: string): Promise<void> {
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
      el.onerror = () => finish(new Error('Playback failed'));
      void el.play().catch(() => finish(new Error('Playback blocked')));
    });
  }
}

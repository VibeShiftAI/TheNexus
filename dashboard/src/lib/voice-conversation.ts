import { VoiceSpeech, type VoiceSession, type SpeechOutcome } from './voice-speech';

export const FOLLOW_UP_DELAY_MS = 500;

/** Explicit opt-in, with a separate owned session for each user turn. */
export class VoiceConversation {
  private current: VoiceSession | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private epoch = 0;
  constructor(private options: {
    speech: VoiceSpeech;
    capture: (session: VoiceSession) => void;
    onChange: (active: boolean) => void;
    visible?: () => boolean;
  }) {}
  active = () => this.current !== null;
  owns = (session: VoiceSession) => this.current === session && session.owns();
  private visible = () => this.options.visible?.() ?? !document.hidden;
  start() {
    this.end();
    if (this.visible()) this.capture();
  }
  private capture() {
    const session = this.options.speech.begin();
    if (!session) return;
    this.current = session;
    session.signal.addEventListener('abort', this.end, { once: true });
    this.options.onChange(true);
    this.options.capture(session);
  }
  complete(session: VoiceSession, outcome: SpeechOutcome) {
    if (!this.owns(session)) return;
    if (outcome !== 'completed' || !this.visible()) { this.end(); return; }
    if (this.timer !== null) return;
    const epoch = this.epoch;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (epoch !== this.epoch || !this.owns(session)) return;
      if (!this.visible()) { this.end(); return; }
      // Detach only our listener before replacing the completed turn. The
      // retained lease prevents automatic announcements during this gap;
      // an explicit player would have aborted it and ended the conversation.
      session.signal.removeEventListener('abort', this.end);
      this.current = null;
      this.capture();
    }, FOLLOW_UP_DELAY_MS);
  }
  end = () => {
    ++this.epoch;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    const session = this.current;
    this.current = null;
    if (!session) return;
    session.signal.removeEventListener('abort', this.end);
    this.options.onChange(false);
    this.options.speech.finish(session);
  };
}

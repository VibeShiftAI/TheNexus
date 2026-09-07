/** One audible conversation per page. Explicit actions preempt; autoplay waits. */
export interface SpeechLease { owns: () => boolean; release: () => void; }
export class SpeechOwner {
  private current: { lease: SpeechLease; cancel: () => void; kind: string } | null = null;
  private listeners = new Set<() => void>();
  busy = () => this.current !== null;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  claim(kind: string, cancel: () => void, interrupt = true): SpeechLease | null {
    if (this.current && !interrupt) return null;
    const previous = this.current;
    const lease: SpeechLease = {
      owns: () => this.current?.lease === lease,
      release: () => { if (lease.owns()) { this.current = null; this.notify(); } },
    };
    this.current = { lease, cancel, kind };
    previous?.cancel();
    this.notify();
    return lease;
  }
  private notify() { for (const listener of this.listeners) listener(); }
}
export const speechOwner = new SpeechOwner();

// Attach once to real HTMLAudioElements so manual native controls also claim
// ownership. Autoplay reserves a separate SpeechOwner lease for its comm
// chirp, then acquires the media lease immediately before calling play().
const mediaLeases = new WeakMap<HTMLAudioElement, SpeechLease>();
export function claimMediaSpeech(el: HTMLAudioElement, interrupt = true): SpeechLease | null {
  const existing = mediaLeases.get(el);
  if (existing?.owns()) return existing;
  const lease = speechOwner.claim('chat', () => { el.pause(); }, interrupt);
  if (lease) mediaLeases.set(el, lease);
  return lease;
}
export function bindMediaSpeech(el: HTMLAudioElement): () => void {
  const onPlay = () => {
    // Native events are queued: an earlier play can arrive after a microphone
    // request has already paused the element and taken ownership.
    if (el.paused || el.ended) return;
    claimMediaSpeech(el);
  };
  const onStop = (event?: Event) => {
    // The inverse race occurs when explicit playback restarts before an old
    // pause/ended event arrives. Cleanup without an event always releases.
    if (event?.type === 'pause' && !el.paused) return;
    if (event?.type === 'ended' && !el.ended) return;
    mediaLeases.get(el)?.release(); mediaLeases.delete(el);
  };
  if (!el.paused && !el.ended) onPlay();
  el.addEventListener('play', onPlay); el.addEventListener('pause', onStop); el.addEventListener('ended', onStop); el.addEventListener('error', onStop);
  return () => { el.removeEventListener('play', onPlay); el.removeEventListener('pause', onStop); el.removeEventListener('ended', onStop); el.removeEventListener('error', onStop); onStop(); };
}

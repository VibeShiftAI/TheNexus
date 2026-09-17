/** Locally served TNG combadge sample; attribution lives beside the asset. */
export const ANNOUNCEMENT_CUE_SRC = '/audio/tng-combadge.mp3';
const CUE_VOLUME = 0.45;
const CUE_TIMEOUT_MS = 2000;

/** The caller holds speech ownership throughout the cue and subsequent speech. */
export function playAnnouncementCue(signal: AbortSignal, createAudio: (src: string) => HTMLAudioElement = src => new Audio(src)): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise(resolve => {
    let audio: HTMLAudioElement | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const finish = (completed: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      if (audio) {
        audio.onended = null; audio.onerror = null;
        audio.pause(); audio.removeAttribute('src'); audio.load();
      }
      resolve(completed && !signal.aborted);
    };
    const cancel = () => finish(false);
    try {
      audio = createAudio(ANNOUNCEMENT_CUE_SRC);
      audio.volume = CUE_VOLUME;
      audio.onended = () => finish(true);
      audio.onerror = cancel;
      signal.addEventListener('abort', cancel, { once: true });
      timer = setTimeout(cancel, CUE_TIMEOUT_MS);
      if (signal.aborted) return cancel();
      void audio.play().catch(cancel);
    } catch { finish(false); }
  });
}

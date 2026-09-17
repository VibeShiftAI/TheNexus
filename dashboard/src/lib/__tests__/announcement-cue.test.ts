import test from 'node:test';
import assert from 'node:assert/strict';
import { playAnnouncementCue, ANNOUNCEMENT_CUE_SRC } from '../announcement-cue';
class CueAudio {
  onended: (() => void) | null = null; onerror: (() => void) | null = null;
  volume = 1; paused = true; src = ''; played = 0;
  play() { this.played++; this.paused = false; return Promise.resolve(); }
  pause() { this.paused = true; }
  removeAttribute() { this.src = ''; }
  load() {}
}
test('combadge finishes before the announcement can proceed, at a gentle volume', async () => {
  const audio = new CueAudio(); let settled = false;
  const pending = playAnnouncementCue(new AbortController().signal, src => { assert.equal(src, ANNOUNCEMENT_CUE_SRC); return audio as unknown as HTMLAudioElement; }).then(ok => { settled = true; return ok; });
  assert.equal(audio.played, 1); assert.ok(audio.volume <= 0.5); assert.equal(settled, false);
  audio.onended?.(); assert.equal(await pending, true); assert.equal(audio.paused, true);
});
test('cancellation stops the cue and never authorizes subsequent speech', async () => {
  const audio = new CueAudio(); const controller = new AbortController();
  const pending = playAnnouncementCue(controller.signal, () => audio as unknown as HTMLAudioElement);
  controller.abort(); assert.equal(await pending, false); assert.equal(audio.paused, true);
});
test('blocked or stalled cue settles without leaving an announcement stuck', async t => {
  const audio = new CueAudio(); audio.play = () => Promise.reject(new Error('blocked'));
  assert.equal(await playAnnouncementCue(new AbortController().signal, () => audio as unknown as HTMLAudioElement), false);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const stalled = new CueAudio();
  const pending = playAnnouncementCue(new AbortController().signal, () => stalled as unknown as HTMLAudioElement);
  t.mock.timers.tick(2000); assert.equal(await pending, false); assert.equal(stalled.paused, true);
});
test('already canceled announcement never creates or plays a cue', async () => {
  const controller = new AbortController(); controller.abort();
  assert.equal(await playAnnouncementCue(controller.signal, () => { throw new Error('must not create'); }), false);
});

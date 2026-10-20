import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
// @ts-expect-error Test loader supplies the controllable navigation module.
import { setPathname } from 'next/navigation';
import { FEEDBACK_LAUNCHER_HOST_ID, measureFloatingControls, planFloatingControls, registerFloatingControl } from '../floating-controls';

// Sizes as rendered at 100%: ticker h-9 plus border, mini player, expanded voice dock, the widget's 48px launcher at 14px.
const TICKER = 37;
const AUDIO = { width: 330, height: 52 };
const VOICE = { width: 420, height: 46 };
const LAUNCHER = { right: 14, bottom: 14, width: 48, height: 48 };
const tick = () => new Promise(resolve => setImmediate(resolve));
const rootVar = (name: string) => document.documentElement.style.getPropertyValue(name);

test('without the feedback launcher the dock stacks above the mini player above the ticker, and the page reserves all of it', () => {
  assert.deepEqual(planFloatingControls({ ticker: TICKER, audio: AUDIO, voice: VOICE }), {
    audioBottom: 45, audioRight: 12, voiceBottom: 105, voiceRight: 12, tickerRight: 0, reserve: 159, overlayReserve: 105,
  });
});

test('the screenshot cluster: the launcher no longer covers the mini player stop button or the ticker display control', () => {
  const plan = planFloatingControls({ ticker: TICKER, audio: AUDIO, voice: VOICE, launcher: LAUNCHER });
  // The mini player shares rows 45 to 97 with the launcher (14 to 62), so it steps left of it; the dock above does not.
  assert.equal(plan.audioRight, 14 + 48 + 8);
  assert.equal(plan.voiceRight, 12);
  assert.equal(plan.tickerRight, 70, 'the ticker keeps its right end clear of the launcher');
  assert.ok(plan.audioRight > LAUNCHER.right + LAUNCHER.width, 'stop button (right end of the player) is left of the launcher');
  assert.equal(plan.reserve, 159);
  assert.equal(plan.overlayReserve, 105, 'sheets and drawers clear the mini player and the launcher');
});

test('on a wide window the dock shares the mini player row, which keeps short windows usable; a phone stacks them', () => {
  const wide = planFloatingControls({ ticker: TICKER, audio: AUDIO, voice: VOICE, launcher: LAUNCHER, viewportWidth: 1209 });
  assert.equal(wide.voiceBottom, wide.audioBottom);
  assert.equal(wide.voiceRight, 70 + 330 + 8, 'left of the mini player, which is left of the launcher');
  assert.equal(wide.reserve, 45 + 52 + 8);
  const phone = planFloatingControls({ ticker: TICKER, audio: AUDIO, voice: VOICE, launcher: LAUNCHER, viewportWidth: 390 });
  assert.equal(phone.voiceBottom, 105);
  assert.equal(phone.reserve, 159);
  const exact = 70 + 330 + 8 + VOICE.width + 12;
  assert.equal(planFloatingControls({ ticker: TICKER, audio: AUDIO, voice: VOICE, launcher: LAUNCHER, viewportWidth: exact }).voiceBottom, 45);
  assert.equal(planFloatingControls({ ticker: TICKER, audio: AUDIO, voice: VOICE, launcher: LAUNCHER, viewportWidth: exact - 1 }).voiceBottom, 105);
});

test('with no audio the dock takes the low slot and steps around the launcher; every stack keeps the launcher inside the reserve', () => {
  const plan = planFloatingControls({ ticker: TICKER, voice: VOICE, launcher: LAUNCHER });
  assert.equal(plan.voiceBottom, 45);
  assert.equal(plan.voiceRight, 70);
  assert.equal(plan.reserve, 99);
  assert.equal(plan.overlayReserve, 70);
  const collapsedDockOnly = planFloatingControls({ ticker: TICKER, voice: { width: 40, height: 30 }, launcher: { ...LAUNCHER, bottom: 120 } });
  assert.equal(collapsedDockOnly.reserve, 120 + 48 + 8, 'a launcher placed higher still counts');
  assert.equal(collapsedDockOnly.tickerRight, 0, 'a launcher above the ticker leaves it alone');
  assert.deepEqual(planFloatingControls({}), { audioBottom: 8, audioRight: 12, voiceBottom: 8, voiceRight: 12, tickerRight: 0, reserve: 8, overlayReserve: 0 });
});

test('registered controls and the injected launcher are measured into CSS variables, and the plan follows them away', async t => {
  const sizes = new Map<Element, { width: number; height: number }>();
  t.mock.getter(HTMLElement.prototype, 'offsetHeight', function (this: HTMLElement) { return sizes.get(this)?.height ?? 0; });
  t.mock.getter(HTMLElement.prototype, 'offsetWidth', function (this: HTMLElement) { return sizes.get(this)?.width ?? 0; });
  const make = (size: { width: number; height: number }) => { const el = document.createElement('div'); document.body.append(el); sizes.set(el, size); return el; };
  const ticker = make({ width: 1400, height: TICKER }); const audio = make(AUDIO); const voice = make(VOICE);
  const offTicker = registerFloatingControl('ticker', ticker); const offAudio = registerFloatingControl('audio', audio); const offVoice = registerFloatingControl('voice', voice);
  const host = document.createElement('div'); host.id = FEEDBACK_LAUNCHER_HOST_ID;
  const launcher = document.createElement('button'); launcher.className = 'launcher';
  launcher.setAttribute('style', 'position: fixed; bottom: 14px; right: 14px; width: 48px; height: 48px');
  host.attachShadow({ mode: 'open' }).append(launcher); sizes.set(launcher, { width: 48, height: 48 });
  t.after(() => { offTicker(); offAudio(); offVoice(); host.remove(); ticker.remove(); audio.remove(); voice.remove(); });

  measureFloatingControls();
  assert.equal(rootVar('--nexus-audio-right'), '12px');
  assert.equal(rootVar('--nexus-floating-bottom'), '159px');
  assert.equal(document.documentElement.style.scrollPaddingBottom, '159px', 'focus scrolls targets clear of the stack');
  document.body.append(host);
  measureFloatingControls();
  assert.equal(rootVar('--nexus-audio-right'), '70px', 'the mini player steps left of the launcher once the shell injects it');
  assert.equal(rootVar('--nexus-ticker-right'), '70px');
  assert.equal(rootVar('--nexus-floating-overlay-bottom'), '105px');
  host.remove();
  offAudio();
  measureFloatingControls();
  assert.equal(rootVar('--nexus-voice-bottom'), '45px', 'the dock drops to the low slot when the audio is dismissed');
  assert.equal(rootVar('--nexus-audio-right'), '12px');
  assert.equal(rootVar('--nexus-floating-bottom'), '99px');
});

test('the voice dock registers itself and takes its position from the plan', async t => {
  const module = await import('../../components/global-voice-dock');
  localStorage.clear(); setPathname('/');
  t.mock.method(globalThis, 'fetch', async (input: unknown) => String(input).includes('board') ? Response.json([]) : Response.json({ available: true }));
  t.mock.getter(HTMLElement.prototype, 'offsetHeight', function (this: HTMLElement) { return this.getAttribute('aria-label') === 'Global voice controls' ? 46 : 0; });
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await act(async () => { root.render(React.createElement(module.GlobalVoiceDock)); await tick(); });
  const dock = host.querySelector('[aria-label="Global voice controls"]') as HTMLElement;
  assert.equal(dock.style.bottom, 'var(--nexus-voice-bottom, 3rem)');
  assert.equal(dock.style.right, 'var(--nexus-voice-right, 0.75rem)');
  assert.doesNotMatch(dock.className, /\bbottom-12\b|\bright-3\b/);
  assert.equal(measureFloatingControls().reserve, 8 + 46 + 8, 'the mounted dock is counted');
  await act(async () => root.unmount());
  assert.equal(measureFloatingControls().reserve, 8, 'and released on unmount');
});

test('the review page keeps Finish review above the floating controls on desktop, phone and at every display scale', () => {
  const review = readFileSync(new URL('../../components/document-review/document-review.tsx', import.meta.url), 'utf8');
  const sticky = review.match(/"sticky top-\[var\(--review-rail-top,6rem\)\] [^"]*"/g) ?? [];
  assert.equal(sticky.length, 1, 'the rails stick where they start, below the measured header');
  assert.match(sticky[0], /max-h-\[max\(8rem,calc\(100vh\/var\(--nexus-display-scale,1\)-var\(--review-rail-top,6rem\)-var\(--nexus-floating-bottom,6rem\)\)\)\]/);
  assert.equal((review.match(/className=\{`\$\{railPosition\} /g) ?? []).length, 2, 'outline and review rails share the position');
  // Short of 8rem between the header and the floating controls, the rails scroll with the page (QA round 1: 389px at 125% and 150%).
  assert.match(review, /root\.clientHeight \/ zoom - \(headerHeight \+ 1\.25 \* rem\) - reserve < 8 \* rem/);
  assert.match(review, /const railPosition = railsFlow\s+\? "\[&_\*\]:scroll-mt-\[var\(--review-rail-top,6rem\)\]"\s+: "sticky /);
  assert.match(review, /"--review-rail-top": `calc\(\$\{headerHeight\}px \+ 1\.25rem\)`/, 'rail top = header height + the grid padding above the rails');
  assert.match(review, /<header ref=\{headerRef\} className="sticky top-0/);
  for (const marker of ['data-composer-sheet=""', 'data-review-drawer=""']) {
    const line = review.split('\n').find(l => l.includes(marker)) ?? '';
    assert.match(line, /pb-\[max\([\d.]+rem,var\(--nexus-floating-overlay-bottom,0px\)\)\]/, `${marker} pads past the mini player and launcher`);
  }
  // Under body zoom a bare vh is the window height times the scale: a bottom sheet would push its close button off the top.
  assert.doesNotMatch(review, /max-h-\[\d+vh\]|max-h-\[calc\(100vh-/);
  const layout = readFileSync(new URL('../../app/layout.tsx', import.meta.url), 'utf8');
  assert.match(layout, /paddingBottom: 'max\(7rem, var\(--nexus-floating-bottom, 0px\)\)'/, 'page ends scroll past the stack');
  const cortex = readFileSync(new URL('../../components/cortex-provider.tsx', import.meta.url), 'utf8');
  assert.match(cortex, /ref=\{floatingControlRef\("audio"\)\}/);
  assert.doesNotMatch(cortex, /fixed bottom-4 right-4 z-\[90\]/, 'the mini player no longer has its own fixed corner');
  const ticker = readFileSync(new URL('../../components/bridge/event-ticker.tsx', import.meta.url), 'utf8');
  assert.match(ticker, /ref=\{floatingControlRef\("ticker"\)\}/);
  // The dock's popovers grow up and left from the dock, so their limits follow where the plan put it.
  const bar = readFileSync(new URL('../../components/bridge/voice-command-bar.tsx', import.meta.url), 'utf8');
  const popovers = bar.match(/absolute right-0 bottom-full[^"]*/g) ?? [];
  assert.equal(popovers.length, 2);
  for (const popover of popovers) {
    assert.match(popover, /max-w-\[calc\(100vw\/var\(--nexus-display-scale,1\)-var\(--nexus-voice-right,0\.75rem\)-1\.5rem\)\]/);
    assert.match(popover, /max-h-\[calc\(100dvh\/var\(--nexus-display-scale,1\)-var\(--nexus-voice-bottom,3rem\)-5rem\)\]/);
  }
});

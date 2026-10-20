/**
 * Space planning for the controls that float over the bottom of every page.
 *
 * The event ticker, the audio mini player, the voice dock and (in the travel
 * shell on https pages) the Praxis feedback launcher are all fixed to the
 * bottom right. Each was placed on its own, so they stacked on top of one
 * another and over whatever the page had down there: on 2026-10-19 they hid
 * "Finish review" at the bottom of the document review rail, and the feedback
 * launcher sat on the mini player's stop button (task 7fe1005f).
 *
 * The plan puts the mini player just above the ticker and the dock beside it
 * when the row has room (above it otherwise, as on a phone), steps either one
 * left of the feedback launcher when they would overlap it, and
 * publishes the height they take as CSS variables so pages keep their own
 * controls above them:
 *
 *   --nexus-floating-bottom          bottom space covered by all of them
 *   --nexus-floating-overlay-bottom  the part that stays over sheets and drawers (mini player, launcher)
 *   --nexus-audio-bottom / -right, --nexus-voice-bottom / -right, --nexus-ticker-right
 *
 * Values are CSS px in the zoomed body's own units (offset sizes and computed
 * insets), so they stay correct at every display scale. This module holds no
 * React components on purpose: root-layout modules must stay Fast Refresh
 * boundaries (see voice-dock-preferences.ts).
 */

export type FloatingControlKind = "ticker" | "audio" | "voice";

export interface FloatingBox {
  width: number;
  height: number;
}

/** The feedback launcher's box, measured from its right and bottom edges. */
export interface LauncherBox extends FloatingBox {
  right: number;
  bottom: number;
}

export interface FloatingPlan {
  audioBottom: number;
  audioRight: number;
  voiceBottom: number;
  voiceRight: number;
  tickerRight: number;
  reserve: number;
  overlayReserve: number;
}

/** Space between stacked controls and above the last one. */
export const FLOATING_GAP = 8;
/** Distance of the stack from the right edge of the viewport. */
export const FLOATING_EDGE = 12;
/** The feedback widget's host element (vibeshiftai feedback-widget, injected by the travel shell). */
export const FEEDBACK_LAUNCHER_HOST_ID = "praxis-feedback-host";

export function planFloatingControls({
  ticker = 0,
  audio = null,
  voice = null,
  launcher = null,
  viewportWidth = 0,
}: {
  ticker?: number;
  audio?: FloatingBox | null;
  voice?: FloatingBox | null;
  launcher?: LauncherBox | null;
  /** Layout width of the page; when the dock fits beside the mini player it shares its row, which saves height on short windows. */
  viewportWidth?: number;
}): FloatingPlan {
  const launcherTop = launcher ? launcher.bottom + launcher.height : 0;
  const clearOfLauncher = launcher ? launcher.right + launcher.width + FLOATING_GAP : FLOATING_EDGE;
  const overlapsLauncher = (bottom: number, height: number) =>
    !!launcher && bottom < launcherTop && launcher.bottom < bottom + height;
  const rightFor = (bottom: number, height: number) => (overlapsLauncher(bottom, height) ? clearOfLauncher : FLOATING_EDGE);

  const row = ticker + FLOATING_GAP;
  let next = row;
  const audioBottom = row;
  const audioRight = audio ? rightFor(audioBottom, audio.height) : FLOATING_EDGE;
  if (audio) next += audio.height + FLOATING_GAP;
  let voiceBottom = next;
  let voiceRight = voice ? rightFor(voiceBottom, voice.height) : FLOATING_EDGE;
  const besideAudio = audio ? audioRight + audio.width + FLOATING_GAP : 0;
  if (audio && voice && besideAudio + voice.width + FLOATING_EDGE <= viewportWidth) {
    voiceBottom = row;
    voiceRight = besideAudio;
    next = row + Math.max(audio.height, voice.height) + FLOATING_GAP;
  } else if (voice) {
    next += voice.height + FLOATING_GAP;
  }

  const launcherReserve = launcher ? launcherTop + FLOATING_GAP : 0;
  const overlayReserve = Math.max(audio ? audioBottom + audio.height + FLOATING_GAP : 0, launcherReserve);
  return {
    audioBottom,
    audioRight,
    voiceBottom,
    voiceRight,
    tickerRight: launcher && launcher.bottom < ticker ? clearOfLauncher : 0,
    reserve: Math.ceil(Math.max(next, ticker, overlayReserve)),
    overlayReserve: Math.ceil(overlayReserve),
  };
}

export function floatingControlVariables(plan: FloatingPlan): Record<string, string> {
  const px = (n: number) => `${Math.ceil(n)}px`;
  return {
    "--nexus-floating-bottom": px(plan.reserve),
    "--nexus-floating-overlay-bottom": px(plan.overlayReserve),
    "--nexus-audio-bottom": px(plan.audioBottom),
    "--nexus-audio-right": px(plan.audioRight),
    "--nexus-voice-bottom": px(plan.voiceBottom),
    "--nexus-voice-right": px(plan.voiceRight),
    "--nexus-ticker-right": px(plan.tickerRight),
  };
}

/** The launcher when it is on the page and anchored to the right; a left-hand launcher shares no space with the stack. */
export function measureFeedbackLauncher(doc: Document): LauncherBox | null {
  const launcher = doc.getElementById(FEEDBACK_LAUNCHER_HOST_ID)?.shadowRoot?.querySelector<HTMLElement>(".launcher");
  if (!launcher || !launcher.isConnected || !launcher.offsetWidth) return null;
  const style = doc.defaultView?.getComputedStyle(launcher);
  const right = parseFloat(style?.right ?? "");
  const bottom = parseFloat(style?.bottom ?? "");
  const left = parseFloat(style?.left ?? "");
  if (!Number.isFinite(right) || !Number.isFinite(bottom) || (Number.isFinite(left) && left < right)) return null;
  return { right, bottom, width: launcher.offsetWidth, height: launcher.offsetHeight };
}

const controls = new Map<FloatingControlKind, HTMLElement>();
const refs = new Map<FloatingControlKind, (el: HTMLElement | null) => (() => void) | undefined>();
let resizeObserver: ResizeObserver | null = null;
let started = false;
let frame = 0;

/** Measure the registered controls and the launcher now and publish the plan. */
export function measureFloatingControls(doc: Document = document): FloatingPlan {
  if (frame) {
    doc.defaultView?.cancelAnimationFrame(frame);
    frame = 0;
  }
  // scrollWidth: a dock squeezed by its max-width still reports the room it needs.
  const box = (kind: FloatingControlKind): FloatingBox | null => {
    const el = controls.get(kind);
    return el && el.isConnected && el.offsetHeight ? { width: Math.max(el.offsetWidth, el.scrollWidth), height: el.offsetHeight } : null;
  };
  // Offset sizes are in the zoomed body's units; the viewport is not, so divide it by the display scale.
  const zoom = parseFloat(doc.defaultView?.getComputedStyle(doc.body).zoom ?? "") || 1;
  const plan = planFloatingControls({
    ticker: box("ticker")?.height ?? 0,
    audio: box("audio"),
    voice: box("voice"),
    launcher: measureFeedbackLauncher(doc),
    viewportWidth: doc.documentElement.clientWidth / zoom,
  });
  const root = doc.documentElement.style;
  for (const [name, value] of Object.entries(floatingControlVariables(plan))) {
    if (root.getPropertyValue(name) !== value) root.setProperty(name, value);
  }
  // Focus and scrollIntoView keep their target above the stack. The page scroller is outside the body zoom, so window px.
  const padding = `${Math.ceil(plan.reserve * zoom)}px`;
  if (root.scrollPaddingBottom !== padding) root.scrollPaddingBottom = padding;
  return plan;
}

function schedule() {
  if (frame || typeof window === "undefined") return;
  frame = window.requestAnimationFrame(() => {
    frame = 0;
    measureFloatingControls();
  });
}

function start() {
  if (started || typeof window === "undefined") return;
  started = true;
  if (typeof ResizeObserver !== "undefined") resizeObserver = new ResizeObserver(schedule);
  // The travel shell adds the launcher's host to <body> after load, and PraxisFeedback.hide() removes it; the display
  // scale arrives as a style property on <body> and changes the viewport's width in body units.
  new MutationObserver(schedule).observe(document.body, { childList: true, attributes: true, attributeFilter: ["style"] });
  window.addEventListener("resize", schedule);
}

/** Track one floating control's size for the plan; returns the matching unregister. */
export function registerFloatingControl(kind: FloatingControlKind, el: HTMLElement): () => void {
  start();
  controls.set(kind, el);
  resizeObserver?.observe(el);
  schedule();
  return () => {
    if (controls.get(kind) === el) controls.delete(kind);
    resizeObserver?.unobserve(el);
    schedule();
  };
}

/** A stable ref callback (React 19 runs its returned cleanup on detach), so re-renders do not re-register. */
export function floatingControlRef(kind: FloatingControlKind) {
  let ref = refs.get(kind);
  if (!ref) {
    ref = (el: HTMLElement | null) => (el ? registerFloatingControl(kind, el) : undefined);
    refs.set(kind, ref);
  }
  return ref;
}

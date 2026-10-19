/**
 * Voice dock preferences that live outside the dock component.
 *
 * `global-voice-dock.tsx` is imported by the root layout. React Fast Refresh
 * only hot-swaps a module whose exports are all components; one plain
 * constant export there turns every save of that file into a full reload of
 * every open dashboard page, which on 2026-10-19 erased the comment Robert was
 * typing on a document review (task 1390fc34). Keep non-component values here.
 */

/** localStorage key remembering whether the voice bar is collapsed to its pip. */
export const VOICE_DOCK_COLLAPSED_KEY = "nexus.voice.dock.collapsed";

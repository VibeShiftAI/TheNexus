"use client";

import { Mic } from 'lucide-react';
import { VOICE_SETUP_EVENT } from '@/lib/voice-input';

/** Opens the single global voice owner; opening setup never starts capture. */
export function VoiceLauncher() {
  return <button
    type="button"
    onClick={() => window.dispatchEvent(new window.Event(VOICE_SETUP_EVENT))}
    aria-label="Talk to Praxis"
    aria-keyshortcuts="Alt+Shift+V"
    title="Talk to Praxis — voice setup (Alt+Shift+V)"
    className="flex shrink-0 items-center gap-1.5 rounded-lg border border-cyan-400/50 bg-cyan-500/15 px-3 py-2 text-xs font-semibold text-cyan-200 transition-colors hover:bg-cyan-500/25 focus-visible:outline-2 focus-visible:outline-cyan-300"
  >
    <Mic size={15} aria-hidden="true" />
    <span>Talk to Praxis</span>
  </button>;
}

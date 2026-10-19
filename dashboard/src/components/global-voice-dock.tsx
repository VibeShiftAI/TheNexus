"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { ChevronLeft, ChevronRight, Mic } from "lucide-react";
import { VoiceCommandBar } from "@/components/bridge/voice-command-bar";
import { VOICE_SETUP_EVENT } from "@/lib/voice-input";

export const VOICE_DOCK_COLLAPSED_KEY = "nexus.voice.dock.collapsed";

/** Root placement preserves capture and playback across client navigation. */
export function GlobalVoiceDock() {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    try { setCollapsed(window.localStorage.getItem(VOICE_DOCK_COLLAPSED_KEY) === "1"); } catch { /* session preference */ }
  }, []);
  const toggle = (next: boolean) => {
    setCollapsed(next);
    try { window.localStorage.setItem(VOICE_DOCK_COLLAPSED_KEY, next ? "1" : "0"); } catch { /* session preference */ }
  };
  // Setup (launcher or Alt+Shift+V) opens a popover inside the bar, so it must be visible.
  useEffect(() => {
    const expand = () => setCollapsed(false);
    window.addEventListener(VOICE_SETUP_EVENT, expand);
    return () => window.removeEventListener(VOICE_SETUP_EVENT, expand);
  }, []);
  if (pathname === "/login" || pathname?.startsWith("/login/")) return null;
  return (
    <div aria-label="Global voice controls" role="region" className="fixed bottom-12 right-3 z-50 flex max-w-[calc(100vw/var(--nexus-display-scale,1)-1.5rem)] items-center gap-1 rounded-xl border border-slate-700/70 bg-slate-950/95 p-1.5 shadow-xl backdrop-blur-md">
      <button
        type="button"
        onClick={() => toggle(!collapsed)}
        aria-expanded={!collapsed}
        aria-controls="global-voice-bar"
        aria-label={collapsed ? "Expand voice controls" : "Collapse voice controls"}
        title={collapsed ? "Show voice controls" : "Hide voice controls"}
        className={`flex shrink-0 items-center rounded-lg border text-cyan-400 transition-colors hover:text-cyan-200 focus-visible:outline-2 focus-visible:outline-cyan-300 ${collapsed ? "gap-0.5 border-cyan-500/30 bg-cyan-500/10 px-1.5 py-1.5" : "self-stretch border-transparent px-0.5 text-slate-500 hover:bg-slate-800/60"}`}
      >
        {collapsed ? <><ChevronLeft size={12} aria-hidden="true" /><Mic size={14} aria-hidden="true" /></> : <ChevronRight size={12} aria-hidden="true" />}
      </button>
      <div
        id="global-voice-bar"
        data-collapsed={collapsed ? "true" : "false"}
        className={`transition-[max-width,opacity,visibility] duration-200 ease-out ${collapsed ? "invisible max-h-0 max-w-0 overflow-hidden opacity-0" : "visible max-w-[100vw] opacity-100"}`}
      >
        <VoiceCommandBar />
      </div>
    </div>
  );
}

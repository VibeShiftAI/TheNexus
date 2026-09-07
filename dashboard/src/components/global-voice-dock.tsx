"use client";

import { usePathname } from "next/navigation";
import { VoiceCommandBar } from "@/components/bridge/voice-command-bar";

/** Root placement preserves capture and playback across client navigation. */
export function GlobalVoiceDock() {
  const pathname = usePathname();
  if (pathname === "/login" || pathname?.startsWith("/login/")) return null;
  return (
    <div aria-label="Global voice controls" role="region" className="fixed bottom-12 right-3 z-50 max-w-[calc(100vw/var(--nexus-display-scale,1)-1.5rem)] rounded-xl border border-slate-700/70 bg-slate-950/95 p-1.5 shadow-xl backdrop-blur-md">
      <VoiceCommandBar />
    </div>
  );
}

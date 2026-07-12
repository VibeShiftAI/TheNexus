"use client"

import { useEffect, useState } from "react";

/**
 * The travel shell's tab strip, hosted inside the bridge header so the
 * Windows app shows ONE header (hamburger · logo · tabs · controls) instead
 * of stacking the native strip above the dashboard's own.
 *
 * The shell injects `window.__NEXUS_SHELL__` ({ tabs, active }) via a
 * webview initialization script and hides its native strip while the bridge
 * is the active tab. Clicks navigate to /__shell/switch/<id>, which the
 * shell's on_navigation hook intercepts (and cancels) to switch webviews —
 * remote pages deliberately get no Tauri IPC. In a normal browser (or the
 * Mac app) the global is absent and this renders nothing.
 */

type ShellTab = { id: string; label: string; accent: string };

declare global {
  interface Window {
    __NEXUS_SHELL__?: { tabs: ShellTab[]; active: string };
  }
}

export function ShellTabs() {
  const [tabs, setTabs] = useState<ShellTab[]>([]);
  const [active, setActive] = useState("");

  useEffect(() => {
    const shell = window.__NEXUS_SHELL__;
    if (!shell || !Array.isArray(shell.tabs) || shell.tabs.length === 0) return;
    setTabs(shell.tabs);
    setActive(shell.active || shell.tabs[0].id);

    // The shell evals a `nexus-shell-active` event on every switch so the
    // highlight tracks switches made from the native strip too.
    const onActive = (event: Event) => {
      const id = (event as CustomEvent<string>).detail;
      if (typeof id === "string") setActive(id);
    };
    window.addEventListener("nexus-shell-active", onActive);
    return () => window.removeEventListener("nexus-shell-active", onActive);
  }, []);

  if (tabs.length === 0) return null;

  return (
    <nav
      aria-label="Shell tabs"
      className="flex items-center gap-1.5 overflow-x-auto px-2 min-w-0"
    >
      {tabs.map((tab) => {
        const isActive = tab.id === active;
        return (
          <button
            key={tab.id}
            onClick={() => {
              setActive(tab.id);
              // Real navigation attempt on purpose — the shell cancels it
              // and switches webviews natively.
              window.location.href = `/__shell/switch/${tab.id}`;
            }}
            className="flex shrink-0 items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[11px] font-semibold tracking-wider transition-all"
            style={
              isActive
                ? {
                    color: tab.accent,
                    borderColor: `${tab.accent}59`,
                    background: `${tab.accent}14`,
                    boxShadow: `0 0 14px ${tab.accent}26`,
                  }
                : { color: "#64748b", borderColor: "transparent" }
            }
          >
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{ background: "currentcolor", opacity: isActive ? 1 : 0.5 }}
            />
            {tab.label}
          </button>
        );
      })}
    </nav>
  );
}

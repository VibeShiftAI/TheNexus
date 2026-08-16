/**
 * AmbientMode — the bridge as a screensaver. A fullscreen overlay with the
 * living core, a large clock, presence summary, and the latest stream event.
 * Holds a Screen Wake Lock while active so the display stays on, and
 * auto-activates after a configurable idle period (screensaver replacement).
 *
 * Exit: click or any key. Idle auto-activation and manual toggle both live
 * here; the setting persists in localStorage.
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MonitorPlay } from "lucide-react";
import { usePraxisStream } from "@/hooks/use-praxis-stream";
import { useCoreState } from "@/hooks/use-core-state";
import { useTokenUsage } from "@/hooks/use-token-usage";
import { fmtTokens } from "@/lib/token-usage";
import { CoreCanvas } from "@/components/bridge/core-canvas";

const IDLE_KEY = "nexus.ambient.idleMinutes"; // "0" disables auto-activation
const DEFAULT_IDLE_MINUTES = 10;

type WakeLockSentinel = { release: () => Promise<void>; addEventListener?: (t: string, cb: () => void) => void };

export function getAmbientIdleMinutes(): number {
  if (typeof window === "undefined") return DEFAULT_IDLE_MINUTES;
  const raw = window.localStorage.getItem(IDLE_KEY);
  if (raw == null) return DEFAULT_IDLE_MINUTES;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_IDLE_MINUTES;
}

export function setAmbientIdleMinutes(minutes: number) {
  window.localStorage.setItem(IDLE_KEY, String(minutes));
}

export function AmbientMode() {
  const { presence, recentEvents } = usePraxisStream();
  const core = useCoreState();
  const { usage } = useTokenUsage();
  const [active, setActive] = useState(false);
  const [clock, setClock] = useState("");
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const lastInputRef = useRef(Date.now());
  const mouseTravelRef = useRef(0);

  const latestLine = recentEvents.find((e) => e.type === "presence.changed" || e.type === "executor.progress" || e.type === "task.completed");

  // Clock tick while active
  useEffect(() => {
    if (!active) return;
    const update = () =>
      setClock(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
    update();
    const t = setInterval(update, 5_000);
    return () => clearInterval(t);
  }, [active]);

  // Screen wake lock while active (keeps the display on — screensaver duty)
  useEffect(() => {
    if (!active) return;
    let released = false;
    const acquire = async () => {
      try {
        const nav = navigator as Navigator & { wakeLock?: { request: (t: "screen") => Promise<WakeLockSentinel> } };
        if (!nav.wakeLock) return;
        const sentinel = await nav.wakeLock.request("screen");
        if (released) {
          sentinel.release().catch(() => {});
          return;
        }
        wakeLockRef.current = sentinel;
      } catch {
        /* wake lock denied (battery saver etc.) — ambient still renders */
      }
    };
    acquire();
    // Re-acquire when the tab becomes visible again (lock auto-releases on hide)
    const onVisibility = () => {
      if (document.visibilityState === "visible" && active) acquire();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      released = true;
      document.removeEventListener("visibilitychange", onVisibility);
      wakeLockRef.current?.release().catch(() => {});
      wakeLockRef.current = null;
    };
  }, [active]);

  const exit = useCallback(() => {
    mouseTravelRef.current = 0;
    lastInputRef.current = Date.now();
    setActive(false);
  }, []);

  // Exit handlers: click, key, or sustained mouse travel (not a single jitter)
  useEffect(() => {
    if (!active) return;
    const onKey = () => exit();
    const onClick = () => exit();
    const onMove = (e: MouseEvent) => {
      mouseTravelRef.current += Math.abs(e.movementX) + Math.abs(e.movementY);
      if (mouseTravelRef.current > 120) exit();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onClick);
    window.addEventListener("mousemove", onMove);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onClick);
      window.removeEventListener("mousemove", onMove);
    };
  }, [active, exit]);

  // Idle auto-activation
  useEffect(() => {
    if (active) return;
    const markInput = () => {
      lastInputRef.current = Date.now();
    };
    window.addEventListener("mousemove", markInput);
    window.addEventListener("keydown", markInput);
    window.addEventListener("mousedown", markInput);
    window.addEventListener("scroll", markInput, true);
    const t = setInterval(() => {
      const idleMinutes = getAmbientIdleMinutes();
      if (idleMinutes <= 0) return;
      if (Date.now() - lastInputRef.current >= idleMinutes * 60_000) {
        mouseTravelRef.current = 0;
        setActive(true);
      }
    }, 15_000);
    return () => {
      window.removeEventListener("mousemove", markInput);
      window.removeEventListener("keydown", markInput);
      window.removeEventListener("mousedown", markInput);
      window.removeEventListener("scroll", markInput, true);
      clearInterval(t);
    };
  }, [active]);

  const stats = (
    [
      { label: "scheduled", value: presence?.scheduledTaskCount },
      { label: "done today", value: presence?.completedTasksToday },
      { label: "tokens today", value: usage ? fmtTokens(usage.today.total) : undefined },
    ] as { label: string; value: number | string | null | undefined }[]
  ).filter((s): s is { label: string; value: number | string } => s.value != null);

  return (
    <>
      <button
        onClick={() => {
          mouseTravelRef.current = 0;
          setActive(true);
        }}
        className="p-1.5 rounded-lg border border-slate-800 bg-slate-900/50 hover:bg-slate-800 text-slate-400 hover:text-white transition-all"
        aria-label="Enter ambient mode"
        title="Ambient mode (screensaver)"
      >
        <MonitorPlay size={18} />
      </button>

      {/* Portal to <body>: the header's backdrop-filter creates a containing
          block, which would trap a fixed overlay inside the 64px header. */}
      {active && typeof document !== "undefined" && createPortal(
        <div className="fixed inset-0 z-[100] flex cursor-none flex-col items-center justify-center bg-black">
          <div className="text-7xl font-bold tabular-nums tracking-tight text-slate-200">{clock}</div>
          <div className="mt-1 text-sm text-slate-500">
            {new Date().toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}
          </div>

          <div className="my-8">
            <CoreCanvas state={core} size={340} />
          </div>

          <div className={`text-xl font-semibold ${core.textClass}`}>{core.label}</div>
          <div className="mt-1 max-w-lg truncate px-6 text-sm text-slate-500">
            {core.council ? core.council.topic : presence?.summary ?? "—"}
          </div>
          {core.workers.filter((w) => w.state === "active").length > 0 && (
            <div className="mt-1 text-xs text-slate-600">
              {core.workers
                .filter((w) => w.state === "active")
                .map((w) => w.label)
                .join(" · ")}{" "}
              working
            </div>
          )}

          {stats.length > 0 && (
            <div className="mt-6 flex gap-8">
              {stats.map((s) => (
                <div key={s.label} className="text-center">
                  <div className="text-2xl font-bold tabular-nums text-slate-300">{s.value}</div>
                  <div className="text-[10px] uppercase tracking-widest text-slate-600">{s.label}</div>
                </div>
              ))}
            </div>
          )}

          <div className="absolute bottom-6 max-w-3xl truncate px-6 font-mono text-[11px] text-slate-700">
            {latestLine ? `${new Date(latestLine.at).toLocaleTimeString()} · ${latestLine.type}` : "standing by"}
          </div>
        </div>,
        document.body
      )}
    </>
  );
}

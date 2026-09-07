"use client";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { Minus, Plus, RotateCcw, Type } from "lucide-react";
import { HudModal } from "@/components/bridge/hud";
const KEY = "nexus.displayScale";
const MIN = 0.8,
  MAX = 1.5;
function normalize(value: number) {
  return Number.isFinite(value)
    ? Math.min(MAX, Math.max(MIN, Math.round(value * 100) / 100))
    : 1;
}
const Context = createContext({ scale: 1, setScale: (_value: number) => {} });
export function DisplayScaleProvider({ children }: { children: ReactNode }) {
  const [scale, update] = useState(1);
  useEffect(() => {
    const apply = (value: number) => {
      const next = normalize(value);
      update(next);
      document.body.style.setProperty("--nexus-display-scale", String(next));
    };
    try {
      const saved = localStorage.getItem(KEY);
      if (saved !== null) apply(Number(saved));
    } catch {
      /* Settings still work without storage. */
    }
    const sync = (e: StorageEvent) => {
      if (e.key === KEY) apply(e.newValue === null ? 1 : Number(e.newValue));
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);
  const setScale = (value: number) => {
    const next = normalize(value);
    update(next);
    document.body.style.setProperty("--nexus-display-scale", String(next));
    try {
      localStorage.setItem(KEY, String(next));
    } catch {}
  };
  return (
    <Context.Provider value={{ scale, setScale }}>{children}</Context.Provider>
  );
}
export function DisplayScaleControl({ full = false }: { full?: boolean }) {
  const { scale, setScale } = useContext(Context);
  const [open, setOpen] = useState(false);
  const controls = (
    <div className="space-y-5">
      <p className="text-sm leading-relaxed text-slate-300">
        One master control for text, labels, charts, and controls throughout
        Nexus. Saved in this browser, so your laptop and monitor can use
        different sizes. Inbox sizing still lets you fine-tune the inbox.
      </p>
      <div className="flex items-center justify-center gap-5">
        <button
          type="button"
          aria-label="Smaller dashboard text"
          disabled={scale <= MIN}
          onClick={() => setScale(scale - 0.05)}
          className="rounded-lg border border-slate-600 p-3 hover:bg-slate-800 disabled:opacity-30"
        >
          <Minus size={20} />
        </button>
        <output
          className="min-w-24 text-center text-3xl font-semibold tabular-nums text-white"
          aria-live="polite"
        >
          {Math.round(scale * 100)}%
        </output>
        <button
          type="button"
          aria-label="Larger dashboard text"
          disabled={scale >= MAX}
          onClick={() => setScale(scale + 0.05)}
          className="rounded-lg border border-slate-600 p-3 hover:bg-slate-800 disabled:opacity-30"
        >
          <Plus size={20} />
        </button>
      </div>
      <label className="block text-xs text-slate-400">
        Master text and display size
        <input
          aria-label="Master text and display size"
          type="range"
          min="80"
          max="150"
          step="5"
          value={Math.round(scale * 100)}
          onChange={(e) => setScale(Number(e.target.value) / 100)}
          className="mt-3 block w-full accent-cyan-300"
        />
      </label>
      <div className="grid grid-cols-3 gap-2">
        {[
          { label: "Laptop", value: 0.9 },
          { label: "Standard", value: 1 },
          { label: "Big monitor", value: 1.25 },
        ].map((p) => (
          <button
            key={p.label}
            type="button"
            aria-pressed={scale === p.value}
            onClick={() => setScale(p.value)}
            className={`rounded-lg border px-2 py-2 text-xs ${scale === p.value ? "border-cyan-300 bg-cyan-300/10 text-cyan-200" : "border-slate-700 text-slate-300 hover:border-slate-400"}`}
          >
            {p.label}
            <span className="mt-1 block text-slate-400">{p.value * 100}%</span>
          </button>
        ))}
      </div>
      <button
        type="button"
        aria-label="Reset display size"
        onClick={() => setScale(1)}
        className="flex items-center gap-2 text-xs text-cyan-300"
      >
        <RotateCcw size={13} /> Reset to 100%
      </button>
    </div>
  );
  if (full) return controls;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Text and display size"
        title="Master text and display size"
        className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-slate-600 bg-slate-900 px-2 py-1 text-xs font-medium tabular-nums text-cyan-200 hover:border-cyan-300"
      >
        <Type size={14} />
        {Math.round(scale * 100)}%
      </button>
      {open && (
        <HudModal
          title="Text & display size"
          icon={<Type size={17} />}
          onClose={() => setOpen(false)}
        >
          {controls}
        </HudModal>
      )}
    </>
  );
}

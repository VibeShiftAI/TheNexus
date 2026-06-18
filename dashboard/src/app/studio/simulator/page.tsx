"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Atom, Loader2, Orbit, Pause, Play, RotateCcw } from "lucide-react";
import { getBoard, type SpaceObject } from "@/lib/studio";
import NbodyView from "./NbodyView";
import KeplerView from "./KeplerView";

type Mode = "tour" | "interaction";

export default function SimulatorPage() {
  const [channelId, setChannelId] = useState("praxis-youtube");
  const [objects, setObjects] = useState<SpaceObject[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("tour");
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [remountKey, setRemountKey] = useState(0);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const cid = params.get("channelId") || "praxis-youtube";
    setChannelId(cid);
    const ids = (params.get("objects") || "").split(",").map((s) => s.trim()).filter(Boolean);
    getBoard(cid)
      .then((board) => {
        const byId = new Map(board.objects.map((o) => [o.id, o]));
        const picked = ids.map((id) => byId.get(id)).filter(Boolean) as SpaceObject[];
        setObjects(picked);
        if (!picked.length) setError("No valid objects in the selection.");
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load objects"));
  }, []);

  const ready = objects && objects.length > 0;

  return (
    <main className="flex h-screen flex-col bg-slate-950 text-slate-200">
      <header className="flex flex-wrap items-center gap-3 border-b border-slate-800 px-6 py-3">
        <Link href={`/studio/catalog?channelId=${encodeURIComponent(channelId)}`} className="rounded-full p-2 text-slate-400 hover:bg-slate-800 hover:text-white"><ArrowLeft size={20} /></Link>
        <h1 className="text-lg font-bold text-white">Planetary Simulator</h1>

        {/* Mode toggle */}
        <div className="flex overflow-hidden rounded-lg border border-slate-700">
          <button onClick={() => setMode("tour")} className={`inline-flex h-9 items-center gap-1.5 px-3 text-sm font-semibold ${mode === "tour" ? "bg-cyan-700 text-white" : "bg-slate-900 text-slate-300 hover:bg-slate-800"}`}>
            <Orbit size={15} /> Tour
          </button>
          <button onClick={() => setMode("interaction")} className={`inline-flex h-9 items-center gap-1.5 border-l border-slate-700 px-3 text-sm font-semibold ${mode === "interaction" ? "bg-cyan-700 text-white" : "bg-slate-900 text-slate-300 hover:bg-slate-800"}`}>
            <Atom size={15} /> Interaction
          </button>
        </div>
        <span className="text-xs text-slate-500">{mode === "tour" ? "textured planets on Keplerian orbits" : "live n-body gravity · illustrative"}</span>

        <div className="flex-1" />
        <button onClick={() => setPlaying((p) => !p)} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-700 px-3 text-sm text-slate-200 hover:border-cyan-500">
          {playing ? <Pause size={15} /> : <Play size={15} />} {playing ? "Pause" : "Play"}
        </button>
        <label className="flex items-center gap-2 text-xs text-slate-400">Speed
          <input type="range" min={0.1} max={5} step={0.1} value={speed} onChange={(e) => setSpeed(Number(e.target.value))} className="accent-cyan-500" />
          <span className="w-8 tabular-nums">{speed.toFixed(1)}×</span>
        </label>
        <button onClick={() => setRemountKey((k) => k + 1)} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-700 px-3 text-sm text-slate-200 hover:border-cyan-500"><RotateCcw size={15} /> Reset</button>
      </header>

      <div className="relative flex-1">
        {error && <div className="absolute left-1/2 top-1/2 z-10 -translate-x-1/2 -translate-y-1/2 border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-200">{error}</div>}
        {!objects && !error && <div className="absolute inset-0 flex items-center justify-center text-cyan-300"><Loader2 className="animate-spin" size={32} /></div>}

        {ready && (mode === "tour"
          ? <KeplerView key={`tour-${remountKey}`} objects={objects!} playing={playing} speed={speed} />
          : <NbodyView key={`nb-${remountKey}`} objects={objects!} playing={playing} speed={speed} />
        )}

        {ready && (
          <div className="absolute left-4 top-4 max-h-[80%] w-64 overflow-auto border border-slate-800 bg-slate-950/80 p-3 text-xs backdrop-blur">
            <h2 className="mb-2 font-bold text-white">System ({objects!.length})</h2>
            <ul className="space-y-1.5">
              {objects!.map((o) => (
                <li key={o.id} className="text-slate-300">
                  <span className="font-semibold text-white">{o.name}</span>
                  <span className="block text-[10px] text-slate-500">{o.object_kind || "object"} · {o.reality_status || "unknown"}</span>
                </li>
              ))}
            </ul>
            <p className="mt-3 border-t border-slate-800 pt-2 text-[10px] leading-relaxed text-slate-500">
              {mode === "tour"
                ? "Tour places each body on its real Keplerian orbit (semi-major axis + eccentricity) around the most massive object, as a textured globe with day/night lighting. Sizes are exaggerated for visibility."
                : "Interaction evolves the bodies under live Newtonian gravity, so they perturb each other. Sizes are exaggerated and the view is normalized for visibility; this is illustrative, not a precise ephemeris."}
            </p>
          </div>
        )}
      </div>
    </main>
  );
}

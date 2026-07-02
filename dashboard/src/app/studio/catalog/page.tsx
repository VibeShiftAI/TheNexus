"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Box,
  Check,
  ClipboardCopy,
  Copy,
  Film,
  Loader2,
  Moon,
  Orbit,
  RefreshCw,
  Search,
  Wand2,
  X,
  Zap,
} from "lucide-react";
import {
  getBoard,
  generateFromObjects,
  getObjectsPrompt,
  exportToUnreal,
  type BoardState,
  type GenMode,
  type SpaceObject,
} from "@/lib/studio";

const DEFAULT_CHANNEL = "praxis-youtube";

const SPEC_CHIPS: Array<[string, string, string]> = [
  ["bulk.surface_gravity_g", "g", "g"],
  ["energy.equilibrium_temperature_k", "T", "K"],
  ["bulk.mass_earth", "M", "M⊕"],
  ["bulk.radius_earth", "R", "R⊕"],
];

function specValue(obj: SpaceObject, key: string): string | null {
  const s = (obj.spec_values || []).find((x) => x.spec_key === key);
  if (!s || s.status === "unknown" || s.status === "not_applicable") return null;
  if (s.value_text != null) return s.value_text;
  if (s.value_number != null) return String(Math.round(s.value_number * 100) / 100);
  return null;
}

export default function CatalogPage() {
  const router = useRouter();
  const [channelId, setChannelId] = useState(DEFAULT_CHANNEL);
  const [board, setBoard] = useState<BoardState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState("");
  const [realityFilter, setRealityFilter] = useState("");
  const [promptModal, setPromptModal] = useState<{ label: string; text: string } | null>(null);
  const [resultPanel, setResultPanel] = useState<{ title: string; text: string } | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setChannelId(params.get("channelId") || DEFAULT_CHANNEL);
  }, []);

  const load = useCallback(async (id = channelId) => {
    setLoading(true);
    try {
      setBoard(await getBoard(id));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load catalog");
    } finally {
      setLoading(false);
    }
  }, [channelId]);

  useEffect(() => { load(channelId); }, [channelId, load]);

  const objects = board?.objects || [];
  const kinds = useMemo(() => Array.from(new Set(objects.map((o) => o.object_kind).filter(Boolean))).sort() as string[], [objects]);
  const realities = useMemo(() => Array.from(new Set(objects.map((o) => o.reality_status).filter(Boolean))).sort() as string[], [objects]);

  const filtered = useMemo(() => objects.filter((o) => {
    if (kindFilter && o.object_kind !== kindFilter) return false;
    if (realityFilter && o.reality_status !== realityFilter) return false;
    if (query) {
      const q = query.toLowerCase();
      if (!o.name.toLowerCase().includes(q) && !(o.field_guide_summary || "").toLowerCase().includes(q)) return false;
    }
    return true;
  }), [objects, kindFilter, realityFilter, query]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  const ids = useMemo(() => Array.from(selected), [selected]);

  function switchChannel(id: string) {
    setChannelId(id);
    setSelected(new Set());
    router.replace(`/studio/catalog?channelId=${encodeURIComponent(id)}`);
  }

  async function act(type: string, mode: GenMode | "prompt", label: string) {
    if (!ids.length) return;
    setBusy(`${type}:${mode}`);
    setError(null);
    try {
      if (mode === "prompt") {
        const prompt = await getObjectsPrompt(channelId, type, ids);
        setPromptModal({ label: prompt.label, text: `${prompt.system}\n\n====================\n\n${prompt.user}` });
      } else {
        const res = await generateFromObjects(channelId, type, ids, mode);
        if (type === "interaction_idea" && res.result.ideaId) {
          router.push(`/studio/idea/${res.result.ideaId}?channelId=${encodeURIComponent(channelId)}`);
        } else if (res.result.text) {
          setResultPanel({ title: label, text: res.result.text });
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : `${label} failed`);
    } finally {
      setBusy(null);
    }
  }

  async function exportUnreal() {
    if (!ids.length) return;
    setBusy("export:unreal");
    setError(null);
    try {
      const scene = await exportToUnreal(channelId, ids);
      const blob = new Blob([JSON.stringify(scene, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "scene.json";
      a.click();
      URL.revokeObjectURL(url);
      const src = (scene as { source?: string }).source;
      const written = (scene as { written?: string[] }).written || [];
      const wroteToSim = written.some((p) => p.includes("ImpossibleWorldsNBody"));
      setResultPanel({
        title: "Exported to Unreal",
        text: `${ids.length} bodies exported (source: ${src}).\n\n${wroteToSim
          ? "Written straight into the simulator project at ImpossibleWorldsNBody/Content/NBody/scene.json — just open the project and press Play."
          : "Downloaded scene.json — drop it into the simulator's Content/NBody/ folder."}\n\nA timestamped copy is also in the project's exports/ folder.`,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className="min-h-screen bg-slate-950 pb-32 text-slate-200">
      <header className="sticky top-0 z-40 border-b border-slate-800 bg-slate-950/90 backdrop-blur-md">
        <div className="container mx-auto flex min-h-16 flex-wrap items-center justify-between gap-3 px-6 py-3">
          <div className="flex items-center gap-3">
            <Link href={`/studio?channelId=${encodeURIComponent(channelId)}`} className="rounded-full p-2 text-slate-400 hover:bg-slate-800 hover:text-white"><ArrowLeft size={20} /></Link>
            <div className="flex items-center gap-2">
              <Orbit size={22} className="text-cyan-300" />
              <div>
                <h1 className="text-lg font-bold text-white">Object Catalog</h1>
                <p className="text-xs text-slate-500">{objects.length} objects · select to build a system</p>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <select value={channelId} onChange={(e) => switchChannel(e.target.value)} className="h-10 rounded-lg border border-slate-700 bg-slate-900 px-3 text-sm text-slate-100 outline-none focus:border-cyan-500">
              {(board?.channels || [{ id: channelId, name: "Loading" }]).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <button onClick={() => load(channelId)} className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-slate-700 text-slate-300 hover:border-cyan-500"><RefreshCw size={16} /></button>
          </div>
        </div>
      </header>

      <div className="container mx-auto space-y-4 p-6">
        {error && <div className="border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200">{error}</div>}

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[200px]">
            <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search objects…" className="h-10 w-full rounded-lg border border-slate-700 bg-slate-900 pl-9 pr-3 text-sm text-slate-100 outline-none focus:border-cyan-500" />
          </div>
          <select value={kindFilter} onChange={(e) => setKindFilter(e.target.value)} className="h-10 rounded-lg border border-slate-700 bg-slate-900 px-3 text-sm text-slate-200 outline-none focus:border-cyan-500">
            <option value="">All kinds</option>
            {kinds.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
          <select value={realityFilter} onChange={(e) => setRealityFilter(e.target.value)} className="h-10 rounded-lg border border-slate-700 bg-slate-900 px-3 text-sm text-slate-200 outline-none focus:border-cyan-500">
            <option value="">All reality</option>
            {realities.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>

        {loading ? (
          <div className="flex min-h-[360px] items-center justify-center text-cyan-300"><Loader2 className="animate-spin" size={32} /></div>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {filtered.map((obj) => {
              const isSel = selected.has(obj.id);
              return (
                <button key={obj.id} onClick={() => toggle(obj.id)} className={`flex gap-3 border p-3 text-left transition ${isSel ? "border-cyan-500 bg-cyan-950/30" : "border-slate-800 bg-slate-900/40 hover:border-slate-600"}`}>
                  <span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border ${isSel ? "border-cyan-400 bg-cyan-500 text-white" : "border-slate-600"}`}>{isSel && <Check size={13} />}</span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span className="truncate font-semibold text-white">{obj.name}</span>
                      {obj.reality_status && <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] uppercase text-slate-400">{obj.reality_status}</span>}
                    </span>
                    <span className="mt-0.5 block text-[11px] text-slate-500">{obj.object_kind || "object"}</span>
                    <span className="mt-1 flex flex-wrap gap-1">
                      {SPEC_CHIPS.map(([key, lab, unit]) => {
                        const v = specValue(obj, key);
                        return v == null ? null : <span key={key} className="rounded bg-slate-950/60 px-1.5 py-0.5 text-[10px] text-cyan-300">{lab} {v}{unit ? ` ${unit}` : ""}</span>;
                      })}
                    </span>
                  </span>
                </button>
              );
            })}
            {!filtered.length && <div className="col-span-full py-12 text-center text-sm text-slate-600">No objects match.</div>}
          </div>
        )}
      </div>

      {/* Selection action bar */}
      {ids.length > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-slate-800 bg-slate-950/95 backdrop-blur-md">
          <div className="container mx-auto flex flex-wrap items-center gap-3 px-6 py-3">
            <span className="text-sm font-semibold text-white">{ids.length} selected</span>
            <button onClick={() => setSelected(new Set())} className="text-xs text-slate-400 hover:text-white">Clear</button>
            <div className="flex-1" />
            <ActionGroup label="Start Video" icon={<Film size={14} />} busy={busy} type="interaction_idea" onAct={act} />
            <ActionGroup label="Unreal 5" icon={<Wand2 size={14} />} busy={busy} type="unreal_environment" onAct={act} />
            <ActionGroup label="Physics" icon={<Orbit size={14} />} busy={busy} type="physics_analysis" onAct={act} />
            <Link href={`/studio/simulator?channelId=${encodeURIComponent(channelId)}&objects=${ids.join(",")}`} className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-indigo-600 px-3 text-sm font-semibold text-white hover:bg-indigo-500">
              <Orbit size={14} /> Simulate
            </Link>
            <button onClick={exportUnreal} disabled={!!busy} title="Export a double-precision SI scene (real Horizons state vectors when available) for the Unreal Engine 5 N-body simulator" className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-emerald-700 px-3 text-sm font-semibold text-white hover:bg-emerald-600 disabled:opacity-50">
              {busy === "export:unreal" ? <Loader2 size={14} className="animate-spin" /> : <Box size={14} />} Export to Unreal
            </button>
          </div>
        </div>
      )}

      {promptModal && <PromptModal label={promptModal.label} text={promptModal.text} onClose={() => setPromptModal(null)} />}
      {resultPanel && <ResultModal title={resultPanel.title} text={resultPanel.text} onClose={() => setResultPanel(null)} />}
    </main>
  );
}

function ActionGroup({ label, icon, type, busy, onAct }: { label: string; icon: React.ReactNode; type: string; busy: string | null; onAct: (type: string, mode: GenMode | "prompt", label: string) => void }) {
  const spinning = busy?.startsWith(`${type}:`);
  return (
    <div className="flex items-center overflow-hidden rounded-lg border border-slate-700">
      <span className="flex items-center gap-1.5 bg-slate-900 px-2.5 text-xs font-semibold text-slate-200">{spinning ? <Loader2 size={13} className="animate-spin" /> : icon}{label}</span>
      <button onClick={() => onAct(type, "local", label)} disabled={!!busy} title="Local" className="h-9 border-l border-slate-700 bg-slate-900 px-2 text-slate-200 hover:bg-slate-800 disabled:opacity-50"><Moon size={13} /></button>
      <button onClick={() => onAct(type, "cloud", label)} disabled={!!busy} title="Cloud" className="h-9 border-l border-slate-700 bg-cyan-700 px-2 text-white hover:bg-cyan-600 disabled:opacity-50"><Zap size={13} /></button>
      <button onClick={() => onAct(type, "prompt", label)} disabled={!!busy} title="Copy prompt" className="h-9 border-l border-slate-700 bg-slate-900 px-2 text-slate-300 hover:bg-slate-800 disabled:opacity-50"><ClipboardCopy size={13} /></button>
    </div>
  );
}

function CopyBtn({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button onClick={() => { navigator.clipboard.writeText(text); setCopied(true); window.setTimeout(() => setCopied(false), 1500); }} className="inline-flex items-center gap-1 text-xs font-semibold text-cyan-300">
      {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? "Copied" : "Copy"}
    </button>
  );
}

function Shell({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-auto bg-slate-950/70 p-6 backdrop-blur-sm">
      <div className="w-full max-w-3xl border border-slate-800 bg-slate-900 p-5">
        <div className="flex items-start justify-between gap-3">
          <h2 className="font-bold text-white">{title}</h2>
          <button onClick={onClose} className="rounded-lg p-1 text-slate-400 hover:bg-slate-800 hover:text-white"><X size={18} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

function PromptModal({ label, text, onClose }: { label: string; text: string; onClose: () => void }) {
  return (
    <Shell title={`Prompt: ${label}`} onClose={onClose}>
      <div className="mt-3 flex items-center justify-between"><span className="text-sm font-semibold text-slate-300">Copy into any model</span><CopyBtn text={text} /></div>
      <pre className="mt-2 max-h-[60vh] overflow-auto whitespace-pre-wrap border border-slate-800 bg-slate-950 p-3 text-[11px] leading-relaxed text-slate-400">{text}</pre>
    </Shell>
  );
}

function ResultModal({ title, text, onClose }: { title: string; text: string; onClose: () => void }) {
  return (
    <Shell title={title} onClose={onClose}>
      <div className="mt-3 flex items-center justify-end"><CopyBtn text={text} /></div>
      <pre className="mt-2 max-h-[60vh] overflow-auto whitespace-pre-wrap border border-slate-800 bg-slate-950 p-3 text-xs leading-relaxed text-slate-300">{text}</pre>
    </Shell>
  );
}

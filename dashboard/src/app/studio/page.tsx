"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Archive,
  ArrowLeft,
  Atom,
  CheckCircle2,
  ChevronRight,
  Clapperboard,
  Database,
  Loader2,
  Moon,
  Plus,
  RefreshCw,
  Radar,
  Sparkles,
  Zap,
} from "lucide-react";
import {
  STAGES,
  advanceIdea,
  archiveIdea,
  createIdea,
  generate,
  getBoard,
  getIngestionCursors,
  getIngestionRuns,
  runAstroAgent,
  runEnrichment,
  runIngestion,
  seedSeries,
  setTargetReady,
  type BoardState,
  type Idea,
  type IngestionCursorState,
  type IngestionRun,
} from "@/lib/studio";

const IMPOSSIBLE_WORLDS = "impossible-worlds-field-guide";

const DEFAULT_CHANNEL = "praxis-youtube";
const STAGE_LABELS: Record<string, string> = {
  suggested: "Suggested",
  approved: "Approved",
  scripted: "Scripted",
  thumbnail: "Thumbnail",
  ready: "Ready to film",
  published: "Published",
};

export default function StudioPage() {
  const router = useRouter();
  const [channelId, setChannelId] = useState(DEFAULT_CHANNEL);
  const [board, setBoard] = useState<BoardState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [newIdea, setNewIdea] = useState({ title: "", angle: "" });
  const [runs, setRuns] = useState<IngestionRun[]>([]);
  const [cursors, setCursors] = useState<IngestionCursorState | null>(null);
  const [catalogBusy, setCatalogBusy] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setChannelId(params.get("channelId") || DEFAULT_CHANNEL);
  }, []);

  const load = useCallback(async (id = channelId) => {
    setLoading(true);
    try {
      const data = await getBoard(id);
      setBoard(data);
      setRuns(await getIngestionRuns(id).catch(() => []));
      setCursors(await getIngestionCursors(id).catch(() => null));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load studio");
    } finally {
      setLoading(false);
    }
  }, [channelId]);

  // Poll a freshly-triggered run until it leaves the queued/running state.
  const pollRun = useCallback(async (id: string, runId: string) => {
    for (let i = 0; i < 120; i += 1) {
      const list = await getIngestionRuns(id).catch(() => []);
      setRuns(list);
      const run = list.find((r) => r.id === runId);
      if (run && run.status !== "queued" && run.status !== "running") return run;
      await new Promise((r) => setTimeout(r, 2500));
    }
    return null;
  }, []);

  useEffect(() => {
    load(channelId);
  }, [channelId, load]);

  const flash = (message: string) => {
    setDone(message);
    window.setTimeout(() => setDone(null), 2600);
  };

  const ideas = useMemo(() => (board?.ideas || []).filter((idea) => idea.status !== "archived"), [board]);
  const readyCount = ideas.filter((idea) => idea.status === "ready").length;
  const target = board?.targetReady || board?.channel?.default_cadence_target || 2;
  const onTrack = readyCount >= target;

  function switchChannel(id: string) {
    setChannelId(id);
    router.replace(`/studio?channelId=${encodeURIComponent(id)}`);
  }

  async function addIdea(event: React.FormEvent) {
    event.preventDefault();
    if (!newIdea.title.trim()) return;
    setBusy("add");
    try {
      await createIdea(channelId, {
        title: newIdea.title,
        angle: newIdea.angle,
        status: "approved",
        source: "manual",
      });
      setNewIdea({ title: "", angle: "" });
      await load(channelId);
      flash("Idea added");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Idea creation failed");
    } finally {
      setBusy(null);
    }
  }

  async function seed() {
    setBusy("seed");
    try {
      const result = await seedSeries(channelId);
      await load(channelId);
      flash(result.seeded ? `Seeded ${result.seeded} video ideas` : result.message || "Already seeded");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Seed failed");
    } finally {
      setBusy(null);
    }
  }

  async function suggest(mode: "local" | "cloud") {
    setBusy(`suggest:${mode}`);
    try {
      const result = await generate(channelId, "suggest_topics", { mode, count: 6 });
      await load(channelId);
      flash(result.result.summary || "Ideas suggested");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Suggestion failed");
    } finally {
      setBusy(null);
    }
  }

  async function updateTarget(value: number) {
    await setTargetReady(channelId, value);
    await load(channelId);
  }

  async function ingest() {
    setCatalogBusy("ingest");
    try {
      const { run } = await runIngestion(channelId);
      flash("Ingestion started — reading sources locally…");
      const finished = await pollRun(channelId, run.id);
      await load(channelId);
      flash(finished?.digest || "Ingestion run finished");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ingestion failed");
    } finally {
      setCatalogBusy(null);
    }
  }

  async function astro() {
    setCatalogBusy("astro");
    try {
      const { run } = await runAstroAgent(channelId);
      flash("Astrophysics agent started — pulling NASA + ArXiv…");
      const finished = await pollRun(channelId, run.id);
      await load(channelId);
      flash(finished?.digest || "Astrophysics run finished");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Astrophysics agent failed");
    } finally {
      setCatalogBusy(null);
    }
  }

  async function enrich() {
    setCatalogBusy("enrich");
    try {
      // Manual clicks use a small batch so they return in a few minutes; the
      // nightly run uses the larger STUDIO_ENRICH_BATCH for bulk overnight work.
      const { run } = await runEnrichment(channelId, 5);
      flash("Enrichment started — deepening 5 objects with related videos…");
      const finished = await pollRun(channelId, run.id);
      await load(channelId);
      flash(finished?.digest || "Enrichment run finished");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Enrichment failed");
    } finally {
      setCatalogBusy(null);
    }
  }

  async function advance(id: string) {
    setBusy(`advance:${id}`);
    try {
      await advanceIdea(id);
      await load(channelId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not advance idea");
    } finally {
      setBusy(null);
    }
  }

  async function archive(id: string) {
    setBusy(`archive:${id}`);
    try {
      await archiveIdea(id);
      await load(channelId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not archive idea");
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className="min-h-screen bg-slate-950 text-slate-200">
      <header className="sticky top-0 z-50 border-b border-slate-800 bg-slate-950/90 backdrop-blur-md">
        <div className="container mx-auto flex min-h-16 flex-wrap items-center justify-between gap-3 px-6 py-3">
          <div className="flex items-center gap-4">
            <Link href="/" className="rounded-full p-2 text-slate-400 transition-colors hover:bg-slate-800 hover:text-white">
              <ArrowLeft size={20} />
            </Link>
            <div className="flex items-center gap-2">
              <Clapperboard size={22} className="text-cyan-300" />
              <div>
                <h1 className="text-xl font-bold text-white">STUDIO</h1>
                <p className="text-xs text-slate-500">{board?.channel?.name || "YouTube production"}</p>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <select
              value={channelId}
              onChange={(event) => switchChannel(event.target.value)}
              className="h-10 rounded-lg border border-slate-700 bg-slate-900 px-3 text-sm text-slate-100 outline-none focus:border-cyan-500"
              aria-label="Studio channel"
            >
              {(board?.channels || [{ id: channelId, name: "Loading" }]).map((channel) => (
                <option key={channel.id} value={channel.id}>{channel.name}</option>
              ))}
            </select>
            <button
              onClick={() => load(channelId)}
              className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-slate-700 text-slate-300 transition-colors hover:border-cyan-500 hover:text-cyan-200"
              title="Refresh"
            >
              <RefreshCw size={16} />
            </button>
          </div>
        </div>
      </header>

      <div className="container mx-auto space-y-5 p-6">
        {error && <Banner kind="err" message={error} />}
        {done && <Banner kind="ok" message={done} />}

        {loading ? (
          <div className="flex min-h-[360px] items-center justify-center text-cyan-300">
            <Loader2 className="animate-spin" size={32} />
          </div>
        ) : board ? (
          <>
            <section className={`border p-5 ${onTrack ? "border-emerald-600/40 bg-emerald-950/20" : "border-amber-600/40 bg-amber-950/20"}`}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <CheckCircle2 size={20} className={onTrack ? "text-emerald-300" : "text-amber-300"} />
                  <div>
                    <h2 className="font-bold text-white">
                      {onTrack ? "On track" : "Pipeline running low"} - {readyCount} of {target} videos ready to film
                    </h2>
                    <p className="text-xs text-slate-500">
                      Idea to script to thumbnail to filmed to live. {ideas.length} active video ideas are in the pipeline.
                    </p>
                  </div>
                </div>
                <label className="flex items-center gap-2 text-sm text-slate-400">
                  Target ready
                  <input
                    type="number"
                    min={1}
                    max={10}
                    value={target}
                    onChange={(event) => updateTarget(Number(event.target.value))}
                    className="h-9 w-16 rounded-lg border border-slate-700 bg-slate-900 px-2 text-slate-100"
                  />
                </label>
              </div>
            </section>

            <section className="flex flex-wrap gap-2">
              <button onClick={seed} disabled={!!busy} className={secondaryButtonCls} title="Seed the channel with starter video ideas">
                <Sparkles size={15} /> Seed Series
              </button>
              <div className="flex overflow-hidden rounded-lg border border-cyan-700/60">
                <button onClick={() => suggest("local")} disabled={!!busy} className="inline-flex h-10 items-center gap-2 bg-slate-900 px-3 text-sm font-semibold text-cyan-100 hover:bg-slate-800 disabled:opacity-60" title="Run topic suggestions locally">
                  <Moon size={15} /> Local Ideas
                </button>
                <button onClick={() => suggest("cloud")} disabled={!!busy} className="inline-flex h-10 items-center gap-2 border-l border-cyan-700/60 bg-cyan-700 px-3 text-sm font-semibold text-white hover:bg-cyan-600 disabled:opacity-60" title="Generate topic suggestions now">
                  <Zap size={15} /> Cloud Ideas
                </button>
              </div>
            </section>

            {(board.sources?.length || board.objects?.length || channelId === IMPOSSIBLE_WORLDS) ? (
              <section className="border border-slate-800 bg-slate-900/40 p-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <Database size={18} className="text-cyan-300" />
                    <div>
                      <h2 className="font-bold text-white">Knowledge & Catalog</h2>
                      <p className="text-xs text-slate-500">
                        <Link href={`/studio/catalog?channelId=${encodeURIComponent(channelId)}`} className="font-semibold text-cyan-300 hover:text-cyan-200">Browse catalog →</Link>
                        {" · "}{board.objects?.length || 0} object(s) · {board.sources?.filter((s) => s.enabled).length || 0} active source(s) · {board.referenceImages?.length || 0} reference image(s)
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <button onClick={ingest} disabled={!!catalogBusy} className={secondaryButtonCls} title="Discover from enabled sources (YouTube + web), then extract space objects locally and save them to the catalog">
                      {catalogBusy === "ingest" ? <Loader2 size={15} className="animate-spin" /> : <Radar size={15} />} Run local ingestion
                    </button>
                    {channelId === IMPOSSIBLE_WORLDS && (
                      <button onClick={astro} disabled={!!catalogBusy} className={secondaryButtonCls} title="Astrophysics agent: pull exoplanets/neutron stars/rogue planets from NASA + ArXiv, then compute surface parameters">
                        {catalogBusy === "astro" ? <Loader2 size={15} className="animate-spin" /> : <Atom size={15} />} Run astrophysics agent
                      </button>
                    )}
                    {(board.objects?.length || 0) > 0 && (
                      <button onClick={enrich} disabled={!!catalogBusy} className={secondaryButtonCls} title="Deepen 5 objects per click: recompute parameters and pull related YouTube videos (which may surface new objects). The 2am nightly run does larger batches.">
                        {catalogBusy === "enrich" ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />} Enrich catalog{cursors && cursors.enrichRemaining > 0 ? ` (${cursors.enrichRemaining})` : ""}
                      </button>
                    )}
                  </div>
                </div>
                {cursors && cursors.cursors.length > 0 && (
                  <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 border-t border-slate-800 pt-3 text-[11px] text-slate-400">
                    {cursors.cursors.map((c) => {
                      const isNasa = c.source === "nasa_exoplanets";
                      const label = isNasa ? "NASA exoplanets" : c.source.replace(/^arxiv:/, "arXiv ");
                      const progress = c.mode === "backfill" && c.total_estimate
                        ? `${c.processed_count ?? 0}/${c.total_estimate}`
                        : c.mode === "incremental" ? "up to date" : `${c.processed_count ?? 0} seen`;
                      return (
                        <span key={c.source}>
                          <span className="text-slate-500">{label}:</span>{" "}
                          <span className="text-cyan-300">{progress}</span>
                          <span className="text-slate-600"> ({c.mode})</span>
                        </span>
                      );
                    })}
                    {cursors.enrichRemaining > 0 && (
                      <span><span className="text-slate-500">to enrich:</span> <span className="text-amber-300">{cursors.enrichRemaining}</span></span>
                    )}
                  </div>
                )}
                {runs.length > 0 && (
                  <div className="mt-3 space-y-1.5 border-t border-slate-800 pt-3">
                    {runs.slice(0, 4).map((run) => (
                      <div key={run.id} className="flex items-start gap-2 text-xs">
                        <span className={`mt-0.5 inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${run.status === "complete" ? "bg-emerald-900/50 text-emerald-300" : run.status === "failed" ? "bg-red-900/50 text-red-300" : "bg-amber-900/50 text-amber-300"}`}>
                          {run.status}
                        </span>
                        <span className="text-slate-500">{run.trigger}</span>
                        <span className="flex-1 text-slate-400">{run.digest}</span>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            ) : null}

            <section className="grid gap-3 lg:grid-cols-3 xl:grid-cols-6">
              {STAGES.map(([key, fallbackLabel]) => {
                const column = ideas.filter((idea) => idea.status === key);
                const label = STAGE_LABELS[key] || fallbackLabel;
                return (
                  <div key={key} className="border border-slate-800 bg-slate-900/40 p-3">
                    <h3 className="mb-2 text-[11px] font-bold uppercase text-slate-500">{label} ({column.length})</h3>
                    <div className="space-y-2">
                      {column.map((idea) => (
                        <IdeaCard
                          key={idea.id}
                          idea={idea}
                          onAdvance={() => advance(idea.id)}
                          onArchive={() => archive(idea.id)}
                          busy={busy === `advance:${idea.id}` || busy === `archive:${idea.id}`}
                        />
                      ))}
                      {!column.length && <div className="text-xs text-slate-600">Empty</div>}
                    </div>
                  </div>
                );
              })}
            </section>

            <section className="border border-slate-800 bg-slate-900/40 p-5">
              <h2 className="font-bold text-white">Add an idea manually</h2>
              <form onSubmit={addIdea} className="mt-3 grid gap-2 md:grid-cols-[1fr_1fr_auto]">
                <input value={newIdea.title} onChange={(event) => setNewIdea({ ...newIdea, title: event.target.value })} required placeholder="Video title" className={inputCls} />
                <input value={newIdea.angle} onChange={(event) => setNewIdea({ ...newIdea, angle: event.target.value })} placeholder="Angle or hook" className={inputCls} />
                <button disabled={busy === "add"} className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-cyan-600 px-4 text-sm font-semibold text-white hover:bg-cyan-500 disabled:opacity-60">
                  <Plus size={15} /> Add
                </button>
              </form>
            </section>
          </>
        ) : null}
      </div>
    </main>
  );
}

function IdeaCard({ idea, onAdvance, onArchive, busy }: { idea: Idea; onAdvance: () => void; onArchive: () => void; busy: boolean }) {
  return (
    <div className="border border-slate-700 bg-slate-900 p-3">
      <Link href={`/studio/idea/${idea.id}?channelId=${idea.channel_id}`} className="block text-sm font-medium leading-snug text-slate-100 hover:text-cyan-200">
        {idea.title}
      </Link>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <span className="rounded bg-cyan-500/10 px-2 py-0.5 text-[10px] font-semibold text-cyan-200">{idea.category || idea.source}</span>
        {idea.script && <span className="rounded bg-slate-800 px-2 py-0.5 text-[10px] text-slate-400">script</span>}
        {idea.thumbnail_concepts?.length ? <span className="rounded bg-slate-800 px-2 py-0.5 text-[10px] text-slate-400">thumbnail</span> : null}
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {idea.status !== "published" && (
          <button onClick={onAdvance} disabled={busy} className="inline-flex h-7 items-center gap-1 rounded bg-slate-800 px-2 text-[11px] font-semibold text-slate-300 hover:bg-cyan-950 hover:text-cyan-200 disabled:opacity-60">
            Advance <ChevronRight size={12} />
          </button>
        )}
        <button onClick={onArchive} disabled={busy} className="inline-flex h-7 items-center gap-1 rounded bg-slate-800 px-2 text-[11px] text-slate-400 hover:text-red-300 disabled:opacity-60">
          <Archive size={12} /> Archive
        </button>
      </div>
    </div>
  );
}

function Banner({ message, kind }: { message: string; kind: "ok" | "err" }) {
  return (
    <div className={`border p-3 text-sm ${kind === "err" ? "border-red-500/40 bg-red-500/10 text-red-200" : "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"}`}>
      {message}
    </div>
  );
}

const inputCls = "w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none placeholder:text-slate-600 focus:border-cyan-500";
const secondaryButtonCls = "inline-flex h-10 items-center gap-2 rounded-lg border border-slate-700 bg-slate-900 px-3 text-sm font-semibold text-slate-200 hover:border-cyan-500 disabled:opacity-60";

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  BookOpenCheck,
  CheckCircle2,
  Clapperboard,
  Database,
  FileImage,
  FlaskConical,
  Loader2,
  Moon,
  Plus,
  RefreshCw,
  Save,
  Search,
  Sparkles,
  Upload,
  Zap,
} from "lucide-react";
import {
  STAGES,
  createIdea,
  createObject,
  createReferenceImage,
  createSource,
  generate,
  getBoard,
  runIngestion,
  seedSeries,
  setTargetReady,
  updateChannel,
  updateSource,
  type BoardState,
  type Idea,
  type SpaceObject,
  type StudioChannel,
  type StudioSource,
} from "@/lib/studio";

const DEFAULT_CHANNEL = "praxis-youtube";
const IMPOSSIBLE = "impossible-worlds-field-guide";

export default function StudioPage() {
  const router = useRouter();
  const [channelId, setChannelId] = useState(DEFAULT_CHANNEL);
  const [board, setBoard] = useState<BoardState | null>(null);
  const [profile, setProfile] = useState<Partial<StudioChannel>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [newIdea, setNewIdea] = useState({ title: "", angle: "" });
  const [newSource, setNewSource] = useState({ name: "", source_type: "web", url: "" });
  const [newObject, setNewObject] = useState({ name: "", object_kind: "", reality_status: "observed", field_guide_summary: "" });
  const [newImage, setNewImage] = useState({ file_path_or_url: "", prompt: "", intended_use: "surface_reference" });

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    setChannelId(q.get("channelId") || DEFAULT_CHANNEL);
  }, []);

  const load = useCallback(async (id = channelId) => {
    setLoading(true);
    try {
      const data = await getBoard(id);
      setBoard(data);
      setProfile(data.channel);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load studio");
    } finally {
      setLoading(false);
    }
  }, [channelId]);

  useEffect(() => {
    load(channelId);
  }, [channelId, load]);

  const flash = (message: string) => {
    setDone(message);
    window.setTimeout(() => setDone(null), 2600);
  };

  const ideas = useMemo(() => (board?.ideas || []).filter((idea) => idea.status !== "archived"), [board]);
  const readyCount = ideas.filter((idea) => idea.status === "ready").length;
  const target = board?.targetReady || board?.channel.default_cadence_target || 2;
  const onTrack = readyCount >= target;
  const isImpossible = channelId === IMPOSSIBLE;

  function switchChannel(id: string) {
    setChannelId(id);
    router.replace(`/studio?channelId=${encodeURIComponent(id)}`);
  }

  async function saveProfile() {
    setBusy("profile");
    try {
      const saved = await updateChannel(channelId, profile);
      setProfile(saved);
      await load(channelId);
      flash("Channel Profile saved");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Profile save failed");
    } finally {
      setBusy(null);
    }
  }

  async function addIdea(event: React.FormEvent) {
    event.preventDefault();
    if (!newIdea.title.trim()) return;
    await createIdea(channelId, { title: newIdea.title, angle: newIdea.angle, status: "approved", source: "manual" });
    setNewIdea({ title: "", angle: "" });
    await load(channelId);
  }

  async function seed() {
    setBusy("seed");
    try {
      const result = await seedSeries(channelId);
      await load(channelId);
      flash(result.seeded ? `Seeded ${result.seeded} episode ideas` : result.message || "Already seeded");
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

  async function toggleSource(source: StudioSource) {
    setBoard((current) => current ? {
      ...current,
      sources: current.sources.map((item) => item.id === source.id ? { ...item, enabled: !source.enabled } : item),
    } : current);
    try {
      await updateSource(channelId, source.id, { enabled: !source.enabled });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Source update failed");
      await load(channelId);
    }
  }

  async function addSource(event: React.FormEvent) {
    event.preventDefault();
    if (!newSource.name.trim()) return;
    await createSource(channelId, newSource);
    setNewSource({ name: "", source_type: "web", url: "" });
    await load(channelId);
  }

  async function startIngestion() {
    setBusy("ingest");
    try {
      const result = await runIngestion(channelId);
      await load(channelId);
      flash(`${result.run.items_enqueued} local item(s) queued`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ingestion failed");
    } finally {
      setBusy(null);
    }
  }

  async function addObject(event: React.FormEvent) {
    event.preventDefault();
    if (!newObject.name.trim()) return;
    await createObject(channelId, newObject);
    setNewObject({ name: "", object_kind: "", reality_status: "observed", field_guide_summary: "" });
    await load(channelId);
  }

  async function addImage(event: React.FormEvent) {
    event.preventDefault();
    if (!newImage.file_path_or_url.trim()) return;
    await createReferenceImage(channelId, newImage);
    setNewImage({ file_path_or_url: "", prompt: "", intended_use: "surface_reference" });
    await load(channelId);
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
                <p className="text-xs text-slate-500">{board?.channel.name || "Multi-channel production"}</p>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <select
              value={channelId}
              onChange={(event) => switchChannel(event.target.value)}
              className="h-10 rounded-lg border border-slate-700 bg-slate-900 px-3 text-sm text-slate-100 outline-none focus:border-cyan-500"
            >
              {(board?.channels || []).map((channel) => (
                <option key={channel.id} value={channel.id}>{channel.name}</option>
              ))}
              {!board?.channels?.length && <option value={channelId}>Loading</option>}
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
            <section className={`flex flex-wrap items-center justify-between gap-3 border p-4 ${onTrack ? "border-emerald-600/40 bg-emerald-950/20" : "border-amber-600/40 bg-amber-950/20"}`}>
              <div className="flex items-center gap-3">
                <CheckCircle2 size={20} className={onTrack ? "text-emerald-300" : "text-amber-300"} />
                <div>
                  <h2 className="font-semibold text-white">{readyCount} of {target} ready</h2>
                  <p className="text-xs text-slate-500">{ideas.length} active episodes across {STAGES.length} stages</p>
                </div>
              </div>
              <label className="flex items-center gap-2 text-sm text-slate-400">
                Target
                <input
                  type="number"
                  min={1}
                  max={10}
                  value={target}
                  onChange={(event) => updateTarget(Number(event.target.value))}
                  className="h-9 w-16 rounded-lg border border-slate-700 bg-slate-900 px-2 text-slate-100"
                />
              </label>
            </section>

            <section className="border border-slate-800 bg-slate-900/40 p-5">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <h2 className="flex items-center gap-2 font-bold text-white"><BookOpenCheck size={18} className="text-cyan-300" /> Channel Profile</h2>
                <button onClick={saveProfile} disabled={busy === "profile"} className="inline-flex h-9 items-center gap-2 rounded-lg bg-cyan-600 px-3 text-sm font-semibold text-white hover:bg-cyan-500 disabled:opacity-60">
                  <Save size={15} /> Save
                </button>
              </div>
              <ProfileEditor value={profile} onChange={setProfile} />
            </section>

            <section className="flex flex-wrap items-center gap-2">
              <button onClick={seed} disabled={busy === "seed"} className="inline-flex h-10 items-center gap-2 rounded-lg border border-slate-700 bg-slate-900 px-3 text-sm font-semibold text-slate-200 hover:border-cyan-500 disabled:opacity-60">
                <Sparkles size={15} /> {busy === "seed" ? "Seeding" : "Seed Series"}
              </button>
              <div className="flex overflow-hidden rounded-lg border border-slate-700">
                <button onClick={() => suggest("local")} disabled={!!busy} className="inline-flex h-10 items-center gap-2 bg-slate-900 px-3 text-sm font-semibold text-slate-200 hover:bg-slate-800 disabled:opacity-60">
                  <Moon size={15} /> Local Ideas
                </button>
                <button onClick={() => suggest("cloud")} disabled={!!busy} className="inline-flex h-10 items-center gap-2 border-l border-slate-700 bg-cyan-700 px-3 text-sm font-semibold text-white hover:bg-cyan-600 disabled:opacity-60">
                  <Zap size={15} /> Cloud Ideas
                </button>
              </div>
              {isImpossible && (
                <button onClick={startIngestion} disabled={busy === "ingest"} className="inline-flex h-10 items-center gap-2 rounded-lg border border-emerald-600/50 bg-emerald-950/40 px-3 text-sm font-semibold text-emerald-200 hover:border-emerald-400 disabled:opacity-60">
                  <FlaskConical size={15} /> Local Ingestion
                </button>
              )}
            </section>

            <section className="grid gap-4 xl:grid-cols-[1.1fr_1fr_1fr]">
              <SourceIngestion sources={board.sources} newSource={newSource} setNewSource={setNewSource} onToggle={toggleSource} onAdd={addSource} />
              <ObjectCatalog objects={board.objects} newObject={newObject} setNewObject={setNewObject} onAdd={addObject} />
              <ReferenceImages images={board.referenceImages} newImage={newImage} setNewImage={setNewImage} onAdd={addImage} />
            </section>

            <section className="grid gap-3 lg:grid-cols-3 xl:grid-cols-6">
              {STAGES.map(([key, label]) => {
                const column = ideas.filter((idea) => idea.status === key);
                return (
                  <div key={key} className="border border-slate-800 bg-slate-900/40 p-3">
                    <h3 className="mb-2 text-[11px] font-bold uppercase text-slate-500">{label} ({column.length})</h3>
                    <div className="space-y-2">
                      {column.map((idea) => <IdeaCard key={idea.id} idea={idea} />)}
                      {!column.length && <div className="text-xs text-slate-600">Empty</div>}
                    </div>
                  </div>
                );
              })}
            </section>

            <section className="border border-slate-800 bg-slate-900/40 p-5">
              <h2 className="mb-3 font-bold text-white">Add Episode</h2>
              <form onSubmit={addIdea} className="grid gap-2 md:grid-cols-[1fr_1fr_auto]">
                <input value={newIdea.title} onChange={(event) => setNewIdea({ ...newIdea, title: event.target.value })} required placeholder="Title" className={inputCls} />
                <input value={newIdea.angle} onChange={(event) => setNewIdea({ ...newIdea, angle: event.target.value })} placeholder="Angle" className={inputCls} />
                <button className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-cyan-600 px-4 text-sm font-semibold text-white hover:bg-cyan-500">
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

function ProfileEditor({ value, onChange }: { value: Partial<StudioChannel>; onChange: (next: Partial<StudioChannel>) => void }) {
  const set = (key: keyof StudioChannel, fieldValue: string | number) => onChange({ ...value, [key]: fieldValue });
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <Field label="Name"><input value={value.name || ""} onChange={(e) => set("name", e.target.value)} className={inputCls} /></Field>
      <Field label="Project Path"><input value={value.project_path || ""} onChange={(e) => set("project_path", e.target.value)} className={inputCls} /></Field>
      <Field label="Positioning" wide><textarea rows={2} value={value.positioning || ""} onChange={(e) => set("positioning", e.target.value)} className={inputCls} /></Field>
      <Field label="Editorial Promise"><textarea rows={2} value={value.editorial_promise || ""} onChange={(e) => set("editorial_promise", e.target.value)} className={inputCls} /></Field>
      <Field label="Audience"><textarea rows={2} value={value.audience || ""} onChange={(e) => set("audience", e.target.value)} className={inputCls} /></Field>
      <Field label="Host Style"><textarea rows={2} value={value.host_style || ""} onChange={(e) => set("host_style", e.target.value)} className={inputCls} /></Field>
      <Field label="Visual Style"><textarea rows={2} value={value.visual_style_notes || ""} onChange={(e) => set("visual_style_notes", e.target.value)} className={inputCls} /></Field>
      <Field label="Episode Format"><textarea rows={2} value={value.recurring_episode_format || ""} onChange={(e) => set("recurring_episode_format", e.target.value)} className={inputCls} /></Field>
      <Field label="Source Strategy"><textarea rows={2} value={value.source_strategy || ""} onChange={(e) => set("source_strategy", e.target.value)} className={inputCls} /></Field>
      <Field label="Monetization"><textarea rows={2} value={value.monetization_notes || ""} onChange={(e) => set("monetization_notes", e.target.value)} className={inputCls} /></Field>
      <Field label="Risks"><textarea rows={2} value={value.risks_and_mitigations || ""} onChange={(e) => set("risks_and_mitigations", e.target.value)} className={inputCls} /></Field>
      <Field label="Guardrails"><textarea rows={2} value={value.prompt_guardrails || ""} onChange={(e) => set("prompt_guardrails", e.target.value)} className={inputCls} /></Field>
      <Field label="Cadence Target"><input type="number" min={1} max={10} value={value.default_cadence_target || 2} onChange={(e) => set("default_cadence_target", Number(e.target.value))} className={inputCls} /></Field>
    </div>
  );
}

function SourceIngestion({ sources, newSource, setNewSource, onToggle, onAdd }: {
  sources: StudioSource[];
  newSource: { name: string; source_type: string; url: string };
  setNewSource: (value: { name: string; source_type: string; url: string }) => void;
  onToggle: (source: StudioSource) => void;
  onAdd: (event: React.FormEvent) => void;
}) {
  return (
    <section className="border border-slate-800 bg-slate-900/40 p-4">
      <h2 className="mb-3 flex items-center gap-2 font-bold text-white"><Search size={18} className="text-cyan-300" /> Source Ingestion</h2>
      <div className="max-h-64 space-y-2 overflow-auto pr-1">
        {sources.map((source) => (
          <label key={source.id} className="flex items-start gap-2 border border-slate-800 bg-slate-950/40 p-2 text-xs">
            <input type="checkbox" checked={source.enabled} onChange={() => onToggle(source)} className="mt-1 accent-cyan-500" />
            <span className="min-w-0">
              <span className="block font-semibold text-slate-200">{source.name}</span>
              <span className="block truncate text-slate-500">{source.url || source.query_template || source.source_type}</span>
            </span>
          </label>
        ))}
      </div>
      <form onSubmit={onAdd} className="mt-3 grid gap-2">
        <input value={newSource.name} onChange={(e) => setNewSource({ ...newSource, name: e.target.value })} placeholder="Source name" className={inputCls} />
        <div className="grid grid-cols-[120px_1fr] gap-2">
          <select value={newSource.source_type} onChange={(e) => setNewSource({ ...newSource, source_type: e.target.value })} className={inputCls}>
            <option value="web">web</option>
            <option value="youtube_search">youtube_search</option>
            <option value="youtube_channel">youtube_channel</option>
            <option value="academic">academic</option>
          </select>
          <input value={newSource.url} onChange={(e) => setNewSource({ ...newSource, url: e.target.value })} placeholder="URL or query" className={inputCls} />
        </div>
        <button className="inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-slate-700 text-sm font-semibold text-slate-200 hover:border-cyan-500">
          <Plus size={14} /> Add Source
        </button>
      </form>
    </section>
  );
}

function ObjectCatalog({ objects, newObject, setNewObject, onAdd }: {
  objects: SpaceObject[];
  newObject: { name: string; object_kind: string; reality_status: string; field_guide_summary: string };
  setNewObject: (value: { name: string; object_kind: string; reality_status: string; field_guide_summary: string }) => void;
  onAdd: (event: React.FormEvent) => void;
}) {
  return (
    <section className="border border-slate-800 bg-slate-900/40 p-4">
      <h2 className="mb-3 flex items-center gap-2 font-bold text-white"><Database size={18} className="text-cyan-300" /> Object Catalog</h2>
      <div className="max-h-64 space-y-2 overflow-auto pr-1">
        {objects.map((object) => (
          <div key={object.id} className="border border-slate-800 bg-slate-950/40 p-2 text-xs">
            <div className="font-semibold text-slate-200">{object.name}</div>
            <div className="text-slate-500">{object.object_kind || "object"} · {object.reality_status || "unknown"}</div>
            {object.field_guide_summary && <p className="mt-1 text-slate-400">{object.field_guide_summary}</p>}
          </div>
        ))}
        {!objects.length && <p className="text-xs text-slate-600">No objects yet</p>}
      </div>
      <form onSubmit={onAdd} className="mt-3 grid gap-2">
        <input value={newObject.name} onChange={(e) => setNewObject({ ...newObject, name: e.target.value })} placeholder="Object name" className={inputCls} />
        <div className="grid grid-cols-2 gap-2">
          <input value={newObject.object_kind} onChange={(e) => setNewObject({ ...newObject, object_kind: e.target.value })} placeholder="Kind" className={inputCls} />
          <select value={newObject.reality_status} onChange={(e) => setNewObject({ ...newObject, reality_status: e.target.value })} className={inputCls}>
            <option value="observed">observed</option>
            <option value="candidate">candidate</option>
            <option value="theoretical">theoretical</option>
            <option value="fictional_physics_sandbox">physics sandbox</option>
          </select>
        </div>
        <textarea rows={2} value={newObject.field_guide_summary} onChange={(e) => setNewObject({ ...newObject, field_guide_summary: e.target.value })} placeholder="Field-guide summary" className={inputCls} />
        <button className="inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-slate-700 text-sm font-semibold text-slate-200 hover:border-cyan-500">
          <Plus size={14} /> Add Object
        </button>
      </form>
    </section>
  );
}

function ReferenceImages({ images, newImage, setNewImage, onAdd }: {
  images: { id: string; file_path_or_url: string; intended_use?: string | null; prompt?: string | null }[];
  newImage: { file_path_or_url: string; prompt: string; intended_use: string };
  setNewImage: (value: { file_path_or_url: string; prompt: string; intended_use: string }) => void;
  onAdd: (event: React.FormEvent) => void;
}) {
  return (
    <section className="border border-slate-800 bg-slate-900/40 p-4">
      <h2 className="mb-3 flex items-center gap-2 font-bold text-white"><FileImage size={18} className="text-cyan-300" /> Reference Images</h2>
      <div className="max-h-64 space-y-2 overflow-auto pr-1">
        {images.map((image) => (
          <div key={image.id} className="border border-slate-800 bg-slate-950/40 p-2 text-xs">
            <div className="truncate font-semibold text-slate-200">{image.file_path_or_url}</div>
            <div className="text-slate-500">{image.intended_use || "reference"}</div>
            {image.prompt && <p className="mt-1 line-clamp-2 text-slate-400">{image.prompt}</p>}
          </div>
        ))}
        {!images.length && <p className="text-xs text-slate-600">No images yet</p>}
      </div>
      <form onSubmit={onAdd} className="mt-3 grid gap-2">
        <input value={newImage.file_path_or_url} onChange={(e) => setNewImage({ ...newImage, file_path_or_url: e.target.value })} placeholder="File path or URL" className={inputCls} />
        <select value={newImage.intended_use} onChange={(e) => setNewImage({ ...newImage, intended_use: e.target.value })} className={inputCls}>
          <option value="thumbnail">thumbnail</option>
          <option value="surface_reference">surface_reference</option>
          <option value="sky_reference">sky_reference</option>
          <option value="diagram_reference">diagram_reference</option>
          <option value="style_reference">style_reference</option>
        </select>
        <textarea rows={2} value={newImage.prompt} onChange={(e) => setNewImage({ ...newImage, prompt: e.target.value })} placeholder="Prompt" className={inputCls} />
        <button className="inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-slate-700 text-sm font-semibold text-slate-200 hover:border-cyan-500">
          <Upload size={14} /> Store Reference
        </button>
      </form>
    </section>
  );
}

function IdeaCard({ idea }: { idea: Idea }) {
  return (
    <Link href={`/studio/idea/${idea.id}?channelId=${idea.channel_id}`} className="block border border-slate-700 bg-slate-900 p-3 transition-colors hover:border-cyan-500">
      <div className="text-sm font-medium leading-snug text-slate-100">{idea.title}</div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <span className="rounded bg-cyan-500/10 px-2 py-0.5 text-[10px] font-semibold text-cyan-200">{idea.category || idea.source}</span>
        {idea.script && <span className="rounded bg-slate-800 px-2 py-0.5 text-[10px] text-slate-400">script</span>}
      </div>
    </Link>
  );
}

function Field({ label, wide, children }: { label: string; wide?: boolean; children: React.ReactNode }) {
  return (
    <label className={wide ? "lg:col-span-2" : ""}>
      <span className="mb-1 block text-[11px] font-semibold uppercase text-slate-500">{label}</span>
      {children}
    </label>
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

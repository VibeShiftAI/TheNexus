"use client";

import { useCallback, useEffect, useState } from "react";
import { use as usePromise } from "react";
import Link from "next/link";
import {
  Archive,
  ArrowLeft,
  Check,
  ChevronRight,
  ClipboardCopy,
  Copy,
  Loader2,
  Moon,
  Save,
  X,
  Zap,
} from "lucide-react";
import {
  STAGES,
  advanceIdea,
  applyPaste,
  archiveIdea,
  createReferenceImage,
  deleteReferenceImage,
  generate,
  getBoard,
  getIdea,
  getPrompt,
  getReferenceImages,
  updateIdea,
  uploadReferenceImage,
  type BoardState,
  type GenMode,
  type Idea,
  type ReferenceImage,
} from "@/lib/studio";

const REFERENCE_USES = ["surface_reference", "sky_reference", "diagram_reference", "b_roll", "style_reference", "thumbnail"] as const;

const STATUSES = [...STAGES.map(([key]) => key), "archived"] as Idea["status"][];

const ACTIONS = [
  ["write_script", "Write Script"],
  ["physics_rigor_pass", "Physics Pass"],
  ["thumbnail_concepts", "Thumbnail Concepts"],
  ["image_prompts", "Image Prompt Pack"],
  ["source_citation_pack", "Source Pack"],
  ["publish_kit", "Publish Kit"],
] as const;

export default function IdeaPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = usePromise(params);
  const [idea, setIdea] = useState<Idea | null>(null);
  const [board, setBoard] = useState<BoardState | null>(null);
  const [channelId, setChannelId] = useState("praxis-youtube");
  const [form, setForm] = useState<Partial<Idea>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [promptModal, setPromptModal] = useState<{ type: string; label: string; text: string } | null>(null);
  const [refImages, setRefImages] = useState<ReferenceImage[]>([]);

  const load = useCallback(async () => {
    try {
      const data = await getIdea(id);
      const q = new URLSearchParams(window.location.search);
      const activeChannel = q.get("channelId") || data.channel_id || "praxis-youtube";
      const boardData = await getBoard(activeChannel);
      const images = await getReferenceImages(activeChannel, id).catch(() => []);
      setIdea(data);
      setBoard(boardData);
      setRefImages(images);
      setChannelId(activeChannel);
      setForm({
        title: data.title,
        category: data.category,
        status: data.status,
        angle: data.angle,
        build_promise: data.build_promise,
        script: data.script || "",
        youtube_id: data.youtube_id || "",
      });
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load episode");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const flash = (message: string) => {
    setDone(message);
    window.setTimeout(() => setDone(null), 2600);
  };

  async function save() {
    setBusy("save");
    try {
      await updateIdea(id, form);
      await load();
      flash("Saved");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setBusy(null);
    }
  }

  async function runNow(type: string, mode: GenMode) {
    setBusy(`${type}:${mode}`);
    try {
      const result = await generate(channelId, type, { ideaId: id, mode });
      await load();
      flash(result.result.summary || "Done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Generation failed");
    } finally {
      setBusy(null);
    }
  }

  async function openPrompt(type: string) {
    setBusy(`${type}:prompt`);
    try {
      const prompt = await getPrompt(channelId, type, id);
      setPromptModal({ type, label: prompt.label, text: `${prompt.system}\n\n====================\n\n${prompt.user}` });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Prompt failed");
    } finally {
      setBusy(null);
    }
  }

  async function advance() {
    await advanceIdea(id);
    await load();
  }

  async function archive() {
    await archiveIdea(id);
    window.location.href = `/studio?channelId=${encodeURIComponent(channelId)}`;
  }

  async function addImageByUrl(url: string, intendedUse: string, prompt: string) {
    setBusy("ref-add");
    try {
      await createReferenceImage(channelId, { episode_id: id, file_path_or_url: url, intended_use: intendedUse, prompt: prompt || undefined });
      await load();
      flash("Reference image added");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add image");
    } finally {
      setBusy(null);
    }
  }

  async function uploadImageFile(file: File, intendedUse: string) {
    setBusy("ref-upload");
    try {
      await uploadReferenceImage(channelId, file, { episode_id: id, intended_use: intendedUse });
      await load();
      flash("Reference image uploaded");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setBusy(null);
    }
  }

  async function removeImage(imageId: string) {
    setBusy(`ref-del:${imageId}`);
    try {
      await deleteReferenceImage(channelId, imageId);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setBusy(null);
    }
  }

  if (loading) {
    return <Shell channelId={channelId}><div className="flex min-h-[360px] items-center justify-center text-cyan-300"><Loader2 className="animate-spin" size={32} /></div></Shell>;
  }
  if (!idea) {
    return <Shell channelId={channelId}><div className="p-6 text-red-300">{error || "Episode not found"}</div></Shell>;
  }

  const concepts = idea.thumbnail_concepts || [];
  const prompts = idea.image_prompts || [];
  const checklist = idea.checklist || [];
  const kit = idea.publish_kit;

  return (
    <Shell title={idea.title} subtitle={board?.channel?.name} channelId={channelId}>
      <div className="container mx-auto max-w-5xl space-y-5 p-6">
        {error && <Banner kind="err" message={error} />}
        {done && <Banner kind="ok" message={done} />}

        <section className="border border-slate-800 bg-slate-900/40 p-4">
          <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
            {ACTIONS.map(([type, label]) => (
              <div key={type} className="flex items-center justify-between gap-2 border border-slate-800 bg-slate-950/40 p-2">
                <span className="text-sm font-semibold text-slate-200">{label}</span>
                <div className="flex overflow-hidden rounded-lg border border-slate-700">
                  <button onClick={() => runNow(type, "local")} disabled={!!busy} className="inline-flex h-8 items-center gap-1 bg-slate-900 px-2 text-xs text-slate-200 hover:bg-slate-800 disabled:opacity-60" title="Local">
                    <Moon size={13} />
                  </button>
                  <button onClick={() => runNow(type, "cloud")} disabled={!!busy} className="inline-flex h-8 items-center gap-1 border-l border-slate-700 bg-cyan-700 px-2 text-xs text-white hover:bg-cyan-600 disabled:opacity-60" title="Cloud">
                    <Zap size={13} />
                  </button>
                  <button onClick={() => openPrompt(type)} disabled={!!busy} className="inline-flex h-8 items-center gap-1 border-l border-slate-700 bg-slate-900 px-2 text-xs text-slate-300 hover:bg-slate-800 disabled:opacity-60" title="Prompt">
                    <ClipboardCopy size={13} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="border border-slate-800 bg-slate-900/40 p-5">
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Title" wide><input value={form.title || ""} onChange={(e) => setForm({ ...form, title: e.target.value })} className={inputCls} /></Field>
            <Field label="Category"><input value={form.category || ""} onChange={(e) => setForm({ ...form, category: e.target.value })} className={inputCls} /></Field>
            <Field label="Status">
              <select value={form.status || idea.status} onChange={(e) => setForm({ ...form, status: e.target.value as Idea["status"] })} className={inputCls}>
                {STATUSES.map((status) => <option key={status} value={status}>{status}</option>)}
              </select>
            </Field>
            <Field label="Angle" wide><textarea rows={2} value={form.angle || ""} onChange={(e) => setForm({ ...form, angle: e.target.value })} className={inputCls} /></Field>
            <Field label="Promise" wide><textarea rows={2} value={form.build_promise || ""} onChange={(e) => setForm({ ...form, build_promise: e.target.value })} className={inputCls} /></Field>
            <Field label={`Script ${idea.script_model ? `(${idea.script_model})` : ""}`} wide>
              <textarea rows={18} value={form.script || ""} onChange={(e) => setForm({ ...form, script: e.target.value })} className={`${inputCls} font-mono text-xs leading-relaxed`} />
            </Field>
            <Field label="YouTube ID"><input value={form.youtube_id || ""} onChange={(e) => setForm({ ...form, youtube_id: e.target.value })} className={inputCls} /></Field>
          </div>
          <div className="mt-4 flex flex-wrap gap-2 border-t border-slate-800 pt-4">
            <button onClick={save} disabled={busy === "save"} className="inline-flex h-10 items-center gap-2 rounded-lg bg-cyan-600 px-4 text-sm font-semibold text-white hover:bg-cyan-500 disabled:opacity-60">
              <Save size={15} /> Save
            </button>
            <button onClick={advance} className="inline-flex h-10 items-center gap-2 rounded-lg border border-slate-700 px-4 text-sm font-semibold text-slate-200 hover:border-cyan-500">
              Advance <ChevronRight size={15} />
            </button>
            <div className="flex-1" />
            <button onClick={archive} className="inline-flex h-10 items-center gap-2 rounded-lg border border-slate-800 px-3 text-sm text-slate-400 hover:text-red-300">
              <Archive size={15} /> Archive
            </button>
          </div>
        </section>

        {concepts.length > 0 && (
          <Panel title="Thumbnail Concepts">
            <div className="grid gap-3 md:grid-cols-3">
              {concepts.map((concept, index) => (
                <div key={index} className="border border-slate-800 bg-slate-950/40 p-3">
                  <p className="text-base font-black uppercase text-white">{concept.overlay_text}</p>
                  <p className="mt-2 text-xs text-slate-400">{concept.visual}</p>
                  <p className="mt-1 text-[11px] text-slate-500">{concept.composition}</p>
                </div>
              ))}
            </div>
          </Panel>
        )}

        {prompts.length > 0 && (
          <Panel title="Image Prompt Pack">
            <div className="space-y-2">
              {prompts.map((prompt, index) => (
                <div key={index} className="border-l-2 border-cyan-500 bg-slate-900/60 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm font-semibold text-slate-200">{prompt.label || "Prompt"}</span>
                    <div className="flex items-center gap-3">
                      <button
                        onClick={() => addImageByUrl("", prompt.intended_use || "surface_reference", prompt.prompt || "")}
                        className="text-[11px] font-semibold text-slate-500 hover:text-cyan-300"
                        title="Add a reference-image slot for this prompt (fill the URL after)"
                      >
                        + slot
                      </button>
                      <CopyButton text={prompt.prompt || ""} />
                    </div>
                  </div>
                  <p className="mt-1 font-mono text-xs text-slate-400">{prompt.prompt}</p>
                </div>
              ))}
            </div>
          </Panel>
        )}

        <ReferenceImagesPanel
          images={refImages}
          busy={busy}
          onAddUrl={addImageByUrl}
          onUpload={uploadImageFile}
          onRemove={removeImage}
        />

        {checklist.length > 0 && (
          <Panel title="Checklist">
            <div className="space-y-1">
              {checklist.map((item, index) => (
                <label key={index} className="flex items-start gap-2 text-sm text-slate-300">
                  <input
                    type="checkbox"
                    checked={item.done}
                    onChange={async (event) => {
                      const next = checklist.map((current, currentIndex) => currentIndex === index ? { ...current, done: event.target.checked } : current);
                      await updateIdea(id, { checklist: next });
                      await load();
                    }}
                    className="mt-1 accent-cyan-500"
                  />
                  <span className={item.done ? "text-slate-500 line-through" : ""}>{item.label}</span>
                </label>
              ))}
            </div>
          </Panel>
        )}

        {kit && (
          <Panel title="Publish Kit">
            {kit.titles?.length ? <ListBlock title="Titles" items={kit.titles} /> : null}
            {kit.description ? <TextBlock title="Description" text={kit.description} /> : null}
            {kit.tags?.length ? <TextBlock title="Tags" text={kit.tags.join(", ")} /> : null}
            {kit.pinned_comment ? <TextBlock title="Pinned Comment" text={kit.pinned_comment} /> : null}
          </Panel>
        )}
      </div>

      {promptModal && (
        <PromptModal
          modal={promptModal}
          channelId={channelId}
          ideaId={id}
          onClose={() => setPromptModal(null)}
          onApplied={async (message) => {
            setPromptModal(null);
            await load();
            flash(message);
          }}
          onError={setError}
        />
      )}
    </Shell>
  );
}

function Shell({ title = "Episode", subtitle, channelId, children }: { title?: string; subtitle?: string; channelId: string; children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-slate-950 text-slate-200">
      <header className="sticky top-0 z-40 border-b border-slate-800 bg-slate-950/90 backdrop-blur-md">
        <div className="container mx-auto flex min-h-16 items-center gap-4 px-6 py-3">
          <Link href={`/studio?channelId=${encodeURIComponent(channelId)}`} className="rounded-full p-2 text-slate-400 hover:bg-slate-800 hover:text-white">
            <ArrowLeft size={20} />
          </Link>
          <div className="min-w-0">
            <h1 className="truncate text-lg font-bold text-white">{title}</h1>
            {subtitle && <p className="truncate text-xs text-slate-500">{subtitle}</p>}
          </div>
        </div>
      </header>
      {children}
    </main>
  );
}

function PromptModal({ modal, channelId, ideaId, onClose, onApplied, onError }: {
  modal: { type: string; label: string; text: string };
  channelId: string;
  ideaId: string;
  onClose: () => void;
  onApplied: (message: string) => void;
  onError: (message: string) => void;
}) {
  const [reply, setReply] = useState("");
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  async function apply() {
    if (!reply.trim()) return;
    setBusy(true);
    try {
      const result = await applyPaste(channelId, modal.type, reply, ideaId);
      onApplied(result.result.summary || "Applied");
    } catch (err) {
      onError(err instanceof Error ? err.message : "Apply failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-auto bg-slate-950/70 p-6 backdrop-blur-sm">
      <div className="w-full max-w-3xl border border-slate-800 bg-slate-900 p-5">
        <div className="flex items-start justify-between gap-3">
          <h2 className="font-bold text-white">Prompt Mode: {modal.label}</h2>
          <button onClick={onClose} className="rounded-lg p-1 text-slate-400 hover:bg-slate-800 hover:text-white"><X size={18} /></button>
        </div>
        <div className="mt-3 flex items-center justify-between">
          <span className="text-sm font-semibold text-slate-300">Prompt</span>
          <button onClick={() => { navigator.clipboard.writeText(modal.text); setCopied(true); window.setTimeout(() => setCopied(false), 1500); }} className="inline-flex items-center gap-1 text-xs font-semibold text-cyan-300">
            {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap border border-slate-800 bg-slate-950 p-3 text-[11px] leading-relaxed text-slate-400">{modal.text}</pre>
        <textarea rows={8} value={reply} onChange={(event) => setReply(event.target.value)} placeholder="Paste model reply" className={`${inputCls} mt-3 font-mono text-xs`} />
        <button onClick={apply} disabled={busy} className="mt-3 h-10 rounded-lg bg-cyan-600 px-5 text-sm font-semibold text-white hover:bg-cyan-500 disabled:opacity-60">
          {busy ? "Applying" : "Apply"}
        </button>
      </div>
    </div>
  );
}

function ReferenceImagesPanel({ images, busy, onAddUrl, onUpload, onRemove }: {
  images: ReferenceImage[];
  busy: string | null;
  onAddUrl: (url: string, intendedUse: string, prompt: string) => void | Promise<void>;
  onUpload: (file: File, intendedUse: string) => void | Promise<void>;
  onRemove: (id: string) => void | Promise<void>;
}) {
  const [url, setUrl] = useState("");
  const [use, setUse] = useState<string>("surface_reference");

  return (
    <Panel title={`Reference Images${images.length ? ` (${images.length})` : ""}`}>
      <p className="mb-3 text-xs text-slate-500">
        Generate a prompt pack above, then collect the reference images you&apos;ll build the video from. Upload files or paste image URLs — add as many as you need.
      </p>

      {images.length > 0 && (
        <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {images.map((img) => (
            <div key={img.id} className="group relative overflow-hidden border border-slate-800 bg-slate-950/50">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={img.file_path_or_url} alt={img.intended_use || "reference"} className="h-36 w-full bg-slate-900 object-cover" onError={(e) => { (e.target as HTMLImageElement).style.opacity = "0.25"; }} />
              <div className="p-2">
                <span className="inline-block rounded bg-slate-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-cyan-300">{img.intended_use || "reference"}</span>
                {img.prompt && <p className="mt-1 line-clamp-2 text-[11px] text-slate-400">{img.prompt}</p>}
              </div>
              <button
                onClick={() => onRemove(img.id)}
                disabled={busy === `ref-del:${img.id}`}
                className="absolute right-1 top-1 rounded bg-slate-950/80 p-1 text-slate-400 opacity-0 transition hover:text-red-300 group-hover:opacity-100"
                title="Remove"
              >
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-end gap-2 border-t border-slate-800 pt-3">
        <label className="flex-1">
          <span className="mb-1 block text-[11px] font-semibold uppercase text-slate-500">Image URL or path</span>
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://… or /path/to/image.png" className={inputCls} />
        </label>
        <label>
          <span className="mb-1 block text-[11px] font-semibold uppercase text-slate-500">Use</span>
          <select value={use} onChange={(e) => setUse(e.target.value)} className={inputCls}>
            {REFERENCE_USES.map((u) => <option key={u} value={u}>{u.replace(/_/g, " ")}</option>)}
          </select>
        </label>
        <button
          onClick={() => { if (url.trim()) { onAddUrl(url.trim(), use, ""); setUrl(""); } }}
          disabled={!url.trim() || busy === "ref-add"}
          className="h-10 rounded-lg border border-slate-700 px-3 text-sm font-semibold text-slate-200 hover:border-cyan-500 disabled:opacity-50"
        >
          Add URL
        </button>
        <label className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-lg bg-cyan-600 px-3 text-sm font-semibold text-white hover:bg-cyan-500">
          {busy === "ref-upload" ? "Uploading…" : "Upload file"}
          <input
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => { const file = e.target.files?.[0]; if (file) onUpload(file, use); e.target.value = ""; }}
          />
        </label>
      </div>
    </Panel>
  );
}

function Panel({ title, icon, children }: { title: string; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="border border-slate-800 bg-slate-900/40 p-5">
      <h2 className="mb-3 flex items-center gap-2 font-bold text-white">{icon}{title}</h2>
      {children}
    </section>
  );
}

function Field({ label, wide, children }: { label: string; wide?: boolean; children: React.ReactNode }) {
  return (
    <label className={wide ? "md:col-span-2" : ""}>
      <span className="mb-1 block text-[11px] font-semibold uppercase text-slate-500">{label}</span>
      {children}
    </label>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button onClick={() => { navigator.clipboard.writeText(text); setCopied(true); window.setTimeout(() => setCopied(false), 1500); }} className="inline-flex items-center gap-1 text-xs font-semibold text-cyan-300">
      {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? "Copied" : "Copy"}
    </button>
  );
}

function ListBlock({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="mb-3">
      <h3 className="mb-1 text-[11px] font-bold uppercase text-slate-500">{title}</h3>
      <ul className="list-inside list-disc text-sm text-slate-300">
        {items.map((item, index) => <li key={index}>{item}</li>)}
      </ul>
    </div>
  );
}

function TextBlock({ title, text }: { title: string; text: string }) {
  return (
    <div className="mb-3">
      <h3 className="mb-1 flex items-center gap-2 text-[11px] font-bold uppercase text-slate-500">{title}<CopyButton text={text} /></h3>
      <p className="whitespace-pre-wrap text-sm text-slate-300">{text}</p>
    </div>
  );
}

function Banner({ message, kind }: { message: string; kind: "ok" | "err" }) {
  return <div className={`border p-3 text-sm ${kind === "err" ? "border-red-500/40 bg-red-500/10 text-red-200" : "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"}`}>{message}</div>;
}

const inputCls = "w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none placeholder:text-slate-600 focus:border-cyan-500";

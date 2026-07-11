/**
 * NotesButton + NotesConsole — the operator's mobile-captured notes, one
 * click from the deck header. The pop-up lists global notes (pinned first,
 * newest first) with the mobile app's category filters; each note can be
 * archived, sent to the Praxis terminal ("chat about it" seeds the composer
 * via the `nexus:chat-seed` event), or turned into a Nexus task on a chosen
 * project. The notes API has no archive flag, so archive = category
 * "archived"; converting a note to a task archives it too.
 */
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  StickyNote,
  MessageSquareText,
  Archive,
  ArchiveRestore,
  ListPlus,
  Pin,
  Bot,
  User,
  Loader2,
  Check,
} from "lucide-react";
import { HudModal } from "@/components/bridge/hud";
import { getGlobalNotes, updateNote, addTask, getProjects, type Note, type Project } from "@/lib/nexus";

const CATEGORY_COLORS: Record<string, string> = {
  "daily-log": "#7c5bff",
  general: "#8888a8",
  idea: "#ffb347",
  decision: "#00d4aa",
  bug: "#ff4757",
  reminder: "#ff6b9d",
  blocker: "#ff4757",
  archived: "#555575",
};

/** Render cap per filter — 300+ notes at once makes the pop-up crawl. */
const LIST_LIMIT = 80;

const FILTERS: { label: string; value: string }[] = [
  { label: "All", value: "all" },
  { label: "Ideas", value: "idea" },
  { label: "Daily Log", value: "daily-log" },
  { label: "General", value: "general" },
  { label: "Decisions", value: "decision" },
  { label: "Bugs", value: "bug" },
  { label: "Reminders", value: "reminder" },
  { label: "Archived", value: "archived" },
];

function noteTime(iso: string) {
  return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** Flash + scroll the Praxis core so the operator sees where the note went. */
function warpToTerminal() {
  const el = document.getElementById("station-core");
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.remove("hud-flash");
  void el.offsetWidth;
  el.classList.add("hud-flash");
  window.setTimeout(() => el.classList.remove("hud-flash"), 1700);
}

function NoteCard({
  note,
  projects,
  onLoadProjects,
  onArchive,
  onRestore,
  onTogglePin,
  onChat,
  onMakeTask,
}: {
  note: Note;
  projects: Project[] | null;
  onLoadProjects: () => void;
  onArchive: (n: Note) => Promise<void>;
  onRestore: (n: Note) => Promise<void>;
  onTogglePin: (n: Note) => Promise<void>;
  onChat: (n: Note) => void;
  onMakeTask: (n: Note, projectId: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [projectId, setProjectId] = useState("");
  const [madeTask, setMadeTask] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const isArchived = note.category === "archived";
  const catColor = CATEGORY_COLORS[note.category] || "#555575";
  const isPraxis = note.source === "praxis";

  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  const openPicker = () => {
    onLoadProjects();
    setPicking(true);
  };

  const createTask = () =>
    run(async () => {
      if (!projectId) return;
      await onMakeTask(note, projectId);
      setPicking(false);
      setMadeTask(true);
    });

  return (
    <div className={`rounded-md border border-slate-800 bg-slate-950/50 p-2.5 ${isArchived ? "opacity-60" : ""}`}>
      <div className="mb-1.5 flex items-center gap-2">
        <span className="flex items-center gap-1 text-[10px] font-semibold" style={{ color: isPraxis ? "#7c5bff" : "#00d4aa" }}>
          {isPraxis ? <Bot size={11} /> : <User size={11} />}
          {isPraxis ? "Praxis" : "You"}
        </span>
        <span
          className="rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide"
          style={{ color: catColor, backgroundColor: `${catColor}20` }}
        >
          {note.category}
        </span>
        {note.pinned ? <Pin size={11} className="text-amber-400" /> : null}
        <span className="ml-auto shrink-0 text-[9px] tabular-nums text-slate-600">{noteTime(note.created_at)}</span>
      </div>

      <button
        onClick={() => setExpanded((p) => !p)}
        className={`block w-full whitespace-pre-wrap text-left text-xs leading-relaxed text-slate-300 ${expanded ? "" : "line-clamp-4"}`}
        title={expanded ? "Collapse" : "Expand"}
      >
        {note.content}
      </button>

      <div className="mt-2 flex items-center gap-1.5 border-t border-slate-800/60 pt-1.5">
        {busy && <Loader2 size={11} className="animate-spin text-slate-500" />}
        {madeTask && (
          <span className="flex items-center gap-1 text-[10px] text-emerald-400">
            <Check size={11} /> task created · note archived
          </span>
        )}
        <span className="flex-1" />
        {!isArchived && !madeTask && (
          <>
            <button
              onClick={() => onChat(note)}
              className="flex items-center gap-1 rounded border border-slate-800 bg-slate-900/60 px-1.5 py-0.5 text-[10px] text-cyan-300 transition-colors hover:border-cyan-500/40 hover:text-cyan-200"
              title="Send this note to the Praxis terminal"
            >
              <MessageSquareText size={11} /> chat
            </button>
            <button
              onClick={openPicker}
              className="flex items-center gap-1 rounded border border-slate-800 bg-slate-900/60 px-1.5 py-0.5 text-[10px] text-emerald-300 transition-colors hover:border-emerald-500/40 hover:text-emerald-200"
              title="Turn this note into a Nexus task"
            >
              <ListPlus size={11} /> task
            </button>
            <button
              onClick={() => run(() => onTogglePin(note))}
              className="flex items-center gap-1 rounded border border-slate-800 bg-slate-900/60 px-1.5 py-0.5 text-[10px] text-slate-400 transition-colors hover:border-amber-500/40 hover:text-amber-300"
              title={note.pinned ? "Unpin" : "Pin to top"}
            >
              <Pin size={11} /> {note.pinned ? "unpin" : "pin"}
            </button>
            <button
              onClick={() => run(() => onArchive(note))}
              className="flex items-center gap-1 rounded border border-slate-800 bg-slate-900/60 px-1.5 py-0.5 text-[10px] text-slate-400 transition-colors hover:border-slate-600 hover:text-slate-200"
              title="Archive this note"
            >
              <Archive size={11} /> archive
            </button>
          </>
        )}
        {isArchived && (
          <button
            onClick={() => run(() => onRestore(note))}
            className="flex items-center gap-1 rounded border border-slate-800 bg-slate-900/60 px-1.5 py-0.5 text-[10px] text-slate-400 transition-colors hover:border-slate-600 hover:text-slate-200"
            title="Restore to General"
          >
            <ArchiveRestore size={11} /> restore
          </button>
        )}
      </div>

      {picking && (
        <div className="mt-2 flex items-center gap-2 rounded border border-emerald-500/30 bg-emerald-500/5 p-1.5">
          <select
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            className="min-w-0 flex-1 rounded border border-slate-700 bg-slate-950 px-1.5 py-1 text-[11px] text-slate-200 focus:border-emerald-500/60 focus:outline-none"
          >
            <option value="">
              {projects === null ? "loading projects…" : "choose a project…"}
            </option>
            {(projects ?? [])
              .filter((p) => p.status !== "archived")
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
          </select>
          <button
            onClick={createTask}
            disabled={!projectId || busy}
            className="shrink-0 rounded border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-[10px] font-semibold text-emerald-300 transition-colors hover:bg-emerald-500/20 disabled:opacity-40"
          >
            create task
          </button>
          <button
            onClick={() => setPicking(false)}
            className="shrink-0 rounded border border-slate-800 px-2 py-1 text-[10px] text-slate-500 hover:text-slate-300"
          >
            cancel
          </button>
        </div>
      )}
    </div>
  );
}

function NotesConsole({ onClose }: { onClose: () => void }) {
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [err, setErr] = useState(false);
  const [filter, setFilter] = useState("all");
  const [projects, setProjects] = useState<Project[] | null>(null);

  const load = useCallback(async () => {
    try {
      setNotes(await getGlobalNotes());
      setErr(false);
    } catch {
      setErr(true);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const loadProjects = useCallback(() => {
    if (projects !== null) return;
    getProjects()
      .then((p) => setProjects(p || []))
      .catch(() => setProjects([]));
  }, [projects]);

  const patchLocal = (id: string, updates: Partial<Note>) =>
    setNotes((prev) => (prev ? prev.map((n) => (n.id === id ? { ...n, ...updates } : n)) : prev));

  const onArchive = async (n: Note) => {
    await updateNote(n.id, { category: "archived" });
    patchLocal(n.id, { category: "archived" as Note["category"] });
  };

  const onRestore = async (n: Note) => {
    await updateNote(n.id, { category: "general" });
    patchLocal(n.id, { category: "general" });
  };

  const onTogglePin = async (n: Note) => {
    await updateNote(n.id, { pinned: n.pinned ? 0 : 1 });
    patchLocal(n.id, { pinned: !n.pinned });
  };

  const onChat = (n: Note) => {
    const text = `Let's talk about this note I captured on ${noteTime(n.created_at)}:\n\n${n.content}`;
    window.dispatchEvent(new CustomEvent("nexus:chat-seed", { detail: { text } }));
    onClose();
    warpToTerminal();
  };

  const onMakeTask = async (n: Note, projectId: string) => {
    const firstLine = n.content.split("\n")[0].trim();
    const title = firstLine.length > 90 ? `${firstLine.slice(0, 89)}…` : firstLine || "Note follow-up";
    const description = `${n.content}\n\n—\nCreated from an operator note captured ${noteTime(n.created_at)} (${n.source}).`;
    await addTask(projectId, title, description);
    await updateNote(n.id, { category: "archived" });
    patchLocal(n.id, { category: "archived" as Note["category"] });
  };

  const visible = useMemo(() => {
    if (!notes) return [];
    const matched =
      filter === "all" ? notes.filter((n) => n.category !== "archived") : notes.filter((n) => n.category === filter);
    return [...matched].sort((a, b) => {
      if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    });
  }, [notes, filter]);

  const liveCount = notes?.filter((n) => n.category !== "archived").length ?? 0;

  return (
    <HudModal
      title="Operator notes"
      subtitle={`captured on the go · ${liveCount} live · archive, discuss, or dispatch`}
      icon={<StickyNote size={15} />}
      accent="amber"
      onClose={onClose}
      wide
    >
      <div className="space-y-3">
        <div className="flex flex-wrap gap-1">
          {FILTERS.map((f) => {
            const isActive = filter === f.value;
            return (
              <button
                key={f.value}
                onClick={() => setFilter(f.value)}
                className={`rounded-md border px-2 py-1 text-[10px] transition-colors ${
                  isActive
                    ? "border-amber-500/50 bg-amber-500/15 text-amber-200"
                    : "border-slate-800 bg-slate-950/60 text-slate-400 hover:text-slate-200"
                }`}
              >
                {f.label}
              </button>
            );
          })}
        </div>

        {err && !notes ? (
          <div className="rounded border border-dashed border-slate-800 px-3 py-6 text-center text-xs text-slate-600">
            Notes unavailable — the Nexus API didn&apos;t answer.
          </div>
        ) : notes === null ? (
          <div className="py-6 text-center text-xs text-slate-500">Loading notes…</div>
        ) : visible.length === 0 ? (
          <div className="rounded border border-dashed border-slate-800 px-3 py-6 text-center text-xs text-slate-600">
            {filter === "all" ? "No notes yet — capture some from the mobile app." : `No ${filter} notes.`}
          </div>
        ) : (
          <div className="space-y-2">
            {visible.slice(0, LIST_LIMIT).map((n) => (
              <NoteCard
                key={n.id}
                note={n}
                projects={projects}
                onLoadProjects={loadProjects}
                onArchive={onArchive}
                onRestore={onRestore}
                onTogglePin={onTogglePin}
                onChat={onChat}
                onMakeTask={onMakeTask}
              />
            ))}
            {visible.length > LIST_LIMIT && (
              <p className="px-1 pt-1 text-center text-[10px] text-slate-600">
                showing {LIST_LIMIT} of {visible.length} — pick a category filter to narrow
              </p>
            )}
          </div>
        )}
      </div>
    </HudModal>
  );
}

export function NotesButton() {
  const [open, setOpen] = useState(false);
  const [count, setCount] = useState<number | null>(null);

  // Light badge fetch on mount; refreshed whenever the console closes.
  const refreshCount = useCallback(async () => {
    try {
      const notes = await getGlobalNotes();
      setCount(notes.filter((n) => n.category !== "archived").length);
    } catch {
      /* badge stays as-is */
    }
  }, []);

  useEffect(() => {
    refreshCount();
  }, [refreshCount]);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="relative rounded-lg border border-slate-800 bg-slate-900/50 p-1.5 text-slate-400 transition-all hover:bg-slate-800 hover:text-white"
        aria-label="Open operator notes"
        title="Operator notes — captured from the mobile app"
      >
        <StickyNote size={18} />
        {count != null && count > 0 && (
          <span className="absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full border border-amber-400/50 bg-amber-500/20 px-0.5 text-[9px] font-bold tabular-nums text-amber-300">
            {count > 99 ? "99+" : count}
          </span>
        )}
      </button>
      {open && (
        <NotesConsole
          onClose={() => {
            setOpen(false);
            refreshCount();
          }}
        />
      )}
    </>
  );
}

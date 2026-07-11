/**
 * TaskBoardStation — "Tactical": the live mission board as a bridge station.
 * Everything currently on the Nexus board — anything needing the operator
 * (glowing rose, echoing the Ops attention counter), dispatched work in
 * flight (light-sweep effect), and the queued successors — with every row
 * linking straight to that task's console (/task/[id]). The full kanban
 * lives behind the header link.
 */
"use client";

import Link from "next/link";
import { ClipboardList, ArrowUpRight, AlertTriangle, Play, CircleDashed } from "lucide-react";
import { HudPanel } from "@/components/bridge/hud";
import { groupBoardTasks, type BoardTask } from "@/lib/task-board";
import { useBoardState } from "@/hooks/use-board-state";
import { useStreamRefetch } from "@/hooks/use-stream-refetch";

const QUEUE_LIMIT = 5;

function taskTitle(t: BoardTask) {
  return (t.title || t.name || "Untitled task").replace(/\s+/g, " ");
}

function prettyStatus(status?: string) {
  return (status || "ready").replace(/[_-]+/g, " ");
}

function timeAgo(t: BoardTask): string {
  const iso = t.updated_at || t.updatedAt || t.created_at || t.createdAt;
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 60_000) return "now";
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function SectionLabel({ tone, children }: { tone: string; children: React.ReactNode }) {
  return (
    <div className={`flex items-center gap-2 text-[9px] font-semibold uppercase tracking-widest ${tone}`}>
      <span>{children}</span>
      <span className="h-px flex-1 bg-slate-800/80" />
    </div>
  );
}

/** Blocked / failed / awaiting input — glows to pull the eye, like the Ops counter promised. */
function AttentionRow({ task }: { task: BoardTask }) {
  return (
    <Link
      href={`/task/${task.id}`}
      className="flex items-center gap-2 rounded-md border border-rose-500/40 bg-rose-500/10 px-2 py-1.5 shadow-[0_0_14px_rgba(244,63,94,0.18)] transition-colors hover:border-rose-400/70 hover:bg-rose-500/15"
      title="Open this task's console"
    >
      <AlertTriangle size={13} className="shrink-0 text-rose-400 motion-safe:animate-pulse" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-semibold text-rose-100">{taskTitle(task)}</span>
        <span className="block truncate text-[10px] text-rose-300/60">{task.projectName || "Unknown project"}</span>
      </span>
      <span className="shrink-0 rounded border border-rose-500/40 bg-rose-950/40 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-rose-300">
        {prettyStatus(task.status)}
      </span>
    </Link>
  );
}

/** Running right now — a light sweep crosses the card while it works. */
function ActiveRow({ task }: { task: BoardTask }) {
  return (
    <Link
      href={`/task/${task.id}`}
      className="relative flex items-center gap-2 overflow-hidden rounded-md border border-violet-500/30 bg-violet-500/5 px-2 py-1.5 transition-colors hover:border-violet-400/60 hover:bg-violet-500/10"
      title="Open this task's console and run logs"
    >
      <span className="hud-sheen pointer-events-none absolute inset-y-0 left-0 w-1/3 bg-gradient-to-r from-transparent via-violet-300/10 to-transparent" />
      <Play size={12} className="shrink-0 text-violet-300 motion-safe:animate-pulse" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-semibold text-slate-100">{taskTitle(task)}</span>
        <span className="block truncate text-[10px] text-slate-500">{task.projectName || "Unknown project"}</span>
      </span>
      <span className="shrink-0 text-right">
        <span className="block text-[9px] font-semibold uppercase tracking-wide text-violet-300">
          {prettyStatus(task.status)}
        </span>
        <span className="block text-[9px] tabular-nums text-slate-600">{timeAgo(task)}</span>
      </span>
    </Link>
  );
}

/** Queued successor / scheduled work waiting its turn. */
function QueuedRow({ task }: { task: BoardTask }) {
  return (
    <Link
      href={`/task/${task.id}`}
      className="flex items-center gap-2 rounded px-1.5 py-1 transition-colors hover:bg-slate-800/50"
      title={`${taskTitle(task)} — open task console`}
    >
      <CircleDashed size={11} className="shrink-0 text-sky-400/70" />
      <span className="min-w-0 flex-1 truncate text-[11px] text-slate-300">{taskTitle(task)}</span>
      <span className="max-w-24 shrink-0 truncate text-[9px] text-slate-600">{task.projectName}</span>
      <span className="w-5 shrink-0 text-right text-[9px] tabular-nums text-slate-600">P{Number(task.priority ?? 0)}</span>
    </Link>
  );
}

export function TaskBoardStation() {
  // Deck-wide shared board poller (one fetch loop no matter how many
  // stations subscribe); stream events nudge it between polls.
  const { projects, loading, refresh } = useBoardState();

  useStreamRefetch(
    ["task.created", "task.updated", "task.started", "task.completed", "task.failed", "task.blocked"],
    refresh,
  );

  const grouped = groupBoardTasks(projects ?? []);
  const attention = grouped.needs_attention.tasks;
  const active = grouped.in_progress.tasks;
  const queued = [...grouped.ready.tasks, ...grouped.new.tasks];
  const onBoard = attention.length + active.length + queued.length;

  return (
    <HudPanel
      icon={<ClipboardList size={16} />}
      title="TACTICAL — TASK BOARD"
      accent="emerald"
      className="flex h-full flex-col"
      headerRight={
        <>
          <span className="text-[10px] tabular-nums text-slate-500">{onBoard} on board</span>
          <Link href="/task-board" className="flex items-center gap-1 text-[11px] text-cyan-400 hover:text-cyan-300">
            kanban <ArrowUpRight size={12} />
          </Link>
        </>
      }
    >
      {loading ? (
        <div className="py-4 text-center text-xs text-slate-500">Reading the board…</div>
      ) : onBoard === 0 ? (
        <div className="rounded border border-dashed border-slate-800 px-2 py-6 text-center text-xs text-slate-600">
          Board clear — nothing dispatched or queued.
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-2.5">
          {attention.length > 0 && (
            <div className="space-y-1.5">
              <SectionLabel tone="text-rose-400">needs your attention</SectionLabel>
              {attention.map((t) => (
                <AttentionRow key={t.id} task={t} />
              ))}
            </div>
          )}

          {active.length > 0 && (
            <div className="space-y-1.5">
              <SectionLabel tone="text-violet-300">active now</SectionLabel>
              {active.map((t) => (
                <ActiveRow key={t.id} task={t} />
              ))}
            </div>
          )}

          {queued.length > 0 && (
            <div className="space-y-1">
              <SectionLabel tone="text-slate-500">up next · {queued.length}</SectionLabel>
              {queued.slice(0, QUEUE_LIMIT).map((t) => (
                <QueuedRow key={t.id} task={t} />
              ))}
              {queued.length > QUEUE_LIMIT && (
                <Link
                  href="/task-board"
                  className="block px-1.5 text-[10px] text-slate-600 transition-colors hover:text-slate-400"
                >
                  +{queued.length - QUEUE_LIMIT} more queued on the kanban
                </Link>
              )}
            </div>
          )}
        </div>
      )}
    </HudPanel>
  );
}

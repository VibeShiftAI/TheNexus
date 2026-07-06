"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowUpDown,
  Check,
  ChevronDown,
  CircleDot,
  ExternalLink,
  Filter,
  Layers,
  Loader2,
  MessageSquareText,
  Pencil,
  RefreshCw,
  Search,
  Table2,
} from "lucide-react";
import { getBoardState, updateTask } from "@/lib/nexus";
import { TaskEditModal, STATUS_OPTIONS } from "@/components/task-edit-modal";
import {
  BOARD_LANES,
  BOARD_SORT_OPTIONS,
  DEFAULT_BOARD_SORT,
  DEFAULT_VISIBLE_LANE_IDS,
  filterBoardTasks,
  formatBoardTime,
  groupBoardTasks,
  sortBoardTasks,
  type BoardLane,
  type BoardLaneId,
  type BoardProject,
  type BoardSortKey,
  type BoardTask,
} from "@/lib/task-board";

const POLL_MS = 12_000;
const VISIBLE_LANES_STORAGE_KEY = "nexus.taskBoard.visibleLanes";
const LANE_SORT_STORAGE_KEY = "nexus.taskBoard.laneSort";
const KNOWN_LANE_IDS = new Set<BoardLaneId>(BOARD_LANES.map((lane) => lane.id));
const KNOWN_SORT_KEYS = new Set<BoardSortKey>(BOARD_SORT_OPTIONS.map((option) => option.value));

type LaneSortMap = Record<BoardLaneId, BoardSortKey>;

function defaultLaneSort(): LaneSortMap {
  return BOARD_LANES.reduce((acc, lane) => {
    acc[lane.id] = DEFAULT_BOARD_SORT;
    return acc;
  }, {} as LaneSortMap);
}

function readStoredVisibleLanes(): Set<BoardLaneId> | null {
  try {
    const raw = window.localStorage.getItem(VISIBLE_LANES_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const valid = parsed.filter((id): id is BoardLaneId => KNOWN_LANE_IDS.has(id));
    return new Set(valid);
  } catch {
    return null;
  }
}

function readStoredLaneSort(): LaneSortMap | null {
  try {
    const raw = window.localStorage.getItem(LANE_SORT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const next = defaultLaneSort();
    for (const lane of BOARD_LANES) {
      const value = (parsed as Record<string, unknown>)[lane.id];
      if (typeof value === "string" && KNOWN_SORT_KEYS.has(value as BoardSortKey)) {
        next[lane.id] = value as BoardSortKey;
      }
    }
    return next;
  } catch {
    return null;
  }
}

export default function TaskBoardPage() {
  const [projects, setProjects] = useState<BoardProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [projectId, setProjectId] = useState("all");
  const [visibleLaneIds, setVisibleLaneIds] = useState<Set<BoardLaneId>>(
    () => new Set(DEFAULT_VISIBLE_LANE_IDS),
  );
  const [laneSort, setLaneSort] = useState<LaneSortMap>(() => defaultLaneSort());
  const [editingTask, setEditingTask] = useState<BoardTask | null>(null);

  const toggleLane = useCallback((id: BoardLaneId) => {
    setVisibleLaneIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const setLaneSortKey = useCallback((laneId: BoardLaneId, sortKey: BoardSortKey) => {
    setLaneSort((prev) => ({ ...prev, [laneId]: sortKey }));
  }, []);

  // Restore the operator's saved lane selection on mount, then persist any
  // change so it survives reloads. `didHydrateRef` skips the very first persist
  // pass so the default set never clobbers a stored selection.
  const didHydrateRef = useRef(false);
  useEffect(() => {
    const stored = readStoredVisibleLanes();
    if (stored) setVisibleLaneIds(stored);
  }, []);
  useEffect(() => {
    if (!didHydrateRef.current) {
      didHydrateRef.current = true;
      return;
    }
    try {
      window.localStorage.setItem(VISIBLE_LANES_STORAGE_KEY, JSON.stringify([...visibleLaneIds]));
    } catch {
      // Storage unavailable (private mode / quota); board still works in-session.
    }
  }, [visibleLaneIds]);

  // Same restore-then-persist dance for each column's sort choice.
  const didHydrateSortRef = useRef(false);
  useEffect(() => {
    const stored = readStoredLaneSort();
    if (stored) setLaneSort(stored);
  }, []);
  useEffect(() => {
    if (!didHydrateSortRef.current) {
      didHydrateSortRef.current = true;
      return;
    }
    try {
      window.localStorage.setItem(LANE_SORT_STORAGE_KEY, JSON.stringify(laneSort));
    } catch {
      // Storage unavailable; sort still applies in-session.
    }
  }, [laneSort]);

  const loadBoard = useCallback(async (mode: "initial" | "refresh" = "refresh") => {
    if (mode === "initial") {
      setLoading(true);
    } else {
      setRefreshing(true);
    }

    try {
      const data = await getBoardState();
      setProjects(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch board state");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadBoard("initial");
    const timer = window.setInterval(() => loadBoard("refresh"), POLL_MS);
    return () => window.clearInterval(timer);
  }, [loadBoard]);

  const grouped = useMemo(() => groupBoardTasks(projects), [projects]);
  const visibleLanes = useMemo(() => {
    return BOARD_LANES
      .filter((lane) => visibleLaneIds.has(lane.id))
      .map((lane) => {
        const tasks = filterBoardTasks(grouped[lane.id].tasks, { projectId, laneId: "all", query });
        return {
          ...grouped[lane.id],
          tasks: sortBoardTasks(tasks, laneSort[lane.id]),
        };
      });
  }, [grouped, visibleLaneIds, projectId, query, laneSort]);

  const totalTasks = useMemo(() => Object.values(grouped).reduce((sum, lane) => sum + lane.tasks.length, 0), [grouped]);
  const visibleTasks = useMemo(() => visibleLanes.reduce((sum, lane) => sum + lane.tasks.length, 0), [visibleLanes]);
  const lastUpdated = useMemo(() => {
    const timestamps = projects
      .flatMap((project) => project.tasks || [])
      .map((task) => task.updated_at || task.updatedAt || task.created_at || task.createdAt)
      .filter(Boolean) as string[];

    if (timestamps.length === 0) return "No task timestamps";
    const latest = timestamps.sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0];
    return formatBoardTime(latest);
  }, [projects]);

  // Inline status change directly from a card (the most common board action).
  const handleQuickStatus = useCallback(async (task: BoardTask, nextStatus: string) => {
    const tProjectId = task.projectId || task.project_id;
    if (!tProjectId) return;

    // Optimistic update so the card jumps lanes immediately.
    setProjects((prev) =>
      prev.map((project) => ({
        ...project,
        tasks: (project.tasks || []).map((t) =>
          t.id === task.id ? { ...t, status: nextStatus, updated_at: new Date().toISOString() } : t,
        ),
      })),
    );

    try {
      await updateTask(tProjectId, task.id, { status: nextStatus });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update status");
      loadBoard("refresh");
    }
  }, [loadBoard]);

  return (
    <main className="min-h-screen bg-slate-950 text-slate-200 selection:bg-cyan-500/30">
      <header className="sticky top-0 z-50 border-b border-slate-800 bg-slate-950/90 backdrop-blur-md">
        <div className="container mx-auto flex min-h-16 flex-wrap items-center justify-between gap-3 px-6 py-3">
          <div className="flex items-center gap-4">
            <Link href="/" className="flex items-center gap-2 text-sm text-slate-400 transition-colors hover:text-white">
              <ArrowLeft size={18} />
              <span>Dashboard</span>
            </Link>
            <div className="h-6 w-px bg-slate-700" />
            <div className="flex items-center gap-2">
              <div className="h-2 w-2 rounded-full bg-cyan-500" />
              <h1 className="text-xl font-bold text-white">
                THE <span className="text-cyan-400">NEXUS</span>
              </h1>
            </div>
          </div>

          <div className="flex items-center gap-3 text-sm font-medium text-slate-400">
            <div className="flex items-center gap-2 rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-3 py-1.5 text-cyan-300">
              <Table2 size={16} />
              <span>Task Board</span>
            </div>
            <div className="hidden items-center gap-2 md:flex">
              <CircleDot size={16} className="text-emerald-400" />
              <span>{visibleTasks} visible</span>
            </div>
          </div>
        </div>
      </header>

      <div className="container mx-auto space-y-5 p-6">
        <section className="flex flex-wrap items-end justify-between gap-4 border-b border-slate-800 pb-5">
          <div>
            <h2 className="text-2xl font-semibold text-white">Daily Command Board</h2>
            <p className="mt-1 text-sm text-slate-400">
              {totalTasks} tasks across {projects.length} active projects. Last task update: {lastUpdated}.
            </p>
          </div>

          <button
            onClick={() => loadBoard("refresh")}
            disabled={refreshing}
            className="flex h-10 items-center gap-2 rounded-lg border border-slate-700 bg-slate-900 px-3 text-sm text-slate-300 transition-colors hover:border-cyan-500/50 hover:text-cyan-200 disabled:opacity-60"
          >
            <RefreshCw size={16} className={refreshing ? "animate-spin" : ""} />
            <span>Refresh</span>
          </button>
        </section>

        <section className="grid gap-3 border-b border-slate-800 pb-5 md:grid-cols-[1fr_220px_220px]">
          <label className="relative block">
            <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" size={16} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="h-11 w-full rounded-lg border border-slate-800 bg-slate-900 pl-10 pr-3 text-sm text-slate-100 outline-none transition-colors placeholder:text-slate-500 focus:border-cyan-500/60"
              placeholder="Search tasks, projects, statuses"
            />
          </label>

          <label className="relative block">
            <Filter className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" size={16} />
            <select
              value={projectId}
              onChange={(event) => setProjectId(event.target.value)}
              className="h-11 w-full appearance-none rounded-lg border border-slate-800 bg-slate-900 pl-10 pr-3 text-sm text-slate-100 outline-none transition-colors focus:border-cyan-500/60"
            >
              <option value="all">All projects</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>{project.name}</option>
              ))}
            </select>
          </label>

          <LaneFilterMenu
            visibleLaneIds={visibleLaneIds}
            onToggle={toggleLane}
            onReset={() => setVisibleLaneIds(new Set(DEFAULT_VISIBLE_LANE_IDS))}
          />
        </section>

        {error && (
          <div className="flex items-start gap-3 rounded-lg border border-rose-500/40 bg-rose-500/10 p-4 text-rose-200">
            <AlertTriangle size={18} className="mt-0.5 shrink-0" />
            <div>
              <p className="font-medium">Board connection failed</p>
              <p className="text-sm text-rose-200/80">{error}</p>
            </div>
          </div>
        )}

        {loading ? (
          <div className="flex min-h-[360px] items-center justify-center text-cyan-300">
            <Loader2 className="animate-spin" size={32} />
          </div>
        ) : (
          <section className="flex gap-4 overflow-x-auto pb-3 scrollbar-thin">
            {visibleLanes.map((lane) => (
              <LaneColumn
                key={lane.id}
                lane={lane}
                sortKey={laneSort[lane.id]}
                onSortChange={(sortKey) => setLaneSortKey(lane.id, sortKey)}
                onManage={setEditingTask}
                onQuickStatus={handleQuickStatus}
              />
            ))}
          </section>
        )}
      </div>

      <TaskEditModal
        task={editingTask}
        isOpen={editingTask !== null}
        onClose={() => setEditingTask(null)}
        onSaved={() => loadBoard("refresh")}
      />
    </main>
  );
}

function LaneFilterMenu({
  visibleLaneIds,
  onToggle,
  onReset,
}: {
  visibleLaneIds: Set<BoardLaneId>;
  onToggle: (id: BoardLaneId) => void;
  onReset: () => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handlePointer = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", handlePointer);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handlePointer);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  const selectedCount = visibleLaneIds.size;

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-haspopup="true"
        aria-expanded={open}
        className="flex h-11 w-full items-center gap-2 rounded-lg border border-slate-800 bg-slate-900 pl-10 pr-3 text-sm text-slate-100 outline-none transition-colors focus:border-cyan-500/60"
      >
        <Filter className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" size={16} />
        <span className="flex-1 text-left">
          Lanes <span className="text-slate-500">({selectedCount}/{BOARD_LANES.length})</span>
        </span>
        <ChevronDown size={16} className={`shrink-0 text-slate-500 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="absolute right-0 z-50 mt-2 w-64 rounded-lg border border-slate-800 bg-slate-900 p-2 shadow-xl shadow-black/40">
          <div className="flex items-center justify-between px-2 py-1.5">
            <span className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-slate-400">
              <Layers size={13} />
              Show lanes
            </span>
            <button
              type="button"
              onClick={onReset}
              className="text-xs text-slate-500 transition-colors hover:text-cyan-300"
            >
              Reset
            </button>
          </div>
          <div className="mt-1 space-y-0.5">
            {BOARD_LANES.map((lane) => {
              const checked = visibleLaneIds.has(lane.id);
              return (
                <button
                  key={lane.id}
                  type="button"
                  onClick={() => onToggle(lane.id)}
                  className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm text-slate-200 transition-colors hover:bg-slate-800"
                >
                  <span
                    className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors ${
                      checked ? "border-cyan-500 bg-cyan-500 text-slate-950" : "border-slate-600 bg-slate-950"
                    }`}
                  >
                    {checked && <Check size={12} strokeWidth={3} />}
                  </span>
                  <span className="flex-1">{lane.title}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// Compact per-column sort picker. A native <select> keeps it accessible and
// gives a real picker on mobile / touch without extra popover plumbing.
function LaneSortControl({
  lane,
  sortKey,
  onSortChange,
}: {
  lane: BoardLane;
  sortKey: BoardSortKey;
  onSortChange: (sortKey: BoardSortKey) => void;
}) {
  return (
    <label className="relative mt-2 block">
      <ArrowUpDown className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-slate-500" size={12} />
      <select
        value={sortKey}
        onChange={(event) => onSortChange(event.target.value as BoardSortKey)}
        className="h-7 w-full appearance-none rounded-md border border-slate-800 bg-slate-900 pl-7 pr-6 text-xs text-slate-300 outline-none transition-colors hover:border-cyan-500/40 focus:border-cyan-500/60"
        aria-label={`Sort ${lane.title} column`}
        title="Sort this column"
      >
        {BOARD_SORT_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            Sort: {option.label}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-slate-500" size={12} />
    </label>
  );
}

function LaneColumn({
  lane,
  sortKey,
  onSortChange,
  onManage,
  onQuickStatus,
}: {
  lane: BoardLane;
  sortKey: BoardSortKey;
  onSortChange: (sortKey: BoardSortKey) => void;
  onManage: (task: BoardTask) => void;
  onQuickStatus: (task: BoardTask, nextStatus: string) => void;
}) {
  return (
    <div className="flex min-h-[520px] w-72 shrink-0 flex-col rounded-lg border border-slate-800 bg-slate-950 xl:w-auto xl:flex-1">
      <div className={`border-b px-3 py-3 ${lane.accentClass}`}>
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold uppercase">{lane.title}</h3>
          <span className="rounded-md border border-slate-700 bg-slate-900 px-2 py-0.5 text-xs text-slate-300">
            {lane.tasks.length}
          </span>
        </div>
        <p className="mt-1 min-h-8 text-xs normal-case text-slate-500">{lane.description}</p>
        <LaneSortControl lane={lane} sortKey={sortKey} onSortChange={onSortChange} />
      </div>

      <div className="space-y-3 p-3">
        {lane.tasks.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-800 p-4 text-center text-sm text-slate-500">
            Nothing here
          </div>
        ) : (
          lane.tasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              onManage={onManage}
              onQuickStatus={onQuickStatus}
            />
          ))
        )}
      </div>
    </div>
  );
}

function TaskCard({
  task,
  onManage,
  onQuickStatus,
}: {
  task: BoardTask;
  onManage: (task: BoardTask) => void;
  onQuickStatus: (task: BoardTask, nextStatus: string) => void;
}) {
  const title = task.title || task.name || "Untitled task";
  const taskProjectId = task.projectId || task.project_id;
  const updated = task.updated_at || task.updatedAt || task.created_at || task.createdAt;
  const description = task.description?.trim();
  const metadata = task.metadata || {};
  const hasTranscript = Boolean(metadata.codex_transcript_path || metadata.praxis_transcript_path || metadata.transcript_path);
  const detailHref = taskProjectId ? `/project/${taskProjectId}?taskId=${task.id}` : "/";

  return (
    <article className="rounded-lg border border-slate-800 bg-slate-900/80 p-3 shadow-sm shadow-black/20 transition-colors hover:border-slate-700">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <Link href={detailHref} className="group inline-flex min-w-0 items-start gap-2">
            <span className="line-clamp-2 text-sm font-semibold leading-5 text-slate-100 group-hover:text-cyan-200">
              {title}
            </span>
            <ExternalLink size={13} className="mt-1 shrink-0 text-slate-500 group-hover:text-cyan-300" />
          </Link>
          <p className="mt-1 truncate text-xs text-slate-500">{task.projectName || "Unknown project"}</p>
        </div>
        <button
          onClick={() => onManage(task)}
          className="shrink-0 rounded-md border border-slate-700 bg-slate-950 p-1.5 text-slate-400 transition-colors hover:border-cyan-500/40 hover:text-cyan-300"
          aria-label="Edit task"
          title="Edit task (status, description, cancel, delete)"
        >
          <Pencil size={13} />
        </button>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
        <select
          value={task.status || ""}
          onChange={(e) => onQuickStatus(task, e.target.value)}
          onClick={(e) => e.stopPropagation()}
          className="max-w-[150px] rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-slate-300 outline-none transition-colors hover:border-cyan-500/40 focus:border-cyan-500/60"
          aria-label="Change task status"
          title="Change status"
        >
          {!STATUS_OPTIONS.some((o) => o.value === (task.status || "")) && task.status && (
            <option value={task.status}>{task.status}</option>
          )}
          {STATUS_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
        <span className="rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-slate-400">
          P{task.priority ?? 0}
        </span>
        {hasTranscript && (
          <span className="inline-flex items-center gap-1 rounded-md border border-cyan-400/30 px-2 py-1 text-cyan-200">
            <MessageSquareText size={12} />
            transcript
          </span>
        )}
      </div>

      {description ? (
        <p className="mt-3 line-clamp-4 text-xs leading-5 text-slate-400">
          {description}
        </p>
      ) : (
        <p className="mt-3 text-xs italic text-slate-600">
          No description
        </p>
      )}

      <div className="mt-3 text-xs text-slate-500">
        Updated {formatBoardTime(updated)}
      </div>
    </article>
  );
}

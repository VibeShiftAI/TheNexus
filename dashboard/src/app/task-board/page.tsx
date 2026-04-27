"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowLeft,
  CircleDot,
  ExternalLink,
  Filter,
  Loader2,
  MessageSquareText,
  RefreshCw,
  Search,
  Table2,
} from "lucide-react";
import { getBoardState } from "@/lib/nexus";
import {
  BOARD_LANES,
  filterBoardTasks,
  formatBoardTime,
  groupBoardTasks,
  type BoardFilterLaneId,
  type BoardLane,
  type BoardProject,
  type BoardTask,
} from "@/lib/task-board";

const POLL_MS = 12_000;

export default function TaskBoardPage() {
  const [projects, setProjects] = useState<BoardProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [projectId, setProjectId] = useState("all");
  const [laneId, setLaneId] = useState<BoardFilterLaneId>("all");

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
      .filter((lane) => laneId === "all" || lane.id === laneId)
      .map((lane) => ({
        ...grouped[lane.id],
        tasks: filterBoardTasks(grouped[lane.id].tasks, { projectId, laneId, query }),
      }));
  }, [grouped, laneId, projectId, query]);

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

          <label className="relative block">
            <Filter className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" size={16} />
            <select
              value={laneId}
              onChange={(event) => setLaneId(event.target.value as BoardFilterLaneId)}
              className="h-11 w-full appearance-none rounded-lg border border-slate-800 bg-slate-900 pl-10 pr-3 text-sm text-slate-100 outline-none transition-colors focus:border-cyan-500/60"
            >
              <option value="all">All lanes</option>
              {BOARD_LANES.map((lane) => (
                <option key={lane.id} value={lane.id}>{lane.title}</option>
              ))}
            </select>
          </label>
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
          <section className="grid gap-4 xl:grid-cols-5">
            {visibleLanes.map((lane) => (
              <LaneColumn
                key={lane.id}
                lane={lane}
              />
            ))}
          </section>
        )}
      </div>
    </main>
  );
}

function LaneColumn({
  lane,
}: {
  lane: BoardLane;
}) {
  return (
    <div className="min-h-[520px] rounded-lg border border-slate-800 bg-slate-950">
      <div className={`border-b px-3 py-3 ${lane.accentClass}`}>
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold uppercase">{lane.title}</h3>
          <span className="rounded-md border border-slate-700 bg-slate-900 px-2 py-0.5 text-xs text-slate-300">
            {lane.tasks.length}
          </span>
        </div>
        <p className="mt-1 min-h-8 text-xs normal-case text-slate-500">{lane.description}</p>
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
            />
          ))
        )}
      </div>
    </div>
  );
}

function TaskCard({
  task,
}: {
  task: BoardTask;
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
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Link href={detailHref} className="group inline-flex min-w-0 items-start gap-2">
            <span className="line-clamp-2 text-sm font-semibold leading-5 text-slate-100 group-hover:text-cyan-200">
              {title}
            </span>
            <ExternalLink size={13} className="mt-1 shrink-0 text-slate-500 group-hover:text-cyan-300" />
          </Link>
          <p className="mt-1 truncate text-xs text-slate-500">{task.projectName || "Unknown project"}</p>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
        <span className="rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-slate-300">
          {task.status || "unknown"}
        </span>
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

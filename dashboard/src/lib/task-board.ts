export type BoardLaneId = "new" | "ready" | "in_progress" | "needs_attention" | "complete" | "cancelled" | "archived";
export type BoardFilterLaneId = BoardLaneId | "all";

export interface BoardTask {
  id: string;
  project_id?: string;
  title?: string;
  name?: string;
  description?: string;
  status?: string;
  priority?: number | string | null;
  source?: string | null;
  is_unblocked?: boolean;
  created_at?: string;
  createdAt?: string;
  updated_at?: string;
  updatedAt?: string;
  metadata?: Record<string, unknown> | null;
  projectId?: string;
  projectName?: string;
  laneId?: BoardLaneId;
}

export interface BoardProject {
  id: string;
  name: string;
  description?: string;
  status?: string;
  priority?: number | string | null;
  tasks?: BoardTask[];
  task_summary?: {
    total?: number;
    unblocked?: number;
    complete?: number;
    suspended?: number;
  };
}

export interface BoardLaneDefinition {
  id: BoardLaneId;
  title: string;
  accentClass: string;
  description: string;
}

export interface BoardLane {
  id: BoardLaneId;
  title: string;
  accentClass: string;
  description: string;
  tasks: BoardTask[];
}

export interface BoardTaskFilters {
  projectId: string;
  laneId: BoardFilterLaneId;
  query: string;
}

// How the tasks inside a single lane column are ordered. Each column carries
// its own sort key so the operator can, say, sort "In Progress" by recency
// while keeping "Ready" priority-first.
export type BoardSortKey = "priority" | "recent" | "oldest" | "title";

export interface BoardSortOption {
  value: BoardSortKey;
  label: string;
}

export const BOARD_SORT_OPTIONS: BoardSortOption[] = [
  { value: "priority", label: "Priority" },
  { value: "recent", label: "Recently updated" },
  { value: "oldest", label: "Oldest updated" },
  { value: "title", label: "Title A–Z" },
];

export const DEFAULT_BOARD_SORT: BoardSortKey = "priority";

export const BOARD_LANES: BoardLaneDefinition[] = [
  {
    id: "new",
    title: "New",
    accentClass: "border-sky-400/40 text-sky-300",
    description: "Fresh requests and planning work",
  },
  {
    id: "ready",
    title: "Ready",
    accentClass: "border-amber-300/40 text-amber-200",
    description: "Unblocked work waiting to start",
  },
  {
    id: "in_progress",
    title: "In Progress",
    accentClass: "border-violet-300/40 text-violet-200",
    description: "Active operator or agent work",
  },
  {
    id: "needs_attention",
    title: "Needs Attention",
    accentClass: "border-rose-300/40 text-rose-200",
    description: "Blocked, failed, or awaiting input",
  },
  {
    id: "complete",
    title: "Complete",
    accentClass: "border-emerald-300/40 text-emerald-200",
    description: "Finished work",
  },
  {
    id: "cancelled",
    title: "Cancelled",
    accentClass: "border-orange-400/40 text-orange-300",
    description: "Cancelled or rejected work",
  },
  {
    id: "archived",
    title: "Archived",
    accentClass: "border-slate-500/40 text-slate-400",
    description: "Archived and retired work",
  },
];

// Lanes hidden by default on the board; the operator can toggle them back on
// from the lane filter menu.
export const DEFAULT_HIDDEN_LANE_IDS: BoardLaneId[] = ["complete", "cancelled", "archived"];
export const DEFAULT_VISIBLE_LANE_IDS: BoardLaneId[] = BOARD_LANES
  .map((lane) => lane.id)
  .filter((id) => !DEFAULT_HIDDEN_LANE_IDS.includes(id));

const NEW_STATUSES = new Set(["idea", "planning"]);
const ACTIVE_STATUSES = new Set(["building", "in_progress", "review", "implementing", "researching", "scheduled", "dispatched", "ready_for_review"]);
const ATTENTION_STATUSES = new Set(["blocked", "suspended", "failed", "awaiting_approval", "rejected", "needs_input"]);
const COMPLETE_STATUSES = new Set(["done", "complete", "completed"]);
const CANCELLED_STATUSES = new Set(["cancelled", "canceled"]);
const ARCHIVED_STATUSES = new Set(["archived"]);

export function getBoardLaneId(task: Pick<BoardTask, "status" | "is_unblocked">): BoardLaneId {
  const status = normalizeStatus(task.status);

  if (COMPLETE_STATUSES.has(status)) return "complete";
  if (CANCELLED_STATUSES.has(status)) return "cancelled";
  if (ARCHIVED_STATUSES.has(status)) return "archived";
  if (ATTENTION_STATUSES.has(status)) return "needs_attention";
  if (ACTIVE_STATUSES.has(status)) return "in_progress";
  if (NEW_STATUSES.has(status)) return "new";
  if (task.is_unblocked === false) return "needs_attention";

  return "ready";
}

export function normalizeStatus(status?: string): string {
  return (status || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

export function groupBoardTasks(projects: BoardProject[]): Record<BoardLaneId, BoardLane> {
  const grouped = BOARD_LANES.reduce(
    (acc, lane) => {
      acc[lane.id] = { ...lane, tasks: [] };
      return acc;
    },
    {} as Record<BoardLaneId, BoardLane>,
  );

  for (const project of projects) {
    for (const task of project.tasks || []) {
      const laneId = getBoardLaneId(task);
      grouped[laneId].tasks.push({
        ...task,
        projectId: task.project_id || task.projectId || project.id,
        projectName: task.projectName || project.name,
        laneId,
      });
    }
  }

  for (const lane of Object.values(grouped)) {
    lane.tasks = sortBoardTasks(lane.tasks, DEFAULT_BOARD_SORT);
  }

  return grouped;
}

function boardTaskTitle(task: BoardTask): string {
  return (task.title || task.name || "").toLowerCase();
}

// Return a new array of `tasks` ordered by `sortKey`. Pure — never mutates the
// input, so it is safe to call inside a render/useMemo pass.
export function sortBoardTasks(tasks: BoardTask[], sortKey: BoardSortKey = DEFAULT_BOARD_SORT): BoardTask[] {
  const sorted = [...tasks];

  switch (sortKey) {
    case "recent":
      sorted.sort((a, b) => getTaskTime(b) - getTaskTime(a));
      break;
    case "oldest":
      sorted.sort((a, b) => getTaskTime(a) - getTaskTime(b));
      break;
    case "title":
      sorted.sort((a, b) => boardTaskTitle(a).localeCompare(boardTaskTitle(b)));
      break;
    case "priority":
    default:
      sorted.sort((a, b) => {
        const priorityA = Number(a.priority ?? 0);
        const priorityB = Number(b.priority ?? 0);
        if (priorityA !== priorityB) return priorityB - priorityA;
        return getTaskTime(b) - getTaskTime(a);
      });
      break;
  }

  return sorted;
}

export function filterBoardTasks(tasks: BoardTask[], filters: BoardTaskFilters): BoardTask[] {
  const terms = filters.query.trim().toLowerCase().split(/\s+/).filter(Boolean);

  return tasks.filter((task) => {
    if (filters.projectId !== "all" && task.projectId !== filters.projectId && task.project_id !== filters.projectId) {
      return false;
    }

    if (filters.laneId !== "all" && task.laneId !== filters.laneId) {
      return false;
    }

    if (terms.length === 0) return true;

    const haystack = [
      task.title,
      task.name,
      task.description,
      task.status,
      task.projectName,
      task.source,
    ].filter(Boolean).join(" ").toLowerCase();

    return terms.every((term) => haystack.includes(term));
  });
}

export function formatBoardTime(value?: string): string {
  if (!value) return "No timestamp";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Invalid timestamp";

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function getTaskTime(task: BoardTask): number {
  const value = task.updated_at || task.updatedAt || task.created_at || task.createdAt;
  if (!value) return 0;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
}

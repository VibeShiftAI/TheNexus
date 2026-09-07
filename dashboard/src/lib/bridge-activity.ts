import type { StreamEvent } from "@praxis/contract";
import type { ExecutorRun } from "@/components/bridge/dispatch-station";

export const CHANNELS = [
  {
    id: "memory",
    label: "Memory",
    color: "#2dd4bf",
    href: "/knowledge-ingestion",
    description: "Recorded MCP memory searches, reads, and observations.",
  },
  {
    id: "vault",
    label: "Vault writes",
    color: "#a78bfa",
    href: "/activity?channel=vault",
    description:
      "MCP write results and the latest modification of each authored vault document.",
  },
  {
    id: "dispatch",
    label: "Dispatched",
    color: "#38bdf8",
    href: "/ops",
    description:
      "Executor launches observed in the task stream and run registry.",
  },
  {
    id: "working",
    label: "Working",
    color: "#34d399",
    href: "/ops",
    description:
      "Executor progress, including loading, thinking, writing, and testing.",
  },
  {
    id: "qa",
    label: "QA review",
    color: "#fbbf24",
    href: "/ops",
    description:
      "Independent review runs. Open the task evidence for the actual QA verdict.",
  },
  {
    id: "completed",
    label: "Completed",
    color: "#a3e635",
    href: "/task-board",
    description:
      "Terminal task results. Completion is separate from verification evidence.",
  },
] as const;
export type ActivityChannel = (typeof CHANNELS)[number]["id"];
export interface ActivityItem {
  id: string;
  at: string;
  channel: ActivityChannel;
  title: string;
  detail: string;
  status: "active" | "success" | "failed" | "recorded";
  source: string;
  taskId?: string;
  href?: string;
  path?: string;
}
export interface KnowledgeSnapshot {
  at: string;
  sources: { memory: boolean; vault: boolean };
  calls: {
    id: number;
    at: string;
    caller: string;
    tool: string;
    success: boolean;
    latency_ms?: number | null;
  }[];
  files: { path: string; at: string; bytes: number }[];
}
export function taskActivityHref(id: string) {
  return `/task/${encodeURIComponent(id.startsWith("qa--") ? id.slice(4) : id)}${id.startsWith("qa--") ? "#qa-reviews" : ""}`;
}
export function activityFromStream(e: StreamEvent): ActivityItem | null {
  const taskId =
    "taskId" in e
      ? e.taskId
      : e.type === "executor.progress"
        ? e.progress.taskId
        : undefined;
  const qa = taskId?.startsWith("qa--");
  const common = {
    id: `stream:${e.eventId}`,
    at: e.at,
    source: e.type,
    taskId,
    href: taskId ? taskActivityHref(taskId) : undefined,
  };
  switch (e.type) {
    case "task.started":
      return {
        ...common,
        channel: qa ? "qa" : "dispatch",
        title: qa ? "Review dispatched" : "Executor dispatched",
        detail: e.executor,
        status: "active",
      };
    case "executor.progress":
      return {
        ...common,
        channel: qa ? "qa" : "working",
        title: `${e.progress.executor} · ${e.progress.phase}`,
        detail: e.progress.message ?? "Progress received from executor",
        status: "active",
      };
    case "task.completed":
      return {
        ...common,
        channel: qa ? "qa" : "completed",
        title: qa
          ? "Review finished — verdict in report"
          : e.result.outcome === "success"
            ? "Task completed"
            : "Task ended without success",
        detail: e.result.summary ?? "",
        status: qa
          ? "recorded"
          : e.result.outcome === "success"
            ? "success"
            : "failed",
      };
    case "task.failed":
      return {
        ...common,
        channel: qa ? "qa" : "completed",
        title: qa ? "Review run failed" : "Task failed",
        detail: e.error,
        status: "failed",
      };
    case "task.blocked":
      return {
        ...common,
        channel: qa ? "qa" : "working",
        title: "Task blocked",
        detail: e.reason,
        status: "failed",
      };
    default:
      return null;
  }
}
export interface ActivityChannelState {
  id: ActivityChannel;
  available: boolean;
  hot: boolean;
  active: number;
  recent: number;
  latest?: ActivityItem;
}
export function deriveBridgeActivity(input: {
  now: number;
  connected: boolean;
  events: StreamEvent[];
  runs: ExecutorRun[];
  runsAvailable: boolean;
  knowledge: KnowledgeSnapshot | null;
}) {
  const items = new Map<string, ActivityItem>();
  const latestTask = new Map<string, ActivityItem>();
  const add = (item: ActivityItem) => {
    if (Number.isFinite(Date.parse(item.at))) items.set(item.id, item);
  };
  for (const event of input.events) {
    const item = activityFromStream(event);
    if (!item) continue;
    add(item);
    if (
      item.taskId &&
      (!latestTask.has(item.taskId) ||
        Date.parse(item.at) > Date.parse(latestTask.get(item.taskId)!.at))
    )
      latestTask.set(item.taskId, item);
  }
  const active = new Map<string, ActivityItem>();
  for (const run of input.runs) {
    const last = latestTask.get(run.taskId);
    const ownerId = run.kind === "agent" ? undefined : run.taskId;
    const qa = run.kind === "qa" || run.taskId.startsWith("qa--");
    const item: ActivityItem = {
      id: `run:${run.taskId}:${run.startedAt}`,
      at: run.updatedAt,
      channel: qa ? "qa" : run.status === "active" ? "working" : "completed",
      title: run.title || run.taskId,
      detail: `${run.executor} · ${run.phase}${run.summary ? `\n${run.summary}` : ""}`,
      source: "Executor registry",
      status:
        run.status === "active"
          ? "active"
          : run.status === "failed"
            ? "failed"
            : qa
              ? "recorded"
              : "success",
      taskId: ownerId,
      href: ownerId ? taskActivityHref(ownerId) : "/ops",
    };
    if (!last || Date.parse(last.at) < Date.parse(run.updatedAt)) {
      add(item);
      latestTask.set(run.taskId, item);
    }
    if (
      !qa &&
      ![...items.values()].some(
        (e) => e.taskId === run.taskId && e.channel === "dispatch",
      )
    ) {
      add({
        ...item,
        id: `launch:${run.taskId}:${run.startedAt}`,
        at: run.startedAt,
        channel: "dispatch",
        title: `Dispatched · ${run.title || run.executor}`,
        detail: run.executor,
        status: "recorded",
      });
    }
  }
  for (const [id, item] of latestTask) {
    const age = input.now - Date.parse(item.at);
    if (
      item.status === "active" &&
      age >= 0 &&
      (item.source === "Executor registry"
        ? input.runsAvailable
        : age < 120000 && input.connected)
    )
      active.set(id, item);
  }
  const knowledge = input.knowledge;
  for (const call of knowledge?.calls ?? []) {
    add({
      id: `call:${call.id}`,
      at: call.at,
      channel: call.tool === "vault_write" ? "vault" : "memory",
      title: call.tool.replaceAll("_", " "),
      detail: `${call.caller} · ${call.success ? "completed" : "failed"}${call.latency_ms != null ? ` · ${call.latency_ms} ms` : ""}`,
      status: call.success ? "recorded" : "failed",
      source: "MCP call ledger",
      href: "/knowledge-ingestion",
    });
  }
  for (const file of knowledge?.files ?? []) {
    add({
      id: `file:${file.path}:${file.at}`,
      at: file.at,
      channel: "vault",
      title: file.path.split("/").pop()!,
      detail: file.path,
      path: file.path,
      status: "recorded",
      source: "Vault file modification · latest write per file",
      href: `/activity?document=${encodeURIComponent(file.path)}`,
    });
  }
  const sorted = [...items.values()]
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, 240);
  const knowledgeAge = knowledge
    ? input.now - Date.parse(knowledge.at)
    : Infinity;
  const knowledgeFresh = knowledgeAge >= 0 && knowledgeAge < 20000;
  const channels: ActivityChannelState[] = CHANNELS.map((c) => {
    const group = sorted.filter((e) => e.channel === c.id);
    const available =
      c.id === "memory" || c.id === "vault"
        ? Boolean(knowledgeFresh && knowledge?.sources[c.id])
        : input.connected || input.runsAvailable;
    const count = [...active.values()].filter((e) =>
      c.id === "qa"
        ? e.channel === "qa"
        : c.id === "working"
          ? e.channel !== "qa"
          : false,
    ).length;
    return {
      id: c.id,
      available,
      active: available ? count : 0,
      latest: group[0],
      recent: group.filter((e) => {
        const age = input.now - Date.parse(e.at);
        return age >= 0 && age < 300000;
      }).length,
      hot:
        available &&
        (count > 0 ||
          group.some((e) => {
            const age = input.now - Date.parse(e.at);
            return age >= 0 && age < 12000;
          })),
    };
  });
  return { items: sorted, channels };
}

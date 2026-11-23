/**
 * Ops graph: which runs hang off which provider node on the Ops graphic.
 *
 * Praxis admits concurrent runs by free memory, so one provider often holds
 * several runs at once. The graphic used to draw one node per provider wearing
 * one role; this module turns the live dispatch state into one child node per
 * run (task runs, QA review runs, agent runs) and per sitting council seat, so
 * the picture can say which executor and model is on which task.
 *
 * Pure functions, no React: the component only lays the result out.
 *
 * Rules:
 *   - Every run the inputs report becomes a node. Nothing here counts, caps,
 *     merges or drops runs.
 *   - A model is shown only when Praxis reported one. The provider's name is
 *     never turned into a model.
 */

import { activeModelName } from "@/lib/active-model";
import { slotTag, type CliLaneRun } from "@/lib/cli-lane";

export type OpsRunRole = "building" | "reviewing" | "council" | "agent";

/** Where the shown model came from, for the node's tooltip. */
export type OpsModelSource = "served" | "requested" | "reported";

export interface OpsRunNode {
  /** Stable within one provider: the run's task id, or the seat's name. */
  key: string;
  role: OpsRunRole;
  title: string;
  taskId: string | null;
  /** `S<number>` when the run carries a slot; null renders nothing. */
  slot: string | null;
  /** Display name of the model, or null when none was reported ("unknown"). */
  model: string | null;
  modelSource: OpsModelSource | null;
  /** The requested model when it differs from the served one shown. */
  requestedModel: string | null;
  /** Requested effort / thinking level, when Praxis recorded one. */
  effort: string | null;
  phase: string | null;
  /** ms since the run started; null when no start time was reported. */
  elapsedMs: number | null;
}

/** The word shown where the model would be when Praxis reported none. */
export const UNKNOWN_MODEL = "unknown";

export const ROLE_LABEL: Record<OpsRunRole, string> = {
  building: "building",
  reviewing: "reviewing",
  council: "council",
  agent: "agent",
};

/** A run's role from its registry kind. A `qa--` id is a review whatever the kind says. */
export function runRole(kind: string | undefined, taskId: string | undefined): OpsRunRole {
  if (kind === "qa" || taskId?.startsWith("qa--")) return "reviewing";
  if (kind === "agent") return "agent";
  return "building";
}

export interface ModelFields {
  model?: string | null;
  requestedModel?: string | null;
  requestedEffort?: string | null;
  servedModel?: string | null;
}

/**
 * The model to show for a run: the served one when the executor reported it,
 * else the requested one, else the legacy `model` field. Null when none of
 * them names a model.
 */
export function resolveRunModel(run: ModelFields): Pick<OpsRunNode, "model" | "modelSource" | "requestedModel" | "effort"> {
  const served = activeModelName(run.servedModel ?? undefined) ?? null;
  const requested = activeModelName(run.requestedModel ?? undefined) ?? null;
  const reported = activeModelName(run.model ?? undefined) ?? null;
  const effort = run.requestedEffort?.trim() || null;
  if (served) return { model: served, modelSource: "served", requestedModel: requested && requested !== served ? requested : null, effort };
  if (requested) return { model: requested, modelSource: "requested", requestedModel: null, effort };
  if (reported) return { model: reported, modelSource: "reported", requestedModel: null, effort };
  return { model: null, modelSource: null, requestedModel: null, effort };
}

/** One sentence on where the shown model came from. */
export function modelProvenance(node: Pick<OpsRunNode, "model" | "modelSource" | "requestedModel" | "effort">): string {
  if (!node.model) return "Model unknown: Praxis reported none for this run";
  const effort = node.effort ? `, effort ${node.effort}` : "";
  if (node.modelSource === "served") {
    return node.requestedModel
      ? `Model ${node.model}, reported by the executor (requested ${node.requestedModel}${effort})`
      : `Model ${node.model}, reported by the executor${effort}`;
  }
  if (node.modelSource === "requested") return `Model ${node.model}, as requested at dispatch${effort}`;
  return `Model ${node.model}, as reported by Praxis${effort}`;
}

/** A stream-only active item: a run the registry has not listed yet. */
export interface StreamRunLike {
  taskId?: string;
  executor?: string;
  title?: string;
  phase?: string;
  channel?: string;
  model?: string;
}

/** A council voice sitting on a provider. */
export interface SeatLike {
  name: string;
  model?: string;
  status: string;
}

export interface ProviderRunsInput {
  /** Registry runs this provider holds (the dispatch-state lane). */
  laneRuns: readonly CliLaneRun[];
  /** Active stream items for this provider; used for runs the registry lacks. */
  streamRuns: readonly StreamRunLike[];
  /** Council voices on this provider while a council sits. */
  seats: readonly SeatLike[];
  council: { topic?: string | null; createdAt?: number | null } | null;
  now: number;
}

function startOf(run: CliLaneRun): number {
  const at = run.startedAt ? Date.parse(run.startedAt) : NaN;
  return Number.isFinite(at) ? at : Number.POSITIVE_INFINITY;
}

/**
 * Every live run on one provider, oldest first, then its sitting council
 * seats. The registry is the authority; a stream item only adds a run the
 * registry does not list yet (a dispatch whose frame beat the registry write).
 */
export function deriveProviderRuns(input: ProviderRunsInput): OpsRunNode[] {
  const nodes: OpsRunNode[] = [];
  const seen = new Set<string>();

  for (const run of [...input.laneRuns].sort((a, b) => startOf(a) - startOf(b))) {
    if (seen.has(run.taskId)) continue;
    seen.add(run.taskId);
    const stream = input.streamRuns.find((s) => s.taskId === run.taskId);
    nodes.push({
      key: run.taskId,
      role: runRole(run.kind, run.taskId),
      title: run.title || run.taskId,
      taskId: run.taskId,
      slot: slotTag(run.slotNumber),
      ...resolveRunModel({ ...run, model: run.model ?? stream?.model }),
      phase: stream?.phase ?? run.phase ?? null,
      elapsedMs: run.runningMs,
    });
  }

  input.streamRuns.forEach((item, index) => {
    const key = item.taskId ?? `stream:${index}`;
    if (seen.has(key)) return;
    seen.add(key);
    nodes.push({
      key,
      role: runRole(item.channel === "qa" ? "qa" : undefined, item.taskId),
      title: item.title || item.taskId || "Dispatched work",
      taskId: item.taskId ?? null,
      slot: null,
      ...resolveRunModel({ model: item.model }),
      phase: item.phase ?? null,
      // The stream names no start time, and the last-frame time is not one.
      elapsedMs: null,
    });
  });

  const created = input.council?.createdAt;
  for (const seat of input.seats) {
    if (seat.status !== "running") continue;
    const name = activeModelName(seat.model) ?? null;
    nodes.push({
      key: `seat:${seat.name}`,
      role: "council",
      title: input.council?.topic?.trim() || "Council session",
      taskId: null,
      slot: null,
      model: name,
      modelSource: name ? "reported" : null,
      requestedModel: null,
      effort: null,
      phase: "deliberating",
      elapsedMs: typeof created === "number" && Number.isFinite(created) ? Math.max(0, input.now - created) : null,
    });
  }

  return nodes;
}

/** "3 running", "2 running · 1 reviewing", ... : the provider's one-line tally. */
export function providerTally(nodes: readonly OpsRunNode[]): string {
  const count = (role: OpsRunRole) => nodes.filter((n) => n.role === role).length;
  const parts = [
    [count("building"), "building"],
    [count("reviewing"), "reviewing"],
    [count("agent"), "agent"],
    [count("council"), "council"],
  ] as const;
  return parts.filter(([n]) => n > 0).map(([n, word]) => `${n} ${word}`).join(" · ");
}

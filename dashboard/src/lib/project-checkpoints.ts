/**
 * Checkpoint read models for the project screen (docs/project-checkpoints.md).
 * The rules live in @praxis/contract so Praxis, TheNexus and the dashboard
 * agree on which checkpoint is current; this file only shapes them for UI.
 */
import {
  activeCheckpoints,
  checkpointProgress,
  checkpointRequiredNeeds,
  knowledgeSatisfied,
  describeCheckpointSequence,
  type Checkpoint,
  type CheckpointAssessment,
  type CheckpointPlan,
  type CheckpointProgress,
} from "@praxis/contract";
import type { Project, ProjectNeed } from "./nexus/projects";
import { endpointReadiness } from "./project-endpoint";

export type CheckpointPhase = "none" | "current" | "complete";

export interface CheckpointView {
  phase: CheckpointPhase;
  plan: CheckpointPlan | null;
  progress: CheckpointProgress | null;
  /** Non-archived checkpoints in sequence order. */
  active: Checkpoint[];
  current: Checkpoint | null;
  /** 1-based position of the current checkpoint in the active sequence (0 when none). */
  position: number;
  total: number;
  completed: Checkpoint[];
  upcoming: Checkpoint[];
  archived: Checkpoint[];
  /** Long-term goal verification, evaluated on its own criteria. */
  finalGoal: { achieved: boolean; assessed: boolean };
  summary: string;
}

export function checkpointView(project: Project): CheckpointView {
  const plan = project.checkpoints ?? null;
  const readiness = endpointReadiness(project);
  const finalGoal = {
    achieved: readiness.achieved,
    assessed: readiness.current,
  };
  if (!plan || activeCheckpoints(plan).length === 0) {
    return {
      phase: "none",
      plan,
      progress: null,
      active: [],
      current: null,
      position: 0,
      total: 0,
      completed: [],
      upcoming: [],
      archived: plan?.archived ?? [],
      finalGoal,
      summary: describeCheckpointSequence(plan),
    };
  }
  const progress = checkpointProgress(plan);
  const active = activeCheckpoints(plan);
  const current = progress.current;
  return {
    phase: current ? "current" : "complete",
    plan,
    progress,
    active,
    current,
    position: current ? active.findIndex((c) => c.id === current.id) + 1 : 0,
    total: progress.total,
    completed: progress.completed,
    upcoming: progress.upcoming,
    archived: plan.archived ?? [],
    finalGoal,
    summary: describeCheckpointSequence(plan),
  };
}

export type CheckpointVerdict = "waiting" | "recorded" | "verified";

/** What the evidence on a checkpoint says right now, in operator words. */
export function checkpointVerdict(checkpoint: Checkpoint): {
  verdict: CheckpointVerdict;
  label: string;
  detail: string;
} {
  if (checkpoint.status === "completed" && checkpoint.completion) {
    return {
      verdict: "verified",
      label: `Verified ${new Date(checkpoint.completion.at).toLocaleString()}`,
      detail: checkpoint.completion.source
        ? `Recorded by ${checkpoint.completion.source} against this definition.`
        : "Recorded against this definition.",
    };
  }
  const assessment = checkpoint.assessment;
  if (!assessment) {
    return {
      verdict: "waiting",
      label: "Waiting for evidence",
      detail: "Praxis has not evaluated this definition yet.",
    };
  }
  const enabled = (checkpoint.criteria ?? []).filter((c) => c.enabled !== false);
  const failing = enabled.filter((c) => {
    const result = assessment.results.find((r) => r.id === c.id);
    return !result || result.status !== "pass";
  });
  const parts: string[] = [];
  if (!enabled.length) parts.push("no enabled criteria");
  if (failing.length) parts.push(`${failing.length} of ${enabled.length} criteria not passing`);
  if (assessment.knowledge.unresolved > 0)
    parts.push(`${assessment.knowledge.unresolved} required knowledge unresolved`);
  return {
    verdict: "recorded",
    label: "Evidence recorded, not verified",
    detail: `Evaluated ${new Date(assessment.evaluated_at).toLocaleString()}${parts.length ? `: ${parts.join(", ")}` : ""}.`,
  };
}

/** Criterion results from the completion evidence (verified) or the latest pending evaluation. */
export function checkpointResults(
  checkpoint: Checkpoint,
): Map<string, CheckpointAssessment["results"][number]> {
  const assessment = checkpoint.completion?.assessment ?? checkpoint.assessment ?? null;
  return new Map((assessment?.results ?? []).map((result) => [result.id, result]));
}

/** Blocking knowledge this checkpoint requires, with its current satisfaction. */
export function checkpointNeeds(
  checkpoint: Checkpoint,
  project: Project,
): Array<{ need: ProjectNeed; satisfied: boolean }> {
  return checkpointRequiredNeeds(checkpoint, project.needs ?? []).map((need) => ({
    need,
    satisfied: knowledgeSatisfied(need, project.end_state_updated_at),
  }));
}

import { checkpointProgress, projectWideRequiredNeeds } from "@praxis/contract";
import type { Project, ProjectNeed } from "./nexus/projects";
import type { ProjectNeedPatch } from "./nexus/project-needs";

/** Matches the runtime's evidence and endpoint revision requirements. */
export function knowledgeSatisfied(
  need: ProjectNeed,
  revision?: string | null,
): boolean {
  const knowledge = need.knowledge;
  return Boolean(
    knowledge &&
      need.status === "met" &&
      knowledge.research_status !== "stale" &&
      knowledge.verified_at &&
      Number.isFinite(Date.parse(knowledge.verified_at)) &&
      knowledge.answer?.trim() &&
      knowledge.evidence.some((e) => e.ref.trim()) &&
      (!revision ||
        !knowledge.endpoint_revision ||
        knowledge.endpoint_revision === revision),
  );
}

export function endpointReadiness(project: Project) {
  const criteria = (project.end_state_criteria ?? []).filter(
    (c) => c.enabled !== false,
  );
  const assessment = project.end_state_assessment;
  const current =
    !!assessment &&
    (assessment.endpoint_revision ?? null) ===
      (project.end_state_updated_at ?? null);
  const results = new Map(
    current ? assessment.results.map((result) => [result.id, result]) : [],
  );
  const progress = checkpointProgress(project.checkpoints);
  const required = projectWideRequiredNeeds(project.checkpoints, project.needs ?? []);
  const unresolved = required.filter(
    (n) => !knowledgeSatisfied(n, project.end_state_updated_at),
  ).length;
  const achieved =
    (!progress.total || progress.sequenceComplete) &&
    current &&
    criteria.length > 0 &&
    criteria.every((c) => results.get(c.id)?.status === "pass") &&
    unresolved === 0 &&
    assessment.knowledge.unresolved === 0 &&
    assessment.achieved !== false;
  return {
    criteria,
    results,
    current,
    achieved,
    required: required.length,
    unresolved,
  };
}

export function canSatisfyNeed(need: ProjectNeed): boolean {
  return (
    !need.knowledge ||
    Boolean(
      need.knowledge.question.trim() &&
        need.knowledge.satisfaction_test.trim() &&
        need.knowledge.answer?.trim() &&
        need.knowledge.evidence.some((e) => e.ref.trim()),
    )
  );
}

/** Only send changed fields so unrelated researcher updates survive a form save. */
export function needPatch(
  before: ProjectNeed,
  after: ProjectNeed,
): ProjectNeedPatch {
  const patch: Record<string, unknown> = {};
  for (const key of ["kind", "description", "notes", "status"] as const) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key]))
      patch[key] = after[key];
  }
  if (after.knowledge) {
    const knowledge: Record<string, unknown> = {};
    for (const key of Object.keys(
      after.knowledge,
    ) as (keyof typeof after.knowledge)[]) {
      if (
        JSON.stringify(before.knowledge?.[key]) !==
        JSON.stringify(after.knowledge[key])
      )
        knowledge[key] = after.knowledge[key];
    }
    if (Object.keys(knowledge).length) patch.knowledge = knowledge;
  }
  return patch as ProjectNeedPatch;
}

export function proposalAcceptance(project: Project) {
  if (!project.endpoint?.proposed_next?.trim())
    throw new Error("No proposed endpoint to accept.");
  return {
    end_state: project.endpoint.proposed_next.trim(),
    endpoint: { ...project.endpoint, proposed_next: "" },
    expected_updated_at: project.updated_at,
    end_state_source: "operator",
    end_state_reason: "Explicitly accepted proposed next endpoint",
  };
}

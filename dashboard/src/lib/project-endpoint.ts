import { checkpointProgress, projectWideRequiredNeeds, type KnowledgeApplication } from "@praxis/contract";
import type { Project, ProjectNeed } from "./nexus/projects";
import { internalHref } from "./task-links";
import type { ProjectNeedPatch } from "./nexus/project-needs";
import type { Task } from "./nexus/tasks";

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
      ((knowledge.revision ?? 0) === 0 || knowledge.verification?.revision === knowledge.revision) &&
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
    for (const key of ["question", "purpose", "group", "resolution", "deferred_until", "deferred_reason", "superseded_by", "tags", "satisfaction_test", "criterion_ids", "task_ids", "blocking", "research_status", "answer", "evidence"] as const) {
      if (
        JSON.stringify(before.knowledge?.[key]) !==
        JSON.stringify(after.knowledge[key])
      )
        knowledge[key] = after.knowledge[key];
    }
    if (Object.keys(knowledge).length) patch.knowledge = knowledge;
  }
  if (Object.keys(patch).length && before.knowledge) patch.expected_knowledge_revision = before.knowledge.revision ?? 0;
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


export function knowledgeApplications(need: ProjectNeed): KnowledgeApplication[] {
  const k = need.knowledge;
  return k?.applications?.length ? k.applications : k?.application ? [k.application] : [];
}

export function hasAppliedKnowledge(need: ProjectNeed): boolean {
  return knowledgeApplications(need).some(a => ["applied", "validated", "successful"].includes(a.status));
}

/** Task creation can link a need from the task side without backfilling task_ids. */
export function knowledgeTaskIds(need: ProjectNeed, tasks: Task[] = []): string[] {
  const k = need.knowledge;
  if (!k) return [];
  const explicit = new Set(k.task_ids);
  const retired = new Set(knowledgeApplications(need)
    .filter(a => (a.answer_revision ?? 0) < (k.revision ?? 0) && ["applied", "validated", "successful"].includes(a.status))
    .flatMap(a => a.task_id ? [a.task_id] : []));
  // Routing preserves old task metadata. The replacement's revision provenance
  // identifies those historical links, including tasks with no application receipt.
  for (const task of tasks.filter(t => explicit.has(t.id))) {
    const changes = task.metadata?.knowledge_changes;
    if (!Array.isArray(changes)) continue;
    for (const change of changes) if (change?.need_id === need.id && typeof change.revision === "number" && change.revision <= (k.revision ?? 0) && Array.isArray(change.previous_task_ids)) {
      for (const id of change.previous_task_ids) if (typeof id === "string") retired.add(id);
    }
  }
  const reverse = tasks.filter(task => {
    if (retired.has(task.id)) return false;
    const ids = task.metadata?.knowledge_need_ids;
    const requirements = task.metadata?.knowledge_context?.requirements;
    return (Array.isArray(ids) && ids.includes(need.id)) || (Array.isArray(requirements) && requirements.some(r => r?.need_id === need.id));
  }).map(t => t.id);
  return [...new Set([...explicit, ...reverse])];
}

export function appliedKnowledgeChanged(before: ProjectNeed, after: ProjectNeed): boolean {
  return hasAppliedKnowledge(before) && ["question", "answer", "satisfaction_test", "evidence", "criterion_ids"].some(key =>
    JSON.stringify(before.knowledge?.[key as keyof NonNullable<ProjectNeed["knowledge"]>]) !== JSON.stringify(after.knowledge?.[key as keyof NonNullable<ProjectNeed["knowledge"]>])
  );
}

export function knowledgeLifecycle(need: ProjectNeed, now = Date.now(), tasks: Task[] = []) {
  const k = need.knowledge;
  const deferred = Boolean(k?.deferred_reason?.trim() || (k?.deferred_until && Date.parse(k.deferred_until) > now));
  const active = need.status !== "dropped" && !deferred && !k?.superseded_by?.length;
  const verified = knowledgeSatisfied(need);
  const verificationProblems: string[] = [];
  if (!k?.question.trim()) verificationProblems.push("Clarify the question.");
  if (!k?.satisfaction_test.trim()) verificationProblems.push("Define what evidence is enough.");
  if (!k?.answer?.trim()) verificationProblems.push("Record an answer before verification.");
  if (!k?.evidence.some(e => e.ref.trim())) verificationProblems.push("Add an evidence reference before verification.");
  if (!active) verificationProblems.push(deferred ? "This question is deferred." : "Reopen this question before verification.");
  const latestApplications = new Map<string, KnowledgeApplication>();
  for (const application of knowledgeApplications(need)) if ((application.answer_revision ?? 0) === (k?.revision ?? 0) && application.task_id) latestApplications.set(application.task_id, application);
  const currentApplications = [...latestApplications.values()].filter(a => ["applied", "validated", "successful", "not_relevant"].includes(a.status));
  const applicationTaskIds = [...new Set([...knowledgeTaskIds(need, tasks), ...latestApplications.keys()])];
  const remainingTaskIds = applicationTaskIds.filter(id => !currentApplications.some(a => a.task_id === id));
  const applicationComplete = applicationTaskIds.length > 0 && !remainingTaskIds.length;
  const complete = k ? verified && applicationComplete : need.status === "met";
  const actionRequired = active && !complete;
  const applied = verified && applicationComplete && currentApplications.some(a => a.status !== "not_relevant");
  const canApply = verified && k?.verification?.revision === (k?.revision ?? 0);
  const needsVerification = !verified || (actionRequired && !canApply);
  const awaitingApplication = actionRequired && canApply;
  const primaryAction = !k || !k.purpose || !k.resolution ? "Clarify question" : k.answer?.trim() ? "Review answer" : k.evidence.length ? "Review evidence" : ["human", "decision", "acceptance"].includes(k.resolution.method) ? "Record answer" : k.resolution.method === "experiment" ? "Record findings" : "Resolve question";
  return { active, deferred, verified, canApply, needsVerification, complete, actionRequired, applied, applicationComplete, remainingTaskIds, answered: !!k?.answer?.trim(), needsAnswer: actionRequired && need.kind === "information" && !k?.answer?.trim(), evidenceToReview: actionRequired && needsVerification && !!k?.evidence.length, needsReview: actionRequired && (k?.research_status === "stale" || (verified && !canApply)), awaitingApplication, verificationProblems, primaryAction };
}

export function knowledgePriority(need: ProjectNeed, project: Project, tasks: Task[]) {
  const current = checkpointProgress(project.checkpoints).current;
  const k = need.knowledge;
  if (k?.blocking && current && (current.need_ids.includes(need.id) || current.criteria.some(c => k.criterion_ids.includes(c.id)))) return { rank: 0, label: "Current checkpoint blocker" };
  if (k?.blocking) return { rank: 1, label: "Blocking work" };
  if (knowledgeTaskIds(need, tasks).some(id => tasks.some(t => t.id === id && !["completed", "cancelled", "archived"].includes(t.status)))) return { rank: 2, label: "Linked to unfinished work" };
  return { rank: 3, label: "Open question" };
}

export function prioritizeKnowledgeNeeds(needs: ProjectNeed[], project: Project, tasks: Task[]): ProjectNeed[] {
  return [...needs].sort((a, b) => knowledgePriority(a, project, tasks).rank - knowledgePriority(b, project, tasks).rank || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
}

export function verificationPatch(need: ProjectNeed, rationale: string, evidenceRefs: string[]): ProjectNeedPatch {
  const problems = knowledgeLifecycle(need).verificationProblems;
  if (problems.length) throw new Error(problems.join(" "));
  if (!rationale.trim()) throw new Error("Explain the verification rationale.");
  if (!evidenceRefs.length) throw new Error("Select the evidence that supports this answer.");
  if (evidenceRefs.some(ref => !need.knowledge!.evidence.some(e => e.ref === ref))) throw new Error("Select evidence from the current answer.");
  return { status: "met", expected_knowledge_revision: need.knowledge!.revision ?? 0, knowledge: { verification: { rationale: rationale.trim(), evidence_refs: [...new Set(evidenceRefs)] } } };
}

export function applicationPatch(need: ProjectNeed, application: KnowledgeApplication): ProjectNeedPatch {
  if (!application.id || !application.task_id?.trim() || !application.notes?.trim()) throw new Error("Choose a task and provide an explanation.");
  const revision = need.knowledge?.revision ?? 0;
  if (["applied", "validated", "successful"].includes(application.status)) {
    if (!knowledgeSatisfied(need) || need.knowledge?.verification?.revision !== revision) throw new Error("This answer must be verified at its current revision before application.");
    if (!application.evidence_ref?.trim()) throw new Error("An evidence reference is required for application.");
  }
  return { expected_knowledge_revision: revision, record_application: { ...application, answer_revision: revision } };
}

/** Links only known viewer routes. Other references remain readable and copyable. */
export function evidenceLink(value: string): { href: string; label?: string } | null {
  const ref = value.trim();
  if (/^\/api\/documents\/[a-zA-Z0-9_-]+\/raw\?revision=[a-zA-Z0-9_-]+$/.test(ref)) return { href: ref };
  const internal = internalHref(ref);
  if (internal) return { href: internal };
  if (/^https?:\/\//i.test(ref)) {
    try { const url = new URL(ref); if (!url.username && !url.password) return { href: url.href }; } catch { /* plain text */ }
    return null;
  }
  const task = /^(?:nexus:)?task:([a-zA-Z0-9_-]+)$/.exec(ref);
  if (task) return { href: `/task/${encodeURIComponent(task[1])}` };
  const document = /^(?:nexus:)?document:([a-zA-Z0-9_-]+)$/.exec(ref);
  if (document) return { href: `/documents/${encodeURIComponent(document[1])}` };
  const hitl = /^(?:praxis:)?hitl:([a-zA-Z0-9_-]+)$/.exec(ref);
  if (hitl) return { href: `/inbox#${encodeURIComponent(hitl[1])}` };
  if (/^praxis:(?:feedback:(?:query|inbound):|mail:|email:)/.test(ref)) return { href: "/mail", label: "Open mailbox" };
  const vault = ref.replace(/^(?:vault:|\/Volumes\/Projects\/shared-mind\/)/, "");
  if (vault !== ref && /^(?:memories|skills|projects|incidents|workflows|_journal)\/.+\.md$/.test(vault) && !vault.split("/").some(part => part === "..") && !vault.includes("\\")) return { href: `/activity?document=${encodeURIComponent(vault)}` };
  return null;
}

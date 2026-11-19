/**
 * Intake as a project's first checkpoint, for the project page.
 *
 * Praxis owns the checkpoint, its standard stages and each stage's status: it
 * reads them from the project's saved intake (Praxis
 * src/orchestrator/intake-stages.ts) and serves the reading at
 * GET /api/projects/:id/intake-checkpoint. This file only fetches that reading
 * through the Nexus server (dashboard /api/praxis/* to :4000 to Praxis :54322).
 * It holds no stage names and no status rules of its own, so the page cannot
 * disagree with the board tool or the status report.
 */
"use client";

import { useEffect, useState } from "react";

export interface IntakeStageReading {
    id: string;
    name: string;
    status: string;
    detail?: string;
}

export interface IntakeCheckpointReading {
    id: string;
    title: string;
    goal: string;
    status: "current" | "complete";
    target?: string;
    stages: IntakeStageReading[];
    stages_settled: number;
}

/**
 * none: the project never came through intake, nothing is shown and nothing is fetched.
 * unavailable: Praxis did not answer, so the page says so and shows no stages.
 */
export type IntakeCheckpointState =
    | { state: "none" }
    | { state: "loading" }
    | { state: "unavailable"; reason: string }
    | { state: "ready"; checkpoint: IntakeCheckpointReading };

export async function fetchIntakeCheckpoint(projectId: string): Promise<IntakeCheckpointReading | null> {
    const res = await fetch(`/api/praxis/projects/${encodeURIComponent(projectId)}/intake-checkpoint`, { cache: "no-store" });
    if (!res.ok) throw new Error(`Praxis answered ${res.status}`);
    const body = await res.json() as { intake_checkpoint?: IntakeCheckpointReading | null };
    const checkpoint = body?.intake_checkpoint;
    if (!checkpoint) return null;
    if (!Array.isArray(checkpoint.stages) || (checkpoint.status !== "current" && checkpoint.status !== "complete")) {
        throw new Error("Praxis returned an intake reading this page cannot show");
    }
    return checkpoint;
}

/**
 * The Intake reading of one project. Only a project that carries an intake
 * record asks Praxis; it asks again whenever the project row changes.
 */
export function useIntakeCheckpoint(project: { id: string; updated_at?: string | null; intake?: { state?: string | null } | null }): IntakeCheckpointState {
    const hasIntake = Boolean(project.intake?.state);
    const key = hasIntake ? `${project.id}|${project.updated_at ?? ""}` : "";
    const [result, setResult] = useState<{ key: string; value: IntakeCheckpointState } | null>(null);
    useEffect(() => {
        if (!key) return;
        let live = true;
        fetchIntakeCheckpoint(project.id).then(
            (checkpoint) => { if (live) setResult({ key, value: checkpoint ? { state: "ready", checkpoint } : { state: "none" } }); },
            (error) => { if (live) setResult({ key, value: { state: "unavailable", reason: error instanceof Error ? error.message : "Praxis did not answer" } }); },
        );
        return () => { live = false; };
    }, [key, project.id]);
    if (!key) return { state: "none" };
    return result?.key === key ? result.value : { state: "loading" };
}

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

import { useEffect, useRef, useState } from "react";
import { useLiveBoardState } from "@/components/live-board-state";

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
 * record asks Praxis.
 *
 * Intake advances on things the project row does not record: a task of the
 * project changing status moves a stage and leaves the project's updated_at
 * alone. So the reading is asked for again whenever the page hands in a
 * refreshed project record (a new object, whatever its timestamp says) and
 * whenever the live board is invalidated. Requests are numbered: only the
 * answer to the latest one is shown, so a slow earlier answer cannot replace a
 * newer reading. While a newer reading of the same project is on its way the
 * last one stays on screen.
 */
export function useIntakeCheckpoint(project: { id: string; intake?: { state?: string | null } | null }): IntakeCheckpointState {
    const projectId = project.intake?.state ? project.id : "";
    const boardRevision = useLiveBoardState().revisions.board;
    const [result, setResult] = useState<{ projectId: string; value: IntakeCheckpointState } | null>(null);
    const latest = useRef(0);
    useEffect(() => {
        if (!projectId) return;
        const request = ++latest.current;
        const show = (value: IntakeCheckpointState) => {
            if (latest.current === request) setResult({ projectId, value });
        };
        fetchIntakeCheckpoint(projectId).then(
            (checkpoint) => show(checkpoint ? { state: "ready", checkpoint } : { state: "none" }),
            (error) => show({ state: "unavailable", reason: error instanceof Error ? error.message : "Praxis did not answer" }),
        );
        // Unmounting, or a newer request, retires this one.
        return () => { if (latest.current === request) latest.current += 1; };
    }, [projectId, project, boardRevision]);
    if (!projectId) return { state: "none" };
    return result?.projectId === projectId ? result.value : { state: "loading" };
}

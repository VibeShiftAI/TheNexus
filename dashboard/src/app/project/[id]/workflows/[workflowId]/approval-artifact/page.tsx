"use client"

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, FileText, Loader2 } from "lucide-react";
import { getProjectWorkflow, ProjectWorkflow, ProjectWorkflowApprovalPayload } from "@/lib/nexus";

function firstParam(value: string | string[] | undefined): string {
    return Array.isArray(value) ? value[0] : value || "";
}

function approvalTitle(approval: ProjectWorkflowApprovalPayload | null): string {
    const artifact = approval?.artifact;
    if (typeof artifact?.title === "string") return artifact.title;
    if (typeof artifact?.gate === "string") return artifact.gate;
    return approval?.gate ? `${approval.gate} approval` : "Approval artifact";
}

export default function ApprovalArtifactPage() {
    const params = useParams();
    const projectId = firstParam(params.id);
    const workflowId = firstParam(params.workflowId);
    const [workflow, setWorkflow] = useState<ProjectWorkflow | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        let cancelled = false;

        async function loadWorkflow() {
            setIsLoading(true);
            setError(null);
            try {
                const result = await getProjectWorkflow(projectId, workflowId);
                if (!cancelled) setWorkflow(result.workflow);
            } catch (err) {
                if (!cancelled) {
                    setError(err instanceof Error ? err.message : "Failed to load approval artifact");
                }
            } finally {
                if (!cancelled) setIsLoading(false);
            }
        }

        if (projectId && workflowId) {
            loadWorkflow();
        } else {
            setError("Missing project or workflow id");
            setIsLoading(false);
        }

        return () => {
            cancelled = true;
        };
    }, [projectId, workflowId]);

    const pendingApproval = workflow?.supervisor_details?.pending_approval as ProjectWorkflowApprovalPayload | null | undefined;
    const artifact = pendingApproval?.artifact || null;
    const artifactJson = useMemo(() => JSON.stringify(artifact || {}, null, 2), [artifact]);

    return (
        <main className="min-h-screen bg-slate-950 px-6 py-6 text-slate-100">
            <div className="mx-auto flex max-w-6xl flex-col gap-5">
                <div className="flex items-center justify-between gap-4">
                    <Link
                        href={`/project/${projectId}`}
                        className="inline-flex items-center gap-2 rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-300 transition-colors hover:border-slate-500 hover:text-white"
                    >
                        <ArrowLeft size={16} />
                        <span>Project</span>
                    </Link>
                    {pendingApproval?.gate && (
                        <span className="rounded-md border border-amber-400/30 bg-amber-500/10 px-3 py-1.5 text-xs font-semibold uppercase text-amber-300">
                            {pendingApproval.gate} approval
                        </span>
                    )}
                </div>

                <section className="border-b border-slate-800 pb-4">
                    <div className="flex items-start gap-3">
                        <FileText className="mt-1 text-cyan-300" size={24} />
                        <div className="min-w-0">
                            <h1 className="text-2xl font-semibold text-white">{approvalTitle(pendingApproval || null)}</h1>
                            {workflow?.name && (
                                <p className="mt-1 text-sm text-slate-400">{workflow.name}</p>
                            )}
                            {pendingApproval?.message && (
                                <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-300">{pendingApproval.message}</p>
                            )}
                        </div>
                    </div>
                </section>

                {isLoading && (
                    <div className="flex items-center gap-2 text-sm text-slate-400">
                        <Loader2 size={16} className="animate-spin" />
                        <span>Loading artifact</span>
                    </div>
                )}

                {error && (
                    <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300">
                        {error}
                    </div>
                )}

                {!isLoading && !error && !artifact && (
                    <div className="rounded-lg border border-slate-800 bg-slate-900/70 p-4 text-sm text-slate-300">
                        This workflow is not currently waiting on an approval artifact.
                    </div>
                )}

                {artifact && (
                    <pre className="overflow-auto rounded-lg border border-slate-800 bg-slate-900 p-5 text-sm leading-6 text-slate-100 shadow-2xl">
                        {artifactJson}
                    </pre>
                )}
            </div>
        </main>
    );
}

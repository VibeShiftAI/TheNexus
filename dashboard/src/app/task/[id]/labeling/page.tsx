"use client";

/**
 * /task/<id>/labeling: the guided blind-labelling workbench for a task that
 * carries the Groundrules gold-set packet. The task page's entry card links
 * here; the workbench itself decides what the API allows to be shown.
 */
import { use } from "react";
import Link from "next/link";
import { LabelingWorkbench } from "@/components/groundrules-labeling/workbench";

export default function TaskLabelingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: taskId } = use(params);
  return (
    <main className="min-h-screen bg-slate-950 text-slate-200 selection:bg-cyan-500/30">
      <header className="sticky top-0 z-50 border-b border-slate-800 bg-slate-950/90 backdrop-blur-md">
        <div className="mx-auto flex min-h-14 max-w-6xl items-center justify-between gap-3 px-4 py-2 sm:px-6">
          <Link href="/task-board" className="flex items-center gap-2 text-sm text-slate-400 transition-colors hover:text-white">
            <span className="h-2 w-2 rounded-full bg-cyan-500" />
            <span className="text-base font-bold text-white">THE <span className="text-cyan-400">NEXUS</span></span>
          </Link>
          <span className="text-xs text-slate-500">Groundrules gold set · blind labeling</span>
        </div>
      </header>
      <LabelingWorkbench taskId={taskId} />
    </main>
  );
}

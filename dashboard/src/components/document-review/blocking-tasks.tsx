import Link from "next/link";
import { CirclePause } from "lucide-react";
import type { DocumentBlockingTask } from "@/lib/document-review";

export function BlockingTasks({ tasks = [] }: { tasks?: DocumentBlockingTask[] }) {
    if (!tasks.length) return null;
    return (
        <div className="mt-2 text-xs" data-blocking-tasks="">
            <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 font-medium text-amber-200">
                <CirclePause size={12} aria-hidden="true" /> Blocking {tasks.length} {tasks.length === 1 ? "task" : "tasks"}
            </span>
            <ul className="mt-1 space-y-0.5">
                {tasks.map(task => (
                    <li key={task.id}>
                        <Link href={`/task/${encodeURIComponent(task.id)}`} className="break-words text-amber-200/90 hover:underline">{task.title}</Link>
                    </li>
                ))}
            </ul>
        </div>
    );
}

'use client';

interface WorkflowDebuggerProps {
    runId: string;
    projectId?: string;
    onRewind?: (checkpointId: string) => Promise<void>;
    onClose?: () => void;
}

export function WorkflowDebugger({ onClose }: WorkflowDebuggerProps) {
    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
            <div className="rounded-lg border border-slate-700 bg-slate-900 p-6 text-slate-200">
                <p className="mb-4 text-sm">This debugger has been retired.</p>
                {onClose && (
                    <button
                        onClick={onClose}
                        className="rounded bg-slate-700 px-3 py-1.5 text-sm hover:bg-slate-600"
                    >
                        Close
                    </button>
                )}
            </div>
        </div>
    );
}

export default WorkflowDebugger;

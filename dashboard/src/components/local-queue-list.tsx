"use client"

import { useEffect, useState } from "react";
import { getLocalLlmQueue, type LocalLlmJob } from "@/lib/nexus";
import { ListRestart, ChevronDown, ChevronUp, AlertCircle, CheckCircle } from "lucide-react";

export function LocalQueueList() {
  const [jobs, setJobs] = useState<LocalLlmJob[]>([]);
  const [expandedJobId, setExpandedJobId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;

    const fetchQueue = async () => {
      try {
        const queueState = await getLocalLlmQueue();
        if (active) {
          setJobs(queueState?.jobs || []);
        }
      } catch (e) {
        console.error("Failed to fetch LLM queue:", e);
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    };

    fetchQueue();
    const interval = setInterval(fetchQueue, 5000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, []);

  const toggleExpand = (id: string) => {
    setExpandedJobId(prev => (prev === id ? null : id));
  };

  const getStatusStyle = (status: string) => {
    switch (status) {
      case "running":
        return "bg-amber-500/20 text-amber-300 border-amber-500/30";
      case "succeeded":
      case "completed":
        return "bg-emerald-500/20 text-emerald-300 border-emerald-500/30";
      case "failed":
        return "bg-red-500/20 text-red-300 border-red-500/30";
      default:
        return "bg-sky-500/20 text-sky-300 border-sky-500/30";
    }
  };

  const getJobPrompt = (job: LocalLlmJob): string => {
    if (typeof job.payload?.prompt === "string") return job.payload.prompt;
    if (typeof job.payload?.input === "string") return job.payload.input;
    return job.type || "Local LLM Job";
  };

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-lg">
      <div className="bg-slate-950/60 border-b border-slate-800 px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ListRestart size={16} className="text-sky-400" />
          <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">Local LLM Queue</span>
        </div>
        <span className="text-xs text-slate-500 font-medium">{jobs.length} jobs</span>
      </div>

      <div className="p-4 max-h-[300px] overflow-y-auto space-y-3">
        {loading ? (
          <div className="text-center text-xs text-slate-500 py-6">Loading queue...</div>
        ) : jobs.length === 0 ? (
          <div className="text-center text-xs text-slate-500 py-6">No jobs in local queue.</div>
        ) : (
          jobs.map((job) => {
            const isExpanded = expandedJobId === job.id;
            const statusStyle = getStatusStyle(job.status);
            const jobPrompt = getJobPrompt(job);
            const cleanPrompt = jobPrompt.replace(/\s+/g, " ");
            const displayPrompt = cleanPrompt.length > 30 ? `${cleanPrompt.slice(0, 30)}...` : cleanPrompt;

            const handleKeyDown = (e: React.KeyboardEvent) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                toggleExpand(job.id);
              }
            };

            return (
              <div 
                key={job.id}
                className="border border-slate-800 rounded-lg hover:border-slate-700/80 transition-all bg-slate-950/20"
              >
                {/* Interactive Header */}
                <div 
                  onClick={() => toggleExpand(job.id)}
                  onKeyDown={handleKeyDown}
                  role="button"
                  tabIndex={0}
                  aria-expanded={isExpanded}
                  className="p-3 flex items-center justify-between cursor-pointer focus:outline-none focus:ring-1 focus:ring-sky-500 rounded-t-lg"
                >
                  <div className="flex items-center gap-3">
                    <span className={`text-[10px] px-2 py-0.5 rounded-full border ${statusStyle} font-semibold uppercase`}>
                      {job.status}
                    </span>
                    <div className="text-left">
                      <h4 className="text-sm font-semibold text-slate-200 font-mono">
                        {displayPrompt}
                      </h4>
                      <span className="text-[10px] text-slate-500">Attempts: {job.attempts || 1} • Priority: {job.priority || 0}</span>
                    </div>
                  </div>
                  {isExpanded ? <ChevronUp size={16} className="text-slate-400" /> : <ChevronDown size={16} className="text-slate-400" />}
                </div>

                {/* Collapsible details (stops click propagation to parent wrapper) */}
                {isExpanded && (
                  <div 
                    onClick={(e) => e.stopPropagation()}
                    className="px-3 pb-3 pt-1 border-t border-slate-800/40 text-xs text-slate-400 space-y-2 bg-slate-950/40 rounded-b-lg text-left"
                  >
                    <div>
                      <span className="font-semibold text-slate-300">Prompt Context:</span>
                      <p className="mt-0.5 bg-slate-950 p-2 rounded border border-slate-800 font-mono text-[10px] whitespace-pre-wrap">{jobPrompt}</p>
                    </div>
                    {job.error && (
                      <div className="text-red-400">
                        <span className="font-semibold text-red-300 flex items-center gap-1">
                          <AlertCircle size={12} /> Error:
                        </span>
                        <p className="mt-0.5 bg-red-950/20 p-2 rounded border border-red-500/20 font-mono text-[10px]">{job.error}</p>
                      </div>
                    )}
                    {job.result && (
                      <div>
                        <span className="font-semibold text-emerald-300 flex items-center gap-1">
                          <CheckCircle size={12} /> Output:
                        </span>
                        <p tabIndex={0} aria-label="Job output logs" className="mt-0.5 bg-emerald-950/20 p-2 rounded border border-emerald-500/20 font-mono text-[10px] max-h-[120px] overflow-y-auto whitespace-pre-wrap">{job.result}</p>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

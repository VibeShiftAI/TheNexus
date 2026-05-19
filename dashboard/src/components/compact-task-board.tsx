"use client"

import { useEffect, useState } from "react";
import { getBoardState } from "@/lib/nexus";
import { groupBoardTasks, type BoardTask, type BoardLaneId } from "@/lib/task-board";
import { FolderGit2, ChevronDown, ChevronUp, Clock, AlertTriangle, Play, ExternalLink } from "lucide-react";

interface CompactTaskBoardProps {
  onSelectTask?: (taskId: string, projectId: string) => void;
}

type TabId = "active" | "next" | "attention";

export function CompactTaskBoard({ onSelectTask }: CompactTaskBoardProps) {
  const [projects, setProjects] = useState<any[]>([]);
  const [activeTab, setActiveTab] = useState<TabId>("active");
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchBoard = async (active: boolean) => {
    try {
      const boardState = await getBoardState();
      if (active) {
        setProjects(boardState || []);
      }
    } catch (e) {
      console.error("Failed to fetch board state:", e);
    } finally {
      if (active) {
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    let active = true;
    fetchBoard(active);
    const interval = setInterval(() => fetchBoard(active), 10000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, []);

  const grouped = groupBoardTasks(projects);

  const getTabTasks = (): BoardTask[] => {
    switch (activeTab) {
      case "active":
        return grouped.in_progress?.tasks || [];
      case "next":
        return [...(grouped.ready?.tasks || []), ...(grouped.new?.tasks || [])];
      case "attention":
        return grouped.needs_attention?.tasks || [];
      default:
        return [];
    }
  };

  const toggleExpand = (id: string) => {
    setExpandedTaskId(prev => (prev === id ? null : id));
  };

  const tabTasks = getTabTasks();

  const getTabBadgeColor = (tab: TabId) => {
    switch (tab) {
      case "active":
        return "bg-violet-500/20 text-violet-300 border-violet-500/30";
      case "next":
        return "bg-sky-500/20 text-sky-300 border-sky-500/30";
      case "attention":
        return "bg-rose-500/20 text-rose-300 border-rose-500/30";
    }
  };

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-lg flex flex-col h-full">
      {/* Header */}
      <div className="bg-slate-950/60 border-b border-slate-800 px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <FolderGit2 size={16} className="text-cyan-400" />
          <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">Task Board</span>
        </div>
        <span className="text-xs text-slate-500 font-medium">
          {tabTasks.length} tasks
        </span>
      </div>

      {/* Tab Buttons */}
      <div className="grid grid-cols-3 border-b border-slate-800 bg-slate-950/20 text-xs">
        {(["active", "next", "attention"] as TabId[]).map((tab) => {
          const isActive = activeTab === tab;
          const count = tab === "active" 
            ? (grouped.in_progress?.tasks?.length || 0)
            : tab === "next" 
              ? ((grouped.ready?.tasks?.length || 0) + (grouped.new?.tasks?.length || 0))
              : (grouped.needs_attention?.tasks?.length || 0);

          const label = tab === "active" ? "Active" : tab === "next" ? "Next Up" : "Attention";

          return (
            <button
              key={tab}
              onClick={() => {
                setActiveTab(tab);
                setExpandedTaskId(null);
              }}
              className={`py-2 px-3 border-b-2 font-medium transition-all flex items-center justify-center gap-1.5 ${
                isActive 
                  ? "border-cyan-500 text-white bg-slate-800/30" 
                  : "border-transparent text-slate-400 hover:text-slate-200 hover:bg-slate-800/10"
              }`}
            >
              <span>{label}</span>
              <span className={`text-[10px] px-1.5 py-0.5 rounded-full border ${getTabBadgeColor(tab)}`}>
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {/* Tasks List */}
      <div className="p-4 overflow-y-auto space-y-3 flex-1 max-h-[350px]">
        {loading ? (
          <div className="text-center text-xs text-slate-500 py-6">Loading tasks...</div>
        ) : tabTasks.length === 0 ? (
          <div className="text-center text-xs text-slate-500 py-6">No tasks in this lane.</div>
        ) : (
          tabTasks.map((task) => {
            const isExpanded = expandedTaskId === task.id;
            const title = task.title || task.name || "Untitled Task";
            const taskProjectId = task.projectId || task.project_id;
            const cleanTitle = title.replace(/\s+/g, " ");

            const handleKeyDown = (e: React.KeyboardEvent) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                toggleExpand(task.id);
              }
            };

            return (
              <div 
                key={task.id}
                className="border border-slate-800 rounded-lg hover:border-slate-700/80 transition-all bg-slate-950/20"
              >
                {/* Interactive Header */}
                <div 
                  onClick={() => toggleExpand(task.id)}
                  onKeyDown={handleKeyDown}
                  role="button"
                  tabIndex={0}
                  aria-expanded={isExpanded}
                  className="p-3 flex items-center justify-between cursor-pointer focus:outline-none focus:ring-1 focus:ring-cyan-500 rounded-t-lg"
                >
                  <div className="flex items-center gap-3">
                    {activeTab === "active" && <Play size={14} className="text-violet-400 animate-pulse shrink-0" />}
                    {activeTab === "next" && <Clock size={14} className="text-sky-400 shrink-0" />}
                    {activeTab === "attention" && <AlertTriangle size={14} className="text-rose-400 shrink-0" />}
                    <div className="text-left">
                      <h4 className="text-sm font-semibold text-slate-200">
                        {cleanTitle.length > 28 ? `${cleanTitle.slice(0, 28)}...` : cleanTitle}
                      </h4>
                      <span className="text-[10px] text-slate-500 truncate block max-w-[180px]">
                        {task.projectName || "Unknown Project"}
                      </span>
                    </div>
                  </div>
                  {isExpanded ? <ChevronUp size={16} className="text-slate-400" /> : <ChevronDown size={16} className="text-slate-400" />}
                </div>

                {/* Collapsible details */}
                {isExpanded && (
                  <div 
                    onClick={(e) => e.stopPropagation()}
                    className="px-3 pb-3 pt-1 border-t border-slate-800/40 text-xs text-slate-400 space-y-2.5 bg-slate-950/40 rounded-b-lg text-left"
                  >
                    {task.description && (
                      <div>
                        <span className="font-semibold text-slate-300">Description:</span>
                        <p 
                          tabIndex={0}
                          aria-label="Task description"
                          className="mt-0.5 text-slate-400 whitespace-pre-wrap leading-relaxed max-h-[100px] overflow-y-auto pr-1"
                        >
                          {task.description.trim()}
                        </p>
                      </div>
                    )}
                    
                    <div className="flex items-center justify-between pt-1 border-t border-slate-800/40 text-[10px] text-slate-500">
                      <span>Priority: <span className="font-semibold text-slate-400">P{task.priority ?? 0}</span></span>
                      <span>Status: <span className="font-semibold text-slate-400 uppercase">{task.status || "ready"}</span></span>
                    </div>

                    {onSelectTask && taskProjectId && (
                      <button
                        onClick={() => onSelectTask(task.id, taskProjectId)}
                        className="w-full flex items-center justify-center gap-1.5 py-1.5 px-3 rounded bg-cyan-950/40 border border-cyan-800/50 hover:bg-cyan-950/80 hover:border-cyan-500 text-cyan-300 transition-all font-medium text-[11px]"
                      >
                        <ExternalLink size={12} />
                        <span>Inspect Full Details</span>
                      </button>
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

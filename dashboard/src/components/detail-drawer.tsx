"use client"

import { useState, useEffect, useCallback, useRef } from "react";
import { X, Save, Edit3, ClipboardList, Calendar as CalendarIcon, Check, Loader2, RefreshCw, AlertCircle } from "lucide-react";
import { updateTask, type Task, type TaskStatus } from "@/lib/nexus";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { normalizeMarkdown } from "@/lib/normalizeMarkdown";
import { AnnotatedMarkdown } from "@/components/annotated-markdown";

interface DetailDrawerProps {
  task: Task | null;
  projectId: string | null;
  isOpen: boolean;
  onClose: () => void;
  onTaskChange?: () => void;
}

type Tab = "overview" | "spec" | "research" | "plan" | "walkthrough";

// Helper to clean potential JSON content from LLMs
function cleanContent(content: string): string {
  if (!content) return "";
  try {
    const trimmed = content.trim();
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
      let parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        try {
          const fixed = trimmed.replace(/'/g, '"');
          parsed = JSON.parse(fixed);
        } catch {
          return content;
        }
      }

      if (Array.isArray(parsed)) {
        return parsed
          .map((item: any) => item.text || item.content || (typeof item === "string" ? item : ""))
          .join("\n");
      }

      if (typeof parsed === "object" && parsed !== null) {
        return parsed.text || parsed.content || content;
      }

      if (typeof parsed === "string") return parsed;
    }
    return content;
  } catch (e) {
    return content;
  }
}

function StatusBadge({ status }: { status: TaskStatus }) {
  const knownConfig: Record<string, { label: string; color: string; bgColor: string }> = {
    idea: { label: "Idea", color: "text-yellow-400", bgColor: "bg-yellow-400/10 border-yellow-400/20" },
    todo: { label: "To Do", color: "text-cyan-400", bgColor: "bg-cyan-400/10 border-cyan-400/20" },
    planning: { label: "Planning", color: "text-purple-400", bgColor: "bg-purple-400/10 border-purple-400/20" },
    building: { label: "Building", color: "text-emerald-400", bgColor: "bg-emerald-400/10 border-emerald-400/20" },
    testing: { label: "Testing", color: "text-blue-400", bgColor: "bg-blue-400/10 border-blue-400/20" },
    ready_for_review: { label: "Review", color: "text-amber-400", bgColor: "bg-amber-400/10 border-amber-400/20" },
    complete: { label: "Complete", color: "text-slate-400", bgColor: "bg-slate-400/10 border-slate-400/20" },
    rejected: { label: "Rejected", color: "text-red-400", bgColor: "bg-red-400/10 border-red-400/20" },
    cancelled: { label: "Cancelled", color: "text-slate-500", bgColor: "bg-slate-500/10 border-slate-500/20" }
  };

  const config = knownConfig[status] || {
    label: status.replace(/_/g, " ").replace(/\b\w/g, l => l.toUpperCase()),
    color: "text-indigo-400",
    bgColor: "bg-indigo-400/10 border-indigo-400/20"
  };

  return (
    <span className={`px-2.5 py-0.5 rounded text-xs font-semibold border ${config.color} ${config.bgColor} uppercase tracking-wider`}>
      {config.label}
    </span>
  );
}

export function DetailDrawer({ task, projectId, isOpen, onClose, onTaskChange }: DetailDrawerProps) {
  const [activeTab, setActiveTab] = useState<Tab>("overview");
  const [isEditing, setIsEditing] = useState(false);
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Track previous task ID to trigger state resets when task switches
  const previousTaskId = useRef<string | null>(null);

  useEffect(() => {
    if (task) {
      if (task.id !== previousTaskId.current) {
        setDescription(task.description || "");
        setIsEditing(false);
        setError(null);
        previousTaskId.current = task.id;

        // Auto-select first available tab if active tab content doesn't exist
        if (activeTab === "research" && !task.researchReport) setActiveTab("overview");
        else if (activeTab === "plan" && !task.implementationPlan) setActiveTab("overview");
        else if (activeTab === "walkthrough" && !task.walkthrough) setActiveTab("overview");
        else if (activeTab === "spec" && !task.spec_output) setActiveTab("overview");
      }
    }
  }, [task, activeTab]);

  // Listen for Escape key press to close drawer
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !isEditing) {
        onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, onClose, isEditing]);

  if (!task) return null;

  const handleSave = async () => {
    if (!projectId) return;
    setSaving(true);
    setError(null);
    try {
      await updateTask(projectId, task.id, { description });
      setIsEditing(false);
      if (onTaskChange) onTaskChange();
    } catch (e) {
      console.error("Failed to update task description:", e);
      setError(e instanceof Error ? e.message : "Failed to update description");
    } finally {
      setSaving(false);
    }
  };

  const tabs: { id: Tab; label: string; disabled: boolean }[] = [
    { id: "overview", label: "Overview", disabled: false },
    { id: "spec", label: "Spec", disabled: !task.spec_output },
    { id: "research", label: "Research", disabled: !task.researchReport },
    { id: "plan", label: "Plan", disabled: !task.implementationPlan },
    { id: "walkthrough", label: "Walkthrough", disabled: !task.walkthrough }
  ];

  return (
    <div className={`fixed inset-0 z-50 overflow-hidden transition-all duration-300 ${isOpen ? "visible" : "delay-300 invisible"}`}>
      {/* Backdrop */}
      <div
        className={`absolute inset-0 bg-slate-950/60 backdrop-blur-sm transition-opacity duration-300 ${isOpen ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"}`}
        onClick={() => {
          if (!isEditing) onClose();
        }}
      />

      <div className="absolute inset-y-0 right-0 max-w-full flex pl-10">
        <div
          role="dialog"
          aria-modal="true"
          className={`w-screen max-w-3xl bg-slate-900 border-l border-slate-800 text-slate-200 flex flex-col justify-between shadow-2xl transform transition-transform duration-300 ease-in-out ${isOpen ? "translate-x-0" : "translate-x-full"}`}
        >
          {/* Header */}
          <div className="p-4 bg-slate-950/60 border-b border-slate-800 flex items-center justify-between shrink-0">
            <div className="flex items-center gap-3 min-w-0">
              <ClipboardList size={18} className="text-cyan-400 shrink-0" />
              <span className="text-xs font-semibold uppercase tracking-wider text-slate-400 truncate">
                Task Details
              </span>
            </div>
            <button onClick={onClose} className="p-1 rounded-lg hover:bg-slate-800 transition-colors">
              <X size={18} className="text-slate-400 hover:text-white" />
            </button>
          </div>

          {/* Title & Metadata Block */}
          <div className="p-6 pb-4 border-b border-slate-800 bg-slate-950/20 shrink-0">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1 text-left">
                <div className="flex items-center gap-2.5 mb-2">
                  <StatusBadge status={task.status} />
                  {task.metadata?.projectName && (
                    <span className="text-[10px] bg-slate-800 border border-slate-700/60 text-slate-400 font-medium px-2 py-0.5 rounded">
                      {String(task.metadata.projectName)}
                    </span>
                  )}
                </div>
                <h3 className="text-lg font-bold text-white leading-snug">{task.title}</h3>
                <div className="flex items-center gap-4 mt-2 text-[10px] text-slate-500 font-mono">
                  <span>ID: {task.id}</span>
                  {task.createdAt && (
                    <span className="flex items-center gap-1">
                      <CalendarIcon size={10} />
                      Created: {new Date(task.createdAt).toLocaleDateString()}
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* Error Message */}
            {error && (
              <div className="mt-3 p-2.5 bg-red-500/10 border border-red-500/20 rounded-lg text-xs text-red-400 flex items-start gap-2">
                <AlertCircle size={14} className="shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}
          </div>

          {/* Navigation Tabs */}
          <div className="flex gap-1 px-6 py-2 border-b border-slate-800 bg-slate-900/50 shrink-0 overflow-x-auto scrollbar-none">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => !tab.disabled && setActiveTab(tab.id)}
                disabled={tab.disabled}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all uppercase tracking-wide shrink-0 ${
                  activeTab === tab.id
                    ? "bg-cyan-500/20 text-cyan-400 border border-cyan-500/30"
                    : tab.disabled
                    ? "text-slate-600 cursor-not-allowed opacity-40"
                    : "text-slate-400 hover:text-white hover:bg-slate-800"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Content Area */}
          <div className="flex-1 overflow-y-auto p-6 min-h-0">
            {activeTab === "overview" && (
              <div className="space-y-4 text-left">
                <div className="flex justify-between items-center mb-1">
                  <span className="text-xs font-bold uppercase tracking-wider text-slate-400">
                    Description (Markdown)
                  </span>
                  {projectId && (
                    <div className="flex gap-2">
                      {!isEditing ? (
                        <button
                          onClick={() => setIsEditing(true)}
                          className="px-2 py-1 text-xs bg-slate-800 hover:bg-slate-700 text-cyan-400 hover:text-cyan-300 rounded border border-slate-750 flex items-center gap-1.5 transition-all"
                        >
                          <Edit3 size={12} /> Edit
                        </button>
                      ) : (
                        <>
                          <button
                            onClick={() => {
                              setIsEditing(false);
                              setDescription(task.description || "");
                              setError(null);
                            }}
                            className="px-2 py-1 text-xs bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-slate-200 rounded border border-slate-750 transition-all"
                          >
                            Cancel
                          </button>
                          <button
                            onClick={handleSave}
                            disabled={saving}
                            className="px-2.5 py-1 text-xs bg-emerald-950 hover:bg-emerald-900 border border-emerald-800 text-emerald-400 hover:text-emerald-300 rounded flex items-center gap-1.5 disabled:opacity-50 transition-all font-semibold"
                          >
                            {saving ? (
                              <Loader2 size={12} className="animate-spin" />
                            ) : (
                              <Check size={12} />
                            )}
                            {saving ? "Saving..." : "Save"}
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </div>

                {isEditing ? (
                  <textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    className="w-full min-h-[250px] bg-slate-950 border border-slate-800 p-3 rounded-lg text-sm text-slate-200 font-mono focus:outline-none focus:border-cyan-500/50"
                  />
                ) : (
                  <div className="bg-slate-950/20 p-5 rounded-lg border border-slate-850">
                    {description ? (
                      <div className="prose prose-invert prose-sm max-w-none
                        prose-headings:text-white prose-headings:font-bold
                        prose-p:text-slate-350 prose-p:leading-relaxed
                        prose-a:text-cyan-400 hover:prose-a:underline
                        prose-code:text-cyan-300 prose-code:bg-slate-800/80 prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:text-xs
                        prose-pre:bg-slate-950 prose-pre:border prose-pre:border-slate-800
                        prose-ul:text-slate-350 prose-ol:text-slate-350
                        prose-strong:text-white
                        prose-blockquote:border-cyan-500/50 prose-blockquote:text-slate-400
                      ">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>
                          {normalizeMarkdown(description)}
                        </ReactMarkdown>
                      </div>
                    ) : (
                      <p className="text-xs text-slate-500 italic">No description provided.</p>
                    )}
                  </div>
                )}
              </div>
            )}

            {activeTab === "spec" && task.spec_output && projectId && (
              <div className="text-left">
                <AnnotatedMarkdown
                  content={normalizeMarkdown(cleanContent(task.spec_output))}
                  stage="spec"
                  taskId={task.id}
                  projectId={projectId}
                  readOnly={true}
                />
              </div>
            )}

            {activeTab === "research" && task.researchReport && projectId && (
              <div className="text-left">
                <AnnotatedMarkdown
                  content={normalizeMarkdown(cleanContent(task.researchReport.content))}
                  stage="research"
                  taskId={task.id}
                  projectId={projectId}
                  readOnly={task.status !== "todo"}
                />
              </div>
            )}

            {activeTab === "plan" && task.implementationPlan && projectId && (
              <div className="text-left">
                <AnnotatedMarkdown
                  content={normalizeMarkdown(cleanContent(task.implementationPlan.content))}
                  stage="plan"
                  taskId={task.id}
                  projectId={projectId}
                  readOnly={task.status !== "planning"}
                />
              </div>
            )}

            {activeTab === "walkthrough" && task.walkthrough && projectId && (
              <div className="text-left">
                <AnnotatedMarkdown
                  content={normalizeMarkdown(cleanContent(task.walkthrough.content))}
                  stage="walkthrough"
                  taskId={task.id}
                  projectId={projectId}
                  readOnly={task.status !== "testing"}
                />
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="p-4 bg-slate-950/60 border-t border-slate-800 flex justify-end gap-3 shrink-0">
            <button
              onClick={onClose}
              className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-xs font-semibold rounded-lg transition-all"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

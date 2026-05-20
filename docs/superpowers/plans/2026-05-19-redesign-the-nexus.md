# Redesign The Nexus Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate The Nexus homepage into a single command center showing the Praxis terminal, daily schedule timeline, local LLM queue, compact task board, and a slide-out markdown inspector drawer.

**Architecture:** We will replace the current dashboard page (`dashboard/src/app/page.tsx`) with a 2-column layout. The left column will house the Praxis chat terminal, and the right column will stack timeline, queue, and board widgets. Clicking timeline/queue items expands them inline via accordions, while clicking tasks slides open a right overlay drawer rendering markdown notes and transcripts.

**Tech Stack:** Next.js (React), Tailwind CSS, Lucide React icons, and standard Next.js routing.

---

## Proposed Changes

### Task 1: Navigation Sidebar Drawer
Create a slide-over navigation panel component triggered by a hamburger button. This panel hosts links to Codex, System Monitor, Workflow Builder, Settings, and Projects, keeping the main dashboard clean.

**Files:**
- Create: `dashboard/src/components/nav-sidebar.tsx`

- [ ] **Step 1: Write Navigation Sidebar Component**
  Create `dashboard/src/components/nav-sidebar.tsx` with slide-over drawer transitions:
  ```tsx
  "use client"

  import { X, BookOpen, Gauge, Zap, Calendar, ListRestart, FolderGit2, Settings } from "lucide-react";
  import Link from "next/link";

  interface NavSidebarProps {
    isOpen: boolean;
    onClose: () => void;
    onOpenSettings: () => void;
  }

  export function NavSidebar({ isOpen, onClose, onOpenSettings }: NavSidebarProps) {
    if (!isOpen) return null;

    const navItems = [
      { href: "/task-board", label: "Task Board", icon: FolderGit2, color: "text-cyan-400 hover:text-cyan-300" },
      { href: "/system-monitor", label: "System Monitor", icon: Gauge, color: "text-amber-400 hover:text-amber-300" },
      { href: "/workflow-builder", label: "Workflow Builder", icon: Zap, color: "text-indigo-400 hover:text-indigo-300" },
      { href: "/calendar", label: "Calendar", icon: Calendar, color: "text-teal-400 hover:text-teal-300" },
      { href: "/local-queue", label: "Local Queue", icon: ListRestart, color: "text-sky-400 hover:text-sky-300" },
      { href: "/codex", label: "The Codex", icon: BookOpen, color: "text-pink-400 hover:text-pink-300" },
    ];

    return (
      <div className="fixed inset-0 z-50 overflow-hidden">
        {/* Backdrop overlay */}
        <div 
          className="absolute inset-0 bg-slate-950/60 backdrop-blur-sm transition-opacity"
          onClick={onClose}
        />

        <div className="absolute inset-y-0 right-0 pl-10 max-w-full flex">
          <div className="w-screen max-w-md bg-slate-900 border-l border-slate-800 text-slate-200 p-6 flex flex-col justify-between shadow-2xl">
            <div>
              <div className="flex items-center justify-between pb-6 border-b border-slate-800">
                <h2 className="text-lg font-bold text-white tracking-tight">THE NEXUS MENU</h2>
                <button onClick={onClose} className="p-1 rounded-lg hover:bg-slate-800 transition-colors">
                  <X size={20} className="text-slate-400 hover:text-white" />
                </button>
              </div>

              <nav className="mt-8 space-y-4">
                {navItems.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={onClose}
                    className={`flex items-center gap-3 px-4 py-3 rounded-lg border border-slate-800 bg-slate-950/40 hover:bg-slate-950/80 transition-all ${item.color}`}
                  >
                    <item.icon size={18} />
                    <span className="font-medium">{item.label}</span>
                  </Link>
                ))}
              </nav>
            </div>

            <div className="pt-6 border-t border-slate-800">
              <button
                onClick={() => {
                  onOpenSettings();
                  onClose();
                }}
                className="flex w-full items-center gap-3 px-4 py-3 rounded-lg border border-slate-800 bg-slate-950/40 hover:bg-slate-950/80 text-slate-400 hover:text-white transition-all"
              >
                <Settings size={18} />
                <span className="font-medium">Settings</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }
  ```

- [ ] **Step 2: Commit Navigation Sidebar**
  ```bash
  git add dashboard/src/components/nav-sidebar.tsx
  git commit -m "feat: add Navigation Sidebar component"
  ```

---

### Task 2: Schedule Timeline Component
Create the daily schedule list widget with inline accordion support to check event details at a glance.

**Files:**
- Create: `dashboard/src/components/schedule-timeline.tsx`

- [ ] **Step 1: Write Schedule Timeline Component**
  Create `dashboard/src/components/schedule-timeline.tsx`:
  ```tsx
  "use client"

  import { useEffect, useState } from "react";
  import { calendarEventsUrl, calendarEventTone, type CalendarEvent } from "@/lib/calendar";
  import { Calendar, ChevronDown, ChevronUp, CheckCircle, Play, Circle } from "lucide-react";

  export function ScheduleTimeline() {
    const [events, setEvents] = useState<CalendarEvent[]>([]);
    const [expandedEventId, setExpandedEventId] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);

    const fetchTodayEvents = async () => {
      try {
        const today = new Date();
        const start = new Date(today.setHours(0, 0, 0, 0)).toISOString();
        const end = new Date(today.setHours(23, 59, 59, 999)).toISOString();
        const res = await fetch(calendarEventsUrl(start, end));
        if (res.ok) {
          const data = await res.json();
          // Sort chronologically
          const sorted = (data || []).sort((a: CalendarEvent, b: CalendarEvent) => 
            new Date(a.start_time).getTime() - new Date(b.start_time).getTime()
          );
          setEvents(sorted);
        }
      } catch (e) {
        console.error("Failed to fetch schedule events:", e);
      } finally {
        setLoading(false);
      }
    };

    useEffect(() => {
      fetchTodayEvents();
      const interval = setInterval(fetchTodayEvents, 10000);
      return () => clearInterval(interval);
    }, []);

    const toggleExpand = (id: string) => {
      setExpandedEventId(prev => (prev === id ? null : id));
    };

    const formatTime = (isoString: string) => {
      return new Date(isoString).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    };

    return (
      <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-lg">
        <div className="bg-slate-950/60 border-b border-slate-800 px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Calendar size={16} className="text-teal-400" />
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">Today's Schedule</span>
          </div>
          <span className="text-xs text-slate-500 font-medium">{events.length} items</span>
        </div>

        <div className="p-4 max-h-[300px] overflow-y-auto space-y-3">
          {loading ? (
            <div className="text-center text-xs text-slate-500 py-6">Loading schedule...</div>
          ) : events.length === 0 ? (
            <div className="text-center text-xs text-slate-500 py-6">No events scheduled for today.</div>
          ) : (
            events.map((event) => {
              const tone = calendarEventTone(event);
              const isExpanded = expandedEventId === event.id;

              return (
                <div 
                  key={event.id}
                  className={`border rounded-lg transition-all ${tone.block} cursor-pointer`}
                  onClick={() => toggleExpand(event.id)}
                >
                  <div className="p-3 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      {event.status === "completed" && <CheckCircle size={16} className="text-emerald-400" />}
                      {event.status === "in_progress" && <Play size={16} className="text-amber-400 animate-pulse" />}
                      {event.status === "scheduled" && <Circle size={16} className="text-cyan-400" />}
                      <div>
                        <div className="text-xs text-slate-400 font-medium">
                          {formatTime(event.start_time)}
                          {event.end_time && ` - ${formatTime(event.end_time)}`}
                        </div>
                        <h4 className={`text-sm font-semibold ${tone.title}`}>{event.title}</h4>
                      </div>
                    </div>
                    {isExpanded ? <ChevronUp size={16} className="text-slate-400" /> : <ChevronDown size={16} className="text-slate-400" />}
                  </div>

                  {isExpanded && (
                    <div className="px-3 pb-3 pt-1 border-t border-slate-800/40 text-xs text-slate-400 space-y-2 bg-slate-950/20">
                      {event.description && (
                        <div>
                          <span className="font-semibold text-slate-300">Description:</span>
                          <p className="mt-0.5">{event.description}</p>
                        </div>
                      )}
                      {event.result && (
                        <div>
                          <span className="font-semibold text-slate-300">Result:</span>
                          <p className="mt-0.5 font-mono text-[10px] bg-slate-950 p-2 rounded border border-slate-800/60 overflow-x-auto whitespace-pre-wrap">{event.result}</p>
                        </div>
                      )}
                      <div className="flex justify-between items-center pt-1 text-[10px] text-slate-500">
                        <span>Status: <span className="font-semibold uppercase">{event.status}</span></span>
                        {event.event_type && <span>Type: {event.event_type}</span>}
                      </div>
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
  ```

- [ ] **Step 2: Commit Schedule Timeline**
  ```bash
  git add dashboard/src/components/schedule-timeline.tsx
  git commit -m "feat: add Schedule Timeline widget with inline accordion"
  ```

---

### Task 3: Local Queue Widget Component
Create the background LLM queue component display with collapsible status/logs list.

**Files:**
- Create: `dashboard/src/components/local-queue-list.tsx`

- [ ] **Step 1: Write Local Queue Component**
  Create `dashboard/src/components/local-queue-list.tsx`:
  ```tsx
  "use client"

  import { useEffect, useState } from "react";
  import { getLocalLlmQueue, type LocalLlmJob } from "@/lib/nexus";
  import { ListRestart, ChevronDown, ChevronUp, RefreshCcw, Pause, Play, AlertCircle, CheckCircle } from "lucide-react";

  export function LocalQueueList() {
    const [jobs, setJobs] = useState<LocalLlmJob[]>([]);
    const [expandedJobId, setExpandedJobId] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);

    const fetchQueue = async () => {
      try {
        const queueState = await getLocalLlmQueue();
        setJobs(queueState?.jobs || []);
      } catch (e) {
        console.error("Failed to fetch LLM queue:", e);
      } finally {
        setLoading(false);
      }
    };

    useEffect(() => {
      fetchQueue();
      const interval = setInterval(fetchQueue, 5000);
      return () => clearInterval(interval);
    }, []);

    const toggleExpand = (id: string) => {
      setExpandedJobId(prev => (prev === id ? null : id));
    };

    const getStatusStyle = (status: string) => {
      switch (status) {
        case "running":
          return "bg-amber-500/20 text-amber-300 border-amber-500/30";
        case "completed":
          return "bg-emerald-500/20 text-emerald-300 border-emerald-500/30";
        case "failed":
          return "bg-red-500/20 text-red-300 border-red-500/30";
        default:
          return "bg-sky-500/20 text-sky-300 border-sky-500/30";
      }
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

              return (
                <div 
                  key={job.id}
                  className="border border-slate-800 rounded-lg hover:border-slate-700/80 transition-all bg-slate-950/20 cursor-pointer"
                  onClick={() => toggleExpand(job.id)}
                >
                  <div className="p-3 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <span className={`text-[10px] px-2 py-0.5 rounded-full border ${statusStyle} font-semibold uppercase`}>
                        {job.status}
                      </span>
                      <div>
                        <h4 className="text-sm font-semibold text-slate-200 font-mono text-left">{job.prompt.slice(0, 30)}...</h4>
                        <span className="text-[10px] text-slate-500">Attempts: {job.attempts || 1} • Priority: {job.priority || 0}</span>
                      </div>
                    </div>
                    {isExpanded ? <ChevronUp size={16} className="text-slate-400" /> : <ChevronDown size={16} className="text-slate-400" />}
                  </div>

                  {isExpanded && (
                    <div className="px-3 pb-3 pt-1 border-t border-slate-800/40 text-xs text-slate-400 space-y-2 bg-slate-950/40">
                      <div>
                        <span className="font-semibold text-slate-300">Prompt Context:</span>
                        <p className="mt-0.5 bg-slate-950 p-2 rounded border border-slate-800 font-mono text-[10px] whitespace-pre-wrap">{job.prompt}</p>
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
                          <p className="mt-0.5 bg-emerald-950/20 p-2 rounded border border-emerald-500/20 font-mono text-[10px] max-h-[120px] overflow-y-auto whitespace-pre-wrap">{job.result}</p>
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
  ```

- [ ] **Step 2: Commit Local Queue**
  ```bash
  git add dashboard/src/components/local-queue-list.tsx
  git commit -m "feat: add Local Queue list widget with expandable detail"
  ```

---

### Task 4: Compact Task Board Component
Create the simplified kanban board widget displaying To Do and In Progress tasks in compact lanes.

**Files:**
- Create: `dashboard/src/components/compact-task-board.tsx`

- [ ] **Step 1: Write Compact Task Board Component**
  Create `dashboard/src/components/compact-task-board.tsx`:
  ```tsx
  "use client"

  import { useEffect, useState } from "react";
  import { getBoardState, type Task } from "@/lib/nexus";
  import { Kanban, ArrowRight } from "lucide-react";

  interface CompactTaskBoardProps {
    onSelectTask: (task: Task) => void;
  }

  export function CompactTaskBoard({ onSelectTask }: CompactTaskBoardProps) {
    const [tasks, setTasks] = useState<Task[]>([]);
    const [loading, setLoading] = useState(true);

    const fetchTasks = async () => {
      try {
        const board = await getBoardState();
        // Flatten projects' tasks
        const allTasks = (board.projects || []).reduce((acc: Task[], project: any) => {
          return [...acc, ...(project.tasks || [])];
        }, []);
        setTasks(allTasks);
      } catch (e) {
        console.error("Failed to fetch board tasks:", e);
      } finally {
        setLoading(false);
      }
    };

    useEffect(() => {
      fetchTasks();
      const interval = setInterval(fetchTasks, 8000);
      return () => clearInterval(interval);
    }, []);

    // Filter into compact columns
    const todoTasks = tasks.filter(t => t.status === "todo" || t.status === "planning");
    const progressTasks = tasks.filter(t => t.status === "building" || t.status === "testing");

    return (
      <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-lg">
        <div className="bg-slate-950/60 border-b border-slate-800 px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Kanban size={16} className="text-purple-400" />
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">Active Tasks</span>
          </div>
        </div>

        <div className="p-4 grid grid-cols-2 gap-3 min-h-[180px] max-h-[300px] overflow-y-auto">
          {loading ? (
            <div className="col-span-2 text-center text-xs text-slate-500 py-6">Loading board...</div>
          ) : (
            <>
              {/* To Do Lane */}
              <div className="space-y-2">
                <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500 border-b border-slate-800/80 pb-1 flex justify-between">
                  <span>To Do</span>
                  <span>{todoTasks.length}</span>
                </div>
                <div className="space-y-1.5">
                  {todoTasks.length === 0 ? (
                    <div className="text-[10px] text-slate-600 text-center py-4">No tasks</div>
                  ) : (
                    todoTasks.map(task => (
                      <div 
                        key={task.id}
                        onClick={() => onSelectTask(task)}
                        className="p-2 bg-slate-950/30 hover:bg-slate-950/80 border border-slate-850 rounded text-xs text-slate-350 cursor-pointer transition-all border-l-2 border-l-purple-500 flex justify-between items-center group"
                      >
                        <span className="truncate pr-1 text-left">{task.title}</span>
                        <ArrowRight size={10} className="text-slate-600 group-hover:text-purple-400 shrink-0" />
                      </div>
                    ))
                  )}
                </div>
              </div>

              {/* In Progress Lane */}
              <div className="space-y-2">
                <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500 border-b border-slate-800/80 pb-1 flex justify-between">
                  <span>In Progress</span>
                  <span>{progressTasks.length}</span>
                </div>
                <div className="space-y-1.5">
                  {progressTasks.length === 0 ? (
                    <div className="text-[10px] text-slate-600 text-center py-4">No tasks</div>
                  ) : (
                    progressTasks.map(task => (
                      <div 
                        key={task.id}
                        onClick={() => onSelectTask(task)}
                        className="p-2 bg-slate-950/30 hover:bg-slate-950/80 border border-slate-850 rounded text-xs text-slate-350 cursor-pointer transition-all border-l-2 border-l-cyan-500 flex justify-between items-center group"
                      >
                        <span className="truncate pr-1 text-left">{task.title}</span>
                        <ArrowRight size={10} className="text-slate-600 group-hover:text-cyan-400 shrink-0" />
                      </div>
                    ))
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    );
  }
  ```

- [ ] **Step 2: Commit Compact Task Board**
  ```bash
  git add dashboard/src/components/compact-task-board.tsx
  git commit -m "feat: add Compact Task Board component"
  ```

---

### Task 5: Detail Inspector Drawer
Create the slide-over markdown viewer and editor drawer to view and modify markdown files, tasks, and notes directly.

**Files:**
- Create: `dashboard/src/components/detail-drawer.tsx`

- [ ] **Step 1: Write Detail Inspector Drawer Component**
  Create `dashboard/src/components/detail-drawer.tsx`:
  ```tsx
  "use client"

  import { useState, useEffect } from "react";
  import { X, Save, Edit3, ClipboardList } from "lucide-react";
  import { updateTask, type Task } from "@/lib/nexus";

  interface DetailDrawerProps {
    task: Task | null;
    onClose: () => void;
    onSaveSuccess?: () => void;
  }

  export function DetailDrawer({ task, onClose, onSaveSuccess }: DetailDrawerProps) {
    const [isEditing, setIsEditing] = useState(false);
    const [description, setDescription] = useState("");
    const [saving, setSaving] = useState(false);

    useEffect(() => {
      if (task) {
        setDescription(task.description || "");
        setIsEditing(false);
      }
    }, [task]);

    if (!task) return null;

    const handleSave = async () => {
      setSaving(true);
      try {
        const projectId = task.metadata?.projectId || "shared-mind";
        await updateTask(projectId, task.id, { description });
        setIsEditing(false);
        if (onSaveSuccess) onSaveSuccess();
      } catch (e) {
        console.error("Failed to update task description:", e);
      } finally {
        setSaving(false);
      }
    };

    return (
      <div className="fixed inset-y-0 right-0 z-40 w-full max-w-md bg-slate-900 border-l border-slate-800 shadow-2xl flex flex-col justify-between text-slate-200">
        <div>
          {/* Header */}
          <div className="p-4 bg-slate-950/60 border-b border-slate-800 flex items-center justify-between">
            <div className="flex items-center gap-2 text-cyan-400">
              <ClipboardList size={18} />
              <span className="text-sm font-bold uppercase tracking-wide">Task Inspector</span>
            </div>
            <button onClick={onClose} className="p-1 rounded hover:bg-slate-800 transition-colors">
              <X size={18} className="text-slate-400 hover:text-white" />
            </button>
          </div>

          {/* Details body */}
          <div className="p-6 overflow-y-auto max-h-[calc(100vh-140px)] space-y-6">
            <div>
              <span className="text-[10px] px-2.5 py-0.5 rounded-full bg-slate-800 border border-slate-700/60 text-slate-400 font-bold uppercase">
                {task.status}
              </span>
              <h3 className="text-lg font-bold text-white mt-2 leading-snug text-left">{task.title}</h3>
              <p className="text-[10px] text-slate-500 mt-1 font-mono">ID: {task.id}</p>
            </div>

            <hr className="border-slate-800" />

            <div className="space-y-3">
              <div className="flex justify-between items-center">
                <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">Description (Markdown)</span>
                {!isEditing ? (
                  <button 
                    onClick={() => setIsEditing(true)}
                    className="text-xs text-cyan-400 hover:text-cyan-300 flex items-center gap-1.5"
                  >
                    <Edit3 size={12} /> Edit
                  </button>
                ) : (
                  <button 
                    onClick={handleSave}
                    disabled={saving}
                    className="text-xs text-emerald-400 hover:text-emerald-300 flex items-center gap-1.5 disabled:opacity-50"
                  >
                    <Save size={12} /> {saving ? "Saving..." : "Save"}
                  </button>
                )}
              </div>

              {isEditing ? (
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className="w-full min-h-[220px] bg-slate-950 border border-slate-800 p-3 rounded-lg text-sm text-slate-200 font-mono focus:outline-none focus:border-cyan-500/50"
                />
              ) : (
                <div className="bg-slate-950/40 p-4 rounded-lg border border-slate-850 text-sm text-slate-350 leading-relaxed text-left whitespace-pre-wrap font-sans">
                  {description || "No description provided."}
                </div>
              )}
            </div>

            {task.implementationPlan && (
              <div className="space-y-2">
                <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">Implementation Plan</span>
                <div className="bg-slate-950 p-3 rounded border border-slate-850 font-mono text-[10px] overflow-x-auto max-h-[150px]">
                  {task.implementationPlan.content}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="p-4 bg-slate-950/60 border-t border-slate-800 flex justify-end gap-3">
          <button 
            onClick={onClose}
            className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-xs font-semibold rounded-lg transition-all"
          >
            Close
          </button>
        </div>
      </div>
    );
  }
  ```

- [ ] **Step 2: Commit Detail Inspector Drawer**
  ```bash
  git add dashboard/src/components/detail-drawer.tsx
  git commit -m "feat: add Detail Drawer component for markdown and task logs"
  ```

---

### Task 6: Unified Page Layout Integration
Replace the default page with our 2-column re-layout: Left Column hosting AITerminal, Right Column stacking Schedule, Queue, and Task widgets. Implement the Hamburger Header menu overlay.

**Files:**
- Modify: `dashboard/src/app/page.tsx`

- [ ] **Step 1: Rewrite Page Layout**
  Edit `dashboard/src/app/page.tsx` to mount widgets, state handlers, navigation sidebar, and detail drawer overlays:
  ```tsx
  "use client"

  import { useState } from "react";
  import { AITerminal } from "@/components/ai-terminal";
  import { ScheduleTimeline } from "@/components/schedule-timeline";
  import { LocalQueueList } from "@/components/local-queue-list";
  import { CompactTaskBoard } from "@/components/compact-task-board";
  import { DetailDrawer } from "@/components/detail-drawer";
  import { NavSidebar } from "@/components/nav-sidebar";
  import { SettingsModal } from "@/components/settings-modal";
  import { Menu } from "lucide-react";
  import { type Task } from "@/lib/nexus";

  export default function Home() {
    const [selectedTask, setSelectedTask] = useState<Task | null>(null);
    const [isMenuOpen, setIsMenuOpen] = useState(false);
    const [showSettings, setShowSettings] = useState(false);

    return (
      <main className="min-h-screen bg-slate-950 text-slate-200 selection:bg-cyan-500/30 flex flex-col">
        {/* Header HUD */}
        <header className="sticky top-0 z-30 border-b border-slate-800 bg-slate-950/80 backdrop-blur-md">
          <div className="container mx-auto flex h-16 items-center justify-between px-6">
            <div className="flex items-center gap-2">
              <div className="h-2 w-2 rounded-full bg-cyan-500 animate-pulse" />
              <h1 className="text-xl font-bold tracking-tight text-white">
                THE <span className="text-cyan-400">NEXUS</span>
              </h1>
            </div>
            
            <div className="flex items-center gap-4">
              <span className="text-xs text-slate-500 bg-slate-900 border border-slate-800 px-3 py-1 rounded-full font-medium">
                Praxis Decoupled
              </span>
              <button 
                onClick={() => setIsMenuOpen(true)}
                className="p-2 rounded-lg bg-slate-900 border border-slate-800 text-slate-400 hover:text-white transition-colors"
              >
                <Menu size={20} />
              </button>
            </div>
          </div>
        </header>

        {/* Dashboard 2-Column Grid */}
        <div className="flex-1 container mx-auto p-6 grid grid-cols-1 lg:grid-cols-2 gap-6 items-stretch">
          {/* Left Column: Praxis Chat/Terminal */}
          <div className="flex flex-col border border-slate-800 rounded-xl overflow-hidden shadow-lg h-[calc(100vh-140px)]">
            <div className="flex-1 relative bg-slate-950/20">
              <AITerminal mode="inline" />
            </div>
          </div>

          {/* Right Column: Stacked Control Center widgets */}
          <div className="flex flex-col gap-6 overflow-y-auto max-h-[calc(100vh-140px)] pr-2">
            <ScheduleTimeline />
            <LocalQueueList />
            <CompactTaskBoard onSelectTask={(task) => setSelectedTask(task)} />
          </div>
        </div>

        {/* Navigation Sidebar Drawer */}
        <NavSidebar 
          isOpen={isMenuOpen} 
          onClose={() => setIsMenuOpen(false)} 
          onOpenSettings={() => setShowSettings(true)}
        />

        {/* Detail Inspection Drawer */}
        {selectedTask && (
          <DetailDrawer 
            task={selectedTask} 
            onClose={() => setSelectedTask(null)} 
          />
        )}

        {/* Settings Modal */}
        {showSettings && (
          <SettingsModal 
            isOpen={showSettings} 
            onClose={() => setShowSettings(false)} 
          />
        )}
      </main>
    );
  }
  ```

- [ ] **Step 2: Commit Page Layout Redesign**
  ```bash
  git add dashboard/src/app/page.tsx
  git commit -m "feat: re-architect main dashboard layout to 2-column grid HUD"
  ```

---

## Verification Plan

### Automated Verification
1. Run local build checks to verify imports, syntax, and stylesheet linking:
   Run: `npm run build` in `/Volumes/Projects/TheNexus/dashboard`
   Expected output: Build success without typescript compilation errors.

### Manual Verification
1. Run the local development server:
   Run: `npm run dev` in `/Volumes/Projects/TheNexus/dashboard`
2. Open the page and verify:
   - Left side contains the AITerminal fully visible.
   - Right side shows schedule events and queue jobs.
   - Clicking schedule timeline items collapses/expands the accordion inline.
   - Clicking a task in the compact task board slides in the right-side detail drawer showing markdown content.
   - Editing and saving description edits properly syncs back to the API.

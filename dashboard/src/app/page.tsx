"use client"

import { useEffect, useState, useCallback } from "react";
import { getProjects, getPins, getTasks, type Project, type Task } from "@/lib/nexus";
import { ProjectCard } from "@/components/project-card";
import { NewProjectModal } from "@/components/new-project-modal";
import { SettingsModal } from "@/components/settings-modal";
import { NavSidebar } from "@/components/nav-sidebar";
import { ScheduleTimeline } from "@/components/schedule-timeline";
import { CompactTaskBoard } from "@/components/compact-task-board";
import { DetailDrawer } from "@/components/detail-drawer";
import { HitlInbox } from "@/components/hitl-inbox";
import { ActivityFeed } from "@/components/activity-feed";
import { PraxisCore } from "@/components/bridge/praxis-core";
import { DispatchStation } from "@/components/bridge/dispatch-station";
import { KnowledgeStation } from "@/components/bridge/knowledge-station";
import { PowerStation } from "@/components/bridge/power-station";
import { AcademyStation } from "@/components/bridge/academy-station";
import { VoiceCommandBar } from "@/components/bridge/voice-command-bar";
import { AmbientMode } from "@/components/bridge/ambient-mode";
import { StatusStrip } from "@/components/bridge/status-strip";
import { Activity, Plus, Settings, Menu, FolderOpen, AlertCircle } from "lucide-react";

export default function Home() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [pins, setPins] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Navigation / Modals State
  const [isNavOpen, setIsNavOpen] = useState(false);
  const [showNewProjectModal, setShowNewProjectModal] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  // Inspector Drawer State
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [inspectingTask, setInspectingTask] = useState<Task | null>(null);
  const [inspectingProjectId, setInspectingProjectId] = useState<string | null>(null);

  // Refresh signals
  const [boardRefreshKey, setBoardRefreshKey] = useState(0);

  const loadData = useCallback(async () => {
    try {
      const [projectsData, pinsData] = await Promise.all([
        getProjects(),
        getPins()
      ]);
      setProjects(projectsData || []);
      setPins(pinsData || []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Filesystem Error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleNewProjectSuccess = () => {
    loadData();
  };

  const handlePinChange = (id: string, pinned: boolean) => {
    if (pinned) {
      setPins(prev => [...prev, id]);
    } else {
      setPins(prev => prev.filter(p => p !== id));
    }
  };

  // Select a task to inspect in detail drawer
  const handleSelectTask = async (taskId: string, projectId: string) => {
    setInspectingProjectId(projectId);
    setInspectingTask(null);
    setInspectorOpen(true);
    try {
      const res = await getTasks(projectId);
      const foundTask = res.tasks?.find(t => t.id === taskId);
      if (foundTask) {
        setInspectingTask(foundTask);
      }
    } catch (err) {
      console.error("Error loading task details for inspector:", err);
    }
  };

  // Called when a task is updated in the inspector (e.g. description edit saved)
  const handleTaskChanged = () => {
    setBoardRefreshKey(prev => prev + 1);
    if (inspectingTask && inspectingProjectId) {
      // Re-fetch detail task to show updated information in the drawer
      getTasks(inspectingProjectId)
        .then(res => {
          const foundTask = res.tasks?.find(t => t.id === inspectingTask.id);
          if (foundTask) {
            setInspectingTask(foundTask);
          }
        })
        .catch(err => console.error("Error updating drawer task details:", err));
    }
  };

  // Sort projects: pinned first
  const sortedProjects = [...projects].sort((a, b) => {
    const aPinned = pins.includes(a.id);
    const bPinned = pins.includes(b.id);
    if (aPinned && !bPinned) return -1;
    if (!aPinned && bPinned) return 1;
    return 0;
  });

  return (
    <main className="min-h-screen bg-slate-950 hud-backdrop text-slate-200 selection:bg-cyan-500/30 flex flex-col pb-12">
      {/* Header HUD */}
      <header className="sticky top-0 z-40 border-b border-slate-800 bg-slate-950/80 backdrop-blur-md shrink-0">
        <div className="mx-auto w-full max-w-[2400px] flex h-16 items-center justify-between px-6">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setIsNavOpen(true)}
              className="p-1.5 rounded-lg border border-slate-800 bg-slate-900/50 hover:bg-slate-800 text-slate-400 hover:text-white transition-all mr-1"
              aria-label="Open navigation menu"
            >
              <Menu size={20} />
            </button>
            <div className="h-2 w-2 rounded-full bg-cyan-500 animate-pulse shrink-0" />
            <h1 className="text-lg font-bold tracking-tight text-white flex items-baseline gap-1.5">
              THE <span className="text-cyan-400">NEXUS</span>
              <span className="text-[10px] text-slate-500 font-mono font-medium border border-slate-800/80 px-1.5 py-0.5 rounded bg-slate-950">
                Bridge
              </span>
            </h1>
          </div>

          <div className="flex items-center gap-3">
            <VoiceCommandBar />
            <AmbientMode />
            <button
              onClick={() => setShowNewProjectModal(true)}
              className="flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-cyan-500/20 to-purple-500/20 hover:from-cyan-500/30 hover:to-purple-500/30 border border-cyan-500/30 hover:border-cyan-500/50 px-3.5 py-1.5 text-xs font-semibold text-cyan-400 hover:text-cyan-300 transition-all shadow-lg shadow-cyan-500/5"
            >
              <Plus size={14} />
              <span>New Project</span>
            </button>
            <button
              onClick={() => setShowSettings(true)}
              className="p-1.5 rounded-lg border border-slate-800 bg-slate-900/50 hover:bg-slate-800 text-slate-400 hover:text-white transition-all"
              aria-label="Open settings"
            >
              <Settings size={18} />
            </button>
          </div>
        </div>
      </header>

      {/* Main Workspace */}
      <div className="mx-auto w-full max-w-[2400px] p-6 flex-1 flex flex-col min-h-0">
        {error && (
          <div className="rounded-lg border border-red-500/50 bg-red-500/10 p-4 text-red-400 mb-6 flex items-start gap-2.5 text-left">
            <AlertCircle size={18} className="shrink-0 mt-0.5" />
            <div>
              <p className="font-bold text-sm">Connection Error</p>
              <p className="text-xs mt-0.5 opacity-90">{error}</p>
            </div>
          </div>
        )}

        {/* Headline KPI strip — click a chip to warp to its station */}
        <StatusStrip />

        {/* Bridge deck — the Praxis core viewer and its four stations stack in
            the left column; the inbox/schedule/activity rail falls beside the
            whole stack on the right rather than stopping under the core. */}
        <div className="mb-6 grid items-start gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          {/* Left column — main viewer over the bridge stations */}
          <div className="flex min-w-0 flex-col gap-4">
            <div id="station-core">
              <PraxisCore />
            </div>

            {/* Stations, 2-up: Dispatch and Knowledge sit directly under the core */}
            <div className="grid items-start gap-4 md:grid-cols-2">
              <div id="station-dispatch">
                <DispatchStation />
              </div>
              <div id="station-knowledge">
                <KnowledgeStation />
              </div>
              <div id="station-academy">
                <AcademyStation />
              </div>
              <div id="station-power">
                <PowerStation />
              </div>
            </div>
          </div>

          {/* Right column — inbox / schedule / activity rail */}
          <div id="panel-inbox" className="flex flex-col gap-4 min-w-0">
            <HitlInbox />
            <ScheduleTimeline />
            <div id="panel-activity">
              <ActivityFeed />
            </div>
          </div>
        </div>

        {/* Task board — full width below the stations */}
        <div id="task-board">
          <CompactTaskBoard key={boardRefreshKey} onSelectTask={handleSelectTask} />
        </div>

        {/* Pinned / Active Projects Section */}
        <div className="mt-12 pt-8 border-t border-slate-800/80 text-left shrink-0">
          <div className="mb-6 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <FolderOpen size={18} className="text-cyan-400" />
              <h2 className="text-lg font-bold text-white tracking-tight">PROJECT REFERENCE</h2>
            </div>
          </div>

          {loading ? (
            <div className="flex h-32 items-center justify-center">
              <Activity className="animate-spin text-cyan-500" size={24} />
            </div>
          ) : sortedProjects.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-slate-800 py-12 text-center bg-slate-900/10">
              <span className="text-xs text-slate-500">No active projects detected.</span>
            </div>
          ) : (
            <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {sortedProjects.map((p) => (
                <ProjectCard
                  key={p.id}
                  project={p}
                  isPinned={pins.includes(p.id)}
                  onPinChange={handlePinChange}
                  pendingReviews={p.stats?.pending_reviews}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Global Slide-over Nav Menu */}
      <NavSidebar
        isOpen={isNavOpen}
        onClose={() => setIsNavOpen(false)}
        onOpenSettings={() => setShowSettings(true)}
      />

      {/* Global Right Slide-over Task Inspector Drawer */}
      <DetailDrawer
        task={inspectingTask}
        projectId={inspectingProjectId}
        isOpen={inspectorOpen}
        onClose={() => setInspectorOpen(false)}
        onTaskChange={handleTaskChanged}
      />

      {/* Modals */}
      <NewProjectModal
        isOpen={showNewProjectModal}
        onClose={() => setShowNewProjectModal(false)}
        onSuccess={handleNewProjectSuccess}
      />

      <SettingsModal
        isOpen={showSettings}
        onClose={() => setShowSettings(false)}
      />
    </main>
  );
}

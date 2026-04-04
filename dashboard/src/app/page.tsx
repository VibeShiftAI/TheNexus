"use client"

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { getProjects, getPins, Project } from "@/lib/nexus";
import { ProjectCard } from "@/components/project-card";
import { NewProjectModal } from "@/components/new-project-modal";
import { ActivityFeed } from "@/components/activity-feed";
import { AntigravityMonitor } from "@/components/antigravity-monitor";
import { AITerminal } from "@/components/ai-terminal";
import { DashboardInitiatives } from "@/components/dashboard-initiatives";
import { DashboardSidebar } from "@/components/dashboard-sidebar";
import { DailyJournal } from "@/components/daily-journal";
import { Activity, Zap, Folder, Plus, Gauge, X, BookOpen, Settings } from "lucide-react";
import { SettingsModal } from "@/components/settings-modal";

import Link from "next/link";

export default function Home() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [pins, setPins] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showNewProjectModal, setShowNewProjectModal] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  const router = useRouter();


  const loadData = useCallback(async () => {
    try {
      const [projectsData, pinsData] = await Promise.all([
        getProjects(),
        getPins()
      ]);
      setProjects(projectsData);
      setPins(pinsData);
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

  // Sort projects: pinned first
  const sortedProjects = [...projects].sort((a, b) => {
    const aPinned = pins.includes(a.id);
    const bPinned = pins.includes(b.id);
    if (aPinned && !bPinned) return -1;
    if (!aPinned && bPinned) return 1;
    return 0;
  });

  return (
    <main className="min-h-screen bg-slate-950 text-slate-200 selection:bg-cyan-500/30">
      {/* Header HUD */}
      <header className="sticky top-0 z-50 border-b border-slate-800 bg-slate-950/80 backdrop-blur-md">
        <div className="container mx-auto flex h-16 items-center justify-between px-6">
          <div className="flex items-center gap-2">
            <div className="h-2 w-2 rounded-full bg-cyan-500 animate-pulse" />
            <h1 className="text-xl font-bold tracking-tight text-white">
              THE <span className="text-cyan-400">NEXUS</span>
            </h1>
          </div>
          <div className="flex items-center gap-6 text-sm font-medium text-slate-400">
            <Link
              href="/system-monitor"
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-gradient-to-r from-amber-500/20 to-orange-500/20 border border-amber-500/30 hover:border-amber-500/50 transition-all text-amber-400 hover:text-amber-300"
            >
              <Gauge size={16} />
              <span>System Monitor</span>
            </Link>
            <Link
              href="/workflow-builder"
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-gradient-to-r from-indigo-500/20 to-purple-500/20 border border-indigo-500/30 hover:border-indigo-500/50 transition-all text-indigo-400 hover:text-indigo-300"
            >
              <Zap size={16} />
              <span>Workflow Builder</span>
            </Link>
            <Link
              href="/codex"
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-gradient-to-r from-pink-500/20 to-rose-500/20 border border-pink-500/30 hover:border-pink-500/50 transition-all text-pink-400 hover:text-pink-300"
            >
              <BookOpen size={16} />
              <span>The Codex</span>
            </Link>
            <button
              onClick={() => setShowSettings(true)}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-gradient-to-r from-slate-500/20 to-slate-400/20 border border-slate-500/30 hover:border-slate-400/50 transition-all text-slate-400 hover:text-slate-300"
            >
              <Settings size={16} />
              <span>Settings</span>
            </button>

          </div>
        </div>
      </header>

      {/* Content Grid */}
      <div className="container mx-auto p-6">
        {/* Praxis Terminal & Dashboard Sidebar */}
        <div className="mb-8 grid gap-6 lg:grid-cols-[1fr_380px]">
          {/* Left: Praxis Terminal — absolute-positioned so sidebar drives row height */}
          <div className="relative min-h-[400px]">
            <div className="absolute inset-0">
              <AITerminal mode="inline" />
            </div>
          </div>

          {/* Right: Consolidated Sidebar — its content determines the row height */}
          <div>
            <DashboardSidebar onRefresh={loadData} />
          </div>
        </div>

        {/* Full-width Praxis Journal under Terminal & Sidebar */}
        <div className="mb-8">
          <DailyJournal />
        </div>

        <div className="mb-8 flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-bold text-white mb-2">Active Projects</h2>
            <div className="h-1 w-24 bg-gradient-to-r from-cyan-500 to-transparent" />
          </div>
          <button
            onClick={() => setShowNewProjectModal(true)}
            className="flex items-center gap-2 rounded-lg bg-gradient-to-r from-cyan-500 to-purple-500 px-4 py-2 text-sm font-medium text-white hover:from-cyan-600 hover:to-purple-600 transition-all shadow-lg shadow-cyan-500/20"
          >
            <Plus size={18} />
            <span>New Project</span>
          </button>
        </div>

        {error && (
          <div className="rounded-lg border border-red-500/50 bg-red-500/10 p-4 text-red-400 mb-6">
            <p className="font-bold">Connection Error</p>
            <p className="text-sm">{error}</p>
            <p className="text-xs mt-2 opacity-70">Make sure the Local Nexus backend is running.</p>
          </div>
        )}

        {loading ? (
          <div className="flex h-64 items-center justify-center">
            <Activity className="animate-spin text-cyan-500" size={32} />
          </div>
        ) : sortedProjects.length === 0 && !error ? (
          <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-slate-800 py-20 text-center">
            <div className="rounded-full bg-slate-900 p-4 text-slate-500">
              <Folder size={32} />
            </div>
            <h3 className="mt-4 text-lg font-semibold text-slate-300">No Projects Found</h3>
            <p className="mt-2 text-sm text-slate-500">
              Scanned path: <code className="rounded bg-slate-900 px-1 py-0.5">$PROJECT_ROOT</code> — set this in your <code className="rounded bg-slate-900 px-1 py-0.5">.env</code> file
            </p>
          </div>
        ) : (
          <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
            {/* Projects Grid */}
            <div className="grid gap-6 sm:grid-cols-2 xl:grid-cols-3">
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

            {/* Initiatives + Activity Sidebar */}
            <div className="lg:sticky lg:top-24 lg:h-fit space-y-6">
              <AntigravityMonitor />
              <DashboardInitiatives onRefresh={loadData} />
              <ActivityFeed />
            </div>
          </div>
        )}
      </div>

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

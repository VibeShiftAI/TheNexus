"use client"

import { useState, useEffect } from "react";
import { X, BookOpen, Gauge, Zap, FolderGit2, Settings, Cpu, WifiOff, Route, BrainCircuit, BarChart3, KanbanSquare } from "lucide-react";
import Link from "next/link";
import { getProjects, type Project } from "@/lib/nexus";
import { getLocalOnlyMode, setLocalOnlyMode } from "@/lib/model-control";
import { ModelAliasManager } from "@/components/model-alias-manager";

interface NavSidebarProps {
  isOpen: boolean;
  onClose: () => void;
  onOpenSettings: () => void;
}

export function NavSidebar({ isOpen, onClose, onOpenSettings }: NavSidebarProps) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [localOnly, setLocalOnly] = useState<{ enabled: boolean; reason: string | null }>({ enabled: false, reason: null });

  // Fetch projects list
  useEffect(() => {
    let active = true;
    getProjects()
      .then((data) => {
        if (active) {
          setProjects(data || []);
          setLoading(false);
        }
      })
      .catch((err) => {
        console.error("Failed to load projects inside NavSidebar:", err);
        if (active) {
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    getLocalOnlyMode()
      .then(setLocalOnly)
      .catch((err) => console.warn("Failed to load local-only mode:", err.message));
  }, []);

  const toggleLocalOnly = async () => {
    const next = !localOnly.enabled;
    const reason = next ? (localOnly.reason || "manual_override") : null;
    const updated = await setLocalOnlyMode(next, reason);
    setLocalOnly(updated);
  };

  // Listen for Escape key press to close sidebar
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, onClose]);

  const larsDashboardHref = "http://192.168.86.205:7878";

  const navItems = [
    { href: "/task-board", label: "Task Board", icon: KanbanSquare, color: "text-cyan-400 hover:text-cyan-300" },
    { href: "/model-control", label: "Model Control", icon: Route, color: "text-cyan-400 hover:text-cyan-300" },
    { href: "/system-monitor", label: "System Monitor", icon: Gauge, color: "text-amber-400 hover:text-amber-300" },
    { href: "/workflow-builder", label: "Workflow Builder", icon: Zap, color: "text-indigo-400 hover:text-indigo-300" },
    { href: larsDashboardHref, label: "LARS Dashboard", icon: BarChart3, color: "text-emerald-400 hover:text-emerald-300", external: true },
    { href: "/codex", label: "The Codex", icon: BookOpen, color: "text-pink-400 hover:text-pink-300" },
    { href: "/knowledge-ingestion", label: "Knowledge Ingestion", icon: BrainCircuit, color: "text-violet-400 hover:text-violet-300" },
  ];

  return (
    <div className={`fixed inset-0 z-50 overflow-hidden transition-all duration-300 ${isOpen ? 'visible' : 'delay-300 invisible'}`}>
      {/* Backdrop overlay */}
      <div 
        className={`absolute inset-0 bg-slate-950/60 backdrop-blur-sm transition-opacity duration-300 ${isOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'}`}
        onClick={onClose}
      />

      <div className="absolute inset-y-0 right-0 pl-10 max-w-full flex">
        <div 
          role="dialog"
          aria-modal="true"
          className={`w-screen max-w-md bg-slate-900 border-l border-slate-800 text-slate-200 p-6 flex flex-col justify-between shadow-2xl transform transition-transform duration-300 ease-in-out ${isOpen ? 'translate-x-0' : 'translate-x-full'}`}
        >
          <div>
            <div className="flex items-center justify-between pb-6 border-b border-slate-800">
              <h2 className="text-lg font-bold text-white tracking-tight">THE NEXUS MENU</h2>
              <button onClick={onClose} className="p-1 rounded-lg hover:bg-slate-800 transition-colors">
                <X size={20} className="text-slate-400 hover:text-white" />
              </button>
            </div>

            <nav className="mt-8 space-y-4">
              {navItems.map((item) => {
                const className = `flex items-center gap-3 px-4 py-3 rounded-lg border border-slate-800 bg-slate-950/40 hover:bg-slate-950/80 transition-all ${item.color}`;

                if (item.external) {
                  return (
                    <a
                      key={item.href}
                      href={item.href}
                      target="_blank"
                      rel="noreferrer"
                      onClick={onClose}
                      className={className}
                    >
                      <item.icon size={18} />
                      <span className="font-medium">{item.label}</span>
                    </a>
                  );
                }

                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={onClose}
                    className={className}
                  >
                    <item.icon size={18} />
                    <span className="font-medium">{item.label}</span>
                  </Link>
                );
              })}
            </nav>

            <div className={`mt-6 rounded-lg border p-3 ${localOnly.enabled ? 'border-amber-500/40 bg-amber-500/10' : 'border-slate-800 bg-slate-950/40'}`}>
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 min-w-0">
                  {localOnly.enabled ? <WifiOff size={16} className="text-amber-300" /> : <Cpu size={16} className="text-slate-400" />}
                  <div className="min-w-0">
                    <div className={`text-sm font-medium ${localOnly.enabled ? 'text-amber-200' : 'text-slate-300'}`}>Local Only</div>
                    <div className="truncate text-xs text-slate-500">{localOnly.enabled ? (localOnly.reason || 'manual_override') : 'Cloud enabled'}</div>
                  </div>
                </div>
                <button
                  onClick={toggleLocalOnly}
                  className={`h-6 w-11 rounded-full border p-0.5 transition-colors ${localOnly.enabled ? 'border-amber-400/50 bg-amber-400/30' : 'border-slate-700 bg-slate-800'}`}
                  aria-pressed={localOnly.enabled}
                  aria-label="Toggle local-only mode"
                >
                  <span className={`block h-4 w-4 rounded-full bg-white transition-transform ${localOnly.enabled ? 'translate-x-5' : 'translate-x-0'}`} />
                </button>
              </div>
            </div>

            <div className="mt-3">
              <ModelAliasManager compact />
            </div>

            {/* Active Projects Section */}
            <div className="mt-8">
              <div className="flex items-center gap-2 px-2 pb-2 text-xs font-semibold text-slate-500 uppercase tracking-wider border-b border-slate-800">
                <FolderGit2 size={12} className="text-slate-500" />
                <span>Active Projects</span>
              </div>
              <div className="mt-3 space-y-2 max-h-[40vh] overflow-y-auto pr-1 scrollbar-thin">
                {loading ? (
                  <div className="flex items-center justify-center py-4 text-xs text-slate-500">
                    <div className="animate-spin h-3 w-3 border border-slate-500 border-t-transparent rounded-full mr-2" />
                    Loading projects...
                  </div>
                ) : projects.length === 0 ? (
                  <div className="text-xs text-slate-600 px-2 py-4">No active projects</div>
                ) : (
                  projects.map((project) => (
                    <Link
                      key={project.id}
                      href={`/project/${project.id}`}
                      onClick={onClose}
                      className="group flex items-center justify-between px-3 py-2 rounded-lg border border-slate-800/40 bg-slate-950/20 hover:bg-slate-950/60 hover:border-slate-800 transition-all"
                    >
                      <div className="flex items-center gap-2.5 truncate">
                        <div className="w-1.5 h-1.5 rounded-full bg-cyan-400 group-hover:bg-cyan-300 group-hover:scale-110 transition-all" />
                        <span className="text-sm font-medium text-slate-400 group-hover:text-white transition-colors truncate">
                          {project.name}
                        </span>
                      </div>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-500 group-hover:text-slate-400 uppercase tracking-wider font-mono">
                        {project.type}
                      </span>
                    </Link>
                  ))
                )}
              </div>
            </div>
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

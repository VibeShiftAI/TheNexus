"use client";

import { useState, useEffect, useCallback } from "react";
import {
    getDashboardInitiatives,
    createDashboardInitiative,
    updateDashboardInitiative,
    deleteDashboardInitiative,
    runDashboardInitiative,
    getProjects,
    DashboardInitiative,
    InitiativeType,
    Project,
} from "@/lib/nexus";
import {
    Target,
    Plus,
    Play,
    Trash2,
    CheckCircle,
    Clock,
    AlertCircle,
    XCircle,
    ChevronDown,
    ChevronUp,
    Loader2,
    Rocket,
    Shield,
    Package,
    FileText,
} from "lucide-react";

// Initiative type icons and colors
const INITIATIVE_CONFIG: Record<string, { icon: React.ComponentType<{ className?: string; size?: number }>; color: string }> = {
    "security-sweep": { icon: Shield, color: "text-red-400" },
    "dependency-audit": { icon: Package, color: "text-amber-400" },
    "documentation": { icon: FileText, color: "text-blue-400" },
    "custom": { icon: Rocket, color: "text-purple-400" },
};

const STATUS_CONFIG: Record<string, { icon: React.ComponentType<{ className?: string; size?: number }>; color: string; bg: string }> = {
    "idea": { icon: Clock, color: "text-slate-400", bg: "bg-slate-500/20" },
    "planning": { icon: Clock, color: "text-blue-400", bg: "bg-blue-500/20" },
    "in_progress": { icon: Loader2, color: "text-cyan-400", bg: "bg-cyan-500/20" },
    "paused": { icon: AlertCircle, color: "text-amber-400", bg: "bg-amber-500/20" },
    "complete": { icon: CheckCircle, color: "text-emerald-400", bg: "bg-emerald-500/20" },
    "cancelled": { icon: XCircle, color: "text-red-400", bg: "bg-red-500/20" },
};

interface DashboardInitiativesProps {
    onRefresh?: () => void;
}

export function DashboardInitiatives({ onRefresh }: DashboardInitiativesProps) {
    const [initiatives, setInitiatives] = useState<DashboardInitiative[]>([]);
    const [projects, setProjects] = useState<Project[]>([]);
    const [loading, setLoading] = useState(true);
    const [expanded, setExpanded] = useState(true);
    const [showCreateModal, setShowCreateModal] = useState(false);
    const [runningId, setRunningId] = useState<string | null>(null);

    const loadData = useCallback(async () => {
        try {
            const [initiativesData, projectsData] = await Promise.all([
                getDashboardInitiatives(),
                getProjects(),
            ]);
            setInitiatives(initiativesData.initiatives || []);
            setProjects(projectsData || []);
        } catch (err) {
            console.error("[DashboardInitiatives] Failed to load:", err);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        loadData();
    }, [loadData]);

    const handleRun = async (id: string) => {
        setRunningId(id);
        try {
            await runDashboardInitiative(id);
            await loadData();
            onRefresh?.();
        } catch (err) {
            console.error("[DashboardInitiatives] Failed to run:", err);
        } finally {
            setRunningId(null);
        }
    };

    const handleDelete = async (id: string) => {
        if (!confirm("Delete this initiative?")) return;
        try {
            await deleteDashboardInitiative(id);
            await loadData();
        } catch (err) {
            console.error("[DashboardInitiatives] Failed to delete:", err);
        }
    };

    const handleCreate = async (data: { name: string; description: string; workflow_type: InitiativeType; target_projects: string[] }) => {
        try {
            await createDashboardInitiative(data);
            await loadData();
            setShowCreateModal(false);
        } catch (err) {
            console.error("[DashboardInitiatives] Failed to create:", err);
        }
    };

    // Only show active initiatives (not complete/cancelled)
    const activeInitiatives = initiatives.filter(i => !["complete", "cancelled"].includes(i.status));
    const hasInitiatives = activeInitiatives.length > 0;

    return (
        <div>
            {/* Header */}
            <div className="flex items-center justify-between mb-3">
                <button
                    onClick={() => setExpanded(!expanded)}
                    className="flex items-center gap-2 group"
                >
                    <Target className="text-orange-400" size={16} />
                    <h2 className="text-sm font-semibold text-white group-hover:text-orange-400 transition-colors">
                        Initiatives
                    </h2>
                    <span className="text-xs text-slate-500 bg-slate-800 px-1.5 py-0.5 rounded-full">
                        {activeInitiatives.length}
                    </span>
                    {expanded ? (
                        <ChevronUp size={14} className="text-slate-500" />
                    ) : (
                        <ChevronDown size={14} className="text-slate-500" />
                    )}
                </button>
                <button
                    onClick={() => setShowCreateModal(true)}
                    className="flex items-center gap-1 px-2 py-1 rounded-lg bg-gradient-to-r from-orange-500/20 to-amber-500/20 border border-orange-500/30 hover:border-orange-500/50 transition-all text-orange-400 hover:text-orange-300 text-xs"
                >
                    <Plus size={12} />
                    <span>New</span>
                </button>
            </div>

            {/* Content */}
            {expanded && (
                <div className="space-y-3">
                    {loading ? (
                        <div className="flex items-center justify-center py-8">
                            <Loader2 className="animate-spin text-orange-400" size={24} />
                        </div>
                    ) : !hasInitiatives ? (
                        <div className="border border-dashed border-slate-700 rounded-lg py-4 text-center">
                            <Target className="mx-auto text-slate-600 mb-1" size={24} />
                            <p className="text-slate-500 text-xs">No active initiatives</p>
                        </div>
                    ) : (
                        <div className="space-y-2">
                            {activeInitiatives.map((initiative) => (
                                <InitiativeCard
                                    key={initiative.id}
                                    initiative={initiative}
                                    projects={projects}
                                    isRunning={runningId === initiative.id}
                                    onRun={() => handleRun(initiative.id)}
                                    onDelete={() => handleDelete(initiative.id)}
                                />
                            ))}
                        </div>
                    )}
                </div>
            )}

            {/* Create Modal */}
            {showCreateModal && (
                <CreateInitiativeModal
                    projects={projects}
                    onClose={() => setShowCreateModal(false)}
                    onCreate={handleCreate}
                />
            )}
        </div>
    );
}

// Individual initiative card
interface InitiativeCardProps {
    initiative: DashboardInitiative;
    projects: Project[];
    isRunning: boolean;
    onRun: () => void;
    onDelete: () => void;
}

function InitiativeCard({ initiative, projects, isRunning, onRun, onDelete }: InitiativeCardProps) {
    const typeConfig = INITIATIVE_CONFIG[initiative.workflow_type] || INITIATIVE_CONFIG.custom;
    const statusConfig = STATUS_CONFIG[initiative.status] || STATUS_CONFIG.idea;
    const Icon = typeConfig.icon;
    const StatusIcon = statusConfig.icon;

    // Calculate progress
    const targetProjects = initiative.target_projects || [];
    const progress = initiative.progress || {};
    const completedCount = Object.values(progress).filter((p: unknown) => (p as { status?: string })?.status === "complete").length;
    const progressPercent = targetProjects.length > 0 ? Math.round((completedCount / targetProjects.length) * 100) : 0;

    return (
        <div className="bg-slate-900/50 border border-slate-800 rounded-lg p-4 hover:border-slate-700 transition-colors">
            {/* Header */}
            <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-2">
                    <Icon className={typeConfig.color} size={18} />
                    <span className="font-medium text-white text-sm truncate max-w-[140px]">
                        {initiative.name}
                    </span>
                </div>
                <div className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-xs ${statusConfig.bg} ${statusConfig.color}`}>
                    <StatusIcon size={12} className={initiative.status === "in_progress" ? "animate-spin" : ""} />
                    <span className="capitalize">{initiative.status.replace("_", " ")}</span>
                </div>
            </div>

            {/* Description */}
            {initiative.description && (
                <p className="text-slate-400 text-xs mb-3 line-clamp-2">{initiative.description}</p>
            )}

            {/* Progress */}
            <div className="mb-3">
                <div className="flex items-center justify-between text-xs mb-1">
                    <span className="text-slate-500">{targetProjects.length} projects targeted</span>
                    <span className="text-cyan-400">{progressPercent}%</span>
                </div>
                <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden">
                    <div
                        className="h-full bg-gradient-to-r from-cyan-500 to-emerald-500 transition-all"
                        style={{ width: `${progressPercent}%` }}
                    />
                </div>
            </div>

            {/* Actions */}
            <div className="flex items-center gap-2">
                {initiative.status !== "complete" && initiative.status !== "cancelled" && (
                    <button
                        onClick={onRun}
                        disabled={isRunning}
                        className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded bg-cyan-500/20 border border-cyan-500/30 text-cyan-400 hover:bg-cyan-500/30 transition-colors text-xs disabled:opacity-50"
                    >
                        {isRunning ? (
                            <Loader2 size={12} className="animate-spin" />
                        ) : (
                            <Play size={12} />
                        )}
                        <span>{isRunning ? "Running..." : "Run"}</span>
                    </button>
                )}
                <button
                    onClick={onDelete}
                    className="p-1.5 rounded text-slate-500 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                >
                    <Trash2 size={14} />
                </button>
            </div>
        </div>
    );
}

// Create initiative modal
interface CreateInitiativeModalProps {
    projects: Project[];
    onClose: () => void;
    onCreate: (data: { name: string; description: string; workflow_type: InitiativeType; target_projects: string[] }) => void;
}

function CreateInitiativeModal({ projects, onClose, onCreate }: CreateInitiativeModalProps) {
    const [name, setName] = useState("");
    const [description, setDescription] = useState("");
    const [workflowType, setWorkflowType] = useState<InitiativeType>("security-sweep");
    const [selectedProjects, setSelectedProjects] = useState<string[]>([]);
    const [creating, setCreating] = useState(false);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!name.trim()) return;

        setCreating(true);
        await onCreate({
            name,
            description,
            workflow_type: workflowType,
            target_projects: selectedProjects.length > 0 ? selectedProjects : projects.map(p => p.id),
        });
        setCreating(false);
    };

    const toggleProject = (id: string) => {
        setSelectedProjects(prev =>
            prev.includes(id) ? prev.filter(p => p !== id) : [...prev, id]
        );
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
            <div className="bg-slate-900 border border-slate-700 rounded-lg w-full max-w-lg p-6">
                <h3 className="text-lg font-semibold text-white mb-4">Create Dashboard Initiative</h3>

                <form onSubmit={handleSubmit} className="space-y-4">
                    {/* Name */}
                    <div>
                        <label className="block text-sm text-slate-400 mb-1">Name</label>
                        <input
                            type="text"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder="e.g., Q1 Security Audit"
                            className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-cyan-500"
                            autoFocus
                        />
                    </div>

                    {/* Description */}
                    <div>
                        <label className="block text-sm text-slate-400 mb-1">Description</label>
                        <textarea
                            value={description}
                            onChange={(e) => setDescription(e.target.value)}
                            placeholder="Brief description of this initiative..."
                            rows={2}
                            className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-cyan-500 resize-none"
                        />
                    </div>

                    {/* Type */}
                    <div>
                        <label className="block text-sm text-slate-400 mb-1">Type</label>
                        <select
                            value={workflowType}
                            onChange={(e) => setWorkflowType(e.target.value as InitiativeType)}
                            className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-cyan-500"
                        >
                            <option value="security-sweep">Security Sweep</option>
                            <option value="dependency-audit">Dependency Audit</option>
                            <option value="documentation">Documentation Update</option>
                            <option value="custom">Custom Initiative</option>
                        </select>
                    </div>

                    {/* Target Projects */}
                    <div>
                        <label className="block text-sm text-slate-400 mb-1">
                            Target Projects ({selectedProjects.length || "All"})
                        </label>
                        <div className="max-h-32 overflow-y-auto bg-slate-800 border border-slate-700 rounded p-2 space-y-1">
                            {projects.map((project) => (
                                <label
                                    key={project.id}
                                    className="flex items-center gap-2 px-2 py-1 rounded hover:bg-slate-700 cursor-pointer"
                                >
                                    <input
                                        type="checkbox"
                                        checked={selectedProjects.includes(project.id)}
                                        onChange={() => toggleProject(project.id)}
                                        className="accent-cyan-500"
                                    />
                                    <span className="text-sm text-slate-300">{project.name}</span>
                                </label>
                            ))}
                            {projects.length === 0 && (
                                <p className="text-slate-500 text-xs text-center py-2">No projects available</p>
                            )}
                        </div>
                        <p className="text-xs text-slate-500 mt-1">Leave empty to target all projects</p>
                    </div>

                    {/* Actions */}
                    <div className="flex items-center justify-end gap-3 pt-2">
                        <button
                            type="button"
                            onClick={onClose}
                            className="px-4 py-2 text-sm text-slate-400 hover:text-white transition-colors"
                        >
                            Cancel
                        </button>
                        <button
                            type="submit"
                            disabled={!name.trim() || creating}
                            className="flex items-center gap-2 px-4 py-2 rounded bg-gradient-to-r from-orange-500 to-amber-500 text-white text-sm font-medium hover:from-orange-600 hover:to-amber-600 transition-colors disabled:opacity-50"
                        >
                            {creating ? (
                                <Loader2 size={14} className="animate-spin" />
                            ) : (
                                <Plus size={14} />
                            )}
                            <span>{creating ? "Creating..." : "Create Initiative"}</span>
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}

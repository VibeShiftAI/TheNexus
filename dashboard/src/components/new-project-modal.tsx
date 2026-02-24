"use client"

import { useState } from "react";
import { X, Rocket, Zap, ArrowRight, ArrowLeft, Check, Sparkles, Target, Palette, Box, Layers, AlertTriangle } from "lucide-react";
import { scaffoldProject, validateInitiative } from "@/lib/nexus";

interface NewProjectModalProps {
    isOpen: boolean;
    onClose: () => void;
    onSuccess: () => void;
}

type Step = "concept" | "design" | "tech" | "review";

interface FormData {
    // Basics (Now inferred or late-stage)
    name: string;
    type: "web-app" | "game" | "tool";
    description: string;

    // Concept
    coreIdea: string;
    targetAudience: string[];
    primaryGoals: string[];

    // Design
    tone: string;
    aesthetic: string;
    aiInteraction: string;

    // Tech
    techStack: string; // "default" or custom
    tasks: string[];
}

const INITIAL_DATA: FormData = {
    name: "",
    type: "web-app",
    description: "",
    coreIdea: "",
    targetAudience: [],
    primaryGoals: [],
    tone: "Professional & Technical",
    aesthetic: "Clean & Minimalist",
    aiInteraction: "Collaborator / Peer",
    techStack: "default",
    tasks: []
};

const AUDIENCES = [
    "Solo Developer / Indie Hacker",
    "Business / Enterprise",
    "General Consumers",
    "Technical/Power Users"
];

const GOALS = [
    "Solve a specific problem",
    "Generate revenue / SaaS",
    "Portfolio / Learning project",
    "Internal tool"
];

const TONES = [
    "Professional & Technical",
    "Friendly & Encouraging",
    "Futuristic & Cyberpunk",
    "Minimal & Clean"
];

const AESTHETICS = [
    "Clean & Minimalist",
    "High-Density Dashboard",
    "Cyberpunk / Neon",
    "Playful & Colorful",
    "Corporate / Professional"
];

const INTERACTIONS = [
    "Servant / Assistant",
    "Collaborator / Peer",
    "System AI / OS Interface",
    "Not applicable"
];

export function NewProjectModal({ isOpen, onClose, onSuccess }: NewProjectModalProps) {
    const [step, setStep] = useState<Step>("concept");
    const [data, setData] = useState<FormData>(INITIAL_DATA);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [customTask, setCustomTask] = useState("");

    if (!isOpen) return null;

    const updateData = (key: keyof FormData, value: any) => {
        setData(prev => ({ ...prev, [key]: value }));
    };

    const toggleArrayItem = (key: keyof FormData, item: string) => {
        setData(prev => {
            const current = prev[key] as string[];
            if (current.includes(item)) {
                return { ...prev, [key]: current.filter(i => i !== item) };
            } else {
                return { ...prev, [key]: [...current, item] };
            }
        });
    };

    const handleTaskAdd = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && customTask.trim()) {
            e.preventDefault();
            setData(prev => ({ ...prev, tasks: [...prev.tasks, customTask.trim()] }));
            setCustomTask("");
        }
    };

    const removeTask = (index: number) => {
        setData(prev => ({ ...prev, tasks: prev.tasks.filter((_, i) => i !== index) }));
    };

    const handleSubmit = async () => {
        setError(null);
        setLoading(true);

        try {
            await scaffoldProject(data.name, data.type, {
                description: data.description,
                conductor: {
                    concept: data.coreIdea,
                    audience: data.targetAudience,
                    goals: data.primaryGoals,
                    tone: data.tone,
                    aesthetic: data.aesthetic,
                    aiInteraction: data.aiInteraction,
                    tasks: data.tasks
                }
            });
            setData(INITIAL_DATA);
            setStep("concept");
            onSuccess();
            onClose();
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to create project");
        } finally {
            setLoading(false);
        }
    };

    const nextStep = async () => {
        const order: Step[] = ["concept", "design", "tech", "review"];
        const currentIndex = order.indexOf(step);

        if (step === 'concept' && data.coreIdea) {
            setLoading(true);
            try {
                const validation = await validateInitiative(data.coreIdea, "New Project Concept");

                if (validation.requiresClarification) {
                    setError(`Clarification Needed: ${validation.reasoning}`);
                    setLoading(false);
                    return; // Block progress
                }

                if (validation.classification === 'BUG') {
                    // Just a warning, let them proceed if they really want
                    if (!confirm(`Wait, this sounds like a bug report: "${validation.reasoning}". Are you sure you want to create a whole new LOCAL PROJECT for this?`)) {
                        setLoading(false);
                        return;
                    }
                }

                if (validation.classification === 'QUESTION') {
                    if (!confirm(`This sounds like a question: "${validation.reasoning}". Do you want to proceed with creating a project?`)) {
                        setLoading(false);
                        return;
                    }
                }

            } catch (err) {
                console.warn("Validation failed, proceeding anyway", err);
            } finally {
                setLoading(false);
            }
        }

        if (currentIndex < order.length - 1) {
            setStep(order[currentIndex + 1]);
        }
    };

    const prevStep = () => {
        const order: Step[] = ["concept", "design", "tech", "review"];
        const currentIndex = order.indexOf(step);
        if (currentIndex > 0) {
            setStep(order[currentIndex - 1]);
        }
    };

    // Auto-generate name from idea if empty
    const generateNameFromIdea = (idea: string) => {
        if (!idea) return "my-awesome-project";
        // Simple heuristic: take first 3 words, lowercase, dasherize
        const slug = idea.split(" ").slice(0, 3).join("-").toLowerCase().replace(/[^a-z0-9-]/g, "");
        return slug || "project-" + Date.now();
    };

    const renderStepContent = () => {
        switch (step) {
            case "concept":
                return (
                    <div className="space-y-6">
                        <div className="text-center space-y-2 mb-8">
                            <h3 className="text-lg font-medium text-white">What are we building?</h3>
                            <p className="text-sm text-slate-400">Describe your idea, even if it's just a rough thought.</p>
                        </div>

                        <div>
                            <textarea
                                value={data.coreIdea}
                                onChange={(e) => updateData("coreIdea", e.target.value)}
                                placeholder="e.g. A personal finance tracker that gamifies saving money..."
                                className="w-full rounded-xl border border-slate-700 bg-slate-800/50 px-6 py-4 text-lg text-white placeholder-slate-500 focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500 h-40 resize-none shadow-inner"
                                autoFocus
                            />
                        </div>

                        <div className="pt-4">
                            <label className="block text-sm font-medium text-slate-400 mb-2">
                                <span className="flex items-center gap-2">Target Audience (Optional)</span>
                            </label>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                {AUDIENCES.map((a) => (
                                    <button
                                        key={a}
                                        onClick={() => toggleArrayItem("targetAudience", a)}
                                        className={`text-left rounded-lg border px-3 py-2 text-xs font-medium transition-all ${data.targetAudience.includes(a)
                                            ? "border-cyan-500 bg-cyan-500/20 text-cyan-400"
                                            : "border-slate-700 bg-slate-800 text-slate-400 hover:border-slate-600"
                                            }`}
                                    >
                                        {data.targetAudience.includes(a) && <Check size={12} className="inline mr-1" />}
                                        {a}
                                    </button>
                                ))}
                            </div>
                        </div>
                    </div>
                );
            case "design":
                return (
                    <div className="space-y-6">
                        <div>
                            <label className="block text-sm font-medium text-slate-400 mb-2">Visual Aesthetic</label>
                            <div className="space-y-2">
                                {AESTHETICS.map(a => (
                                    <button
                                        key={a}
                                        onClick={() => updateData("aesthetic", a)}
                                        className={`w-full text-left rounded-lg border px-4 py-3 text-sm transition-all flex items-center justify-between ${data.aesthetic === a
                                            ? "border-pink-500 bg-pink-500/10 text-pink-300"
                                            : "border-slate-700 bg-slate-800 text-slate-400 hover:border-slate-600"
                                            }`}
                                    >
                                        {a}
                                        {data.aesthetic === a && <Check size={16} />}
                                    </button>
                                ))}
                            </div>
                        </div>
                        <div>
                            <label className="block text-sm font-medium text-slate-400 mb-2">Tone of Voice</label>
                            <div className="space-y-2">
                                {TONES.map(t => (
                                    <button
                                        key={t}
                                        onClick={() => updateData("tone", t)}
                                        className={`w-full text-left rounded-lg border px-4 py-3 text-sm transition-all flex items-center justify-between ${data.tone === t
                                            ? "border-purple-500 bg-purple-500/10 text-purple-300"
                                            : "border-slate-700 bg-slate-800 text-slate-400 hover:border-slate-600"
                                            }`}
                                    >
                                        {t}
                                        {data.tone === t && <Check size={16} />}
                                    </button>
                                ))}
                            </div>
                        </div>
                    </div>
                );
            case "tech":
                return (
                    <div className="space-y-6">
                        <div className="bg-slate-950/30 p-4 rounded-lg border border-slate-800 mb-6">
                            <h4 className="text-sm font-medium text-white mb-4 flex items-center gap-2">
                                <Box size={16} className="text-cyan-400" />
                                Project Structure
                            </h4>
                            <div className="space-y-4">
                                <div>
                                    <label className="block text-xs font-medium text-slate-500 mb-1.5 uppercase tracking-wider">Project Name (ID)</label>
                                    <div className="flex gap-2">
                                        <input
                                            type="text"
                                            value={data.name}
                                            onChange={(e) => updateData("name", e.target.value)}
                                            placeholder={generateNameFromIdea(data.coreIdea)}
                                            className="flex-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white placeholder-slate-600 focus:border-cyan-500 focus:outline-none"
                                            pattern="^[a-zA-Z0-9-_]+$"
                                        />
                                        <button
                                            onClick={() => updateData("name", generateNameFromIdea(data.coreIdea))}
                                            className="px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-slate-400 hover:text-white"
                                            title="Auto-generate name"
                                        >
                                            <Sparkles size={16} />
                                        </button>
                                    </div>
                                    <p className="text-[10px] text-slate-600 mt-1">This will be your folder name.</p>
                                </div>

                                <div>
                                    <label className="block text-xs font-medium text-slate-500 mb-1.5 uppercase tracking-wider">Project Type</label>
                                    <div className="grid grid-cols-3 gap-2">
                                        {(["web-app", "game", "tool"] as const).map((t) => (
                                            <button
                                                key={t}
                                                onClick={() => updateData("type", t)}
                                                className={`rounded-lg border px-3 py-2 text-xs font-medium transition-all ${data.type === t
                                                    ? "border-cyan-500 bg-cyan-500/20 text-cyan-400"
                                                    : "border-slate-700 bg-slate-800 text-slate-400 hover:border-slate-600"
                                                    }`}
                                            >
                                                {t}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            </div>
                        </div>

                        <div>
                            <label className="block text-sm font-medium text-slate-400 mb-2">Key Tasks Needed</label>
                            <div className="flex gap-2 mb-2">
                                <input
                                    type="text"
                                    value={customTask}
                                    onChange={(e) => setCustomTask(e.target.value)}
                                    onKeyDown={handleTaskAdd}
                                    placeholder="Add a task..."
                                    className="flex-1 rounded-lg border border-slate-700 bg-slate-800 px-4 py-2 text-white placeholder-slate-500 focus:border-cyan-500 focus:outline-none"
                                />
                                <button
                                    onClick={() => {
                                        if (customTask.trim()) {
                                            setData(prev => ({ ...prev, tasks: [...prev.tasks, customTask.trim()] }));
                                            setCustomTask("");
                                        }
                                    }}
                                    className="px-3 py-2 bg-slate-700 hover:bg-slate-600 rounded-lg text-white"
                                >
                                    <Plus size={18} />
                                </button>
                            </div>
                            <div className="flex flex-wrap gap-2">
                                {data.tasks.map((f, i) => (
                                    <div key={i} className="flex items-center gap-1 bg-slate-800 border border-slate-700 rounded-full px-3 py-1 text-sm text-slate-300">
                                        {f}
                                        <button onClick={() => removeTask(i)} className="text-slate-500 hover:text-red-400">
                                            <X size={14} />
                                        </button>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>
                );
            case "review":
                return (
                    <div className="space-y-4">
                        <div className="bg-slate-950/50 rounded-lg p-4 border border-slate-800 space-y-3">
                            <div className="flex items-center justify-between">
                                <h4 className="text-xs uppercase tracking-wider text-slate-500 font-bold">Project Identity</h4>
                                <span className={`text-[10px] px-2 py-0.5 rounded-full border ${data.type === 'web-app' ? 'border-cyan-500/30 text-cyan-400' : 'border-purple-500/30 text-purple-400'}`}>{data.type}</span>
                            </div>
                            <div>
                                <div className="text-white font-medium text-lg">{data.name || <span className="text-slate-500 italic">Untitled Project</span>}</div>
                                <div className="text-sm text-slate-400 mt-1">{data.coreIdea || "No concept provided."}</div>
                            </div>

                            <div className="h-px bg-slate-800 my-2" />

                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <h4 className="text-xs uppercase tracking-wider text-slate-500 font-bold mb-1">Aesthetic</h4>
                                    <div className="text-sm text-pink-400">{data.aesthetic}</div>
                                </div>
                                <div>
                                    <h4 className="text-xs uppercase tracking-wider text-slate-500 font-bold mb-1">Tone</h4>
                                    <div className="text-sm text-purple-400">{data.tone}</div>
                                </div>
                            </div>
                        </div>

                        {!data.name && (
                            <div className="flex items-start gap-3 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-200 text-sm">
                                <Zap size={16} className="mt-0.5" />
                                <div>
                                    <p className="font-medium">Project Name Missing</p>
                                    <p className="opacity-80">We'll generate one for you: <code className="bg-amber-900/40 px-1 rounded">{generateNameFromIdea(data.coreIdea)}</code></p>
                                </div>
                            </div>
                        )}
                    </div>
                );
        }
    };

    const isNextDisabled = () => {
        // Idea is required to proceed from step 1
        if (step === "concept") return !data.coreIdea;
        return false;
    };

    // Use generated name if blank on submit
    const finalSubmit = async () => {
        const finalName = data.name || generateNameFromIdea(data.coreIdea);
        // Only update state if needed, but for now just pass to submit
        const submissionData = { ...data, name: finalName };

        setError(null);
        setLoading(true);

        try {
            await scaffoldProject(submissionData.name, submissionData.type, {
                description: submissionData.description || submissionData.coreIdea, // Use idea as desc if desc blank
                conductor: {
                    concept: submissionData.coreIdea,
                    audience: submissionData.targetAudience,
                    goals: submissionData.primaryGoals,
                    tone: submissionData.tone,
                    aesthetic: submissionData.aesthetic,
                    aiInteraction: submissionData.aiInteraction,
                    tasks: submissionData.tasks
                }
            });
            setData(INITIAL_DATA);
            setStep("concept"); // Reset to start
            onSuccess();
            onClose();
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to create project");
            setLoading(false);
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
            {/* Backdrop */}
            <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" onClick={onClose} />

            {/* Modal */}
            <div className="relative z-10 w-full max-w-2xl rounded-xl border border-slate-700 bg-slate-900 shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
                {/* Header */}
                <div className="border-b border-slate-800 bg-slate-900/50 p-6 flex flex-col gap-4">
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                            <div className="rounded-lg bg-gradient-to-br from-cyan-500 to-purple-500 p-2">
                                <Rocket size={24} className="text-white" />
                            </div>
                            <div>
                                <h2 className="text-xl font-bold text-white">New Project Workflow</h2>
                                <p className="text-xs text-slate-400">Step {["concept", "design", "tech", "review"].indexOf(step) + 1} of 4</p>
                            </div>
                        </div>
                        <button onClick={onClose} className="text-slate-500 hover:text-white transition-colors">
                            <X size={20} />
                        </button>
                    </div>

                    {/* Progress Bar */}
                    <div className="flex gap-2">
                        {(["concept", "design", "tech", "review"] as const).map((s, i) => {
                            const currentIdx = ["concept", "design", "tech", "review"].indexOf(step);
                            const isActive = i <= currentIdx;
                            return (
                                <div key={s} className={`h-1 flex-1 rounded-full transition-all ${isActive ? "bg-cyan-500" : "bg-slate-800"}`} />
                            );
                        })}
                    </div>
                </div>

                {/* Content */}
                <div className="p-6 overflow-y-auto flex-1">
                    {renderStepContent()}

                    {error && (
                        <div className="mt-4 rounded-lg border border-red-500/50 bg-red-500/10 px-4 py-2 text-sm text-red-400">
                            {error}
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div className="border-t border-slate-800 bg-slate-900/50 p-6 flex justify-between">
                    <button
                        onClick={prevStep}
                        disabled={step === "concept" || loading}
                        className={`flex items-center gap-2 px-4 py-2 rounded-lg text-slate-400 hover:text-white transition-colors ${step === "concept" ? "invisible" : ""}`}
                    >
                        <ArrowLeft size={18} />
                        Back
                    </button>

                    {step === "review" ? (
                        <button
                            onClick={finalSubmit}
                            disabled={loading}
                            className="flex items-center gap-2 rounded-lg bg-gradient-to-r from-cyan-500 to-purple-500 px-6 py-2 font-medium text-white hover:from-cyan-600 hover:to-purple-600 transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-cyan-500/20"
                        >
                            {loading ? <Zap size={18} className="animate-spin" /> : <Rocket size={18} />}
                            <span>{loading ? "Ignition..." : "Launch Project"}</span>
                        </button>
                    ) : (
                        <button
                            onClick={nextStep}
                            disabled={isNextDisabled()}
                            className="flex items-center gap-2 rounded-lg bg-slate-800 border border-slate-700 px-6 py-2 font-medium text-white hover:bg-slate-700 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            Next
                            <ArrowRight size={18} />
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}

// Helper icons needed but not imported in top import line
import { Plus } from "lucide-react";

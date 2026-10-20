"use client"

import { Breadcrumbs } from "@/components/breadcrumbs";
import { AgentManager } from "@/components/agent-manager";
import { Brain } from "lucide-react";

export default function AgentsPage() {
    return (
        <main className="min-h-screen bg-slate-950 text-slate-200 selection:bg-cyan-500/30">
            {/* Header HUD */}
            <header className="sticky top-0 z-50 border-b border-slate-800 bg-slate-950/80 backdrop-blur-md">
                <div className="container mx-auto flex min-h-16 flex-wrap gap-y-2 py-3 items-center justify-between px-6">
                    <div className="flex min-w-0 max-w-full flex-wrap items-center gap-x-4 gap-y-2">
                        <Breadcrumbs current="Agents" />
                        <div className="h-6 w-px bg-slate-700" />
                        <div className="flex items-center gap-2">
                            <div className="h-2 w-2 rounded-full bg-purple-500 animate-pulse" />
                            <h1 className="text-xl font-bold tracking-tight text-white">
                                THE <span className="text-purple-400">NEXUS</span>
                            </h1>
                        </div>
                    </div>
                    <div className="flex items-center gap-6 text-sm font-medium text-slate-400">
                        <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-purple-500/20 border border-purple-500/30 text-purple-400">
                            <Brain size={16} />
                            <span>Agent Registry</span>
                        </div>
                    </div>
                </div>
            </header>

            {/* Content - Agent Registry */}
            <div className="container mx-auto p-6 space-y-6">
                <AgentManager />
            </div>
        </main>
    );
}

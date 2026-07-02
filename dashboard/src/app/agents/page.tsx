"use client"

import { useRouter } from "next/navigation";
import { AgentManager } from "@/components/agent-manager";
import { FleetStation, useFleetHealth } from "@/components/bridge/fleet-station";
import { Brain, ArrowLeft, ShieldCheck, ShieldAlert } from "lucide-react";

export default function AgentsPage() {
    const router = useRouter();
    const { services } = useFleetHealth();
    const online = services?.filter((s) => s.ok).length ?? 0;
    const total = services?.length ?? 0;
    const praxisUp = services?.find((s) => s.id === "praxis")?.ok ?? false;
    const allUp = total > 0 && online === total;

    return (
        <main className="min-h-screen bg-slate-950 text-slate-200 selection:bg-cyan-500/30">
            {/* Header HUD */}
            <header className="sticky top-0 z-50 border-b border-slate-800 bg-slate-950/80 backdrop-blur-md">
                <div className="container mx-auto flex h-16 items-center justify-between px-6">
                    <div className="flex items-center gap-4">
                        <button
                            onClick={() => router.push('/')}
                            className="flex items-center gap-2 text-slate-400 hover:text-white transition-colors"
                        >
                            <ArrowLeft size={18} />
                            <span className="text-sm">Dashboard</span>
                        </button>
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
                        <div className="flex items-center gap-2" title="Live fleet probe via /api/fleet/health">
                            {allUp ? (
                                <ShieldCheck size={16} className="text-emerald-500" />
                            ) : (
                                <ShieldAlert size={16} className={total > 0 ? "text-amber-500" : "text-slate-600"} />
                            )}
                            <span>{total > 0 ? `FLEET ${online}/${total}` : "FLEET —"}</span>
                        </div>
                        <div className="flex items-center gap-2">
                            <span className={`h-2 w-2 rounded-full ${praxisUp ? "bg-emerald-400 animate-pulse" : "bg-red-400"}`} />
                            <span>{praxisUp ? "PRAXIS ONLINE" : "PRAXIS DOWN"}</span>
                        </div>
                    </div>
                </div>
            </header>

            {/* Content - Fleet health + Agent Registry */}
            <div className="container mx-auto p-6 space-y-6">
                <FleetStation />
                <AgentManager />
            </div>
        </main>
    );
}

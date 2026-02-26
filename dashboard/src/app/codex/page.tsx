"use client";

import React from 'react';
import Link from 'next/link';
import { ArrowLeft, BookOpen, ShieldCheck, Zap } from 'lucide-react';
import { VibecodingWorkflowDiagram } from '@/components/visualizations/vibecoding-workflow-diagram';
import { getCodexDocs, CodexDoc } from '@/lib/codex';
import { useEffect, useState } from 'react';

function CodexSection() {
    const [docs, setDocs] = useState<CodexDoc[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        getCodexDocs().then(data => {
            setDocs(data);
            setLoading(false);
        });
    }, []);

    if (loading) return <div className="text-slate-500 animate-pulse">Loading Codex...</div>;

    return (
        <section className="grid md:grid-cols-2 lg:grid-cols-3 gap-6 mt-12">
            {docs.filter(d => d.slug !== 'primary-vibecoding-workflow').map(doc => (
                <Link
                    key={doc.id}
                    href={`/codex/${doc.slug}`}
                    className="group p-6 rounded-xl border border-slate-800 bg-slate-900/30 hover:bg-slate-900/50 hover:border-cyan-500/30 transition-all duration-300"
                >
                    <h3 className="text-lg font-semibold text-white mb-2 group-hover:text-cyan-400 transition-colors">
                        {doc.title}
                    </h3>
                    <div className="flex flex-wrap gap-2 mb-3">
                        <span className="text-xs px-2 py-0.5 rounded-full bg-slate-800 text-slate-400 border border-slate-700">
                            {doc.category}
                        </span>
                        {doc.tags.slice(0, 2).map(tag => (
                            <span key={tag} className="text-xs text-slate-500">#{tag}</span>
                        ))}
                    </div>
                    <p className="text-sm text-slate-500 line-clamp-2">
                        {(doc.content || '').substring(0, 120).replace(/[#*]/g, '')}...
                    </p>
                </Link>
            ))}
        </section>
    );
}

export default function CodexPage() {
    return (
        <main className="min-h-screen bg-slate-950 text-slate-200 selection:bg-cyan-500/30">
            {/* Header HUD */}
            <header className="sticky top-0 z-50 border-b border-slate-800 bg-slate-950/80 backdrop-blur-md">
                <div className="container mx-auto flex h-16 items-center justify-between px-6">
                    <div className="flex items-center gap-4">
                        <Link
                            href="/"
                            className="flex items-center gap-2 text-slate-400 hover:text-white transition-colors"
                        >
                            <ArrowLeft size={18} />
                            <span className="text-sm">Dashboard</span>
                        </Link>
                        <div className="h-6 w-px bg-slate-700" />
                        <div className="flex items-center gap-2">
                            <div className="h-2 w-2 rounded-full bg-cyan-500 animate-pulse" />
                            <h1 className="text-xl font-bold tracking-tight text-white">
                                THE <span className="text-cyan-400">NEXUS</span>
                            </h1>
                        </div>
                    </div>
                    <div className="flex items-center gap-6 text-sm font-medium text-slate-400">
                        <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-pink-500/20 border border-pink-500/30 text-pink-400">
                            <BookOpen size={16} />
                            <span>The Codex</span>
                        </div>
                        <div className="flex items-center gap-2">
                            <ShieldCheck size={16} className="text-emerald-500" />
                            <span>TUNNEL ACTIVE</span>
                        </div>
                        <div className="flex items-center gap-2">
                            <Zap size={16} className="text-yellow-500" />
                            <span>VIBE: HIGH</span>
                        </div>
                    </div>
                </div>
            </header>

            {/* Content */}
            <div className="container mx-auto p-6 space-y-8">
                {/* Page Header */}
                <div>
                    <h1 className="text-3xl font-bold text-white mb-2 flex items-center gap-3">
                        <BookOpen className="text-pink-500" />
                        The Codex
                    </h1>
                    <p className="text-slate-400 max-w-2xl">
                        The central repository for Nexus documentation, architectural patterns, and workflow visualizations.
                        Connecting the dots between the mesh and the mission.
                    </p>
                </div>

                {/* Section: Primary Vibecoding Workflow */}
                <section className="space-y-4">
                    <div className="flex items-center gap-2 border-b border-slate-800 pb-2">
                        <div className="w-1 h-6 bg-gradient-to-b from-cyan-500 to-purple-500 rounded-full" />
                        <h2 className="text-xl font-semibold text-white">Primary Vibecoding Workflow</h2>
                    </div>

                    <p className="text-slate-400 text-sm">
                        This diagram illustrates the high-level orchestration flow within The Nexus.
                        <span className="text-amber-400"> Nexus Prime (Supervisor)</span> coordinates the specialized agentic fleets, maintaining state and ensuring alignment with the user's intent.
                    </p>

                    <VibecodingWorkflowDiagram />
                </section>

                {/* Dynamic Content Section */}
                <CodexSection />

                {/* Section: End-to-End Data Flow */}
                <section className="space-y-4 mt-12 pb-12">
                    <div className="flex items-center gap-2 border-b border-slate-800 pb-2">
                        <div className="w-1 h-6 bg-gradient-to-b from-emerald-500 to-indigo-500 rounded-full" />
                        <h2 className="text-xl font-semibold text-white">End-to-End Data Flow</h2>
                    </div>

                    <p className="text-slate-400 text-sm">
                        This diagram traces the complete data flow from <span className="text-cyan-400">AI Terminal (Agent Mode)</span> submission,
                        through the <span className="text-purple-400">23-node LangGraph Orchestrator</span> with complexity-based routing (Fast vs Full deliberation),
                        <span className="text-amber-400">Human-in-the-Loop review</span> with revision loops, to <span className="text-emerald-400">Nexus Project &amp; Task Creation</span>.
                        The <span className="text-indigo-400">Post-Execution Metacognitive Pipeline</span> runs 11 analysis nodes including Fact Check, Cognitive Auditor, and Epistemic Monitor.
                        Infrastructure: <span className="text-purple-300">Blackboard</span>, <span className="text-cyan-400">Memory (Neo4j)</span>, <span className="text-pink-400">Glass Box Broadcasting</span>, and <span className="text-yellow-400">LLM Factory</span>.
                    </p>

                    <div className="rounded-xl border border-slate-800 bg-slate-900/30 p-4 overflow-auto">
                        <object
                            data="/nexus_data_flow.svg"
                            type="image/svg+xml"
                            className="w-full max-w-[1400px] mx-auto"
                            style={{ minHeight: '1200px' }}
                        >
                            Praxis End-to-End Data Flow Diagram
                        </object>
                    </div>
                </section>

            </div>
        </main>
    );
}

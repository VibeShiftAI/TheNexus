"use client";

import React from 'react';
import Link from 'next/link';
import { ArrowLeft, BookOpen, Brain, ShieldCheck, Zap } from 'lucide-react';
import { AgentManager } from '@/components/agent-manager';
import { AnnotatedScreenshot } from '@/components/ui/annotated-screenshot';


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
                        The central repository for Nexus documentation, current architecture notes, and interface references.
                    </p>
                </div>

                {/* Section: Interface Overview */}
                <section className="space-y-12 pb-12">
                    <div className="flex items-center gap-2 border-b border-slate-800 pb-2">
                        <div className="w-1 h-6 bg-gradient-to-b from-blue-500 to-indigo-500 rounded-full" />
                        <h2 className="text-xl font-semibold text-white">The Nexus Interface</h2>
                    </div>

                    <div className="space-y-4">
                        <h3 className="text-lg font-medium text-slate-300">Dashboard Home</h3>
                        <p className="text-slate-400 text-sm">
                            The central hub for all active projects and initiatives. Hover over the glowing cyan dots to explore each feature area.
                        </p>
                        <AnnotatedScreenshot
                            src="/dashboard_screenshot.png"
                            alt="Nexus Dashboard Home"
                            annotations={[
                                { id: 'nav', x: 60, y: 2.5, title: 'Navigation Bar', description: 'Quick access to the System Monitor, The Codex documentation, and the live Cloudflare Tunnel status indicator.', align: 'bottom' },
                                { id: 'model', x: 28, y: 9, title: 'Model Selector & Agent Mode', description: 'Choose between AI models from multiple providers and toggle Agent Mode for full orchestration vs. simple chat.', align: 'bottom' },
                                { id: 'term', x: 40, y: 28, title: 'Nexus Terminal', description: 'The primary AI interface. Submit natural language prompts to Praxis/Cortex-backed chat and planning flows.', align: 'right' },
                                { id: 'review', x: 80, y: 11, title: 'Artifacts In Review', description: 'A centralized queue for the Human-in-the-Loop review process. Plans and generated code wait here for your approval before the system proceeds.', align: 'left' },
                                { id: 'taskstatus', x: 84, y: 43, title: 'Global Task Status', description: 'Aggregated tasks across every project, grouped by status for a bird\'s-eye view of total workload.', align: 'left' },
                                { id: 'projects', x: 18, y: 62, title: 'Active Projects', description: 'Card grid of all managed projects. Each card shows the project type, description, deployment status (Live/Draft), tech stack, and latest Git activity.', align: 'top' },
                                { id: 'newproject', x: 84, y: 56, title: '+ New Project', description: 'Scaffold a brand-new software project. Creates the database record and initializes a .context directory.', align: 'left' },
                                { id: 'initiatives', x: 84, y: 62, title: 'Initiatives Panel', description: 'High-level strategic goals that span multiple projects.', align: 'left' },
                                { id: 'activity', x: 84, y: 82, title: 'Recent Activity Feed', description: 'A chronological stream of commits, context updates, and task completions across the entire Nexus ecosystem.', align: 'left' },
                                { id: 'gitstatus', x: 35, y: 82, title: 'Project Git Info', description: 'Each project card shows branch info, latest commit hash, and a direct link to the GitHub repository for quick navigation.', align: 'top' }
                            ]}
                        />
                    </div>

                    <div className="space-y-4">
                        <h3 className="text-lg font-medium text-slate-300">Project Workspace</h3>
                        <p className="text-slate-400 text-sm">
                            The dedicated workspace for a single software project. Context, tasks, and source control converge here.
                        </p>
                        <AnnotatedScreenshot
                            src="/project_screenshot.png"
                            alt="Nexus Project Home"
                            annotations={[
                                { id: 'header', x: 25, y: 9, title: 'Project Header', description: 'Shows the project name, description, type badge (web-app, tool), file path, and vibe mode. Quick links for Production site and Github views.', align: 'bottom' },
                                { id: 'ctxsidebar', x: 18, y: 22, title: 'Context Sidebar', description: 'Dynamic file browser for the .context/ directory. Select documents like project-context.md, api-reference.md, or tech-stack.md to view and edit.', align: 'right' },
                                { id: 'ctxeditor', x: 45, y: 22, title: 'Context Editor', description: 'Live markdown editor with Preview/Edit Source toggle. Supports Draft and Published states, Git sync, and direct save to database. A Copy All Context button enables quick communication about complex projects.', align: 'bottom' },
                                { id: 'ctxbody', x: 40, y: 42, title: 'Project Context Document', description: 'The AI\'s memory for this project — Vision, Target Audience, Core Value Proposition, and Architecture decisions. This context is injected into every AI interaction scoped to this project.', align: 'right' },
                                { id: 'git', x: 82, y: 12, title: 'Git Status Panel', description: 'Real-time sync with the local repo: uncommitted changes count, sync status with remote, branch info, and a scrollable list of recent commits.', align: 'left' },
                                { id: 'artifactsreview', x: 82, y: 42, title: 'Artifacts In Review', description: 'Project-scoped and Task-scoped artifact review queue. AI-generated plans and code blocks appear here awaiting human approval before execution.', align: 'left' },
                                { id: 'taskpanel', x: 82, y: 60, title: 'Task Status Sidebar', description: 'Tasks grouped by current status for at-a-glance progress across the project.', align: 'left' },
                                { id: 'taskmgr', x: 35, y: 60, title: 'Task Manager', description: 'The main task list with full descriptions, creation dates, and action buttons. Supports Auto Research (AI-driven task expansion) and manual "+ New Task" creation.', align: 'top' },
                                { id: 'taskcard', x: 40, y: 75, title: 'Task Cards', description: 'Each task shows its title, detailed description, timestamp, and quick-action icons for editing or navigating to the full task detail view.', align: 'top' },
                                { id: 'archive', x: 82, y: 78, title: 'Archive', description: 'Collapsed section for completed and deprecated tasks. Keeps the workspace clean while preserving full history.', align: 'left' },
                                { id: 'deleteproj', x: 18, y: 27, title: 'Delete Project', description: 'Danger Zone action with multi-scope confirmation. Removes project data from the database, optionally deletes local files and the .context directory.', align: 'right' }
                            ]}
                        />
                    </div>
                </section>

                {/* Section: Agent Registry */}
                <section className="space-y-4 mt-12 pb-12">
                    <div className="flex items-center gap-2 border-b border-slate-800 pb-2">
                        <div className="w-1 h-6 bg-gradient-to-b from-purple-500 to-pink-500 rounded-full" />
                        <h2 className="text-xl font-semibold text-white flex items-center gap-2">
                            <Brain size={20} className="text-purple-400" />
                            Agent Registry
                        </h2>
                    </div>

                    <p className="text-slate-400 text-sm">
                        The current model and agent catalog for the Nexus dashboard.
                    </p>

                    <AgentManager />
                </section>

            </div>
        </main>
    );
}

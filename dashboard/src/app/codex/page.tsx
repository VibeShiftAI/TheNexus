"use client";

/**
 * The Codex — the living atlas of the Praxis ecosystem.
 *
 * Fully self-contained: every fact on this page is static content verified
 * against the running system (no /api/codex backend exists — the old doc
 * library fetched a dead endpoint). If the architecture shifts, edit the
 * ORGANS / PIPELINE / DIRECTIVES / EPOCHS data below and bump ATLAS_REV.
 */

import React, { useEffect, useState } from "react";
import Link from "next/link";
import {
    ArrowLeft,
    BookOpen,
    BrainCircuit,
    ChevronRight,
    Cpu,
    FastForward,
    History,
    Landmark,
    LayoutDashboard,
    Library,
    Orbit,
    Radio,
    Scale,
    Send,
    ShieldCheck,
    Terminal,
    Waypoints,
    Zap,
} from "lucide-react";

const ATLAS_REV = "2026.07.11";

// ── Data: the seven organs ────────────────────────────────────────────────

type OrganId =
    | "praxis"
    | "nexus"
    | "cortex"
    | "vault"
    | "executors"
    | "forge"
    | "channels";

interface Organ {
    id: OrganId;
    name: string;
    designation: string;
    icon: React.ComponentType<{ size?: number; className?: string; style?: React.CSSProperties }>;
    hex: string;
    chip: string; // full tailwind classes (JIT-safe)
    glow: string;
    x: number; // viewBox 0..1000
    y: number; // viewBox 0..620
    role: string;
    station: string;
    berth: string;
    stack: string[];
    law: string;
}

const ORGANS: Organ[] = [
    {
        id: "praxis",
        name: "PRAXIS",
        designation: "The Agent",
        icon: Orbit,
        hex: "#22d3ee",
        chip: "bg-cyan-500/10 border-cyan-500/30 text-cyan-300",
        glow: "shadow-[0_0_32px_rgba(34,211,238,0.35)]",
        x: 500,
        y: 300,
        role:
            "The autonomous runtime at the center of everything — scheduler, heartbeat, guardrails, skill pipeline, and MCP bridge. Praxis decides what gets worked on, dispatches it, watches it finish, and answers on every channel. He supervises the cockpit and the brain's gateway as child processes. Robert calls him “he.”",
        station: "Port :54322",
        berth: "/Volumes/Projects/Praxis",
        stack: ["TypeScript", "Node / ESM", "tsx", "Event-sourced core"],
        law: "Praxis is authoritative for what is being worked on and what state it is in. Everything else is a viewport.",
    },
    {
        id: "nexus",
        name: "THE NEXUS",
        designation: "The Cockpit",
        icon: LayoutDashboard,
        hex: "#60a5fa",
        chip: "bg-blue-500/10 border-blue-500/30 text-blue-300",
        glow: "shadow-[0_0_24px_rgba(96,165,250,0.3)]",
        x: 185,
        y: 130,
        role:
            "The bridge you are standing on. Express API on :4000, this Next.js deck on :3000 — retrofitted as a pure viewport onto Praxis and supervised as his child process. Also berths the praxis-mind MCP server: the vault, memory, and task tools every Claude session mounts.",
        station: "Ports :4000 / :3000",
        berth: "/Volumes/Projects/TheNexus",
        stack: ["Next.js", "Express", "SQLite (WAL)", "praxis-mind MCP"],
        law: "The Nexus is a viewport, never an orchestrator. It renders and relays; it does not decide.",
    },
    {
        id: "cortex",
        name: "THE CORTEX",
        designation: "The Brain",
        icon: BrainCircuit,
        hex: "#a78bfa",
        chip: "bg-violet-500/10 border-violet-500/30 text-violet-300",
        glow: "shadow-[0_0_24px_rgba(167,139,250,0.3)]",
        x: 815,
        y: 130,
        role:
            "Semantic long-term memory and System 2 deliberation. Pinecone holds the vectors, Neo4j holds the knowledge graph (container neo4j-cortex, gateway :8100), the Gardener keeps the graph pruned, and the sensorium feeds it. Praxis reaches here when a question needs depth instead of reflex.",
        station: "Gateway :8100",
        berth: "/Volumes/Projects/TheCortex",
        stack: ["Python", "Neo4j", "Pinecone", "Gardener hygiene"],
        law: "Cognitive tools live in Praxis and the Cortex. Credentialed adapters stay outside the agent runtime.",
    },
    {
        id: "vault",
        name: "THE VAULT",
        designation: "The Shared Mind",
        icon: Library,
        hex: "#f472b6",
        chip: "bg-pink-500/10 border-pink-500/30 text-pink-300",
        glow: "shadow-[0_0_24px_rgba(244,114,182,0.3)]",
        x: 905,
        y: 350,
        role:
            "A file-based shared mind that every agent session — Claude, councils, executors — reads and writes. Memories, skills, projects, workflows, and incident reports live here as plain markdown; a watcher regenerates the MEMORY.md and SKILLS.md indexes on every change.",
        station: "Filesystem + watcher",
        berth: "~/.claude/projects/…/memory",
        stack: ["Markdown", "Hybrid search", "Vault watcher", "Git-synced"],
        law: "The indexes are generated, never hand-edited. One file, one fact; link liberally.",
    },
    {
        id: "channels",
        name: "CHANNELS",
        designation: "The Senses",
        icon: Radio,
        hex: "#2dd4bf",
        chip: "bg-teal-500/10 border-teal-500/30 text-teal-300",
        glow: "shadow-[0_0_24px_rgba(45,212,191,0.3)]",
        x: 95,
        y: 350,
        role:
            "Every way Praxis hears and speaks: the Nexus chat terminal, iMessage via BlueBubbles, Gmail, Home Assistant, and the mobile command deck (Expo / React Native with FCM push). The mobile HITL inbox carries the morning slate approval card and free-text answers that resume suspended runs.",
        station: "Multi-channel",
        berth: "~/Projects/Nexus-Mobile-Android",
        stack: ["iMessage", "Gmail", "Home Assistant", "Mobile deck"],
        law: "A needs_input question suspends the run, frees the slot, and the answer resumes the same executor.",
    },
    {
        id: "executors",
        name: "EXECUTOR BAY",
        designation: "The Hands",
        icon: Terminal,
        hex: "#34d399",
        chip: "bg-emerald-500/10 border-emerald-500/30 text-emerald-300",
        glow: "shadow-[0_0_24px_rgba(52,211,153,0.3)]",
        x: 285,
        y: 525,
        role:
            "Three CLI crews take the actual work: codex, claude-code (subscription-billed, API key stripped from the child env), and antigravity running agy headless. A rotation with a health circuit breaker picks the crew; a machine-wide gate holds the fleet to one CLI run at a time. Detached runs survive Praxis restarts.",
        station: "CLI dispatch seam",
        berth: "Praxis src/executors/",
        stack: ["codex", "claude-code", "antigravity (agy)", "Run gate"],
        law: "The diff baseline is a worktree snapshot taken at dispatch — shared workspaces mean HEAD lies.",
    },
    {
        id: "forge",
        name: "LOCAL FORGE",
        designation: "Background Cognition",
        icon: Cpu,
        hex: "#fbbf24",
        chip: "bg-amber-500/10 border-amber-500/30 text-amber-300",
        glow: "shadow-[0_0_24px_rgba(251,191,36,0.3)]",
        x: 715,
        y: 525,
        role:
            "LM Studio running Gemma 31B QAT as the on-metal worker under Praxis's queue: nightly ingestion, community summaries, skill harvesting, calendar and history digestion. A swap-aware pressure governor pauses it when the machine strains — and only auto-resumes pauses it made itself.",
        station: "LM Studio queue",
        berth: "Praxis src/local-llm/",
        stack: ["Gemma 31B QAT", "LM Studio", "Pressure governor"],
        law: "Operator pauses are sacred. The governor resumes only what the governor paused.",
    },
];

// ── Data: the pipeline ────────────────────────────────────────────────────

const PIPELINE = [
    {
        icon: Landmark,
        title: "COUNCIL",
        hex: "#fbbf24",
        chip: "border-amber-500/30 text-amber-300",
        body: "At 06:15 the Knowledge Council convenes — in-house seats deliberate and draft the morning slate. Robert approves it slot by slot from the mobile deck.",
    },
    {
        icon: Send,
        title: "DISPATCH",
        hex: "#22d3ee",
        chip: "border-cyan-500/30 text-cyan-300",
        body: "Rotation picks a healthy executor, the single-run gate opens, and a worktree snapshot is captured as the diff baseline before a single line changes.",
    },
    {
        icon: Zap,
        title: "EXECUTE",
        hex: "#34d399",
        chip: "border-emerald-500/30 text-emerald-300",
        body: "The run detaches and writes every step to the event log — it survives Praxis restarts. If it needs Robert, the question rides push to his phone and the slot frees.",
    },
    {
        icon: ShieldCheck,
        title: "REVIEW",
        hex: "#a78bfa",
        chip: "border-violet-500/30 text-violet-300",
        body: "Completed work holds at ready_for_review. A different executor — never the author — audits the diff against the task contract.",
    },
    {
        icon: FastForward,
        title: "ADVANCE",
        hex: "#f472b6",
        chip: "border-pink-500/30 text-pink-300",
        body: "Pass: the schedule advances atomically. Fail: re-dispatch with corrections. Three strikes trips the circuit breaker; fail-open happens only when no reviewer remains.",
    },
];

// ── Data: prime directives ────────────────────────────────────────────────

const DIRECTIVES = [
    {
        law: "The event log is truth.",
        why: "Presence and the run registry are projections, rebuilt at boot. Any question about execution state goes to the log — never to a cache of it.",
    },
    {
        law: "The Nexus is a viewport.",
        why: "Orchestration belongs to Praxis. The cockpit renders state and relays intent; the day it starts deciding is the day there are two agents.",
    },
    {
        law: "The author never grades their own work.",
        why: "QA review is dispatched to a different executor, retried through third parties, and fails open — complete with a warning — only when nobody is left to ask.",
    },
    {
        law: "Cognition in, credentials out.",
        why: "LLM-shaped tools live in Praxis and the Cortex. Anything holding API keys, OAuth tokens, or a cost ledger stays outside the agent runtime.",
    },
    {
        law: "Silence from launchctl is not death.",
        why: "The dashboard and the Cortex gateway are supervised children of Praxis — liveness comes from the supervisor and the open port, not a launchd label.",
    },
    {
        law: "One CLI run at a time.",
        why: "A machine-wide gate holds every executor to a single slot. Suspension on needs_input frees it; nothing queues silently behind a ghost.",
    },
];

// ── Data: epochs ──────────────────────────────────────────────────────────

const EPOCHS = [
    {
        date: "2026 · 07 · 02",
        title: "LangGraph decommissioned",
        body: "The external orchestrator retired after two lifetime runs, both zombies. Orchestration folded into Praxis, where it stayed.",
        hex: "#f87171",
    },
    {
        date: "2026 · 07 · 03",
        title: "The reliability spine",
        body: "Wave 1 lands: the event-sourced execution log becomes the source of truth, runs detach and survive restarts, the pressure governor learns restraint, and cross-executor QA goes live.",
        hex: "#34d399",
    },
    {
        date: "2026 · 07 · 06",
        title: "Supervision consolidation",
        body: "The dashboard and Cortex gateway become Praxis-supervised children; their launchd plists retire. The health model learns that a missing label is not a missing service.",
        hex: "#60a5fa",
    },
    {
        date: "2026 · 07 · 10",
        title: "The knowledge loop closes",
        body: "Knowledge Council v1 takes the 06:15 cron. The system now reads, deliberates, and files what it learns into the shared mind — on its own.",
        hex: "#a78bfa",
    },
];

const ROADMAP = [
    { wave: "W2", item: "Improvement ledger feeding the morning slate" },
    { wave: "W2", item: "The Groundskeeper" },
    { wave: "W2", item: "Backups — 3 of 4 legs live, Neo4j leg pending" },
    { wave: "W3", item: "Project context packs" },
    { wave: "W3", item: "Pre-LLM setup latency burn-down (~58s)" },
];

// ── Hooks ─────────────────────────────────────────────────────────────────

function useReducedMotion(): boolean {
    const [reduced, setReduced] = useState(false);
    useEffect(() => {
        const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
        setReduced(mq.matches);
        const onChange = () => setReduced(mq.matches);
        mq.addEventListener("change", onChange);
        return () => mq.removeEventListener("change", onChange);
    }, []);
    return reduced;
}

// ── The constellation map ─────────────────────────────────────────────────

const VB_W = 1000;
const VB_H = 620;
const CORE = ORGANS[0];
const SATELLITES = ORGANS.filter((o) => o.id !== "praxis");

function ConstellationMap({
    selected,
    onSelect,
}: {
    selected: OrganId;
    onSelect: (id: OrganId) => void;
}) {
    const reduced = useReducedMotion();

    return (
        <div className="relative overflow-x-auto rounded-2xl border border-slate-800 bg-slate-950/60 hud-scanlines">
            <div className="relative mx-auto min-w-[860px]" style={{ aspectRatio: `${VB_W} / ${VB_H}` }}>
                {/* Beam layer */}
                <svg
                    viewBox={`0 0 ${VB_W} ${VB_H}`}
                    preserveAspectRatio="none"
                    className="absolute inset-0 h-full w-full"
                    aria-hidden="true"
                >
                    {SATELLITES.map((o, i) => {
                        const active = selected === o.id || selected === "praxis";
                        return (
                            <g key={o.id}>
                                <line
                                    x1={CORE.x}
                                    y1={CORE.y}
                                    x2={o.x}
                                    y2={o.y}
                                    stroke={o.hex}
                                    strokeOpacity={active ? 0.45 : 0.16}
                                    strokeWidth={active ? 1.5 : 1}
                                    strokeDasharray="6 7"
                                    className="codex-anim codex-beam"
                                    style={{ transition: "stroke-opacity 300ms" }}
                                />
                                {!reduced && (
                                    <circle r={3} fill={o.hex} opacity={0.9}>
                                        <animateMotion
                                            dur={`${2.6 + i * 0.35}s`}
                                            begin={`${i * 0.45}s`}
                                            repeatCount="indefinite"
                                            path={`M${CORE.x},${CORE.y} L${o.x},${o.y}`}
                                        />
                                    </circle>
                                )}
                                {!reduced && (
                                    <circle r={2} fill={o.hex} opacity={0.5}>
                                        <animateMotion
                                            dur={`${3.4 + i * 0.3}s`}
                                            begin={`${1.2 + i * 0.5}s`}
                                            repeatCount="indefinite"
                                            path={`M${o.x},${o.y} L${CORE.x},${CORE.y}`}
                                        />
                                    </circle>
                                )}
                            </g>
                        );
                    })}
                    {/* Orbit ring around the core */}
                    <circle
                        cx={CORE.x}
                        cy={CORE.y}
                        r={150}
                        fill="none"
                        stroke="#22d3ee"
                        strokeOpacity={0.08}
                        strokeWidth={1}
                    />
                </svg>

                {/* Node layer */}
                {ORGANS.map((o) => {
                    const isCore = o.id === "praxis";
                    const isSelected = selected === o.id;
                    const Icon = o.icon;
                    return (
                        <button
                            key={o.id}
                            onClick={() => onSelect(o.id)}
                            aria-pressed={isSelected}
                            aria-label={`${o.name} — ${o.designation}`}
                            className="group absolute -translate-x-1/2 -translate-y-1/2 outline-none"
                            style={{
                                left: `${(o.x / VB_W) * 100}%`,
                                top: `${(o.y / VB_H) * 100}%`,
                            }}
                        >
                            <span className="flex flex-col items-center gap-2">
                                <span className="relative flex items-center justify-center">
                                    {/* pulse ring */}
                                    <span
                                        className={`codex-anim codex-ring absolute rounded-full border ${isCore ? "h-20 w-20" : "h-14 w-14"}`}
                                        style={{ borderColor: o.hex, opacity: isSelected ? 0.7 : 0.25 }}
                                    />
                                    <span
                                        className={`relative flex items-center justify-center rounded-full border bg-slate-950 transition-all duration-300 group-focus-visible:ring-2 group-focus-visible:ring-white/60 ${
                                            isCore ? "h-20 w-20" : "h-14 w-14"
                                        } ${isSelected ? o.glow : ""}`}
                                        style={{
                                            borderColor: o.hex,
                                            borderWidth: isSelected ? 2 : 1,
                                            boxShadow: isSelected ? undefined : `0 0 12px ${o.hex}22`,
                                        }}
                                    >
                                        <Icon size={isCore ? 32 : 22} className="transition-transform duration-300 group-hover:scale-110" style={{ color: o.hex } as React.CSSProperties} />
                                    </span>
                                </span>
                                <span className="flex flex-col items-center">
                                    <span
                                        className={`whitespace-nowrap font-mono text-[11px] font-bold tracking-[0.18em] transition-colors ${isSelected ? "text-white" : "text-slate-400 group-hover:text-slate-200"}`}
                                    >
                                        {o.name}
                                    </span>
                                    <span className="whitespace-nowrap font-mono text-[9px] uppercase tracking-[0.22em] text-slate-600">
                                        {o.designation}
                                    </span>
                                </span>
                            </span>
                        </button>
                    );
                })}
            </div>
        </div>
    );
}

// ── Organ detail panel ────────────────────────────────────────────────────

function OrganDetail({ organ }: { organ: Organ }) {
    const Icon = organ.icon;
    return (
        <div className="flex h-full flex-col rounded-2xl border border-slate-800 bg-slate-900/50 p-6 backdrop-blur-sm">
            <div className="flex items-center gap-4 border-b border-slate-800 pb-4">
                <span
                    className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full border bg-slate-950"
                    style={{ borderColor: organ.hex, boxShadow: `0 0 18px ${organ.hex}33` }}
                >
                    <Icon size={22} style={{ color: organ.hex } as React.CSSProperties} />
                </span>
                <div>
                    <div className="font-mono text-lg font-bold tracking-[0.14em] text-white">{organ.name}</div>
                    <div className="font-mono text-[10px] uppercase tracking-[0.28em] text-slate-500">
                        {organ.designation}
                    </div>
                </div>
            </div>

            <p className="mt-4 text-sm leading-relaxed text-slate-300">{organ.role}</p>

            <dl className="mt-5 space-y-2 font-mono text-xs">
                <div className="flex gap-3">
                    <dt className="w-16 shrink-0 uppercase tracking-widest text-slate-600">Station</dt>
                    <dd className="text-slate-300">{organ.station}</dd>
                </div>
                <div className="flex gap-3">
                    <dt className="w-16 shrink-0 uppercase tracking-widest text-slate-600">Berth</dt>
                    <dd className="break-all text-slate-300">{organ.berth}</dd>
                </div>
            </dl>

            <div className="mt-4 flex flex-wrap gap-1.5">
                {organ.stack.map((s) => (
                    <span key={s} className={`rounded-md border px-2 py-0.5 font-mono text-[10px] tracking-wider ${organ.chip}`}>
                        {s}
                    </span>
                ))}
            </div>

            <div className="mt-auto pt-5">
                <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-4">
                    <div className="mb-1 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.28em] text-slate-500">
                        <Scale size={11} />
                        Operating law
                    </div>
                    <p className="text-sm italic leading-relaxed" style={{ color: organ.hex }}>
                        {organ.law}
                    </p>
                </div>
            </div>
        </div>
    );
}

// ── Section scaffolding ───────────────────────────────────────────────────

function SectionHeader({
    index,
    icon: Icon,
    title,
    subtitle,
}: {
    index: string;
    icon: React.ComponentType<{ size?: number; className?: string }>;
    title: string;
    subtitle: string;
}) {
    return (
        <div className="mb-8">
            <div className="mb-2 flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.3em] text-cyan-500/80">
                <Icon size={13} />
                <span>{index}</span>
            </div>
            <h2 className="text-2xl font-bold tracking-tight text-white">{title}</h2>
            <p className="mt-1 max-w-2xl text-sm text-slate-400">{subtitle}</p>
        </div>
    );
}

// ── Page ──────────────────────────────────────────────────────────────────

export default function CodexPage() {
    const [selected, setSelected] = useState<OrganId>("praxis");
    const organ = ORGANS.find((o) => o.id === selected) ?? ORGANS[0];

    return (
        <main className="hud-backdrop min-h-screen bg-slate-950 text-slate-200 selection:bg-cyan-500/30">
            <style>{`
                @keyframes codex-dash { to { stroke-dashoffset: -26; } }
                .codex-beam { animation: codex-dash 1.6s linear infinite; }
                @keyframes codex-ring {
                    0% { transform: scale(1); opacity: inherit; }
                    100% { transform: scale(1.8); opacity: 0; }
                }
                .codex-ring { animation: codex-ring 2.6s ease-out infinite; }
                @keyframes codex-rise {
                    from { opacity: 0; transform: translateY(10px); }
                    to { opacity: 1; transform: translateY(0); }
                }
                .codex-rise { animation: codex-rise 700ms ease-out both; }
                @media (prefers-reduced-motion: reduce) {
                    .codex-anim, .codex-beam, .codex-ring, .codex-rise { animation: none !important; }
                }
            `}</style>

            {/* Header HUD */}
            <header className="sticky top-0 z-50 border-b border-slate-800 bg-slate-950/80 backdrop-blur-md">
                <div className="container mx-auto flex h-16 items-center justify-between px-6">
                    <div className="flex items-center gap-4">
                        <Link
                            href="/"
                            className="flex items-center gap-2 text-slate-400 transition-colors hover:text-white"
                        >
                            <ArrowLeft size={18} />
                            <span className="text-sm">Dashboard</span>
                        </Link>
                        <div className="h-6 w-px bg-slate-700" />
                        <div className="flex items-center gap-2">
                            <div className="h-2 w-2 animate-pulse rounded-full bg-cyan-500" />
                            <h1 className="text-xl font-bold tracking-tight text-white">
                                THE <span className="text-cyan-400">NEXUS</span>
                            </h1>
                        </div>
                    </div>
                    <div className="flex items-center gap-4 text-sm font-medium text-slate-400">
                        <div className="flex items-center gap-2 rounded-lg border border-pink-500/30 bg-pink-500/20 px-3 py-1.5 text-pink-400">
                            <BookOpen size={16} />
                            <span>The Codex</span>
                        </div>
                        <span className="hidden font-mono text-[11px] uppercase tracking-[0.22em] text-slate-600 md:block">
                            Atlas rev {ATLAS_REV}
                        </span>
                    </div>
                </div>
            </header>

            <div className="container mx-auto space-y-24 px-6 pb-24">
                {/* Hero */}
                <section className="codex-rise pt-16 text-center md:pt-24">
                    <div className="mb-4 font-mono text-[11px] uppercase tracking-[0.4em] text-slate-500">
                        System atlas · verified against the running system
                    </div>
                    <h1 className="bg-gradient-to-b from-white via-slate-200 to-slate-500 bg-clip-text text-6xl font-bold tracking-tight text-transparent md:text-7xl">
                        The Codex
                    </h1>
                    <p className="mx-auto mt-5 max-w-xl text-lg text-slate-400">
                        The living atlas of the Praxis ecosystem.
                    </p>
                    <div className="mt-6 flex items-center justify-center gap-3 font-mono text-[11px] uppercase tracking-[0.3em] text-cyan-400/80">
                        <span>One agent</span>
                        <span className="text-slate-700">·</span>
                        <span>Six organs</span>
                        <span className="text-slate-700">·</span>
                        <span>A shared mind</span>
                    </div>
                </section>

                {/* 01 · Constellation */}
                <section>
                    <SectionHeader
                        index="01 · The constellation"
                        icon={Orbit}
                        title="Anatomy of the system"
                        subtitle="Praxis at the core; everything else is an organ he works through. Select a node to read its dossier."
                    />
                    <div className="grid gap-6 xl:grid-cols-[1.7fr_1fr]">
                        <div className="relative">
                            <ConstellationMap selected={selected} onSelect={setSelected} />
                        </div>
                        <OrganDetail organ={organ} />
                    </div>
                </section>

                {/* 02 · Pipeline */}
                <section>
                    <SectionHeader
                        index="02 · The pipeline"
                        icon={Send}
                        title="How work moves"
                        subtitle="From the 06:15 council to an atomically advanced schedule — every task rides the same rail, and nobody reviews their own work."
                    />
                    <div className="flex snap-x gap-0 overflow-x-auto pb-2">
                        {PIPELINE.map((stage, i) => {
                            const Icon = stage.icon;
                            return (
                                <React.Fragment key={stage.title}>
                                    <div className="min-w-[208px] flex-1 snap-start rounded-2xl border border-slate-800 bg-slate-900/50 p-5">
                                        <div className="flex items-center justify-between">
                                            <span
                                                className="flex h-9 w-9 items-center justify-center rounded-lg border bg-slate-950"
                                                style={{ borderColor: `${stage.hex}55` }}
                                            >
                                                <Icon size={17} style={{ color: stage.hex } as React.CSSProperties} />
                                            </span>
                                            <span className="font-mono text-[10px] text-slate-600">0{i + 1}</span>
                                        </div>
                                        <div className={`mt-3 inline-block rounded border px-2 py-0.5 font-mono text-[11px] font-bold tracking-[0.2em] ${stage.chip}`}>
                                            {stage.title}
                                        </div>
                                        <p className="mt-3 text-[13px] leading-relaxed text-slate-400">{stage.body}</p>
                                    </div>
                                    {i < PIPELINE.length - 1 && (
                                        <div className="flex shrink-0 items-center px-1">
                                            <ChevronRight size={16} className="text-slate-700" />
                                        </div>
                                    )}
                                </React.Fragment>
                            );
                        })}
                    </div>
                    <div className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] uppercase tracking-wider text-slate-500">
                        <ShieldCheck size={12} className="text-violet-400" />
                        <span>Fail path:</span>
                        <span className="text-slate-400">review fail → re-dispatch with corrections</span>
                        <span className="text-slate-700">·</span>
                        <span className="text-slate-400">3 strikes → circuit breaker</span>
                        <span className="text-slate-700">·</span>
                        <span className="text-slate-400">fail-open only when no reviewer remains</span>
                    </div>
                </section>

                {/* 03 · Prime directives */}
                <section>
                    <SectionHeader
                        index="03 · Prime directives"
                        icon={Scale}
                        title="The laws that keep it sane"
                        subtitle="Doctrine written in scar tissue. Each one exists because its absence, at some point, hurt."
                    />
                    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                        {DIRECTIVES.map((d, i) => (
                            <div
                                key={d.law}
                                className="group rounded-2xl border border-slate-800 bg-slate-900/50 p-5 transition-colors hover:border-cyan-500/30"
                            >
                                <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-cyan-500/70">
                                    Law 0{i + 1}
                                </div>
                                <div className="mt-2 text-base font-semibold text-white">{d.law}</div>
                                <p className="mt-2 text-[13px] leading-relaxed text-slate-400">{d.why}</p>
                            </div>
                        ))}
                    </div>
                </section>

                {/* 04 · Epochs */}
                <section>
                    <SectionHeader
                        index="04 · Epochs"
                        icon={History}
                        title="How we got here"
                        subtitle="The convergence, in four moves. Praxis became the agent; everything else found its station."
                    />
                    <div className="relative ml-2 space-y-8 border-l border-slate-800 pl-8">
                        {EPOCHS.map((e) => (
                            <div key={e.title} className="relative">
                                <span
                                    className="absolute -left-[38.5px] top-1 h-2.5 w-2.5 rounded-full border-2 border-slate-950"
                                    style={{ backgroundColor: e.hex, boxShadow: `0 0 10px ${e.hex}66` }}
                                />
                                <div className="font-mono text-[11px] tracking-[0.25em] text-slate-500">{e.date}</div>
                                <div className="mt-1 text-base font-semibold text-white">{e.title}</div>
                                <p className="mt-1 max-w-2xl text-sm leading-relaxed text-slate-400">{e.body}</p>
                            </div>
                        ))}
                    </div>
                </section>

                {/* 05 · Course laid in */}
                <section>
                    <SectionHeader
                        index="05 · Course laid in"
                        icon={Waypoints}
                        title="What comes next"
                        subtitle="The wave roadmap on the board. The shape is converged; this is refinement, not surgery."
                    />
                    <div className="flex flex-wrap gap-3">
                        {ROADMAP.map((r) => (
                            <div
                                key={r.item}
                                className="flex items-center gap-3 rounded-xl border border-slate-800 bg-slate-900/50 px-4 py-2.5"
                            >
                                <span className="rounded bg-cyan-500/10 px-1.5 py-0.5 font-mono text-[10px] font-bold tracking-widest text-cyan-400">
                                    {r.wave}
                                </span>
                                <span className="text-sm text-slate-300">{r.item}</span>
                            </div>
                        ))}
                    </div>
                </section>

                {/* Footer stamp */}
                <div className="border-t border-slate-800/60 pt-8 text-center font-mono text-[11px] uppercase tracking-[0.3em] text-slate-600">
                    The Codex · atlas rev {ATLAS_REV} · hand-verified against the running system
                </div>
            </div>
        </main>
    );
}

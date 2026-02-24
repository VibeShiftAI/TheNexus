import React from 'react';

// Helper component for agent nodes within fleets
const AgentNode = ({ x, y, name, model, task, color = 'slate' }: { x: number; y: number; name: string; model: string; task: string; color?: string }) => {
    const colors: Record<string, { bg: string; border: string; text: string }> = {
        blue: { bg: '#1e3a5f', border: '#3b82f6', text: '#93c5fd' },
        purple: { bg: '#3b1f5c', border: '#8b5cf6', text: '#c4b5fd' },
        amber: { bg: '#4a3728', border: '#f59e0b', text: '#fcd34d' },
        emerald: { bg: '#1a3a2e', border: '#10b981', text: '#6ee7b7' },
        rose: { bg: '#4a2832', border: '#f43f5e', text: '#fda4af' },
        slate: { bg: '#1e293b', border: '#64748b', text: '#94a3b8' },
        cyan: { bg: '#0c3644', border: '#06b6d4', text: '#67e8f9' },
    };
    const c = colors[color] || colors.slate;
    return (
        <g transform={`translate(${x}, ${y})`}>
            <rect x="-60" y="-32" width="120" height="64" rx="6" fill={c.bg} stroke={c.border} strokeWidth="1.5" />
            <text x="0" y="-10" textAnchor="middle" fill={c.text} fontWeight="bold" fontSize="10">{name}</text>
            <text x="0" y="5" textAnchor="middle" fill="#94a3b8" fontSize="8">{model}</text>
            <text x="0" y="18" textAnchor="middle" fill="#64748b" fontSize="8">{task}</text>
        </g>
    );
};

// Helper component for output artifacts
const ArtifactNode = ({ x, y, name, items }: { x: number; y: number; name: string; items: string[] }) => (
    <g transform={`translate(${x}, ${y})`}>
        <polygon points="-75,-38 75,-38 85,0 75,38 -75,38 -65,0" fill="#422006" stroke="#f59e0b" strokeWidth="1.5" />
        <text x="0" y={-14 - (items.length > 2 ? 2 : 0)} textAnchor="middle" fill="#fbbf24" fontWeight="bold" fontSize="10">{name}</text>
        {items.map((item, i) => (
            <text key={i} x="0" y={1 + i * 12} textAnchor="middle" fill="#fcd34d" fontSize="8">{item}</text>
        ))}
    </g>
);

// Helper component for system/tool nodes
const SystemNode = ({ x, y, name, task }: { x: number; y: number; name: string; task: string }) => (
    <g transform={`translate(${x}, ${y})`}>
        <rect x="-65" y="-22" width="130" height="44" rx="4" fill="transparent" stroke="#64748b" strokeWidth="1" strokeDasharray="3,2" />
        <text x="0" y="-4" textAnchor="middle" fill="#94a3b8" fontSize="9">⚙ {name}</text>
        <text x="0" y="12" textAnchor="middle" fill="#64748b" fontSize="8">{task}</text>
    </g>
);

// Fleet container
const FleetBox = ({ x, y, width, height, phase, name, meshType, color, children }: { x: number; y: number; width: number; height: number; phase: string; name: string; meshType: string; color: string; children: React.ReactNode }) => {
    const colors: Record<string, string> = {
        blue: '#3b82f6',
        purple: '#8b5cf6',
        amber: '#f59e0b',
        rose: '#f43f5e',
    };
    const borderColor = colors[color] || '#64748b';
    return (
        <g transform={`translate(${x}, ${y})`}>
            <rect x="0" y="0" width={width} height={height} rx="10" fill="#0f172a" stroke={borderColor} strokeWidth="2" opacity="0.95" />
            <text x="15" y="25" fill={borderColor} fontWeight="bold" fontSize="12">{phase}: {name}</text>
            <text x="15" y="42" fill="#64748b" fontSize="9">({meshType})</text>
            {children}
        </g>
    );
};

export const VibecodingWorkflowDiagram = () => {
    return (
        <div className="w-full bg-slate-900/50 rounded-xl border border-slate-800 p-6 flex items-center justify-center overflow-x-auto relative group">
            {/* Background Grid */}
            <div className="absolute inset-0 opacity-15 pointer-events-none rounded-xl"
                style={{ backgroundImage: 'radial-gradient(circle at 2px 2px, rgba(6,182,212,0.15) 1px, transparent 0)', backgroundSize: '24px 24px' }}
            />

            <svg width="1600" height="1000" viewBox="0 0 1600 1000" className="min-w-[1600px]">
                <defs>
                    <filter id="glow-gold" x="-50%" y="-50%" width="200%" height="200%">
                        <feGaussianBlur stdDeviation="4" result="coloredBlur" />
                        <feMerge><feMergeNode in="coloredBlur" /><feMergeNode in="SourceGraphic" /></feMerge>
                    </filter>
                    <filter id="glow-cyan" x="-50%" y="-50%" width="200%" height="200%">
                        <feGaussianBlur stdDeviation="5" result="coloredBlur" />
                        <feMerge><feMergeNode in="coloredBlur" /><feMergeNode in="SourceGraphic" /></feMerge>
                    </filter>
                    <marker id="arrow-gold" markerWidth="10" markerHeight="7" refX="8" refY="3.5" orient="auto">
                        <polygon points="0 0, 10 3.5, 0 7" fill="#fbbf24" />
                    </marker>
                    <marker id="arrow-green" markerWidth="10" markerHeight="7" refX="8" refY="3.5" orient="auto">
                        <polygon points="0 0, 10 3.5, 0 7" fill="#22c55e" />
                    </marker>
                    <marker id="arrow-red" markerWidth="10" markerHeight="7" refX="8" refY="3.5" orient="auto">
                        <polygon points="0 0, 10 3.5, 0 7" fill="#ef4444" />
                    </marker>
                    <marker id="arrow-slate" markerWidth="10" markerHeight="7" refX="8" refY="3.5" orient="auto">
                        <polygon points="0 0, 10 3.5, 0 7" fill="#94a3b8" />
                    </marker>
                </defs>

                {/* ========== USER INPUT ========== */}
                <g transform="translate(800, 50)">
                    <circle cx="0" cy="0" r="40" fill="#0f172a" stroke="#06b6d4" strokeWidth="2.5" filter="url(#glow-cyan)" />
                    <text x="0" y="5" textAnchor="middle" fill="#06b6d4" fontWeight="bold" fontSize="13">User Input</text>
                </g>
                <path d="M800,90 L800,140" stroke="#06b6d4" strokeWidth="2" strokeDasharray="5,4" markerEnd="url(#arrow-slate)" />

                {/* ========== NEXUS PRIME (Supervisor) ========== */}
                <g transform="translate(800, 200)">
                    <polygon points="0,-60 80,0 0,60 -80,0" fill="#1a1a2e" stroke="#fbbf24" strokeWidth="3" filter="url(#glow-gold)" />
                    <text x="0" y="-18" textAnchor="middle" fill="#fbbf24" fontWeight="bold" fontSize="13">NEXUS PRIME</text>
                    <text x="0" y="0" textAnchor="middle" fill="#d4a574" fontSize="9">Claude Opus 4.5</text>
                    <text x="0" y="15" textAnchor="middle" fill="#a78bfa" fontSize="9">The CEO & Router</text>
                </g>

                {/* ========== DELEGATION LINES FROM NEXUS PRIME ========== */}
                {/* To Research Fleet */}
                <path d="M720,200 L200,320" stroke="#fbbf24" strokeWidth="2" markerEnd="url(#arrow-gold)" opacity="0.8" />
                <text x="420" y="235" fill="#fbbf24" fontSize="10" textAnchor="middle">1. Research</text>

                {/* To Architect Fleet */}
                <path d="M750,250 L550,340" stroke="#fbbf24" strokeWidth="2" markerEnd="url(#arrow-gold)" opacity="0.8" />
                <text x="610" y="310" fill="#fbbf24" fontSize="10" textAnchor="middle">2. Planning</text>

                {/* To Builder Fleet */}
                <path d="M850,250 L1020,340" stroke="#fbbf24" strokeWidth="2" markerEnd="url(#arrow-gold)" opacity="0.8" />
                <text x="980" y="310" fill="#fbbf24" fontSize="10" textAnchor="middle">3. Build</text>

                {/* To Auditor Fleet */}
                <path d="M880,200 L1400,320" stroke="#fbbf24" strokeWidth="2" markerEnd="url(#arrow-gold)" opacity="0.8" />
                <text x="1180" y="235" fill="#fbbf24" fontSize="10" textAnchor="middle">4. Audit</text>

                {/* ========== REJECTION LOOPBACK (center, goes back up to Nexus Prime) ========== */}
                <path d="M800,260 L800,290 Q800,300 790,300 L700,300 Q680,300 680,280 L680,220 Q680,200 700,200 L720,200"
                    stroke="#ef4444" strokeWidth="2" strokeDasharray="6,4" markerEnd="url(#arrow-red)" fill="none" />
                <text x="640" y="255" fill="#ef4444" fontSize="9" textAnchor="end">✗ REJECTED:</text>
                <text x="640" y="268" fill="#ef4444" fontSize="9" textAnchor="end">Retry w/ Critique</text>

                {/* ========== APPROVAL FLOW ========== */}
                <path d="M880,185 L1100,100 L1250,100" stroke="#22c55e" strokeWidth="2.5" markerEnd="url(#arrow-green)" />
                <text x="1000" y="85" fill="#22c55e" fontSize="11" fontWeight="bold">✓ APPROVED: Merge</text>

                {/* Deploy */}
                <g transform="translate(1330, 100)">
                    <circle cx="0" cy="0" r="38" fill="#14532d" stroke="#22c55e" strokeWidth="2.5" strokeDasharray="5,3" />
                    <text x="0" y="5" textAnchor="middle" fill="#22c55e" fontSize="11" fontWeight="bold">✓ DEPLOY</text>
                </g>

                {/* ========== PHASE 0: RESEARCH FLEET ========== */}
                <FleetBox x={20} y={340} width={360} height={460} phase="PHASE 0" name="RESEARCH FLEET" meshType="Gemini Mesh" color="blue">
                    {/* Start node */}
                    <circle cx="50" cy="80" r="22" fill="transparent" stroke="#64748b" strokeWidth="1.5" />
                    <text x="50" y="85" textAnchor="middle" fill="#94a3b8" fontSize="10">Start</text>

                    {/* Arrow to Scoper */}
                    <path d="M72,80 L120,80" stroke="#64748b" strokeWidth="1.5" markerEnd="url(#arrow-slate)" />

                    {/* Scoper */}
                    <AgentNode x={195} y={80} name="Scoper" model="Gemini 3 Pro" task="Define Queries" color="blue" />

                    {/* Main flow from Scoper down to Professor */}
                    <path d="M195,112 L195,145 L100,145 L100,168" stroke="#64748b" strokeWidth="1.5" markerEnd="url(#arrow-slate)" />

                    {/* Professor (for relevance check) */}
                    <AgentNode x={100} y={200} name="The Professor" model="Gemini 3 Flash" task="Relevance Check" color="blue" />

                    {/* Executor */}
                    <AgentNode x={270} y={200} name="Executor" model="Gemini 3 Pro" task="Web Search/Scrape" color="blue" />

                    {/* Rejection loopback from Professor to Scoper */}
                    <path d="M40,200 L20,200 Q5,200 5,185 L5,100 Q5,80 25,80 L135,80" stroke="#ef4444" strokeWidth="1.5" strokeDasharray="4,3" markerEnd="url(#arrow-red)" fill="none" />
                    <text x="15" y="140" fill="#ef4444" fontSize="8">✗ Reject</text>

                    {/* Approval from Professor to Executor */}
                    <path d="M160,200 L208,200" stroke="#22c55e" strokeWidth="1.5" markerEnd="url(#arrow-green)" />
                    <text x="185" y="190" fill="#22c55e" fontSize="8">✓ Approve</text>

                    {/* Arrow from Executor to Synthesizer */}
                    <path d="M270,232 L270,280 L195,280 L195,310" stroke="#64748b" strokeWidth="1.5" markerEnd="url(#arrow-slate)" />

                    {/* Synthesizer */}
                    <AgentNode x={195} y={350} name="Synthesizer" model="Gemini 3 Pro" task="Compile Report" color="blue" />

                    {/* Arrow to DOSSIER */}
                    <path d="M195,382 L195,420" stroke="#f59e0b" strokeWidth="2" markerEnd="url(#arrow-gold)" />
                </FleetBox>

                {/* DOSSIER Artifact */}
                <ArtifactNode x={215} y={840} name="DOSSIER.md" items={['1. API Documentation', '2. Design Patterns', '3. Library Versions']} />


                {/* ========== PHASE 1: ARCHITECT FLEET ========== */}
                <FleetBox x={410} y={340} width={360} height={460} phase="PHASE 1" name="ARCHITECT FLEET" meshType="Gemini Mesh" color="purple">
                    {/* Start node */}
                    <circle cx="50" cy="80" r="22" fill="transparent" stroke="#64748b" strokeWidth="1.5" />
                    <text x="50" y="85" textAnchor="middle" fill="#94a3b8" fontSize="10">Start</text>

                    {/* Arrow to Cartographer */}
                    <path d="M72,80 L130,80" stroke="#64748b" strokeWidth="1.5" markerEnd="url(#arrow-slate)" />

                    {/* Cartographer */}
                    <AgentNode x={205} y={80} name="Cartographer" model="Gemini 3 Pro" task="Read Dossier + Repo" color="purple" />

                    {/* Arrow to Drafter */}
                    <path d="M205,112 L205,170" stroke="#64748b" strokeWidth="1.5" markerEnd="url(#arrow-slate)" />

                    {/* Drafter */}
                    <AgentNode x={205} y={210} name="Drafter" model="Gemini 3 Pro" task="Write Spec" color="purple" />

                    {/* Arrow to Grounder */}
                    <path d="M205,242 L205,300" stroke="#64748b" strokeWidth="1.5" markerEnd="url(#arrow-slate)" />

                    {/* Grounder */}
                    <AgentNode x={205} y={340} name="Grounder" model="Gemini 3 Flash" task="Validate File Paths" color="purple" />

                    {/* Hallucination loopback from Grounder to Drafter */}
                    <path d="M145,340 L100,340 Q85,340 85,325 L85,230 Q85,210 105,210 L145,210" stroke="#ef4444" strokeWidth="1.5" strokeDasharray="4,3" markerEnd="url(#arrow-red)" fill="none" />
                    <text x="70" y="280" fill="#ef4444" fontSize="8" textAnchor="end">✗ Hallucination</text>

                    {/* Validated arrow to Blueprint */}
                    <path d="M205,372 L205,420" stroke="#22c55e" strokeWidth="2" markerEnd="url(#arrow-green)" />
                    <text x="205" y="400" fill="#22c55e" fontSize="9" textAnchor="middle">✓ Validated</text>
                </FleetBox>

                {/* BLUEPRINT Artifact */}
                <ArtifactNode x={590} y={840} name="BLUEPRINT" items={['1. SPEC.md - Logic', '2. MANIFEST.json - Files', '3. DDB.json - Audit Rules']} />


                {/* ========== PHASE 2: BUILDER FLEET ========== */}
                <FleetBox x={810} y={340} width={360} height={460} phase="PHASE 2" name="BUILDER FLEET" meshType="Implementation" color="amber">
                    {/* Start node */}
                    <circle cx="50" cy="80" r="22" fill="transparent" stroke="#64748b" strokeWidth="1.5" />
                    <text x="50" y="85" textAnchor="middle" fill="#94a3b8" fontSize="10">Start</text>

                    {/* Arrow to Loader */}
                    <path d="M72,80 L120,80" stroke="#64748b" strokeWidth="1.5" markerEnd="url(#arrow-slate)" />

                    {/* System: Loader */}
                    <SystemNode x={205} y={80} name="System: Loader" task="Pre-load Files from Manifest" />

                    {/* Arrow to Scout */}
                    <path d="M205,102 L205,150" stroke="#64748b" strokeWidth="1.5" markerEnd="url(#arrow-slate)" />

                    {/* Scout */}
                    <AgentNode x={205} y={190} name="Scout" model="Gemini 3 Pro" task="Navigate Symbols" color="amber" />

                    {/* Arrow to Builder */}
                    <path d="M205,222 L205,270" stroke="#64748b" strokeWidth="1.5" markerEnd="url(#arrow-slate)" />

                    {/* Builder */}
                    <AgentNode x={205} y={310} name="Builder" model="Gemini 3 Pro" task="Vibe Coding" color="amber" />

                    {/* Arrow to Syntax */}
                    <path d="M205,342 L205,385" stroke="#64748b" strokeWidth="1.5" markerEnd="url(#arrow-slate)" />

                    {/* System: Syntax */}
                    <SystemNode x={205} y={410} name="System: Syntax" task="AST Check / Linter" />

                    {/* Syntax Error loopback from Syntax to Builder */}
                    <path d="M140,410 L100,410 Q85,410 85,395 L85,330 Q85,310 105,310 L145,310" stroke="#ef4444" strokeWidth="1.5" strokeDasharray="4,3" markerEnd="url(#arrow-red)" fill="none" />
                    <text x="70" y="365" fill="#ef4444" fontSize="8" textAnchor="end">✗ Syntax Error</text>

                    {/* Compiles arrow */}
                    <path d="M270,410 L310,410 L310,430" stroke="#22c55e" strokeWidth="2" markerEnd="url(#arrow-green)" />
                    <text x="310" y="420" fill="#22c55e" fontSize="9" textAnchor="middle">✓ Compiles</text>
                </FleetBox>

                {/* SOURCE ARTIFACTS */}
                <ArtifactNode x={1020} y={840} name="SOURCE ARTIFACTS" items={['1. Updated Files', '2. DIFF.patch']} />


                {/* ========== PHASE 3: AUDITOR FLEET ========== */}
                <FleetBox x={1210} y={340} width={370} height={460} phase="PHASE 3" name="AUDITOR FLEET" meshType="Adversarial Mesh" color="rose">
                    {/* Start node */}
                    <circle cx="50" cy="80" r="22" fill="transparent" stroke="#64748b" strokeWidth="1.5" />
                    <text x="50" y="85" textAnchor="middle" fill="#94a3b8" fontSize="10">Start</text>

                    {/* Arrow to Blast Calc */}
                    <path d="M72,80 L130,80" stroke="#64748b" strokeWidth="1.5" markerEnd="url(#arrow-slate)" />

                    {/* System: Blast Calc */}
                    <SystemNode x={215} y={80} name="System: Blast Calc" task="Generate Dependency Graph" />

                    {/* Dependency Map label */}
                    <text x="215" y="125" fill="#64748b" fontSize="9" textAnchor="middle">↓ Dependency Map</text>

                    {/* Arrow to Sentinel */}
                    <path d="M215,135 L215,165" stroke="#64748b" strokeWidth="1.5" markerEnd="url(#arrow-slate)" />

                    {/* The Sentinel */}
                    <AgentNode x={215} y={205} name="The Sentinel" model="Claude Opus 4.5" task="Security Analysis" color="rose" />

                    {/* Arrow to Interrogator */}
                    <path d="M215,237 L215,285" stroke="#64748b" strokeWidth="1.5" markerEnd="url(#arrow-slate)" />
                    <text x="215" y="268" fill="#f59e0b" fontSize="8" textAnchor="middle">Suspicious?</text>

                    {/* The Interrogator */}
                    <AgentNode x={215} y={325} name="The Interrogator" model="Claude Opus 4.5" task="Dry-Run Tests" color="rose" />

                    {/* Test Results label */}
                    <text x="290" y={315} fill="#94a3b8" fontSize="8">Test Results →</text>

                    {/* Arrow to Audit Report */}
                    <path d="M215,357 L215,420" stroke="#f59e0b" strokeWidth="2" markerEnd="url(#arrow-gold)" />
                </FleetBox>

                {/* AUDIT REPORT Artifact */}
                <ArtifactNode x={1395} y={840} name="AUDIT REPORT" items={['1. Status: PASS or FAIL', '2. Blocking Issues List', '3. Security Score']} />

                {/* ========== LEGEND ========== */}
                <g transform="translate(30, 930)">
                    <rect x="0" y="0" width="500" height="55" rx="8" fill="#0f172a" stroke="#334155" strokeWidth="1.5" />
                    <text x="20" y="25" fill="#94a3b8" fontSize="12" fontWeight="bold">LEGEND:</text>
                    <circle cx="120" cy="28" r="12" fill="#1e3a5f" stroke="#3b82f6" strokeWidth="1.5" />
                    <text x="140" y="32" fill="#94a3b8" fontSize="10">AI Agent</text>
                    <rect x="210" y="16" width="30" height="24" fill="transparent" stroke="#64748b" strokeWidth="1.5" strokeDasharray="3,2" />
                    <text x="250" y="32" fill="#94a3b8" fontSize="10">System Tool</text>
                    <polygon points="360,28 380,16 400,28 380,40" fill="#422006" stroke="#f59e0b" strokeWidth="1.5" />
                    <text x="415" y="32" fill="#94a3b8" fontSize="10">Artifact</text>
                </g>

                {/* Figure label */}
                <text x="1580" y="980" textAnchor="end" fill="#475569" fontSize="11" fontFamily="monospace">FIG 1.1 - PRIMARY VIBECODING WORKFLOW (DETAILED)</text>
            </svg>
        </div>
    );
};

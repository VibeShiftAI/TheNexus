/**
 * MissionBrief — the hero block of the project screen. Reads like a starship
 * mission briefing: designation + classification on the left with the mission
 * directive (end state), acceptance criteria, and outstanding needs; a live
 * readout column of pulse stats on the right.
 */
"use client";

import type { Project, ProjectBrief } from "@/lib/nexus";
import { CornerBrackets } from "@/components/bridge/hud";
import { ActivityLed, activityBand, BAND_STYLES, timeAgo } from "@/components/pulse-visuals";
import { Crosshair, ListChecks, CircleAlert, Tag } from "lucide-react";

function Readout({ label, value, tone, sub }: { label: string; value: React.ReactNode; tone?: string; sub?: string }) {
    return (
        <div className="rounded-md border border-slate-800 bg-slate-950/60 px-3 py-2">
            <div className="text-[9px] uppercase tracking-widest text-slate-600">{label}</div>
            <div className={`text-base font-bold tabular-nums leading-tight ${tone ?? "text-slate-200"}`}>{value}</div>
            {sub && <div className="truncate text-[10px] text-slate-500">{sub}</div>}
        </div>
    );
}

export function fmtTokensShort(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
    return String(n);
}

export function MissionBrief({ project, brief }: { project: Project; brief: ProjectBrief | null }) {
    const band = activityBand(brief?.lastActivityAt);
    const bandStyle = BAND_STYLES[band];
    const directive = project.end_state?.trim() || project.description?.trim() || "No mission directive on file.";
    const criteria = (project.end_state_criteria ?? []).filter(c => c.enabled !== false);
    const openNeeds = (project.needs ?? []).filter(n => n.status === "open");
    const crew = brief?.crew;

    return (
        <section className="hud-scanlines relative overflow-hidden rounded-xl border border-slate-800 bg-gradient-to-br from-slate-900/70 via-slate-950/80 to-slate-950/90">
            <CornerBrackets accent="cyan" />
            <span className="pointer-events-none absolute inset-x-6 top-0 h-px bg-gradient-to-r from-transparent via-cyan-400/50 to-transparent" />
            {/* faint radial glow behind the designation */}
            <span className="pointer-events-none absolute -top-24 left-1/4 h-56 w-[36rem] rounded-full bg-cyan-500/5 blur-3xl" />

            <div className="relative grid gap-6 p-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
                {/* Directive column */}
                <div className="min-w-0">
                    <div className="mb-1 flex items-center gap-2.5">
                        <ActivityLed band={band} />
                        <h1 className="truncate text-2xl font-bold tracking-tight text-white">{project.name}</h1>
                    </div>
                    <div className="mb-4 flex flex-wrap items-center gap-2 pl-[18px] text-[10px] uppercase tracking-widest">
                        <span className="text-slate-500">{project.type}</span>
                        <span className={`font-semibold ${bandStyle.text}`}>{bandStyle.label}</span>
                        {project.status && project.status !== "active" && (
                            <span className="rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-amber-300">{project.status}</span>
                        )}
                        {typeof project.priority === "number" && project.priority !== 0 && (
                            <span className={project.priority > 0 ? "text-cyan-300" : "text-slate-600"}>
                                priority {project.priority > 0 ? `+${project.priority}` : project.priority}
                            </span>
                        )}
                    </div>

                    <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-cyan-400/90">
                        <Crosshair size={11} />
                        Mission directive
                    </div>
                    <p className="whitespace-pre-line text-sm leading-relaxed text-slate-300">{directive}</p>

                    {criteria.length > 0 && (
                        <div className="mt-4">
                            <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-emerald-400/90">
                                <ListChecks size={11} />
                                Acceptance criteria
                            </div>
                            <ul className="space-y-1">
                                {criteria.map(c => (
                                    <li key={c.id} className="flex items-start gap-2 text-xs text-slate-400">
                                        <span className="mt-1 h-1 w-1 shrink-0 rounded-full bg-emerald-500/70" />
                                        <span className="min-w-0">
                                            {c.description}
                                            <span className="ml-1.5 font-mono text-[10px] text-slate-600">[{c.kind}]</span>
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}

                    {openNeeds.length > 0 && (
                        <div className="mt-4">
                            <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-amber-400/90">
                                <CircleAlert size={11} />
                                Outstanding needs
                            </div>
                            <ul className="space-y-1">
                                {openNeeds.map(n => (
                                    <li key={n.id} className="flex items-start gap-2 text-xs text-amber-200/80">
                                        <span className="mt-1 h-1 w-1 shrink-0 rounded-full bg-amber-400/80" />
                                        <span className="min-w-0">
                                            {n.description}
                                            <span className="ml-1.5 font-mono text-[10px] text-amber-500/60">[{n.kind}]</span>
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}

                    {Array.isArray(project.tags) && project.tags.length > 0 && (
                        <div className="mt-4 flex flex-wrap gap-1.5">
                            {project.tags.map(tag => (
                                <span key={tag} className="flex items-center gap-1 rounded border border-slate-800 bg-slate-900/80 px-1.5 py-0.5 text-[10px] text-slate-500">
                                    <Tag size={9} />
                                    {tag}
                                </span>
                            ))}
                        </div>
                    )}
                </div>

                {/* Readout column */}
                <div className="min-w-0">
                    <div className="mb-2 text-[10px] font-bold uppercase tracking-widest text-slate-500">
                        Status readout
                    </div>
                    <div className="grid grid-cols-2 gap-2 xl:grid-cols-3">
                        <Readout
                            label="Last contact"
                            value={brief?.lastActivityAt ? `Δ ${timeAgo(brief.lastActivityAt)}` : "—"}
                            tone={bandStyle.text}
                        />
                        <Readout
                            label="Ops active"
                            value={brief ? brief.tasks.active + (crew?.running ?? 0) : "—"}
                            tone={brief && (brief.tasks.active + (crew?.running ?? 0)) > 0 ? "text-cyan-300" : undefined}
                            sub={brief?.tasks.activeNames[0]}
                        />
                        <Readout
                            label="Needs input"
                            value={brief ? brief.tasks.attention : "—"}
                            tone={brief && brief.tasks.attention > 0 ? "text-amber-300" : undefined}
                        />
                        <Readout
                            label="Done · 7d"
                            value={brief ? brief.tasks.done7d : "—"}
                            tone={brief && brief.tasks.done7d > 0 ? "text-emerald-300" : undefined}
                        />
                        <Readout
                            label="Queued"
                            value={brief ? brief.tasks.queued : "—"}
                        />
                        <Readout
                            label="Tokens · 7d"
                            value={crew ? fmtTokensShort(crew.tokens7d) : "—"}
                            sub={crew && crew.tokens24h > 0 ? `${fmtTokensShort(crew.tokens24h)} in 24h` : undefined}
                            tone="text-purple-300"
                        />
                    </div>

                    {crew?.last && (
                        <div className="mt-2 rounded-md border border-slate-800 bg-slate-950/60 px-3 py-2">
                            <div className="text-[9px] uppercase tracking-widest text-slate-600">Last crew run</div>
                            <div className="mt-0.5 flex items-center gap-2 text-xs">
                                <span className={
                                    crew.last.outcome === "success" ? "text-emerald-400"
                                        : crew.last.outcome === "failure" || crew.last.outcome === "timeout" ? "text-red-400"
                                            : crew.last.outcome === "running" ? "text-cyan-300"
                                                : "text-slate-400"
                                }>
                                    {crew.last.outcome}
                                </span>
                                <span className="truncate font-mono text-slate-400">
                                    {crew.last.executor}
                                    {crew.last.model ? ` · ${crew.last.model}` : ""}
                                </span>
                                <span className="ml-auto shrink-0 text-slate-600">Δ {timeAgo(crew.last.at)}</span>
                            </div>
                            {crew.last.taskName && (
                                <div className="mt-0.5 truncate text-[11px] text-slate-500">{crew.last.taskName}</div>
                            )}
                        </div>
                    )}
                </div>
            </div>
        </section>
    );
}

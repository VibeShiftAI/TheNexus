"use client";

import { useMemo, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";
import {
    COMPONENT_FILTERS, EDGE_OUT, EXTERNAL_APIS_ID, ROUTE_SERVICES, SEVERITY_LABEL, SIBLING_CLASSES, SYSTEMS,
    buildDiagram, buildTimeline, compactCount, cronState, cronWhere, driftChecks, filterCrons, filterRoutes, formatCount,
    matchesNode, nodeName, siblingEvidence, sortCrons, stalestDocs, strongestLinks, systemMatrix, systemOf, systemSections,
    tunnelServedBy, warningCount,
    type ComponentFilter, type MapIndex, type MapNode,
} from "@/lib/system-map";
import { NodeLink, StateMark, Swatch, type PairDetail, type SelectNode } from "./system-map-panel";

interface TabProps {
    index: MapIndex;
    query: string;
    selectedId: string | null;
    onSelect: SelectNode;
    onPair: (pair: PairDetail, keyboard: boolean) => void;
}

type Tip = { x: number; y: number; title: string; lines: string[] } | null;

const sysVar = (key: string) => ({ "--sm-sysc": `var(--sm-c-${key})` }) as CSSProperties;
const isActivation = (key: string) => key === "Enter" || key === " ";

function Tooltip({ tip }: { tip: Tip }) {
    if (!tip) return null;
    return (
        <div className="sm-tip" role="tooltip" style={{ left: tip.x, top: tip.y }}>
            <b>{tip.title}</b>
            {tip.lines.map((line, i) => <div key={i}>{line}</div>)}
        </div>
    );
}

/** Keep the tooltip on screen beside the pointer. */
function tipAt(ev: ReactMouseEvent, title: string, lines: string[]): Tip {
    const x = Math.max(8, Math.min(ev.clientX + 14, window.innerWidth - 348));
    return { x, y: ev.clientY + 16, title, lines };
}

// ───────────────────────────────────────────────────────────── Map: service diagram

function ServiceDiagram({ index, selectedId, onSelect, onPair }: Omit<TabProps, "query">) {
    const diagram = useMemo(() => buildDiagram(index), [index]);
    const [focusId, setFocusId] = useState<string | null>(null);
    const [tip, setTip] = useState<Tip>(null);
    const near = useMemo(() => {
        const set = new Set<string>();
        if (focusId) for (const e of diagram.edges) { if (e.from === focusId) set.add(e.to); if (e.to === focusId) set.add(e.from); }
        return set;
    }, [diagram, focusId]);

    const activate = (id: string, keyboard: boolean) => {
        if (id !== EXTERNAL_APIS_ID) { onSelect(id, { reveal: true, keyboard }); return; }
        const edges = diagram.edges.filter((e) => e.from === id || e.to === id).flatMap((e) => e.edges);
        onPair({ title: "External APIs", summary: `Outside services found in code that have no box of their own. ${formatCount(edges.reduce((n, e) => n + e.count, 0))} references.`, edges }, keyboard);
    };

    return (
        <>
            <div className="sm-scroll sm-diagram" role="group" aria-label="Service diagram. Scroll sideways to see every column." tabIndex={0} data-sm-diagram="">
                <svg viewBox={`0 0 ${diagram.width} ${diagram.height}`} data-focus={focusId ? "true" : "false"}>
                    <title>Service diagram: processes, clients, stores and dependencies, and how they connect</title>
                    <defs>
                        <marker id="sm-arr" viewBox="0 0 8 8" refX="7.5" refY="4" markerWidth="7" markerHeight="7" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
                            <path d="M0,0 L8,4 L0,8 z" style={{ fill: "var(--sm-muted)" }} />
                        </marker>
                        <marker id="sm-arr-on" viewBox="0 0 8 8" refX="7.5" refY="4" markerWidth="7" markerHeight="7" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
                            <path d="M0,0 L8,4 L0,8 z" style={{ fill: "var(--sm-sel)" }} />
                        </marker>
                    </defs>
                    {diagram.titles.map((t, i) => (
                        <text key={t} className="sm-d-col" x={i * diagram.columnWidth + diagram.columnWidth / 2} y={20} textAnchor="middle">{t}</text>
                    ))}
                    <g>
                        {diagram.edges.map((e) => {
                            const on = Boolean(focusId) && (e.from === focusId || e.to === focusId);
                            const title = `${nodeName(index, e.from)} → ${nodeName(index, e.to)}`;
                            return (
                                <g key={`${e.from}|${e.to}`}>
                                    <path className="sm-d-edge" data-on={on ? "true" : "false"} d={e.d} strokeWidth={e.width.toFixed(1)} markerEnd={on ? "url(#sm-arr-on)" : "url(#sm-arr)"} />
                                    <path className="sm-d-hit" d={e.d}
                                        onMouseMove={(ev) => setTip(tipAt(ev, title, e.kinds.map(([k, c]) => `${EDGE_OUT[k] ?? k}: ${formatCount(c)}`)))}
                                        onMouseLeave={() => setTip(null)}
                                        onClick={() => onPair({ title, summary: `${formatCount(e.count)} references across ${e.edges.length} component pairs.`, edges: e.edges }, false)} />
                                </g>
                            );
                        })}
                    </g>
                    <g>
                        {diagram.nodes.map((n) => {
                            const label = `${n.name}${n.sub ? `, ${n.sub}` : ""}. Show detail.`;
                            return (
                                <g key={n.id} className="sm-d-node" role="button" tabIndex={0} aria-label={label} aria-pressed={selectedId === n.id}
                                    data-sm-diagram-node={n.id} data-on={focusId === n.id || selectedId === n.id ? "true" : "false"} data-near={near.has(n.id) ? "true" : "false"}
                                    transform={`translate(${n.x},${n.y})`}
                                    onMouseEnter={() => setFocusId(n.id)} onMouseLeave={() => setFocusId(null)}
                                    onFocus={() => setFocusId(n.id)} onBlur={() => setFocusId(null)}
                                    onClick={(ev) => activate(n.id, ev.detail === 0)}
                                    onKeyDown={(ev) => { if (isActivation(ev.key)) { ev.preventDefault(); activate(n.id, true); } }}>
                                    <rect className="sm-box" width={diagram.boxWidth} height={diagram.boxHeight} rx={6} />
                                    <rect width={4} height={diagram.boxHeight} rx={2} style={{ fill: `var(--sm-c-${n.system})` }} />
                                    <text x={12} y={n.sub ? 16 : 23}>{n.label}</text>
                                    {n.sub ? <text className="sm-sub" x={12} y={30}>{n.sub}</text> : null}
                                </g>
                            );
                        })}
                    </g>
                </svg>
            </div>
            {diagram.undrawn ? (
                <p className="sm-small sm-muted" data-sm-undrawn="">
                    {formatCount(diagram.undrawn)} more references end on a repo or loose folder rather than one of these boxes. They are counted under Connections.
                </p>
            ) : null}
            <Tooltip tip={tip} />
        </>
    );
}

// ───────────────────────────────────────────────────────────── Map: components

function Tile({ node, maxLines, selected, near, hidden, onSelect }: {
    node: MapNode; maxLines: number; selected: boolean; near: "out" | "in" | null; hidden: boolean; onSelect: SelectNode;
}) {
    if (hidden) return null;
    const a = node.attrs ?? {};
    const meta: string[] = [];
    if (a.lines) meta.push(`${compactCount(a.lines)} lines`);
    if (a.commits90d !== undefined && a.files) meta.push(`${a.commits90d} commits/90d`);
    if (a.references) meta.push(`${a.references} refs`);
    if (a.ports?.length) meta.push(`:${a.ports.join(" :")}`);
    if (a.count) meta.push(`${a.count} projects`);
    const tags: string[] = [];
    if (a.routeCount) tags.push(`${a.routeCount} routes`);
    if (a.jobs) tags.push(`${a.jobs} jobs`);
    if (a.agentTools) tags.push(`${a.agentTools} tools`);
    if (a.mcpTools) tags.push(`${a.mcpTools} MCP tools`);
    const relation = near === "out" ? " Reached by the selected component." : near === "in" ? " Reaches the selected component." : "";
    return (
        <button type="button" className="sm-tile" data-sm-id={node.id} data-near={near ?? undefined} aria-pressed={selected}
            title={node.path || node.id} style={sysVar(systemOf(node.id))}
            onClick={(e) => onSelect(node.id, { keyboard: e.detail === 0 })}>
            <span className="sm-nm">{node.name}</span>
            <span className="sm-pp" data-none={node.purpose ? undefined : "true"}>{node.purpose || "no purpose line yet"}</span>
            <span className="sm-meta">{tags.map((t) => <span key={t} className="sm-tag">{t}</span>)}{meta.join(" · ")}</span>
            {relation ? <span className="sm-sr">{relation}</span> : null}
            {a.lines && maxLines ? <span className="sm-bar" style={{ width: `${Math.max(3, Math.round(100 * Math.sqrt(a.lines / maxLines)))}%` }} /> : null}
        </button>
    );
}

export function MapTab({ index, query, selectedId, onSelect, onPair }: TabProps) {
    const [filter, setFilter] = useState<ComponentFilter>("all");
    const sections = useMemo(() => systemSections(index), [index]);
    const { outs, ins } = useMemo(() => ({
        outs: new Set((selectedId ? index.outgoing.get(selectedId) ?? [] : []).map((e) => e.to)),
        ins: new Set((selectedId ? index.incoming.get(selectedId) ?? [] : []).map((e) => e.from)),
    }), [index, selectedId]);
    const narrowed = Boolean(query) || filter !== "all";
    const tile = (n: MapNode, maxLines: number) => (
        <Tile key={n.id} node={n} maxLines={maxLines} selected={selectedId === n.id}
            near={outs.has(n.id) ? "out" : ins.has(n.id) ? "in" : null}
            hidden={!matchesNode(n, query, filter)} onSelect={onSelect} />
    );
    let shown = 0;
    const rendered = sections.map(({ system, flat, blocks, maxLines }) => {
        let body;
        if (flat) {
            const visible = flat.filter((n) => matchesNode(n, query, filter));
            shown += visible.length;
            if (narrowed && !visible.length) return null;
            body = <div className="sm-tiles">{flat.map((n) => tile(n, 0))}</div>;
        } else {
            const blockEls = blocks.map((block) => {
                const visible = block.components.filter((n) => matchesNode(n, query, filter));
                // A process that matches by its own name stays, with or without matching components.
                const processMatches = Boolean(block.process && matchesNode(block.process, query, filter));
                if (narrowed && !visible.length && !processMatches) return null;
                shown += visible.length || (processMatches ? 1 : 0);
                const p = block.process;
                const started = p?.attrs?.launchd ? `launchd ${p.attrs.launchd}` : p?.attrs?.supervisedBy ? "started by the Praxis supervisor" : "";
                const meta = p ? [(p.attrs?.ports ?? []).map((x) => `:${x}`).join(" "), started, block.components.length ? `${block.components.length} components` : ""].filter(Boolean).join(" · ") : "";
                return (
                    <div className="sm-proc" key={p?.id ?? block.title}>
                        <div className="sm-proc-h">
                            {p ? <NodeLink index={index} id={p.id} onSelect={onSelect} /> : <b>{block.title}</b>}
                            {p ? <StateMark node={p} /> : null}
                            {meta ? <span className="sm-meta">{meta}</span> : null}
                        </div>
                        {block.components.length ? <div className="sm-tiles">{block.components.map((n) => tile(n, maxLines))}</div> : null}
                    </div>
                );
            });
            if (narrowed && blockEls.every((b) => b === null)) return null;
            body = blockEls;
        }
        return (
            <section className="sm-sys" key={system.key} style={sysVar(system.key)} aria-label={system.label}>
                <h2>{system.label}</h2>
                <p className="sm-sysnote">{system.note}</p>
                {body}
            </section>
        );
    });

    return (
        <div>
            <h2>Services</h2>
            <p className="sm-lead">Each box is a process, client, data store or outside dependency. Line weight is the number of call sites or references found in code, not traffic. Point at or focus a box to isolate its connections; select one for detail.</p>
            <div className="sm-legend">{SYSTEMS.map((s) => <span key={s.key}><span className="sm-sw" style={sysVar(s.key)} aria-hidden="true" />{s.label}</span>)}</div>
            <ServiceDiagram index={index} selectedId={selectedId} onSelect={onSelect} onPair={onPair} />

            <h2>Components</h2>
            <p className="sm-lead">Every subsystem, route module, service, page and dependency. The bar under a tile is its size in lines relative to the largest in its system. Select a tile to see what it reaches (solid outline) and what reaches it (dashed outline).</p>
            <div className="sm-chips" role="group" aria-label="Filter components">
                {COMPONENT_FILTERS.map(([key, label]) => (
                    <button type="button" key={key} className="sm-chip" aria-pressed={filter === key} onClick={() => setFilter(key)}>{label}</button>
                ))}
            </div>
            <div data-sm-components="" data-sm-has-sel={selectedId ? "true" : "false"}>
                {rendered}
                {narrowed && shown === 0 ? <p className="sm-empty">No component matches.</p> : null}
            </div>
        </div>
    );
}

// ───────────────────────────────────────────────────────────── Connections

export function ConnectionsTab({ index, query, onSelect, onPair }: TabProps) {
    const matrix = useMemo(() => systemMatrix(index.map), [index]);
    const links = useMemo(() => strongestLinks(index, query), [index, query]);
    const catalogs = index.map.catalogs;
    const sharedEnv = (catalogs.env ?? []).filter((x) => (x.systems ?? []).length > 1);
    return (
        <div>
            <h2>Who depends on whom</h2>
            <p className="sm-lead">Rows reach out to columns. Each number is a count of call sites or references in code that cross from one system to another. Select a number to list them.</p>
            <div className="sm-tw">
                <table className="sm-table" data-sm-matrix="">
                    <thead>
                        <tr><th scope="col">From \ To</th>{SYSTEMS.map((s) => <th scope="col" className="sm-num" key={s.key}>{s.label}</th>)}</tr>
                    </thead>
                    <tbody>
                        {SYSTEMS.map((a) => (
                            <tr key={a.key}>
                                <th scope="row"><span className="sm-sw" style={sysVar(a.key)} aria-hidden="true" /><b>{a.label}</b></th>
                                {SYSTEMS.map((b) => {
                                    const cell = matrix.get(`${a.key}|${b.key}`);
                                    return (
                                        <td className="sm-num" key={b.key}>
                                            {cell ? (
                                                <button type="button" className="sm-cell" aria-label={`${a.label} to ${b.label}: ${formatCount(cell.count)} references. List them.`}
                                                    onClick={(e) => onPair({ title: `${a.label} → ${b.label}`, summary: `${formatCount(cell.count)} references.`, edges: cell.edges }, e.detail === 0)}>
                                                    {formatCount(cell.count)}
                                                </button>
                                            ) : a.key === b.key ? null : <span className="sm-muted"><span aria-hidden="true">·</span><span className="sm-sr">none</span></span>}
                                        </td>
                                    );
                                })}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            <h2>Strongest links between components</h2>
            {links.length ? (
                <div className="sm-tw">
                    <table className="sm-table sm-stack">
                        <thead><tr><th scope="col">From</th><th scope="col">To</th><th scope="col">How</th><th scope="col" className="sm-num">Count</th><th scope="col">Example</th></tr></thead>
                        <tbody>
                            {links.map((e, i) => (
                                <tr key={`${e.from}|${e.to}|${e.kind}|${i}`}>
                                    <td data-label="From"><Swatch id={e.from} /><NodeLink index={index} id={e.from} onSelect={onSelect} /></td>
                                    <td data-label="To"><Swatch id={e.to} /><NodeLink index={index} id={e.to} onSelect={onSelect} /></td>
                                    <td data-label="How">{EDGE_OUT[e.kind] ?? e.kind}</td>
                                    <td data-label="Count" className="sm-num">{formatCount(e.count)}</td>
                                    <td data-label="Example" className="sm-mono">{e.evidence?.[0] ?? ""}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            ) : <p className="sm-empty">No link matches.</p>}

            <h2>Quieter couplings</h2>
            <p className="sm-small"><b>Fleet-wide secrets file keys: </b>{(catalogs.fleetEnvKeys ?? []).join(", ") || "none"}</p>
            <p className="sm-small"><b>Environment variable names read by more than one system ({sharedEnv.length}): </b><span className="sm-mono">{sharedEnv.map((x) => x.name).join(", ") || "none"}</span></p>
            <p className="sm-small"><b>Symlinks into the vault: </b><span className="sm-mono">{(catalogs.symlinks ?? []).map((s) => `${s.from} → ${s.to}`).join("; ") || "none"}</span></p>
        </div>
    );
}

// ───────────────────────────────────────────────────────────── Schedule

export function ScheduleTab({ index, query, onSelect }: TabProps) {
    const crons = useMemo(() => filterCrons(index.map.catalogs.crons ?? [], query), [index, query]);
    const timeline = useMemo(() => buildTimeline(crons), [crons]);
    const [tip, setTip] = useState<Tip>(null);
    const rowsBottom = timeline.top + timeline.categories.length * timeline.rowHeight;
    const hours = Array.from({ length: 13 }, (_, i) => i * 2);
    return (
        <div>
            <h2>When things run</h2>
            <p className="sm-lead">One dot per scheduled job at its time of day (Eastern), by category. Hollow dots are paused. Jobs that repeat within the day are listed in the table only. Shaded hours are the overnight local-model window, 22:00 to 06:00.</p>
            {crons.length ? (
                <div className="sm-scroll sm-timeline" role="group" aria-label="Job timeline. Scroll sideways to see the whole day." tabIndex={0} data-sm-timeline="">
                    <svg viewBox={`0 0 ${timeline.width} ${timeline.height}`}>
                        <title>Scheduled jobs by time of day</title>
                        <rect className="sm-tl-night" x={timeline.xOf(0)} y={timeline.top - 8} width={timeline.xOf(6) - timeline.xOf(0)} height={timeline.categories.length * timeline.rowHeight + 8} />
                        <rect className="sm-tl-night" x={timeline.xOf(22)} y={timeline.top - 8} width={timeline.xOf(24) - timeline.xOf(22)} height={timeline.categories.length * timeline.rowHeight + 8} />
                        {hours.map((h) => (
                            <g key={h}>
                                <line className="sm-tl-grid" x1={timeline.xOf(h)} x2={timeline.xOf(h)} y1={timeline.top - 8} y2={rowsBottom} />
                                <text className="sm-tl-lab" x={timeline.xOf(h)} y={timeline.height - 10} textAnchor="middle">{String(h).padStart(2, "0")}:00</text>
                            </g>
                        ))}
                        <line className="sm-tl-axis" x1={timeline.left} x2={timeline.width - timeline.right} y1={rowsBottom} y2={rowsBottom} />
                        {timeline.categories.map((category, i) => (
                            <text key={category} className="sm-tl-row" x={timeline.left - 10} y={timeline.top + i * timeline.rowHeight + timeline.rowHeight / 2} textAnchor="end">{category}</text>
                        ))}
                        {timeline.dots.map(({ cron, x, y }) => {
                            const title = cron.label || cron.key;
                            const when = `${cron.cadence || cron.schedule || ""}${cron.paused ? " · paused" : ""}${cron.registeredLive === false ? " · not registered" : ""}`;
                            const owner = cron.owner ? nodeName(index, cron.owner) : "";
                            const open = (keyboard: boolean) => { if (cron.owner && index.byId.has(cron.owner)) onSelect(cron.owner, { keyboard }); };
                            return (
                                <circle key={cron.key} className="sm-tl-dot" data-paused={cron.paused ? "true" : "false"} cx={x} cy={y} r={5}
                                    role="button" tabIndex={0} aria-label={`${title}, ${when}${owner ? `, owned by ${owner}. Show the owner.` : ""}`}
                                    onMouseMove={(ev) => setTip(tipAt(ev, title, [when, owner].filter(Boolean)))} onMouseLeave={() => setTip(null)}
                                    onClick={(ev) => open(ev.detail === 0)}
                                    onKeyDown={(ev) => { if (isActivation(ev.key)) { ev.preventDefault(); open(true); } }} />
                            );
                        })}
                    </svg>
                </div>
            ) : null}
            <Tooltip tip={tip} />

            <h2>All jobs ({crons.length})</h2>
            {crons.length ? (
                <div className="sm-tw">
                    <table className="sm-table sm-stack" data-sm-jobs="">
                        <thead><tr><th scope="col">Job</th><th scope="col">When</th><th scope="col">Category</th><th scope="col">Owner</th><th scope="col">State</th><th scope="col">What it does</th><th scope="col">Registered at</th></tr></thead>
                        <tbody>
                            {sortCrons(crons).map((c) => {
                                const state = cronState(c);
                                return (
                                    <tr key={c.key}>
                                        <td data-label="Job" className="sm-mono">{c.key}</td>
                                        <td data-label="When">{c.cadence || c.schedule || ""}</td>
                                        <td data-label="Category">{c.category || ""}</td>
                                        <td data-label="Owner">{c.owner ? <NodeLink index={index} id={c.owner} onSelect={onSelect} /> : null}</td>
                                        <td data-label="State"><span className="sm-sev" data-tone={state.tone}>{state.label}</span></td>
                                        <td data-label="What it does" className="sm-small">{(c.description || c.label || "").slice(0, 260)}</td>
                                        <td data-label="Registered at" className="sm-mono">{cronWhere(c)}</td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            ) : <p className="sm-empty">No job matches.</p>}
        </div>
    );
}

// ───────────────────────────────────────────────────────────── Routes

export function RoutesTab({ index, query, onSelect }: TabProps) {
    const [service, setService] = useState("all");
    const [orphansOnly, setOrphansOnly] = useState(false);
    const rows = useMemo(() => filterRoutes(index, index.map.catalogs.routes ?? [], { service, orphansOnly, query }), [index, service, orphansOnly, query]);
    return (
        <div>
            <h2>HTTP routes</h2>
            <p className="sm-lead">Every route the scan found, with the component that owns it. &quot;Caller found&quot; means some other code names this path; routes reached only by a person, a webhook or a path built from variables will show none.</p>
            <div className="sm-chips" role="group" aria-label="Filter routes">
                {[["all", "All services"], ...Object.entries(ROUTE_SERVICES)].map(([key, label]) => (
                    <button type="button" key={key} className="sm-chip" aria-pressed={service === key} onClick={() => setService(key)}>{label}</button>
                ))}
                <button type="button" className="sm-chip" aria-pressed={orphansOnly} onClick={() => setOrphansOnly((v) => !v)}>No caller found</button>
            </div>
            <p className="sm-small" role="status" data-sm-route-count="">{formatCount(rows.length)} routes shown.</p>
            {rows.length ? (
                <div className="sm-tw">
                    <table className="sm-table sm-stack" data-sm-routes="">
                        <thead><tr><th scope="col">Service</th><th scope="col">Method</th><th scope="col">Path</th><th scope="col">Owner</th><th scope="col">Caller found</th><th scope="col">Defined at</th></tr></thead>
                        <tbody>
                            {rows.map((r, i) => (
                                <tr key={`${r.service} ${r.method} ${r.path} ${i}`}>
                                    <td data-label="Service">{ROUTE_SERVICES[r.service] ?? r.service}</td>
                                    <td data-label="Method" className="sm-mono">{r.method}</td>
                                    <td data-label="Path" className="sm-mono">{r.path}</td>
                                    <td data-label="Owner"><NodeLink index={index} id={r.owner} onSelect={onSelect} /></td>
                                    <td data-label="Caller found">{r.calledFromCode ? "yes" : "none found"}</td>
                                    <td data-label="Defined at" className="sm-mono">{r.at}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            ) : <p className="sm-empty">No route matches.</p>}
        </div>
    );
}

// ───────────────────────────────────────────────────────────── Drift

export function DriftTab({ index, query }: TabProps) {
    const all = index.map.checks;
    const checks = useMemo(() => driftChecks(all, query), [all, query]);
    const docs = useMemo(() => stalestDocs(index.map.catalogs.docs), [index]);
    const count = (severity: string) => all.filter((c) => c.severity === severity).length;
    return (
        <div>
            <h2>Where code, machine and docs disagree</h2>
            <p className="sm-lead">Recomputed every time the map is generated. Warnings are likely to matter; notes are for awareness. The scan reports what the code says, not whether it is a problem.</p>
            <div className="sm-summary" data-sm-drift-summary="">
                <span><b>{warningCount(all)}</b>warnings</span>
                <span><b>{count("info")}</b>notes</span>
                <span><b>{count("ok")}</b>checks passing</span>
            </div>
            {checks.length ? checks.map((c) => (
                <div className="sm-check" key={c.id} data-tone={c.severity} data-sm-check={c.id}>
                    <span className="sm-sev" data-tone={c.severity}>{SEVERITY_LABEL[c.severity] ?? c.severity}</span>
                    <h3>{c.title} ({c.items.length})</h3>
                    <p>{c.detail}</p>
                    <ul>{c.items.slice(0, 12).map((item, i) => <li key={i}>{item}</li>)}</ul>
                    {c.items.length > 12 ? (
                        <details>
                            <summary>Show {c.items.length - 12} more</summary>
                            <ul>{c.items.slice(12).map((item, i) => <li key={i}>{item}</li>)}</ul>
                        </details>
                    ) : null}
                </div>
            )) : <p className="sm-empty">No check matches.</p>}

            {docs.length ? (
                <>
                    <h2>Stalest living docs</h2>
                    <div className="sm-tw">
                        <table className="sm-table sm-stack">
                            <thead><tr><th scope="col">Doc</th><th scope="col">Last commit</th><th scope="col" className="sm-num">File references</th><th scope="col" className="sm-num">Missing</th><th scope="col" className="sm-num">Changed since</th></tr></thead>
                            <tbody>
                                {docs.map((d) => (
                                    <tr key={d.file}>
                                        <td data-label="Doc" className="sm-mono">{d.file}</td>
                                        <td data-label="Last commit">{d.lastCommit || "untracked"}</td>
                                        <td data-label="File references" className="sm-num">{d.refs ?? 0}</td>
                                        <td data-label="Missing" className="sm-num">{d.missingRefs || "0"}</td>
                                        <td data-label="Changed since" className="sm-num">{d.refsChangedSince || "0"}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </>
            ) : null}
        </div>
    );
}

// ───────────────────────────────────────────────────────────── Boundary

export function BoundaryTab({ index, query, onSelect }: TabProps) {
    const catalogs = index.map.catalogs;
    const siblings = catalogs.siblings ?? [];
    const tunnel = catalogs.tunnelIngress ?? [];
    const agents = (catalogs.launchAgents ?? []).filter((a) => (a.projectDirs ?? []).length || a.node);
    return (
        <div>
            <h2>What is on the map, and why</h2>
            <p className="sm-lead">A sibling folder is connected when its code calls a core service, uses the shared contract or the MCP server, shares a launch agent with a core repo, or owns a port that core code calls. A folder that is only a project on the Nexus board is a workspace. Copies and worktrees of the core repos are left out.</p>
            {SIBLING_CLASSES.map(([cls, title]) => {
                const list = siblings.filter((s) => s.class === cls && (!query || s.dir.toLowerCase().includes(query)));
                if (!list.length) return null;
                return (
                    <section key={cls} data-sm-boundary={cls}>
                        <h3>{title} ({list.length})</h3>
                        <div className="sm-tw">
                            <table className="sm-table sm-stack">
                                <thead><tr><th scope="col">Folder</th><th scope="col">Evidence</th><th scope="col">Launch agents</th><th scope="col">Ports</th></tr></thead>
                                <tbody>
                                    {list.map((s) => (
                                        <tr key={s.dir}>
                                            <td data-label="Folder" className="sm-mono">
                                                {cls === "connected" && index.byId.has(`sat/${s.dir}`)
                                                    ? <button type="button" className="sm-link" onClick={(e) => onSelect(`sat/${s.dir}`, { keyboard: e.detail === 0 })}>{s.dir}</button>
                                                    : s.dir}
                                            </td>
                                            <td data-label="Evidence" className="sm-small">{siblingEvidence(s)}</td>
                                            <td data-label="Launch agents" className="sm-small">{(s.launchAgents ?? []).join(", ")}</td>
                                            <td data-label="Ports" className="sm-mono">{(s.ports ?? []).join(", ")}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </section>
                );
            })}

            {tunnel.length ? (
                <section data-sm-boundary="tunnel">
                    <h3>Published through the Cloudflare tunnel ({tunnel.length})</h3>
                    <p className="sm-small">The scan reads the tunnel&apos;s route list, not the Cloudflare Access policies in front of it, so a hostname listed here is not necessarily open to anyone.</p>
                    <div className="sm-tw">
                        <table className="sm-table sm-stack">
                            <thead><tr><th scope="col">Hostname</th><th scope="col">Path</th><th scope="col">Local service</th><th scope="col">Served by</th></tr></thead>
                            <tbody>
                                {tunnel.map((rule, i) => (
                                    <tr key={`${rule.hostname}${rule.path ?? ""}${i}`}>
                                        <td data-label="Hostname" className="sm-mono">{rule.hostname}</td>
                                        <td data-label="Path" className="sm-mono">{rule.path || "(all)"}</td>
                                        <td data-label="Local service" className="sm-mono">{rule.service}</td>
                                        <td data-label="Served by">
                                            {rule.node && index.byId.has(rule.node)
                                                ? <><NodeLink index={index} id={rule.node} onSelect={onSelect} />{rule.inferred ? ` (inferred from ${rule.inferred})` : ""}</>
                                                : tunnelServedBy(index, rule)}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </section>
            ) : null}

            <section data-sm-boundary="launch-agents">
                <h3>Launch agents ({agents.length})</h3>
                <div className="sm-tw">
                    <table className="sm-table sm-stack">
                        <thead><tr><th scope="col">Label</th><th scope="col">On the map as</th><th scope="col">Keep alive</th><th scope="col">Folders it touches</th></tr></thead>
                        <tbody>
                            {agents.map((a) => (
                                <tr key={a.label}>
                                    <td data-label="Label" className="sm-mono">{a.label}</td>
                                    <td data-label="On the map as">{a.node && index.byId.has(a.node) ? <NodeLink index={index} id={a.node} onSelect={onSelect} /> : "not on the map"}</td>
                                    <td data-label="Keep alive">{a.keepAlive ? "yes" : a.startInterval ? `every ${a.startInterval}s` : "at login"}</td>
                                    <td data-label="Folders it touches" className="sm-small">{(a.projectDirs ?? []).join(", ")}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </section>
        </div>
    );
}

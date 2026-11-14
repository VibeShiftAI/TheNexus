"use client";

import type { CSSProperties, ReactNode, Ref } from "react";
import {
    EDGE_IN, EDGE_OUT, cronWhere, formatCount, nodeConnections, nodeName, purposeOrigin, sortConnections, systemOf,
    type MapEdge, type MapIndex, type MapNode,
} from "@/lib/system-map";

export type SelectOptions = { reveal?: boolean; keyboard?: boolean };
export type SelectNode = (id: string, options?: SelectOptions) => void;
export type PairDetail = { title: string; summary: string; edges: MapEdge[] };
export type PanelState = { type: "node"; id: string } | ({ type: "pair" } & PairDetail) | null;

const systemColor = (id: string) => ({ "--sm-sysc": `var(--sm-c-${systemOf(id)})` }) as CSSProperties;

export function Swatch({ id }: { id: string }) {
    return <span className="sm-sw" style={systemColor(id)} aria-hidden="true" />;
}

/** A component name that opens that component's detail. Clicks made from the keyboard move focus to the detail. */
export function NodeLink({ index, id, onSelect, reveal = false }: { index: MapIndex; id: string; onSelect: SelectNode; reveal?: boolean }) {
    if (!index.byId.has(id)) return <span>{nodeName(index, id)}</span>;
    return (
        <button type="button" className="sm-link" data-sm-open={id} onClick={(e) => onSelect(id, { reveal, keyboard: e.detail === 0 })}>
            {nodeName(index, id)}
        </button>
    );
}

export function StateMark({ node }: { node: MapNode }) {
    const running = node.attrs?.running;
    if (running === true) return <span className="sm-state" data-state="run"><i />running</span>;
    if (running === false) return <span className="sm-state" data-state="off"><i />not running</span>;
    if (running === "interval") return <span className="sm-state" data-state="int"><i />interval job</span>;
    return null;
}

/**
 * Source locations behind a claim: the first is always on screen, the rest one tap away.
 * The generator records the first few places it finds for a link, not every one,
 * so a link counted more often than it has places listed says how many the map keeps.
 */
export function Evidence({ items, count }: { items: string[]; count?: number }) {
    if (!items.length) return null;
    const [first, ...rest] = items;
    const kept = count !== undefined && count > items.length
        ? <span data-sm-evidence-kept="">the map keeps {items.length} of {formatCount(count)} places</span> : null;
    return (
        <>
            <div className="sm-at" data-sm-evidence="">{first}</div>
            {rest.length ? (
                <details className="sm-where">
                    <summary>{rest.length} more place{rest.length === 1 ? "" : "s"}{kept ? <>; {kept}</> : null}</summary>
                    {rest.map((x, i) => <div key={i} data-sm-evidence="">{x}</div>)}
                </details>
            ) : kept ? <div className="sm-small">{kept}</div> : null}
        </>
    );
}

/** The first `limit` rows, with the remainder behind a disclosure so nothing is dropped. */
function Capped<T>({ items, limit, noun, render }: { items: T[]; limit: number; noun: string; render: (item: T, i: number) => ReactNode }) {
    const rest = items.slice(limit);
    return (
        <>
            <ul className="sm-rel">{items.slice(0, limit).map(render)}</ul>
            {rest.length ? (
                <details className="sm-where">
                    <summary>Show {rest.length} more {noun}</summary>
                    <ul className="sm-rel">{rest.map((item, i) => render(item, i + limit))}</ul>
                </details>
            ) : null}
        </>
    );
}

function ConnectionList({ index, edges, direction, onSelect }: { index: MapIndex; edges: MapEdge[]; direction: "out" | "in"; onSelect: SelectNode }) {
    return (
        <Capped items={sortConnections(edges)} limit={80} noun="connections" render={(e, i) => {
            const other = direction === "out" ? e.to : e.from;
            return (
                <li key={`${e.from}|${e.to}|${e.kind}|${i}`} data-sm-connection={direction}>
                    <div className="sm-row">
                        <Swatch id={other} />
                        <NodeLink index={index} id={other} onSelect={onSelect} reveal />
                        <span className="sm-k">{(direction === "out" ? EDGE_OUT : EDGE_IN)[e.kind] ?? e.kind} · {formatCount(e.count)}</span>
                    </div>
                    <Evidence items={e.evidence ?? []} count={e.count} />
                </li>
            );
        }} />
    );
}

export function PairList({ index, edges, onSelect }: { index: MapIndex; edges: MapEdge[]; onSelect: SelectNode }) {
    return (
        <Capped items={[...edges].sort((a, b) => b.count - a.count)} limit={100} noun="links" render={(e, i) => (
            <li key={`${e.from}|${e.to}|${e.kind}|${i}`}>
                <div className="sm-row">
                    <NodeLink index={index} id={e.from} onSelect={onSelect} reveal />
                    <span aria-hidden="true">→</span><span className="sm-sr">reaches</span>
                    <NodeLink index={index} id={e.to} onSelect={onSelect} reveal />
                    <span className="sm-k">{EDGE_OUT[e.kind] ?? e.kind} · {formatCount(e.count)}</span>
                </div>
                <Evidence items={e.evidence ?? []} count={e.count} />
            </li>
        )} />
    );
}

function Fact({ value, label }: { value: string | number | null | undefined; label: string }) {
    if (value === undefined || value === null || value === "" || value === 0) return null;
    return <div><b>{typeof value === "number" ? formatCount(value) : value}</b><span>{label}</span></div>;
}

function NodeDetail({ index, node, onSelect }: { index: MapIndex; node: MapNode; onSelect: SelectNode }) {
    const a = node.attrs ?? {};
    const catalogs = index.map.catalogs;
    const { outs, ins } = nodeConnections(index, node);
    const jobs = (catalogs.crons ?? []).filter((c) => c.owner === node.id);
    const routes = (catalogs.routes ?? []).filter((r) => r.owner === node.id);
    const tools = [...(catalogs.agentTools ?? []), ...(catalogs.mcpTools ?? [])].filter((t) => t.owner === node.id);
    const tables = (catalogs.tables ?? []).filter((t) => (t.users ?? []).includes(node.id));
    const hasCode = Boolean(a.files);
    return (
        <>
            {node.path ? <div className="sm-mono sm-muted" data-sm-path="">{node.path}</div> : null}
            <p className="sm-purpose" data-sm-purpose="">{node.purpose || "No purpose line yet."}</p>
            <div className="sm-small sm-muted" data-sm-purpose-source="">{purposeOrigin(node)}</div>

            <div className="sm-facts" data-sm-facts="">
                <Fact value={a.files} label="source files" />
                <Fact value={a.lines} label="lines" />
                <Fact value={hasCode ? String(a.commits90d ?? 0) : null} label="commits, 90 days" />
                <Fact value={a.lastCommit} label="last commit" />
                <Fact value={a.routeCount} label="HTTP routes" />
                <Fact value={a.jobs} label="scheduled jobs" />
                <Fact value={a.agentTools} label="agent tools" />
                <Fact value={a.mcpTools} label="MCP tools" />
                <Fact value={a.stateStores} label="state stores" />
                <Fact value={a.envVars} label="env vars read" />
                <Fact value={a.timers} label="interval timers" />
                <Fact value={(a.ports ?? []).map((p) => `:${p}`).join(" ")} label="port" />
                <Fact value={a.launchd} label="launch agent" />
                <Fact value={a.supervisedBy ? nodeName(index, a.supervisedBy) : null} label="supervised by" />
                <Fact value={a.references} label="references in code" />
                <Fact value={a.count} label="projects" />
            </div>
            <StateMark node={node} />

            {a.why?.length ? <><h3>Why it is on the map</h3><ul className="sm-small">{a.why.map((w, i) => <li key={i}>{w}</li>)}</ul></> : null}
            {a.mounts?.length ? <div className="sm-small">Mounted at <span className="sm-mono">{a.mounts.map((m) => m || "/").join("  ")}</span></div> : null}
            {a.via?.length ? <><h3>Seen as</h3><div className="sm-mono">{a.via.join(", ")}</div></> : null}
            {a.projects?.length ? <><h3>Projects</h3><div className="sm-small">{a.projects.join(", ")}</div></> : null}
            {a.documents?.length ? (
                <>
                    <h3>Documents</h3>
                    <ul className="sm-rel">{a.documents.map((d) => (
                        <li key={d.file}><div className="sm-row"><span className="sm-mono">{d.file}</span><span className="sm-k">{d.generatedBy ? `generated by ${d.generatedBy}` : "authored"}</span></div></li>
                    ))}</ul>
                </>
            ) : null}

            <section data-sm-section="out">
                <h3>Reaches out to ({new Set(outs.map((e) => e.to)).size})</h3>
                {outs.length ? <ConnectionList index={index} edges={outs} direction="out" onSelect={onSelect} /> : <p className="sm-small sm-muted">Nothing found in code.</p>}
            </section>
            <section data-sm-section="in">
                <h3>Reached from ({new Set(ins.map((e) => e.from)).size})</h3>
                {ins.length ? <ConnectionList index={index} edges={ins} direction="in" onSelect={onSelect} /> : <p className="sm-small sm-muted">Nothing found in code.</p>}
            </section>

            {jobs.length ? (
                <section data-sm-section="jobs">
                    <h3>Scheduled jobs ({jobs.length})</h3>
                    <ul className="sm-rel">{jobs.map((c) => (
                        <li key={c.key}>
                            <div className="sm-row"><b className="sm-mono">{c.key}</b><span className="sm-k">{c.registeredLive === false ? "not registered" : c.paused ? "paused" : c.cadence || c.schedule || ""}</span></div>
                            <div className="sm-small">{c.description || c.label || ""}</div>
                            {cronWhere(c) ? <div className="sm-at" data-sm-evidence="">{cronWhere(c)}</div> : null}
                        </li>
                    ))}</ul>
                </section>
            ) : null}

            {routes.length ? (
                <section data-sm-section="routes">
                    <h3>HTTP routes ({routes.length})</h3>
                    <Capped items={routes} limit={60} noun="routes" render={(r, i) => (
                        <li key={`${r.method} ${r.path} ${i}`}>
                            <div className="sm-row"><span className="sm-mono">{r.method} {r.path}</span>{r.calledFromCode ? null : <span className="sm-k">no caller found</span>}</div>
                            <div className="sm-at" data-sm-evidence="">{r.at}</div>
                        </li>
                    )} />
                </section>
            ) : null}

            {tools.length ? (
                <section data-sm-section="tools">
                    <h3>Tools ({tools.length})</h3>
                    <div className="sm-mono">{[...new Set(tools.map((t) => t.name))].sort().join(", ")}</div>
                </section>
            ) : null}
            {tables.length ? <><h3>Tables used ({tables.length})</h3><div className="sm-mono">{tables.map((t) => t.name).join(", ")}</div></> : null}
            {a.rootFiles?.length ? <><h3>Files</h3><div className="sm-mono">{a.rootFiles.join(", ")}</div></> : null}
        </>
    );
}

function HowToRead({ index }: { index: MapIndex }) {
    const { map } = index;
    const repos = Object.values(map.repos ?? {}).filter((r): r is NonNullable<typeof r> => Boolean(r));
    return (
        <>
            <p className="sm-small">Everything here is extracted from the working trees and the running machine by the Praxis generator. Nothing is drawn by hand. Purpose lines come from each repo&apos;s system-map-notes.json, or from a header comment in code when no note exists. Select any component to see what it is, what it reaches and what reaches it.</p>
            {repos.length ? (
                <>
                    <h3>Repos at generation time</h3>
                    <ul className="sm-rel">{repos.map((r) => (
                        <li key={r.path}><div className="sm-row"><b>{r.path}</b><span className="sm-k">{[r.branch, r.head, r.headDate, r.dirtyFiles ? `${r.dirtyFiles} uncommitted` : r.dirty ? "uncommitted changes" : ""].filter(Boolean).join(" · ")}</span></div></li>
                    ))}</ul>
                </>
            ) : null}
            {map.callResolution ? (
                <>
                    <h3>Extraction confidence</h3>
                    <p className="sm-small">{formatCount(map.callResolution.resolved ?? 0)} API call sites were matched to a route on another component; {formatCount(map.callResolution.unresolved ?? 0)} matched nothing and are listed under Drift. Call sites built from variables are not seen. Socket and event traffic is not mapped yet.</p>
                </>
            ) : null}
        </>
    );
}

export function SystemMapPanel({ index, panel, onSelect, onClose, onShowOnMap, headingRef }: {
    index: MapIndex;
    panel: PanelState;
    onSelect: SelectNode;
    onClose: () => void;
    /** Present when the selected component can be shown among the Map tab's tiles from another tab. */
    onShowOnMap: (() => void) | null;
    headingRef: Ref<HTMLHeadingElement>;
}) {
    const node = panel?.type === "node" ? index.byId.get(panel.id) ?? null : null;
    const title = node ? node.name : panel?.type === "pair" ? panel.title : "How to read this";
    const open = Boolean(node || panel?.type === "pair");
    return (
        <aside className="sm-panel" data-sm-panel="" data-sm-open={open ? "true" : "false"} data-sm-selected={node?.id ?? ""} aria-label="Detail"
            onKeyDown={(e) => { if (e.key === "Escape" && open) { e.stopPropagation(); onClose(); } }}>
            <div className="sm-panel-head">
                <h2 ref={headingRef} tabIndex={-1}>{title}</h2>
                {open ? <button type="button" className="sm-close" data-sm-close="" onClick={onClose}>Close</button> : null}
            </div>
            {node ? (
                <>
                    {onShowOnMap ? <p><button type="button" className="sm-link" onClick={onShowOnMap}>Show on the map</button></p> : null}
                    <NodeDetail index={index} node={node} onSelect={onSelect} />
                </>
            ) : panel?.type === "pair" ? (
                <>
                    <p className="sm-small">{panel.summary}</p>
                    <PairList index={index} edges={panel.edges} onSelect={onSelect} />
                </>
            ) : <HowToRead index={index} />}
        </aside>
    );
}

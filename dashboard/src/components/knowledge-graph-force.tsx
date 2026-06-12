"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { forceCollide, forceX, forceY } from "d3-force";
import { Loader2, Search } from "lucide-react";
import type { KnowledgeGraphEdge, KnowledgeGraphNode } from "@/lib/ingestion-control";

// force-graph touches `window` — client-only. next/dynamic erases the lib's
// node-type generic, so the boundary is intentionally untyped; our callbacks
// keep their own GraphNode typing.
const ForceGraph2D = dynamic(() => import("react-force-graph-2d"), {
    ssr: false,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
}) as unknown as React.ComponentType<Record<string, any>>;

interface Props {
    term: string;
    nodes: KnowledgeGraphNode[];
    edges: KnowledgeGraphEdge[];
    /** Single click — re-center the explorer on this entity. */
    onNodeClick?: (label: string) => void;
    /** Double click — fetch this node's neighbors and merge them into the graph. */
    onNodeExpand?: (nodeId: string, knownIds: string[]) => Promise<void>;
}

interface GraphNode {
    id: string;
    label: string;
    kind: "entity" | "neighbor";
    degree: number;
    communityId?: number;
    topic?: string | null;
    color: string;
    x?: number;
    y?: number;
}

interface GraphLink {
    source: string | GraphNode;
    target: string | GraphNode;
    label: string;
    observedAt: string | null;
}

/** Distinct, dark-theme-friendly topic palette (cycled by community id). */
const TOPIC_COLORS = [
    "#22d3ee", "#a78bfa", "#34d399", "#fbbf24", "#f472b6",
    "#60a5fa", "#fb923c", "#4ade80", "#e879f9", "#2dd4bf",
];
const NO_TOPIC_COLOR = "#64748b";

const TIME_WINDOWS: Array<{ label: string; days: number | null }> = [
    { label: "24h", days: 1 },
    { label: "7d", days: 7 },
    { label: "30d", days: 30 },
    { label: "all", days: null },
];

/** Degree → radius, kept small: the layout reads better as constellation than bubbles. */
function nodeRadius(degree: number): number {
    return Math.max(2.5, Math.min(9, 2 + Math.sqrt(degree) * 0.6));
}

function linkEndId(end: string | GraphNode): string {
    return typeof end === "string" ? end : end.id;
}

/** Andrew's monotone-chain convex hull over node positions. */
function convexHull(points: Array<[number, number]>): Array<[number, number]> {
    if (points.length < 3) return points;
    const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cross = (o: [number, number], a: [number, number], b: [number, number]) =>
        (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lower: Array<[number, number]> = [];
    for (const p of pts) {
        while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
        lower.push(p);
    }
    const upper: Array<[number, number]> = [];
    for (const p of [...pts].reverse()) {
        while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
        upper.push(p);
    }
    lower.pop();
    upper.pop();
    return [...lower, ...upper];
}

export default function KnowledgeGraphForce({ term, nodes, edges, onNodeClick, onNodeExpand }: Props) {
    const containerRef = useRef<HTMLDivElement>(null);
    // The lib loads via next/dynamic, so a plain ref is still null when our
    // force-setup effect first runs — track readiness with a callback ref.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [fg, setFg] = useState<any>(null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handleRef = useCallback((el: any) => { if (el) setFg(el); }, []);
    const [size, setSize] = useState({ width: 800, height: 540 });
    const [hovered, setHovered] = useState<GraphNode | null>(null);
    const [timeDays, setTimeDays] = useState<number | null>(null);
    const [searchQ, setSearchQ] = useState("");
    const [expanding, setExpanding] = useState<string | null>(null);

    // Position cache so node positions survive prop changes (expansion, time filter).
    const nodeCacheRef = useRef(new Map<string, GraphNode>());
    // Where the last expansion happened — new nodes spawn near it instead of at origin.
    const spawnRef = useRef<{ x: number; y: number } | null>(null);

    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;
        const update = () => setSize({ width: el.clientWidth, height: Math.max(440, Math.min(620, el.clientWidth * 0.62)) });
        update();
        const observer = new ResizeObserver(update);
        observer.observe(el);
        return () => observer.disconnect();
    }, []);

    // Fresh term → fresh canvas: drop cached positions and filters.
    useEffect(() => {
        nodeCacheRef.current.clear();
        spawnRef.current = null;
        setSearchQ("");
    }, [term]);

    const { data, communityColor, legend, neighborIds, hiddenByTime } = useMemo(() => {
        // Time filter on edges; undated edges only survive in "all".
        const cutoff = timeDays !== null ? new Date(Date.now() - timeDays * 86_400_000).toISOString() : null;
        const visibleEdges = cutoff
            ? edges.filter((e) => e.observed_at && e.observed_at >= cutoff.slice(0, e.observed_at.length))
            : edges;

        // Nodes: seeds always shown; neighbors must touch a visible edge when filtering.
        const touched = new Set<string>();
        for (const e of visibleEdges) {
            touched.add(e.source);
            touched.add(e.target);
        }
        const visibleNodes = cutoff ? nodes.filter((n) => n.kind === "entity" || touched.has(n.id)) : nodes;
        const hiddenByTime = nodes.length - visibleNodes.length;

        const communityColor = new Map<number, string>();
        const topicTitles = new Map<number, string | null>();
        for (const n of visibleNodes) {
            if (n.community_id !== undefined && !communityColor.has(n.community_id)) {
                communityColor.set(n.community_id, TOPIC_COLORS[communityColor.size % TOPIC_COLORS.length]);
            }
            if (n.community_id !== undefined) topicTitles.set(n.community_id, n.topic ?? null);
        }

        const cache = nodeCacheRef.current;
        const graphNodes: GraphNode[] = visibleNodes.map((n) => {
            const color = n.community_id !== undefined ? communityColor.get(n.community_id)! : NO_TOPIC_COLOR;
            const cached = cache.get(n.id);
            if (cached) {
                // Reuse the simulation object → position survives the data swap.
                cached.label = n.label;
                cached.kind = n.kind;
                cached.degree = n.degree ?? 1;
                cached.communityId = n.community_id;
                cached.topic = n.topic;
                cached.color = color;
                return cached;
            }
            const fresh: GraphNode = {
                id: n.id,
                label: n.label,
                kind: n.kind,
                degree: n.degree ?? 1,
                communityId: n.community_id,
                topic: n.topic,
                color,
                ...(spawnRef.current
                    ? {
                          x: spawnRef.current.x + (Math.random() - 0.5) * 30,
                          y: spawnRef.current.y + (Math.random() - 0.5) * 30,
                      }
                    : {}),
            };
            cache.set(n.id, fresh);
            return fresh;
        });

        const idSet = new Set(graphNodes.map((n) => n.id));
        const graphLinks: GraphLink[] = visibleEdges
            .filter((e) => idSet.has(e.source) && idSet.has(e.target))
            .map((e) => ({ source: e.source, target: e.target, label: e.label, observedAt: e.observed_at ?? null }));

        const neighborIds = new Map<string, Set<string>>();
        for (const l of graphLinks) {
            const s = l.source as string;
            const t = l.target as string;
            if (!neighborIds.has(s)) neighborIds.set(s, new Set());
            if (!neighborIds.has(t)) neighborIds.set(t, new Set());
            neighborIds.get(s)!.add(t);
            neighborIds.get(t)!.add(s);
        }

        const counts = new Map<number, number>();
        for (const n of graphNodes) {
            if (n.communityId !== undefined) counts.set(n.communityId, (counts.get(n.communityId) ?? 0) + 1);
        }
        const legend = [...counts.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 6)
            .map(([cid, count]) => ({
                color: communityColor.get(cid)!,
                title: topicTitles.get(cid) ?? `Topic #${cid}`,
                count,
            }));

        return { data: { nodes: graphNodes, links: graphLinks }, communityColor, legend, neighborIds, hiddenByTime };
    }, [nodes, edges, timeDays]);

    // Layout forces: gentle gravity pulls disconnected satellites back toward
    // the center, collision keeps labels breathable, charge spreads the core.
    useEffect(() => {
        if (!fg) return;
        fg.d3Force("x", forceX(0).strength(0.06));
        fg.d3Force("y", forceY(0).strength(0.06));
        fg.d3Force("collide", forceCollide((n: GraphNode) => nodeRadius(n.degree) + 7).iterations(2));
        fg.d3Force("charge")?.strength(-90);
        fg.d3ReheatSimulation?.();
    }, [fg, data]);

    // Re-center on a new term (not on expansion — that would yank the view).
    useEffect(() => {
        if (!fg) return;
        const t = setTimeout(() => fg.zoomToFit?.(600, 40), 700);
        return () => clearTimeout(t);
    }, [fg, term]);

    const searchMatch = useCallback(
        (n: GraphNode) => searchQ.trim() !== "" && n.label.toLowerCase().includes(searchQ.trim().toLowerCase()),
        [searchQ],
    );

    const isDimmed = useCallback(
        (n: GraphNode) => {
            if (searchQ.trim() !== "" && !searchMatch(n)) return true;
            return hovered !== null && hovered.id !== n.id && !neighborIds.get(hovered.id)?.has(n.id);
        },
        [hovered, neighborIds, searchQ, searchMatch],
    );

    // Single click explores; double click expands in place.
    const clickRef = useRef<{ id: string; at: number; timer: ReturnType<typeof setTimeout> | null }>({ id: "", at: 0, timer: null });
    const handleNodeClick = useCallback(
        (n: GraphNode) => {
            const now = Date.now();
            const prev = clickRef.current;
            if (prev.id === n.id && now - prev.at < 350) {
                if (prev.timer) clearTimeout(prev.timer);
                clickRef.current = { id: "", at: 0, timer: null };
                if (onNodeExpand && !expanding) {
                    spawnRef.current = { x: n.x ?? 0, y: n.y ?? 0 };
                    setExpanding(n.id);
                    onNodeExpand(n.id, nodes.map((node) => node.id)).finally(() => setExpanding(null));
                }
                return;
            }
            if (prev.timer) clearTimeout(prev.timer);
            clickRef.current = {
                id: n.id,
                at: now,
                timer: setTimeout(() => {
                    onNodeClick?.(n.label);
                    clickRef.current = { id: "", at: 0, timer: null };
                }, 330),
            };
        },
        [onNodeClick, onNodeExpand, expanding, nodes],
    );

    // Topic hulls behind the nodes — inflated convex hull per community.
    const drawHulls = useCallback(
        (ctx: CanvasRenderingContext2D) => {
            const groups = new Map<number, Array<[number, number]>>();
            for (const n of data.nodes) {
                if (n.communityId === undefined || n.x === undefined || n.y === undefined) continue;
                if (!groups.has(n.communityId)) groups.set(n.communityId, []);
                groups.get(n.communityId)!.push([n.x, n.y]);
            }
            for (const [cid, pts] of groups) {
                if (pts.length < 2) continue;
                const hull = convexHull(pts);
                const color = communityColor.get(cid) ?? NO_TOPIC_COLOR;
                ctx.beginPath();
                ctx.moveTo(hull[0][0], hull[0][1]);
                for (let i = 1; i < hull.length; i++) ctx.lineTo(hull[i][0], hull[i][1]);
                ctx.closePath();
                ctx.fillStyle = `${color}10`;
                ctx.strokeStyle = `${color}1e`;
                ctx.lineWidth = 26;
                ctx.lineJoin = "round";
                ctx.lineCap = "round";
                ctx.stroke();
                ctx.fill();
            }
        },
        [data, communityColor],
    );

    const drawNode = useCallback(
        (node: GraphNode, ctx: CanvasRenderingContext2D, globalScale: number) => {
            const r = nodeRadius(node.degree);
            const dim = isDimmed(node);
            const isHover = hovered?.id === node.id;
            const isMatch = searchMatch(node);

            ctx.globalAlpha = dim ? 0.15 : 1;
            if (node.kind === "entity") {
                ctx.beginPath();
                ctx.arc(node.x!, node.y!, r + 2, 0, 2 * Math.PI);
                ctx.strokeStyle = node.color;
                ctx.lineWidth = isHover ? 1.5 : 0.8;
                ctx.globalAlpha = dim ? 0.1 : 0.55;
                ctx.stroke();
                ctx.globalAlpha = dim ? 0.15 : 1;
            }
            ctx.beginPath();
            ctx.arc(node.x!, node.y!, r, 0, 2 * Math.PI);
            ctx.fillStyle = node.color;
            ctx.fill();
            if (isHover || isMatch) {
                ctx.strokeStyle = isMatch ? "#fde047" : "#f8fafc";
                ctx.lineWidth = 1.5;
                ctx.stroke();
            }
            if (expanding === node.id) {
                ctx.beginPath();
                ctx.arc(node.x!, node.y!, r + 4, 0, 2 * Math.PI);
                ctx.strokeStyle = "#67e8f9";
                ctx.setLineDash([3, 3]);
                ctx.lineWidth = 1;
                ctx.stroke();
                ctx.setLineDash([]);
            }

            const showLabel =
                node.kind === "entity" || globalScale > 1.6 || isHover || isMatch ||
                (hovered && neighborIds.get(hovered.id)?.has(node.id));
            if (showLabel) {
                const fontSize = Math.max(10 / globalScale, node.kind === "entity" ? 3.5 : 2.8);
                ctx.font = `${node.kind === "entity" ? "600 " : ""}${fontSize}px Inter, ui-sans-serif`;
                const text = node.label.length > 28 ? `${node.label.slice(0, 27)}…` : node.label;
                ctx.textAlign = "center";
                ctx.textBaseline = "top";
                if (!dim) {
                    const w = ctx.measureText(text).width;
                    ctx.fillStyle = "rgba(2,6,23,0.72)";
                    ctx.fillRect(node.x! - w / 2 - 1.5, node.y! + r + 1, w + 3, fontSize + 2);
                }
                ctx.fillStyle = dim ? "rgba(148,163,184,0.22)" : node.kind === "entity" ? "#e2e8f0" : "#94a3b8";
                ctx.fillText(text, node.x!, node.y! + r + 2);
            }
            ctx.globalAlpha = 1;
        },
        [hovered, isDimmed, neighborIds, searchMatch, expanding],
    );

    if (nodes.length === 0) {
        return (
            <div className="flex h-64 items-center justify-center text-sm text-slate-500">
                No graph entities found for &ldquo;{term}&rdquo; yet — they appear after a nightly run ingests matching content.
            </div>
        );
    }

    return (
        <div ref={containerRef} className="relative">
            <ForceGraph2D
                ref={handleRef}
                width={size.width}
                height={size.height}
                graphData={data}
                backgroundColor="rgba(0,0,0,0)"
                nodeId="id"
                nodeVal={(n: GraphNode) => Math.max(0.5, n.degree / 12)}
                nodeLabel={(n: GraphNode) =>
                    `<div style="padding:4px 8px;background:#0f172a;border:1px solid #334155;border-radius:6px;color:#e2e8f0;font-size:12px">
                       <b>${n.label}</b><br/>${n.degree} connections${n.topic ? `<br/><span style="color:${n.color}">◉ ${n.topic}</span>` : ""}
                       <br/><span style="color:#64748b">click: explore · double-click: expand</span>
                     </div>`
                }
                onRenderFramePre={(ctx: CanvasRenderingContext2D) => drawHulls(ctx)}
                nodeCanvasObject={drawNode}
                nodePointerAreaPaint={(n: GraphNode, color: string, ctx: CanvasRenderingContext2D) => {
                    const r = nodeRadius(n.degree) + 4;
                    ctx.fillStyle = color;
                    ctx.beginPath();
                    ctx.arc(n.x!, n.y!, r, 0, 2 * Math.PI);
                    ctx.fill();
                }}
                linkColor={(l: GraphLink) => {
                    const active = hovered && (linkEndId(l.source) === hovered.id || linkEndId(l.target) === hovered.id);
                    if (active) return "#67e8f9";
                    return hovered || searchQ ? "rgba(51,65,85,0.25)" : "rgba(71,85,105,0.6)";
                }}
                linkWidth={(l: GraphLink) =>
                    hovered && (linkEndId(l.source) === hovered.id || linkEndId(l.target) === hovered.id) ? 1.8 : 0.8
                }
                linkLabel={(l: GraphLink) =>
                    `<span style="padding:2px 6px;background:#0f172a;border:1px solid #334155;border-radius:4px;color:#67e8f9;font-size:11px">${l.label}${l.observedAt ? ` · ${new Date(l.observedAt).toLocaleDateString()}` : ""}</span>`
                }
                linkDirectionalParticles={1}
                linkDirectionalParticleWidth={(l: GraphLink) =>
                    hovered && (linkEndId(l.source) === hovered.id || linkEndId(l.target) === hovered.id) ? 3 : 0
                }
                linkDirectionalParticleColor={() => "#67e8f9"}
                onNodeHover={(n: GraphNode | null) => setHovered(n)}
                onNodeClick={handleNodeClick}
                cooldownTicks={120}
                d3VelocityDecay={0.35}
            />

            {/* Controls: time scrubber + in-graph search */}
            <div className="absolute left-2 top-2 flex items-center gap-2">
                <div className="flex overflow-hidden rounded-md border border-slate-800 bg-slate-950/85 text-[11px]">
                    {TIME_WINDOWS.map((w) => (
                        <button
                            key={w.label}
                            onClick={() => setTimeDays(w.days)}
                            className={`px-2 py-1 ${
                                timeDays === w.days ? "bg-cyan-500/20 text-cyan-200" : "text-slate-400 hover:text-slate-200"
                            }`}
                            title={w.days ? `Only knowledge observed in the last ${w.label}` : "All time"}
                        >
                            {w.label}
                        </button>
                    ))}
                </div>
                <div className="flex items-center gap-1 rounded-md border border-slate-800 bg-slate-950/85 px-2 py-1">
                    <Search size={11} className="text-slate-500" />
                    <input
                        value={searchQ}
                        onChange={(e) => setSearchQ(e.target.value)}
                        placeholder="filter nodes…"
                        className="w-28 bg-transparent text-[11px] text-slate-200 placeholder:text-slate-600 focus:outline-none"
                    />
                    {searchQ && (
                        <button onClick={() => setSearchQ("")} className="text-slate-500 hover:text-slate-300">×</button>
                    )}
                </div>
                {expanding && (
                    <span className="flex items-center gap-1 rounded-md border border-cyan-500/30 bg-cyan-500/10 px-2 py-1 text-[11px] text-cyan-200">
                        <Loader2 size={11} className="animate-spin" /> expanding…
                    </span>
                )}
            </div>

            {legend.length > 0 && (
                <div className="pointer-events-none absolute bottom-2 left-2 space-y-1 rounded-md border border-slate-800 bg-slate-950/85 px-2.5 py-2 text-[11px]">
                    {legend.map((l) => (
                        <div key={l.title} className="flex items-center gap-1.5 text-slate-300">
                            <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: l.color }} />
                            {l.title} <span className="text-slate-500">({l.count})</span>
                        </div>
                    ))}
                    {communityColor.size > legend.length && (
                        <div className="text-slate-600">+{communityColor.size - legend.length} more topics</div>
                    )}
                </div>
            )}

            <div className="pointer-events-none absolute right-2 top-2 rounded-md border border-slate-800 bg-slate-950/85 px-2.5 py-1.5 text-[11px] text-slate-500">
                {data.nodes.length} nodes · {data.links.length} links
                {hiddenByTime > 0 ? ` · ${hiddenByTime} hidden by time filter` : ""}
                <span className="text-slate-600"> · click explores · 2×click expands</span>
            </div>
        </div>
    );
}

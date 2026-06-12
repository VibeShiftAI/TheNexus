"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { forceCollide, forceX, forceY } from "d3-force";
import type { TopicMapData, TopicMapNode } from "@/lib/ingestion-control";

// Same untyped boundary as knowledge-graph-force — next/dynamic erases generics.
const ForceGraph2D = dynamic(() => import("react-force-graph-2d"), {
    ssr: false,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
}) as unknown as React.ComponentType<Record<string, any>>;

interface Props {
    data: TopicMapData;
    /** Clicking a topic explores its strongest entity in the Knowledge Explorer. */
    onTopicClick?: (topic: TopicMapNode) => void;
}

interface MapNode {
    id: number;
    title: string | null;
    size: number;
    topEntities: string[];
    color: string;
    x?: number;
    y?: number;
}

interface MapLink {
    source: number | MapNode;
    target: number | MapNode;
    weight: number;
}

const PALETTE = [
    "#22d3ee", "#a78bfa", "#34d399", "#fbbf24", "#f472b6",
    "#60a5fa", "#fb923c", "#4ade80", "#e879f9", "#2dd4bf",
];

function radius(size: number): number {
    return Math.max(4, Math.min(30, 2 + Math.sqrt(size) * 1.0));
}

/** Size filter presets — small dust topics hide by default for readability. */
const SIZE_FILTERS: Array<{ label: string; min: number }> = [
    { label: "major (≥50)", min: 50 },
    { label: "≥15", min: 15 },
    { label: "all", min: 0 },
];

function endId(end: number | MapNode): number {
    return typeof end === "number" ? end : end.id;
}

/**
 * Whole-graph topic map: one node per Leiden community, sized by entity count,
 * linked by how many entity-entity edges cross between the two communities.
 */
export default function TopicMapForce({ data, onTopicClick }: Props) {
    const containerRef = useRef<HTMLDivElement>(null);
    // The lib loads via next/dynamic, so a plain ref is still null when our
    // force-setup effect first runs — track readiness with a callback ref.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [fg, setFg] = useState<any>(null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handleRef = useCallback((el: any) => { if (el) setFg(el); }, []);
    const [size, setSize] = useState({ width: 800, height: 560 });
    const [hovered, setHovered] = useState<MapNode | null>(null);
    const [minSize, setMinSize] = useState(15);

    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;
        const update = () => setSize({ width: el.clientWidth, height: Math.max(460, Math.min(640, el.clientWidth * 0.6)) });
        update();
        const observer = new ResizeObserver(update);
        observer.observe(el);
        return () => observer.disconnect();
    }, []);

    const graph = useMemo(() => {
        const nodes: MapNode[] = data.nodes
            .filter((n) => n.size >= minSize)
            .map((n, i) => ({
                id: n.id,
                title: n.title,
                size: n.size,
                topEntities: n.top_entities ?? [],
                color: PALETTE[i % PALETTE.length],
            }));
        const idSet = new Set(nodes.map((n) => n.id));
        const links: MapLink[] = data.links
            .filter((l) => idSet.has(l.source) && idSet.has(l.target))
            .map((l) => ({ source: l.source, target: l.target, weight: l.weight }));
        const maxWeight = Math.max(1, ...links.map((l) => l.weight));
        return { nodes, links, maxWeight, hidden: data.nodes.length - nodes.length };
    }, [data, minSize]);

    // Physics: gravity keeps weakly-linked topics from flying into a dust
    // ring (which used to blow up the auto-zoom), collision stops the linked
    // core from collapsing into an overlapping clump, and link distance
    // scales with node radii so big topics get breathing room. Weak link
    // strength on purpose — collision must win over link pull.
    useEffect(() => {
        if (!fg) return;
        fg.d3Force("x", forceX(0).strength(0.09));
        fg.d3Force("y", forceY(0).strength(0.09));
        fg.d3Force("collide", forceCollide((n: MapNode) => radius(n.size) + 6).iterations(2));
        fg.d3Force("charge")?.strength(-160);
        const link = fg.d3Force("link");
        if (link) {
            link
                .distance((l: { source: MapNode; target: MapNode }) =>
                    30 + radius(l.source.size ?? 5) + radius(l.target.size ?? 5))
                .strength((l: MapLink) => 0.05 + 0.3 * (l.weight / graph.maxWeight));
        }
        fg.d3ReheatSimulation?.();
    }, [fg, graph]);

    useEffect(() => {
        if (!fg) return;
        const t = setTimeout(() => fg.zoomToFit?.(600, 40), 1600);
        return () => clearTimeout(t);
    }, [fg, graph]);

    const connected = useMemo(() => {
        const map = new Map<number, Set<number>>();
        for (const l of graph.links) {
            const s = endId(l.source);
            const t = endId(l.target);
            if (!map.has(s)) map.set(s, new Set());
            if (!map.has(t)) map.set(t, new Set());
            map.get(s)!.add(t);
            map.get(t)!.add(s);
        }
        return map;
    }, [graph]);

    const drawNode = useCallback(
        (node: MapNode, ctx: CanvasRenderingContext2D, globalScale: number) => {
            const r = radius(node.size);
            const dim = hovered !== null && hovered.id !== node.id && !connected.get(hovered.id)?.has(node.id);
            ctx.globalAlpha = dim ? 0.15 : 1;
            ctx.beginPath();
            ctx.arc(node.x!, node.y!, r, 0, 2 * Math.PI);
            ctx.fillStyle = `${node.color}cc`;
            ctx.fill();
            ctx.strokeStyle = hovered?.id === node.id ? "#f8fafc" : node.color;
            ctx.lineWidth = hovered?.id === node.id ? 1.6 : 0.8;
            ctx.stroke();

            // Label the big topics always, small ones when zoomed/hovered.
            if (node.size >= 50 || globalScale > 1.2 || hovered?.id === node.id) {
                const fontSize = Math.max(11 / globalScale, 3.5);
                ctx.font = `600 ${fontSize}px Inter, ui-sans-serif`;
                const text = node.title ?? `Topic #${node.id}`;
                const clipped = text.length > 30 ? `${text.slice(0, 29)}…` : text;
                ctx.textAlign = "center";
                ctx.textBaseline = "top";
                if (!dim) {
                    const w = ctx.measureText(clipped).width;
                    ctx.fillStyle = "rgba(2,6,23,0.72)";
                    ctx.fillRect(node.x! - w / 2 - 1.5, node.y! + r + 1, w + 3, fontSize + 2);
                }
                ctx.fillStyle = dim ? "rgba(148,163,184,0.25)" : "#e2e8f0";
                ctx.fillText(clipped, node.x!, node.y! + r + 2);
            }
            ctx.globalAlpha = 1;
        },
        [hovered, connected],
    );

    return (
        <div ref={containerRef} className="relative">
            <ForceGraph2D
                ref={handleRef}
                width={size.width}
                height={size.height}
                graphData={graph}
                backgroundColor="rgba(0,0,0,0)"
                nodeId="id"
                nodeVal={(n: MapNode) => Math.max(1, n.size / 40)}
                nodeLabel={(n: MapNode) =>
                    `<div style="padding:4px 8px;background:#0f172a;border:1px solid #334155;border-radius:6px;color:#e2e8f0;font-size:12px;max-width:280px">
                       <b>${n.title ?? `Topic #${n.id}`}</b><br/>${n.size} entities
                       ${n.topEntities.length ? `<br/><span style="color:#94a3b8">${n.topEntities.slice(0, 5).join(", ")}</span>` : ""}
                       <br/><span style="color:#64748b">click to explore this topic</span>
                     </div>`
                }
                nodeCanvasObject={drawNode}
                nodePointerAreaPaint={(n: MapNode, color: string, ctx: CanvasRenderingContext2D) => {
                    ctx.fillStyle = color;
                    ctx.beginPath();
                    ctx.arc(n.x!, n.y!, radius(n.size) + 3, 0, 2 * Math.PI);
                    ctx.fill();
                }}
                linkColor={(l: MapLink) => {
                    const active = hovered && (endId(l.source) === hovered.id || endId(l.target) === hovered.id);
                    return active ? "#67e8f9" : "rgba(71,85,105,0.35)";
                }}
                linkWidth={(l: MapLink) => 0.5 + (l.weight / graph.maxWeight) * 4}
                linkLabel={(l: MapLink) =>
                    `<span style="padding:2px 6px;background:#0f172a;border:1px solid #334155;border-radius:4px;color:#67e8f9;font-size:11px">${l.weight} cross-links</span>`
                }
                onNodeHover={(n: MapNode | null) => setHovered(n)}
                onNodeClick={(n: MapNode) =>
                    onTopicClick?.({ id: n.id, title: n.title, size: n.size, top_entities: n.topEntities })
                }
                cooldownTicks={150}
                d3VelocityDecay={0.3}
            />
            <div className="absolute left-2 top-2 flex overflow-hidden rounded-md border border-slate-800 bg-slate-950/85 text-[11px]">
                {SIZE_FILTERS.map((f) => (
                    <button
                        key={f.label}
                        onClick={() => setMinSize(f.min)}
                        className={`px-2 py-1 ${
                            minSize === f.min ? "bg-emerald-500/20 text-emerald-200" : "text-slate-400 hover:text-slate-200"
                        }`}
                        title={f.min > 0 ? `Only topics with at least ${f.min} entities` : "Every topic, including tiny ones"}
                    >
                        {f.label}
                    </button>
                ))}
            </div>
            <div className="pointer-events-none absolute right-2 top-2 rounded-md border border-slate-800 bg-slate-950/85 px-2.5 py-1.5 text-[11px] text-slate-500">
                {graph.nodes.length} topics · {graph.links.length} connections
                {graph.hidden > 0 ? ` · ${graph.hidden} small topics hidden` : ""} · node size = entity count · click to explore
            </div>
        </div>
    );
}

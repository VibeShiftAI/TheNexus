/**
 * KnowledgeStation — "Science": live cortex telemetry. Headline knowledge-base
 * counters from Praxis /api/praxis/stats (Neo4j nodes, Pinecone vectors) in a
 * left rail beside an animated constellation of the knowledge graph's topic
 * communities, fed live from the ingestion topic map (Leiden communities over
 * Neo4j). Replaces the old growth chart, whose fleet stats-history source was
 * decommissioned 2026-07-02. Links through to the full graph console on
 * /knowledge-ingestion.
 */
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { BrainCircuit, ArrowUpRight } from "lucide-react";
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import { HudPanel, HudModal, HudStat } from "@/components/bridge/hud";
import { getTopicMap, type TopicMapData } from "@/lib/ingestion-control";

interface PraxisStats {
  neo4jNodes?: number;
  pineconeVectors?: number;
  mcpToolCount?: number;
  dailyCallCount?: number;
}

function fmt(n: number | undefined | null) {
  if (n == null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${(n / 1000).toFixed(0)}k`;
  return n.toLocaleString();
}

function timeAgo(iso: string) {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 60_000) return "just now";
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Same palette as the graph console so topics read consistently across views. */
const TOPIC_COLORS = [
  "#22d3ee", "#a78bfa", "#34d399", "#fbbf24", "#f472b6",
  "#60a5fa", "#fb923c", "#4ade80", "#e879f9", "#2dd4bf",
];

function hexA(hex: string, alpha: number) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function topicLabel(title: string | null, entities: string[], id: number) {
  return title ?? entities[0] ?? `topic ${id}`;
}

interface StarNode extends SimulationNodeDatum {
  id: number;
  label: string;
  entities: string[];
  size: number;
  r: number;
  color: string;
  phase: number;
}

interface StarLink extends SimulationLinkDatum<StarNode> {
  weight: number;
}

/**
 * TopicConstellation — canvas star-map of the largest topic communities.
 * Fills its parent (measure via ResizeObserver), so the parent decides the
 * footprint. Layout is a pre-ticked d3-force simulation (static, cheap); the
 * render loop animates star pulses and photons drifting along the strongest
 * inter-topic bridges. Hover a star for its top entities.
 */
function TopicConstellation({
  data,
  maxNodes,
  labelCount,
}: {
  data: TopicMapData;
  maxNodes: number;
  labelCount: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const projectRef = useRef<{ px: (n: StarNode) => number; py: (n: StarNode) => number; s: number } | null>(null);
  const [dims, setDims] = useState({ w: 0, h: 0 });
  const [hover, setHover] = useState<StarNode | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setDims({ w: el.clientWidth, h: el.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const layout = useMemo(() => {
    const top = [...data.nodes].sort((a, b) => b.size - a.size).slice(0, maxNodes);
    const ids = new Set(top.map((n) => n.id));
    const rawLinks = data.links.filter((l) => ids.has(l.source) && ids.has(l.target));
    const maxSize = Math.max(1, ...top.map((n) => n.size));
    const maxWeight = Math.max(1, ...rawLinks.map((l) => l.weight));

    const adjacency = new Map<number, Set<number>>();
    for (const l of rawLinks) {
      if (!adjacency.has(l.source)) adjacency.set(l.source, new Set());
      if (!adjacency.has(l.target)) adjacency.set(l.target, new Set());
      adjacency.get(l.source)!.add(l.target);
      adjacency.get(l.target)!.add(l.source);
    }

    const nodes: StarNode[] = top.map((n, i) => ({
      id: n.id,
      label: topicLabel(n.title, n.top_entities, n.id),
      entities: n.top_entities,
      size: n.size,
      r: 2.2 + 7 * Math.sqrt(n.size / maxSize),
      color: TOPIC_COLORS[i % TOPIC_COLORS.length],
      // Golden-angle phase offsets keep the pulse organic rather than lockstep.
      phase: (i * 2.399963) % (Math.PI * 2),
    }));
    const links: StarLink[] = rawLinks.map((l) => ({ source: l.source, target: l.target, weight: l.weight }));

    const sim = forceSimulation(nodes)
      .force(
        "link",
        forceLink<StarNode, StarLink>(links)
          .id((d) => d.id)
          .distance(26)
          .strength((l) => 0.2 + 0.6 * (l.weight / maxWeight)),
      )
      .force("charge", forceManyBody().strength(-70))
      // Stronger y-gravity flattens the cloud into the panel's wide aspect.
      .force("x", forceX(0).strength(0.05))
      .force("y", forceY(0).strength(0.16))
      .force("collide", forceCollide<StarNode>((d) => d.r + 5))
      .stop();
    for (let i = 0; i < 300; i++) sim.tick();

    const particles = [...links]
      .sort((a, b) => b.weight - a.weight)
      .slice(0, Math.min(24, links.length))
      .map((l, i) => ({
        link: l,
        speed: 0.05 + 0.1 * (l.weight / maxWeight),
        phase: (i * 0.618) % 1,
      }));
    const labeled = new Set(
      [...nodes].sort((a, b) => b.size - a.size).slice(0, labelCount).map((n) => n.id),
    );
    return { nodes, links, particles, labeled, adjacency, maxWeight };
  }, [data, maxNodes, labelCount]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const { w: width, h: height } = dims;
    if (!canvas || width === 0 || height === 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);

    const { nodes, links, particles, labeled, adjacency, maxWeight } = layout;

    // Fit the simulated layout into the canvas with padding.
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const n of nodes) {
      minX = Math.min(minX, (n.x ?? 0) - n.r);
      maxX = Math.max(maxX, (n.x ?? 0) + n.r);
      minY = Math.min(minY, (n.y ?? 0) - n.r);
      maxY = Math.max(maxY, (n.y ?? 0) + n.r);
    }
    const pad = 14;
    const s = Math.min(
      (width - pad * 2) / Math.max(1, maxX - minX),
      (height - pad * 2) / Math.max(1, maxY - minY),
    );
    const ox = (width - (maxX + minX) * s) / 2;
    const oy = (height - (maxY + minY) * s) / 2;
    const px = (n: StarNode) => ox + (n.x ?? 0) * s;
    const py = (n: StarNode) => oy + (n.y ?? 0) * s;
    projectRef.current = { px, py, s };

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const isDim = (n: StarNode) =>
      hover !== null && hover.id !== n.id && !adjacency.get(hover.id)?.has(n.id);

    const draw = (nowMs: number) => {
      const t = nowMs / 1000;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);

      // Radar rings behind the map for depth.
      const cx = width / 2, cy = height / 2;
      const ringMax = Math.min(width, height) * 0.46;
      ctx.strokeStyle = "rgba(45,212,191,0.06)";
      ctx.lineWidth = 1;
      for (const f of [0.45, 0.75, 1]) {
        ctx.beginPath();
        ctx.arc(cx, cy, ringMax * f, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Bridges between topics.
      for (const l of links) {
        const a = l.source as StarNode, b = l.target as StarNode;
        const active = hover && (a.id === hover.id || b.id === hover.id);
        ctx.beginPath();
        ctx.moveTo(px(a), py(a));
        ctx.lineTo(px(b), py(b));
        ctx.strokeStyle = active
          ? "rgba(103,232,249,0.55)"
          : `rgba(94,234,212,${hover ? 0.04 : 0.05 + 0.13 * (l.weight / maxWeight)})`;
        ctx.lineWidth = active ? 1.2 : 0.7;
        ctx.stroke();
      }

      // Photons drifting along the strongest bridges.
      if (!reduced) {
        for (const p of particles) {
          const a = p.link.source as StarNode, b = p.link.target as StarNode;
          const k = (t * p.speed + p.phase) % 1;
          const x = px(a) + (px(b) - px(a)) * k;
          const y = py(a) + (py(b) - py(a)) * k;
          const g = ctx.createRadialGradient(x, y, 0, x, y, 3.2);
          g.addColorStop(0, "rgba(165,243,252,0.9)");
          g.addColorStop(1, "rgba(165,243,252,0)");
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(x, y, 3.2, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // Topic stars: halo + body + hot nucleus.
      for (const n of nodes) {
        const x = px(n), y = py(n);
        const pulse = reduced ? 1 : 1 + 0.07 * Math.sin(t * 1.6 + n.phase);
        const r = Math.max(1.6, n.r * s) * pulse;
        const dim = isDim(n);

        const halo = ctx.createRadialGradient(x, y, 0, x, y, r * 3);
        halo.addColorStop(0, hexA(n.color, dim ? 0.06 : 0.3));
        halo.addColorStop(1, hexA(n.color, 0));
        ctx.fillStyle = halo;
        ctx.beginPath();
        ctx.arc(x, y, r * 3, 0, Math.PI * 2);
        ctx.fill();

        ctx.globalAlpha = dim ? 0.25 : 0.95;
        ctx.fillStyle = n.color;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = "rgba(240,253,255,0.85)";
        ctx.beginPath();
        ctx.arc(x, y, Math.max(0.6, r * 0.35), 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;

        if (hover?.id === n.id) {
          ctx.beginPath();
          ctx.arc(x, y, r + 3.5, 0, Math.PI * 2);
          ctx.strokeStyle = "rgba(248,250,252,0.8)";
          ctx.lineWidth = 1;
          ctx.setLineDash([3, 3]);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }

      // Callsigns for the biggest communities (plus whatever is hovered).
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.font = "600 9px ui-monospace, SFMono-Regular, Menlo, monospace";
      for (const n of nodes) {
        const wanted = labeled.has(n.id) || hover?.id === n.id;
        if (!wanted || isDim(n)) continue;
        const x = px(n);
        const y = py(n) + Math.max(1.6, n.r * s) + 4;
        const raw = n.label.toUpperCase();
        const text = raw.length > 18 ? `${raw.slice(0, 17)}…` : raw;
        const w = ctx.measureText(text).width;
        ctx.fillStyle = "rgba(2,6,23,0.72)";
        ctx.fillRect(x - w / 2 - 2, y - 1, w + 4, 11);
        ctx.fillStyle = "rgba(203,225,235,0.85)";
        ctx.fillText(text, x, y);
      }
    };

    if (reduced) {
      draw(performance.now());
      return;
    }
    let raf = requestAnimationFrame(function loop(now) {
      draw(now);
      raf = requestAnimationFrame(loop);
    });
    return () => cancelAnimationFrame(raf);
  }, [layout, dims, hover]);

  const handleMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const proj = projectRef.current;
    if (!proj) return;
    let best: StarNode | null = null;
    let bestD = Infinity;
    for (const n of layout.nodes) {
      const d = Math.hypot(proj.px(n) - mx, proj.py(n) - my);
      if (d < Math.max(9, n.r * proj.s + 4) && d < bestD) {
        best = n;
        bestD = d;
      }
    }
    setHover((prev) => (prev?.id === best?.id ? prev : best));
  };

  return (
    <div ref={containerRef} className="relative h-full w-full">
      <canvas
        ref={canvasRef}
        style={{ width: "100%", height: "100%" }}
        className="block cursor-crosshair"
        onMouseMove={handleMove}
        onMouseLeave={() => setHover(null)}
      />
      {hover && (
        <div className="pointer-events-none absolute left-2 top-2 max-w-[85%] rounded-md border border-slate-800 bg-slate-950/90 px-2.5 py-1.5 text-[10px]">
          <div className="flex items-center gap-1.5 font-semibold text-slate-200">
            <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: hover.color }} />
            <span className="truncate">{hover.label}</span>
            <span className="shrink-0 text-slate-500">· {hover.size.toLocaleString()} entities</span>
          </div>
          {hover.entities.length > 1 && (
            <div className="mt-0.5 truncate text-slate-500">{hover.entities.slice(0, 4).join(" · ")}</div>
          )}
        </div>
      )}
    </div>
  );
}

export function KnowledgeStation() {
  const [stats, setStats] = useState<PraxisStats | null>(null);
  const [topicMap, setTopicMap] = useState<TopicMapData | null>(null);
  const [err, setErr] = useState(false);
  const [mapErr, setMapErr] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let active = true;
    const loadStats = async () => {
      try {
        const res = await fetch("/api/praxis/stats", { cache: "no-store" });
        if (!res.ok) throw new Error();
        const data = await res.json();
        if (active) {
          setStats(data);
          setErr(false);
        }
      } catch {
        if (active) setErr(true);
      }
    };
    const loadMap = async () => {
      try {
        const map = await getTopicMap();
        if (active) {
          setTopicMap(map);
          setMapErr(false);
        }
      } catch {
        if (active) setMapErr(true);
      }
    };
    loadStats();
    loadMap();
    const t1 = setInterval(loadStats, 60_000);
    const t2 = setInterval(loadMap, 5 * 60_000);
    return () => {
      active = false;
      clearInterval(t1);
      clearInterval(t2);
    };
  }, []);

  const hasMap = (topicMap?.nodes.length ?? 0) >= 2;

  const legend = useMemo(() => {
    if (!topicMap) return [];
    return [...topicMap.nodes]
      .sort((a, b) => b.size - a.size)
      .slice(0, 6)
      .map((n, i) => ({
        color: TOPIC_COLORS[i % TOPIC_COLORS.length],
        label: topicLabel(n.title, n.top_entities, n.id),
        size: n.size,
        entities: n.top_entities,
      }));
  }, [topicMap]);

  const tiles: { value: string; label: string }[] = [
    { value: fmt(stats?.neo4jNodes), label: "graph nodes" },
    { value: fmt(stats?.pineconeVectors), label: "vectors" },
    { value: fmt(topicMap?.nodes.length), label: "topics" },
    { value: fmt(stats?.mcpToolCount), label: "mcp tools" },
  ];

  return (
    <HudPanel
      icon={<BrainCircuit size={16} />}
      title="SCIENCE — KNOWLEDGE"
      accent="teal"
      className="flex h-full flex-col"
      headerRight={
        <Link href="/knowledge-ingestion" className="flex items-center gap-1 text-[11px] text-cyan-400 hover:text-cyan-300">
          graph console <ArrowUpRight size={12} />
        </Link>
      }
    >
      {err && !stats && !hasMap ? (
        <div className="py-4 text-center text-xs text-slate-500">Cortex stats unavailable</div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1 gap-3">
            {/* Stats rail */}
            <div className="flex w-[96px] shrink-0 flex-col justify-between gap-2">
              {tiles.map((t) => (
                <button
                  key={t.label}
                  onClick={() => setExpanded(true)}
                  className="rounded-md border border-slate-800/60 bg-slate-950/40 px-2 py-1.5 text-left transition-colors hover:border-teal-500/30 hover:bg-slate-800/40"
                  title="Expand knowledge telemetry"
                >
                  <div className="text-lg font-bold leading-tight tabular-nums text-white">{t.value}</div>
                  <div className="text-[9px] uppercase tracking-wide text-slate-500">{t.label}</div>
                </button>
              ))}
            </div>

            {/* Constellation fills the rest */}
            {hasMap ? (
              <button
                onClick={() => setExpanded(true)}
                className="relative min-h-[196px] min-w-0 flex-1 overflow-hidden rounded-md border border-slate-800/70 bg-slate-950/60 text-left transition-colors hover:border-teal-500/30"
                title="Expand the topic constellation"
              >
                <TopicConstellation data={topicMap!} maxNodes={26} labelCount={5} />
              </button>
            ) : (
              <div className="flex min-h-[196px] min-w-0 flex-1 items-center justify-center rounded-md border border-dashed border-slate-800 px-2 text-center text-[10px] text-slate-600">
                {mapErr
                  ? "topic map offline — the constellation returns when the cortex answers"
                  : "resolving cortex topology…"}
              </div>
            )}
          </div>

          {hasMap && (
            <div className="mt-1.5 flex items-center justify-between gap-2 text-[10px] text-slate-500">
              <span className="truncate">
                <span className="text-teal-400">◉</span> live topic constellation · {topicMap!.links.length} bridges ·
                hover a star for its entities
              </span>
              <span className="shrink-0 text-slate-600">mapped {timeAgo(topicMap!.computed_at)}</span>
            </div>
          )}
        </div>
      )}

      {expanded && (
        <HudModal
          title="Knowledge constellation"
          subtitle={
            topicMap
              ? `cortex topic map · ${topicMap.nodes.length} communities · mapped ${timeAgo(topicMap.computed_at)}`
              : "cortex topic map"
          }
          icon={<BrainCircuit size={15} />}
          accent="teal"
          onClose={() => setExpanded(false)}
          wide
        >
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-2">
              <HudStat label="graph nodes" value={fmt(stats?.neo4jNodes)} tone="text-teal-300" />
              <HudStat label="vectors" value={fmt(stats?.pineconeVectors)} tone="text-blue-300" />
              <HudStat label="mcp tools" value={fmt(stats?.mcpToolCount)} />
            </div>

            {hasMap ? (
              <>
                <div className="h-[400px] overflow-hidden rounded-md border border-slate-800/70 bg-slate-950/60">
                  <TopicConstellation data={topicMap!} maxNodes={72} labelCount={14} />
                </div>
                <div className="grid gap-1.5 sm:grid-cols-2">
                  {legend.map((l) => (
                    <div key={l.label} className="flex min-w-0 items-center gap-2 text-[11px]">
                      <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: l.color }} />
                      <span className="truncate text-slate-300">{l.label}</span>
                      <span className="shrink-0 text-slate-500">{l.size.toLocaleString()} entities</span>
                    </div>
                  ))}
                </div>
                <p className="text-[11px] text-slate-500">
                  Each star is a topic community in the knowledge graph, sized by member count; bridges show how strongly
                  topics interlink. Hover a star for its top entities — open the graph console to explore entity-level.
                </p>
              </>
            ) : (
              <p className="rounded border border-dashed border-slate-800 px-3 py-4 text-center text-xs text-slate-600">
                {mapErr ? "Topic map unavailable — cortex offline?" : "Resolving cortex topology…"}
              </p>
            )}

            <Link
              href="/knowledge-ingestion"
              className="inline-flex items-center gap-1 text-[11px] text-cyan-400 hover:text-cyan-300"
            >
              open graph console <ArrowUpRight size={12} />
            </Link>
          </div>
        </HudModal>
      )}
    </HudPanel>
  );
}

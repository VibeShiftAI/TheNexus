"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type SimulationLinkDatum, type SimulationNodeDatum } from "d3-force";
import type { TopicMapData, TopicMapNode } from "@/lib/ingestion-control";
import { topicAccessStrength, visibleTopicAccesses, type TopicAccess } from "@/lib/topic-activity";
const NO_ACCESSES: TopicAccess[] = [];
/** Same palette as the graph console so topics read consistently across views. */
export const TOPIC_COLORS = [
  "#22d3ee", "#a78bfa", "#34d399", "#fbbf24", "#f472b6",
  "#60a5fa", "#fb923c", "#4ade80", "#e879f9", "#2dd4bf",
];

function hexA(hex: string, alpha: number) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

export function topicLabel(title: string | null, entities: string[], id: number) {
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
export function TopicConstellation({
  data,
  maxNodes,
  labelCount,
  accesses = NO_ACCESSES,
  onSelect,
  onExpand,
}: {
  data: TopicMapData;
  maxNodes: number;
  labelCount: number;
  accesses?: TopicAccess[];
  onSelect?: (topic: TopicMapNode) => void;
  onExpand?: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const projectRef = useRef<{ px: (n: StarNode) => number; py: (n: StarNode) => number; s: number } | null>(null);
  const [dims, setDims] = useState({ w: 0, h: 0 });
  const [inView, setInView] = useState(true);
  const [hover, setHover] = useState<StarNode | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setDims({ w: el.clientWidth, h: el.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    const visibility = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting));
    visibility.observe(el);
    return () => { observer.disconnect(); visibility.disconnect(); };
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
      // Fixed golden-angle orientation gives each crystal its own silhouette.
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
        speed: 0.035 + 0.045 * (l.weight / maxWeight),
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
    const pad = 26;
    const s = Math.min(
      (width - pad * 2) / Math.max(1, maxX - minX),
      (height - pad * 2) / Math.max(1, maxY - minY),
    );
    const ox = (width - (maxX + minX) * s) / 2;
    const oy = (height - (maxY + minY) * s) / 2;
    const px = (n: StarNode) => ox + (n.x ?? 0) * s;
    const py = (n: StarNode) => oy + (n.y ?? 0) * s;
    projectRef.current = { px, py, s };

    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const isDim = (n: StarNode) =>
      hover !== null && hover.id !== n.id && !adjacency.get(hover.id)?.has(n.id);

    const draw = (nowMs: number) => {
      const t = nowMs / 1000;
      const reduced = motion.matches;
      const now = Date.now();
      const touched = new Map(visibleTopicAccesses(accesses, data, now)
        .map(a => [a.topicId, topicAccessStrength(a.at, now)]));
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
        // Co-accessed endpoints only; a read of one topic must not imply that
        // every connected topic was also retrieved.
        const access = Math.min(touched.get(a.id) ?? 0, touched.get(b.id) ?? 0);
        ctx.beginPath();
        ctx.moveTo(px(a), py(a));
        ctx.lineTo(px(b), py(b));
        ctx.strokeStyle = active
          ? "rgba(103,232,249,0.55)"
          : hexA("#7dd3fc", hover ? .04 : .06 + .14 * (l.weight / maxWeight) + access * .1);
        ctx.lineWidth = active ? 1.2 : 0.7;
        ctx.stroke();
      }

      // Photons drifting along the strongest bridges.
      {
        for (const p of particles) {
          const a = p.link.source as StarNode, b = p.link.target as StarNode;
          const k = reduced ? p.phase : (t * p.speed + p.phase) % 1;
          const access = Math.min(touched.get(a.id) ?? 0, touched.get(b.id) ?? 0);
          const x = px(a) + (px(b) - px(a)) * k;
          const y = py(a) + (py(b) - py(a)) * k;
          const g = ctx.createRadialGradient(x, y, 0, x, y, 2.4);
          g.addColorStop(0, hexA("#a5f3fc", .5 + access * .35));
          g.addColorStop(1, "rgba(165,243,252,0)");
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(x, y, 2.4, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // Each community is a tiny crystalline instrument: shell, facets,
      // orbit filaments and satellite points. No flat filled discs.
      for (const n of nodes) {
        const x = px(n), y = py(n), dim = isDim(n);
        const r = Math.min(24, Math.max(3, n.r * s));
        const access = touched.get(n.id) ?? 0;
        const color = n.color;
        const spin = n.phase;
        ctx.save(); ctx.translate(x, y); ctx.globalAlpha = dim ? .2 : 1;
        const halo = ctx.createRadialGradient(0, 0, r * .15, 0, 0, r * 2.6);
        halo.addColorStop(0, hexA(color, .18)); halo.addColorStop(1, hexA(color, 0));
        ctx.fillStyle = halo; ctx.fillRect(-r * 3, -r * 3, r * 6, r * 6);
        const vertices = Array.from({length: 6}, (_, i) => {
          const angle = n.phase + i * Math.PI / 3;
          return {x: Math.cos(angle) * r * .78, y: Math.sin(angle) * r * .78};
        });
        ctx.beginPath(); vertices.forEach((v, i) => i ? ctx.lineTo(v.x, v.y) : ctx.moveTo(v.x, v.y)); ctx.closePath();
        ctx.fillStyle = "#071422"; ctx.fill(); ctx.strokeStyle = hexA(color, .9); ctx.lineWidth = .8; ctx.stroke();
        vertices.forEach((v, i) => {
          const next = vertices[(i + 1) % 6];
          ctx.beginPath(); ctx.moveTo(-r * .15, -r * .12); ctx.lineTo(v.x, v.y); ctx.lineTo(next.x, next.y); ctx.closePath();
          ctx.fillStyle = hexA(color, (i % 2 ? .06 : .25) + access * .22); ctx.fill();
          ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(v.x, v.y); ctx.strokeStyle = hexA(color, .32 + access * .3); ctx.lineWidth = .6; ctx.stroke();
        });
        for (let ring = 0; ring < 2; ring++) {
          ctx.beginPath(); ctx.ellipse(0, 0, r * 1.25, r * .54, spin + ring * 1.35, .2, Math.PI * 1.9);
          ctx.strokeStyle = hexA(n.color, .48); ctx.lineWidth = .65; ctx.stroke();
          const a = spin + ring * 2.4;
          ctx.beginPath(); ctx.arc(Math.cos(a) * r * 1.25, Math.sin(a) * r * .54, Math.max(.7, r * .065), 0, Math.PI * 2);
          ctx.fillStyle = hexA(n.color, .95); ctx.fill();
        }
        const core = ctx.createRadialGradient(-r * .07, -r * .1, 0, 0, 0, r * .4);
        core.addColorStop(0, "#ecfeff"); core.addColorStop(.25, hexA(color, .9)); core.addColorStop(.55, hexA(color, .35 + access * .4)); core.addColorStop(1, hexA(color, 0));
        ctx.fillStyle = core; ctx.beginPath(); ctx.arc(0, 0, r * .4, 0, Math.PI * 2); ctx.fill();
        if (hover?.id === n.id) {
          ctx.beginPath(); ctx.arc(0, 0, r * 1.5, 0, Math.PI * 2); ctx.strokeStyle = "#e2e8f0"; ctx.lineWidth = .8;
          ctx.setLineDash([2, 4]); ctx.stroke(); ctx.setLineDash([]);
        }
        ctx.restore();
      }

      // Callsigns for the biggest communities (plus whatever is hovered).
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.font = "600 9px ui-monospace, SFMono-Regular, Menlo, monospace";
      const labelBoxes: {left: number; right: number; top: number; bottom: number}[] = [];
      for (const n of [...nodes].sort((a,b) => a.id === hover?.id ? -1 : b.id === hover?.id ? 1 : b.size-a.size)) {
        const wanted = labeled.has(n.id) || hover?.id === n.id;
        if (!wanted || isDim(n)) continue;
        let x = px(n);
        const y = py(n) + Math.min(24, Math.max(3, n.r * s)) * 1.3 + 4;
        const raw = n.label.toUpperCase();
        const text = raw.length > 18 ? `${raw.slice(0, 17)}…` : raw;
        const w = ctx.measureText(text).width;
        x = Math.max(w / 2 + 3, Math.min(width - w / 2 - 3, x));
        const box = {left:x-w/2-4, right:x+w/2+4, top:y-2, bottom:y+12};
        if (labelBoxes.some(b => box.left < b.right && box.right > b.left && box.top < b.bottom && box.bottom > b.top)) continue;
        labelBoxes.push(box);
        ctx.fillStyle = "rgba(2,6,23,0.72)";
        ctx.fillRect(x - w / 2 - 2, y - 1, w + 4, 11);
        ctx.fillStyle = "rgba(203,225,235,0.85)";
        ctx.fillText(text, x, y);
      }
    };

    let raf = 0, lastFrame = -Infinity;
    const loop = (at: number) => {
      // Slow bridge photons need only 30 painted frames/sec. Offscreen and
      // hidden canvases stop entirely; reduced motion gets a static frame.
      if (at - lastFrame >= 1000 / 30) { draw(at); lastFrame = at; }
      if (!document.hidden && inView && !motion.matches) raf = requestAnimationFrame(loop);
    };
    const resume = () => { cancelAnimationFrame(raf); lastFrame = -Infinity; if (!document.hidden && inView) loop(performance.now()); };
    resume();
    document.addEventListener("visibilitychange", resume);
    motion.addEventListener?.("change", resume);
    return () => { cancelAnimationFrame(raf); document.removeEventListener("visibilitychange", resume); motion.removeEventListener?.("change", resume); };
  }, [layout, data, dims, hover, inView, accesses]);

  const hitTest = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = (e.clientX - rect.left) * dims.w / rect.width;
    const my = (e.clientY - rect.top) * dims.h / rect.height;
    const proj = projectRef.current;
    if (!proj) return;
    let best: StarNode | null = null;
    let bestD = Infinity;
    for (const n of layout.nodes) {
      const d = Math.hypot(proj.px(n) - mx, proj.py(n) - my);
      if (d < Math.max(10, Math.min(24, n.r * proj.s) * 1.5) && d < bestD) {
        best = n;
        bestD = d;
      }
    }
    return best;
  };

  return (
    <div ref={containerRef} className="relative h-full w-full">
      <canvas
        ref={canvasRef}
        style={{ width: "100%", height: "100%" }}
        className="block cursor-crosshair"
        role="button"
        tabIndex={0}
        aria-label="Explore knowledge communities"
        data-active-topics={visibleTopicAccesses(accesses, data, Date.now()).filter(a => layout.nodes.some(n => n.id === a.topicId)).map(a => a.topicId).join(",")}
        onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onExpand?.(); } }}
        onClick={e => { const hit = hitTest(e); const topic = hit && data.nodes.find(n => n.id === hit.id); if (topic) onSelect?.(topic); else onExpand?.(); }}
        onMouseMove={e => { const best = hitTest(e) ?? null; setHover(prev => prev?.id === best?.id ? prev : best); }}
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


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

import { useCallback, useEffect, useMemo, useState } from "react";
import { useLiveRefetch } from "@/components/live-board-state";
import Link from "next/link";
import { BrainCircuit, ArrowUpRight, FilePenLine, Radio } from "lucide-react";
import { HudPanel, HudModal, HudStat } from "@/components/bridge/hud";
import { getTopicMap, type TopicMapData, type TopicMapNode } from "@/lib/ingestion-control";

import { TopicConstellation, TOPIC_COLORS, topicLabel } from "./topic-constellation";
import { KnowledgeCommunity } from "./knowledge-community";
import { useBridgeActivity } from "./activity-provider";
import { ActivityList, ActivityDetails } from "./activity-monitor";
import type { ActivityChannel, ActivityItem } from "@/lib/bridge-activity";
import { visibleTopicAccesses } from "@/lib/topic-activity";

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

export function KnowledgeStation() {
  const [stats, setStats] = useState<PraxisStats | null>(null);
  const [topicMap, setTopicMap] = useState<TopicMapData | null>(null);
  const [err, setErr] = useState(false);
  const [mapErr, setMapErr] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [selectedTopic, setSelectedTopic] = useState<TopicMapNode | null>(null);
  const [activityChannel, setActivityChannel] = useState<ActivityChannel | null>(null);
  const [detail, setDetail] = useState<ActivityItem | null>(null);
  const { channels, topicAccesses, topicsAvailable, now } = useBridgeActivity();
  const memoryActivity = channels.find(c => c.id === "memory")!;
  const vaultActivity = channels.find(c => c.id === "vault")!;
  const selectTopic = (topic: TopicMapNode) => { setSelectedTopic(topic); setExpanded(true); };
  const expandMap = () => { setSelectedTopic(null); setExpanded(true); };
  const currentAccesses = useMemo(() => topicMap ? visibleTopicAccesses(topicAccesses, topicMap, now) : [], [topicAccesses, topicMap, now]);
  const constellationActivity = { accesses: currentAccesses, onSelect: selectTopic, onExpand: expandMap };

  const loadStats = useCallback(async () => {
    try {
      const res = await fetch("/api/praxis/stats", { cache: "no-store" });
      if (!res.ok) throw new Error();
      setStats(await res.json());
      setErr(false);
    } catch {
      setErr(true);
    }
  }, []);

  const loadMap = useCallback(async () => {
    try {
      setTopicMap(await getTopicMap());
      setMapErr(false);
    } catch {
      setMapErr(true);
    }
  }, []);

  // D-1: vault counts and the topic map change when the ingestion pipeline
  // runs, which publishes no stream frame — poll only, through the shared
  // mechanism. Two cadences, so two subscriptions: the map is expensive to
  // recompute and moves far more slowly than the counts.
  useLiveRefetch([], () => void loadStats(), { fallbackPollMs: 60_000 });
  useLiveRefetch([], () => void loadMap(), { fallbackPollMs: 5 * 60_000 });

  const hasMap = (topicMap?.nodes.length ?? 0) >= 2;

  const legend = useMemo(() => {
    if (!topicMap) return [];
    return [...topicMap.nodes]
      .sort((a, b) => b.size - a.size)
      .slice(0, 6)
      .map((n, i) => ({
        ...n,
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
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1 flex-col gap-3">
            {/* Stats rail */}
            <div className="order-2 grid shrink-0 grid-cols-4 gap-2">
              {tiles.map((t) => (
                <button
                  key={t.label}
                  onClick={expandMap}
                  className="rounded-md border border-slate-800/60 bg-slate-950/40 px-2 py-1.5 text-left transition-colors hover:border-teal-500/30 hover:bg-slate-800/40"
                  title="Expand knowledge telemetry"
                >
                  <div className="text-lg font-bold leading-tight tabular-nums text-white">{t.value}</div>
                  <div className="text-[9px] uppercase tracking-wide text-slate-500">{t.label}</div>
                </button>
              ))}
            </div>

            {/* Constellation fills the rest */}
              <div className="relative min-h-[290px] min-w-0 flex-1 overflow-hidden rounded-lg border border-slate-800/70 bg-slate-950/70">
                <div className="absolute inset-0">{hasMap ? <TopicConstellation data={topicMap!} maxNodes={26} labelCount={5} {...constellationActivity} /> : <div className="flex h-full items-center justify-center px-6 text-center text-xs text-slate-500">{mapErr || err ? "Topic map unavailable · access reports remain available" : "Resolving Cortex topology…"}</div>}</div>
                <div className="pointer-events-none absolute inset-x-3 top-3 flex justify-between gap-2">
                  {[{ state: memoryActivity, id: "memory" as const, label: "Memory", Icon: BrainCircuit, color: "#2dd4bf" }, { state: vaultActivity, id: "vault" as const, label: "Vault", Icon: FilePenLine, color: "#a78bfa" }].map(({state, id, label, Icon, color}) => <button type="button" key={id} onClick={() => { setActivityChannel(id); setDetail(null); }} aria-label={`Inspect ${label} activity`} className="pointer-events-auto flex items-center gap-1.5 rounded-full border border-slate-700/60 bg-slate-950/90 px-2 py-1 text-[10px] hover:border-slate-400" style={{color: state.available ? color : "#64748b", boxShadow: state.hot ? `0 0 18px ${color}40` : undefined}}>
                    <Icon size={12} className={state.hot ? "module-breathe" : ""}/><span>{label}</span><span className="w-[4em] text-center text-slate-400">{!state.available ? "offline" : state.hot ? state.latest?.status === "failed" ? "failed" : id === "vault" ? "write" : "access" : state.recent > 0 ? "recent" : "quiet"}</span>
                  </button>)}
                </div>
                <button type="button" onClick={() => { setActivityChannel("memory"); setDetail(null); }} className="absolute bottom-2 left-2 flex h-6 max-w-[calc(100%-3.5rem)] items-center gap-1.5 rounded bg-slate-950/85 px-2 text-[10px] text-slate-400 hover:text-teal-200" aria-label="Inspect topic access records">
                  <span className="h-1 w-1 shrink-0 rounded-full" style={{backgroundColor:currentAccesses.length ? "#5eead4" : "#475569"}} />
                  <span className="truncate">{!topicsAvailable ? "Topic access unavailable" : currentAccesses.length ? `${currentAccesses.length} ${currentAccesses.length === 1 ? "topic" : "topics"} accessed · ${currentAccesses[0].title ?? "view activity"}` : "Topic access quiet"}</span>
                </button>
                <button type="button" onClick={expandMap} className="absolute bottom-2 right-2 rounded-md bg-slate-950/80 p-1.5 text-teal-300 hover:text-white" aria-label="Expand the topic constellation"><ArrowUpRight size={14}/></button>
              </div>

          </div>

          {hasMap && (
            <div className="mt-1.5 flex items-center justify-between gap-2 text-[10px] text-slate-500">
              <span className="truncate">
                <span className="text-teal-400">◉</span> {topicMap!.nodes.length} communities · {topicMap!.links.length} bridges
              </span>
              <span className="shrink-0 text-slate-600">mapped {timeAgo(topicMap!.computed_at)}</span>
            </div>
          )}
        </div>

      {expanded && (
        <HudModal
          title={selectedTopic ? topicLabel(selectedTopic.title, selectedTopic.top_entities, selectedTopic.id) : "Knowledge constellation"}
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
          {selectedTopic && topicMap ? <><button type="button" className="mb-4 text-xs text-teal-300" onClick={() => setSelectedTopic(null)}>← Back to constellation</button><KnowledgeCommunity topic={selectedTopic} data={topicMap} onSelect={setSelectedTopic}/></> : <div className="space-y-4">
            <div className="grid grid-cols-3 gap-2">
              <HudStat label="graph nodes" value={fmt(stats?.neo4jNodes)} tone="text-teal-300" />
              <HudStat label="vectors" value={fmt(stats?.pineconeVectors)} tone="text-blue-300" />
              <HudStat label="mcp tools" value={fmt(stats?.mcpToolCount)} />
            </div>

            {hasMap ? (
              <>
                <div className="h-[400px] overflow-hidden rounded-md border border-slate-800/70 bg-slate-950/60">
                  <TopicConstellation data={topicMap!} maxNodes={72} labelCount={14} {...constellationActivity} />
                </div>
                <label className="flex items-center gap-2 text-xs text-slate-400">Inspect a community
                  <select value="" onChange={e => { const topic = topicMap!.nodes.find(n => n.id === Number(e.target.value)); if (topic) selectTopic(topic); }} className="min-w-0 flex-1 rounded border border-slate-700 bg-slate-900 p-2 text-slate-200"><option value="" disabled>Select a topic…</option>{[...topicMap!.nodes].sort((a,b) => b.size-a.size).map(n => <option key={n.id} value={n.id}>{topicLabel(n.title,n.top_entities,n.id)}</option>)}</select>
                </label>
                <div className="grid gap-1.5 sm:grid-cols-2">
                  {legend.map((l) => (
                    <button type="button" onClick={() => selectTopic(l)} key={l.id} className="flex min-w-0 items-center gap-2 rounded p-1 text-left text-[11px] hover:bg-slate-800">
                      <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: l.color }} />
                      <span className="truncate text-slate-300">{l.label}</span>
                      <span className="shrink-0 text-slate-500">{l.size.toLocaleString()} entities</span>
                    </button>
                  ))}
                </div>
                <p className="text-[11px] text-slate-500">
                  Each crystal is a topic community in the knowledge graph, sized by member count; bridges show how strongly
                  topics interlink. Select a crystal to inspect its entities and connected communities. Retrieved topics briefly brighten inside their crystals. Small drifting dots trace the bridges; brighter bridges connect two recently accessed topics. Memory and vault reports show the recorded activity.
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
          </div>}
        </HudModal>
      )}
      {activityChannel && <HudModal title={detail ? "Knowledge activity detail" : activityChannel === "memory" ? "Memory access" : "Vault writes"} icon={<Radio size={15}/>} accent={activityChannel === "memory" ? "teal" : "purple"} onClose={() => {setActivityChannel(null); setDetail(null);}} wide>
        {detail ? <><button type="button" onClick={() => setDetail(null)} className="mb-4 text-xs text-cyan-300">← Back to activity</button><ActivityDetails item={detail}/></> : <><p className="mb-3 text-xs text-slate-400">{activityChannel === "memory" ? "Topic records show the entities Cortex retrieved. Open a record to explore the knowledge behind it. Other memory calls remain listed below." : "Recorded vault writes and the latest document modifications. Open a record to read its report."}</p><ActivityList channel={activityChannel} onSelect={setDetail}/><Link href={`/activity?channel=${activityChannel}`} className="mt-4 inline-flex items-center gap-1 text-sm text-cyan-300">Open full activity report <ArrowUpRight size={14}/></Link></>}
      </HudModal>}
    </HudPanel>
  );
}

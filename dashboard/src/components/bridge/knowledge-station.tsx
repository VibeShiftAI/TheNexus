/**
 * KnowledgeStation — "Science": headline knowledge-base counters from Praxis
 * /api/praxis/stats (Neo4j nodes, Pinecone vectors) plus a growth chart from
 * the fleet sampler's stats history. Links through to the full graph console
 * on /knowledge-ingestion.
 */
"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { BrainCircuit, ArrowUpRight } from "lucide-react";
import { AreaChart, Area, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { HudPanel, HudModal, HudStat } from "@/components/bridge/hud";

interface PraxisStats {
  neo4jNodes?: number;
  pineconeVectors?: number;
  mcpToolCount?: number;
  dailyCallCount?: number;
}

interface HistoryRow {
  at: string;
  neo4j_nodes: number | null;
  pinecone_vectors: number | null;
  skills_total: number | null;
}

function fmt(n: number | undefined | null) {
  if (n == null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${(n / 1000).toFixed(0)}k`;
  return n.toLocaleString();
}

export function KnowledgeStation() {
  const [stats, setStats] = useState<PraxisStats | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [err, setErr] = useState(false);
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
    const loadHistory = async () => {
      try {
        const res = await fetch("/api/fleet/stats-history?hours=168", { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();
        if (active) setHistory(data.rows ?? []);
      } catch {
        /* history is progressive enhancement */
      }
    };
    loadStats();
    loadHistory();
    const t1 = setInterval(loadStats, 60_000);
    const t2 = setInterval(loadHistory, 5 * 60_000);
    return () => {
      active = false;
      clearInterval(t1);
      clearInterval(t2);
    };
  }, []);

  const chartData = useMemo(
    () =>
      history
        .filter((r) => r.neo4j_nodes != null || r.pinecone_vectors != null)
        .map((r) => ({
          at: new Date(r.at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit" }),
          nodes: r.neo4j_nodes,
          vectors: r.pinecone_vectors,
        })),
    [history]
  );

  const growth = useMemo(() => {
    const pts = history.filter((r) => r.neo4j_nodes != null);
    if (pts.length < 2) return null;
    return (pts[pts.length - 1].neo4j_nodes ?? 0) - (pts[0].neo4j_nodes ?? 0);
  }, [history]);

  const vectorGrowth = useMemo(() => {
    const pts = history.filter((r) => r.pinecone_vectors != null);
    if (pts.length < 2) return null;
    return (pts[pts.length - 1].pinecone_vectors ?? 0) - (pts[0].pinecone_vectors ?? 0);
  }, [history]);

  const tiles: { value: string; label: string }[] = [
    { value: fmt(stats?.neo4jNodes), label: "graph nodes" },
    { value: fmt(stats?.pineconeVectors), label: "vectors" },
    { value: fmt(stats?.mcpToolCount), label: "mcp tools" },
  ];

  return (
    <HudPanel
      icon={<BrainCircuit size={16} />}
      title="SCIENCE — KNOWLEDGE"
      accent="teal"
      headerRight={
        <Link href="/knowledge-ingestion" className="flex items-center gap-1 text-[11px] text-cyan-400 hover:text-cyan-300">
          graph console <ArrowUpRight size={12} />
        </Link>
      }
    >
      {err && !stats ? (
        <div className="py-4 text-center text-xs text-slate-500">Cortex stats unavailable</div>
      ) : (
        <>
          <div className="mb-2 grid grid-cols-3 gap-2">
            {tiles.map((t) => (
              <button
                key={t.label}
                onClick={() => setExpanded(true)}
                className="rounded-md px-1 py-0.5 text-left transition-colors hover:bg-slate-800/50"
                title="Expand knowledge telemetry"
              >
                <div className="text-xl font-bold tabular-nums text-white">{t.value}</div>
                <div className="text-[10px] uppercase tracking-wide text-slate-500">{t.label}</div>
              </button>
            ))}
          </div>

          {chartData.length >= 2 ? (
            <>
              <div className="h-16">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={chartData} margin={{ top: 2, right: 0, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="nodesFill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#2dd4bf" stopOpacity={0.35} />
                        <stop offset="100%" stopColor="#2dd4bf" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <YAxis yAxisId="nodes" domain={["dataMin", "dataMax"]} hide />
                    <YAxis yAxisId="vectors" domain={["dataMin", "dataMax"]} hide />
                    <Tooltip
                      contentStyle={{
                        background: "#0f172a",
                        border: "1px solid #1e293b",
                        borderRadius: 6,
                        fontSize: 11,
                      }}
                      labelStyle={{ color: "#94a3b8" }}
                    />
                    <Area yAxisId="nodes" type="monotone" dataKey="nodes" stroke="#2dd4bf" strokeWidth={1.5} fill="url(#nodesFill)" />
                    <Area yAxisId="vectors" type="monotone" dataKey="vectors" stroke="#60a5fa" strokeWidth={1.2} fill="none" strokeDasharray="4 3" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
              <div className="mt-1 text-[10px] text-slate-500">
                <span className="text-teal-400">■</span>{" "}
                {growth != null && growth >= 0 ? `+${growth.toLocaleString()}` : growth?.toLocaleString()} nodes
                {vectorGrowth != null && (
                  <>
                    {" · "}
                    <span className="text-blue-400">▪</span> {vectorGrowth >= 0 ? "+" : ""}
                    {vectorGrowth.toLocaleString()} vectors
                  </>
                )}{" "}
                over the sampled window
              </div>
            </>
          ) : (
            <div className="rounded border border-dashed border-slate-800 px-2 py-2 text-center text-[10px] text-slate-600">
              growth chart appears as history samples accumulate (every 10 min)
            </div>
          )}
        </>
      )}

      {expanded && (
        <HudModal
          title="Knowledge telemetry"
          subtitle="cortex growth · sampled every 10 min"
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
            {chartData.length >= 2 ? (
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={chartData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="nodesFillLg" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#2dd4bf" stopOpacity={0.35} />
                        <stop offset="100%" stopColor="#2dd4bf" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <XAxis
                      dataKey="at"
                      tick={{ fill: "#64748b", fontSize: 10 }}
                      tickLine={false}
                      axisLine={{ stroke: "#1e293b" }}
                      minTickGap={48}
                    />
                    <YAxis
                      yAxisId="nodes"
                      domain={["dataMin", "dataMax"]}
                      tick={{ fill: "#64748b", fontSize: 10 }}
                      tickLine={false}
                      axisLine={false}
                      width={54}
                      tickFormatter={(v: number) => v.toLocaleString()}
                    />
                    <YAxis yAxisId="vectors" domain={["dataMin", "dataMax"]} hide />
                    <Tooltip
                      contentStyle={{
                        background: "#0f172a",
                        border: "1px solid #1e293b",
                        borderRadius: 6,
                        fontSize: 11,
                      }}
                      labelStyle={{ color: "#94a3b8" }}
                    />
                    <Area yAxisId="nodes" type="monotone" dataKey="nodes" stroke="#2dd4bf" strokeWidth={1.5} fill="url(#nodesFillLg)" />
                    <Area yAxisId="vectors" type="monotone" dataKey="vectors" stroke="#60a5fa" strokeWidth={1.2} fill="none" strokeDasharray="4 3" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <p className="rounded border border-dashed border-slate-800 px-3 py-4 text-center text-xs text-slate-600">
                Growth chart appears as history samples accumulate.
              </p>
            )}
            <div className="text-[11px] text-slate-500">
              <span className="text-teal-400">■</span> graph nodes{" "}
              {growth != null ? `(${growth >= 0 ? "+" : ""}${growth.toLocaleString()})` : ""}
              {" · "}
              <span className="text-blue-400">▪</span> vectors{" "}
              {vectorGrowth != null ? `(${vectorGrowth >= 0 ? "+" : ""}${vectorGrowth.toLocaleString()})` : ""} over the
              sampled window
            </div>
          </div>
        </HudModal>
      )}
    </HudPanel>
  );
}

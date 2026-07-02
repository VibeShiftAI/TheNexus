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
import { AreaChart, Area, ResponsiveContainer, Tooltip, YAxis } from "recharts";

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
        .filter((r) => r.neo4j_nodes != null)
        .map((r) => ({
          at: new Date(r.at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit" }),
          nodes: r.neo4j_nodes,
        })),
    [history]
  );

  const growth = useMemo(() => {
    const pts = history.filter((r) => r.neo4j_nodes != null);
    if (pts.length < 2) return null;
    return (pts[pts.length - 1].neo4j_nodes ?? 0) - (pts[0].neo4j_nodes ?? 0);
  }, [history]);

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <BrainCircuit size={16} className="text-teal-400" />
          <h3 className="text-sm font-bold tracking-tight text-white">SCIENCE — KNOWLEDGE</h3>
        </div>
        <Link href="/knowledge-ingestion" className="flex items-center gap-1 text-[11px] text-cyan-400 hover:text-cyan-300">
          graph console <ArrowUpRight size={12} />
        </Link>
      </div>

      {err && !stats ? (
        <div className="py-4 text-center text-xs text-slate-500">Cortex stats unavailable</div>
      ) : (
        <>
          <div className="mb-2 grid grid-cols-3 gap-2">
            <div>
              <div className="text-xl font-bold tabular-nums text-white">{fmt(stats?.neo4jNodes)}</div>
              <div className="text-[10px] uppercase tracking-wide text-slate-500">graph nodes</div>
            </div>
            <div>
              <div className="text-xl font-bold tabular-nums text-white">{fmt(stats?.pineconeVectors)}</div>
              <div className="text-[10px] uppercase tracking-wide text-slate-500">vectors</div>
            </div>
            <div>
              <div className="text-xl font-bold tabular-nums text-white">{fmt(stats?.mcpToolCount)}</div>
              <div className="text-[10px] uppercase tracking-wide text-slate-500">mcp tools</div>
            </div>
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
                    <YAxis domain={["dataMin", "dataMax"]} hide />
                    <Tooltip
                      contentStyle={{
                        background: "#0f172a",
                        border: "1px solid #1e293b",
                        borderRadius: 6,
                        fontSize: 11,
                      }}
                      labelStyle={{ color: "#94a3b8" }}
                    />
                    <Area type="monotone" dataKey="nodes" stroke="#2dd4bf" strokeWidth={1.5} fill="url(#nodesFill)" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
              <div className="mt-1 text-[10px] text-slate-500">
                {growth != null && growth >= 0 ? `+${growth.toLocaleString()}` : growth?.toLocaleString()} nodes over the
                sampled week
              </div>
            </>
          ) : (
            <div className="rounded border border-dashed border-slate-800 px-2 py-2 text-center text-[10px] text-slate-600">
              growth chart appears as history samples accumulate (every 10 min)
            </div>
          )}
        </>
      )}
    </div>
  );
}

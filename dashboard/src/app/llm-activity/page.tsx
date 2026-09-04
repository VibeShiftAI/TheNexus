"use client";

import React, { useState, useCallback } from "react";
import { useLiveRefetch } from "@/components/live-board-state";

import {
  Activity,
  RefreshCw,
  ArrowLeft,
  Brain,
  Cpu,
  AlertTriangle,
} from "lucide-react";
import Link from "next/link";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";

// ── Types ──────────────────────────────────────────────────────────
interface LLMCall {
  ts: string;
  caller: string;
  provider: string | null;
  model: string | null;
  tier: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  latency_ms: number | null;
  success: number;
  error: string | null;
}
interface CallerAgg { caller: string; calls: number; tokens: number; failures: number }
interface ProviderAgg { provider: string; calls: number; tokens: number }
interface ModelAgg { model: string; provider: string; calls: number; tokens: number }
interface LogResponse {
  recent: LLMCall[];
  aggregates: {
    since_hours: number;
    by_caller: CallerAgg[];
    by_provider: ProviderAgg[];
    by_model: ModelAgg[];
    total_calls: number;
  };
}

const CALLER_COLORS: Record<string, string> = {
  "mcp.claude": "#d97757",
  "mcp.codex": "#22c55e",
  "mcp.antigravity": "#3b82f6",
  // Task-dispatch events (which executor a Nexus task was routed to). Colors
  // mirror each executor's brand so dispatches read consistently alongside
  // that executor's MCP calls.
  "dispatch.claude-code": "#d97757",
  "dispatch.codex": "#22c55e",
  "dispatch.antigravity": "#3b82f6",
};
const PROVIDER_COLORS: Record<string, string> = {
  google: "#3b82f6",
  "google-biz": "#6366f1",
  anthropic: "#f59e0b",
  openai: "#22c55e",
  xai: "#ec4899",
  openrouter: "#8b5cf6",
  local: "#14b8a6",
  // Executors, when they appear as the `provider` of a dispatch event.
  antigravity: "#3b82f6",
  codex: "#22c55e",
  "claude-code": "#d97757",
};
function colorFor(map: Record<string, string>, key: string, i: number) {
  return map[key] || ["#94a3b8", "#64748b", "#475569", "#cbd5e1"][i % 4];
}
function fmt(n: number | null | undefined) {
  if (n == null) return "—";
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
function ago(ts: string) {
  const s = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export default function LLMActivityPage() {
  const [data, setData] = useState<LogResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hours, setHours] = useState(24);
  const [loading, setLoading] = useState(true);
  const [lastFetch, setLastFetch] = useState<Date | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/praxis/llm-log?limit=80&hours=${hours}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as LogResponse;
      setData(json);
      setError(null);
      setLastFetch(new Date());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [hours]);

  // D-1: no Praxis stream frame describes an LLM call, so this stays a poll —
  // but through the shared mechanism, so every poller on the deck is visible
  // in one place. See docs/live-transport-phase2.md § second tranche.
  useLiveRefetch([], load, { fallbackPollMs: 5_000 });

  const agg = data?.aggregates;
  const callerData = (agg?.by_caller ?? []).map((c) => ({ ...c, name: c.caller }));
  const providerData = (agg?.by_provider ?? []).map((p) => ({ ...p, name: p.provider }));

  return (
    <div style={{ minHeight: "100vh", background: "#0a0a0f", color: "#e2e8f0", padding: "24px", fontFamily: "ui-sans-serif, system-ui" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <Link href="/" style={{ color: "#94a3b8", display: "flex", alignItems: "center" }}>
            <ArrowLeft size={20} />
          </Link>
          <Brain size={24} color="#d97757" />
          <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>LLM Activity — who is calling which AI</h1>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <select value={hours} onChange={(e) => setHours(Number(e.target.value))}
            style={{ background: "#1e293b", color: "#e2e8f0", border: "1px solid #334155", borderRadius: 6, padding: "6px 10px" }}>
            <option value={1}>Last 1h</option>
            <option value={6}>Last 6h</option>
            <option value={24}>Last 24h</option>
            <option value={168}>Last 7d</option>
          </select>
          <button onClick={load} style={{ background: "#1e293b", border: "1px solid #334155", borderRadius: 6, padding: 8, color: "#94a3b8", cursor: "pointer" }}>
            <RefreshCw size={16} className={loading ? "spin" : ""} />
          </button>
        </div>
      </div>

      {error && (
        <div style={{ background: "#7f1d1d", border: "1px solid #b91c1c", borderRadius: 8, padding: 12, marginBottom: 16, display: "flex", gap: 8, alignItems: "center" }}>
          <AlertTriangle size={18} /> Failed to load: {error}
        </div>
      )}

      {/* Summary cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16, marginBottom: 24 }}>
        <Card icon={<Activity size={18} />} label={`Total LLM calls (${hours}h)`} value={fmt(agg?.total_calls)} />
        <Card icon={<Cpu size={18} />} label="Distinct callers" value={String(agg?.by_caller?.length ?? 0)} />
        <Card icon={<Brain size={18} />} label="Providers in use" value={String(agg?.by_provider?.length ?? 0)} />
      </div>

      {/* Charts */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 24 }}>
        <Panel title="Calls by caller">
          <ResponsiveContainer width="100%" height={Math.max(180, callerData.length * 38)}>
            <BarChart data={callerData} layout="vertical" margin={{ left: 40, right: 20 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
              <XAxis type="number" stroke="#64748b" fontSize={11} />
              <YAxis type="category" dataKey="name" stroke="#94a3b8" fontSize={11} width={130} />
              <Tooltip contentStyle={{ background: "#1e293b", border: "1px solid #334155", borderRadius: 6 }} />
              <Bar dataKey="calls" radius={[0, 4, 4, 0]}>
                {callerData.map((c, i) => <Cell key={i} fill={colorFor(CALLER_COLORS, c.caller, i)} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </Panel>
        <Panel title="Calls by provider">
          <ResponsiveContainer width="100%" height={Math.max(180, providerData.length * 38)}>
            <BarChart data={providerData} layout="vertical" margin={{ left: 40, right: 20 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
              <XAxis type="number" stroke="#64748b" fontSize={11} />
              <YAxis type="category" dataKey="name" stroke="#94a3b8" fontSize={11} width={90} />
              <Tooltip contentStyle={{ background: "#1e293b", border: "1px solid #334155", borderRadius: 6 }} />
              <Bar dataKey="calls" radius={[0, 4, 4, 0]}>
                {providerData.map((p, i) => <Cell key={i} fill={colorFor(PROVIDER_COLORS, p.provider, i)} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </Panel>
      </div>

      {/* Recent feed */}
      <Panel title={`Recent calls${lastFetch ? ` · updated ${ago(lastFetch.toISOString())} ago` : ""}`}>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ color: "#64748b", textAlign: "left", borderBottom: "1px solid #1e293b" }}>
                <th style={{ padding: "6px 8px" }}>When</th>
                <th style={{ padding: "6px 8px" }}>Caller</th>
                <th style={{ padding: "6px 8px" }}>Provider / Model</th>
                <th style={{ padding: "6px 8px" }}>Tier</th>
                <th style={{ padding: "6px 8px", textAlign: "right" }}>Tokens</th>
                <th style={{ padding: "6px 8px", textAlign: "right" }}>Latency</th>
                <th style={{ padding: "6px 8px" }}>OK</th>
              </tr>
            </thead>
            <tbody>
              {(data?.recent ?? []).map((c, i) => (
                <tr key={i} style={{ borderBottom: "1px solid #111827" }}>
                  <td style={{ padding: "6px 8px", color: "#94a3b8" }}>{ago(c.ts)} ago</td>
                  <td style={{ padding: "6px 8px" }}>
                    <span style={{ background: colorFor(CALLER_COLORS, c.caller, i) + "33", color: colorFor(CALLER_COLORS, c.caller, i), padding: "2px 8px", borderRadius: 12, fontWeight: 600 }}>
                      {c.caller}
                    </span>
                  </td>
                  <td style={{ padding: "6px 8px" }}>
                    <span style={{ color: colorFor(PROVIDER_COLORS, c.provider ?? "", i) }}>{c.provider ?? "—"}</span>
                    <span style={{ color: "#64748b" }}> / {c.model ?? "—"}</span>
                  </td>
                  <td style={{ padding: "6px 8px", color: "#94a3b8" }}>{c.tier ?? "—"}</td>
                  <td style={{ padding: "6px 8px", textAlign: "right", color: "#cbd5e1" }}>{fmt(c.total_tokens)}</td>
                  <td style={{ padding: "6px 8px", textAlign: "right", color: "#cbd5e1" }}>{c.latency_ms != null ? `${(c.latency_ms / 1000).toFixed(1)}s` : "—"}</td>
                  <td style={{ padding: "6px 8px" }}>{c.success ? "✅" : "❌"}</td>
                </tr>
              ))}
              {(!data?.recent || data.recent.length === 0) && (
                <tr><td colSpan={7} style={{ padding: 16, textAlign: "center", color: "#64748b" }}>No calls in window.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Panel>

      <style>{`.spin { animation: spin 1s linear infinite } @keyframes spin { to { transform: rotate(360deg) } }`}</style>
    </div>
  );
}

function Card({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div style={{ background: "#0f172a", border: "1px solid #1e293b", borderRadius: 10, padding: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, color: "#64748b", fontSize: 12, marginBottom: 8 }}>{icon}{label}</div>
      <div style={{ fontSize: 28, fontWeight: 700 }}>{value}</div>
    </div>
  );
}
function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ background: "#0f172a", border: "1px solid #1e293b", borderRadius: 10, padding: 16 }}>
      <h2 style={{ fontSize: 14, fontWeight: 600, color: "#cbd5e1", margin: "0 0 12px" }}>{title}</h2>
      {children}
    </div>
  );
}

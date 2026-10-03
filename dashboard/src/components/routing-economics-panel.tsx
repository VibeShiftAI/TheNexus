"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { EconomicsSummary, RoutingEconomics } from "@/lib/routing-economics";

const laneLabel = { local: "Local", cloud: "Cloud", unknown: "Unknown lane" };
const reasons: Record<string, string> = {
  no_model: "no model recorded", no_token_record: "no token record",
  unpriced_model: "no rate available", unknown_lane: "unknown execution lane",
};
function duration(ms: number | null) {
  if (ms === null) return "No data";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3600000) return `${(ms / 60000).toFixed(1)}m`;
  return `${(ms / 3600000).toFixed(1)}h`;
}
function Coverage({ runs, total }: { runs: number; total: number }) {
  return <span className="mt-1 block text-xs text-slate-400">from {runs} of {total} runs</span>;
}
function SummaryRow({ group, lane = false }: { group: EconomicsSummary; lane?: boolean }) {
  const label = lane ? `${laneLabel[group.lane]} lane` : group.model || "Model not recorded";
  return <tr className={lane ? "border-b border-slate-700 bg-slate-800/70" : "border-b border-slate-800"}>
    <th scope="row" className="p-3 text-left align-top font-medium">
      <span className="block max-w-64 break-words text-slate-100">{label}</span>
      {!lane && <span className="text-xs text-slate-400">{laneLabel[group.lane]} · </span>}
      <span className="text-xs text-slate-400">{group.runCount} runs</span>
      {!!group.runs?.length && <details className="mt-2 text-xs font-normal">
        <summary className="cursor-pointer text-cyan-300">View {group.runCount} runs / logs</summary>
        <ul className="mt-2 max-h-52 space-y-2 overflow-y-auto">
          {group.runs.map(run => <li key={run.id}><Link href={run.href} className="break-all text-cyan-300 hover:underline">
            {run.id} · {run.outcome} · {run.executor} · {run.startedAt}
          </Link></li>)}
        </ul>
      </details>}
    </th>
    {group.state === "no_data" ? <td colSpan={4} className="p-3 align-top text-slate-400">No data — no recorded runs</td> : <>
      <td className="p-3 align-top whitespace-nowrap">
        {group.latency.runs ? <>{duration(group.latency.medianMs)} median<br />{duration(group.latency.worstMs)} worst observed</> : "No data"}
        <Coverage runs={group.latency.runs} total={group.runCount} />
      </td>
      <td className="p-3 align-top">
        {group.tokens.total === null ? "No data" : group.tokens.total.toLocaleString("en-US")}
        {group.tokens.estimatedRuns > 0 && <span className="block text-xs text-amber-300">includes {group.tokens.estimatedRuns} estimated runs</span>}
        <Coverage runs={group.tokens.runs} total={group.runCount} />
      </td>
      <td className="p-3 align-top">
        {group.cost.usd === null ? "Unknown cost" : <span className={group.cost.provenance === "estimated" ? "text-amber-300" : "text-slate-200"}>
          ${group.cost.usd.toFixed(3)} {group.cost.provenance === "estimated" ? "estimate" : "local provider fees"}
        </span>}
        <Coverage runs={group.cost.runs} total={group.runCount} />
        {Object.entries(group.cost.unknownByReason).map(([reason, count]) => <span key={reason} className="block text-xs text-slate-400">{count} runs: {reasons[reason] || reason}</span>)}
      </td>
      <td className="p-3 align-top">
        {group.outcomes.completionRate === null ? "No terminal outcomes" : `${(group.outcomes.completionRate * 100).toFixed(0)}% completed`}
        <Coverage runs={group.outcomes.runs} total={group.runCount} />
        <span className="mt-1 block text-xs text-slate-400">{group.outcomes.completed} completed · {group.outcomes.failed} failed / timed out · {group.outcomes.needsInput} needed input · {group.outcomes.cancelled} cancelled</span>
        {group.outcomes.unfinished > 0 && <span className="block text-xs text-slate-400">{group.outcomes.unfinished} unfinished / unknown</span>}
      </td>
    </>}
  </tr>;
}

export function RoutingEconomicsPanel() {
  const [data, setData] = useState<RoutingEconomics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision(n => n + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    setData(null);
    void (async () => {
      try {
        const response = await fetch("/api/routing-economics", { signal: controller.signal });
        if (!response.ok) throw new Error("Routing economics unavailable; history could not be read.");
        const next = await response.json();
        if (!controller.signal.aborted) setData(next);
      } catch (err) {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "Routing economics unavailable.");
      }
    })();
    return () => controller.abort();
  }, [revision]);
  return <section id="routing-economics" aria-labelledby="routing-economics-title" className="rounded-xl border border-slate-700 bg-slate-900/60 p-4 sm:p-5">
    <div className="flex items-start justify-between gap-3">
      <div><h2 id="routing-economics-title" className="text-lg font-semibold text-white">Measured routing economics</h2>
        <p className="mt-1 text-xs text-slate-400">Observed attempts, including failures. Small samples describe history; they do not predict the next run.</p></div>
      <button type="button" onClick={refresh} className="rounded border border-slate-600 px-3 py-1.5 text-xs text-slate-300 hover:text-white">Refresh</button>
    </div>
    {error ? <p role="alert" className="mt-4 text-amber-300">{error}</p> : !data ? <p className="mt-4 text-sm text-slate-400">Loading run history…</p> : <>
      <p className="mt-3 text-xs text-slate-400">{data.scope}</p>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[780px] text-sm">
          <caption className="sr-only">Routing economics by lane and model, with contributing run counts</caption>
          <thead><tr className="text-left text-xs text-slate-400">{["Model / lane", "Wall-clock latency", "Token total", "Cost subtotal · USD", "Executor outcome"].map(label => <th scope="col" className="p-3" key={label}>{label}</th>)}</tr></thead>
          <tbody>
            {data.lanes.map(group => <SummaryRow key={group.lane} group={group} lane />)}
            {data.models.map(group => <SummaryRow key={`${group.lane}:${group.model}`} group={group} />)}
          </tbody>
        </table>
      </div>
      <p className="mt-4 text-xs leading-relaxed text-amber-200/80">{data.costBasis}</p>
      <p className="mt-2 text-xs leading-relaxed text-slate-400">{data.outcomeBasis}</p>
      {data.generatedAt && <p className="mt-2 text-xs text-slate-500">Read at {new Date(data.generatedAt).toLocaleString()}</p>}
    </>}
  </section>;
}

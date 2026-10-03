/**
 * ProjectClientAccess: the cockpit's read-only view of who may see this
 * project as a client, which artifact versions were published for them, and
 * what they decided (docs/contracts/client-project-access.md, 2026-10-02).
 *
 * Read-only on purpose. A grant or revocation needs Robert's operator
 * credential (or the local grant script on the Nexus host); the dashboard
 * never holds that key. Client acceptances shown here are client decisions,
 * distinct from technical QA and from Robert's reserved decisions.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { KeyRound, RefreshCw } from "lucide-react";
import { HudPanel } from "@/components/bridge/hud";
import {
  getProjectClientAccess,
  type ClientAccessSummary,
  type ClientArtifactRow,
  type ClientEntitlementRow,
  type ClientReviewRow,
} from "@/lib/nexus/client-access";

const ACCESS_LABEL: Record<string, string> = {
  granted: "access granted",
  superseded: "replaced by a newer grant",
  revoked: "revoked",
  not_linked: "member unlinked, access off",
  member_dormant: "member dormant, access off",
  member_missing: "member deleted, access off",
  identity_changed: "identity edited, re-grant needed",
  project_missing: "project missing",
  not_entitled: "no entitlement",
};

const DECISION_LABEL: Record<ClientReviewRow["decision"], string> = {
  accept: "Accepted",
  request_changes: "Changes requested",
  comment: "Comment",
};

const STATE_CHIP: Record<string, string> = {
  active: "border-emerald-500/30 bg-emerald-500/15 text-emerald-300",
  current: "border-emerald-500/30 bg-emerald-500/15 text-emerald-300",
  revoked: "border-red-500/30 bg-red-500/15 text-red-300",
  withdrawn: "border-red-500/30 bg-red-500/15 text-red-300",
  superseded: "border-slate-500/30 bg-slate-500/15 text-slate-300",
};

const REVIEW_LIMIT = 6;

/** Stable, timezone-free stamp so the panel reads the same in tests and on the tunnel. */
function stamp(iso: string | null | undefined): string {
  if (!iso) return "";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return at.toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

function Chip({ value }: { value: string }) {
  return (
    <span className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${STATE_CHIP[value] ?? STATE_CHIP.superseded}`}>
      {value}
    </span>
  );
}

function EntitlementRow({ row }: { row: ClientEntitlementRow }) {
  const identity = row.member ?? row.member_snapshot;
  return (
    <li className="rounded border border-slate-800 bg-slate-950/40 px-3 py-2 text-xs" data-entitlement={row.id} data-access={row.access}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold text-white">{identity.name || identity.id}</span>
        {identity.email ? <span className="text-slate-500">{identity.email}</span> : null}
        <Chip value={row.state} />
        <span className="text-slate-400">{ACCESS_LABEL[row.access] ?? row.access}</span>
      </div>
      <div className="mt-1 text-[11px] text-slate-500">
        Granted {stamp(row.granted_at)} by {row.granted_by} ({row.authority})
        {row.source ? <> from {row.source}</> : null}
        {row.revoked ? <> · revoked {stamp(row.revoked.at)}{row.revoked.reason ? `: ${row.revoked.reason}` : ""}</> : null}
      </div>
    </li>
  );
}

function ArtifactRow({ artifact }: { artifact: ClientArtifactRow }) {
  return (
    <li className="rounded border border-slate-800 bg-slate-950/40 px-3 py-2 text-xs" data-artifact={artifact.id} data-state={artifact.state}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold text-white">{artifact.title}</span>
        <span className="text-slate-500">{artifact.kind} · {artifact.version}</span>
        <Chip value={artifact.state} />
        <span className={artifact.accepted.length ? "text-emerald-300" : "text-slate-500"}>
          {artifact.accepted.length ? `accepted by ${artifact.accepted.map((r) => r.member.name || r.member.id).join(", ")}` : "not yet accepted"}
        </span>
      </div>
      <div className="mt-1 text-[11px] text-slate-500">
        Published {stamp(artifact.published_at)} by {artifact.published_by}
        {artifact.url ? (
          <>
            {" · "}
            <a href={artifact.url} target="_blank" rel="noreferrer" className="text-cyan-300 hover:underline">{artifact.url}</a>
          </>
        ) : null}
        {" · version "}<code className="text-slate-400">{artifact.version_hash.slice(0, 12)}</code>
      </div>
    </li>
  );
}

function ReviewRow({ review, artifacts }: { review: ClientReviewRow; artifacts: ClientArtifactRow[] }) {
  const artifact = artifacts.find((a) => a.id === review.artifact_id);
  return (
    <li className="rounded border border-slate-800 bg-slate-950/40 px-3 py-2 text-xs" data-review={review.id} data-decision={review.decision}>
      <div className="flex flex-wrap items-center gap-2">
        <span className={review.decision === "accept" ? "font-semibold text-emerald-300" : "font-semibold text-white"}>{DECISION_LABEL[review.decision]}</span>
        <span className="text-slate-400">{review.member.name || review.member.id}</span>
        <span className="text-slate-500">{artifact ? `${artifact.title} (${artifact.version})` : review.artifact_id}</span>
        <span className="text-slate-600">{stamp(review.created_at)}</span>
      </div>
      {review.body ? <p className="mt-1 whitespace-pre-wrap text-slate-300">{review.body}</p> : null}
      {review.decision === "accept" ? <div className="mt-1 text-[11px] text-slate-500">evidence <code className="text-slate-400">{review.evidence_ref}</code></div> : null}
    </li>
  );
}

export function ProjectClientAccess({ projectId }: { projectId: string }) {
  const [summary, setSummary] = useState<ClientAccessSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setSummary(await getProjectClientAccess(projectId));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const entitlements = summary?.entitlements ?? [];
  const artifacts = summary?.artifacts ?? [];
  const reviews = [...(summary?.reviews ?? [])].reverse().slice(0, REVIEW_LIMIT);
  const active = entitlements.filter((e) => e.access === "granted").length;

  return (
    <HudPanel
      icon={<KeyRound size={16} />}
      title="Client Access"
      accent="purple"
      headerRight={
        <button type="button" onClick={() => void load()} disabled={loading} aria-label="Refresh client access"
          className="rounded border border-slate-700 bg-slate-800/60 p-1 text-slate-300 hover:text-white disabled:opacity-50">
          <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
        </button>
      }
    >
      {error ? (
        <p className="text-xs text-amber-300">{error}</p>
      ) : (
        <div className="space-y-3">
          <div className="text-[11px] text-slate-500">
            {active === 1 ? "1 member has" : `${active} members have`} project-scoped client access. Grants need Robert&apos;s operator credential; the decision-maker flag alone grants nothing.
          </div>
          {entitlements.length ? (
            <ul className="space-y-1.5">{entitlements.map((row) => <EntitlementRow key={row.id} row={row} />)}</ul>
          ) : (
            <p className="text-xs text-slate-500">No client entitlements recorded for this project.</p>
          )}
          {artifacts.length ? (
            <div>
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-500">Published versions</div>
              <ul className="space-y-1.5">{artifacts.map((artifact) => <ArtifactRow key={artifact.id} artifact={artifact} />)}</ul>
            </div>
          ) : null}
          {reviews.length ? (
            <div>
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-500">Client decisions and feedback</div>
              <ul className="space-y-1.5">{reviews.map((review) => <ReviewRow key={review.id} review={review} artifacts={artifacts} />)}</ul>
            </div>
          ) : null}
        </div>
      )}
    </HudPanel>
  );
}

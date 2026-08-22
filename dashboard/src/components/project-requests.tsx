/**
 * ProjectRequests — the stakeholder approval queue for one project.
 *
 * When a project has a Primary Decision Maker, requests arriving from the
 * feedback widget are filed as `blocked` tasks carrying a StakeholderGate
 * (metadata.stakeholder_gate) instead of going straight onto the board. This
 * panel is the operator's seat at that gate: approve (→ idea), needs changes
 * (→ deferred — stays blocked with a note), not now (→ cancelled), or
 * duplicate of an existing task (→ cancelled, pointing at the original). PDMs
 * make the same calls from hosted status reports; both paths land on the same
 * gate, so this list is always the truth.
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ChevronDown, ChevronUp, ExternalLink, Inbox, RefreshCw } from "lucide-react";
import { HudPanel } from "@/components/bridge/hud";
import { timeAgo } from "@/components/pulse-visuals";
import {
  OPERATOR_DECIDER,
  decideStakeholderRequest,
  getProjectRequests,
  type ProjectRequest,
  type StakeholderDecision,
  type StakeholderGate,
} from "@/lib/nexus";

type GateStatus = StakeholderGate["status"];
type Decision = StakeholderDecision["decision"];

const GATE_CHIP: Record<GateStatus, string> = {
  pending: "border-amber-500/30 bg-amber-500/15 text-amber-300",
  approved: "border-emerald-500/30 bg-emerald-500/15 text-emerald-300",
  rejected: "border-red-500/30 bg-red-500/15 text-red-300",
  duplicate: "border-slate-500/30 bg-slate-500/15 text-slate-300",
  deferred: "border-purple-500/30 bg-purple-500/15 text-purple-300",
};

const BUTTON_TONES = {
  emerald: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20",
  purple: "border-purple-500/40 bg-purple-500/10 text-purple-300 hover:bg-purple-500/20",
  red: "border-red-500/40 bg-red-500/10 text-red-300 hover:bg-red-500/20",
  slate: "border-slate-700 bg-slate-800/60 text-slate-300 hover:text-white",
} as const;

const DESCRIPTION_LIMIT = 600;

function partyLabel(party?: StakeholderGate["requested_by"]): string | null {
  if (!party) return null;
  return party.name || party.email || null;
}

export function ProjectRequests({
  projectId,
  onChanged,
}: {
  projectId: string;
  /** Fires after a decision lands (the task's board status changed). */
  onChanged?: () => void;
}) {
  const [requests, setRequests] = useState<ProjectRequest[]>([]);
  const [showAll, setShowAll] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const onChangedRef = useRef(onChanged);
  useEffect(() => {
    onChangedRef.current = onChanged;
  }, [onChanged]);

  const reload = useCallback(async () => {
    try {
      setRequests(await getProjectRequests(projectId, showAll ? "all" : "pending"));
      setError(null);
    } catch (err) {
      setRequests([]);
      setError(
        `Requests API unavailable — the Nexus server needs the stakeholder routes (${
          err instanceof Error ? err.message : "request failed"
        }).`,
      );
    } finally {
      setLoading(false);
    }
  }, [projectId, showAll]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const pendingCount = requests.filter((r) => r.gate?.status === "pending").length;

  return (
    <HudPanel
      icon={<Inbox size={16} />}
      title="Requests awaiting decision"
      accent="amber"
      headerRight={
        <>
          <span
            title="Requests with an open gate"
            className={`rounded px-1.5 py-0.5 text-[10px] font-bold tabular-nums ${
              pendingCount > 0 ? "bg-amber-500/20 text-amber-300" : "bg-slate-800 text-slate-500"
            }`}
          >
            {pendingCount}
          </span>
          <button
            onClick={() => setShowAll((v) => !v)}
            className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] font-bold text-amber-300 transition-colors hover:bg-amber-500/20"
          >
            {showAll ? "Pending only" : "Show all"}
          </button>
          <button
            onClick={() => void reload()}
            title="Refresh"
            aria-label="Refresh requests"
            className="rounded border border-slate-800 p-1 text-slate-500 transition-colors hover:text-amber-300"
          >
            <RefreshCw size={12} />
          </button>
        </>
      }
    >
      {error && <p className="mb-2 text-xs text-amber-400">{error}</p>}
      {loading && !error && <p className="text-[11px] text-slate-600">Loading…</p>}

      {!error && !loading && requests.length === 0 && (
        <p className="py-3 text-center text-sm text-slate-500">
          {showAll
            ? "No requests on record for this project yet."
            : "No requests waiting. Feedback from testers lands here when the project has a Primary Decision Maker."}
        </p>
      )}

      {requests.length > 0 && (
        <div className="space-y-2">
          {requests.map((r) => (
            <RequestRow
              key={r.id}
              request={r}
              others={requests.filter((o) => o.id !== r.id)}
              expanded={expandedId === r.id}
              onToggle={() => setExpandedId(expandedId === r.id ? null : r.id)}
              onDecided={() => {
                void reload();
                onChangedRef.current?.();
              }}
            />
          ))}
        </div>
      )}
    </HudPanel>
  );
}

function RequestRow({
  request,
  others,
  expanded,
  onToggle,
  onDecided,
}: {
  request: ProjectRequest;
  /** The other requests in this project — candidates for "duplicate of". */
  others: ProjectRequest[];
  expanded: boolean;
  onToggle: () => void;
  onDecided: () => void;
}) {
  const gate: StakeholderGate = request.gate ?? { status: "pending", requested_at: request.created_at };
  const status: GateStatus = gate.status in GATE_CHIP ? gate.status : "pending";
  const [note, setNote] = useState("");
  const [dupOpen, setDupOpen] = useState(false);
  const [dupTarget, setDupTarget] = useState("");
  const [busy, setBusy] = useState<Decision | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [revisit, setRevisit] = useState(false);

  // pending + deferred are still blocked on the board; final states can be revisited on demand.
  const canDecide = status === "pending" || status === "deferred" || revisit;
  const who = partyLabel(gate.requested_by) ?? (request.source ? `via ${request.source}` : "unknown requester");
  const requestedAt = gate.requested_at || request.created_at;
  const when = timeAgo(requestedAt);
  const description = request.description ?? "";
  const truncated = description.length > DESCRIPTION_LIMIT;

  const decide = async (decision: Decision) => {
    setErr(null);
    const body: StakeholderDecision = { decision, decided_by: OPERATOR_DECIDER };
    const trimmedNote = note.trim();
    if (trimmedNote) body.note = trimmedNote;
    if (decision === "duplicate") {
      const target = dupTarget.trim();
      if (!target) {
        setDupOpen(true);
        setErr("Pick the request this duplicates, or paste the task id.");
        return;
      }
      body.duplicate_of = target;
    }
    setBusy(decision);
    try {
      await decideStakeholderRequest(request.id, body);
      setNote("");
      setDupOpen(false);
      setRevisit(false);
      onDecided();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Decision failed");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/40">
      <button onClick={onToggle} className="flex w-full items-start gap-2.5 px-3 py-2 text-left">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-bold text-slate-100">{request.name}</span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-slate-500">
            <span className="truncate">{who}</span>
            {when && (
              <span title={new Date(requestedAt).toLocaleString()} className="font-mono text-[10px]">
                {when} ago
              </span>
            )}
            {gate.feedback_tag && (
              <span className="rounded bg-slate-800 px-1.5 font-mono text-[10px] text-slate-400">{gate.feedback_tag}</span>
            )}
            <span
              className={`rounded border px-1.5 text-[10px] font-semibold uppercase tracking-wider ${GATE_CHIP[status]}`}
            >
              {status}
            </span>
          </span>
        </span>
        {expanded ? (
          <ChevronUp size={14} className="mt-1 shrink-0 text-slate-500" />
        ) : (
          <ChevronDown size={14} className="mt-1 shrink-0 text-slate-500" />
        )}
      </button>

      {expanded && (
        <div className="space-y-2 border-t border-slate-800 px-3 py-3">
          {description ? (
            <p className="whitespace-pre-wrap text-[12px] leading-relaxed text-slate-300">
              {truncated ? `${description.slice(0, DESCRIPTION_LIMIT)}…` : description}
            </p>
          ) : (
            <p className="text-[12px] italic text-slate-600">No description.</p>
          )}

          {gate.note && (
            <p className="text-[11px] text-slate-400">
              <span className="text-slate-500">Note:</span> {gate.note}
            </p>
          )}

          {status !== "pending" && (gate.decided_by || gate.decided_at) && (
            <p className="text-[11px] text-slate-500">
              Decided
              {gate.decided_by ? ` by ${partyLabel(gate.decided_by) ?? gate.decided_by.via ?? "someone"}` : ""}
              {gate.decided_at ? ` · ${new Date(gate.decided_at).toLocaleString()}` : ""}
              {gate.duplicate_of ? (
                <>
                  {" · duplicate of "}
                  <Link href={`/task/${gate.duplicate_of}`} className="font-mono text-cyan-400 hover:underline">
                    {gate.duplicate_of.slice(0, 8)}
                  </Link>
                </>
              ) : null}
            </p>
          )}

          {canDecide ? (
            <div className="space-y-2 pt-1">
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                className="hud-input min-h-[44px]"
                placeholder="Note to the requester / for the next report (optional)"
              />
              <div className="flex flex-wrap items-center gap-1.5">
                <DecisionButton tone="emerald" label="Approve" busy={busy === "approve"} disabled={busy !== null} onClick={() => decide("approve")} />
                <DecisionButton tone="purple" label="Needs changes" busy={busy === "defer"} disabled={busy !== null} onClick={() => decide("defer")} />
                <DecisionButton tone="red" label="Not now" busy={busy === "reject"} disabled={busy !== null} onClick={() => decide("reject")} />
                <DecisionButton tone="slate" label="Duplicate of…" disabled={busy !== null} onClick={() => setDupOpen((v) => !v)} />
              </div>
              {dupOpen && (
                <div className="space-y-1.5 rounded border border-slate-800 bg-slate-950/50 p-2">
                  {others.length > 0 && (
                    <select
                      className="hud-input"
                      value={others.some((o) => o.id === dupTarget) ? dupTarget : ""}
                      onChange={(e) => setDupTarget(e.target.value)}
                    >
                      <option value="">Pick another request in this project…</option>
                      {others.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.name}
                        </option>
                      ))}
                    </select>
                  )}
                  <input
                    className="hud-input font-mono"
                    value={dupTarget}
                    onChange={(e) => setDupTarget(e.target.value)}
                    placeholder="…or paste the id of the task it duplicates"
                  />
                  <div className="flex justify-end">
                    <DecisionButton
                      tone="slate"
                      label="Mark as duplicate"
                      busy={busy === "duplicate"}
                      disabled={busy !== null || !dupTarget.trim()}
                      onClick={() => decide("duplicate")}
                    />
                  </div>
                </div>
              )}
            </div>
          ) : (
            <button onClick={() => setRevisit(true)} className="text-[11px] text-slate-500 hover:text-amber-300">
              Revisit this decision…
            </button>
          )}

          {err && <p className="text-[11px] text-amber-400">{err}</p>}

          <div className="flex justify-end">
            <Link href={`/task/${request.id}`} className="flex items-center gap-1 text-[11px] text-slate-500 hover:text-cyan-300">
              Open task <ExternalLink size={10} />
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

function DecisionButton({
  tone,
  label,
  busy,
  disabled,
  onClick,
}: {
  tone: keyof typeof BUTTON_TONES;
  label: string;
  busy?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`rounded border px-2 py-0.5 text-[11px] font-bold transition-colors disabled:opacity-50 ${BUTTON_TONES[tone]}`}
    >
      {busy ? "…" : label}
    </button>
  );
}

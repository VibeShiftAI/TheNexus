"use client";

/**
 * Council ballots panel for the dispatch console.
 *
 * Shows every Morning Council session that balloted this task, each seat's
 * recorded decision and the cue it gave for it, and whether the seats
 * disagreed. Matching votes are shown as the absence of dissent, never as an
 * endorsement, and a seat that errored or returned no row is shown as giving
 * no position rather than being folded into the majority. A registered seat
 * whose ballot has not landed yet is shown as pending, so a session still in
 * flight never reads as "all seats".
 */

import { useId, useState } from "react";
import { ChevronDown, ChevronRight, Users } from "lucide-react";
import type {
  CouncilBallotSession,
  CouncilDivergence,
  CouncilSeatPosition,
  TaskCouncilBallots,
} from "@/lib/dispatch-insight";

const DIVERGENCE_STYLES: Record<CouncilDivergence, string> = {
  dissent: "border-amber-500/50 bg-amber-500/10 text-amber-200",
  no_dissent: "border-slate-600 bg-slate-800/60 text-slate-300",
  no_dissent_among_reporting: "border-slate-600 bg-slate-800/60 text-slate-400",
  insufficient: "border-slate-700 bg-slate-900 text-slate-500",
};

/** How the seats that did not vote are missing: ballots not yet landed versus no position. */
function missingText(coverage: CouncilBallotSession["coverage"]): string {
  const pending = coverage.pending ?? 0;
  const silent = coverage.seats - coverage.voted - pending;
  const parts: string[] = [];
  if (pending > 0) parts.push(`${pending} not yet recorded`);
  if (silent > 0) parts.push(`${silent} gave no position`);
  return parts.join(", ");
}

/** The chip text for a session. Deliberately never "consensus" or "agreed". */
export function divergenceLabel(session: CouncilBallotSession): string {
  const { voted, seats } = session.coverage;
  switch (session.divergence) {
    case "dissent":
      return "Seats disagree";
    case "no_dissent":
      return `No dissent recorded (${voted} of ${seats} seats)`;
    case "no_dissent_among_reporting":
      return `No dissent among ${voted} of ${seats} seats; ${missingText(session.coverage)}`;
    case "insufficient":
      return voted === 0 ? "No seat recorded a position" : "Only one seat recorded a position";
  }
}

const DIVERGENCE_TITLES: Record<CouncilDivergence, string> = {
  dissent: "Voting seats recorded different decisions on this task. Each position and the cue behind it is listed below.",
  no_dissent:
    "Every seat recorded the same decision. That is an absence of dissent, not evidence the decision is right: read the cue each seat relied on.",
  no_dissent_among_reporting:
    "The seats that voted recorded the same decision, but at least one seat errored, returned no row for this task, or has not reported yet, so dissent is not ruled out.",
  insufficient: "Fewer than two seats recorded a position, so neither dissent nor its absence can be shown.",
};

function sessionDate(session: CouncilBallotSession): string {
  if (!session.createdAt) return session.sessionId;
  const d = new Date(session.createdAt);
  return Number.isNaN(d.getTime()) ? session.createdAt : d.toLocaleString();
}

const IN_PROGRESS_TITLE =
  "Praxis has not closed this session, so ballots may still land; the counts cover only what is recorded so far.";

const NO_POSITION_LABELS: Record<Exclude<CouncilSeatPosition["state"], "voted">, string> = {
  unavailable: "no position (seat unavailable)",
  no_position: "no position",
  pending: "ballot not yet recorded",
};

function coverageText(session: CouncilBallotSession): string {
  const { seats, voted, unavailable, noPosition } = session.coverage;
  const pending = session.coverage.pending ?? 0;
  const parts = [`${voted} of ${seats} seats voted`];
  if (pending > 0) parts.push(`${pending} not yet recorded`);
  if (unavailable > 0) parts.push(`${unavailable} unavailable`);
  if (noPosition > 0) parts.push(`${noPosition} without a row`);
  return parts.join(" · ");
}

function SeatRow({ seat }: { seat: CouncilSeatPosition }) {
  if (seat.state !== "voted") {
    return (
      <li className="rounded border border-dashed border-slate-700 px-2 py-1.5" data-seat-state={seat.state}>
        <p className="text-[11px]">
          <span className="font-mono text-slate-300">{seat.seat}</span>{" "}
          <span className="text-slate-500">· {NO_POSITION_LABELS[seat.state]}</span>
        </p>
        <p className="break-words text-[11px] text-slate-500">{seat.detail}</p>
      </li>
    );
  }
  const meta = [
    seat.decision === "include" && seat.rank ? `rank ${seat.rank}` : null,
    seat.estimatedMinutes != null ? `~${seat.estimatedMinutes}m` : null,
    seat.complexity != null ? `complexity ${seat.complexity}` : null,
  ].filter(Boolean);
  return (
    <li className="rounded border border-slate-800 px-2 py-1.5" data-seat-state="voted">
      <p className="text-[11px]">
        <span className="font-mono text-slate-300">{seat.seat}</span>{" "}
        <span className={seat.decision === "include" ? "font-semibold text-cyan-300" : "font-semibold text-slate-200"}>
          {seat.decision}
        </span>
        {meta.length > 0 && <span className="text-slate-500"> · {meta.join(" · ")}</span>}
      </p>
      <p className="whitespace-pre-wrap break-words text-xs text-slate-300">
        <span className="text-slate-500">Cue: </span>
        {seat.cue || <span className="text-slate-500">(seat gave no reason)</span>}
      </p>
    </li>
  );
}

function SessionBlock({ session, defaultOpen }: { session: CouncilBallotSession; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();
  const inProgress = Boolean(session.phase) && session.phase !== "complete";
  return (
    <li className="rounded border border-slate-800 bg-slate-950/40" data-divergence={session.divergence}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={bodyId}
        className="flex w-full flex-wrap items-center gap-x-2 gap-y-1 px-2 py-1.5 text-left text-[11px] text-slate-400"
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span className="text-slate-300">{sessionDate(session)}</span>
        <span
          className={`rounded-full border px-2 py-0.5 font-semibold ${DIVERGENCE_STYLES[session.divergence]}`}
          title={DIVERGENCE_TITLES[session.divergence]}
        >
          {divergenceLabel(session)}
        </span>
        {inProgress && (
          <span
            className="rounded-full border border-cyan-500/40 bg-cyan-500/10 px-2 py-0.5 text-cyan-300"
            title={IN_PROGRESS_TITLE}
            data-session-phase={session.phase}
          >
            session in progress ({session.phase})
          </span>
        )}
        {session.positions.map((p) => (
          <span key={p.decision} className="text-slate-500">
            {p.decision} {p.seats.length}
          </span>
        ))}
      </button>
      {open && (
        <div id={bodyId} className="space-y-2 border-t border-slate-800 px-2 py-2">
          <p className="text-[11px] text-slate-500">{coverageText(session)}</p>
          {session.divergence === "dissent" && (
            <ul className="space-y-0.5 text-[11px]">
              {session.positions.map((p) => (
                <li key={p.decision}>
                  <span className="font-semibold text-slate-200">{p.decision}</span>
                  <span className="text-slate-500">: {p.seats.join(", ")}</span>
                </li>
              ))}
            </ul>
          )}
          <ul className="space-y-1.5">
            {session.seats.map((seat, i) => (
              <SeatRow key={`${seat.seat}-${i}`} seat={seat} />
            ))}
          </ul>
          <p className="break-all text-[10px] text-slate-600">
            Source: {session.source.store}/{session.source.file} · {session.source.field}
            {session.source.roster && ` · roster ${session.source.roster}`}
            {session.morningRunId && ` · ${session.morningRunId}`}
          </p>
        </div>
      )}
    </li>
  );
}

/** The console's council section. Renders nothing when the API omits it. */
export function CouncilBallots({ council }: { council: TaskCouncilBallots | undefined }) {
  // Opens by itself when any session recorded dissent, so disagreement is
  // seen without a click; agreement-only history stays folded.
  const [open, setOpen] = useState(() => (council?.totals?.dissent ?? 0) > 0);
  const listId = useId();
  if (!council) return null;

  if (!council.available) {
    return (
      <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-200" data-council="unavailable">
        <Users size={12} className="mr-1.5 inline" />
        Council ballots unavailable. {council.reason}
      </div>
    );
  }

  if (council.totalSessions === 0) {
    return (
      <div className="rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2 text-[11px] text-slate-500" data-council="none">
        <Users size={12} className="mr-1.5 inline" />
        No Morning Council ballot has a row for this task ({council.sessionsScanned} session files scanned). No
        dissent to show because no seat has recorded a position, not because seats agreed.
        {council.reason && <span className="text-amber-300"> {council.reason}</span>}
      </div>
    );
  }

  const totals = council.totals;
  const shown = council.sessions.length;
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950/60 text-[11px] text-slate-400" data-council="present">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={listId}
        className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-left"
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span className="inline-flex items-center gap-1.5 text-slate-300">
          <Users size={12} className="text-slate-500" />
          Council ballots
        </span>
        <span>
          {council.totalSessions} session{council.totalSessions === 1 ? "" : "s"}
        </span>
        {totals && (
          <>
            <span className={totals.dissent > 0 ? "font-semibold text-amber-300" : ""}>{totals.dissent} with dissent</span>
            <span title={DIVERGENCE_TITLES.no_dissent}>{totals.no_dissent} no dissent (all seats)</span>
            <span title={DIVERGENCE_TITLES.no_dissent_among_reporting}>
              {totals.no_dissent_among_reporting} no dissent among reporting seats
            </span>
            <span title={DIVERGENCE_TITLES.insufficient}>{totals.insufficient} too few positions</span>
          </>
        )}
      </button>
      {council.reason && <p className="px-3 pb-1 text-amber-300">{council.reason}</p>}
      {open && (
        <div id={listId} className="space-y-2 border-t border-slate-800 px-3 py-2">
          <ul className="space-y-1.5">
            {council.sessions.map((s, i) => (
              <SessionBlock key={s.sessionId} session={s} defaultOpen={i === 0} />
            ))}
          </ul>
          {council.totalSessions > shown && (
            <p className="text-slate-500">
              Showing the newest {shown} of {council.totalSessions} sessions; the counts above cover all of them.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

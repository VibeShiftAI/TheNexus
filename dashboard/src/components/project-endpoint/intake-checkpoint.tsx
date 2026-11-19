"use client";
/**
 * Intake shown as the project's first checkpoint, ahead of the checkpoints of
 * its own plan. The stages and their statuses come from Praxis as read from
 * the saved intake (see @/lib/intake-checkpoint); this component only lays
 * them out. Nothing here edits the intake or completes a checkpoint.
 */
import type { IntakeCheckpointState } from "@/lib/intake-checkpoint";
import { Status } from "./fields";

export function IntakeCheckpointCard({ intake }: { intake: IntakeCheckpointState }) {
  if (intake.state === "none") return null;
  if (intake.state === "loading") {
    return <p className="text-xs text-slate-500" data-intake-checkpoint="loading">Reading the Intake checkpoint from Praxis.</p>;
  }
  if (intake.state === "unavailable") {
    return (
      <p className="text-xs text-amber-300" data-intake-checkpoint="unavailable">
        Intake checkpoint not read: {intake.reason}. This project came through intake, so its current
        checkpoint may be Intake.
      </p>
    );
  }
  const { checkpoint } = intake;
  const current = checkpoint.status === "current";
  return (
    <div
      data-intake-checkpoint={checkpoint.status}
      className={current
        ? "rounded-lg border border-cyan-700/60 bg-cyan-950/20 p-4"
        : "rounded-lg border border-emerald-800/60 bg-emerald-950/20 p-4"}
    >
      <div className={`flex flex-wrap items-center gap-2 text-[10px] font-bold uppercase tracking-widest ${current ? "text-cyan-300" : "text-emerald-300"}`}>
        <span>{current ? "Working toward now" : "Complete"}</span>
        <span className={`font-mono ${current ? "text-cyan-500/80" : "text-emerald-500/80"}`}>
          first checkpoint · {checkpoint.stages_settled} of {checkpoint.stages.length} stages settled
        </span>
      </div>
      <h3 className="mt-1 break-words text-base font-semibold text-white">{checkpoint.title}</h3>
      {checkpoint.goal && (
        <p className="mt-1 whitespace-pre-wrap break-words text-sm text-slate-300">{checkpoint.goal}</p>
      )}
      {checkpoint.target && (
        <p className="mt-1 text-xs text-slate-400">Target: {checkpoint.target}</p>
      )}
      <ol className="mt-3 space-y-1.5 text-xs">
        {checkpoint.stages.map((stage, index) => (
          <li key={stage.id} data-intake-stage={stage.id} className="flex flex-wrap items-baseline gap-2">
            <span className="font-mono text-slate-600">{index + 1}.</span>
            <span className="min-w-0 break-words text-slate-200">{stage.name}</span>
            <Status value={stage.status} />
            {stage.detail && <span className="min-w-0 break-words text-slate-500">{stage.detail}</span>}
          </li>
        ))}
      </ol>
      <p className="mt-3 text-[11px] text-slate-500">
        Read from the saved intake. Intake advances as the intake advances; its stages are not tasks.
      </p>
    </div>
  );
}

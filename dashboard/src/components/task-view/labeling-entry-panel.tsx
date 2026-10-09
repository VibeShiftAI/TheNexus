"use client";

/**
 * LabelingEntryPanel: the entry card for a task that carries the Groundrules
 * blind-labelling packet. It sits above the long source inventory with one
 * working action (Start or Continue labeling), a short note on what the task
 * asks for, and the saved progress per stage read from the server. Tasks the
 * API does not link to the packet render nothing.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { Check, ClipboardList, Lock } from "lucide-react";
import { STAGES, labelingApi, shortSha, stageTitle, type EntryInfo } from "@/lib/groundrules-labeling";

export function LabelingEntryPanel({ taskId, onLinked }: { taskId: string; onLinked?: (linked: boolean) => void }) {
  const [info, setInfo] = useState<EntryInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    labelingApi.entry(taskId)
      .then(data => { if (!cancelled) { setInfo(data); onLinked?.(Boolean(data.linked)); } })
      .catch(() => { if (!cancelled) { setInfo({ linked: false, task_id: taskId }); onLinked?.(false); } });
    return () => { cancelled = true; };
  }, [taskId, onLinked]);

  if (!info?.linked) return null;
  const session = info.session;
  const packet = info.packet;
  const route = info.route ?? `/task/${taskId}/labeling`;
  const committed = session ? STAGES.filter(s => session.stages[s].committed_at).length : 0;
  const action = !session ? "Start labeling" : committed === 3 ? "Open the labeling record" : "Continue labeling";

  return (
    <section className="rounded-lg border border-cyan-500/50 bg-cyan-500/5 p-4" data-labeling-entry aria-label="Blind labeling">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0 flex-1">
          <h3 className="flex items-center gap-2 text-base font-semibold text-white">
            <ClipboardList size={18} className="text-cyan-300" /> Your input goes here
          </h3>
          <p className="mt-1 text-sm text-slate-300">
            This task asks for your own reading of {packet ? `${packet.counts.rows} passages` : "each passage"}: the kind of rule, the words naming the actor, and any exact spans that condition, except or negate it.
            The scorer compares extractor output against these labels, so they have to be yours and made before any extractor output is shown.
            The guided form below takes one passage at a time and saves every answer on the server.
          </p>
          {packet && (
            <p className="mt-2 text-xs text-slate-500">
              Packet {shortSha(packet.sha256)} · roster {shortSha(packet.digests.rosterSha256)} · {packet.counts.rows} passages, {packet.counts.controls} control judgments, {packet.counts.pairs} pairs.
            </p>
          )}
          {info.packet_error && <p className="mt-2 text-sm text-rose-300">The packet could not be read: {info.packet_error.message}</p>}
          {session?.packet_conflict && <p className="mt-2 text-sm text-amber-200">The packet changed since your session started; open the form to resolve it.</p>}
        </div>
        <Link href={route} className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg border border-cyan-400/60 bg-cyan-500/20 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-cyan-500/30" data-labeling-action>
          {action}
        </Link>
      </div>
      {session?.blind === false && <p className="mt-2 text-sm text-amber-200" data-not-blind>This session was rebound after Part B or C had been shown, so its Stage A record is not blind.</p>}
      {session?.progress && (
        <ul className="mt-3 grid gap-2 text-xs sm:grid-cols-3" data-labeling-progress>
          {STAGES.map(s => {
            const p = session.progress![s];
            return (
              <li key={s} className="rounded-md border border-slate-800 bg-slate-950/60 px-3 py-2 text-slate-300">
                <span className="flex items-center gap-1 font-semibold text-slate-100">
                  {p.committed_at ? <Check size={12} className="text-emerald-300" /> : p.unlocked ? null : <Lock size={12} className="text-slate-500" />}
                  {stageTitle[s]}
                </span>
                <span className="block" data-stage-progress={s}>
                  {p.committed_at
                    ? `committed ${new Date(p.committed_at).toLocaleString()}`
                    : p.unlocked
                      ? `${p.complete} of ${p.total} complete, ${p.draft} draft, ${p.unsure} unsure`
                      : "locked until the previous stage is committed"}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {session && (
        <p className="mt-2 text-[11px] text-slate-500">
          Session started {new Date(session.created_at).toLocaleString()} · last saved {new Date(session.updated_at).toLocaleString()} · progress is kept on the server and resumes on any device.
        </p>
      )}
    </section>
  );
}

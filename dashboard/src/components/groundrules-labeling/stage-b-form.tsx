"use client";

/**
 * Stage B: one control fixture. The passage, Robert's own committed blind
 * reading of it (frozen), the proposal(s) under judgment, and the verdict the
 * fixture asks for: accept / reject for a single proposal, equivalent /
 * different for a pair. No expected answer or scoring hint is shown.
 */
import { useMemo } from "react";
import { UNKNOWN, resolveQuote, type ControlItem, type FieldError, type PacketRow, type ProposedProposition, type StageAAnswer, type StageBAnswer } from "@/lib/groundrules-labeling";
import { Passage, type Mark } from "./passage";
import { FieldErrorText } from "./stage-a-form";

const errorFor = (errors: FieldError[], path: string) => errors.find(e => e.path === path) ?? null;

function Proposal({ p, title }: { p: ProposedProposition; title: string }) {
  return (
    <div className="rounded-md border border-violet-500/30 bg-violet-500/5 p-3 text-sm" data-proposal>
      <p className="text-xs font-semibold uppercase tracking-wide text-violet-200">{title}</p>
      <p className="mt-1"><span className="text-slate-400">kind:</span> <span className="font-semibold text-slate-100">{p.category}</span></p>
      <p className="mt-1 font-serif text-[15px] text-slate-100">&ldquo;{p.quote}&rdquo;</p>
      {p.numeric && <p className="mt-1 text-xs text-slate-300">numeric: value {String(p.numeric.value)}, unit {p.numeric.unit}, operator {p.numeric.operator}</p>}
      {p.within && <p className="mt-1 text-xs text-slate-500">within: &ldquo;{p.within}&rdquo;</p>}
    </div>
  );
}

export function CommittedReading({ answer }: { answer: StageAAnswer | null }) {
  if (!answer) return <p className="text-xs italic text-slate-500">No committed reading on file for this passage.</p>;
  return (
    <div className="rounded-md border border-cyan-500/30 bg-cyan-500/5 p-3 text-sm" data-committed-reading>
      <p className="text-xs font-semibold uppercase tracking-wide text-cyan-200">Your blind reading (committed, frozen)</p>
      <p className="mt-1"><span className="text-slate-400">modality:</span> <span className="font-semibold text-slate-100">{answer.modality}</span> · <span className="text-slate-400">actor:</span> <span className="font-serif text-slate-100">&ldquo;{answer.actor.quote}&rdquo;</span></p>
      {answer.propositions.length ? (
        <ul className="mt-1 list-disc space-y-0.5 pl-5 text-slate-200">
          {answer.propositions.map((p, i) => <li key={i}><span className="text-slate-400">{p.category}:</span> <span className="font-serif">&ldquo;{p.quote}&rdquo;</span>{p.numeric ? ` (${String(p.numeric.value)} ${p.numeric.unit} ${p.numeric.operator})` : ""}</li>)}
        </ul>
      ) : <p className="mt-1 text-slate-300">You declared: no conditions, exceptions or negations.</p>}
      {answer.notes && <p className="mt-1 text-xs text-slate-400">note: {answer.notes}</p>}
    </div>
  );
}

export function StageBForm({ item, row, committed, value, onChange, errors, readOnly, unsure, onUnsureChange, idPrefix = "b" }: {
  item: ControlItem; row: PacketRow | null; committed: StageAAnswer | null; value: StageBAnswer; onChange: (next: StageBAnswer) => void;
  errors: FieldError[]; readOnly: boolean; unsure: boolean; onUnsureChange: (v: boolean) => void; idPrefix?: string;
}) {
  const proposals = Array.isArray(item.proposed) ? item.proposed : [item.proposed];
  const marks = useMemo<Mark[]>(() => {
    if (!row) return [];
    return proposals.flatMap((p, i) => {
      const res = resolveQuote(row.text, p.quote, p.within ?? null);
      return res.ok ? [{ start: res.start!, end: res.end!, kind: "proposed" as const, label: proposals.length > 1 ? `proposal ${i + 1}` : "proposal" }] : [];
    });
  }, [row, proposals]);
  const options = item.form === "pair" ? ["equivalent", "different"] : ["accept", "reject"];
  const prompts: Record<string, string> = {
    accept: "Accept: this proposal is a correct label for the passage.",
    reject: "Reject: this proposal is not a correct label for the passage.",
    equivalent: "Equivalent: the two proposals say the same thing about the passage.",
    different: "Different: the two proposals do not say the same thing.",
  };
  const id = (s: string) => `${idPrefix}-${s}`;
  return (
    <div className="space-y-4" data-stage-b-form={item.id}>
      <div>
        <p className="text-xs text-slate-400">{row?.citation ?? item.rowId} · fixture {item.id} · {item.form === "pair" ? "pair of proposals" : "single proposal"}</p>
        <h3 className="mt-1 font-semibold text-slate-100">{row?.label ?? item.rowId}</h3>
      </div>
      {row ? (
        <div className="space-y-2">
          {row.contexts.map((c, i) => <Passage key={i} title={`Context ${i + 1}`} text={c.quote} marks={[]} source={{ kind: "context", index: i }} target={null} dense />)}
          <Passage title="Passage" text={row.text} marks={marks} source={{ kind: "row", index: null }} target={null} />
        </div>
      ) : <p className="text-sm text-rose-300">The packet row for this fixture is missing.</p>}
      <CommittedReading answer={committed} />
      <div className={`grid gap-2 ${proposals.length > 1 ? "md:grid-cols-2" : ""}`}>
        {proposals.map((p, i) => <Proposal key={i} p={p} title={proposals.length > 1 ? `Proposal ${i + 1}` : "Proposal"} />)}
      </div>
      <p className="text-sm text-slate-300"><span className="font-semibold text-slate-100">The question:</span> {item.ask}</p>
      <fieldset>
        <legend className="text-sm font-medium text-slate-200">Your verdict</legend>
        <div className="mt-2 grid gap-2 sm:grid-cols-2" role="radiogroup">
          {[...options, UNKNOWN].map(option => (
            <label key={option} className={`flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 text-sm ${value.verdict === option ? "border-cyan-500/60 bg-cyan-500/10 text-slate-100" : "border-slate-800 bg-slate-950/40 text-slate-300 hover:border-slate-600"} ${option === UNKNOWN ? "sm:col-span-2" : ""}`}>
              <input type="radio" name={id("verdict")} value={option} checked={value.verdict === option} disabled={readOnly} onChange={() => onChange({ ...value, verdict: option })} className="mt-1 accent-cyan-400" />
              <span>{option === UNKNOWN ? <><span className="font-semibold text-amber-200">UNKNOWN</span><span className="block text-xs text-slate-400">I cannot settle it; the scorer counts it as unanswered.</span></> : <><span className="font-semibold capitalize text-cyan-200">{option}</span><span className="block text-xs text-slate-400">{prompts[option]}</span></>}</span>
            </label>
          ))}
        </div>
        <FieldErrorText error={errorFor(errors, "verdict")} />
      </fieldset>
      <label className="block text-sm font-medium text-slate-200" htmlFor={id("note")}>Note (optional)
        <textarea id={id("note")} value={value.note} disabled={readOnly} onChange={e => onChange({ ...value, note: e.target.value })} rows={2} className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100" />
      </label>
      {!readOnly && (
        <label className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-amber-100" data-unsure>
          <input type="checkbox" checked={unsure} onChange={e => onUnsureChange(e.target.checked)} className="mt-1 accent-amber-400" />
          <span><span className="font-semibold">Unsure, return later.</span> Kept as a draft and listed in the commit review.</span>
        </label>
      )}
    </div>
  );
}

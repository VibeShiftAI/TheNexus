"use client";

/**
 * Stage C: one original/mutant pair. The source text with the removed words
 * marked, the two structured versions side by side, the worked example, and
 * the three answers the packet asks for: does the example come out the same
 * (yes/no), do the two versions mean the same (same/different), and, when
 * different, a case where they part. No key or expected answer is shown.
 */
import { useMemo } from "react";
import { UNKNOWN, resolveQuote, type FieldError, type PairItem, type StageCAnswer } from "@/lib/groundrules-labeling";
import { Passage, type Mark } from "./passage";
import { FieldErrorText } from "./stage-a-form";

const errorFor = (errors: FieldError[], path: string) => errors.find(e => e.path === path) ?? null;

export function StageCForm({ item, value, onChange, errors, readOnly, unsure, onUnsureChange, idPrefix = "c" }: {
  item: PairItem; value: StageCAnswer; onChange: (next: StageCAnswer) => void; errors: FieldError[]; readOnly: boolean; unsure: boolean; onUnsureChange: (v: boolean) => void; idPrefix?: string;
}) {
  const marks = useMemo<Mark[]>(() => {
    const res = resolveQuote(item.sourceText, item.removedText);
    return res.ok ? [{ start: res.start!, end: res.end!, kind: "removed", label: "removed in the mutant" }] : [];
  }, [item]);
  const id = (s: string) => `${idPrefix}-${s}`;
  const radio = (name: keyof StageCAnswer, options: [string, string][]) => (
    <div className="mt-2 grid gap-2 sm:grid-cols-3" role="radiogroup">
      {[...options, [UNKNOWN, "I cannot settle it; counts as unanswered."] as [string, string]].map(([option, hint]) => (
        <label key={option} className={`flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 text-sm ${value[name] === option ? "border-cyan-500/60 bg-cyan-500/10 text-slate-100" : "border-slate-800 bg-slate-950/40 text-slate-300 hover:border-slate-600"}`}>
          <input type="radio" name={id(name)} value={option} checked={value[name] === option} disabled={readOnly} onChange={() => onChange({ ...value, [name]: option })} className="mt-1 accent-cyan-400" />
          <span><span className={`font-semibold capitalize ${option === UNKNOWN ? "text-amber-200" : "text-cyan-200"}`}>{option}</span><span className="block text-xs text-slate-400">{hint}</span></span>
        </label>
      ))}
    </div>
  );
  return (
    <div className="space-y-4" data-stage-c-form={item.id}>
      <div>
        <p className="text-xs text-slate-400">{item.citation} · pair {item.id} · {item.label}</p>
        <h3 className="mt-1 font-semibold text-slate-100">Original versus mutant</h3>
      </div>
      <Passage title="Source text (removed words marked)" text={item.sourceText} marks={marks} source={{ kind: "row", index: null }} target={null} />
      {item.alsoReworded.length > 0 && <p className="text-xs text-slate-400">Also reworded in the mutant: {item.alsoReworded.map(s => `“${s}”`).join(", ")}</p>}
      <div className="grid gap-2 md:grid-cols-2">
        {(["original", "mutant"] as const).map(side => (
          <div key={side} className={`rounded-md border p-3 text-sm ${side === "original" ? "border-slate-700 bg-slate-900/50" : "border-rose-500/30 bg-rose-500/5"}`} data-version={side}>
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-300">{side}</p>
            <ul className="mt-1 space-y-1 text-slate-100">{item.versions[side].map((line, i) => <li key={i} className="font-serif text-[15px]">{line}</li>)}</ul>
          </div>
        ))}
      </div>
      <div className="rounded-md border border-slate-800 bg-slate-950/60 p-3 text-sm" data-example>
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-300">Worked example</p>
        <p className="mt-1 text-slate-100">{item.example.description}</p>
        <p className="mt-1 text-slate-300">Under the original: <span className="font-semibold text-slate-100">{item.example.original}</span>. Under the mutant: <span className="font-semibold text-slate-100">{item.example.mutant}</span>.</p>
      </div>
      <p className="text-sm text-slate-300"><span className="font-semibold text-slate-100">The question:</span> {item.ask}</p>
      <fieldset>
        <legend className="text-sm font-medium text-slate-200">1. Does the worked example really come out the same under both versions?</legend>
        {radio("exampleOutcomeSame", [["yes", "The example's outcome is the same under both."], ["no", "The example's outcome differs."]])}
        <FieldErrorText error={errorFor(errors, "exampleOutcomeSame")} />
      </fieldset>
      <fieldset>
        <legend className="text-sm font-medium text-slate-200">2. Do the two versions mean the same thing?</legend>
        {radio("meaning", [["same", "Same meaning in every case, not only this example."], ["different", "There is at least one case where they part."]])}
        <FieldErrorText error={errorFor(errors, "meaning")} />
      </fieldset>
      <label className="block text-sm font-medium text-slate-200" htmlFor={id("diverging")}>3. A case where they part {value.meaning === "different" ? <span className="text-rose-300">(required when different)</span> : <span className="text-slate-500">(only when different)</span>}
        <textarea id={id("diverging")} value={value.divergingCase} disabled={readOnly} onChange={e => onChange({ ...value, divergingCase: e.target.value })} rows={3} aria-invalid={Boolean(errorFor(errors, "divergingCase"))} className={`mt-1 w-full rounded-md border bg-slate-950 px-3 py-2 text-sm text-slate-100 ${errorFor(errors, "divergingCase") ? "border-rose-500/60" : "border-slate-700"}`} placeholder="Describe facts under which the original and the mutant give different results" />
      </label>
      <FieldErrorText error={errorFor(errors, "divergingCase")} />
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

"use client";

/**
 * Stage A: one passage, one independent reading. Modality, the actor's exact
 * words, zero or more exact-span propositions (condition / exception /
 * negation, with a number for conditions that carry one), free notes, and
 * the two honest escapes: UNKNOWN on a field you read but cannot settle, and
 * "unsure, return later" on the whole passage. The passage never carries a
 * suggested label; highlights are only what Robert has typed.
 */
import { useMemo, useState } from "react";
import { BookOpen, Plus, Trash2 } from "lucide-react";
import {
  CATEGORIES, CATEGORY_DEFINITIONS, FIELD_DEFINITIONS, MODALITIES, MODALITY_DEFINITIONS, UNKNOWN,
  describeQuoteFailure, newProposition, resolveQuote, sourceText,
  type FieldError, type PacketProvision, type PacketRow, type Proposition, type StageAAnswer,
} from "@/lib/groundrules-labeling";
import { Passage, type Mark, type PassageSource, type QuoteTarget } from "./passage";

const errorFor = (errors: FieldError[], path: string) => errors.find(e => e.path === path) ?? null;
const sourceOf = (source: string | number | null | undefined): PassageSource =>
  source === undefined || source === null || source === "" || source === "row" ? { kind: "row", index: null } : { kind: "context", index: typeof source === "number" ? source : Number.parseInt(String(source).replace(/^context:/, ""), 10) };
const sourceValue = (s: PassageSource) => (s.kind === "row" ? "row" : String(s.index));

export function FieldErrorText({ error, id }: { error: FieldError | null; id?: string }) {
  if (!error) return null;
  return <p id={id} role="alert" className={`mt-1 text-xs ${error.unknown ? "text-amber-300" : "text-rose-300"}`} data-field-error>{error.message}</p>;
}

export function Definitions() {
  return (
    <details className="rounded-lg border border-slate-800 bg-slate-900/40 text-sm" data-definitions>
      <summary className="cursor-pointer px-4 py-2 font-semibold text-slate-200"><BookOpen size={14} className="mr-1 inline text-cyan-400" /> What the fields mean (examples come from an invented library act, not from the packet)</summary>
      <div className="grid gap-3 border-t border-slate-800 px-4 py-3 md:grid-cols-2">
        {[...MODALITIES.map(m => MODALITY_DEFINITIONS[m]), ...CATEGORIES.map(c => CATEGORY_DEFINITIONS[c]), ...FIELD_DEFINITIONS].map(def => (
          <div key={def.term} className="rounded-md border border-slate-800 bg-slate-950/60 p-3">
            <p className="font-semibold text-cyan-200">{def.term}</p>
            <p className="mt-1 text-slate-300">{def.meaning}</p>
            <p className="mt-1 text-xs italic text-slate-400">Example: {def.example}</p>
          </div>
        ))}
      </div>
    </details>
  );
}

function SourceSelect({ row, value, onChange, id, disabled }: { row: PacketRow; value: string | number; onChange: (v: string | number) => void; id: string; disabled?: boolean }) {
  if (!row.contexts.length) return null;
  return (
    <label className="block text-xs text-slate-400" htmlFor={id}>
      Taken from
      <select id={id} value={sourceValue(sourceOf(value))} disabled={disabled} onChange={e => onChange(e.target.value === "row" ? "row" : Number.parseInt(e.target.value, 10))} className="mt-1 block w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100">
        <option value="row">The passage itself</option>
        {row.contexts.map((c, i) => <option key={i} value={i} disabled={!c.quotable}>Context {i + 1}{c.quotable ? "" : " (not quotable)"}</option>)}
      </select>
    </label>
  );
}

function QuoteField({ id, label, value, onChange, onPick, error, disabled, help }: { id: string; label: string; value: string; onChange: (v: string) => void; onPick: () => void; error: FieldError | null; disabled?: boolean; help?: string }) {
  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-2">
        <label htmlFor={id} className="text-sm font-medium text-slate-200">{label}</label>
        {!disabled && <button type="button" onClick={onPick} className="rounded-md border border-cyan-500/40 px-2 py-1 text-xs text-cyan-200 hover:bg-cyan-500/10" data-pick-for={id}>Quote from passage</button>}
      </div>
      <textarea id={id} value={value} disabled={disabled} onChange={e => onChange(e.target.value)} rows={2} aria-invalid={Boolean(error)} aria-describedby={error ? `${id}-error` : undefined}
        className={`mt-1 w-full rounded-md border bg-slate-950 px-3 py-2 font-serif text-[15px] text-slate-100 disabled:opacity-70 ${error ? "border-rose-500/60" : "border-slate-700 focus:border-cyan-500/60"}`} placeholder="Exact words from the passage" />
      {help && !error && <p className="mt-1 text-xs text-slate-500">{help}</p>}
      <FieldErrorText error={error} id={`${id}-error`} />
    </div>
  );
}

function WithinField({ id, value, onChange, disabled, row, error }: { id: string; value: string; onChange: (v: string) => void; disabled?: boolean; row: PacketRow; error: FieldError | null }) {
  if (row.anchorWithin) {
    return <p className="mt-1 text-xs text-slate-500">This passage repeats inside its section, so quotes here must also be unique in the section span the scorer uses; a narrower &quot;within&quot; is not available.</p>;
  }
  return (
    <details className="mt-1 text-xs text-slate-400" open={Boolean(value) || Boolean(error)}>
      <summary className="cursor-pointer">Pin a repeated quote (&quot;within&quot;)</summary>
      <label htmlFor={id} className="mt-1 block">Only needed when the words occur more than once: name a longer span, unique in the passage, that contains this one occurrence.
        <input id={id} value={value} disabled={disabled} onChange={e => onChange(e.target.value)} className="mt-1 block w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 font-serif text-sm text-slate-100" />
      </label>
      <FieldErrorText error={error} id={`${id}-error`} />
    </details>
  );
}

export function StageAForm({ row, provision, value, onChange, errors, readOnly, unsure, onUnsureChange, idPrefix = "a" }: {
  row: PacketRow; provision: PacketProvision; value: StageAAnswer; onChange: (next: StageAAnswer) => void; errors: FieldError[];
  readOnly: boolean; unsure: boolean; onUnsureChange: (v: boolean) => void; idPrefix?: string;
}) {
  const [target, setTarget] = useState<QuoteTarget | null>(null);
  const id = (s: string) => `${idPrefix}-${s}`;

  // Highlights are what Robert typed, resolved locally with the anchor rule.
  const marksBySource = useMemo(() => {
    const out = new Map<string, Mark[]>();
    const add = (src: PassageSource, mark: Mark) => { const k = sourceValue(src); out.set(k, [...(out.get(k) ?? []), mark]); };
    const actorSrc = sourceOf(value.actor.source);
    const actorText = sourceText(row, value.actor.source).text;
    const actor = resolveQuote(actorText, value.actor.quote, value.actor.within || null);
    if (actor.ok) add(actorSrc, { start: actor.start!, end: actor.end!, kind: "actor", label: "actor" });
    value.propositions.forEach((p, i) => {
      const src = sourceOf(p.source);
      const res = resolveQuote(sourceText(row, p.source).text, p.quote, p.within || null);
      const kind = (CATEGORIES as readonly string[]).includes(p.category) ? (p.category as Mark["kind"]) : "proposed";
      if (res.ok) add(src, { start: res.start!, end: res.end!, kind, label: `${i + 1}. ${p.category || "proposition"}` });
    });
    return out;
  }, [row, value]);

  const localQuoteError = (quote: string, source: string | number, within: string, path: string): FieldError | null => {
    const server = errorFor(errors, `${path}.quote`);
    if (server) return server;
    if (!quote.trim()) return null;
    const res = resolveQuote(sourceText(row, source).text, quote, within || null);
    return res.ok ? null : { path: `${path}.quote`, message: describeQuoteFailure(res), reason: res.reason, count: res.count };
  };

  const applyQuote = (quote: string, source: PassageSource) => {
    if (!target) return;
    const src = source.kind === "row" ? "row" : source.index!;
    if (target.field === "actor") onChange({ ...value, actor: { ...value.actor, quote, source: src } });
    else {
      const i = Number.parseInt(target.field.replace("prop-", ""), 10);
      onChange({ ...value, propositions: value.propositions.map((p, j) => (j === i ? { ...p, quote, source: src } : p)) });
    }
    setTarget(null);
  };

  const arm = (field: string, label: string, source: string | number) => setTarget({ field, label, source: sourceOf(source) });
  const setProp = (i: number, patch: Partial<Proposition>) => onChange({ ...value, propositions: value.propositions.map((p, j) => (j === i ? { ...p, ...patch } : p)) });
  const removeProp = (i: number) => onChange({ ...value, propositions: value.propositions.filter((_, j) => j !== i) });
  const addProp = () => onChange({ ...value, propositionsDeclared: "some", propositions: [...value.propositions, newProposition(value.propositions.length)] });

  const radio = (name: string, current: string, option: string, label: React.ReactNode, onPick: (v: string) => void, extraClass = "") => (
    <label key={option} className={`flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 text-sm ${current === option ? "border-cyan-500/60 bg-cyan-500/10 text-slate-100" : "border-slate-800 bg-slate-950/40 text-slate-300 hover:border-slate-600"} ${readOnly ? "cursor-default opacity-80" : ""} ${extraClass}`}>
      <input type="radio" name={id(name)} value={option} checked={current === option} disabled={readOnly} onChange={() => onPick(option)} className="mt-1 accent-cyan-400" />
      <span className="min-w-0">{label}</span>
    </label>
  );

  const declaredError = errorFor(errors, "propositionsDeclared") ?? errorFor(errors, "propositions");

  return (
    <div className="space-y-5" data-stage-a-form={row.id}>
      <div>
        <p className="text-xs text-slate-400">{provision.citation} · {provision.topic} · {provision.jurisdiction}</p>
        <h3 className="mt-1 font-semibold text-slate-100">{row.label}</h3>
      </div>
      <div className="space-y-3">
        {row.contexts.map((c, i) => (
          <Passage key={i} title={`Context ${i + 1}${c.quotable ? "" : " (read only)"}`} text={c.quote} marks={marksBySource.get(String(i)) ?? []} source={{ kind: "context", index: i }} target={c.quotable ? target : null} onQuote={applyQuote} onCancelTarget={() => setTarget(null)} dense />
        ))}
        <Passage title="Passage" text={row.text} marks={marksBySource.get("row") ?? []} source={{ kind: "row", index: null }} target={target} onQuote={applyQuote} onCancelTarget={() => setTarget(null)} />
      </div>

      <Definitions />

      <fieldset>
        <legend className="text-sm font-medium text-slate-200">1. Modality: what kind of rule is this?</legend>
        <div className="mt-2 grid gap-2 sm:grid-cols-2" role="radiogroup" aria-describedby={errorFor(errors, "modality") ? id("modality-error") : undefined}>
          {MODALITIES.map(m => radio("modality", value.modality, m, <><span className="font-semibold text-cyan-200">{m}</span><span className="block text-xs text-slate-400">{MODALITY_DEFINITIONS[m].meaning}</span></>, v => onChange({ ...value, modality: v })))}
          {radio("modality", value.modality, UNKNOWN, <><span className="font-semibold text-amber-200">UNKNOWN</span><span className="block text-xs text-slate-400">I read it and cannot settle it. Keeps the stage from committing until resolved.</span></>, v => onChange({ ...value, modality: v }), "sm:col-span-2")}
        </div>
        <FieldErrorText error={errorFor(errors, "modality")} id={id("modality-error")} />
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-slate-200">2. Actor: who does the rule address?</legend>
        <QuoteField id={id("actor-quote")} label="Exact words naming the actor" value={value.actor.quote} disabled={readOnly} onChange={v => onChange({ ...value, actor: { ...value.actor, quote: v } })} onPick={() => arm("actor", "Actor", value.actor.source)} error={localQuoteError(value.actor.quote, value.actor.source, value.actor.within, "actor")} help="Copy the words as written. Select them in the passage above or use Pick words." />
        <SourceSelect id={id("actor-source")} row={row} value={value.actor.source} disabled={readOnly} onChange={v => onChange({ ...value, actor: { ...value.actor, source: v } })} />
        <FieldErrorText error={errorFor(errors, "actor.source")} />
        <WithinField id={id("actor-within")} row={row} value={value.actor.within} disabled={readOnly} onChange={v => onChange({ ...value, actor: { ...value.actor, within: v } })} error={errorFor(errors, "actor.within")} />
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="text-sm font-medium text-slate-200">3. Conditions, exceptions and negations</legend>
        <div className="grid gap-2 sm:grid-cols-3" role="radiogroup">
          {radio("declared", value.propositionsDeclared, "some", <><span className="font-semibold">Yes, listed below</span><span className="block text-xs text-slate-400">Add each one as an exact span.</span></>, v => onChange({ ...value, propositionsDeclared: v as StageAAnswer["propositionsDeclared"] }))}
          {radio("declared", value.propositionsDeclared, "none", <><span className="font-semibold">None</span><span className="block text-xs text-slate-400">The passage carries no condition, exception or negation. This is an explicit answer, not a blank.</span></>, v => onChange({ ...value, propositionsDeclared: v as StageAAnswer["propositionsDeclared"], propositions: [] }))}
          {radio("declared", value.propositionsDeclared, UNKNOWN, <><span className="font-semibold text-amber-200">UNKNOWN</span><span className="block text-xs text-slate-400">I cannot settle whether it carries any.</span></>, v => onChange({ ...value, propositionsDeclared: v as StageAAnswer["propositionsDeclared"] }))}
        </div>
        <FieldErrorText error={declaredError} />
        {value.propositionsDeclared !== "none" && value.propositions.map((p, i) => {
          const path = `propositions[${i}]`;
          const isCondition = p.category === "condition";
          return (
            <div key={p.id || i} className="space-y-2 rounded-lg border border-slate-800 bg-slate-900/50 p-3" data-proposition={i}>
              <div className="flex flex-wrap items-end gap-2">
                <label className="min-w-[180px] flex-1 text-xs text-slate-400" htmlFor={id(`prop-${i}-category`)}>Kind
                  <select id={id(`prop-${i}-category`)} value={p.category} disabled={readOnly} onChange={e => setProp(i, { category: e.target.value, numeric: e.target.value === "condition" ? p.numeric : null })} className="mt-1 block w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100" aria-invalid={Boolean(errorFor(errors, `${path}.category`))}>
                    <option value="">Choose…</option>
                    {CATEGORIES.map(c => <option key={c} value={c}>{c}: {CATEGORY_DEFINITIONS[c].meaning.split(":")[0].split(" (")[0]}</option>)}
                    <option value={UNKNOWN}>UNKNOWN (cannot settle the kind)</option>
                  </select>
                </label>
                {!readOnly && <button type="button" onClick={() => removeProp(i)} className="inline-flex items-center gap-1 rounded-md border border-slate-700 px-2 py-1.5 text-xs text-slate-300 hover:border-rose-500/50 hover:text-rose-200" aria-label={`Remove proposition ${i + 1}`}><Trash2 size={12} /> Remove</button>}
              </div>
              <FieldErrorText error={errorFor(errors, `${path}.category`)} />
              <QuoteField id={id(`prop-${i}-quote`)} label={`Exact span ${i + 1}`} value={p.quote} disabled={readOnly} onChange={v => setProp(i, { quote: v })} onPick={() => arm(`prop-${i}`, `Span ${i + 1}`, p.source)} error={localQuoteError(p.quote, p.source, p.within, path)} />
              <SourceSelect id={id(`prop-${i}-source`)} row={row} value={p.source} disabled={readOnly} onChange={v => setProp(i, { source: v })} />
              <FieldErrorText error={errorFor(errors, `${path}.source`)} />
              <WithinField id={id(`prop-${i}-within`)} row={row} value={p.within} disabled={readOnly} onChange={v => setProp(i, { within: v })} error={errorFor(errors, `${path}.within`)} />
              {isCondition && (
                <div className="rounded-md border border-slate-800 bg-slate-950/60 p-2">
                  <label className="flex items-center gap-2 text-sm text-slate-200">
                    <input type="checkbox" checked={Boolean(p.numeric)} disabled={readOnly} onChange={e => setProp(i, { numeric: e.target.checked ? { value: "", unit: "", operator: "" } : null })} className="accent-cyan-400" />
                    This condition carries a number, deadline or threshold
                  </label>
                  {p.numeric && (
                    <div className="mt-2 grid gap-2 sm:grid-cols-3">
                      <label className="text-xs text-slate-400" htmlFor={id(`prop-${i}-value`)}>Value
                        <input id={id(`prop-${i}-value`)} type="number" inputMode="decimal" step="any" value={p.numeric.value ?? ""} disabled={readOnly} onChange={e => setProp(i, { numeric: { ...p.numeric!, value: e.target.value } })} className="mt-1 block w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100" aria-invalid={Boolean(errorFor(errors, `${path}.numeric.value`))} />
                        <FieldErrorText error={errorFor(errors, `${path}.numeric.value`)} />
                      </label>
                      <label className="text-xs text-slate-400" htmlFor={id(`prop-${i}-unit`)}>Unit (day, week, dollar, item…)
                        <input id={id(`prop-${i}-unit`)} value={p.numeric.unit} disabled={readOnly} onChange={e => setProp(i, { numeric: { ...p.numeric!, unit: e.target.value } })} className="mt-1 block w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100" aria-invalid={Boolean(errorFor(errors, `${path}.numeric.unit`))} />
                        <FieldErrorText error={errorFor(errors, `${path}.numeric.unit`)} />
                      </label>
                      <label className="text-xs text-slate-400" htmlFor={id(`prop-${i}-operator`)}>Operator (&lt;=, &gt;=, &lt;, &gt;, =, within)
                        <input id={id(`prop-${i}-operator`)} value={p.numeric.operator} disabled={readOnly} onChange={e => setProp(i, { numeric: { ...p.numeric!, operator: e.target.value } })} className="mt-1 block w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100" aria-invalid={Boolean(errorFor(errors, `${path}.numeric.operator`))} />
                        <FieldErrorText error={errorFor(errors, `${path}.numeric.operator`)} />
                      </label>
                    </div>
                  )}
                </div>
              )}
              <FieldErrorText error={errorFor(errors, `${path}.numeric`)} />
              <label className="block text-xs text-slate-400" htmlFor={id(`prop-${i}-note`)}>Note (optional)
                <input id={id(`prop-${i}-note`)} value={p.note} disabled={readOnly} onChange={e => setProp(i, { note: e.target.value })} className="mt-1 block w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100" />
              </label>
            </div>
          );
        })}
        {!readOnly && value.propositionsDeclared !== "none" && (
          <button type="button" onClick={addProp} className="inline-flex items-center gap-1 rounded-md border border-slate-600 px-3 py-1.5 text-sm text-slate-200 hover:border-cyan-500/50 hover:text-cyan-200" data-add-proposition><Plus size={14} /> Add a condition, exception or negation</button>
        )}
      </fieldset>

      <label className="block text-sm font-medium text-slate-200" htmlFor={id("notes")}>4. Notes (optional)
        <textarea id={id("notes")} value={value.notes} disabled={readOnly} onChange={e => onChange({ ...value, notes: e.target.value })} rows={2} className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100" placeholder="Anything you want the scorer run to remember about this reading" />
      </label>

      {!readOnly && (
        <label className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-amber-100" data-unsure>
          <input type="checkbox" checked={unsure} onChange={e => onUnsureChange(e.target.checked)} className="mt-1 accent-amber-400" />
          <span><span className="font-semibold">Unsure, return later.</span> Keeps everything above as a draft and lists this passage in the commit review until you clear it.</span>
        </label>
      )}
    </div>
  );
}

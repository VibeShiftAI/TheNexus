"use client";

/**
 * One passage (a row's text or one of its context spans) with the current
 * labels highlighted and two ways to take an exact quote from it:
 *
 *   - select words with the mouse or a finger, then "Use selection";
 *   - "Pick words": every word becomes a button; the first press marks the
 *     start, the second the end (keyboard and screen-reader reachable).
 *
 * Both hand back the exact slice of the passage, so the quote can only be
 * words that are really there. Which field receives it is the `target` the
 * form armed ("Quote from passage" next to a field).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { MousePointerClick, X } from "lucide-react";

export type MarkKind = "actor" | "condition" | "exception" | "negation" | "proposed" | "removed";
export interface Mark { start: number; end: number; kind: MarkKind; label: string }
export interface PassageSource { kind: "row" | "context"; index: number | null }
export interface QuoteTarget { field: string; label: string; source: PassageSource }

const MARK_CLASS: Record<MarkKind, string> = {
  actor: "bg-cyan-500/25 text-cyan-100 ring-1 ring-cyan-400/40",
  condition: "bg-emerald-500/25 text-emerald-100 ring-1 ring-emerald-400/40",
  exception: "bg-amber-500/25 text-amber-100 ring-1 ring-amber-400/40",
  negation: "bg-rose-500/25 text-rose-100 ring-1 ring-rose-400/40",
  proposed: "bg-violet-500/25 text-violet-100 ring-1 ring-violet-400/40",
  removed: "bg-rose-500/20 text-rose-100 line-through decoration-rose-300",
};

interface Token { text: string; start: number; end: number; word: boolean; index: number }

function tokenize(text: string): Token[] {
  const out: Token[] = [];
  let offset = 0;
  let wordIndex = 0;
  for (const part of text.split(/(\s+)/)) {
    if (!part) continue;
    const word = !/^\s+$/.test(part);
    out.push({ text: part, start: offset, end: offset + part.length, word, index: word ? wordIndex : -1 });
    if (word) wordIndex += 1;
    offset += part.length;
  }
  return out;
}

const sameSource = (a: PassageSource, b: PassageSource) => a.kind === b.kind && (a.kind === "row" || a.index === b.index);

export function Passage({ title, text, marks, source, target, onQuote, onCancelTarget, dense = false }: {
  title: string; text: string; marks: Mark[]; source: PassageSource; target: QuoteTarget | null;
  onQuote?: (quote: string, source: PassageSource) => void; onCancelTarget?: () => void; dense?: boolean;
}) {
  const tokens = useMemo(() => tokenize(text), [text]);
  const armed = Boolean(target && onQuote && sameSource(target.source, source));
  const [picking, setPicking] = useState(false);
  const [pickStart, setPickStart] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const container = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!armed) { setPicking(false); setPickStart(null); setNotice(null); }
  }, [armed]);

  const markFor = (token: Token): Mark | null => {
    for (const mark of marks) if (token.start >= mark.start && token.end <= mark.end) return mark;
    return null;
  };

  const useSelection = () => {
    const selection = window.getSelection();
    const raw = selection ? selection.toString() : "";
    const inside = Boolean(selection && selection.anchorNode && container.current && container.current.contains(selection.anchorNode));
    if (!raw.trim() || !inside) {
      setNotice("Select words inside this passage first, or use Pick words.");
      return;
    }
    onQuote?.(raw.replace(/\s+/g, " ").trim(), source);
    selection?.removeAllRanges();
    setNotice(null);
  };

  const pick = (token: Token) => {
    if (pickStart === null) { setPickStart(token.index); setNotice(`Start at "${token.text}". Now pick the last word.`); return; }
    const [a, b] = pickStart <= token.index ? [pickStart, token.index] : [token.index, pickStart];
    const first = tokens.find(t => t.index === a)!;
    const last = tokens.find(t => t.index === b)!;
    onQuote?.(text.slice(first.start, last.end), source);
    setPickStart(null);
    setPicking(false);
    setNotice(null);
  };

  return (
    <div className={`rounded-lg border ${armed ? "border-cyan-500/60 bg-cyan-500/5" : "border-slate-800 bg-slate-950/60"} ${dense ? "p-3" : "p-4"}`} data-passage={source.kind === "row" ? "row" : `context-${source.index}`}>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">{title}</span>
        {armed && target && (
          <span className="rounded-full border border-cyan-500/40 bg-cyan-500/10 px-2 py-0.5 text-[11px] text-cyan-200" data-quote-target>
            Choosing words for: {target.label}
          </span>
        )}
        {armed && (
          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            <button type="button" onClick={useSelection} className="inline-flex items-center gap-1 rounded-md border border-cyan-500/50 bg-cyan-500/10 px-2 py-1 text-xs text-cyan-100 hover:bg-cyan-500/20" data-use-selection>
              <MousePointerClick size={12} /> Use selection
            </button>
            <button type="button" aria-pressed={picking} onClick={() => { setPicking(v => !v); setPickStart(null); setNotice(picking ? null : "Pick the first word, then the last word."); }} className={`rounded-md border px-2 py-1 text-xs ${picking ? "border-cyan-400 bg-cyan-500/20 text-cyan-100" : "border-slate-600 text-slate-200 hover:border-cyan-500/50"}`} data-pick-words>
              {picking ? "Picking words…" : "Pick words"}
            </button>
            <button type="button" onClick={onCancelTarget} aria-label="Stop choosing words" className="rounded-md border border-slate-700 p-1 text-slate-400 hover:text-slate-100">
              <X size={12} />
            </button>
          </div>
        )}
      </div>
      <div ref={container} className={`whitespace-pre-wrap font-serif ${dense ? "text-[15px] leading-7" : "text-base leading-8"} text-slate-100`} data-passage-text>
        {tokens.map((token, i) => {
          if (!token.word) return <span key={i}>{token.text}</span>;
          const mark = markFor(token);
          const cls = mark ? `rounded-sm px-0.5 ${MARK_CLASS[mark.kind]}` : "";
          if (picking) {
            const chosen = pickStart === token.index;
            return (
              <button key={i} type="button" onClick={() => pick(token)} aria-pressed={chosen} data-word={token.index}
                className={`rounded-sm px-0.5 font-serif outline-none ring-offset-1 ring-offset-slate-950 hover:bg-cyan-500/30 focus-visible:ring-2 focus-visible:ring-cyan-300 ${chosen ? "bg-cyan-400/40 text-white" : cls}`}>
                {token.text}
              </button>
            );
          }
          return <span key={i} className={cls} title={mark?.label} data-word={token.index}>{token.text}</span>;
        })}
      </div>
      {notice && <p className="mt-2 text-xs text-cyan-200/80" role="status">{notice}</p>}
      {marks.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5 text-[11px]">
          {marks.map((mark, i) => (
            <span key={i} className={`rounded-full px-2 py-0.5 ${MARK_CLASS[mark.kind]}`}>{mark.label}</span>
          ))}
        </div>
      )}
    </div>
  );
}

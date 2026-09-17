"use client";
import { useEffect, useState } from "react";
import { getKnowledgeView, type KnowledgeView } from "@/lib/ingestion-control";
import { buttonClass, inputClass, Field } from "./fields";

export function KnowledgeSearch({
  query,
  onClose,
}: {
  query: string;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(query);
  const [term, setTerm] = useState(query);
  const [result, setResult] = useState<KnowledgeView | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    setResult(null);
    getKnowledgeView(term)
      .then((data) => {
        if (active) setResult(data);
      })
      .catch((e) => {
        if (active)
          setError(e instanceof Error ? e.message : "Retrieval failed");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [term]);
  const unavailable =
    result &&
    (!result.cortex || /offline|unavailable|error/i.test(result.cortex.status));
  return (
    <aside
      aria-label="Knowledge search"
      className="space-y-3 rounded-lg border border-cyan-900/60 bg-cyan-950/10 p-4"
    >
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-cyan-300">
          Search existing knowledge
        </h3>
        <button className={buttonClass} onClick={onClose}>
          Close search
        </button>
      </div>
      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (draft.trim()) setTerm(draft.trim());
        }}
      >
        <Field label="Knowledge search query">
          <input
            className={inputClass}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
        </Field>
        <button className={buttonClass} disabled={loading || !draft.trim()}>
          Search knowledge
        </button>
      </form>
      {loading && (
        <p role="status" className="text-xs text-slate-400">
          Searching knowledge…
        </p>
      )}
      {(error || unavailable) && (
        <p role="alert" className="text-xs text-amber-300">
          Knowledge retrieval unavailable
          {error ? `: ${error}` : ". Some sources did not respond."} Missing
          results do not establish that knowledge is absent.
        </p>
      )}
      {result && (
        <div className="space-y-3 text-xs text-slate-300">
          {!!result.facts?.length && (
            <ul className="max-h-64 space-y-2 overflow-auto">
              {result.facts.map((fact, i) => (
                <li key={i} className="border-l border-cyan-700 pl-2">
                  {fact.fact}
                  <span className="ml-1 text-slate-500">
                    {fact.observed_at
                      ? new Date(fact.observed_at).toLocaleDateString()
                      : ""}
                    {fact.is_current === false ? " · superseded" : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {result.semantic_context && (
            <div className="max-h-64 overflow-auto whitespace-pre-wrap">
              {result.semantic_context}
            </div>
          )}
          {!!result.graph?.nodes.length && (
            <p className="text-slate-400">
              Related entities:{" "}
              {result.graph.nodes.map((n) => n.label).join(", ")}
            </p>
          )}
          {!result.facts?.length &&
            !result.semantic_context &&
            !result.graph?.nodes.length &&
            !unavailable && (
              <p>
                No matches returned for this query. Try the question or another
                tag before starting new research.
              </p>
            )}
          <a
            href="/knowledge-ingestion"
            className="inline-block text-cyan-300 underline"
          >
            Open knowledge graph console
          </a>
        </div>
      )}
    </aside>
  );
}

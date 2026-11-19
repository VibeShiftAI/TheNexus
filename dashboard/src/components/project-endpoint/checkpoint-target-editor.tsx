"use client";

import { useState } from "react";
import { buttonClass, inputClass, Field } from "./fields";

export function CheckpointTargetEditor<Revision extends string | number>({ id, target, revision, onSave }: {
  id: string;
  target?: string;
  revision: Revision;
  onSave: (target: string | null, prior: string | null, revision: Revision) => Promise<void>;
}) {
  const [draft, setDraft] = useState<{ value: string; prior: string | null; revision: Revision } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  function edit() {
    setError("");
    setDraft({ value: target ?? "", prior: target ?? null, revision });
  }
  async function save(target: string | null) {
    if (!draft) return;
    setBusy(true);
    setError("");
    try {
      await onSave(target, draft.prior, draft.revision);
      setDraft(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save checkpoint target.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mt-2 space-y-2 text-xs" data-checkpoint-target={id}>
      {draft ? (
        <form className="space-y-2" onSubmit={e => { e.preventDefault(); void save(draft.value.trim()); }}>
          <Field label="Target date or window">
            <input className={inputClass} value={draft.value} disabled={busy}
              onChange={e => setDraft({ ...draft, value: e.target.value })} />
          </Field>
          <div className="flex flex-wrap gap-2">
            <button className={buttonClass} disabled={busy || !draft.value.trim()}>Save target</button>
            {draft.prior !== null && <button type="button" className={buttonClass} disabled={busy} onClick={() => void save(null)}>Clear target</button>}
            <button type="button" className={buttonClass} disabled={busy} onClick={() => { setDraft(null); setError(""); }}>Cancel</button>
          </div>
          {error && <p role="alert" className="text-amber-300">{error}</p>}
        </form>
      ) : (
        <div className="flex flex-wrap items-baseline gap-2">
          {target && <span className="break-words text-slate-300">Target · {target}</span>}
          <button type="button" className="text-cyan-300 underline" onClick={edit}>{target ? "Edit target" : "Set target"}</button>
        </div>
      )}
    </div>
  );
}

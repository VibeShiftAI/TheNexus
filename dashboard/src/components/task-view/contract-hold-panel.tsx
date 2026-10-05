/**
 * ContractHoldPanel: a task whose brief changed during execution, by someone
 * Nexus could not verify as Robert, is held with the exact diff and source.
 *
 * Robert's own contract changes (his session, his operator credential, or a
 * Praxis relay of a decision he already made) never land here: the admission
 * guard records them as authorized and the task advances. What does land here
 * is executor or QA drift: which fields moved, from what to what, who wrote
 * it, and in which phase. Two actions resolve it exactly once: accept the
 * changed contract, or return the task to the authorized one. Nothing else
 * on this screen clears the hold (docs/work-admission.md, task 9021f20d).
 *
 * The server checks Robert's verified Access session or operator credential.
 * The Mac app on localhost carries neither, so the panel explains that honestly
 * instead of pretending a click worked.
 */
"use client";

import { useState } from "react";
import { ShieldAlert } from "lucide-react";
import {
  ContractDecisionError,
  decideContractHold,
  workAdmissionOf,
  type ContractChangeEntry,
  type ContractHold,
  type TaskById,
} from "@/lib/nexus/tasks";

const FIELD_LABELS: Record<string, string> = {
  name: "Title",
  description: "Description",
  dispatch_instructions: "Dispatch instructions",
  dependencies: "Dependencies",
  project_id: "Project",
  workspace: "Workspace",
  "payload.prompt": "Prompt",
  "payload.acceptance_criteria": "Acceptance criteria",
  "payload.scope": "Scope",
  "payload.target_files": "Target files",
  "payload.context_files": "Context files",
  "payload.commands": "Commands",
  "payload.constraints": "Constraints",
  "payload.binding_constraints": "Binding constraints",
  "payload.workspace": "Workspace",
  "payload.declared_paths": "Declared paths",
  "payload.workspace_roots": "Workspace roots",
  "payload.additional_workspaces": "Additional workspaces",
};

const ORIGIN_LABELS: Record<string, string> = {
  operator: "Robert (verified)",
  operator_relayed: "Praxis relaying Robert's recorded decision",
  runtime: "Praxis runtime (no relayed decision)",
  system: "Nexus",
  unverified: "unverified writer",
};

export function fieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? field;
}

export function describeOrigin(origin: ContractChangeEntry["origin"]): string {
  const base = ORIGIN_LABELS[origin.kind] ?? origin.kind;
  const who = origin.requester && origin.requester !== "operator" && origin.requester !== "runtime" ? ` via ${origin.requester.replace(/_/g, " ")}` : "";
  return `${base}${who}`;
}

export function describeExecution(execution: ContractChangeEntry["execution"]): string {
  const sessions = execution.open_dispatches?.length
    ? `; running: ${execution.open_dispatches.map((d) => `${d.executor}${d.task_id.startsWith("qa--") ? " (QA)" : ""}`).join(", ")}`
    : "";
  return `${execution.phase.replace(/_/g, " ")} at ${execution.status ?? "unknown"}${execution.next_status ? ` moving to ${execution.next_status}` : ""}${sessions}`;
}

export function renderValue(value: unknown): string {
  if (value === undefined) return "(absent)";
  if (value === null) return "(none)";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

/**
 * What the authorized contract held for a drifted field. A field the drift
 * added has no authorized value and returning removes it; a value is missing
 * only when the drift was found on read, after a write bypassed the guard.
 */
export function authorizedColumn(field: string, hold: ContractHold, baselineFields?: Record<string, string>): string {
  if (field in hold.authorized_values) return renderValue(hold.authorized_values[field]);
  if (baselineFields && !(field in baselineFields)) {
    return "(absent from the authorized contract: this field was added by the drift; returning the contract removes it)";
  }
  return "(not recorded: this drift was found on read, after a write bypassed the guard; it can be accepted but not returned)";
}

/**
 * The value the task row holds for a governed field right now. Fields that
 * map to a row column are read from the row; the held entries only fill in
 * fields the loaded task cannot show.
 */
export function rowValue(task: TaskById, field: string): { known: boolean; value?: unknown } {
  if (field.startsWith("payload.")) {
    if (!task.antigravity_payload || typeof task.antigravity_payload !== "object") return { known: false };
    return { known: true, value: task.antigravity_payload[field.slice("payload.".length)] };
  }
  switch (field) {
    case "name":
      return { known: true, value: task.title };
    case "description":
      return { known: true, value: task.description };
    case "dependencies":
      return { known: true, value: task.dependencies ?? [] };
    case "dispatch_instructions":
      return { known: task.dispatch_instructions !== undefined, value: task.dispatch_instructions };
    case "project_id":
      return { known: task.project_id !== undefined, value: task.project_id };
    default:
      return { known: false };
  }
}

/** Errors that mean the page is behind the task: a reload, not a retry, is the next step. */
function needsRefresh(error: unknown): boolean {
  return error instanceof ContractDecisionError
    && (error.code === "contract_hold_changed" || error.code === "no_contract_hold" || /changed since/i.test(error.message));
}

function decisionFailureText(error: unknown): string {
  if (error instanceof ContractDecisionError) {
    if (error.code === "contract_decision_unauthorized") {
      return error.reason === "assertion-missing"
        ? "This browser carries no verified operator session, so Nexus refused the decision. Decide from the tunnel or phone (behind Access), or with the operator credential."
        : `Nexus could not verify this request as Robert (${error.reason ?? error.code}). Decide from a verified operator session or with the operator credential.`;
    }
    if (error.code === "contract_hold_changed" || /changed since/i.test(error.message)) {
      return "The task or its hold changed since this page loaded. Refresh and read the new diff before deciding.";
    }
    if (error.code === "no_contract_hold") return "This hold was already decided. Refresh to see the current receipt.";
    if (error.code === "contract_restore_failed") {
      return "The authorized values for this drift were not recorded (it was found on read), so the brief cannot be returned automatically. Accept the change, or restore the fields by hand and the hold clears on its own.";
    }
    if (error.status === 503) return "Nexus could not check operator identity right now; nothing was recorded.";
    return error.message;
  }
  return error instanceof Error ? error.message : "The decision could not be recorded.";
}

export function ContractHoldPanel({ task, onChanged }: { task: TaskById; onChanged?: () => void }) {
  const receipt = workAdmissionOf(task);
  const hold = receipt?.hold_kind === "contract_drift" ? receipt.contract_hold : undefined;
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<"approve" | "return_to_authorized" | null>(null);
  const [failure, setFailure] = useState<{ text: string; refresh: boolean } | null>(null);
  if (!receipt || !hold) return null;

  const entries = receipt.contract_changes ?? [];
  const held = entries.filter((entry) => hold.change_ids.includes(entry.id));
  // "Now in the brief" is the task row itself. The held entries, applied in
  // order, stand in only for fields the loaded row cannot show; an entry
  // without an after value is a deletion and leaves the field absent.
  const entryValues = new Map<string, unknown>();
  for (const entry of held) for (const change of entry.fields) entryValues.set(change.field, "after" in change ? change.after : undefined);
  const currentValue = (field: string): unknown => {
    const row = rowValue(task, field);
    return row.known ? row.value : entryValues.get(field);
  };
  const recent = entries.slice(-6).reverse();

  async function decide(decision: "approve" | "return_to_authorized") {
    if (typeof task.version !== "number") {
      setFailure({ text: "This task view has no row version; refresh before deciding.", refresh: true });
      return;
    }
    setBusy(decision);
    setFailure(null);
    try {
      await decideContractHold(task.id, {
        expected_task_version: task.version,
        decision,
        change_ids: hold!.change_ids,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      });
      setReason("");
      onChanged?.();
    } catch (error) {
      setFailure({ text: decisionFailureText(error), refresh: needsRefresh(error) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section
      id="contract-hold"
      className="scroll-mt-24 rounded-lg border border-rose-500/40 bg-rose-500/5 p-4"
      aria-label="Contract changed during execution by an unverified source"
    >
      <div className="flex items-start gap-3">
        <ShieldAlert size={18} className="mt-0.5 shrink-0 text-rose-400" />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-rose-200">Contract changed during execution; held for your decision</h3>
          <p className="mt-1 text-sm text-rose-100/80">{receipt.reason}</p>
          <p className="mt-2 text-xs text-rose-200/60">
            Held since {hold.since}. Authorized contract version {receipt.contract?.version ?? "?"}. Edits made through a verified
            operator session or the operator credential never open this hold; this one came from a writer Nexus could not verify,
            which includes the Mac app without an Access session.
            {hold.prior?.decision ? ` Before the drift the admission decision was ${hold.prior.decision}.` : ""}
          </p>
        </div>
      </div>

      <ul className="mt-3 space-y-3" aria-label="Drifted fields">
        {hold.drifted_fields.map((field) => (
          <li key={field} className="rounded-md border border-rose-500/20 bg-slate-950/60 p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-rose-300/80">{fieldLabel(field)}</p>
            <div className="mt-2 grid gap-2 md:grid-cols-2">
              <div>
                <p className="text-[11px] uppercase tracking-wide text-emerald-300/70">Authorized</p>
                <pre className="custom-scrollbar mt-1 max-h-48 overflow-auto whitespace-pre-wrap text-[12px] leading-5 text-emerald-50/80">
                  {authorizedColumn(field, hold, receipt.contract?.fields)}
                </pre>
              </div>
              <div>
                <p className="text-[11px] uppercase tracking-wide text-rose-300/70">Now in the brief</p>
                <pre className="custom-scrollbar mt-1 max-h-48 overflow-auto whitespace-pre-wrap text-[12px] leading-5 text-rose-50/80">
                  {renderValue(currentValue(field))}
                </pre>
              </div>
            </div>
          </li>
        ))}
      </ul>

      <ul className="mt-3 space-y-1 text-xs text-rose-100/70" aria-label="Who changed it">
        {held.map((entry) => (
          <li key={entry.id}>
            <span className="font-mono text-rose-200/80">{entry.id}</span>: {entry.fields.map((f) => fieldLabel(f.field)).join(", ")} changed by{" "}
            {describeOrigin(entry.origin)} while {describeExecution(entry.execution)}, task version {entry.task_version ?? "?"}, {entry.recorded_at}.
          </li>
        ))}
      </ul>

      <div className="mt-4 space-y-2">
        <label className="block text-xs text-rose-200/70" htmlFor="contract-hold-reason">
          Note for the receipt (optional)
        </label>
        <textarea
          id="contract-hold-reason"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          rows={2}
          className="w-full rounded-md border border-rose-500/30 bg-slate-950/60 p-2 text-sm text-rose-50 outline-none focus-visible:ring-1 focus-visible:ring-rose-400"
          placeholder="Why you accept the change, or why the brief goes back."
        />
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => decide("approve")}
            className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-sm font-medium text-emerald-200 hover:bg-emerald-500/20 disabled:opacity-50"
          >
            {busy === "approve" ? "Recording..." : "Accept the changed contract"}
          </button>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => decide("return_to_authorized")}
            className="rounded-md border border-sky-500/40 bg-sky-500/10 px-3 py-1.5 text-sm font-medium text-sky-200 hover:bg-sky-500/20 disabled:opacity-50"
          >
            {busy === "return_to_authorized" ? "Restoring..." : "Return to the authorized contract"}
          </button>
        </div>
        {failure ? (
          <p role="alert" className="flex flex-wrap items-center gap-2 text-sm text-amber-200">
            <span>{failure.text}</span>
            {failure.refresh && onChanged ? (
              <button
                type="button"
                onClick={() => {
                  setFailure(null);
                  onChanged();
                }}
                className="rounded-md border border-amber-400/40 bg-amber-500/10 px-2 py-1 text-xs font-medium text-amber-100 hover:bg-amber-500/20"
              >
                Refresh diff
              </button>
            ) : null}
          </p>
        ) : null}
      </div>

      {recent.length ? (
        <details className="mt-3 group">
          <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-rose-300/80 outline-none focus-visible:ring-1 focus-visible:ring-rose-400">
            Contract change history
          </summary>
          <ul className="mt-2 space-y-1 text-xs text-rose-100/70">
            {recent.map((entry) => (
              <li key={entry.id}>
                v{entry.contract_version} {entry.outcome}
                {entry.resolution ? ` (${entry.resolution.decision.replace(/_/g, " ")})` : ""}: {entry.fields.map((f) => fieldLabel(f.field)).join(", ") || "no governed field"} by{" "}
                {describeOrigin(entry.origin)}, {entry.recorded_at}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

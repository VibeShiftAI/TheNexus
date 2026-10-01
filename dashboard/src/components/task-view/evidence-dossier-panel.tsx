"use client";

/**
 * Completion evidence dossier for the task screen (/task/[id]).
 *
 * One panel, four rows: walkthrough, verify gate, code-review gate, QA
 * verdict (server/routes/task-evidence.js). Each present row opens in one
 * click to its recorded result, its timestamp, where the record came from,
 * and the tail of the run log it points at. An absent row says why it is
 * absent. A completion missing any piece renders amber and names the missing
 * gates; only a fully evidenced completion gets the green treatment.
 *
 * Renders nothing for tasks that are not completed: the dossier is about a
 * completion, and the dispatch console already covers a run in flight.
 */

import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  FileText,
  Loader2,
  ShieldAlert,
  ShieldCheck,
  XCircle,
  CheckCircle2,
} from "lucide-react";
import {
  EVIDENCE_TONE_CLASSES,
  evidenceBadge,
  evidenceSourceLabel,
  getEvidenceLogTail,
  getTaskEvidence,
  type EvidenceDossier,
  type EvidenceLogTail,
  type EvidencePiece,
} from "@/lib/task-evidence";

function formatWhen(iso: string | null): string {
  if (!iso) return "no timestamp";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function PieceIcon({ status }: { status: EvidencePiece["status"] }) {
  if (status === "present") return <CheckCircle2 size={14} className="shrink-0 text-emerald-400" />;
  if (status === "failed") return <XCircle size={14} className="shrink-0 text-rose-400" />;
  return <CircleDashed size={14} className="shrink-0 text-amber-400" />;
}

function LogTail({ href }: { href: string }) {
  const [tail, setTail] = useState<EvidenceLogTail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    getEvidenceLogTail(href)
      .then((t) => !cancelled && setTail(t))
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : "Failed to load log"));
    return () => {
      cancelled = true;
    };
  }, [href]);
  if (error) return <p className="text-[11px] text-rose-300">Log unavailable: {error}</p>;
  if (!tail) {
    return (
      <p className="flex items-center gap-1 text-[11px] text-slate-500">
        <Loader2 size={11} className="animate-spin" /> loading log tail
      </p>
    );
  }
  return (
    <div>
      <p className="mb-1 text-[10px] text-slate-500">
        {tail.truncated ? `Last ${Math.round(tail.text.length / 1024)} KB of ${Math.round(tail.size / 1024)} KB` : `${tail.size} bytes`}
        {" · file modified "}
        {formatWhen(tail.modifiedAt)}
      </p>
      <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all rounded border border-slate-800 bg-slate-950/80 p-2.5 text-[11px] leading-4 text-slate-400">
        {tail.text}
      </pre>
    </div>
  );
}

function PieceRow({ piece }: { piece: EvidencePiece }) {
  const [open, setOpen] = useState(false);
  const present = piece.status === "present";
  const sourceLabel = evidenceSourceLabel(piece.source);
  return (
    <li id={`evidence-${piece.key}`} className="rounded-md border border-slate-800 bg-slate-950/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full flex-wrap items-center gap-2 px-3 py-2 text-left"
      >
        {open ? (
          <ChevronDown size={13} className="shrink-0 text-slate-500" />
        ) : (
          <ChevronRight size={13} className="shrink-0 text-slate-500" />
        )}
        <PieceIcon status={piece.status} />
        <span className="text-sm font-medium text-slate-100">{piece.label}</span>
        <span
          className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
            present
              ? "border-emerald-500/30 text-emerald-300"
              : piece.status === "failed"
                ? "border-rose-500/40 text-rose-300"
                : "border-amber-500/40 text-amber-300"
          }`}
        >
          {present
            ? "on record"
            : piece.status === "failed"
              ? `failed${piece.verdict ? `: ${piece.verdict}` : ""}`
              : piece.status === "incomplete"
                ? "incomplete"
                : "absent"}
        </span>
        <span className="ml-auto text-[11px] text-slate-500">{formatWhen(piece.at)}</span>
      </button>
      {open && (
        <div className="space-y-2 border-t border-slate-800 px-3 py-2.5 text-xs">
          {piece.reason && (
            <p className="flex items-start gap-1.5 text-amber-200/90">
              <AlertTriangle size={12} className="mt-0.5 shrink-0" /> {piece.reason}
            </p>
          )}
          {piece.detail && <p className="whitespace-pre-wrap text-slate-300">{piece.detail}</p>}
          <p className="text-[11px] text-slate-500">
            {sourceLabel ? `Source: ${sourceLabel}` : "No source record"}
            {piece.reviewer ? ` · reviewer ${piece.reviewer}` : ""}
            {piece.ref?.seq != null ? ` · run-events seq ${piece.ref.seq}` : ""}
          </p>
          {piece.key === "walkthrough" && present && (
            <a href="#task-walkthrough" className="inline-flex items-center gap-1 text-[11px] text-cyan-300 hover:underline">
              <FileText size={11} /> Read the walkthrough
            </a>
          )}
          {piece.log ? (
            <div className="space-y-1">
              <p className="truncate text-[10px] text-slate-500" title={piece.log.path ?? undefined}>
                Log: {piece.log.executor ?? "run"} dispatch {piece.log.dispatchId.slice(0, 8)}
                {piece.log.path ? ` · ${piece.log.path}` : " · no log path recorded"}
              </p>
              {piece.log.href && <LogTail href={piece.log.href} />}
            </div>
          ) : (
            <p className="text-[10px] text-slate-600">No run log is linked to this piece.</p>
          )}
        </div>
      )}
    </li>
  );
}

export function EvidenceDossierPanel({ taskId, refreshKey }: { taskId: string; refreshKey?: string | null }) {
  const [dossier, setDossier] = useState<EvidenceDossier | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setDossier(await getTaskEvidence(taskId));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load evidence");
    }
  }, [taskId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  if (error && !dossier) {
    return (
      <section className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-xs text-amber-200">
        Completion evidence could not be loaded ({error}). Treat this completion as unverified until it can.
      </section>
    );
  }
  if (!dossier || dossier.state === "not_completed") return null;

  const badge = evidenceBadge(dossier);
  const verified = dossier.state === "verified";
  return (
    <section
      aria-label="Completion evidence"
      className={`rounded-lg border p-4 ${
        verified ? "border-emerald-500/30 bg-emerald-500/5" : "border-amber-500/50 bg-amber-500/5"
      }`}
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {verified ? (
          <ShieldCheck size={16} className="text-emerald-400" />
        ) : (
          <ShieldAlert size={16} className="text-amber-400" />
        )}
        <h3 className="text-sm font-semibold text-slate-100">Completion evidence</h3>
        <span
          className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${EVIDENCE_TONE_CLASSES[badge.tone]}`}
          title={badge.title}
        >
          {badge.label}
          {badge.missingText ? `: ${badge.missingText}` : ""}
        </span>
        {dossier.verification?.verdict && (
          <span className="text-[11px] text-slate-500" title="Praxis's own grade of the evidence behind this completion">
            Praxis grade: {dossier.verification.verdict}
          </span>
        )}
      </div>
      <p className={`mb-3 text-xs ${verified ? "text-emerald-200/70" : "text-amber-200/80"}`}>
        {dossier.summary}
        {dossier.predatesEvidenceCapture && " This task completed before Praxis began recording verification evidence."}
      </p>
      {!dossier.sources.spine.available && (
        <p className="mb-3 text-[11px] text-amber-300/80">
          Praxis&apos;s verification record could not be read ({dossier.sources.spine.reason ?? "unavailable"}), so
          gates it would carry are shown unseen, not passed.
        </p>
      )}
      <ul className="space-y-2">
        {dossier.pieces.map((p) => (
          <PieceRow key={p.key} piece={p} />
        ))}
      </ul>
    </section>
  );
}

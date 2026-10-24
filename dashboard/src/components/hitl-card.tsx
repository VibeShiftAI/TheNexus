"use client";

/**
 * The Praxis Inbox card — ONE implementation, rendered by every inbox surface.
 *
 * WHY THIS MODULE EXISTS. The bridge widget (`hitl-inbox.tsx`) and the
 * fullscreen route (`app/inbox`) each grew their own copy of this card, and
 * the copies drifted in BOTH directions: the widget alone showed
 * `confidenceScore`, while the fullscreen alone had the priority rail, the
 * relative timestamp, ⌘⏎ submit, and Park. Neither surface was strictly
 * better — Robert simply saw different things depending on where he opened
 * the same queue.
 *
 * There is one inbox, so there is one card. Everything below is the union of
 * what the two copies did; surfaces differ only in the chrome AROUND the list
 * (filters, history, stream status), never in the card itself.
 */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { Archive, ChevronDown, ChevronRight, ImagePlus, Loader2, Send, X } from "lucide-react";
import type { HITLRequest } from "@praxis/contract";

import { hitlTaskMeta, parseResumeContext, PRIORITY_TONES, REASON_LABELS } from "@/lib/hitl-meta";
import {
  HITL_ATTACHMENT_MAX_COUNT,
  formatBytes,
  refuseHitlAttachment,
  uploadHitlAttachment,
  type HitlAnswerAttachment,
  type PendingHitlAttachment,
} from "@/lib/hitl-attachments";
import { briefDetails, briefFromMetadata, briefQuestions } from "@/lib/human-brief";
import { describeHitlAction } from "@/lib/alert-action";
import { AlertAction, SafeAlertMarkdown } from "./alert-action";
import { HumanBriefBlock } from "./human-brief";
import {
  BoardMaintenanceHitlCard,
  ScheduleHitlCard,
  SkillCandidatesHitlCard,
  isBoardMaintenanceHitl,
  isScheduleHitl,
  isSkillCandidatesHitl,
} from "./schedule-hitl-card";

export type HitlResolveInput = {
  choice?: string;
  freeText?: string;
  /**
   * Structured input alongside the answer. The card sets
   * `{ attachments: HitlAnswerAttachment[] }` when photos were attached;
   * schedule cards carry their own overrides here.
   */
  payload?: Record<string, unknown>;
};
export type HitlResolver = (requestId: string, input: HitlResolveInput) => Promise<void>;

export function timeAgo(iso: string | undefined): string {
  if (!iso) return "";
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true });
  } catch {
    return "";
  }
}

/**
 * Render the right card for a request's kind.
 *
 * `onResolveSchedule` exists for the one genuine per-surface difference: the
 * fullscreen route hops back to the bridge after a schedule approval so the
 * "Engage" confirmation voice has a mounted terminal to play in.
 */
export function HitlCard({
  request,
  resolving,
  onResolve,
  onResolveSchedule,
}: {
  request: HITLRequest;
  resolving: boolean;
  onResolve: HitlResolver;
  onResolveSchedule?: HitlResolver;
}) {
  if (describeHitlAction(request).state !== 'pending') return <AlertAction action={describeHitlAction(request)} inline />;
  if (request.metadata?.kind === "qa-followup-slate" && Array.isArray(request.metadata.slots)) {
    return <ScheduleHitlCard request={request} resolving={resolving} onResolve={onResolve} />;
  }
  if (isScheduleHitl(request)) {
    return (
      <ScheduleHitlCard
        request={request}
        resolving={resolving}
        onResolve={onResolveSchedule ?? onResolve}
      />
    );
  }
  if (isSkillCandidatesHitl(request)) {
    return <SkillCandidatesHitlCard request={request} resolving={resolving} onResolve={onResolve} />;
  }
  if (isBoardMaintenanceHitl(request)) {
    return (
      <BoardMaintenanceHitlCard request={request} resolving={resolving} onResolve={onResolve} />
    );
  }
  return <HitlRequestCard request={request} resolving={resolving} onResolve={onResolve} />;
}

export function HitlRequestCard({
  onResolve,
  request,
  resolving,
}: {
  onResolve: HitlResolver;
  request: HITLRequest;
  resolving: boolean;
}) {
  const [reply, setReply] = useState("");
  const [showContext, setShowContext] = useState(false);
  // Photos picked for this answer stay on the device until Send uploads
  // them (lib/hitl-attachments.ts). A refused file, a failed upload or a
  // failed send is reported here and discards nothing: the typed answer and
  // the photos remain in the card.
  const [attachments, setAttachments] = useState<PendingHitlAttachment[]>([]);
  const [attachNotice, setAttachNotice] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attachmentKey = useRef(0);
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  useEffect(
    () => () => {
      for (const item of attachmentsRef.current) if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    },
    [],
  );
  const meta = hitlTaskMeta(request);
  const resume = parseResumeContext(request.originalPayload?.prompt);
  // Only offer the accordion when the payload adds something beyond the
  // question itself (older records set prompt = question verbatim).
  const hasContext =
    (resume.context.length > 0 && resume.context !== request.question) || resume.tail.length > 0;
  const tone = PRIORITY_TONES[request.priority ?? "normal"] ?? PRIORITY_TONES.normal;
  const reasonLabel = REASON_LABELS[request.reason] ?? request.reason;
  // Empty-answer resolution is only a guaranteed no-op for task questions
  // (Praxis parks the task, dispatches nothing). Other kinds fall through to
  // the agent-mediated resume, so don't offer "park" there.
  const canPark = meta.kind === "task-question";
  const action = describeHitlAction(request, true);
  // The human brief (Praxis docs/human-brief.md) leads when the producer
  // shipped one: project, what happened, the problem, the ask. The sender's
  // full text then becomes detail under it rather than the whole card.
  const brief = briefFromMetadata(request.metadata);
  const questions = brief ? briefQuestions(request.metadata) : [];
  const details = brief ? briefDetails(request.metadata) : undefined;
  // With a brief and structured questions the `question` text twin repeats
  // them; with a brief alone (task questions, approvals) the question is
  // still the thing to answer, so it stays, long ones folded.
  const showQuestionText = !brief || questions.length === 0;
  const foldQuestion = Boolean(brief) && showQuestionText && request.question.length > 700;

  function addFiles(files: FileList | File[] | null) {
    if (!files) return;
    const picked = Array.from(files);
    if (picked.length === 0) return;
    // Build the next list from the ref, not inside the state updater: the
    // refusal must be known now, and updaters run later in the render.
    const next = [...attachmentsRef.current];
    let refusal: string | null = null;
    for (const file of picked) {
      const reason = refuseHitlAttachment(file, next.length);
      if (reason) {
        refusal = refusal ?? reason;
        continue;
      }
      attachmentKey.current += 1;
      next.push({
        key: `photo-${attachmentKey.current}`,
        file,
        previewUrl: file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined,
      });
    }
    setAttachments(next);
    setAttachNotice(refusal);
  }

  function removeAttachment(key: string) {
    setAttachments((current) => {
      const removed = current.find((item) => item.key === key);
      if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
      return current.filter((item) => item.key !== key);
    });
    setAttachNotice(null);
  }

  function clearAttachments() {
    for (const item of attachmentsRef.current) if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    setAttachments([]);
    setAttachNotice(null);
  }

  /**
   * Upload every photo that is not uploaded yet. A photo that already has a
   * reference (an earlier send failed after its upload) is not sent twice.
   * Throws the first failure with the message to show.
   */
  async function uploadPending(): Promise<HitlAnswerAttachment[]> {
    const uploaded: HitlAnswerAttachment[] = [];
    for (const item of attachmentsRef.current) {
      if (item.uploaded) {
        uploaded.push(item.uploaded);
        continue;
      }
      const reference = await uploadHitlAttachment(item.file);
      setAttachments((current) => current.map((entry) => (entry.key === item.key ? { ...entry, uploaded: reference } : entry)));
      uploaded.push(reference);
    }
    return uploaded;
  }

  async function submit(choice?: string) {
    const freeText = reply.trim();
    let photos: HitlAnswerAttachment[] = [];
    if (attachmentsRef.current.length > 0) {
      setUploading(true);
      setAttachNotice(null);
      try {
        photos = await uploadPending();
      } catch (error) {
        setAttachNotice(error instanceof Error ? error.message : "The photo could not be uploaded. Your answer and photo are still here; try again.");
        return;
      } finally {
        setUploading(false);
      }
    }
    try {
      await onResolve(request.id, {
        choice,
        freeText: freeText.length > 0 ? freeText : undefined,
        ...(photos.length > 0 ? { payload: { attachments: photos } } : {}),
      });
    } catch (error) {
      // The inbox shows the failure too; say it on the card so the answer
      // is visibly unsent rather than silently kept.
      const reason = error instanceof Error ? error.message : "the request failed";
      setAttachNotice(`Your answer was not sent (${reason}). It is still here; try again.`);
      return;
    }
    setReply("");
    clearAttachments();
  }

  // Park sends a deliberately EMPTY resolution: never the draft text or photos.
  async function park() {
    await onResolve(request.id, {});
    setReply("");
    clearAttachments();
  }

  if (action.state !== 'pending') return <AlertAction action={action} inline />;
  return (
    <article className="relative overflow-hidden rounded-lg border border-slate-800 bg-slate-900/60">
      <div className={`absolute inset-y-0 left-0 w-0.5 ${tone.rail}`} />
      <div className="p-3.5 pl-4">
        {/* chips row */}
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          <span
            className={`rounded-full px-2 py-0.5 text-[length:var(--hitl-fs-11,0.6875rem)] font-medium ${tone.chip}`}
          >
            {reasonLabel}
          </span>
          {meta.executor ? (
            <span className="rounded-full bg-slate-800 px-2 py-0.5 font-mono text-[length:var(--hitl-fs-10,0.625rem)] text-slate-300">
              {meta.executor}
            </span>
          ) : null}
          {request.confidenceScore !== undefined ? (
            <span className="text-[length:var(--hitl-fs-11,0.6875rem)] text-slate-400">
              {request.confidenceScore}% confidence
            </span>
          ) : null}
          <span className="ml-auto font-mono text-[length:var(--hitl-fs-10,0.625rem)] text-slate-500">
            {timeAgo(request.requestedAt)}
          </span>
        </div>

        {/* task identity */}
        {request.taskId ? (
          <Link
            href={`/task/${encodeURIComponent(request.taskId)}`}
            title={`Open task ${request.taskId}`}
            className="mb-2 flex items-center gap-1.5 text-[length:var(--hitl-fs-xs,0.75rem)] text-cyan-300 transition hover:text-cyan-200"
          >
            <ChevronRight className="h-3 w-3 shrink-0" />
            <span className="truncate font-semibold">{meta.taskTitle ?? request.taskId}</span>
            {meta.projectName ? (
              <span className="shrink-0 rounded-full bg-slate-800 px-1.5 py-0.5 text-[length:var(--hitl-fs-10,0.625rem)] text-slate-400">
                {meta.projectName}
              </span>
            ) : null}
          </Link>
        ) : null}

        {/* kind-specific guidance (acknowledging repairs nothing, a saved
            answer awaits delivery); ordinary questions show none */}
        {action.guidance ? (
          <p className="mb-2 text-[length:var(--hitl-fs-xs,0.75rem)] leading-relaxed text-amber-200/90" data-hitl-guidance="">
            {action.guidance}
          </p>
        ) : null}
        {action.relatedLinks?.map(link => (
          <Link key={link.href} href={link.href} className="mb-2 block text-[length:var(--hitl-fs-xs,0.75rem)] text-cyan-300 underline">{link.label} →</Link>
        ))}

        {/* the brief first, when there is one */}
        {brief ? (
          <div className="mb-3">
            <HumanBriefBlock brief={brief} />
          </div>
        ) : null}

        {/* the numbered questions an ask_robert card carries */}
        {brief && questions.length > 0 ? (
          <ol className="mb-3 list-decimal space-y-1.5 pl-5 text-[length:var(--hitl-fs-sm,0.875rem)] leading-relaxed text-slate-100" data-brief-questions="">
            {questions.map((q, i) => <li key={i}>{q}</li>)}
          </ol>
        ) : null}

        {/* the question — pre-wrap so multi-paragraph questions (red alerts,
            EOD summaries) keep their structure instead of welding into one
            line (2026-08-30: the inbox item is the informed-decision surface) */}
        {showQuestionText && !foldQuestion ? (
          <div className="mb-3 text-[length:var(--hitl-fs-sm,0.875rem)] leading-relaxed text-slate-100">
            <SafeAlertMarkdown>{request.question}</SafeAlertMarkdown>
          </div>
        ) : null}
        {showQuestionText && foldQuestion ? (
          <details className="mb-3 rounded-md border border-slate-800 bg-slate-950/70" data-brief-details="question">
            <summary className="cursor-pointer px-2.5 py-1.5 text-[length:var(--hitl-fs-11,0.6875rem)] uppercase tracking-wider text-slate-500 transition hover:text-slate-300">
              Full question
            </summary>
            <div className="px-2.5 pb-2.5 text-[length:var(--hitl-fs-sm,0.875rem)] leading-relaxed text-slate-200">
              <SafeAlertMarkdown>{request.question}</SafeAlertMarkdown>
            </div>
          </details>
        ) : null}

        {/* the sender's full message, kept under the brief */}
        {brief && details ? (
          <details className="mb-3 rounded-md border border-slate-800 bg-slate-950/70" data-brief-details="message">
            <summary className="cursor-pointer px-2.5 py-1.5 text-[length:var(--hitl-fs-11,0.6875rem)] uppercase tracking-wider text-slate-500 transition hover:text-slate-300">
              Full message
            </summary>
            <div className="px-2.5 pb-2.5 text-[length:var(--hitl-fs-xs,0.75rem)] leading-relaxed text-slate-300">
              <SafeAlertMarkdown>{details}</SafeAlertMarkdown>
            </div>
          </details>
        ) : null}

        {/* full plan / detail block, when the producer shipped one on the item
            (e.g. the EOD commit card's per-workspace survey). This is the rest
            of the informed-decision picture, so it defaults hidden but is one
            tap away. */}
        {typeof request.metadata?.planCard === "string" && request.metadata.planCard ? (
          <details className="mb-3 rounded-md border border-slate-800 bg-slate-950/70">
            <summary className="cursor-pointer px-2.5 py-1.5 text-[length:var(--hitl-fs-11,0.6875rem)] uppercase tracking-wider text-slate-500 transition hover:text-slate-300">
              Full plan
            </summary>
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap px-2.5 pb-2.5 font-mono text-[length:var(--hitl-fs-11,0.6875rem)] leading-relaxed text-slate-300">
              {request.metadata.planCard}
            </pre>
          </details>
        ) : null}

        {/* agent context accordion */}
        {hasContext ? (
          <div className="mb-3">
            <button
              onClick={() => setShowContext((v) => !v)}
              className="flex items-center gap-1 text-[length:var(--hitl-fs-11,0.6875rem)] uppercase tracking-wider text-slate-500 transition hover:text-slate-300"
            >
              {showContext ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronRight className="h-3 w-3" />
              )}
              Agent context
            </button>
            {showContext ? (
              <div className="mt-1.5 space-y-2 rounded-md border border-slate-800 bg-slate-950/70 p-2.5">
                {resume.context && resume.context !== request.question ? (
                  <p className="whitespace-pre-wrap text-[length:var(--hitl-fs-xs,0.75rem)] leading-relaxed text-slate-300">
                    {resume.context}
                  </p>
                ) : null}
                {resume.tail ? (
                  <pre className="max-h-52 overflow-auto rounded bg-slate-950 p-2 font-mono text-[length:var(--hitl-fs-10,0.625rem)] leading-relaxed text-slate-500">
                    {resume.tail}
                  </pre>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}

        {/* option quick-chips */}
        {request.options && request.options.length > 0 ? (
          <div className="mb-3 flex flex-wrap gap-2">
            {request.options.map((option) => (
              <button
                key={option}
                disabled={resolving}
                onClick={() => void submit(option)}
                className="rounded-md border border-cyan-500/40 px-2.5 py-1 text-[length:var(--hitl-fs-xs,0.75rem)] text-cyan-200 transition hover:border-cyan-300 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {option}
              </button>
            ))}
          </div>
        ) : null}

        {/* reply */}
        <textarea
          value={reply}
          onChange={(event) => setReply(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && reply.trim()) {
              event.preventDefault();
              void submit();
            }
          }}
          placeholder="Type your answer… (⌘⏎ to send)"
          className="mb-2 min-h-20 w-full resize-y rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-[length:var(--hitl-fs-sm,0.875rem)] text-slate-100 outline-none transition placeholder:text-slate-600 focus:border-cyan-500"
        />

        {/* photos picked for this answer: thumbnail, name, size, remove */}
        {attachments.length > 0 ? (
          <ul className="mb-2 flex flex-wrap gap-2" data-hitl-attachments="">
            {attachments.map((item) => (
              <li
                key={item.key}
                data-hitl-attachment={item.file.name}
                className="flex max-w-full items-center gap-2 rounded-md border border-slate-700 bg-slate-950 p-1.5 pr-1"
              >
                {item.previewUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element -- object URL preview of a local file
                  <img src={item.previewUrl} alt="" className="h-12 w-12 shrink-0 rounded object-cover" />
                ) : (
                  <span className="grid h-12 w-12 shrink-0 place-items-center rounded bg-slate-800 text-slate-500">
                    <ImagePlus className="h-4 w-4" />
                  </span>
                )}
                <span className="min-w-0">
                  <span className="block max-w-40 truncate text-[length:var(--hitl-fs-xs,0.75rem)] text-slate-200">{item.file.name}</span>
                  <span className="block font-mono text-[length:var(--hitl-fs-10,0.625rem)] text-slate-500">
                    {formatBytes(item.file.size)}
                    {item.uploaded ? " · uploaded" : ""}
                  </span>
                </span>
                <button
                  type="button"
                  aria-label={`Remove ${item.file.name}`}
                  title="Remove this photo"
                  disabled={resolving || uploading}
                  onClick={() => removeAttachment(item.key)}
                  className="grid h-9 w-9 shrink-0 place-items-center rounded-md text-slate-400 transition hover:bg-slate-800 hover:text-rose-300 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {attachNotice ? (
          <p
            role="alert"
            data-hitl-attach-error=""
            className="mb-2 rounded-md border border-rose-500/30 bg-rose-500/10 px-2.5 py-1.5 text-[length:var(--hitl-fs-xs,0.75rem)] leading-relaxed text-rose-200"
          >
            {attachNotice}
          </p>
        ) : null}

        <div className="flex gap-2">
          <button
            disabled={resolving || uploading || (reply.trim().length === 0 && attachments.length === 0)}
            onClick={() => void submit()}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-md bg-cyan-500 px-3 py-2 text-[length:var(--hitl-fs-xs,0.75rem)] font-bold text-slate-950 transition hover:bg-cyan-400 disabled:cursor-not-allowed disabled:bg-slate-800 disabled:text-slate-500"
          >
            {resolving || uploading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Send className="h-3.5 w-3.5" />
            )}
            {uploading ? "Uploading photo…" : resolving ? "Sending…" : "Send Answer"}
          </button>
          <button
            type="button"
            disabled={resolving || uploading || attachments.length >= HITL_ATTACHMENT_MAX_COUNT}
            onClick={() => fileInputRef.current?.click()}
            title="Attach a photo or screenshot to this answer"
            aria-label="Add a photo"
            data-hitl-attach-button=""
            className="flex items-center gap-1.5 rounded-md border border-slate-700 px-3 py-2 text-[length:var(--hitl-fs-xs,0.75rem)] text-slate-400 transition hover:border-cyan-500 hover:text-cyan-200 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <ImagePlus className="h-3.5 w-3.5" />
            Photo
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,.heic,.heif"
            multiple
            className="hidden"
            data-hitl-attach-input=""
            onChange={(event) => {
              addFiles(event.target.files);
              event.target.value = "";
            }}
          />
          {canPark ? (
            <button
              disabled={resolving}
              onClick={() => void park()}
              title="Close the question without answering — the task stays parked and nothing is re-dispatched"
              className="flex items-center gap-1.5 rounded-md border border-slate-700 px-3 py-2 text-[length:var(--hitl-fs-xs,0.75rem)] text-slate-400 transition hover:border-slate-500 hover:text-slate-200 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Archive className="h-3.5 w-3.5" />
              Park
            </button>
          ) : null}
        </div>
      </div>
    </article>
  );
}

"use client";
import Link from "next/link";
import type { DocumentResponse } from "@/lib/document-review";

/** Mail decisions have one home; document review remains editorial feedback. */
export function OutgoingCard({
  data,
}: {
  data: DocumentResponse;
  viewingCurrent: boolean;
  onRefresh: () => Promise<void> | void;
  pollMs?: number;
}) {
  const outgoing = data.outgoing;
  if (!outgoing) return null;
  return (
    <section
      aria-label="Outgoing message"
      data-outgoing-card={outgoing.status}
      className="mb-4 rounded-lg border border-cyan-700/70 bg-slate-900/60 p-4 text-sm"
    >
      <h2 className="font-semibold text-cyan-100">
        {outgoing.envelope.subject}
      </h2>
      <p className="mt-2 text-slate-400">
        To {outgoing.envelope.to} · {outgoing.status}
      </p>
      <p className="mt-2 text-slate-300">
        Review, edit, approve, return, or cancel this message in Praxis Mail.
      </p>
      <Link
        className="mt-3 inline-block rounded border border-cyan-500/50 px-3 py-2 text-cyan-200"
        href={
          outgoing.status === "sent"
            ? "/mail?folder=sent"
            : `/mail?draft=${encodeURIComponent(data.document.id)}${outgoing.status === "cancelled" ? "&folder=cancelled" : ""}`
        }
      >
        Open in Praxis Mail
      </Link>
    </section>
  );
}

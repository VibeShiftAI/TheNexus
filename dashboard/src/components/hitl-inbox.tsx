"use client";

import Link from "next/link";
import { AlertCircle, CheckCircle2, Loader2, Maximize2 } from "lucide-react";
import { useHitlInbox } from "@/hooks/use-hitl-inbox";
import { HitlCard } from "./hitl-card";
import { FontScaleControl, inboxFontScaleStyle, useInboxFontScale } from "./inbox-font-scale";

export function HitlInbox() {
  const { error, loading, pendingRequests, resolvingId, resolveRequest } = useHitlInbox();
  const { scale: fontScale, adjust: adjustFontScale } = useInboxFontScale();

  if (loading) {
    return (
      <section className="rounded-lg border border-slate-800 bg-slate-900/50 p-4 text-sm text-slate-400">
        <div className="flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin text-cyan-400" />
          <span>Checking for input requests</span>
        </div>
      </section>
    );
  }

  return (
    <section
      className="rounded-lg border border-slate-800 bg-slate-900/50 p-4"
      style={inboxFontScaleStyle(fontScale)}
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          {pendingRequests.length > 0 ? (
            <AlertCircle className="h-4 w-4 text-amber-400" />
          ) : (
            <CheckCircle2 className="h-4 w-4 text-emerald-400" />
          )}
          <h3 className="text-sm font-bold text-white">Praxis Inbox</h3>
        </div>
        <div className="flex items-center gap-2">
          <FontScaleControl scale={fontScale} onAdjust={adjustFontScale} />
          <span className="rounded-full border border-slate-700 px-2 py-0.5 text-xs text-slate-300">
            {pendingRequests.length}
          </span>
          <Link
            href="/inbox"
            title="Open the full inbox"
            aria-label="Open the full inbox"
            className="rounded-md border border-slate-700 p-1 text-slate-400 transition hover:border-cyan-500 hover:text-cyan-300"
          >
            <Maximize2 className="h-3.5 w-3.5" />
          </Link>
        </div>
      </div>

      {error ? (
        <p className="mb-3 text-[length:var(--hitl-fs-xs,0.75rem)] text-rose-300">{error}</p>
      ) : null}

      {pendingRequests.length === 0 ? (
        <p className="text-[length:var(--hitl-fs-xs,0.75rem)] text-slate-400">
          No input needed right now.
        </p>
      ) : (
        <div className="space-y-3">
          {pendingRequests.map((request) => (
            <HitlCard
              key={request.id}
              request={request}
              resolving={resolvingId === request.id}
              onResolve={resolveRequest}
            />
          ))}
        </div>
      )}
    </section>
  );
}

"use client";

import Link from "next/link";
import { AlertCircle, CheckCircle2, Loader2, Maximize2 } from "lucide-react";
import { useArrivalPulse } from "@/hooks/use-arrival-pulse";
import { useHitlInbox } from "@/hooks/use-hitl-inbox";
import { HitlCard } from "./hitl-card";
import { FontScaleControl, inboxFontScaleStyle, useInboxFontScale } from "./inbox-font-scale";

export function HitlInbox() {
  const { error, loading, pendingRequests, resolvingId, resolveRequest } = useHitlInbox();
  const arrivals = useArrivalPulse(pendingRequests.map(r => r.id), !loading);
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
      className={`rounded-lg border border-slate-800 bg-slate-900/50 p-4 transition-[border-color,box-shadow] ${pendingRequests.length > 0 ? "module-live" : ""}`}
      style={inboxFontScaleStyle(fontScale)}
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          {pendingRequests.length > 0 ? (
            <span className="relative grid place-items-center"><span aria-hidden="true" className="absolute -inset-2 rounded-full border border-amber-400/20 bg-amber-400/5"/><AlertCircle className="h-4 w-4 text-amber-400" /></span>
          ) : (
            <CheckCircle2 className="h-4 w-4 text-emerald-400" />
          )}
          <h3 className="text-sm font-bold text-white">Praxis Inbox</h3>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <FontScaleControl scale={fontScale} onAdjust={adjustFontScale} />
          <span className="rounded-full border border-slate-700 px-2 py-0.5 text-xs text-slate-300">
            {pendingRequests.length}
          </span>
          <Link
            href="/inbox"
            title="Open the full inbox"
            aria-label="Open the full inbox"
            className="shrink-0 rounded-md border border-slate-700 p-1 text-slate-400 transition hover:border-cyan-500 hover:text-cyan-300"
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
            <div key={request.id} className={arrivals.has(request.id) ? "module-new rounded-lg" : ""}><HitlCard
              request={request}
              resolving={resolvingId === request.id}
              onResolve={resolveRequest}
            /></div>
          ))}
        </div>
      )}
    </section>
  );
}

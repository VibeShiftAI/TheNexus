"use client";
import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { vaultDocumentParts, vaultDocumentLink } from "@/lib/vault-document";
import {
  CHANNELS,
  type ActivityChannel,
  type ActivityItem,
} from "@/lib/bridge-activity";
import {
  ActivityMonitor,
  ActivityList,
  ActivityDetails,
} from "@/components/bridge/activity-monitor";

function ActivityReport() {
  const params = useSearchParams();
  const initial = params.get("channel");
  const [channel, setChannel] = useState<ActivityChannel | "all">(
    CHANNELS.some((c) => c.id === initial)
      ? (initial as ActivityChannel)
      : "all",
  );
  const [detail, setDetail] = useState<ActivityItem | null>(null);
  useEffect(() => {
    setChannel(
      CHANNELS.some((c) => c.id === initial)
        ? (initial as ActivityChannel)
        : "all",
    );
    setDetail(null);
  }, [initial]);
  const path = params.get("document");
  const [document, setDocument] = useState<{
    content: string;
    at: string;
  } | null>(null);
  const [error, setError] = useState("");
  const parts = vaultDocumentParts(document?.content ?? "");
  useEffect(() => {
    const controller = new AbortController();
    setDocument(null);
    setError("");
    if (path)
      void (async () => {
        try {
          const res = await fetch(
            `/api/knowledge-activity/document?path=${encodeURIComponent(path)}`,
            { signal: controller.signal },
          );
          if (!res.ok)
            throw new Error(
              "This document is unavailable or exceeds the viewer limit.",
            );
          const data = await res.json();
          if (!controller.signal.aborted) setDocument(data);
        } catch (e) {
          if (!controller.signal.aborted)
            setError(e instanceof Error ? e.message : "Document unavailable");
        }
      })();
    return () => controller.abort();
  }, [path]);
  return (
    <main className="min-h-screen bg-slate-950 hud-backdrop px-4 py-6 text-slate-200 sm:px-8">
      <div className="mx-auto max-w-6xl space-y-5">
        <Link href="/" className="text-sm text-cyan-300 hover:text-white">
          ← Nexus bridge
        </Link>
        <div>
          <h1 className="text-2xl font-bold text-white">
            {path ? "Vault document" : "Activity report"}
          </h1>
          <p className="mt-1 break-words text-sm text-slate-400">
            {path ??
              "Follow system activity into its source, task, and evidence."}
          </p>
        </div>
        {path ? (
          <section className="rounded-xl border border-slate-700 bg-slate-900/60 p-5">
            {error ? (
              <p role="alert" className="text-amber-300">
                {error}
              </p>
            ) : !document ? (
              <p>Loading document…</p>
            ) : (
              <>
                <p className="mb-6 text-xs text-slate-400">
                  Current document · last modified{" "}
                  {new Date(document.at).toLocaleString()}
                </p>
                <div className="prose prose-invert max-w-none break-words prose-pre:overflow-x-auto">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                      a: ({ href, children }) => (
                        <a href={vaultDocumentLink(href ?? "", path)}>
                          {children}
                        </a>
                      ),
                    }}
                  >
                    {parts.body}
                  </ReactMarkdown>
                </div>
                {parts.metadata && (
                  <details className="mt-6 border-t border-slate-700 pt-4">
                    <summary className="cursor-pointer text-sm text-slate-400">
                      Document metadata
                    </summary>
                    <pre className="mt-3 whitespace-pre-wrap break-words text-xs text-slate-400">
                      {parts.metadata}
                    </pre>
                  </details>
                )}
              </>
            )}
            <Link
              href="/activity?channel=vault"
              className="mt-6 block text-sm text-cyan-300"
            >
              ← Vault activity
            </Link>
          </section>
        ) : (
          <>
            <ActivityMonitor />
            <p className="text-xs leading-relaxed text-slate-400">
              Recent stream events and executor snapshots; MCP calls from the
              last 24 hours; latest vault modification per document. This is a
              bounded activity view. Task pages retain the full execution and QA
              reports.
            </p>
            <div className="flex flex-wrap gap-2" aria-label="Activity filters">
              {[{ id: "all", label: "All activity" }, ...CHANNELS].map((c) => (
                <button
                  key={c.id}
                  type="button"
                  aria-pressed={channel === c.id}
                  onClick={() => {
                    setChannel(c.id as ActivityChannel | "all");
                    setDetail(null);
                  }}
                  className={`rounded-full border px-3 py-1.5 text-xs ${channel === c.id ? "border-cyan-300/50 bg-cyan-300/10 text-cyan-100" : "border-slate-700 text-slate-400 hover:text-white"}`}
                >
                  {c.label}
                </button>
              ))}
            </div>
            <div className="grid items-start gap-5 lg:grid-cols-2">
              <ActivityList channel={channel} onSelect={setDetail} />
              <section className="rounded-xl border border-slate-700 bg-slate-900/60 p-5 lg:sticky lg:top-6">
                {detail ? (
                  <ActivityDetails item={detail} />
                ) : (
                  <p className="text-sm text-slate-400">
                    Select an event to inspect its details and open the full
                    source report.
                  </p>
                )}
              </section>
            </div>
          </>
        )}
      </div>
    </main>
  );
}
export default function Page() {
  return (
    <Suspense fallback={<p className="p-8">Loading activity…</p>}>
      <ActivityReport />
    </Suspense>
  );
}

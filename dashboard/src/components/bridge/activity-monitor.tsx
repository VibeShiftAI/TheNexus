"use client";
import { useState, type CSSProperties } from "react";
import Link from "next/link";
import {
  Activity,
  ArrowUpRight,
  BrainCircuit,
  CheckCheck,
  FilePenLine,
  Radio,
  Rocket,
  ShieldCheck,
} from "lucide-react";
import {
  CHANNELS,
  type ActivityChannel,
  type ActivityItem,
} from "@/lib/bridge-activity";
import { useBridgeActivity } from "./activity-provider";
import { HudModal } from "./hud";

const ICONS = {
  memory: BrainCircuit,
  vault: FilePenLine,
  dispatch: Rocket,
  working: Activity,
  qa: ShieldCheck,
  completed: CheckCheck,
};
function ago(at: string, now: number) {
  const age = Math.max(0, Math.floor((now - Date.parse(at)) / 1000));
  return age < 10
    ? "just now"
    : age < 60
      ? `${age}s ago`
      : age < 3600
        ? `${Math.floor(age / 60)}m ago`
        : age < 86400
          ? `${Math.floor(age / 3600)}h ago`
          : `${Math.floor(age / 86400)}d ago`;
}
export function ActivityDetails({ item }: { item: ActivityItem }) {
  return (
    <article className="space-y-4 text-sm">
      <div>
        <p className="mb-1 text-xs uppercase tracking-wider text-cyan-300">
          {item.source}
        </p>
        <h3 className="break-words text-lg font-semibold text-white">
          {item.title}
        </h3>
      </div>
      <dl className="grid gap-3 rounded-lg border border-slate-800 bg-slate-900/60 p-3 sm:grid-cols-2">
        <div>
          <dt className="text-xs text-slate-400">Recorded</dt>
          <dd>{new Date(item.at).toLocaleString()}</dd>
        </div>
        <div>
          <dt className="text-xs text-slate-400">Event result</dt>
          <dd
            className={
              item.status === "failed" ? "text-rose-300" : "text-slate-200"
            }
          >
            {item.status === "active" ? "Progress reported" : item.status}
          </dd>
        </div>
      </dl>
      <p className="whitespace-pre-wrap break-words leading-relaxed text-slate-300">
        {item.detail}
      </p>
      {item.channel === "qa" && (
        <p className="text-xs leading-relaxed text-amber-200">
          This records the review run. The task’s QA report contains the verdict
          and supporting evidence.
        </p>
      )}
      {item.href && (
        <Link
          href={item.href}
          className="inline-flex items-center gap-2 rounded-lg border border-cyan-400/30 bg-cyan-400/10 px-3 py-2 font-medium text-cyan-200 hover:bg-cyan-400/20"
        >
          {item.path
            ? "Open full vault document"
            : item.taskId
              ? "Open task and full report"
              : item.href === "/ops"
                ? "Open operations console"
                : "Open knowledge console"}{" "}
          <ArrowUpRight size={16} />
        </Link>
      )}
    </article>
  );
}
export function ActivityList({
  channel = "all",
  onSelect,
  limit = 80,
}: {
  channel?: ActivityChannel | "all";
  onSelect: (item: ActivityItem) => void;
  limit?: number;
}) {
  const { items, now } = useBridgeActivity();
  const filtered = items
    .filter((e) => channel === "all" || e.channel === channel)
    .slice(0, limit);
  return filtered.length === 0 ? (
    <div className="rounded-lg border border-dashed border-slate-700 px-4 py-8 text-center text-sm text-slate-400">
      No recorded activity in this view yet. New signals appear here as they
      arrive.
    </div>
  ) : (
    <div className="space-y-2">
      {filtered.map((item) => {
        const info = CHANNELS.find((c) => c.id === item.channel)!;
        const Icon = ICONS[item.channel];
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => onSelect(item)}
            className="group flex w-full items-start gap-3 rounded-lg border border-slate-800 bg-slate-900/50 p-3 text-left transition hover:border-slate-500 focus-visible:outline-2 focus-visible:outline-cyan-300"
          >
            <Icon
              size={17}
              className="mt-0.5 shrink-0"
              style={{
                color: item.status === "failed" ? "#fb7185" : info.color,
              }}
            />
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-sm font-medium text-slate-100">
                  {item.title}
                </span>
                <time className="text-xs text-slate-400" dateTime={item.at}>
                  {ago(item.at, now)}
                </time>
              </span>
              <span className="mt-1 block truncate text-xs text-slate-400">
                {item.detail}
              </span>
            </span>
            <ArrowUpRight
              size={14}
              className="mt-1 shrink-0 text-slate-500 group-hover:text-cyan-200"
            />
          </button>
        );
      })}
    </div>
  );
}
export function ActivityMonitor({
  only,
  compact = false,
}: {
  only?: ActivityChannel[];
  compact?: boolean;
}) {
  const { channels, now } = useBridgeActivity();
  const [selected, setSelected] = useState<ActivityChannel | null>(null);
  const [detail, setDetail] = useState<ActivityItem | null>(null);
  const visible = channels.filter((c) => !only || only.includes(c.id));
  return (
    <section
      aria-label="Live system activity"
      className={
        compact
          ? ""
          : "rounded-xl border border-slate-700/70 bg-slate-950/70 p-3"
      }
    >
      {!compact && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-slate-300">
            <Radio size={14} className="text-cyan-300" /> Activity circuits
          </h3>
          <Link
            href="/activity"
            className="flex items-center gap-1 text-xs text-cyan-300 hover:text-white"
          >
            Full activity report <ArrowUpRight size={13} />
          </Link>
        </div>
      )}
      <div
        className={`grid gap-2 ${compact ? "grid-cols-2" : "grid-cols-2 sm:grid-cols-3 2xl:grid-cols-6"}`}
      >
        {visible.map((c) => {
          const info = CHANNELS.find((i) => i.id === c.id)!;
          const Icon = ICONS[c.id];
          return (
            <button
              type="button"
              key={c.id}
              onClick={() => {
                setSelected(c.id);
                setDetail(null);
              }}
              aria-label={`Inspect ${info.label} activity`}
              className={`activity-circuit group relative flex min-w-0 items-center gap-2 overflow-hidden rounded-lg border p-2.5 text-left transition focus-visible:outline-2 focus-visible:outline-cyan-200 ${c.hot ? "is-active" : "border-slate-800 bg-slate-900/40 hover:border-slate-500"}`}
              style={{ "--circuit-color": info.color } as CSSProperties}
            >
              <span
                className="activity-orbit relative grid h-9 w-9 shrink-0 place-items-center rounded-full border border-current"
                style={{ color: c.available ? info.color : "#64748b" }}
                aria-hidden="true"
              >
                <span className="activity-marker absolute inset-0 rounded-full">
                  <i className="absolute -top-0.5 left-1/2 h-1.5 w-1.5 rounded-full bg-current" />
                </span>
                <Icon size={15} />
              </span>
              <span className="min-w-0">
                <span className="block text-xs font-semibold text-slate-100">
                  {info.label}
                </span>
                <span
                  className={`block text-xs ${c.hot ? "text-slate-100" : "text-slate-400"}`}
                >
                  {!c.available
                    ? "Signal unavailable"
                    : c.active > 0
                      ? `${c.active} active`
                      : c.latest?.status === "failed" && c.recent > 0
                        ? "Last attempt failed"
                        : c.recent > 0
                          ? `${c.recent} in 5 min`
                          : "Quiet"}
                </span>
                <span
                  className="mt-0.5 block truncate text-[0.625rem] text-slate-500"
                  title={c.latest?.detail}
                >
                  {c.latest ? ago(c.latest.at, now) : "Awaiting events"}
                </span>
              </span>
            </button>
          );
        })}
      </div>
      {selected && (
        <HudModal
          title={
            detail
              ? "Activity detail"
              : `${CHANNELS.find((c) => c.id === selected)!.label} activity`
          }
          subtitle={CHANNELS.find((c) => c.id === selected)!.description}
          icon={<Activity size={16} />}
          onClose={() => {
            setSelected(null);
            setDetail(null);
          }}
          wide
        >
          {detail ? (
            <>
              <button
                className="mb-4 text-xs text-cyan-300 hover:text-white"
                onClick={() => setDetail(null)}
              >
                ← Back to activity
              </button>
              <ActivityDetails item={detail} />
            </>
          ) : (
            <>
              <p className="mb-3 text-xs leading-relaxed text-slate-400">
                {CHANNELS.find((c) => c.id === selected)!.description}
              </p>
              <ActivityList channel={selected} onSelect={setDetail} />
              <Link
                href={`/activity?channel=${selected}`}
                className="mt-4 inline-flex items-center gap-1 text-sm text-cyan-300"
              >
                Open full activity report <ArrowUpRight size={14} />
              </Link>
            </>
          )}
        </HudModal>
      )}
    </section>
  );
}

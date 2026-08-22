/**
 * ProjectComms — the Communication station on a project page: how Praxis
 * keeps the project's Primary Decision Makers (PDMs) in the loop.
 *
 *  1. Status reports — the project's `comms_settings`: master switch (auto =
 *     follows PDMs), review-first vs auto-send, the activity trigger (a report
 *     after a quiet hour following incoming requests), the weekly schedule and
 *     the recipient list; plus "Preview report" / "Generate & send now".
 *  2. Report history — what Praxis generated/sent, with preview + hosted links
 *     and a Send button for reports waiting in review.
 *  3. Review meetings — `stakeholder_meeting` calendar events (one-off or a
 *     weekly/biweekly/monthly series) with member attendees.
 *  4. Branded template — the project's `report_template` (brand, tone,
 *     sections, intro/footer); Praxis creates it on the first report and the
 *     operator can tune it here.
 *
 * Settings and template are JSON columns on the project; every Save PATCHes
 * the whole object (like `needs`) and reloads the project through `onUpdate`.
 * Every remote call degrades to an amber line — the panel never crashes when
 * the server or Praxis routes are not there yet.
 */
"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  CalendarClock,
  ChevronDown,
  ChevronUp,
  Crown,
  ExternalLink,
  FileText,
  History,
  Megaphone,
  Palette,
  Plus,
  RefreshCw,
  Send,
  Trash2,
  X,
} from "lucide-react";
import { commsEffectivelyActive, hasReportTemplate, parseCommsSettings } from "@praxis/contract";
import { HudPanel } from "@/components/bridge/hud";
import { toDatetimeLocalValue } from "@/lib/calendar";
import {
  createMeetingSeries,
  deleteCalendarEvent,
  deleteMeetingSeries,
  generateStakeholderReport,
  getProjectContacts,
  getProjectMeetings,
  listStakeholderReports,
  sendStakeholderReport,
  stakeholderReportPreviewUrl,
  updateProject,
  type MeetingEvent,
  type MeetingRecurrence,
  type Project,
  type ProjectCommsSettings,
  type ProjectContact,
  type ReportTemplate,
  type StakeholderReport,
} from "@/lib/nexus";

// ─── Shared bits ────────────────────────────────────────────────────────────

const BTN = {
  teal: "rounded border border-teal-500/40 bg-teal-500/10 px-2 py-0.5 text-[11px] font-bold text-teal-300 transition-colors hover:bg-teal-500/20 disabled:opacity-50",
  slate: "rounded border border-slate-700 bg-slate-800/60 px-2 py-0.5 text-[11px] font-bold text-slate-300 transition-colors hover:text-white disabled:opacity-50",
  red: "rounded border border-red-500/30 bg-red-500/10 px-2 py-0.5 text-[11px] font-bold text-red-300 transition-colors hover:bg-red-500/20 disabled:opacity-50",
} as const;

const SAVE_BTN =
  "rounded border border-teal-500/40 bg-teal-500/20 px-3 py-1 text-[12px] font-bold text-teal-300 transition-colors hover:bg-teal-500/30 disabled:opacity-50";

type Notice = { kind: "ok" | "err"; text: string; href?: string | null };

function NoticeLine({ notice }: { notice: Notice | null }) {
  if (!notice) return null;
  return (
    <p className={`text-[11px] ${notice.kind === "err" ? "text-amber-400" : "text-emerald-300"}`}>
      {notice.text}
      {notice.href ? (
        <>
          {" "}
          <a
            href={notice.href}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-0.5 text-cyan-400 hover:underline"
          >
            Open preview <ExternalLink size={10} />
          </a>
        </>
      ) : null}
    </p>
  );
}

function errText(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

function Field({ label, children, className = "" }: { label: string; children: ReactNode; className?: string }) {
  return (
    <label className={`block ${className}`}>
      <span className="mb-0.5 block text-[10px] uppercase tracking-widest text-slate-500">{label}</span>
      {children}
    </label>
  );
}

function Check({
  checked,
  onChange,
  children,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <label className="flex items-start gap-2 text-[11px] text-slate-400">
      <input type="checkbox" className="mt-0.5" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>{children}</span>
    </label>
  );
}

/** Collapsible sub-station inside the Communication panel. */
function Section({
  icon,
  title,
  hint,
  right,
  defaultOpen = true,
  children,
}: {
  icon: ReactNode;
  title: string;
  hint?: ReactNode;
  right?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950/40">
      <div className="flex items-center gap-2 px-3 py-2">
        <button onClick={() => setOpen((o) => !o)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          <span className="shrink-0 text-teal-400">{icon}</span>
          <span className="shrink-0 text-[12px] font-bold uppercase tracking-wider text-slate-200">{title}</span>
          {hint ? <span className="min-w-0 truncate text-[11px] text-slate-500">{hint}</span> : null}
          <span className="ml-auto shrink-0 text-slate-500">{open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</span>
        </button>
        {right ? <div className="flex shrink-0 items-center gap-1.5">{right}</div> : null}
      </div>
      {open && <div className="border-t border-slate-800 px-3 py-3">{children}</div>}
    </div>
  );
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const HOURS = Array.from({ length: 24 }, (_, h) => h);
const hourLabel = (h: number) => `${String(h).padStart(2, "0")}:00`;

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
function fmtShort(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}
function parseCsv(raw: string): string[] {
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}
function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

// ─── Panel ──────────────────────────────────────────────────────────────────

export function ProjectComms({
  project,
  onUpdate,
  refreshKey = 0,
}: {
  project: Project;
  /** Reload the project (comms_settings / report_template changed). */
  onUpdate: () => void;
  /** Bump to re-read the member list (e.g. after a PDM was flagged in the Members panel). */
  refreshKey?: number;
}) {
  const [members, setMembers] = useState<ProjectContact[]>([]);
  const [membersNote, setMembersNote] = useState<string | null>(null);
  const [historyToken, setHistoryToken] = useState(0);
  const onUpdateRef = useRef(onUpdate);
  useEffect(() => {
    onUpdateRef.current = onUpdate;
  }, [onUpdate]);

  const loadMembers = useCallback(async () => {
    try {
      setMembers(await getProjectContacts(project.id));
      setMembersNote(null);
    } catch {
      setMembers([]);
      setMembersNote("Members unavailable — recipient and attendee pickers stay empty until the contacts API answers.");
    }
  }, [project.id]);

  useEffect(() => {
    void loadMembers();
  }, [loadMembers, refreshKey]);

  const pdms = useMemo(() => members.filter((m) => Boolean(m.decision_maker)), [members]);

  // Key on the serialized blobs so an unrelated project reload never resets in-progress edits.
  const settingsKey = JSON.stringify(project.comms_settings ?? {});
  const saved = useMemo<ProjectCommsSettings>(() => parseCommsSettings(JSON.parse(settingsKey)), [settingsKey]);
  const templateKey = JSON.stringify(project.report_template ?? {});
  const template = useMemo<ReportTemplate | null>(() => {
    const raw: unknown = JSON.parse(templateKey);
    return hasReportTemplate(raw) ? raw : null;
  }, [templateKey]);

  const effective = commsEffectivelyActive(saved, pdms.length);

  /** A report was generated (preview or real) — history + project may have changed. */
  const afterGenerate = useCallback(() => {
    setHistoryToken((t) => t + 1);
    onUpdateRef.current();
  }, []);

  return (
    <HudPanel
      icon={<Megaphone size={16} />}
      title="Communication"
      accent="teal"
      headerRight={
        <>
          <span
            className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
              effective ? "bg-teal-500/15 text-teal-300" : "bg-slate-800 text-slate-500"
            }`}
          >
            {effective ? "Reports active" : "Reports off"}
          </span>
          <span
            title="Primary Decision Makers on this project (flag them in Members)"
            className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold ${
              pdms.length > 0 ? "bg-amber-500/15 text-amber-300" : "bg-slate-800 text-slate-500"
            }`}
          >
            <Crown size={10} fill="currentColor" /> {pdms.length} PDM
          </span>
        </>
      }
    >
      <p className="mb-3 text-[11px] text-slate-500">
        Praxis keeps this project&apos;s Primary Decision Makers informed: branded status reports after activity or
        weekly, review meetings on the calendar, and their answers flow back as decisions on the request queue.
      </p>
      {membersNote && <p className="mb-3 text-[11px] text-amber-400">{membersNote}</p>}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="min-w-0 space-y-4">
          <StatusReportsSection
            project={project}
            saved={saved}
            pdms={pdms}
            members={members}
            effective={effective}
            onSaved={() => onUpdateRef.current()}
            afterGenerate={afterGenerate}
          />
          <ReportHistorySection projectId={project.id} refreshToken={historyToken} />
        </div>
        <div className="min-w-0 space-y-4">
          <MeetingsSection project={project} members={members} pdms={pdms} />
          <TemplateSection project={project} template={template} afterGenerate={afterGenerate} onSaved={() => onUpdateRef.current()} />
        </div>
      </div>
    </HudPanel>
  );
}

// ─── 1. Status reports ──────────────────────────────────────────────────────

type ActiveMode = "auto" | "on" | "off";

interface CommsDraft {
  active: ActiveMode;
  send_mode: ProjectCommsSettings["send_mode"];
  quiet_minutes: string;
  event_trigger: boolean;
  weekly_enabled: boolean;
  weekday: number;
  hour: number;
  decision_makers: boolean;
  member_ids: string[];
  emails: string;
  cc_operator: boolean;
  timezone: string;
}

function toDraft(s: ProjectCommsSettings): CommsDraft {
  return {
    active: s.active === undefined ? "auto" : s.active ? "on" : "off",
    send_mode: s.send_mode,
    quiet_minutes: String(s.quiet_minutes),
    event_trigger: s.event_trigger,
    weekly_enabled: s.weekly.enabled,
    weekday: s.weekly.weekday,
    hour: s.weekly.hour,
    decision_makers: s.recipients.decision_makers,
    member_ids: [...s.recipients.member_ids],
    emails: s.recipients.emails.join(", "),
    cc_operator: s.cc_operator,
    timezone: s.timezone,
  };
}

/** Full settings object for the PATCH — keeps Praxis's last_report_* stamps from `base`. */
function fromDraft(d: CommsDraft, base: ProjectCommsSettings): ProjectCommsSettings {
  const quiet = Number.parseInt(d.quiet_minutes, 10);
  const next: ProjectCommsSettings = {
    ...base,
    send_mode: d.send_mode,
    quiet_minutes: clamp(Number.isFinite(quiet) ? quiet : 60, 5, 24 * 60),
    event_trigger: d.event_trigger,
    weekly: { enabled: d.weekly_enabled, weekday: d.weekday, hour: d.hour },
    recipients: { decision_makers: d.decision_makers, member_ids: d.member_ids, emails: parseCsv(d.emails) },
    cc_operator: d.cc_operator,
    timezone: d.timezone.trim() || "America/New_York",
  };
  if (d.active === "auto") delete next.active;
  else next.active = d.active === "on";
  return next;
}

function StatusReportsSection({
  project,
  saved,
  pdms,
  members,
  effective,
  onSaved,
  afterGenerate,
}: {
  project: Project;
  saved: ProjectCommsSettings;
  pdms: ProjectContact[];
  members: ProjectContact[];
  effective: boolean;
  onSaved: () => void;
  afterGenerate: () => void;
}) {
  const savedDraftKey = JSON.stringify(toDraft(saved));
  const [draft, setDraft] = useState<CommsDraft>(() => toDraft(saved));
  // Saved settings changed underneath (reload after save, Praxis stamped a
  // send) → reset the draft. State adjusted during render, keyed on the blob.
  const [seenKey, setSeenKey] = useState(savedDraftKey);
  if (seenKey !== savedDraftKey) {
    setSeenKey(savedDraftKey);
    setDraft(JSON.parse(savedDraftKey) as CommsDraft);
  }
  const dirty = JSON.stringify(draft) !== savedDraftKey;
  const patch = (p: Partial<CommsDraft>) => setDraft((d) => ({ ...d, ...p }));

  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<"preview" | "send" | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  const pdmRecipients = saved.recipients.decision_makers ? pdms.length : 0;
  const memberRecipients = saved.recipients.member_ids.filter(
    (id) => !(saved.recipients.decision_makers && pdms.some((p) => p.id === id)),
  ).length;
  const extraRecipients = memberRecipients + saved.recipients.emails.length;
  const stateLine = !effective
    ? saved.active === false
      ? "Off — switched off for this project; no reports go out."
      : "Inactive — flag a Primary Decision Maker or switch on below."
    : pdmRecipients + extraRecipients === 0
      ? "Active — but nobody would receive a report yet: flag a PDM or add recipients below."
      : pdmRecipients === 0
        ? `Active — reports go to ${plural(extraRecipients, "recipient")} (no decision makers flagged).`
        : `Active — reports go to ${plural(pdmRecipients, "decision maker")}${
            extraRecipients > 0 ? ` and ${plural(extraRecipients, "more recipient")}` : ""
          }.`;

  const save = async () => {
    setSaving(true);
    setNotice(null);
    try {
      await updateProject(project.id, { comms_settings: fromDraft(draft, saved) });
      setNotice({ kind: "ok", text: "Communication settings saved." });
      onSaved();
    } catch (err) {
      setNotice({ kind: "err", text: errText(err, "Save failed") });
    } finally {
      setSaving(false);
    }
  };

  const preview = async () => {
    setBusy("preview");
    setNotice(null);
    try {
      const report = await generateStakeholderReport(project.id, { dryRun: true });
      const url = stakeholderReportPreviewUrl(report.html_file);
      const items = (report.items ?? []).length;
      if (url) {
        window.open(url, "_blank", "noopener,noreferrer");
        setNotice({ kind: "ok", text: `Preview ready — ${plural(items, "item")}. ${report.summary ?? ""}`.trim(), href: url });
      } else {
        setNotice({ kind: "ok", text: `Preview composed (${plural(items, "item")}): ${report.summary || "no summary"}` });
      }
      afterGenerate();
    } catch (err) {
      setNotice({ kind: "err", text: `Preview failed — ${errText(err, "Praxis reports API unavailable")}` });
    } finally {
      setBusy(null);
    }
  };

  const sendNow = async () => {
    setBusy("send");
    setNotice(null);
    try {
      const report = await generateStakeholderReport(project.id);
      const url = stakeholderReportPreviewUrl(report.html_file);
      const queued = report.status === "review" || (report.status !== "sent" && saved.send_mode === "review");
      const text = queued
        ? "Queued for your approval in the inbox."
        : report.status === "sent"
          ? `Sent to ${plural((report.recipients ?? []).length, "recipient")}.`
          : report.status === "failed"
            ? "Praxis could not send the report — see the history below."
            : `Report generated (${report.status}).`;
      setNotice({ kind: report.status === "failed" ? "err" : "ok", text, href: url });
      afterGenerate();
    } catch (err) {
      setNotice({ kind: "err", text: `Generation failed — ${errText(err, "Praxis reports API unavailable")}` });
    } finally {
      setBusy(null);
    }
  };

  const toggleMember = (id: string, on: boolean) =>
    patch({ member_ids: on ? Array.from(new Set([...draft.member_ids, id])) : draft.member_ids.filter((m) => m !== id) });

  return (
    <Section
      icon={<FileText size={14} />}
      title="Status reports"
      right={
        <span
          className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
            effective ? "bg-teal-500/15 text-teal-300" : "bg-slate-800 text-slate-500"
          }`}
        >
          {effective ? "active" : "inactive"}
        </span>
      }
    >
      <p className={`text-[12px] ${effective ? "text-teal-300" : "text-slate-400"}`}>{stateLine}</p>
      {saved.last_report_at && (
        <p className="mt-0.5 text-[11px] text-slate-500">
          Last report {fmtShort(saved.last_report_at)}
          {saved.last_trigger ? ` · ${saved.last_trigger}` : ""}
        </p>
      )}

      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Field label="Reporting">
          <select className="hud-input" value={draft.active} onChange={(e) => patch({ active: e.target.value as ActiveMode })}>
            <option value="auto">Auto — follows PDMs (on while any are flagged)</option>
            <option value="on">On</option>
            <option value="off">Off</option>
          </select>
        </Field>
        <Field label="Sending">
          <select
            className="hud-input"
            value={draft.send_mode}
            onChange={(e) => patch({ send_mode: e.target.value as ProjectCommsSettings["send_mode"] })}
          >
            <option value="review">Review first — Robert approves each send</option>
            <option value="auto">Auto-send</option>
          </select>
        </Field>
      </div>

      <div className="mt-3 space-y-1.5">
        <Check checked={draft.event_trigger} onChange={(v) => patch({ event_trigger: v })}>
          Send a report after a quiet hour following incoming requests
        </Check>
        <div className="flex flex-wrap items-center gap-2 pl-5 text-[11px] text-slate-500">
          Quiet period
          <span className="inline-block w-20">
            <input
              type="number"
              min={5}
              max={1440}
              className="hud-input"
              value={draft.quiet_minutes}
              onChange={(e) => patch({ quiet_minutes: e.target.value })}
            />
          </span>
          minutes (5–1440)
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={draft.weekly_enabled} onChange={(e) => patch({ weekly_enabled: e.target.checked })} />
            Weekly report every
          </label>
          <span className="inline-block">
            <select className="hud-input" value={draft.weekday} onChange={(e) => patch({ weekday: Number(e.target.value) })}>
              {WEEKDAYS.map((w, i) => (
                <option key={w} value={i}>
                  {w}
                </option>
              ))}
            </select>
          </span>
          at
          <span className="inline-block">
            <select className="hud-input" value={draft.hour} onChange={(e) => patch({ hour: Number(e.target.value) })}>
              {HOURS.map((h) => (
                <option key={h} value={h}>
                  {hourLabel(h)}
                </option>
              ))}
            </select>
          </span>
        </div>
      </div>

      <p className="mt-3 mb-1 text-[10px] uppercase tracking-widest text-slate-500">Recipients</p>
      <div className="space-y-1.5">
        <Check checked={draft.decision_makers} onChange={(v) => patch({ decision_makers: v })}>
          All Primary Decision Makers ({pdms.length})
        </Check>
        {members.length > 0 ? (
          <div className="flex flex-wrap gap-1.5 pl-5">
            {members.map((m) => {
              const on = draft.member_ids.includes(m.id);
              return (
                <label
                  key={m.id}
                  className={`flex cursor-pointer items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] transition-colors ${
                    on ? "border-teal-500/40 bg-teal-500/10 text-teal-200" : "border-slate-800 text-slate-400 hover:border-slate-600"
                  }`}
                  title={m.email ?? undefined}
                >
                  <input type="checkbox" className="sr-only" checked={on} onChange={(e) => toggleMember(m.id, e.target.checked)} />
                  {m.name}
                  {m.decision_maker ? <Crown size={9} className="text-amber-300" fill="currentColor" /> : null}
                </label>
              );
            })}
          </div>
        ) : (
          <p className="pl-5 text-[11px] text-slate-600">No members yet — add them in the Members panel.</p>
        )}
        <Field label="Extra emails (comma-separated)">
          <input
            className="hud-input"
            value={draft.emails}
            onChange={(e) => patch({ emails: e.target.value })}
            placeholder="them@example.com, other@example.com"
          />
        </Field>
        <Check checked={draft.cc_operator} onChange={(v) => patch({ cc_operator: v })}>
          Copy Robert (the operator mailbox) on every report
        </Check>
        <Field label="Timezone for the weekly schedule">
          <input className="hud-input" value={draft.timezone} onChange={(e) => patch({ timezone: e.target.value })} placeholder="America/New_York" />
        </Field>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1.5">
          <button onClick={preview} disabled={busy !== null} className={BTN.slate} title="Compose a report now without sending it (opens the HTML preview)">
            {busy === "preview" ? "Composing…" : "Preview report"}
          </button>
          <button onClick={sendNow} disabled={busy !== null} className={BTN.teal} title="Compose a report now and send it (or queue it for your approval in review mode)">
            <span className="flex items-center gap-1">
              <Send size={11} /> {busy === "send" ? "Generating…" : "Generate & send now"}
            </span>
          </button>
        </div>
        <div className="flex items-center gap-2">
          {dirty && (
            <button onClick={() => setDraft(JSON.parse(savedDraftKey) as CommsDraft)} className="text-[11px] text-slate-500 hover:text-white">
              Reset
            </button>
          )}
          <button onClick={save} disabled={!dirty || saving} className={SAVE_BTN}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
      <div className="mt-2">
        <NoticeLine notice={notice} />
      </div>
    </Section>
  );
}

// ─── 2. Report history ──────────────────────────────────────────────────────

const REPORT_STATUS_CHIP: Record<StakeholderReport["status"], string> = {
  draft: "bg-slate-500/15 text-slate-300",
  review: "bg-amber-500/15 text-amber-300",
  sent: "bg-emerald-500/15 text-emerald-300",
  cancelled: "bg-slate-700/40 text-slate-500",
  failed: "bg-red-500/15 text-red-300",
};

function ReportHistorySection({ projectId, refreshToken }: { projectId: string; refreshToken: number }) {
  const [reports, setReports] = useState<StakeholderReport[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setReports((await listStakeholderReports(projectId)).slice(0, 10));
      setError(null);
    } catch (err) {
      setReports([]);
      setError(`Praxis reports API unavailable — ${errText(err, "request failed")}.`);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void reload();
  }, [reload, refreshToken]);

  const send = async (id: string) => {
    setSendingId(id);
    setNotice(null);
    try {
      await sendStakeholderReport(id);
      setNotice({ kind: "ok", text: "Report sent." });
      await reload();
    } catch (err) {
      setNotice({ kind: "err", text: `Send failed — ${errText(err, "Praxis reports API unavailable")}` });
    } finally {
      setSendingId(null);
    }
  };

  return (
    <Section
      icon={<History size={14} />}
      title="Report history"
      hint={reports.length > 0 ? `${reports.length} recent` : undefined}
      defaultOpen={false}
      right={
        <button onClick={() => void reload()} title="Refresh" aria-label="Refresh report history" className="rounded border border-slate-800 p-1 text-slate-500 transition-colors hover:text-teal-300">
          <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
        </button>
      }
    >
      {error && <p className="text-[11px] text-amber-400">{error}</p>}
      {!error && !loading && reports.length === 0 && (
        <p className="text-[12px] text-slate-500">No reports yet. Praxis files them here once the first one is generated.</p>
      )}
      {reports.length > 0 && (
        <ul className="space-y-1.5">
          {reports.map((r) => {
            const previewUrl = stakeholderReportPreviewUrl(r.html_file);
            const canSend = r.status === "review" || r.status === "draft";
            return (
              <li key={r.id} className="rounded border border-slate-800 bg-slate-900/40 px-2.5 py-1.5">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
                  <span className="font-mono text-slate-300">{fmtShort(r.generated_at)}</span>
                  <span className="rounded bg-slate-800 px-1.5 text-[10px] uppercase tracking-wider text-slate-400">{r.trigger}</span>
                  <span className={`rounded px-1.5 text-[10px] font-semibold uppercase tracking-wider ${REPORT_STATUS_CHIP[r.status] ?? REPORT_STATUS_CHIP.draft}`}>
                    {r.status}
                  </span>
                  <span className="text-slate-500">{plural((r.items ?? []).length, "item")}</span>
                  {r.tag && <span className="font-mono text-[10px] text-slate-600">{r.tag}</span>}
                  <span className="ml-auto flex items-center gap-2">
                    {previewUrl && (
                      <a href={previewUrl} target="_blank" rel="noopener noreferrer" className="flex items-center gap-0.5 text-cyan-400 hover:underline">
                        Open <ExternalLink size={10} />
                      </a>
                    )}
                    {r.hosted_url && (
                      <a href={r.hosted_url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-0.5 text-cyan-400 hover:underline">
                        Hosted <ExternalLink size={10} />
                      </a>
                    )}
                    {canSend && (
                      <button onClick={() => send(r.id)} disabled={sendingId !== null} className={BTN.teal}>
                        {sendingId === r.id ? "Sending…" : "Send"}
                      </button>
                    )}
                  </span>
                </div>
                {r.summary && <p className="mt-0.5 line-clamp-2 text-[11px] text-slate-500">{r.summary}</p>}
                {(r.feedback ?? []).length > 0 && (
                  <p className="mt-0.5 text-[10px] text-teal-300/80">{plural(r.feedback.length, "reply")} from stakeholders</p>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <div className="mt-2">
        <NoticeLine notice={notice} />
      </div>
    </Section>
  );
}

// ─── 3. Review meetings ─────────────────────────────────────────────────────

const MEETING_WINDOW_DAYS = 60;

function MeetingsSection({ project, members, pdms }: { project: Project; members: ProjectContact[]; pdms: ProjectContact[] }) {
  const [meetings, setMeetings] = useState<MeetingEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const now = new Date();
    const to = new Date(now.getTime() + MEETING_WINDOW_DAYS * 86_400_000);
    try {
      setMeetings(await getProjectMeetings(project.id, now, to));
      setError(null);
    } catch (err) {
      setMeetings([]);
      setError(`Calendar API unavailable — ${errText(err, "request failed")}.`);
    }
  }, [project.id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const nameOf = (id: string) => members.find((m) => m.id === id)?.name ?? id.slice(0, 8);

  const removeOne = async (m: MeetingEvent) => {
    if (!confirm(`Delete "${m.title}" on ${fmtWhen(m.start_time)}?`)) return;
    setBusyId(m.id);
    try {
      await deleteCalendarEvent(m.id);
      await reload();
    } catch (err) {
      setError(`Delete failed — ${errText(err, "calendar API error")}`);
    } finally {
      setBusyId(null);
    }
  };

  const removeSeries = async (m: MeetingEvent) => {
    if (!m.series_id) return;
    if (!confirm(`Delete all upcoming occurrences of "${m.title}"? Past ones stay on the calendar.`)) return;
    setBusyId(m.id);
    try {
      await deleteMeetingSeries(m.series_id);
      await reload();
    } catch (err) {
      setError(`Delete failed — ${errText(err, "calendar API error")}`);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Section
      icon={<CalendarClock size={14} />}
      title="Review meetings"
      hint={meetings.length > 0 ? `${plural(meetings.length, "upcoming")} · next ${MEETING_WINDOW_DAYS} days` : `next ${MEETING_WINDOW_DAYS} days`}
      right={
        <button onClick={() => setAdding((v) => !v)} className={BTN.teal}>
          <span className="flex items-center gap-1">
            {adding ? <X size={11} /> : <Plus size={11} />}
            {adding ? "Close" : "Add meeting"}
          </span>
        </button>
      }
    >
      {error && <p className="mb-2 text-[11px] text-amber-400">{error}</p>}

      {adding && (
        <MeetingForm
          project={project}
          members={members}
          pdms={pdms}
          onDone={() => {
            setAdding(false);
            void reload();
          }}
        />
      )}

      {!error && meetings.length === 0 && !adding && (
        <p className="text-[12px] text-slate-500">No review meetings scheduled. Add one — a one-off or a weekly/biweekly/monthly series.</p>
      )}

      {meetings.length > 0 && (
        <ul className="space-y-1.5">
          {meetings.map((m) => (
            <li key={m.id} className="rounded border border-slate-800 bg-slate-900/40 px-2.5 py-1.5">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-[12px] font-bold text-slate-100">{m.title}</span>
                <span className="font-mono text-[11px] text-slate-400">{fmtWhen(m.start_time)}</span>
                {m.recurrence && (
                  <span className="rounded bg-purple-500/15 px-1.5 text-[10px] font-semibold uppercase tracking-wider text-purple-300">{m.recurrence}</span>
                )}
                <span className="ml-auto flex items-center gap-1.5">
                  <button onClick={() => removeOne(m)} disabled={busyId !== null} className={BTN.red} title="Delete this occurrence">
                    <span className="flex items-center gap-1">
                      <Trash2 size={10} /> Delete
                    </span>
                  </button>
                  {m.series_id && (
                    <button onClick={() => removeSeries(m)} disabled={busyId !== null} className={BTN.red} title="Delete all upcoming occurrences of this series">
                      Delete series
                    </button>
                  )}
                </span>
              </div>
              {m.attendees.length > 0 && (
                <p className="mt-0.5 text-[11px] text-slate-500">With {m.attendees.map(nameOf).join(", ")}</p>
              )}
              {m.description && <p className="mt-0.5 line-clamp-2 text-[11px] text-slate-500">{m.description}</p>}
            </li>
          ))}
        </ul>
      )}

      <p className="mt-3 text-[10px] text-slate-600">
        Praxis expects comments around these meetings and sends a status report after an hour of quiet.
      </p>
    </Section>
  );
}

type RecurrenceChoice = "none" | MeetingRecurrence;

function MeetingForm({
  project,
  members,
  pdms,
  onDone,
}: {
  project: Project;
  members: ProjectContact[];
  pdms: ProjectContact[];
  onDone: () => void;
}) {
  const [title, setTitle] = useState(`${project.name} review`);
  const [start, setStart] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(10, 0, 0, 0);
    return toDatetimeLocalValue(d);
  });
  const [duration, setDuration] = useState("60");
  const [recurrence, setRecurrence] = useState<RecurrenceChoice>("none");
  const [count, setCount] = useState("12");
  const [attendees, setAttendees] = useState<string[]>(() => pdms.map((p) => p.id));
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const toggleAttendee = (id: string, on: boolean) =>
    setAttendees((prev) => (on ? Array.from(new Set([...prev, id])) : prev.filter((a) => a !== id)));

  const submit = async () => {
    setErr(null);
    const startDate = new Date(start);
    if (Number.isNaN(startDate.getTime())) {
      setErr("Pick a valid date and time.");
      return;
    }
    const durationMin = clamp(Number.parseInt(duration, 10) || 60, 5, 600);
    const recurring = recurrence !== "none";
    setBusy(true);
    try {
      await createMeetingSeries({
        title: title.trim() || `${project.name} review`,
        start_time: startDate.toISOString(),
        duration_minutes: durationMin,
        recurrence: recurring ? recurrence : null,
        ...(recurring ? { count: clamp(Number.parseInt(count, 10) || 12, 1, 52) } : {}),
        project_id: project.id,
        attendees,
        ...(notes.trim() ? { description: notes.trim() } : {}),
      });
      onDone();
    } catch (e) {
      setErr(errText(e, "Could not schedule the meeting"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mb-3 space-y-2 rounded-lg border border-teal-500/30 bg-slate-900/60 p-3">
      <Field label="Title">
        <input autoFocus className="hud-input" value={title} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Field label="First occurrence">
          <input type="datetime-local" className="hud-input" value={start} onChange={(e) => setStart(e.target.value)} />
        </Field>
        <Field label="Duration (minutes)">
          <input type="number" min={5} max={600} className="hud-input" value={duration} onChange={(e) => setDuration(e.target.value)} />
        </Field>
        <Field label="Repeats">
          <select className="hud-input" value={recurrence} onChange={(e) => setRecurrence(e.target.value as RecurrenceChoice)}>
            <option value="none">Does not repeat</option>
            <option value="weekly">Weekly</option>
            <option value="biweekly">Every two weeks</option>
            <option value="monthly">Monthly</option>
          </select>
        </Field>
        {recurrence !== "none" && (
          <Field label="Occurrences (max 52)">
            <input type="number" min={1} max={52} className="hud-input" value={count} onChange={(e) => setCount(e.target.value)} />
          </Field>
        )}
      </div>
      <div>
        <p className="mb-1 text-[10px] uppercase tracking-widest text-slate-500">Attendees</p>
        {members.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {members.map((m) => {
              const on = attendees.includes(m.id);
              return (
                <label
                  key={m.id}
                  className={`flex cursor-pointer items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] transition-colors ${
                    on ? "border-teal-500/40 bg-teal-500/10 text-teal-200" : "border-slate-800 text-slate-400 hover:border-slate-600"
                  }`}
                >
                  <input type="checkbox" className="sr-only" checked={on} onChange={(e) => toggleAttendee(m.id, e.target.checked)} />
                  {m.name}
                  {m.decision_maker ? <Crown size={9} className="text-amber-300" fill="currentColor" /> : null}
                </label>
              );
            })}
          </div>
        ) : (
          <p className="text-[11px] text-slate-600">No members on this project yet — add them in the Members panel.</p>
        )}
      </div>
      <Field label="Notes (optional)">
        <textarea className="hud-input min-h-[44px]" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Agenda, link, anything Praxis should mention in the invite" />
      </Field>
      {err && <p className="text-[11px] text-amber-400">{err}</p>}
      <div className="flex justify-end">
        <button onClick={submit} disabled={busy} className={SAVE_BTN}>
          {busy ? "Scheduling…" : recurrence === "none" ? "Schedule meeting" : "Schedule series"}
        </button>
      </div>
    </div>
  );
}

// ─── 4. Branded template ────────────────────────────────────────────────────

const SECTION_LABELS: Array<[keyof ReportTemplate["sections"], string]> = [
  ["requests", "Requests"],
  ["completed", "Completed"],
  ["in_progress", "In progress"],
  ["next", "Up next"],
  ["questions", "Questions"],
  ["feedback", "Feedback"],
];

const HEX_RE = /^#[0-9a-f]{6}$/i;

interface TemplateDraft {
  name: string;
  accent: string;
  logo_url: string;
  tagline: string;
  tone: string;
  from_name: string;
  intro: string;
  footer: string;
  sections: ReportTemplate["sections"];
}

function templateDraft(t: ReportTemplate): TemplateDraft {
  return {
    name: t.brand.name ?? "",
    accent: t.brand.accent ?? "#6d5efc",
    logo_url: t.brand.logo_url ?? "",
    tagline: t.brand.tagline ?? "",
    tone: t.brand.tone ?? "",
    from_name: t.brand.from_name ?? "",
    intro: t.intro ?? "",
    footer: t.footer ?? "",
    sections: { ...t.sections },
  };
}

function TemplateSection({
  project,
  template,
  afterGenerate,
  onSaved,
}: {
  project: Project;
  template: ReportTemplate | null;
  afterGenerate: () => void;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<TemplateDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const patch = (p: Partial<TemplateDraft>) => setDraft((d) => (d ? { ...d, ...p } : d));

  const createNow = async () => {
    setBusy(true);
    setNotice(null);
    try {
      await generateStakeholderReport(project.id, { dryRun: true });
      setNotice({ kind: "ok", text: "Praxis composed a preview and created the template — reloading." });
      afterGenerate();
    } catch (err) {
      setNotice({ kind: "err", text: `Could not create the template — ${errText(err, "Praxis reports API unavailable")}` });
    } finally {
      setBusy(false);
    }
  };

  const startEdit = () => {
    if (!template) return;
    setDraft(templateDraft(template));
    setNotice(null);
    setEditing(true);
  };

  const save = async () => {
    if (!template || !draft) return;
    const now = new Date().toISOString();
    const next: ReportTemplate = {
      ...template,
      brand: {
        ...template.brand,
        name: draft.name.trim() || template.brand.name,
        accent: HEX_RE.test(draft.accent.trim()) ? draft.accent.trim() : template.brand.accent,
        logo_url: draft.logo_url.trim() || undefined,
        tagline: draft.tagline.trim() || undefined,
        tone: draft.tone.trim() || template.brand.tone,
        from_name: draft.from_name.trim() || undefined,
      },
      sections: { ...draft.sections },
      intro: draft.intro.trim() || undefined,
      footer: draft.footer.trim() || undefined,
      updated_at: now,
      source: "operator",
      version: template.version,
      change_log: [...(template.change_log ?? []), { at: now, by: "operator", note: "Edited on the project page" }],
    };
    setBusy(true);
    setNotice(null);
    try {
      await updateProject(project.id, { report_template: next });
      setEditing(false);
      setNotice({ kind: "ok", text: "Template saved — the next report uses it." });
      onSaved();
    } catch (err) {
      setNotice({ kind: "err", text: errText(err, "Save failed") });
    } finally {
      setBusy(false);
    }
  };

  const colorValue = draft && HEX_RE.test(draft.accent.trim()) ? draft.accent.trim() : "#6d5efc";
  const changeLog = [...(template?.change_log ?? [])].slice(-5).reverse();

  return (
    <Section
      icon={<Palette size={14} />}
      title="Branded template"
      hint={template ? `v${template.version} · ${template.source} · updated ${fmtShort(template.updated_at)}` : "not created yet"}
      defaultOpen={false}
      right={
        template && !editing ? (
          <button onClick={startEdit} className={BTN.slate}>
            Edit
          </button>
        ) : undefined
      }
    >
      {!template && (
        <div className="space-y-2">
          <p className="text-[12px] text-slate-400">
            Created automatically the first time a report goes out — Praxis derives the brand (name, accent, tone) from the
            project and refines it from stakeholder feedback.
          </p>
          <button onClick={createNow} disabled={busy} className={BTN.teal}>
            {busy ? "Composing…" : "Create now"}
          </button>
        </div>
      )}

      {template && !editing && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="h-5 w-5 shrink-0 rounded border border-slate-700" style={{ background: template.brand.accent }} title={template.brand.accent} />
            <span className="text-[13px] font-bold text-slate-100">{template.brand.name}</span>
            {template.brand.tagline && <span className="text-[11px] text-slate-500">— {template.brand.tagline}</span>}
          </div>
          <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-[11px] sm:grid-cols-2">
            <div>
              <dt className="text-[10px] uppercase tracking-widest text-slate-500">Tone</dt>
              <dd className="text-slate-300">{template.brand.tone}</dd>
            </div>
            <div>
              <dt className="text-[10px] uppercase tracking-widest text-slate-500">From</dt>
              <dd className="text-slate-300">{template.brand.from_name || "Praxis"}</dd>
            </div>
            {template.brand.logo_url && (
              <div className="sm:col-span-2">
                <dt className="text-[10px] uppercase tracking-widest text-slate-500">Logo</dt>
                <dd className="truncate font-mono text-slate-400">{template.brand.logo_url}</dd>
              </div>
            )}
            {template.intro && (
              <div className="sm:col-span-2">
                <dt className="text-[10px] uppercase tracking-widest text-slate-500">Intro</dt>
                <dd className="line-clamp-2 text-slate-300">{template.intro}</dd>
              </div>
            )}
            {template.footer && (
              <div className="sm:col-span-2">
                <dt className="text-[10px] uppercase tracking-widest text-slate-500">Footer</dt>
                <dd className="line-clamp-2 text-slate-300">{template.footer}</dd>
              </div>
            )}
          </dl>
          <div className="flex flex-wrap gap-1">
            {SECTION_LABELS.map(([key, label]) => (
              <span
                key={key}
                className={`rounded px-1.5 py-0.5 text-[10px] ${
                  template.sections[key] ? "bg-teal-500/15 text-teal-300" : "bg-slate-800 text-slate-600 line-through"
                }`}
              >
                {label}
              </span>
            ))}
          </div>
          {changeLog.length > 0 && (
            <div>
              <p className="mb-0.5 text-[10px] uppercase tracking-widest text-slate-500">Change log</p>
              <ul className="space-y-0.5">
                {changeLog.map((c, i) => (
                  <li key={`${c.at}-${i}`} className="text-[11px] text-slate-400">
                    <span className="font-mono text-slate-600">{fmtShort(c.at)}</span> · {c.by} — {c.note}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {template && editing && draft && (
        <div className="space-y-2">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Field label="Brand name">
              <input className="hud-input" value={draft.name} onChange={(e) => patch({ name: e.target.value })} />
            </Field>
            <Field label="Accent">
              <span className="flex items-center gap-2">
                <input
                  type="color"
                  value={colorValue}
                  onChange={(e) => patch({ accent: e.target.value })}
                  className="h-7 w-9 shrink-0 cursor-pointer rounded border border-slate-800 bg-transparent"
                  aria-label="Accent color"
                />
                <input className="hud-input font-mono" value={draft.accent} onChange={(e) => patch({ accent: e.target.value })} placeholder="#6d5efc" />
              </span>
            </Field>
            <Field label="Logo URL">
              <input className="hud-input" value={draft.logo_url} onChange={(e) => patch({ logo_url: e.target.value })} placeholder="https://…/logo.png" />
            </Field>
            <Field label="Tagline">
              <input className="hud-input" value={draft.tagline} onChange={(e) => patch({ tagline: e.target.value })} />
            </Field>
            <Field label="Tone (voice hints for the composer)">
              <input className="hud-input" value={draft.tone} onChange={(e) => patch({ tone: e.target.value })} placeholder="friendly, plain language, no jargon" />
            </Field>
            <Field label="From name (email sender)">
              <input className="hud-input" value={draft.from_name} onChange={(e) => patch({ from_name: e.target.value })} placeholder="Praxis for Meeple Magnate" />
            </Field>
          </div>
          <Field label="Intro">
            <textarea className="hud-input min-h-[44px]" value={draft.intro} onChange={(e) => patch({ intro: e.target.value })} />
          </Field>
          <Field label="Footer">
            <textarea className="hud-input min-h-[44px]" value={draft.footer} onChange={(e) => patch({ footer: e.target.value })} />
          </Field>
          <div>
            <p className="mb-1 text-[10px] uppercase tracking-widest text-slate-500">Sections</p>
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {SECTION_LABELS.map(([key, label]) => (
                <label key={key} className="flex items-center gap-1.5 text-[11px] text-slate-400">
                  <input
                    type="checkbox"
                    checked={draft.sections[key]}
                    onChange={(e) => patch({ sections: { ...draft.sections, [key]: e.target.checked } })}
                  />
                  {label}
                </label>
              ))}
            </div>
          </div>
          <div className="flex items-center justify-end gap-2 pt-1">
            <button onClick={() => setEditing(false)} disabled={busy} className="text-[11px] text-slate-500 hover:text-white">
              Cancel
            </button>
            <button onClick={save} disabled={busy} className={SAVE_BTN}>
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      )}

      <div className="mt-2">
        <NoticeLine notice={notice} />
      </div>
    </Section>
  );
}

"use client";

import { useCallback, useEffect, useState } from "react";
import { Settings2 } from "lucide-react";
import { HudPanel } from "@/components/bridge/hud";
import { authFetch } from "@/lib/nexus/shared";

type Policy = {
  schemaVersion: 1; projectId: string; mode: "off" | "maintenance"; workspace: string;
  feedback: { project: string; code: string; displayName: string };
  contact: { memberId: string; email: string }; quietMinutes: number;
  taskAutonomy: "draft" | "schedule" | "execute_simple";
  communicationAutonomy: "draft" | "send_status";
  mixedBatch: "independent" | "hold_all"; maxTaskMinutes: number;
  deployment: { kind: "manual" } | { kind: "ios_wifi"; deviceId: string; bundleId: string };
  revision?: string; updatedAt?: string; updatedBy?: string;
};
type Settings = { policy: Policy | null; project: { id: string; name: string; workspace?: string }; contacts: { id: string; name: string; email?: string | null }[];
  batches?: { id: string; stage: string; commentCount: number; dueAt: string; summary?: string; lastError?: string }[] };
const inputClass = "mt-1 w-full rounded border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 disabled:opacity-50";
const batchLabel: Record<string, string> = { complete: "reviewed", held: "needs attention", reviewing: "reviewing", planned: "preparing tasks", notifying: "preparing update", reporting: "preparing update" };

export function ProjectMaintenance({ projectId }: { projectId: string }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<Policy | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const load = useCallback(async () => {
    setBusy(true); setError("");
    try {
      const response = await authFetch(`/api/praxis/project-maintenance/${encodeURIComponent(projectId)}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not load maintenance settings.");
      const state = data as Settings;
      setSettings(state);
      setDraft(state.policy ?? {
        schemaVersion: 1, projectId, mode: "off", workspace: state.project.workspace ?? "",
        feedback: { project: "", code: "", displayName: state.project.name },
        contact: { memberId: "", email: "" }, quietMinutes: 30, taskAutonomy: "draft",
        communicationAutonomy: "draft", mixedBatch: "independent", maxTaskMinutes: 120, deployment: { kind: "manual" },
      });
    } catch (e) { setError(e instanceof Error ? e.message : "Could not load maintenance settings."); }
    finally { setBusy(false); }
  }, [projectId]);
  useEffect(() => { void load(); }, [load]);
  function change<K extends keyof Policy>(key: K, value: Policy[K]) { setDraft(old => old ? { ...old, [key]: value } : old); setSaved(""); }
  async function save() {
    if (!draft) return;
    setBusy(true); setError(""); setSaved("");
    try {
      const { revision: _revision, updatedAt: _updatedAt, updatedBy: _updatedBy, ...policy } = draft;
      const response = await authFetch(`/api/praxis/project-maintenance/${encodeURIComponent(projectId)}`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ policy, expectedRevision: settings?.policy?.revision ?? null }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Settings were not saved.");
      setDraft(data.policy); setSettings(old => old ? { ...old, policy: data.policy } : old);
      setSaved("Maintenance settings saved.");
    } catch (e) { setError(e instanceof Error ? e.message : "Settings were not saved."); }
    finally { setBusy(false); }
  }
  return <HudPanel icon={<Settings2 size={16} />} title="Maintenance mode" accent="purple">
    <p className="mb-4 text-sm text-slate-400">Collect recent client requests, review them after a quiet period, and finish approved changes with a deployment task. Architecture, new design, and uncertain scope come to your inbox.</p>
    {error && <p role="alert" className="mb-3 text-sm text-amber-300">{error}</p>}
    {saved && <p role="status" className="mb-3 text-sm text-emerald-300">{saved}</p>}
    {!!settings?.batches?.length && <div className="mb-4 space-y-2 rounded border border-slate-800 p-3 text-sm text-slate-300">
      <p className="font-medium">Recent feedback batches</p>
      {settings.batches.slice(0, 3).map(batch => <p key={batch.id}>{batch.commentCount} comment{batch.commentCount === 1 ? "" : "s"} · {batch.stage === "collecting" ? `review after ${new Date(batch.dueAt).toLocaleString()}` : (batchLabel[batch.stage] ?? batch.stage)}{batch.lastError ? ` · ${batch.lastError}` : batch.summary ? ` · ${batch.summary}` : ""}</p>)}
    </div>}
    {!draft ? <button type="button" disabled={busy} onClick={() => void load()} className={inputClass}>{busy ? "Loading…" : "Reload settings"}</button> : <form noValidate={draft.mode === "off"} onSubmit={event => { event.preventDefault(); void save(); }}>
      <fieldset disabled={busy} className="space-y-4">
        <label className="flex items-center gap-2 text-sm text-slate-100"><input type="checkbox" checked={draft.mode === "maintenance"} onChange={e => change("mode", e.target.checked ? "maintenance" : "off")} /> Enable maintenance for this project</label>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="text-sm text-slate-300">Review after quiet minutes<input type="number" min={1} max={1440} required className={inputClass} value={draft.quietMinutes} onChange={e => change("quietMinutes", Number(e.target.value))} /></label>
          <label className="text-sm text-slate-300">Simple work<select className={inputClass} value={draft.taskAutonomy} onChange={e => change("taskAutonomy", e.target.value as Policy["taskAutonomy"])}><option value="draft">Draft tasks for my review</option><option value="schedule">Add to schedule; wait for approval</option><option value="execute_simple">Schedule and start when idle</option></select></label>
          <label className="text-sm text-slate-300">Client reports and follow-up questions<select className={inputClass} value={draft.communicationAutonomy} onChange={e => change("communicationAutonomy", e.target.value as Policy["communicationAutonomy"])}><option value="draft">Hold drafts for my review</option><option value="send_status">Send recent-request updates automatically</option></select></label>
          <label className="text-sm text-slate-300">When requests include major work<select className={inputClass} value={draft.mixedBatch} onChange={e => change("mixedBatch", e.target.value as Policy["mixedBatch"])}><option value="independent">Proceed with independent simple fixes</option><option value="hold_all">Hold the entire batch for me</option></select></label>
          <label className="text-sm text-slate-300">Client contact<select required={draft.mode === "maintenance"} className={inputClass} value={draft.contact.memberId} onChange={e => { const person = settings?.contacts.find(p => p.id === e.target.value); if (person?.email) change("contact", { memberId: person.id, email: person.email }); }}><option value="">Choose a project member</option>{settings?.contacts.filter(p => p.email).map(p => <option key={p.id} value={p.id}>{p.name} — {p.email}</option>)}</select></label>
          <label className="text-sm text-slate-300">Maximum simple task estimate (minutes)<input type="number" min={5} max={240} required className={inputClass} value={draft.maxTaskMinutes} onChange={e => change("maxTaskMinutes", Number(e.target.value))} /></label>
        </div>
        <p className="text-xs text-slate-400">Each new comment resets the quiet period. Reports cover the recent batch and copy Robert. Changing permissions holds queued work from the previous policy for review. Turning maintenance off revokes future automatic work and sending; it does not undo work already running.</p>
        <details open={!settings?.policy} className="rounded border border-slate-800 p-3">
          <summary className="cursor-pointer text-sm text-slate-300">Feedback setup and deployment</summary>
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            <label className="text-sm text-slate-300">Feedback project ID<input required pattern="[a-z0-9][a-z0-9_-]{1,79}" className={inputClass} value={draft.feedback.project} onChange={e => change("feedback", { ...draft.feedback, project: e.target.value })} /></label>
            <label className="text-sm text-slate-300">Reply code<input required pattern="[A-Z0-9]{2,12}" className={inputClass} value={draft.feedback.code} onChange={e => change("feedback", { ...draft.feedback, code: e.target.value.toUpperCase() })} /></label>
            <label className="text-sm text-slate-300">Client-facing app name<input required maxLength={160} className={inputClass} value={draft.feedback.displayName} onChange={e => change("feedback", { ...draft.feedback, displayName: e.target.value })} /></label>
            <label className="text-sm text-slate-300">Final deployment<select className={inputClass} value={draft.deployment.kind} onChange={e => change("deployment", e.target.value === "manual" ? { kind: "manual" } : { kind: "ios_wifi", deviceId: "", bundleId: "" })}><option value="manual">Deployment task for review</option><option value="ios_wifi">Paired iPhone when available on Wi-Fi</option></select></label>
            {draft.deployment.kind === "ios_wifi" && <>
              <label className="text-sm text-slate-300">Paired device ID<input required className={inputClass} value={draft.deployment.deviceId} onChange={e => { if (draft.deployment.kind === "ios_wifi") change("deployment", { ...draft.deployment, deviceId: e.target.value }); }} /></label>
              <label className="text-sm text-slate-300">App bundle ID<input required className={inputClass} value={draft.deployment.bundleId} onChange={e => { if (draft.deployment.kind === "ios_wifi") change("deployment", { ...draft.deployment, bundleId: e.target.value }); }} /></label>
            </>}
          </div>
          <p className="mt-3 text-xs text-slate-400">Praxis registers the public feedback token through its existing relay credential. The project ID must match the installed widget. iPhone deployment uses this project’s verified updater and requires the paired phone to be unlocked and reachable on the local network.</p>
        </details>
        <div className="flex gap-3"><button type="submit" className="rounded bg-purple-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{busy ? "Saving…" : "Save maintenance settings"}</button><button type="button" onClick={() => void load()} className="px-3 py-2 text-sm text-slate-400">Reload</button></div>
      </fieldset>
    </form>}
  </HudPanel>;
}

"use client";

/**
 * The guided blind-labelling workbench behind /task/<id>/labeling.
 *
 * One passage at a time through the three stages the packet defines
 * (A blind labels, B control judgments, C same-outcome pairs). Every edit is
 * saved to the server (debounced, acknowledged with a timestamp), reload or
 * another device resumes from the server record, and a stage is committed
 * only through an explicit review. Stage B and C content is fetched only
 * after the API has unlocked it and the operator's own reveal POST has
 * recorded the exposure; a read never records anything.
 * Browser storage holds nothing but the per-tab operator credential.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowLeft, Check, ChevronLeft, ChevronRight, Loader2, Lock, RefreshCw, ShieldCheck, Unlock } from "lucide-react";
import {
  LabelingApiError, STAGES, editableStageA, emptyStageB, emptyStageC, labelingApi, readOperatorKey, shortSha, stageShort, stageTitle, stateLabel, storeOperatorKey,
  type AnswerState, type AnyAnswer, type CommitRefusal, type ControlItem, type EntryInfo, type ExportResult, type FieldError, type PacketProvision, type PacketRow, type PairItem,
  type SavedAnswer, type SessionRead, type SessionSummary, type Stage, type StageAAnswer, type StageBAnswer, type StageBContent, type StageCAnswer, type StageCContent, type StageProgress, type StageRead, type WhoAmI,
} from "@/lib/groundrules-labeling";
import { StageAForm } from "./stage-a-form";
import { StageBForm, CommittedReading } from "./stage-b-form";
import { StageCForm } from "./stage-c-form";

type Key = `${Stage}:${string}`;
interface Draft { answer: AnyAnswer; unsure: boolean; dirty: boolean; version: number }
interface SaveInfo { status: "idle" | "saving" | "saved" | "error" | "stale" | "unsaved"; at?: string; message?: string; current?: SavedAnswer | null }
interface ItemA { kind: "A"; id: string; row: PacketRow; provision: PacketProvision }
interface ItemB { kind: "B"; id: string; item: ControlItem }
interface ItemC { kind: "C"; id: string; item: PairItem }
type Item = ItemA | ItemB | ItemC;

export interface WorkbenchTimings { autosaveMs: number }
const DEFAULT_TIMINGS: WorkbenchTimings = { autosaveMs: 700 };
/** Stands in while the packet on disk cannot be read: every stage shown as locked, nothing counted. */
const EMPTY_PROGRESS: Record<Stage, StageProgress> = Object.fromEntries((["A", "B", "C"] as const).map(s => [s, { total: 0, complete: 0, draft: 0, unsure: 0, untouched: 0, unlocked: false, reason: "packet_unreadable", committed_at: null, revealed_at: null }])) as Record<Stage, StageProgress>;
const keyOf = (stage: Stage, id: string): Key => `${stage}:${id}`;
const fmt = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : "");
const errorMessage = (err: unknown) => (err instanceof Error ? err.message : "Request failed");

function SaveChip({ info, dirty }: { info: SaveInfo | undefined; dirty: boolean }) {
  const status = info?.status ?? (dirty ? "unsaved" : "idle");
  const map: Record<SaveInfo["status"], { text: string; cls: string }> = {
    idle: { text: "No changes", cls: "border-slate-700 text-slate-400" },
    unsaved: { text: "Unsaved changes", cls: "border-amber-500/40 text-amber-200" },
    saving: { text: "Saving…", cls: "border-cyan-500/40 text-cyan-200" },
    saved: { text: `Saved ${info?.at ? new Date(info.at).toLocaleTimeString() : ""}`, cls: "border-emerald-500/40 text-emerald-200" },
    error: { text: `Not saved: ${info?.message ?? "error"}`, cls: "border-rose-500/50 text-rose-200" },
    stale: { text: "Saved elsewhere since you loaded it", cls: "border-amber-500/60 text-amber-200" },
  };
  const { text, cls } = map[status];
  return <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] ${cls}`} data-save-status={status} role="status" aria-live="polite">{status === "saving" ? <Loader2 size={11} className="animate-spin" /> : status === "saved" ? <Check size={11} /> : null}{text}</span>;
}

function stateChip(state: AnswerState | "untouched") {
  const cls = state === "complete" ? "bg-emerald-500/20 text-emerald-200" : state === "unsure" ? "bg-amber-500/20 text-amber-200" : state === "draft" ? "bg-cyan-500/15 text-cyan-200" : "bg-slate-800 text-slate-400";
  return <span className={`rounded-full px-1.5 py-0.5 text-[10px] ${cls}`}>{stateLabel(state)}</span>;
}

export function LabelingWorkbench({ taskId, timings = DEFAULT_TIMINGS }: { taskId: string; timings?: WorkbenchTimings }) {
  const [entry, setEntry] = useState<EntryInfo | null>(null);
  const [read, setRead] = useState<SessionRead | null>(null);
  const [session, setSession] = useState<SessionSummary | null>(null);
  const [stageContent, setStageContent] = useState<{ B?: StageRead<StageBContent>; C?: StageRead<StageCContent> }>({});
  const [answers, setAnswers] = useState<Record<Stage, Record<string, SavedAnswer>>>({ A: {}, B: {}, C: {} });
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [saves, setSaves] = useState<Record<string, SaveInfo>>({});
  const [stage, setStage] = useState<Stage>("A");
  const [index, setIndex] = useState(0);
  const [whoami, setWhoami] = useState<WhoAmI | null>(null);
  const [operatorKey, setOperatorKey] = useState("");
  const [keyInput, setKeyInput] = useState("");
  const [credentialNotice, setCredentialNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [refusal, setRefusal] = useState<CommitRefusal | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [revising, setRevising] = useState<{ itemId: string; answer: StageAAnswer; note: string; errors: FieldError[] } | null>(null);
  const [exportsDone, setExportsDone] = useState<Record<string, ExportResult | { error: string }>>({});
  const [rebindConfirm, setRebindConfirm] = useState(false);

  const draftsRef = useRef(drafts);
  const answersRef = useRef(answers);
  const sessionRef = useRef(session);
  const keyRef = useRef(operatorKey);
  const timers = useRef(new Map<string, number>());
  // Latest acknowledged revision per answer, kept in step synchronously so a
  // save queued behind another never names a revision the server has moved past.
  const revisionsRef = useRef<Record<string, number>>({});
  // The revision a dirty draft was built on. A session refresh (Reload, a
  // commit or export elsewhere on the page, a stale-session reload) may learn
  // a newer server revision while the typed text stays on screen; the draft
  // keeps naming the revision it actually saw, so its save is refused as
  // stale instead of silently overwriting what another device wrote. Only
  // an acknowledged save or an explicit conflict resolution moves it.
  const draftBaseRef = useRef<Record<string, number | null>>({});
  const inFlight = useRef(new Map<string, Promise<boolean>>());
  draftsRef.current = drafts;
  answersRef.current = answers;
  sessionRef.current = session;
  keyRef.current = operatorKey;
  const noteRevision = (s: Stage, a: SavedAnswer) => { revisionsRef.current[keyOf(s, a.item_id)] = a.revision; };

  // ---------------------------------------------------------------- loading

  const loadSession = useCallback(async (sessionId: string, keepDrafts = false) => {
    const data = await labelingApi.session(sessionId);
    const sameSession = sessionRef.current?.id === sessionId;
    setRead(data);
    setSession(data.session);
    const next: Record<Stage, Record<string, SavedAnswer>> = { A: {}, B: {}, C: {} };
    for (const s of STAGES) for (const a of data.answers[s] ?? []) next[s][a.item_id] = a;
    // A dirty draft whose base the server has moved past is a conflict the
    // moment the refresh shows it: flagged here, and its autosave is refused
    // as stale anyway because the save names the draft's own base revision.
    const flagConflicts = (s: Stage, list: SavedAnswer[]) => {
      for (const a of list) {
        const key = keyOf(s, a.item_id);
        const draft = draftsRef.current[key];
        if (draft?.dirty && draftBaseRef.current[key] !== a.revision && !inFlight.current.has(key)) {
          setSave(key, { status: "stale", message: "This passage was saved from another device or tab after you loaded it", current: a });
        }
      }
    };
    if (!sameSession) {
      // A different session (first load, or the successor after a rebind):
      // nothing from the previous one may linger, least of all Part B or C
      // content that the new session has not revealed yet.
      revisionsRef.current = {};
      draftBaseRef.current = {};
      inFlight.current.clear();
      setStageContent({});
      setAnswers(next);
      setDrafts({});
      setSaves({});
    } else {
      // The session read carries Stage A (and any unlocked later stage);
      // revealed stages are refreshed below from their own read.
      setAnswers(prev => ({ A: next.A, B: { ...prev.B, ...next.B }, C: { ...prev.C, ...next.C } }));
      if (!keepDrafts) {
        // A plain reload mirrors the server record, except for text typed
        // and not yet acknowledged: that stays on screen with its chip, so a
        // commit or export elsewhere on the page never discards it.
        setDrafts(prev => Object.fromEntries(Object.entries(prev).filter(([, d]) => d.dirty)));
        setSaves(prev => Object.fromEntries(Object.entries(prev).filter(([k]) => draftsRef.current[k]?.dirty)));
      }
      for (const s of STAGES) flagConflicts(s, data.answers[s] ?? []);
    }
    for (const s of STAGES) for (const a of data.answers[s] ?? []) noteRevision(s, a);
    // Already-revealed later stages reload without changing their provenance.
    for (const s of ["B", "C"] as const) {
      if (data.session.stages[s].revealed_at && data.session.progress?.[s].unlocked) {
        const content = await labelingApi.stage<StageBContent | StageCContent>(sessionId, s);
        setStageContent(prev => ({ ...prev, [s]: content }));
        setAnswers(prev => ({ ...prev, [s]: Object.fromEntries(content.answers.map(a => [a.item_id, a])) }));
        if (sameSession) flagConflicts(s, content.answers);
        for (const a of content.answers) noteRevision(s, a);
      }
    }
    return data;
  }, []);

  const load = useCallback(async (keepDrafts = false) => {
    setLoading(true);
    try {
      const [info, who] = await Promise.all([labelingApi.entry(taskId), labelingApi.whoami().catch(() => null)]);
      setEntry(info);
      setWhoami(who);
      if (info.linked && info.session) await loadSession(info.session.id, keepDrafts);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [taskId, loadSession]);

  useEffect(() => {
    setOperatorKey(readOperatorKey());
    void load();
  }, [load]);

  // ----------------------------------------------------------------- items

  const itemsA = useMemo<ItemA[]>(() => (read ? read.stageA.provisions.flatMap(p => p.rows.map(row => ({ kind: "A" as const, id: row.id, row, provision: p }))) : []), [read]);
  const itemsB = useMemo<ItemB[]>(() => (stageContent.B?.content.items ?? []).map(item => ({ kind: "B" as const, id: item.id, item })), [stageContent.B]);
  const itemsC = useMemo<ItemC[]>(() => (stageContent.C?.content.items ?? []).map(item => ({ kind: "C" as const, id: item.id, item })), [stageContent.C]);
  const items: Item[] = stage === "A" ? itemsA : stage === "B" ? itemsB : itemsC;
  const current = items[index] ?? null;
  const committedStage = Boolean(session?.stages[stage].committed_at);

  const draftFor = (s: Stage, id: string): Draft => {
    const existing = drafts[keyOf(s, id)];
    if (existing) return existing;
    const saved = answers[s][id];
    const answer: AnyAnswer = s === "A" ? editableStageA(saved?.answer as StageAAnswer | undefined) : saved ? (saved.answer as AnyAnswer) : s === "B" ? emptyStageB() : emptyStageC();
    return { answer, unsure: saved?.state === "unsure", dirty: false, version: 0 };
  };
  const stateFor = (s: Stage, id: string): AnswerState | "untouched" => {
    const d = drafts[keyOf(s, id)];
    if (d?.dirty) return d.unsure ? "unsure" : "draft";
    return answers[s][id]?.state ?? "untouched";
  };

  // Land on the first passage that still needs work, once per load.
  const landed = useRef<string | null>(null);
  useEffect(() => {
    if (!session || !read || landed.current === session.id) return;
    landed.current = session.id;
    const params = new URLSearchParams(window.location.search);
    const wantStage = params.get("stage") as Stage | null;
    const wantItem = params.get("item");
    const working = STAGES.find(s => !session.stages[s].committed_at) ?? "C";
    const s = wantStage && STAGES.includes(wantStage) && session.progress?.[wantStage].unlocked ? wantStage : working;
    setStage(s);
    const list = s === "A" ? read.stageA.provisions.flatMap(p => p.rows.map(r => r.id)) : [];
    const firstOpen = list.findIndex(id => (answers.A[id]?.state ?? "untouched") !== "complete");
    const wanted = wantItem ? list.indexOf(wantItem) : -1;
    setIndex(wanted >= 0 ? wanted : firstOpen >= 0 ? firstOpen : 0);
  }, [session, read, answers.A]);

  useEffect(() => {
    if (!current) return;
    const url = new URL(window.location.href);
    url.searchParams.set("stage", stage);
    url.searchParams.set("item", current.id);
    window.history.replaceState(null, "", url.toString());
  }, [stage, current]);

  // ---------------------------------------------------------------- saving

  const setSave = (key: string, info: SaveInfo) => setSaves(prev => ({ ...prev, [key]: info }));

  const persistNow = useCallback(async (s: Stage, id: string, force: boolean, baseRevision: number | null | undefined, keepalive: boolean) => {
    const key = keyOf(s, id);
    const draft = draftsRef.current[key];
    const sess = sessionRef.current;
    if (!draft || !sess || (!draft.dirty && !force)) return true;
    const version = draft.version;
    setSave(key, { status: "saving" });
    try {
      // An explicit base (a deliberate overwrite) wins; otherwise a dirty
      // draft names the revision it was built on, never one learnt later.
      const base = baseRevision !== undefined ? baseRevision : key in draftBaseRef.current ? draftBaseRef.current[key] : revisionsRef.current[key] ?? answersRef.current[s][id]?.revision ?? null;
      const res = await labelingApi.saveAnswer(sess.id, s, id, { packet_sha256: sess.packet_sha256, base_revision: base, state: draft.unsure ? "unsure" : "draft", answer: draft.answer }, keyRef.current, keepalive ? { keepalive: true } : {});
      noteRevision(s, res.answer);
      draftBaseRef.current[key] = res.answer.revision;
      setAnswers(prev => ({ ...prev, [s]: { ...prev[s], [id]: res.answer } }));
      setSession(res.session);
      setDrafts(prev => {
        const latest = prev[key];
        if (!latest || latest.version !== version) return prev; // typed again meanwhile: stays dirty
        return { ...prev, [key]: { ...latest, dirty: false } };
      });
      setSave(key, { status: "saved", at: res.saved_at });
      return true;
    } catch (err) {
      if (err instanceof LabelingApiError && err.code === "stale_write") {
        setSave(key, { status: "stale", message: err.message, current: (err.body.current as SavedAnswer | null) ?? null });
      } else if (err instanceof LabelingApiError && (err.status === 401 || err.status === 403 || err.status === 503)) {
        setSave(key, { status: "error", message: err.message });
        setCredentialNotice(err.message);
      } else if (err instanceof LabelingApiError && (err.code === "packet_changed" || err.code === "packet_mismatch")) {
        setSave(key, { status: "error", message: err.message });
        void load(true); // surfaces the packet conflict; the unsaved text stays on screen
      } else {
        setSave(key, { status: "error", message: errorMessage(err) });
      }
      return false;
    }
  }, [load]);

  // Saves of one answer run one after another: a second edit made while the
  // first save is in the air waits for its acknowledgment and then names the
  // revision that acknowledgment returned, so the server never sees two
  // writes claiming the same base revision.
  const persist = useCallback((s: Stage, id: string, force = false, baseRevision?: number | null, keepalive = false) => {
    const key = keyOf(s, id);
    const previous = inFlight.current.get(key);
    // With nothing in the air the request starts at once (a keepalive flush
    // on unload must not wait for a later tick); otherwise it queues.
    const run = previous ? previous.catch(() => false).then(() => persistNow(s, id, force, baseRevision, keepalive)) : persistNow(s, id, force, baseRevision, keepalive);
    inFlight.current.set(key, run);
    void run.finally(() => { if (inFlight.current.get(key) === run) inFlight.current.delete(key); });
    return run;
  }, [persistNow]);

  const schedule = useCallback((s: Stage, id: string) => {
    const key = keyOf(s, id);
    const pending = timers.current.get(key);
    if (pending) window.clearTimeout(pending);
    timers.current.set(key, window.setTimeout(() => { timers.current.delete(key); void persist(s, id); }, timings.autosaveMs));
  }, [persist, timings.autosaveMs]);

  // Leaving the page (navigation within the app, or closing the tab) must not
  // lose text that was typed but not yet acknowledged: pending autosaves are
  // sent at once with keepalive, and the browser warns before unloading.
  const flushPendingRef = useRef<(keepalive: boolean) => void>(() => {});
  flushPendingRef.current = (keepalive: boolean) => {
    for (const [key, t] of timers.current.entries()) {
      window.clearTimeout(t);
      timers.current.delete(key);
      const colon = key.indexOf(":");
      void persist(key.slice(0, colon) as Stage, key.slice(colon + 1), false, undefined, keepalive);
    }
  };
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      const pending = Object.values(draftsRef.current).some(d => d.dirty);
      if (!pending) return;
      flushPendingRef.current(true);
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => {
      window.removeEventListener("beforeunload", warn);
      flushPendingRef.current(true);
    };
  }, []);

  const updateDraft = (s: Stage, id: string, patch: Partial<Pick<Draft, "answer" | "unsure">>) => {
    const key = keyOf(s, id);
    // The first edit after a clean state pins the revision the draft starts
    // from; later edits of the same dirty draft keep it.
    if (!draftsRef.current[key]?.dirty && !(key in draftBaseRef.current && inFlight.current.has(key))) {
      draftBaseRef.current[key] = revisionsRef.current[key] ?? answersRef.current[s][id]?.revision ?? null;
    }
    setDrafts(prev => {
      const base = prev[key] ?? draftFor(s, id);
      return { ...prev, [key]: { ...base, ...patch, dirty: true, version: base.version + 1 } };
    });
    setSave(key, { status: "unsaved" });
    schedule(s, id);
  };

  const flushAll = async () => {
    for (const t of timers.current.values()) window.clearTimeout(t);
    timers.current.clear();
    let ok = true;
    for (const [key, draft] of Object.entries(draftsRef.current)) {
      if (!draft.dirty) continue;
      const colon = key.indexOf(":");
      ok = (await persist(key.slice(0, colon) as Stage, key.slice(colon + 1))) && ok;
    }
    return ok;
  };

  // The only two ways a conflicted draft moves on: "keep mine" deliberately
  // names the revision it is overwriting; "theirs" drops the draft.
  const resolveStale = (s: Stage, id: string, keepMine: boolean) => {
    const key = keyOf(s, id);
    const info = saves[key];
    if (info?.current) {
      noteRevision(s, info.current);
      setAnswers(prev => ({ ...prev, [s]: { ...prev[s], [id]: info.current! } }));
    }
    if (keepMine) {
      const theirs = info?.current?.revision ?? revisionsRef.current[key] ?? null;
      draftBaseRef.current[key] = theirs;
      setSaves(prev => ({ ...prev, [key]: { status: "unsaved" } }));
      setDrafts(prev => ({ ...prev, [key]: { ...(prev[key] ?? draftFor(s, id)), dirty: true } }));
      void persist(s, id, true, theirs);
    } else {
      delete draftBaseRef.current[key];
      setDrafts(prev => { const next = { ...prev }; delete next[key]; return next; });
      setSaves(prev => ({ ...prev, [key]: { status: "idle" } }));
    }
  };

  // ------------------------------------------------------------- credentials

  const useKey = () => {
    const key = keyInput.trim();
    setOperatorKey(key);
    storeOperatorKey(key);
    setKeyInput("");
    setCredentialNotice(key ? "Operator credential set for this tab. Nothing is stored on the server." : null);
  };
  const forgetKey = () => { setOperatorKey(""); storeOperatorKey(""); setCredentialNotice("Operator credential cleared."); };
  const canWrite = Boolean(whoami?.operator_session) || Boolean(operatorKey);

  // ------------------------------------------------------------------ stages

  const start = async () => {
    setBusy("start");
    try {
      const res = await labelingApi.startSession(taskId, operatorKey);
      setNotice(res.created ? "Labeling session started. Every answer you save from here is kept on the server." : "Resumed your existing session.");
      await load();
    } catch (err) {
      if (err instanceof LabelingApiError && (err.status === 401 || err.status === 403 || err.status === 503)) setCredentialNotice(err.message);
      else setError(errorMessage(err));
    } finally { setBusy(null); }
  };

  const selectStage = (s: Stage) => {
    if (!session) return;
    if (s !== "A" && !session.progress?.[s].unlocked) return;
    setStage(s);
    setIndex(0);
    setReviewOpen(false);
  };

  const openStage = async (s: Stage) => {
    if (!session) return;
    if (s === "A") { selectStage("A"); return; }
    if (!session.progress?.[s].unlocked) return;
    if (!stageContent[s]) {
      setBusy(`open-${s}`);
      try {
        // The operator's own deliberate disclosure: the reveal is recorded
        // under the operator credential first, then the content is read.
        await labelingApi.reveal(session.id, s, { packet_sha256: session.packet_sha256 }, keyRef.current);
        const content = await labelingApi.stage<StageBContent | StageCContent>(session.id, s);
        setStageContent(prev => ({ ...prev, [s]: content }));
        setAnswers(prev => ({ ...prev, [s]: Object.fromEntries(content.answers.map(a => [a.item_id, a])) }));
        for (const a of content.answers) noteRevision(s, a);
        setSession(content.session);
      } catch (err) {
        if (err instanceof LabelingApiError && (err.status === 401 || err.status === 403 || err.status === 503) && err.code !== "stage_locked") setCredentialNotice(err.message);
        else setError(errorMessage(err));
        setBusy(null);
        return;
      }
      setBusy(null);
    }
    setStage(s);
    setIndex(0);
    setReviewOpen(false);
  };

  const commit = async () => {
    if (!session) return;
    setBusy("commit");
    setRefusal(null);
    try {
      const flushed = await flushAll();
      if (!flushed) { setNotice("Some answers are not saved yet; fix them before committing."); return; }
      const sess = sessionRef.current!;
      const res = await labelingApi.commit(sess.id, stage, { packet_sha256: sess.packet_sha256, expected_revision: sess.revision }, keyRef.current);
      setSession(res.session);
      setReviewOpen(false);
      setNotice(`${stageShort[stage]} committed ${fmt(res.commit.committed_at)}. Its answers are now frozen as the blind record.`);
      await loadSession(sess.id);
    } catch (err) {
      if (err instanceof LabelingApiError && err.code === "incomplete") setRefusal(err.body as unknown as CommitRefusal);
      else if (err instanceof LabelingApiError && err.code === "stale_session") { setNotice("The session changed from another device; it was reloaded, review again."); await loadSession(session.id); }
      else if (err instanceof LabelingApiError && (err.status === 401 || err.status === 403 || err.status === 503)) setCredentialNotice(err.message);
      else setError(errorMessage(err));
    } finally { setBusy(null); }
  };

  const recordRevision = async () => {
    if (!session || !revising) return;
    setBusy("revise");
    try {
      const res = await labelingApi.revise(session.id, revising.itemId, { packet_sha256: session.packet_sha256, answer: revising.answer, note: revising.note }, operatorKey);
      if (!res.validation.complete) { setRevising({ ...revising, errors: res.validation.errors }); setNotice("Revision recorded with open fields; it is marked incomplete."); } else setNotice(`Post-exposure revision recorded ${fmt(res.revision.created_at)}. The blind baseline is unchanged.`);
      setRevising(null);
      await loadSession(session.id);
    } catch (err) {
      if (err instanceof LabelingApiError && (err.status === 401 || err.status === 403 || err.status === 503)) setCredentialNotice(err.message);
      else setError(errorMessage(err));
    } finally { setBusy(null); }
  };

  const exportKind = async (kind: string) => {
    if (!session) return;
    setBusy(`export-${kind}`);
    try {
      const res = await labelingApi.exportKind(session.id, kind, { packet_sha256: session.packet_sha256 }, operatorKey);
      setExportsDone(prev => ({ ...prev, [kind]: res }));
      await loadSession(session.id);
    } catch (err) {
      setExportsDone(prev => ({ ...prev, [kind]: { error: errorMessage(err) } }));
      if (err instanceof LabelingApiError && (err.status === 401 || err.status === 403 || err.status === 503)) setCredentialNotice(err.message);
    } finally { setBusy(null); }
  };

  const rebind = async () => {
    if (!session?.packet_conflict) return;
    setBusy("rebind");
    try {
      const res = await labelingApi.rebind(session.id, { confirm: true, from_packet_sha256: session.packet_conflict.session_packet_sha256, to_packet_sha256: session.packet_conflict.current_packet_sha256 }, operatorKey);
      setNotice(`Rebound to packet ${shortSha(res.session.packet_sha256)}: ${res.carried} answers carried over as drafts for you to re-check. The earlier session is kept.`);
      setRebindConfirm(false);
      landed.current = null;
      await load();
    } catch (err) {
      if (err instanceof LabelingApiError && (err.status === 401 || err.status === 403 || err.status === 503)) setCredentialNotice(err.message);
      else setError(errorMessage(err));
    } finally { setBusy(null); }
  };

  const goTo = (i: number) => { setIndex(Math.max(0, Math.min(items.length - 1, i))); setReviewOpen(false); setRevising(null); window.scrollTo({ top: 0 }); };

  // ------------------------------------------------------------------ render

  const backLink = <Link href={`/task/${taskId}`} className="inline-flex items-center gap-1 text-sm text-slate-400 hover:text-white"><ArrowLeft size={16} /> Back to the task</Link>;

  if (loading && !entry) return <div className="flex min-h-[40vh] items-center justify-center text-cyan-300"><Loader2 className="animate-spin" size={28} /></div>;
  if (!entry || !entry.linked) {
    return <div className="space-y-3 p-6">{backLink}<p className="text-slate-300">This task carries no labeling packet.</p>{error && <p className="text-rose-300">{error}</p>}</div>;
  }

  const credentialPanel = whoami && !whoami.operator_session && (
    <section className={`rounded-lg border p-4 ${operatorKey ? "border-emerald-500/30 bg-emerald-500/5" : "border-amber-500/40 bg-amber-500/5"}`} data-credential-panel={operatorKey ? "set" : "needed"}>
      <div className="flex items-start gap-3">
        <ShieldCheck size={18} className={`mt-0.5 shrink-0 ${operatorKey ? "text-emerald-300" : "text-amber-300"}`} />
        <div className="min-w-0 flex-1 text-sm">
          <p className={`font-semibold ${operatorKey ? "text-emerald-200" : "text-amber-200"}`}>{operatorKey ? "Operator credential set for this tab" : "Saving needs your operator credential on this device"}</p>
          <p className="mt-1 text-slate-300">This browser carries no verified Access session, and only you may record labels. Enter the operator approval credential; it stays in this tab, is sent only with saves, and is never written to the server.</p>
          {!whoami.operator_credential_configured && <p className="mt-1 text-rose-300">The server has no operator credential configured, so saves will be refused until it is set.</p>}
          <div className="mt-2 flex flex-wrap items-end gap-2">
            <label className="min-w-[220px] flex-1 text-xs text-slate-400">Operator approval credential
              <input type="password" autoComplete="off" value={keyInput} onChange={e => setKeyInput(e.target.value)} onKeyDown={e => { if (e.key === "Enter") useKey(); }} aria-label="Operator approval credential" className="mt-1 block w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100" data-operator-key />
            </label>
            <button type="button" onClick={useKey} disabled={!keyInput.trim()} className="rounded-md border border-cyan-500/50 bg-cyan-500/10 px-3 py-1.5 text-sm text-cyan-100 disabled:opacity-50" data-use-key>Use in this tab</button>
            {operatorKey && <button type="button" onClick={forgetKey} className="rounded-md border border-slate-600 px-3 py-1.5 text-sm text-slate-200">Forget</button>}
          </div>
          {credentialNotice && <p className="mt-2 text-xs text-amber-200" role="status" data-credential-notice>{credentialNotice}</p>}
        </div>
      </div>
    </section>
  );

  // Before the session exists: the explanation and the single Start action.
  if (!session) {
    const packet = entry.packet;
    return (
      <div className="mx-auto max-w-3xl space-y-4 p-4 sm:p-6">
        {backLink}
        <section className="rounded-lg border border-cyan-500/40 bg-cyan-500/5 p-5" data-start-card>
          <h2 className="text-xl font-semibold text-white">Blind labeling for the Groundrules gold set</h2>
          <p className="mt-2 text-sm text-slate-300">The scorer needs your own reading of each passage before any extractor output is shown. This guide takes one passage at a time; nothing is suggested, and every answer is saved on the server as you go.</p>
          {packet ? (
            <ul className="mt-3 grid gap-2 text-sm text-slate-200 sm:grid-cols-3">
              <li className="rounded-md border border-slate-800 bg-slate-950/60 p-3"><span className="font-semibold text-cyan-200">Stage A</span><br />{packet.counts.rows} passages in {packet.counts.provisions} provisions: modality, actor and exact spans, blind.</li>
              <li className="rounded-md border border-slate-800 bg-slate-950/60 p-3"><span className="font-semibold text-cyan-200">Stage B</span><br />{packet.counts.controls} control judgments, shown only after Stage A is committed.</li>
              <li className="rounded-md border border-slate-800 bg-slate-950/60 p-3"><span className="font-semibold text-cyan-200">Stage C</span><br />{packet.counts.pairs} original/mutant pairs, shown only after Stage B is committed.</li>
            </ul>
          ) : <p className="mt-3 text-sm text-rose-300">The packet could not be read{entry.packet_error ? `: ${entry.packet_error.message}` : ""}.</p>}
          {packet && <p className="mt-3 text-xs text-slate-500">Packet {shortSha(packet.sha256)} · roster {shortSha(packet.digests.rosterSha256)} · guideline {shortSha(packet.digests.guidelineSha256)} · controls {shortSha(packet.digests.controlsSha256)} · pairs {shortSha(packet.digests.vpuSha256)}. Your session binds to these exact digests.</p>}
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button type="button" onClick={start} disabled={!packet || busy === "start" || !canWrite} className="inline-flex items-center gap-2 rounded-lg border border-cyan-400/60 bg-cyan-500/20 px-4 py-2 text-sm font-semibold text-white hover:bg-cyan-500/30 disabled:opacity-50" data-start-labeling>
              {busy === "start" ? <Loader2 size={16} className="animate-spin" /> : <Unlock size={16} />} Start labeling
            </button>
            {!canWrite && <span className="text-xs text-amber-200">Enter the operator credential below to start.</span>}
          </div>
        </section>
        {credentialPanel}
        {error && <p className="rounded-md border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-200">{error}</p>}
        <RelatedTasks related={entry.related_tasks ?? []} />
      </div>
    );
  }

  const progress = session.progress ?? EMPTY_PROGRESS;
  const conflict = session.packet_conflict;
  const unlockedStages = STAGES.filter(s => progress[s].unlocked);
  const revealGate = stage !== "A" && !stageContent[stage];
  const currentKey = current ? keyOf(stage, current.id) : null;
  const currentDraft = current ? draftFor(stage, current.id) : null;
  const currentSaved = current ? answers[stage][current.id] : undefined;
  const currentErrors: FieldError[] = currentSaved && !drafts[currentKey!]?.dirty ? currentSaved.errors : [];
  const itemRevisions = current && stage === "A" ? (read?.revisions ?? []).filter(r => r.item_id === current.id) : [];

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4 pb-28 sm:p-6 lg:pb-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {backLink}
        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
          {whoami?.operator_session ? <span className="rounded-full border border-emerald-500/40 px-2 py-0.5 text-emerald-200">Operator session</span> : operatorKey ? <span className="rounded-full border border-emerald-500/40 px-2 py-0.5 text-emerald-200">Operator credential set</span> : <span className="rounded-full border border-amber-500/50 px-2 py-0.5 text-amber-200">No write credential</span>}
          <span>packet {shortSha(session.packet_sha256)}</span>
          <button type="button" onClick={() => void load()} className="inline-flex items-center gap-1 rounded-md border border-slate-700 px-2 py-0.5 hover:text-white" aria-label="Reload from the server"><RefreshCw size={12} /> Reload</button>
        </div>
      </div>

      <header className="space-y-3 rounded-lg border border-slate-800 bg-slate-900/40 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold text-white">Blind labeling</h2>
          <p className="text-xs text-slate-500">Session {session.id.slice(0, 8)} · started {fmt(session.created_at)} · last change {fmt(session.updated_at)}</p>
        </div>
        <nav className="grid gap-2 sm:grid-cols-3" aria-label="Stages">
          {STAGES.map(s => {
            const p = progress[s];
            const active = s === stage;
            const done = Boolean(p.committed_at);
            return (
              <button key={s} type="button" onClick={() => selectStage(s)} disabled={!p.unlocked || busy === `open-${s}`} aria-current={active ? "step" : undefined}
                className={`rounded-md border px-3 py-2 text-left text-sm disabled:cursor-not-allowed disabled:opacity-60 ${active ? "border-cyan-500/60 bg-cyan-500/10" : "border-slate-800 bg-slate-950/40 hover:border-slate-600"}`} data-stage-tab={s} data-stage-unlocked={p.unlocked}>
                <span className="flex items-center gap-2 font-semibold text-slate-100">{p.unlocked ? (done ? <Check size={14} className="text-emerald-300" /> : <Unlock size={14} className="text-cyan-300" />) : <Lock size={14} className="text-slate-500" />}{stageTitle[s]}</span>
                <span className="block text-xs text-slate-400" data-stage-progress={s}>{done ? `committed ${fmt(p.committed_at)}` : p.unlocked ? `${p.complete} of ${p.total} complete · ${p.draft} draft · ${p.unsure} unsure · ${p.untouched} not started` : `locked until ${stageShort[s === "B" ? "A" : "B"]} is committed`}</span>
              </button>
            );
          })}
        </nav>
      </header>

      {conflict && (
        <section className="rounded-lg border border-rose-500/50 bg-rose-500/10 p-4 text-sm" data-packet-conflict>
          <p className="flex items-center gap-2 font-semibold text-rose-200"><AlertTriangle size={16} /> The packet on disk changed since this session started</p>
          <p className="mt-1 text-rose-100/90">{conflict.message}</p>
          <p className="mt-1 text-xs text-rose-200/70">Session packet {shortSha(conflict.session_packet_sha256)} · current packet {shortSha(conflict.current_packet_sha256)}. Saves are refused until you decide.</p>
          <label className="mt-2 flex items-center gap-2 text-rose-100"><input type="checkbox" checked={rebindConfirm} onChange={e => setRebindConfirm(e.target.checked)} className="accent-rose-400" /> I understand: a new session bound to the current packet is created, every answer is carried over as a draft to re-check, and this session is kept as it is.</label>
          <button type="button" disabled={!rebindConfirm || busy === "rebind"} onClick={rebind} className="mt-2 rounded-md border border-rose-400/60 bg-rose-500/20 px-3 py-1.5 text-sm text-white disabled:opacity-50" data-rebind>Rebind to the current packet</button>
        </section>
      )}
      {credentialPanel}
      {notice && <p className="rounded-md border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm text-emerald-100" role="status" data-notice>{notice}</p>}
      {error && <p className="rounded-md border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-200" role="alert">{error}</p>}

      <div className="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
        <aside className="lg:sticky lg:top-20 lg:self-start">
          <details className="rounded-lg border border-slate-800 bg-slate-900/40 lg:open" open data-progress-index>
            <summary className="cursor-pointer px-3 py-2 text-sm font-semibold text-slate-200">{stageShort[stage]} index · {progress[stage].complete}/{progress[stage].total} complete</summary>
            <ol className="custom-scrollbar max-h-[60vh] overflow-auto border-t border-slate-800 p-2 text-sm">
              {items.map((it, i) => {
                const st = stateFor(stage, it.id);
                const label = it.kind === "A" ? `${it.provision.citation} · ${it.row.label}` : it.kind === "B" ? `${it.item.id} · ${it.item.form}` : `${it.item.id} · ${it.item.label}`;
                return (
                  <li key={it.id}>
                    <button type="button" onClick={() => goTo(i)} aria-current={i === index ? "true" : undefined} className={`flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left hover:bg-slate-800/60 ${i === index ? "bg-cyan-500/10 text-cyan-100" : "text-slate-300"}`} data-index-item={it.id} data-index-state={st}>
                      <span className="min-w-0 truncate"><span className="mr-1 text-slate-500">{i + 1}.</span>{label}</span>
                      {stateChip(st)}
                    </button>
                  </li>
                );
              })}
              {revealGate && <li className="px-2 py-1.5 text-xs text-slate-500">Open the stage to list its items.</li>}
            </ol>
          </details>
          <RelatedTasks related={read?.related_tasks ?? []} compact />
        </aside>

        <section className="min-w-0 space-y-4">
          {revealGate ? (
            <div className="rounded-lg border border-cyan-500/40 bg-cyan-500/5 p-5 text-sm" data-reveal-gate={stage}>
              <h3 className="text-lg font-semibold text-white">{stageTitle[stage]}</h3>
              <p className="mt-2 text-slate-300">{stage === "B" ? `Opening this stage shows ${progress.B.total} proposed labels for passages you already labelled. Your Stage A answers are committed and frozen; the moment you open Part B is recorded as the exposure time.` : `Opening this stage shows ${progress.C.total} original/mutant pairs. The moment you open Part C is recorded as the exposure time.`}</p>
              <button type="button" onClick={() => void openStage(stage)} disabled={busy === `open-${stage}`} className="mt-3 inline-flex items-center gap-2 rounded-lg border border-cyan-400/60 bg-cyan-500/20 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50" data-open-stage={stage}>{busy === `open-${stage}` ? <Loader2 size={16} className="animate-spin" /> : <Unlock size={16} />} Open {stageTitle[stage]}</button>
            </div>
          ) : reviewOpen ? (
            <CommitReview stage={stage} items={items} stateFor={stateFor} refusal={refusal} busy={busy === "commit"} onJump={goTo} onCommit={commit} onClose={() => setReviewOpen(false)} session={session} answers={answers[stage]} drafts={drafts} />
          ) : current && currentDraft ? (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2">
                <p className="text-sm text-slate-300" data-position>{stage === "A" ? "Passage" : stage === "B" ? "Fixture" : "Pair"} {index + 1} of {items.length}</p>
                <div className="flex items-center gap-2">
                  <SaveChip info={saves[currentKey!]} dirty={Boolean(drafts[currentKey!]?.dirty)} />
                  {committedStage && <span className="rounded-full border border-emerald-500/40 px-2 py-0.5 text-[11px] text-emerald-200" data-frozen>committed, frozen</span>}
                </div>
                <div className="flex items-center gap-1">
                  <button type="button" onClick={() => goTo(index - 1)} disabled={index === 0} className="inline-flex items-center gap-1 rounded-md border border-slate-700 px-2 py-1 text-sm text-slate-200 disabled:opacity-40" data-prev><ChevronLeft size={14} /> Previous</button>
                  <button type="button" onClick={() => goTo(index + 1)} disabled={index >= items.length - 1} className="inline-flex items-center gap-1 rounded-md border border-slate-700 px-2 py-1 text-sm text-slate-200 disabled:opacity-40" data-next>Next <ChevronRight size={14} /></button>
                </div>
              </div>

              {saves[currentKey!]?.status === "stale" && (
                <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm text-amber-100" data-stale-write>
                  <p>This passage was saved from another device or tab after you loaded it. Nothing was overwritten.</p>
                  {saves[currentKey!]?.current && <p className="mt-1 text-xs text-amber-200/80">Their version: {stateLabel(saves[currentKey!]!.current!.state)}, saved {fmt(saves[currentKey!]!.current!.updated_at)}.</p>}
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button type="button" onClick={() => resolveStale(stage, current.id, false)} className="rounded-md border border-slate-600 px-2 py-1 text-xs text-slate-100" data-stale-theirs>Load their version</button>
                    <button type="button" onClick={() => resolveStale(stage, current.id, true)} className="rounded-md border border-amber-400/60 px-2 py-1 text-xs text-amber-100" data-stale-mine>Keep mine and save over it</button>
                  </div>
                </div>
              )}

              <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-4">
                {current.kind === "A" && (
                  <StageAForm row={current.row} provision={current.provision} value={currentDraft.answer as StageAAnswer} errors={currentErrors} readOnly={committedStage} unsure={currentDraft.unsure}
                    onChange={next => updateDraft("A", current.id, { answer: next })} onUnsureChange={v => updateDraft("A", current.id, { unsure: v })} idPrefix={`a-${index}`} />
                )}
                {current.kind === "B" && (
                  <StageBForm item={current.item} row={stageContent.B?.committed_rows?.[current.item.rowId]?.row ?? null} committed={stageContent.B?.committed_rows?.[current.item.rowId]?.answer ?? null}
                    value={currentDraft.answer as StageBAnswer} errors={currentErrors} readOnly={committedStage} unsure={currentDraft.unsure}
                    onChange={next => updateDraft("B", current.id, { answer: next })} onUnsureChange={v => updateDraft("B", current.id, { unsure: v })} idPrefix={`b-${index}`} />
                )}
                {current.kind === "C" && (
                  <StageCForm item={current.item} value={currentDraft.answer as StageCAnswer} errors={currentErrors} readOnly={committedStage} unsure={currentDraft.unsure}
                    onChange={next => updateDraft("C", current.id, { answer: next })} onUnsureChange={v => updateDraft("C", current.id, { unsure: v })} idPrefix={`c-${index}`} />
                )}
              </div>

              {stage === "A" && committedStage && current.kind === "A" && (
                <section className="rounded-lg border border-slate-800 bg-slate-900/40 p-4 text-sm" data-revisions>
                  <h4 className="font-semibold text-slate-100">After exposure</h4>
                  <p className="mt-1 text-xs text-slate-400">The reading above is your blind baseline, committed {fmt(session.stages.A.committed_at)}. A change of mind after seeing Part B or C is recorded beside it, never over it.</p>
                  {itemRevisions.length > 0 && (
                    <ul className="mt-2 space-y-2">
                      {itemRevisions.map(rev => (
                        <li key={rev.id} className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2" data-revision>
                          <p className="text-xs text-amber-200">Revised {fmt(rev.created_at)} after exposure to {rev.exposure.after_exposure_to.join(" and ") || "nothing yet"} · not blind{rev.errors.length ? " · incomplete" : ""}</p>
                          <CommittedReading answer={rev.answer} />
                          {rev.note && <p className="mt-1 text-xs text-slate-300">note: {rev.note}</p>}
                        </li>
                      ))}
                    </ul>
                  )}
                  {revising?.itemId === current.id ? (
                    <div className="mt-3 space-y-3 rounded-md border border-amber-500/40 p-3" data-revision-form>
                      <StageAForm row={current.row} provision={current.provision} value={revising.answer} errors={revising.errors} readOnly={false} unsure={false} onUnsureChange={() => undefined} onChange={next => setRevising({ ...revising, answer: next })} idPrefix={`rev-${index}`} />
                      <label className="block text-sm text-slate-200">Why you changed your reading
                        <textarea value={revising.note} onChange={e => setRevising({ ...revising, note: e.target.value })} rows={2} className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100" />
                      </label>
                      <div className="flex gap-2">
                        <button type="button" onClick={recordRevision} disabled={busy === "revise"} className="rounded-md border border-amber-400/60 bg-amber-500/20 px-3 py-1.5 text-sm text-white disabled:opacity-50" data-record-revision>Record post-exposure revision</button>
                        <button type="button" onClick={() => setRevising(null)} className="rounded-md border border-slate-600 px-3 py-1.5 text-sm text-slate-200">Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <button type="button" onClick={() => setRevising({ itemId: current.id, answer: editableStageA(currentSaved?.answer as StageAAnswer | undefined), note: "", errors: [] })} className="mt-2 rounded-md border border-slate-600 px-3 py-1.5 text-sm text-slate-200 hover:border-amber-400/60" data-revise>Revise after exposure</button>
                  )}
                </section>
              )}
            </>
          ) : <p className="text-sm text-slate-400">Nothing to show for this stage.</p>}

          {!revealGate && !committedStage && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-800 bg-slate-900/40 p-3">
              <p className="text-xs text-slate-400">Drafts and unsure passages save as you go but never count as complete. Committing is explicit and freezes the stage.</p>
              <button type="button" onClick={() => { setRefusal(null); setReviewOpen(v => !v); }} className="rounded-md border border-emerald-500/50 bg-emerald-500/10 px-3 py-1.5 text-sm font-semibold text-emerald-100 hover:bg-emerald-500/20" data-open-review>{reviewOpen ? "Back to the passages" : `Review and commit ${stageShort[stage]}`}</button>
            </div>
          )}

          {unlockedStages.length > 0 && <ExportPanel session={session} read={read} results={exportsDone} busy={busy} onExport={exportKind} />}
        </section>
      </div>

      {current && !revealGate && !reviewOpen && (
        <div className="fixed inset-x-0 bottom-0 z-40 flex items-center justify-between gap-2 border-t border-slate-800 bg-slate-950/95 px-4 py-2 backdrop-blur lg:hidden" data-mobile-nav>
          <button type="button" onClick={() => goTo(index - 1)} disabled={index === 0} className="inline-flex items-center gap-1 rounded-md border border-slate-700 px-3 py-2 text-sm text-slate-200 disabled:opacity-40"><ChevronLeft size={14} /> Prev</button>
          <SaveChip info={saves[currentKey!]} dirty={Boolean(drafts[currentKey!]?.dirty)} />
          <button type="button" onClick={() => goTo(index + 1)} disabled={index >= items.length - 1} className="inline-flex items-center gap-1 rounded-md border border-slate-700 px-3 py-2 text-sm text-slate-200 disabled:opacity-40">Next <ChevronRight size={14} /></button>
        </div>
      )}
    </div>
  );
}

function RelatedTasks({ related, compact = false }: { related: { id: string; role: string }[]; compact?: boolean }) {
  if (!related.length) return null;
  return (
    <section className={`rounded-lg border border-slate-800 bg-slate-900/40 ${compact ? "mt-3 p-3" : "p-4"} text-sm`} data-related-tasks>
      <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Related tasks</h4>
      <ul className="mt-1 space-y-1">
        {related.map(t => <li key={t.id}><Link href={`/task/${t.id}`} className="text-cyan-300 hover:underline">{t.role}</Link> <span className="font-mono text-[10px] text-slate-500">{t.id.slice(0, 8)}</span></li>)}
      </ul>
    </section>
  );
}

/** Shown wherever a Stage A record is about to be frozen or exported after Part B or C was already seen (a rebind after a reveal). */
function NotBlindNotice({ session }: { session: SessionSummary }) {
  if (session.blind !== false) return null;
  const seen = (["B", "C"] as const).filter(s => session.exposure_before_a[s]).map(s => `${stageShort[s]} (${new Date(session.exposure_before_a[s]!).toLocaleString()})`);
  return (
    <p className="mt-2 rounded-md border border-amber-400/50 bg-amber-500/10 p-3 text-sm text-amber-100" data-not-blind>
      This session inherits exposure from the one it replaced: {seen.join(" and ")} had already been shown. Its Stage A record is still yours, but it is not blind, and the labels export will say so.
    </p>
  );
}

function CommitReview({ stage, items, stateFor, refusal, busy, onJump, onCommit, onClose, answers, drafts, session }: {
  stage: Stage; items: Item[]; stateFor: (s: Stage, id: string) => AnswerState | "untouched"; refusal: CommitRefusal | null; busy: boolean;
  onJump: (i: number) => void; onCommit: () => void; onClose: () => void; answers: Record<string, SavedAnswer>; drafts: Record<string, Draft>; session: SessionSummary;
}) {
  const states = items.map(it => stateFor(stage, it.id));
  const open = states.filter(s => s !== "complete").length;
  const summary = (it: Item): string => {
    const saved = answers[it.id];
    const draft = drafts[keyOf(stage, it.id)];
    const a = (draft?.dirty ? draft.answer : saved?.answer) as AnyAnswer | undefined;
    if (!a) return "nothing entered";
    if (it.kind === "A") { const x = a as StageAAnswer; return `${x.modality || "modality?"} · actor "${x.actor.quote || "?"}" · ${x.propositionsDeclared === "none" ? "no propositions" : `${x.propositions.length} proposition${x.propositions.length === 1 ? "" : "s"}`}`; }
    if (it.kind === "B") return `verdict: ${(a as StageBAnswer).verdict || "?"}`;
    const c = a as StageCAnswer; return `same outcome: ${c.exampleOutcomeSame || "?"} · meaning: ${c.meaning || "?"}`;
  };
  return (
    <section className="rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-4" data-commit-review={stage}>
      <h3 className="text-lg font-semibold text-white">Review before committing {stageShort[stage]}</h3>
      <p className="mt-1 text-sm text-slate-300">{open === 0 ? `All ${items.length} items are complete. Committing freezes them as the record for this stage; after that, changes are recorded as separate post-exposure revisions.` : `${open} of ${items.length} items still need work. Drafts and unsure items are kept, but the stage cannot be committed until each one is complete.`}</p>
      {stage === "A" && <NotBlindNotice session={session} />}
      {refusal && (
        <div className="mt-2 rounded-md border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-100" data-commit-refusal>
          <p>{refusal.error}</p>
          <ul className="mt-1 list-disc pl-5 text-xs">
            {refusal.missing.map(id => <li key={`m-${id}`}>{id}: not started</li>)}
            {refusal.unsure.map(id => <li key={`u-${id}`}>{id}: marked unsure</li>)}
            {refusal.invalid.map(x => <li key={`i-${x.item_id}`}>{x.item_id}: {x.errors.map(e => e.message).join(" ")}</li>)}
          </ul>
        </div>
      )}
      <ol className="mt-3 space-y-1 text-sm">
        {items.map((it, i) => (
          <li key={it.id} className="flex items-center justify-between gap-2 rounded-md border border-slate-800 bg-slate-950/50 px-2 py-1.5" data-review-item={it.id} data-review-state={states[i]}>
            <button type="button" onClick={() => onJump(i)} className="min-w-0 flex-1 truncate text-left text-slate-200 hover:text-cyan-200"><span className="text-slate-500">{i + 1}.</span> {it.kind === "A" ? it.row.label : it.id} <span className="text-xs text-slate-400">· {summary(it)}</span></button>
            {stateChip(states[i])}
          </li>
        ))}
      </ol>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" onClick={onCommit} disabled={busy || open > 0} className="inline-flex items-center gap-2 rounded-md border border-emerald-400/60 bg-emerald-500/20 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50" data-commit>{busy ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Commit {stageShort[stage]}</button>
        <button type="button" onClick={onClose} className="rounded-md border border-slate-600 px-3 py-2 text-sm text-slate-200">Back to the passages</button>
      </div>
    </section>
  );
}

function ExportPanel({ session, read, results, busy, onExport }: { session: SessionSummary; read: SessionRead | null; results: Record<string, ExportResult | { error: string }>; busy: string | null; onExport: (kind: string) => void }) {
  const kinds: { kind: string; label: string; ready: boolean }[] = [
    { kind: "A", label: "Stage A labels", ready: Boolean(session.stages.A.committed_at) },
    { kind: "B", label: "Stage B judgments", ready: Boolean(session.stages.B.committed_at) },
    { kind: "C", label: "Stage C annotations", ready: Boolean(session.stages.C.committed_at) },
    { kind: "revisions", label: "Post-exposure revisions", ready: Boolean(session.stages.A.committed_at) && (read?.revisions.length ?? 0) > 0 },
  ];
  if (!kinds.some(k => k.ready)) return null;
  return (
    <details className="rounded-lg border border-slate-800 bg-slate-900/40 text-sm" data-export-panel>
      <summary className="cursor-pointer px-4 py-2 font-semibold text-slate-200">Hand the committed stages to the Groundrules scorer</summary>
      <div className="px-4"><NotBlindNotice session={session} /></div>
      <div className="space-y-2 border-t border-slate-800 px-4 py-3">
        <p className="text-xs text-slate-400">Each export writes the committed record as the scorer&apos;s own document at its fixed path under the gold set. A file this session did not write is never replaced.</p>
        {kinds.filter(k => k.ready).map(k => {
          const result = results[k.kind];
          const target = read?.export_targets[k.kind];
          const prior = read?.exports.filter(e => e.kind === k.kind) ?? [];
          return (
            <div key={k.kind} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-slate-800 bg-slate-950/50 p-2" data-export={k.kind}>
              <div className="min-w-0 text-xs">
                <p className="font-semibold text-slate-100">{k.label} <span className="font-mono text-slate-500">{target}</span></p>
                {prior.length > 0 && <p className="text-slate-400">last written {fmt(prior[prior.length - 1].exported_at)} · sha {shortSha(prior[prior.length - 1].sha256, 8)}</p>}
                {result && "error" in result && <p className="text-rose-300" data-export-error>{result.error}</p>}
                {result && !("error" in result) && <p className="text-emerald-200" data-export-result>{result.identical ? "Already on disk, byte for byte." : `Written · sha ${shortSha(result.export.sha256, 8)}`}{result.scorer_command ? ` · score with: ${result.scorer_command.replace(/^score with:\s*/i, "")}` : ""}</p>}
              </div>
              <button type="button" onClick={() => onExport(k.kind)} disabled={busy === `export-${k.kind}`} className="rounded-md border border-slate-600 px-3 py-1.5 text-xs text-slate-100 hover:border-cyan-500/50 disabled:opacity-50" data-export-button={k.kind}>{busy === `export-${k.kind}` ? "Writing…" : prior.length ? "Write again" : "Write to the gold set"}</button>
            </div>
          );
        })}
      </div>
    </details>
  );
}

/**
 * Client for the guided blind-labelling API (server/routes/groundrules-labeling.js)
 * plus the pieces the forms need locally: the anchor-rule quote resolver
 * (immediate "is this quote unique?" feedback, mirrored from
 * server/services/groundrules-labeling/quotes.js; the server re-checks every
 * save), neutral field definitions with examples that are NOT roster
 * passages, and the per-tab operator credential used on a device without an
 * Access session (the Mac app on localhost:3000). Reads go through the
 * ordinary `/api/*` proxy seam; writes add the operator bearer when one is
 * set. Nothing here is a system of record: every answer lives on the server.
 */
import { authFetch } from "./nexus/shared";

export type Stage = "A" | "B" | "C";
export const STAGES: Stage[] = ["A", "B", "C"];
export type AnswerState = "draft" | "unsure" | "complete";
export const UNKNOWN = "UNKNOWN";
export const MODALITIES = ["may", "shall", "must-not", "is"] as const;
export const CATEGORIES = ["condition", "exception", "negation"] as const;
export type Modality = (typeof MODALITIES)[number];
export type Category = (typeof CATEGORIES)[number];

export interface PacketContext { quote: string; sourceUnit: string | null; quotable: boolean }
export interface PacketRow { id: string; label: string; text: string; contexts: PacketContext[]; anchorWithin: string | null; citation?: string; provisionId?: string }
export interface PacketProvision { id: string; citation: string; topic: string; jurisdiction: string; sourceId: string; rows: PacketRow[] }
export interface StageAContent { title: string; provisions: PacketProvision[] }
export interface ProposedProposition { category: string; quote: string; numeric?: { value: number; unit: string; operator: string } | null; within?: string; sourceUnit?: string; note?: string }
export interface ControlItem { id: string; rowId: string; form: "single" | "pair"; ask: string; proposed: ProposedProposition | ProposedProposition[] }
export interface PairItem {
  id: string; rowId: string; citation: string; label: string; removedText: string; alsoReworded: string[]; sourceText: string;
  versions: { original: string[]; mutant: string[] }; example: { description: string; original: string; mutant: string }; ask: string;
}
export interface StageBContent { title: string; items: ControlItem[] }
export interface StageCContent { title: string; items: PairItem[] }

export interface NumericValue { value: number | string | null; unit: string; operator: string }
export interface Proposition { id: string; category: string; quote: string; source: string | number; within: string; numeric: NumericValue | null; note: string; resolved?: ResolvedSpan }
export interface ResolvedSpan { source: "row" | "context"; index: number | null; start: number; end: number; slice: string }
export interface StageAAnswer {
  modality: string; actor: { quote: string; source: string | number; within: string }; propositionsDeclared: "" | "none" | "some" | "UNKNOWN";
  propositions: Proposition[]; notes: string; actorResolved?: ResolvedSpan; carried_from?: { session_id: string; packet_sha256: string; state: string };
}
export interface StageBAnswer { verdict: string; note: string }
export interface StageCAnswer { exampleOutcomeSame: string; meaning: string; divergingCase: string; note: string }
export type AnyAnswer = StageAAnswer | StageBAnswer | StageCAnswer;

export interface FieldError { path: string; message: string; reason?: string; unknown?: boolean; count?: number }
export interface SavedAnswer<T = AnyAnswer> {
  session_id: string; stage: Stage; item_id: string; state: AnswerState; answer: T; errors: FieldError[]; revision: number;
  updated_by: string; updated_authority: string; created_at: string; updated_at: string;
}
export interface StageProgress { total: number; complete: number; draft: number; unsure: number; untouched: number; unlocked: boolean; reason: string | null; committed_at: string | null; revealed_at: string | null }
export interface PacketConflict { session_packet_sha256: string; current_packet_sha256: string; message: string }
export interface Digests { rosterSha256: string | null; guidelineSha256: string | null; controlsSha256: string | null; vpuSha256: string | null; thresholdsSha256: string | null }
export interface SessionSummary {
  id: string; task_id: string; project_id: string | null; annotator: string; packet_sha256: string; packet_path: string; digests: Digests; revision: number;
  stages: Record<Stage, { committed_at: string | null; revealed_at: string | null }>; progress: Record<Stage, StageProgress> | null; packet_conflict: PacketConflict | null;
  /** False when Part B or C had been shown before Stage A was committed (a session rebound after a reveal); the labels export says so too. */
  blind: boolean; exposure_before_a: { B: string | null; C: string | null };
  carried_from: string | null; superseded_by: string | null; created_by: string; created_authority: string; created_at: string; updated_at: string; route: string;
}
export interface PacketSummary { sha256: string; path: string; schemaVersion: string; status: string; digests: Digests; counts: { provisions: number; rows: number; controls: number; pairs: number }; sources: unknown[]; guidelineSource: string | null }
export interface RelatedTask { id: string; role: string }
export interface EntryInfo {
  linked: boolean; task_id: string; route?: string; project_id?: string; related_tasks?: RelatedTask[]; need_id?: string;
  packet?: PacketSummary | null; packet_error?: { code: string; message: string } | null; session?: SessionSummary | null;
}
export interface CommitMeta { id: string; snapshot_sha256: string; item_count: number; committed_at: string; committed_authority: string; packet_sha256: string }
export interface RevisionRecord { id: string; item_id: string; answer: StageAAnswer; errors: FieldError[]; note: string; exposure: { committed_at: string; revealed: { B: string | null; C: string | null }; after_exposure_to: Stage[]; blind: false }; created_at: string; created_authority: string }
export interface ExportRecord { id: string; kind: string; path: string; sha256: string; exported_at: string; exported_authority: string }
export interface SessionRead {
  session: SessionSummary;
  packet: PacketSummary & { protocol: string[]; filling: string[]; guideline: { source: string | null; sha256: string | null; text: string }; alignmentMinJaccard: number };
  stageA: StageAContent; answers: Partial<Record<Stage, SavedAnswer[]>>; commits: Partial<Record<Stage, CommitMeta>>; revisions: RevisionRecord[];
  exports: ExportRecord[]; export_targets: Record<string, string>; related_tasks: RelatedTask[]; need_id: string;
}
export interface StageRead<C = StageBContent | StageCContent | StageAContent> {
  stage: Stage; session: SessionSummary; answers: SavedAnswer[]; revealed_at: string | null; content: C;
  committed_rows?: Record<string, { row: PacketRow | null; answer: StageAAnswer | null }>;
}
export interface WhoAmI { operator_session: boolean; identity: string | null; reason: string; operator_credential_configured: boolean; user_id: string | null }
export interface SaveResult<T = AnyAnswer> { answer: SavedAnswer<T>; session: SessionSummary; validation: { complete: boolean; errors: FieldError[] }; saved_at: string }
export interface CommitRefusal { code: "incomplete"; error: string; missing: string[]; unsure: string[]; invalid: { item_id: string; errors: FieldError[] }[] }
export interface ExportResult { export: ExportRecord; written: boolean; identical: boolean; replaced_sha256: string | null; target: string; scorer_command: string | null }

/** An API refusal with its code and the extra fields the server attached. */
export class LabelingApiError extends Error {
  status: number;
  code: string;
  body: Record<string, unknown>;
  constructor(status: number, body: Record<string, unknown>) {
    super(typeof body.error === "string" ? body.error : `Request failed (${status})`);
    this.status = status;
    this.code = typeof body.code === "string" ? body.code : "request_failed";
    this.body = body;
  }
}

const BASE = "/api/groundrules-labeling";
export const OPERATOR_KEY_STORAGE = "groundrules-labeling.operator-key";

/** The per-tab operator credential: sessionStorage only, never sent on reads, never stored server-side. */
export function readOperatorKey(): string {
  try { return window.sessionStorage.getItem(OPERATOR_KEY_STORAGE) ?? ""; } catch { return ""; }
}
export function storeOperatorKey(key: string) {
  try {
    if (key) window.sessionStorage.setItem(OPERATOR_KEY_STORAGE, key);
    else window.sessionStorage.removeItem(OPERATOR_KEY_STORAGE);
  } catch { /* storage blocked: the key stays in memory for this page only */ }
}

async function request<T>(path: string, init: RequestInit = {}, operatorKey = ""): Promise<T> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) };
  if (operatorKey) headers.Authorization = `Bearer ${operatorKey}`;
  const res = await authFetch(`${BASE}${path}`, { ...init, headers });
  let body: Record<string, unknown> = {};
  try { body = await res.json(); } catch { body = {}; }
  if (!res.ok) throw new LabelingApiError(res.status, body);
  return body as T;
}
const json = (body: unknown): RequestInit => ({ method: "PUT", body: JSON.stringify(body) });
const post = (body?: unknown): RequestInit => ({ method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });

export const labelingApi = {
  whoami: () => request<WhoAmI>("/whoami"),
  entry: (taskId: string) => request<EntryInfo>(`/tasks/${encodeURIComponent(taskId)}`),
  startSession: (taskId: string, key: string) => request<{ session: SessionSummary; created: boolean }>(`/tasks/${encodeURIComponent(taskId)}/session`, post({}), key),
  session: (sessionId: string) => request<SessionRead>(`/sessions/${encodeURIComponent(sessionId)}`),
  stage: <C,>(sessionId: string, stage: Stage) => request<StageRead<C>>(`/sessions/${encodeURIComponent(sessionId)}/stages/${stage}`),
  /** The deliberate first disclosure of Part B or C; 201 the first time, 200 after, never on a read. */
  reveal: (sessionId: string, stage: Stage, body: { packet_sha256: string }, key: string) =>
    request<{ stage: Stage; first: boolean; revealed_at: string; session: SessionSummary }>(`/sessions/${encodeURIComponent(sessionId)}/reveal/${stage}`, post(body), key),
  saveAnswer: <T,>(sessionId: string, stage: Stage, itemId: string, body: { packet_sha256: string; base_revision: number | null; state: "draft" | "unsure"; answer: T }, key: string, init: { keepalive?: boolean } = {}) =>
    request<SaveResult<T>>(`/sessions/${encodeURIComponent(sessionId)}/answers/${stage}/${encodeURIComponent(itemId)}`, { ...json(body), ...init }, key),
  commit: (sessionId: string, stage: Stage, body: { packet_sha256: string; expected_revision: number | null }, key: string) =>
    request<{ session: SessionSummary; commit: CommitMeta & { stage: Stage } }>(`/sessions/${encodeURIComponent(sessionId)}/commit/${stage}`, post(body), key),
  revise: (sessionId: string, itemId: string, body: { packet_sha256: string; answer: StageAAnswer; note: string }, key: string) =>
    request<{ revision: RevisionRecord; session: SessionSummary; validation: { complete: boolean; errors: FieldError[] } }>(`/sessions/${encodeURIComponent(sessionId)}/revisions/${encodeURIComponent(itemId)}`, post(body), key),
  exportKind: (sessionId: string, kind: string, body: { packet_sha256: string }, key: string) =>
    request<ExportResult>(`/sessions/${encodeURIComponent(sessionId)}/exports/${kind}`, post(body), key),
  rebind: (sessionId: string, body: { confirm: true; from_packet_sha256: string; to_packet_sha256: string }, key: string) =>
    request<{ session: SessionSummary; superseded: SessionSummary; carried: number }>(`/sessions/${encodeURIComponent(sessionId)}/rebind`, post(body), key),
};

// ------------------------------------------------------------------ quotes

const WORD_CHAR = "[\\p{L}\\p{N}_]";
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const quoteWords = (quote: string) => (typeof quote === "string" ? quote.split(/\s+/u).filter(Boolean) : []);

export interface QuoteResolution { ok: boolean; count: number; start?: number; end?: number; slice?: string; reason?: string }

/** The scorer's anchor rule: words joined by any whitespace, ending at a word boundary, exactly once inside `within` (or the whole text). */
export function resolveQuote(text: string, quote: string, within: string | null = null): QuoteResolution {
  if (typeof text !== "string") return { ok: false, count: 0, reason: "no_text" };
  const parts = quoteWords(quote);
  if (!parts.length) return { ok: false, count: 0, reason: "empty" };
  let lower = 0;
  let upper = text.length;
  if (within && within.trim()) {
    const window = resolveQuote(text, within, null);
    if (!window.ok) return { ok: false, count: 0, reason: window.count === 0 ? "within_not_found" : "within_not_unique" };
    lower = window.start!;
    upper = window.end!;
  }
  const windowText = text.slice(lower, upper);
  const re = new RegExp(`${parts.map(escapeRegExp).join("\\s+")}(?!${WORD_CHAR})`, "gu");
  const matches: { start: number; end: number }[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(windowText)) !== null) {
    matches.push({ start: lower + match.index, end: lower + match.index + match[0].length });
    if (match[0].length === 0) re.lastIndex += 1;
  }
  if (matches.length === 1) return { ok: true, count: 1, start: matches[0].start, end: matches[0].end, slice: text.slice(matches[0].start, matches[0].end) };
  return { ok: false, count: matches.length, reason: matches.length === 0 ? "not_found" : "not_unique" };
}

export function describeQuoteFailure(result: QuoteResolution): string {
  switch (result.reason) {
    case "empty": return "Quote the exact words from the passage.";
    case "not_found": return "These words do not occur in the passage as written. Copy them exactly; spacing does not matter, but the quote must end at a word boundary.";
    case "not_unique": return `These words occur ${result.count} times in the passage. Quote a longer span, or name a unique surrounding span under "within".`;
    case "within_not_found": return 'The "within" span does not occur in the passage.';
    case "within_not_unique": return 'The "within" span occurs more than once in the passage; make it longer.';
    default: return "The quote could not be resolved.";
  }
}

/** Which text a quote field points at: the row itself or one of its contexts. */
export function sourceText(row: PacketRow, source: string | number | undefined | null): { kind: "row" | "context"; index: number | null; text: string } {
  if (source === undefined || source === null || source === "" || source === "row") return { kind: "row", index: null, text: row.text };
  const index = typeof source === "number" ? source : Number.parseInt(String(source).replace(/^context:/, ""), 10);
  const context = row.contexts[index];
  if (!context) return { kind: "row", index: null, text: row.text };
  return { kind: "context", index, text: context.quote };
}

// ------------------------------------------------------------------ answers

export const emptyStageA = (): StageAAnswer => ({ modality: "", actor: { quote: "", source: "row", within: "" }, propositionsDeclared: "", propositions: [], notes: "" });
export const emptyStageB = (): StageBAnswer => ({ verdict: "", note: "" });
export const emptyStageC = (): StageCAnswer => ({ exampleOutcomeSame: "", meaning: "", divergingCase: "", note: "" });
export const newProposition = (index: number): Proposition => ({ id: `p${index + 1}`, category: "", quote: "", source: "row", within: "", numeric: null, note: "" });

/** Strip the server's derived fields so a stored answer can be edited and re-sent. */
export function editableStageA(saved: StageAAnswer | null | undefined): StageAAnswer {
  if (!saved) return emptyStageA();
  const { actorResolved: _r, carried_from: _c, ...rest } = saved;
  return {
    ...emptyStageA(),
    ...rest,
    actor: { quote: saved.actor?.quote ?? "", source: saved.actor?.source ?? "row", within: saved.actor?.within ?? "" },
    propositions: (saved.propositions ?? []).map((p, i) => { const { resolved: _x, ...prop } = p; return { ...newProposition(i), ...prop }; }),
  };
}

export const stageTitle: Record<Stage, string> = { A: "Part A: blind labels", B: "Part B: control judgments", C: "Part C: same outcome, different meaning?" };
export const stageShort: Record<Stage, string> = { A: "Stage A", B: "Stage B", C: "Stage C" };

export function stateLabel(state: AnswerState | "untouched"): string {
  switch (state) {
    case "complete": return "complete";
    case "draft": return "draft";
    case "unsure": return "unsure, return later";
    default: return "not started";
  }
}

export const shortSha = (sha: string | null | undefined, n = 12) => (sha ? sha.slice(0, n) : "n/a");

// -------------------------------------------------------------- definitions
//
// Neutral wording with examples from an invented ordinance (a public library
// act), never from a roster passage, so no real row gets a suggested reading.

export interface Definition { term: string; meaning: string; example: string }

export const MODALITY_DEFINITIONS: Record<Modality, Definition> = {
  may: { term: "may", meaning: "A permission: the actor is allowed to do something, and may also choose not to.", example: '"A card holder may renew a loan once" grants the holder a choice.' },
  shall: { term: "shall", meaning: "An obligation: the actor is required to do something (shall, must, is required to).", example: '"The library shall post its hours at every entrance" imposes a duty.' },
  "must-not": { term: "must-not", meaning: "A prohibition: the actor is forbidden to do something (shall not, may not, no person shall).", example: '"No holder shall lend a library card to another person" forbids an act.' },
  is: { term: "is", meaning: "A definition or statement of fact or status: the passage says what something is, counts as, or applies to, rather than directing conduct.", example: '"A branch library is a library operated by the district" defines a term.' },
};

export const CATEGORY_DEFINITIONS: Record<Category, Definition> = {
  condition: { term: "condition", meaning: "A circumstance that must hold for the rule to apply, including deadlines, amounts and thresholds (if, when, within N days, at least).", example: 'In "a holder may renew a loan if no other holder has reserved the item", the span "if no other holder has reserved the item" is a condition.' },
  exception: { term: "exception", meaning: "A carve-out that removes cases from the rule (unless, except, other than, does not apply to).", example: 'In "the library shall charge a late fee, except for holders under sixteen", the span "except for holders under sixteen" is an exception.' },
  negation: { term: "negation", meaning: "Words that negate or reverse what would otherwise be required or allowed, inside the rule itself (no, not, nothing, in no event).", example: 'In "nothing in this section requires the library to open on a holiday", the span "nothing in this section requires" is a negation.' },
};

export const FIELD_DEFINITIONS: Definition[] = [
  { term: "actor", meaning: "The exact words naming who the rule addresses: the person, body or thing that may, shall, must not, or is.", example: 'In "The district librarian shall approve the schedule", quote "The district librarian".' },
  { term: "quote", meaning: "An exact span of the passage, copied as written. Spacing does not matter, but every word must be there and the span must occur only once. If it occurs twice, quote more words.", example: 'Prefer "within ten days after the notice" over "within ten days" when the shorter span appears twice.' },
  { term: "numeric value", meaning: "For a condition that carries a number, deadline or threshold: the number, its unit (day, week, dollar, item) and the operator the passage implies (<=, >=, <, >, =, within).", example: '"not later than thirty days" is value 30, unit day, operator <=.' },
  { term: "no propositions", meaning: "An explicit statement that the passage carries no condition, exception or negation. It is not the same as leaving the list blank: blank means you have not decided yet.", example: '"The board shall meet monthly" carries none; declare "none" rather than leaving it open.' },
  { term: "UNKNOWN", meaning: "You read the passage and could not settle the field. It is recorded as unsettled and keeps the stage from committing until you return to it.", example: "Use it for a modality that genuinely reads two ways, not for a passage you have not read yet." },
  { term: "unsure, return later", meaning: "Keeps everything you entered as a draft and flags the passage in the index so you come back before committing.", example: "Mark it, move on, and the commit review will list it." },
];

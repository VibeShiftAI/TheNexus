/**
 * Chat-directed display commands: the shell side of the Praxis relay.
 *
 * Praxis holds no controller session and enumerates no hardware. When a chat
 * turn is a display command ("show me the displays", "display this document
 * review on the Living Room TV", "stop presenting") its reply carries ONE
 * bounded directive as the structured `displayDirective` field of the chat
 * response (JSON body, or the SSE `final` event). This module runs that
 * directive inside the signed-in Windows shell or Android app with the
 * operator's OWN session (discover, start, stop, status) and renders the
 * outcome as the `PRAXIS_DISPLAY_REPORT {...}` chat line Praxis reads back
 * and answers in plain words.
 *
 * Authority: only the issued field is a directive. Reply text is never parsed
 * for one, so assistant prose, quoted examples and fenced code cannot make
 * the device or the presentation service do anything. Each request id runs
 * once per page: a replay is refused before any device or HTTP action.
 *
 * Boundaries: a directive names ids only. Nothing here accepts a URL, token,
 * cookie or credential from the directive, every request goes through the
 * existing presentation routes with the controller's own cookie, and the
 * native bridge keeps the device's OS consent and target chooser in place.
 * Contract: Praxis docs/reviews/travel-display-commands.md.
 */
import {
  DisplayInventorySchema, PresentationSessionSchema, PresentationStartSchema,
  type DisplayCommandResult, type DisplayInventory, type DisplayTarget, type PresentationSession, type PresentationStart,
} from '@praxis/contract';
import { displayShellAvailable, requestNativeDisplay } from './presentation-native';
import { presentationRequest } from './presentation-transport';

/** The response field that carries an issued directive. Reply text never does. */
export const DISPLAY_DIRECTIVE_FIELD = 'displayDirective';
export const DISPLAY_REPORT_PREFIX = 'PRAXIS_DISPLAY_REPORT';
/** Window event carrying an accepted inventory, so the Displays panel's heartbeat loop covers chat-started sessions too. */
export const DISPLAY_INVENTORY_EVENT = 'nexus:display-inventory';
const api = '/api/presentations';
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const NATIVE_TIMEOUT_CAP_MS = 60_000;
/** Request ids already carried out on this page; bounded, oldest forgotten first. */
const EXECUTED_LIMIT = 256;

interface DirectiveBase { version: 1; requestId: string; issuedAt: string; expiresAt: string; timeoutMs: number }
export type DisplayDirective =
  | (DirectiveBase & { action: 'discover' })
  | (DirectiveBase & { action: 'start'; start: PresentationStart; replaceSessionId?: string })
  | (DirectiveBase & { action: 'stop'; sessionId: string })
  | (DirectiveBase & { action: 'status'; sessionId?: string });

export interface DisplayReport {
  version: 1;
  requestId: string;
  action: 'discover' | 'start' | 'stop' | 'status';
  ok: boolean;
  code?: string;
  message?: string;
  inventory?: DisplayInventory;
  session?: PresentationSession;
}

export interface RelayDeps {
  native?: typeof requestNativeDisplay;
  request?: typeof presentationRequest;
  shellAvailable?: () => boolean;
  now?: () => number;
}

const isId = (value: unknown): value is string => typeof value === 'string' && ID.test(value);
const isStamp = (value: unknown): value is string => typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
const isTimeout = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 1_000 && value <= 120_000;
const nativeMethod = (method: string) => method === 'windows-monitor' || method === 'android-presentation';

/** Targets this page has seen, so a start can tell a native window from a receiver that needs its pairing code. */
let knownTargets = new Map<string, DisplayTarget>();
let executed = new Set<string>();
function remember(inventory: DisplayInventory) {
  for (const target of inventory.targets) knownTargets.set(`${inventory.sourceDevice.id}\u0000${target.id}`, target);
}
export function __resetDisplayRelayForTests() { knownTargets = new Map(); executed = new Set(); }

/**
 * Read the issued directive from a chat reply's `displayDirective` field.
 * Only a plain object matching the directive shape exactly counts; a string
 * (including one holding a well-formed directive) or anything taken from
 * reply text is null. Unknown keys, URLs and unpinned document views are
 * refused by the strict start schema.
 */
export function readIssuedDirective(value: unknown): DisplayDirective | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  const { requestId, issuedAt, expiresAt, timeoutMs } = r;
  if (r.version !== 1 || !isId(requestId) || !isStamp(issuedAt) || !isStamp(expiresAt) || !isTimeout(timeoutMs)) return null;
  const base: DirectiveBase = { version: 1, requestId, issuedAt, expiresAt, timeoutMs };
  const keys = new Set(Object.keys(r));
  const allowed = (...extra: string[]) => [...keys].every(key => ['version', 'requestId', 'issuedAt', 'expiresAt', 'timeoutMs', 'action', ...extra].includes(key));
  switch (r.action) {
    case 'discover': return allowed() ? { ...base, action: 'discover' } : null;
    case 'stop': return allowed('sessionId') && isId(r.sessionId) ? { ...base, action: 'stop', sessionId: r.sessionId } : null;
    case 'status':
      if (!allowed('sessionId')) return null;
      if (r.sessionId === undefined) return { ...base, action: 'status' };
      return isId(r.sessionId) ? { ...base, action: 'status', sessionId: r.sessionId } : null;
    case 'start': {
      if (!allowed('start', 'replaceSessionId')) return null;
      const start = PresentationStartSchema.safeParse(r.start);
      if (!start.success) return null;
      if (r.replaceSessionId === undefined) return { ...base, action: 'start', start: start.data };
      return isId(r.replaceSessionId) ? { ...base, action: 'start', start: start.data, replaceSessionId: r.replaceSessionId } : null;
    }
    default: return null;
  }
}

/** The chat line Praxis reads back. Plain text, one line, no markup. */
export function renderDisplayReport(report: DisplayReport): string {
  return `${DISPLAY_REPORT_PREFIX} ${JSON.stringify(report)}`;
}

/** Codes must match the Praxis report schema (lowercase snake, 64 chars) or the whole report is refused. */
function reportCode(code: string): string {
  const clean = code.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^[^a-z]+/, '').slice(0, 64);
  return clean || 'failed';
}

function failure(error: unknown, fallback: string): { code: string; message?: string } {
  const cause = error as { code?: unknown; message?: unknown } | null;
  return {
    code: typeof cause?.code === 'string' && cause.code ? cause.code : fallback,
    message: typeof cause?.message === 'string' && cause.message ? cause.message : undefined,
  };
}

/** Single use per page: true the first time a request id is seen, false on any replay. */
function claim(requestId: string): boolean {
  if (executed.has(requestId)) return false;
  executed.add(requestId);
  if (executed.size > EXECUTED_LIMIT) {
    const oldest = executed.values().next().value;
    if (oldest !== undefined) executed.delete(oldest);
  }
  return true;
}

interface Io {
  native: typeof requestNativeDisplay;
  request: typeof presentationRequest;
  timeoutMs: number;
  base: { version: 1; requestId: string; action: DisplayReport['action'] };
  fail: (code: string, message?: string) => DisplayReport;
}

/**
 * Run one issued directive with the operator's own session and report the
 * outcome. Never throws: every failure becomes a coded report so Praxis can
 * explain it. A request id runs once; a replay is refused before any action.
 */
export async function executeDisplayDirective(directive: DisplayDirective, deps: RelayDeps = {}): Promise<DisplayReport> {
  const base = { version: 1 as const, requestId: directive.requestId, action: directive.action };
  const fail = (code: string, message?: string): DisplayReport => ({ ...base, ok: false, code: reportCode(code), ...(message ? { message: message.slice(0, 300) } : {}) });
  if (!claim(directive.requestId)) return fail('directive_replayed', 'That display request was already carried out once; a repeat is ignored.');
  const now = deps.now?.() ?? Date.now();
  if (!(deps.shellAvailable ?? displayShellAvailable)()) {
    return fail('shell_unavailable', 'This chat is not running inside the Nexus Windows or Android app, so it cannot reach a display.');
  }
  if (!(Date.parse(directive.expiresAt) > now)) return fail('directive_expired', 'The app saw this request after it expired.');
  // Same rule as the Displays panel: an Android controller in the background neither scans nor starts (stop and status still run).
  if ((directive.action === 'discover' || directive.action === 'start') && typeof document !== 'undefined' && document.visibilityState === 'hidden') {
    return fail('app_background', 'The Nexus app is in the background. Bring it to the front and ask again.');
  }
  const io: Io = {
    native: deps.native ?? requestNativeDisplay,
    request: deps.request ?? presentationRequest,
    timeoutMs: Math.min(directive.timeoutMs, NATIVE_TIMEOUT_CAP_MS),
    base, fail,
  };
  try {
    switch (directive.action) {
      case 'discover': {
        // Discovery is on demand and bounded by the directive's timeout; the shell runs no background scan.
        const result = await io.native({ action: 'discover' }, { timeoutMs: io.timeoutMs });
        const inventory = DisplayInventorySchema.safeParse(result.inventory);
        if (!inventory.success) return fail('invalid_inventory', 'The native bridge returned a display list that does not match the contract.');
        const accepted = await io.request<DisplayInventory>(`${api}/inventory`, { method: 'PUT', body: JSON.stringify(inventory.data) });
        remember(accepted);
        if (typeof window !== 'undefined') window.dispatchEvent(new window.CustomEvent(DISPLAY_INVENTORY_EVENT, { detail: accepted }));
        return { ...base, ok: true, inventory: accepted };
      }
      case 'start': return await start(directive, io);
      case 'stop': {
        // Revoke first: the data lease ends even if closing the native window fails.
        const stopped = await io.request<PresentationSession>(`${api}/sessions/${encodeURIComponent(directive.sessionId)}`, { method: 'DELETE' });
        if (nativeMethod(stopped.method)) await io.native({ action: 'stop' }, { timeoutMs: io.timeoutMs }).catch(() => {});
        return { ...base, ok: true, session: stopped };
      }
      case 'status': {
        const listed = await io.request<{ sessions: PresentationSession[] }>(`${api}/sessions`);
        const session = directive.sessionId ? listed.sessions.find(entry => entry.id === directive.sessionId) : undefined;
        return session ? { ...base, ok: true, session } : fail('session_not_found', 'Nexus no longer lists that presentation.');
      }
    }
  } catch (error) {
    const { code, message } = failure(error, directive.action === 'discover' ? 'discovery_failed' : 'controller_request_failed');
    return fail(code, message);
  }
}

async function findTarget(io: Io, start: PresentationStart): Promise<DisplayTarget | undefined> {
  const key = `${start.sourceDeviceId}\u0000${start.targetId}`;
  if (!knownTargets.has(key)) {
    const listed = await io.request<{ inventories: DisplayInventory[] }>(`${api}/inventory`).catch(() => null);
    for (const inventory of listed?.inventories ?? []) if (inventory.sourceDevice.id === start.sourceDeviceId) remember(inventory);
  }
  return knownTargets.get(key);
}

async function start(directive: Extract<DisplayDirective, { action: 'start' }>, io: Io): Promise<DisplayReport> {
  const { start, replaceSessionId } = directive;
  const target = await findTarget(io, start);
  if (target && !nativeMethod(target.method)) {
    // Cast and TV-browser receivers pair with a two-digit code typed from the TV: that consent step stays on the controller.
    return io.fail('pairing_required', `${target.name} is a ${target.method === 'cast' ? 'Cast' : 'TV-browser'} receiver: open Displays in the app, connect it, and enter the two-digit code shown on the TV for this view.`);
  }
  if (replaceSessionId) {
    await io.request(`${api}/sessions/${encodeURIComponent(replaceSessionId)}`, { method: 'DELETE' }).catch(() => {});
    await io.native({ action: 'stop' }, { timeoutMs: io.timeoutMs }).catch(() => {});
  }
  // The authority opens the session first (fresh inventory, exact revision, capability), then the device shows it.
  const created = await io.request<PresentationSession>(`${api}/sessions`, { method: 'POST', body: JSON.stringify(start) });
  if (!nativeMethod(created.method)) {
    await io.request(`${api}/sessions/${encodeURIComponent(created.id)}`, { method: 'DELETE' }).catch(() => {});
    return io.fail('pairing_required', 'That receiver pairs with a two-digit code: open Displays in the app, connect it, and enter the code shown on the TV.');
  }
  let opened: DisplayCommandResult;
  try {
    opened = await io.native({ action: 'start', targetId: start.targetId, sessionId: created.id, expiresAt: created.expiresAt }, { timeoutMs: io.timeoutMs });
    if (opened.state !== 'active' || opened.sessionId !== created.id) {
      throw Object.assign(new Error('The device did not confirm the presentation window.'), { code: 'native_start_failed' });
    }
  } catch (error) {
    // Revoke first, then close whatever the device half-opened.
    await io.request(`${api}/sessions/${encodeURIComponent(created.id)}`, { method: 'DELETE' }).catch(() => {});
    await io.native({ action: 'stop' }, { timeoutMs: io.timeoutMs }).catch(() => {});
    const { code, message } = failure(error, 'native_start_failed');
    return io.fail(code, message);
  }
  const active = await io.request<PresentationSession>(`${api}/sessions/${encodeURIComponent(created.id)}/heartbeat`, { method: 'POST', body: JSON.stringify({ state: 'active' }) });
  return { ...io.base, ok: true, session: PresentationSessionSchema.safeParse(active).success ? active : { ...created, state: 'active' } };
}

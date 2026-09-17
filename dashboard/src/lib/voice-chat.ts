import type { Message, MessageAttachment } from '@/components/cortex-provider';

export interface VoiceChatTurn {
  clientMessageId: string;
  message: string;
  conversationId?: string;
  history?: { role: string; content: string }[];
  projectId?: string;
}
export type SavedVoiceMessage = Omit<Message, 'timestamp'> & { id: string; created_at?: string };
export interface VoiceChatReceipt {
  accepted: boolean;
  clientMessageId: string;
  conversationId: string;
  status: 'pending' | 'completed' | 'failed' | 'interrupted' | 'not_found';
  response?: string;
  suppressVoice?: boolean;
  error?: string;
  assistantMessageId?: string;
  voiceData?: { audio: string; mimeType: string }[];
  attachments?: MessageAttachment[];
  messages?: SavedVoiceMessage[];
}
export type VoiceChatProgress = 'accepting' | 'accepted' | 'working' | 'reconnecting';
interface RequestOptions {
  signal?: AbortSignal;
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
  pollIntervalMs?: number;
}
const abortError = () => new DOMException('Voice ended', 'AbortError');
const checkAbort = (signal?: AbortSignal) => { if (signal?.aborted) throw abortError(); };

/** Bound both response headers and body; cancellation also works with stalled transports. */
export async function voiceChatRequest<T>(url: string, init: RequestInit, options: RequestOptions) {
  checkAbort(options.signal);
  const controller = new AbortController();
  let rejectAbort!: (error: Error) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const abort = () => { controller.abort(); rejectAbort(abortError()); };
  options.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => { controller.abort(); rejectAbort(new Error('Chat request timed out')); }, options.requestTimeoutMs ?? 10_000);
  try {
    return await Promise.race([aborted, (async () => {
      const res = await (options.fetch ?? fetch)(url, { ...init, signal: controller.signal });
      const data = await res.json().catch(error => {
        if (res.ok) throw error;
        return { error: `Chat request rejected (HTTP ${res.status}). Check saved chat before resending.` };
      }) as T;
      return { ok: res.ok, status: res.status, data };
    })()]);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
}
function pause(options: RequestOptions) {
  checkAbort(options.signal);
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); };
    const abort = () => { cleanup(); reject(abortError()); };
    const timer = setTimeout(() => { cleanup(); resolve(); }, options.pollIntervalMs ?? 1500);
    options.signal?.addEventListener('abort', abort, { once: true });
  });
}
class ChatRejected extends Error {}
const permanent = (status: number) => status >= 400 && status < 500 && status !== 408 && status !== 429;

/** Retry transport only. After any acceptance, all subsequent requests are exact-ID reads. */
export async function sendVoiceChat(turn: VoiceChatTurn, options: RequestOptions & {
  signal: AbortSignal;
  onProgress?: (progress: VoiceChatProgress) => void;
  onReceipt?: (receipt: VoiceChatReceipt) => void;
}): Promise<VoiceChatReceipt> {
  const body = JSON.stringify({ ...turn, async: true, voiceConversation: true });
  let post = true;
  let accepted = false;
  options.onProgress?.('accepting');
  for (;;) {
    checkAbort(options.signal);
    let result;
    const wasPost = post;
    // An ambiguous POST always reconciles by GET before another POST is allowed.
    post = false;
    try {
      result = await voiceChatRequest<VoiceChatReceipt>(wasPost ? '/api/ai/chat' : `/api/ai/chat/requests/${encodeURIComponent(turn.clientMessageId)}`,
        wasPost ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body } : { cache: 'no-store' }, options);
      checkAbort(options.signal);
      if (!result.ok) {
        if (!wasPost && result.status === 404) {
          post = !accepted;
        } else if (permanent(result.status)) {
          throw new ChatRejected(result.data.error || 'The chat request was rejected. Check saved chat before resending.');
        }
        throw new Error('Chat connection unavailable');
      }
      const receipt = result.data;
      if (!receipt.accepted || receipt.clientMessageId !== turn.clientMessageId || !receipt.conversationId) throw new Error('Chat receipt unavailable');
      if (!accepted) { accepted = true; options.onProgress?.('accepted'); }
      options.onReceipt?.(receipt);
      if (receipt.status === 'completed') return receipt;
      if (receipt.status === 'failed' || receipt.status === 'interrupted') {
        throw new ChatRejected('Your message was accepted, but the final result is uncertain. Check saved chat before resending.');
      }
      options.onProgress?.('working');
    } catch (error) {
      checkAbort(options.signal);
      if (error instanceof ChatRejected) throw error;
      options.onProgress?.('reconnecting');
    }
    await pause(options);
  }
}

/** Local actions run elsewhere once. Only their stable archive rows may be retried. */
export async function archiveVoiceExchange(turn: VoiceChatTurn, outcome?: string, options: RequestOptions & { suppressVoice?: boolean } = {}): Promise<SavedVoiceMessage[]> {
  const messages = [
    { id: turn.clientMessageId, role: 'user', content: turn.message, metadata: { voiceConversation: true } },
    ...(outcome === undefined ? [] : [{ id: `${turn.clientMessageId}:reply`, role: 'assistant', content: outcome, metadata: { voiceConversation: true, playbackOwner: 'voice', ...(options.suppressVoice ? { suppressVoice: true } : {}) } }]),
  ];
  return archiveVoiceRows(messages, turn.conversationId, options);
}

/** Save the exact spoken announcement before playback, without inventing a user turn. */
export function archiveVoiceAnnouncement(eventId: string, text: string, conversationId?: string, options: RequestOptions = {}) {
  return archiveVoiceRows([{ id: `voice-alert:${eventId}`, role: 'assistant', content: text,
    metadata: { eventId, voiceAnnouncement: true, playbackOwner: 'voice', suppressVoice: true } }], conversationId, options);
}

/** Delivery notices are durable chat rows, and must never trigger speech themselves. */
export function archiveVoiceDeliveryNotice(eventId: string, text: string, conversationId?: string, options: RequestOptions = {}) {
  return archiveVoiceRows([{ id: `voice-delivery:${eventId}`, role: 'assistant', content: text,
    metadata: { eventId, voiceDeliveryNotice: true, playbackOwner: 'voice', suppressVoice: true } }], conversationId, options);
}

async function archiveVoiceRows(messages: unknown[], conversationId: string | undefined, options: RequestOptions): Promise<SavedVoiceMessage[]> {
  const body = JSON.stringify({ conversationId, mode: 'praxis', messages });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const result = await voiceChatRequest<{ ok: boolean; synced: number; messages: SavedVoiceMessage[]; error?: string }>('/api/chat/messages/sync', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
      }, options);
      if (result.ok && result.data.ok && result.data.synced === messages.length && Array.isArray(result.data.messages)) return result.data.messages;
      if (permanent(result.status)) throw new ChatRejected(result.data.error || 'Chat archival rejected');
      throw new Error('Chat archival unavailable');
    } catch (error) {
      checkAbort(options.signal);
      if (error instanceof ChatRejected || attempt === 2) throw error;
    }
    await pause(options);
  }
  throw new Error('Chat archival unavailable');
}

/** Socket delivery normally adds these rows; receipt delivery fills any missed IDs. */
export function mergeVoiceMessages(previous: Message[], saved: SavedVoiceMessage[]): Message[] {
  const ids = new Set(previous.map(message => message.id));
  const missing = saved.filter(message => {
    if (ids.has(message.id)) return false;
    ids.add(message.id); return true;
  });
  if (!missing.length) return previous;
  return [...previous, ...missing.map(message => ({ ...message, timestamp: new Date(message.created_at || Date.now()) }))]
    .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
}

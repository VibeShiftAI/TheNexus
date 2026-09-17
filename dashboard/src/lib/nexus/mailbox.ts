import { authFetch } from './shared';

export type MailboxFolder = 'all' | 'inbox' | 'feedback' | 'sent' | 'pending';
export interface MailboxSummary {
  id: string;
  subject: string;
  from: string;
  to: string[];
  date: string | null;
  status: 'received' | 'sent' | 'pending';
  unread?: boolean;
  approvalId?: string;
  approvalState?: string;
  source?: 'email' | 'feedback';
  tag?: string;
  project?: string;
}
export interface MailboxThreadEntry {
  id: string;
  direction: 'in' | 'out';
  kind: 'feedback' | 'email' | 'answers';
  date: string | null;
  from: string;
  to: string[];
  subject?: string;
  body: string;
  status?: string;
  attachments: MailboxDetail['attachments'];
  approvalId?: string;
  approvalState?: string;
  truncated?: boolean;
}
export interface MailboxDetail extends MailboxSummary {
  body: string;
  cc: string[];
  replyTo: string[];
  messageId?: string;
  attachments: Array<{ filename: string; contentType: string; size: number }>;
  bodyUnavailable?: boolean;
  thread?: {
    tag: string;
    project?: string;
    status?: string;
    taskIds: string[];
    entries: MailboxThreadEntry[];
    hasMore: boolean;
    truncated?: boolean;
  };
}
export interface MailboxPage {
  account: string;
  folder: MailboxFolder;
  items: MailboxSummary[];
  nextCursor: string | null;
  updatedAt: string;
}

async function readMailbox<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await authFetch(`/api/praxis/mailbox${path}`, { signal, cache: 'no-store' });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(typeof data?.message === 'string' ? data.message : typeof data?.error === 'string' ? data.error : `Unable to load Praxis mail (${response.status}). Please retry.`);
  }
  if (!data) throw new Error('Praxis returned an unreadable mailbox response. Please retry.');
  return data as T;
}

export function getMailbox(folder: MailboxFolder, cursor?: string, signal?: AbortSignal) {
  const params = new URLSearchParams({ folder, limit: '30' });
  if (cursor) params.set('cursor', cursor);
  return readMailbox<MailboxPage>(`?${params}`, signal);
}
export function getMailboxMessage(folder: MailboxFolder, id: string, signal?: AbortSignal) {
  return readMailbox<MailboxDetail>(`/${folder}/${encodeURIComponent(id)}`, signal);
}

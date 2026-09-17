"use client";

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Inbox, Mail, Paperclip, RefreshCw, Send } from 'lucide-react';
import { getMailbox, getMailboxMessage, type MailboxDetail, type MailboxFolder, type MailboxPage, type MailboxSummary } from '@/lib/nexus/mailbox';

const buttonClass = 'inline-flex items-center justify-center gap-2 rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300 transition hover:border-cyan-500/60 hover:text-cyan-200 disabled:cursor-wait disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-cyan-300';
const selectedClass = 'border-cyan-500/50 bg-cyan-400/10 text-cyan-200';
function dateLabel(value: string | null) {
  if (!value) return 'Date unavailable';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Date unavailable' : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
function mailStatus(message: MailboxSummary) {
  if (message.source === 'feedback') return 'Conversation';
  if (message.status === 'received') return 'Received';
  if (message.status === 'sent') return 'Sent';
  switch (message.approvalState) {
    case 'pending': return 'Awaiting approval';
    case 'approved': return 'Approved · not sent';
    case 'queued': return 'Queued · not sent';
    case 'rejected': return 'Declined · not sent';
    case 'cancelled': return 'Cancelled · not sent';
    case 'expired': return 'Expired · not sent';
    default: return 'Not sent';
  }
}
function failure(error: unknown) {
  return error instanceof Error ? error.message : 'Unable to load Praxis mail. Please retry.';
}

export function PraxisMailbox() {
  const [folder, setFolder] = useState<MailboxFolder>('all');
  const [inboxFolder, setInboxFolder] = useState<'all' | 'inbox' | 'feedback'>('all');
  const [outboxFolder, setOutboxFolder] = useState<'pending' | 'sent'>('pending');
  const [account, setAccount] = useState<string | null>(null);
  const outbox = folder === 'sent' || folder === 'pending';
  return (
    <main className="min-h-screen bg-slate-950 px-4 py-6 text-slate-100 sm:px-8" style={{ backgroundImage: 'radial-gradient(ellipse at top left, rgba(34,211,238,0.07), transparent 55%)' }}>
      <div className="mx-auto max-w-7xl">
        <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
          <div>
            <Link href="/" className="mb-4 inline-flex items-center gap-2 text-sm text-slate-400 hover:text-cyan-200"><ArrowLeft size={15} />Dashboard</Link>
            <h1 className="flex items-center gap-3 text-2xl font-semibold tracking-tight"><Mail className="text-cyan-300" size={26} />Praxis mail</h1>
            <p className="mt-2 text-sm text-slate-400">{account ?? 'Dedicated Praxis mailbox'}</p>
          </div>
        </header>
        <nav aria-label="Mail folders" className="mb-4 flex gap-2">
          <button className={`${buttonClass} ${!outbox ? selectedClass : ''}`} aria-pressed={!outbox} onClick={() => setFolder(inboxFolder)}><Inbox size={16} />Inbox</button>
          <button className={`${buttonClass} ${outbox ? selectedClass : ''}`} aria-pressed={outbox} onClick={() => setFolder(outboxFolder)}><Send size={16} />Outbox</button>
        </nav>
        {!outbox && <div className="mb-4 flex flex-wrap items-center gap-2" aria-label="Inbox filters">
          {(['all', 'inbox', 'feedback'] as const).map(value => <button key={value} className={`${buttonClass} ${folder === value ? selectedClass : ''}`} aria-pressed={folder === value} onClick={() => { setInboxFolder(value); setFolder(value); }}>{value === 'all' ? 'All' : value === 'inbox' ? 'Email' : 'Feedback'}</button>)}
          <p className="ml-1 text-xs text-slate-400">Email, feedback requests, and their conversations.</p>
        </div>}
        {outbox && <div className="mb-4 flex flex-wrap items-center gap-2" aria-label="Outbox filters">
          {(['pending', 'sent'] as const).map(value => <button key={value} className={`${buttonClass} ${folder === value ? selectedClass : ''}`} aria-pressed={folder === value} onClick={() => { setOutboxFolder(value); setFolder(value); }}>{value === 'pending' ? 'Pending' : 'Sent'}</button>)}
          <p className="ml-1 text-xs text-slate-400">{folder === 'pending' ? 'Praxis drafts that have not been sent.' : 'Messages in the Praxis Sent folder.'}</p>
        </div>}
        <MailboxFolderView key={folder} folder={folder} onAccount={setAccount} />
      </div>
    </main>
  );
}

function MailboxFolderView({ folder, onAccount }: { folder: MailboxFolder; onAccount: (account: string) => void }) {
  const [page, setPage] = useState<MailboxPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const pageController = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    pageController.current = controller;
    setLoading(true);
    setError(null);
    setPage(null);
    setSelectedId(null);
    getMailbox(folder, undefined, controller.signal).then(data => {
      if (controller.signal.aborted) return;
      setPage(data);
      onAccount(data.account);
    }).catch(err => {
      if (!controller.signal.aborted) setError(failure(err));
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [folder, revision, onAccount]);

  async function loadMore() {
    const controller = pageController.current;
    if (!page?.nextCursor || !controller || loadingMore) return;
    setLoadingMore(true);
    setError(null);
    try {
      const more = await getMailbox(folder, page.nextCursor, controller.signal);
      if (controller.signal.aborted) return;
      setPage(current => current && ({ ...more, items: [...current.items, ...more.items.filter(item => !current.items.some(existing => existing.id === item.id))] }));
    } catch (err) {
      if (!controller.signal.aborted) setError(failure(err));
    } finally {
      if (!controller.signal.aborted) setLoadingMore(false);
    }
  }

  const isOutbox = folder === 'sent' || folder === 'pending';
  return <section aria-label={folder === 'sent' ? 'Sent mail' : folder === 'pending' ? 'Pending drafts' : 'Inbox'}>
    <div className="mb-3 flex items-center justify-between gap-3">
      <p className="text-xs text-slate-500">{page ? `${page.items.length} loaded · Updated ${dateLabel(page.updatedAt)}` : loading ? 'Connecting to Praxis mail…' : 'Mailbox could not be loaded'}</p>
      <button className={buttonClass} disabled={loading || loadingMore} onClick={() => setRevision(value => value + 1)}><RefreshCw size={14} className={loading ? 'animate-spin' : ''} />Refresh</button>
    </div>
    {error && <div role="alert" className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-200">
      <span>{error}</span><button className={buttonClass} onClick={() => setRevision(value => value + 1)} disabled={loadingMore}>Retry</button>
    </div>}
    <div className="grid min-h-[28rem] overflow-hidden rounded-xl border border-slate-800 bg-slate-900/35 lg:grid-cols-[minmax(17rem,0.85fr)_minmax(0,1.8fr)]">
      <div className={`border-slate-800 lg:max-h-[70vh] lg:overflow-y-auto lg:border-r ${selectedId ? 'hidden lg:block' : ''}`} aria-label="Message list" aria-busy={loading || loadingMore}>
        {loading && <p role="status" className="p-6 text-sm text-slate-400">Loading messages…</p>}
        {!loading && !error && page?.items.length === 0 && <div className="p-8 text-center text-slate-400"><Inbox className="mx-auto mb-3 text-slate-600" /><p>No messages {folder === 'pending' ? 'pending.' : 'in this folder.'}</p></div>}
        {page?.items.map(message => <button key={message.id} data-message-id={message.id} aria-pressed={message.id === selectedId} onClick={() => setSelectedId(message.id)} className={`block w-full border-b border-slate-800 px-4 py-4 text-left transition hover:bg-slate-800/50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-cyan-300 ${selectedId === message.id ? 'bg-cyan-400/10' : ''}`}>
          <span className="mb-1 flex items-center justify-between gap-2 text-xs text-slate-400"><span className="truncate">{!isOutbox ? message.from || 'Unknown sender' : message.to.join(', ') || 'No recipient'}</span>{message.unread && <span className="h-2 w-2 shrink-0 rounded-full bg-cyan-300" aria-label="Unread" />}</span>
          {!isOutbox && <span className="mb-1 block truncate text-[10px] uppercase tracking-wide text-cyan-400/80">{message.source === 'feedback' ? `Feedback${message.project ? ` · ${message.project}` : ''}` : 'Email'}</span>}
          <span className="block truncate text-sm font-medium text-slate-100">{message.subject || '(No subject)'}</span>
          <span className="mt-2 flex flex-wrap items-center justify-between gap-1 text-[11px] text-slate-500"><span>{dateLabel(message.date)}</span><span className={message.status === 'pending' ? 'text-amber-300' : 'text-slate-400'}>{mailStatus(message)}</span></span>
        </button>)}
        {page?.nextCursor && <div className="p-4"><button className={`${buttonClass} w-full`} disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? 'Loading…' : 'Load more'}</button></div>}
      </div>
      <div className={`min-w-0 lg:max-h-[70vh] lg:overflow-y-auto ${!selectedId ? 'hidden lg:block' : ''}`}>
        {selectedId ? <><button className={`${buttonClass} m-4 lg:hidden`} onClick={() => setSelectedId(null)}><ArrowLeft size={14} />Messages</button><MessageDetail key={selectedId} folder={folder} id={selectedId} /></> : <div className="flex h-full min-h-80 flex-col items-center justify-center gap-3 p-8 text-center text-slate-500"><Mail size={30} /><p className="text-sm">Select a message to read it.</p></div>}
      </div>
    </div>
  </section>;
}

function MessageDetail({ folder, id }: { folder: MailboxFolder; id: string }) {
  const [message, setMessage] = useState<MailboxDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    setMessage(null);
    getMailboxMessage(folder, id, controller.signal).then(data => {
      if (!controller.signal.aborted) setMessage(data);
    }).catch(err => {
      if (!controller.signal.aborted) setError(failure(err));
    });
    return () => controller.abort();
  }, [folder, id, revision]);
  if (error) return <div role="alert" className="space-y-4 p-6 text-sm text-amber-200"><p>{error}</p><button className={buttonClass} onClick={() => setRevision(value => value + 1)}>Retry message</button></div>;
  if (!message) return <p role="status" className="p-6 text-sm text-slate-400">Loading message…</p>;
  if (message.thread) return <FeedbackConversation message={message} />;
  return <article className="p-5 sm:p-7" aria-label="Message detail">
    <div className="mb-3 flex flex-wrap items-center gap-3">
      <span className={`rounded-full border px-2.5 py-1 text-xs ${message.status === 'pending' ? 'border-amber-500/30 text-amber-300' : 'border-slate-700 text-slate-400'}`}>{mailStatus(message)}</span>
      {message.approvalId && message.approvalState === 'pending' && <Link href={`/inbox#${encodeURIComponent(message.approvalId)}`} className="text-sm text-cyan-300 underline underline-offset-4">Review approval</Link>}
    </div>
    <h2 className="mb-5 break-words text-xl font-semibold">{message.subject || '(No subject)'}</h2>
    <dl className="grid grid-cols-[4rem_minmax(0,1fr)] gap-x-3 gap-y-2 border-b border-slate-800 pb-5 text-sm">
      {([['From', message.from], ['To', message.to.join(', ')], ['Date', dateLabel(message.date)], ['Cc', message.cc.join(', ')], ['Reply-To', message.replyTo.join(', ')]] as const).filter(([, value]) => value).map(([label, value]) => <div key={label} className="contents"><dt className="text-slate-500">{label}</dt><dd className="break-words text-slate-300">{value}</dd></div>)}
    </dl>
    {message.bodyUnavailable ? <p role="status" className="my-6 rounded-lg border border-amber-500/30 p-4 text-sm text-amber-200">This message is too large to display here. Open it in the Praxis email account to read the complete message.</p> : <div className="my-6 whitespace-pre-wrap break-words text-sm leading-7 text-slate-200">{message.body || 'This message has no text body.'}</div>}
    {message.attachments.length > 0 && <section aria-label="Attachments" className="border-t border-slate-800 pt-5"><h3 className="mb-3 flex items-center gap-2 text-xs uppercase tracking-wider text-slate-500"><Paperclip size={14} />Attachments</h3><ul className="space-y-2">{message.attachments.map((attachment, index) => <li key={`${attachment.filename}-${index}`} className="rounded-lg border border-slate-800 bg-slate-950/40 p-3 text-sm"><span className="block break-words text-slate-300">{attachment.filename || 'Unnamed attachment'}</span><span className="text-xs text-slate-500">{attachment.contentType} · {Math.ceil(attachment.size / 1024).toLocaleString()} KB · File information only</span></li>)}</ul></section>}
  </article>;
}

const conversationStatus: Record<string, string> = {
  received: 'Received', triaged: 'Reviewed', tasked: 'Work created', replied: 'Response sent',
  awaiting_user: 'Awaiting response', closed: 'Closed', discarded: 'Archived',
  sent: 'Sent', answered: 'Answered', draft: 'Not sent', expired: 'Expired', cancelled: 'Cancelled',
};

function FeedbackConversation({ message }: { message: MailboxDetail }) {
  const thread = message.thread!;
  return <article aria-label="Feedback conversation" className="p-5 sm:p-7">
    <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
      <span className="rounded-full border border-cyan-500/30 px-2.5 py-1 text-cyan-300">{thread.tag}</span>
      {thread.project && <span className="text-slate-400">{thread.project}</span>}
      {thread.status && <span className="text-slate-400">{conversationStatus[thread.status] ?? thread.status}</span>}
    </div>
    <h2 className="mb-5 break-words text-xl font-semibold">{message.subject || 'Feedback conversation'}</h2>
    {thread.taskIds.length > 0 && <div className="mb-6 flex flex-wrap items-center gap-2 text-sm"><span className="text-slate-500">Linked work</span>{thread.taskIds.map((id, index) => <Link key={id} href={`/task/${encodeURIComponent(id)}`} className="rounded border border-slate-700 px-2 py-1 text-cyan-300 hover:border-cyan-500">Task {index + 1}</Link>)}</div>}
    {(thread.hasMore || thread.truncated) && <p role="status" className="mb-5 rounded-lg border border-amber-500/30 p-3 text-sm text-amber-200">This conversation exceeds the viewer’s size limit. Some history or text is omitted here; the original records are retained.</p>}
    <ol className="space-y-5">
      {thread.entries.map(entry => {
        const draft = entry.direction === 'out' && entry.status === 'draft';
        const status = draft ? mailStatus({ ...message, source: 'email', status: 'pending', approvalState: entry.approvalState }) : entry.status ? conversationStatus[entry.status] ?? entry.status : entry.direction === 'in' ? 'Received' : 'Status unavailable';
        return <li key={entry.id} className={`rounded-xl border p-4 sm:p-5 ${entry.direction === 'out' ? 'border-violet-400/20 bg-violet-400/5' : 'border-slate-800 bg-slate-950/40'}`}>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs"><span className={entry.direction === 'out' ? 'text-violet-300' : 'text-cyan-300'}>{entry.kind === 'feedback' ? 'Feedback request' : entry.kind === 'answers' ? 'Questionnaire answers' : entry.direction === 'out' ? 'Praxis response' : 'Reply'} · {status}</span><span className="text-slate-500">{dateLabel(entry.date)}</span></div>
          <p className="mb-3 break-words text-xs text-slate-400">{entry.from || 'Anonymous'}{entry.to.length > 0 ? ` → ${entry.to.join(', ')}` : ''}</p>
          {entry.subject && <h3 className="mb-3 break-words text-sm font-medium text-slate-200">{entry.subject}</h3>}
          <div className="whitespace-pre-wrap break-words text-sm leading-7 text-slate-200">{entry.body || 'No text was recorded.'}</div>
          {entry.truncated && <p className="mt-3 text-xs text-amber-300">This entry is shortened by the viewer’s size limit.</p>}
          {entry.attachments.length > 0 && <ul aria-label="Attachment information" className="mt-4 space-y-1 text-xs text-slate-400">{entry.attachments.map((attachment, index) => <li key={`${attachment.filename}-${index}`} className="flex items-start gap-2 break-all"><Paperclip className="shrink-0" size={13} />{attachment.filename} · {attachment.contentType} · File information only</li>)}</ul>}
          {entry.approvalId && entry.approvalState === 'pending' && <Link href={`/inbox#${encodeURIComponent(entry.approvalId)}`} className="mt-4 inline-block text-sm text-cyan-300 underline underline-offset-4">Review approval</Link>}
        </li>;
      })}
    </ol>
  </article>;
}

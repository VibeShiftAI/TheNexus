"use client";
import Link from 'next/link';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { safeAlertHref, type AlertActionView } from '@/lib/alert-action';

export function SafeAlertMarkdown({ children }: { children: string }) {
  return <div className="space-y-2 break-words [&_p]:whitespace-pre-wrap [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_pre]:overflow-auto [&_a]:text-cyan-300 [&_a]:underline">
    <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={url => safeAlertHref(url) ?? ''} components={{
      a: ({ href, children: label }) => {
        const safe = href ? safeAlertHref(href) : undefined;
        if (!safe) return <span>{label}</span>;
        return safe.startsWith('/') ? <Link href={safe}>{label}</Link> : <a href={safe} target="_blank" rel="noopener noreferrer">{label}</a>;
      },
      img: ({ alt }) => <span>{alt}</span>,
    }}>{children}</ReactMarkdown>
  </div>;
}

export function AlertAction({ action, inline = false, showQuestion = true }: { action: AlertActionView; inline?: boolean; showQuestion?: boolean }) {
  const pending = action.state === 'pending';
  return <section className={`my-2 space-y-2 rounded border p-2 text-xs ${pending ? 'border-amber-500/30 bg-amber-500/5 text-amber-100' : 'border-slate-700 text-slate-300'}`}>
    <p className="font-semibold">{action.label}</p>
    <p>{action.instruction}</p>
    <p className="text-[11px] text-slate-400">Owner: {action.owner}</p>
    {action.reason && <div><strong>Why: </strong><SafeAlertMarkdown>{action.reason}</SafeAlertMarkdown></div>}
    {showQuestion && action.question && <SafeAlertMarkdown>{action.question}</SafeAlertMarkdown>}
    {action.answer && <div><p className="font-semibold">Recorded answer</p><SafeAlertMarkdown>{action.answer}</SafeAlertMarkdown></div>}
    {!inline && <Link href={action.href} className="inline-block font-semibold text-cyan-300 underline underline-offset-2">{action.linkLabel} →</Link>}
    {action.relatedLinks?.map(link => <Link key={link.href} href={link.href} className="block text-cyan-300 underline">{link.label} →</Link>)}
  </section>;
}

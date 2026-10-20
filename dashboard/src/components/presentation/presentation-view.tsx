"use client";

import { useEffect, useState } from 'react';
import type { PresentationSnapshot } from '@praxis/contract';
import { DocumentMarkdown } from '../document-review/document-markdown';
import { PdfViewer } from '../document-review/viewers/pdf-viewer';
import { ImageViewer } from '../document-review/viewers/image-viewer';
import { VideoViewer } from '../document-review/viewers/video-viewer';

function Clock() {
  const [time, setTime] = useState('');
  useEffect(() => {
    const update = () => setTime(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    update(); const timer = setInterval(update, 1000); return () => clearInterval(timer);
  }, []);
  return <div className="presentation-clock">{time}</div>;
}

export function PresentationView({ snapshot, assetSrc }: { snapshot: PresentationSnapshot; assetSrc: string | null }) {
  const { content, sampledAt, session } = snapshot;
  return <main className="presentation-root" data-presentation-kind={content.kind}>
    <header className="presentation-heading"><span className="presentation-brand">THE NEXUS</span><span>Read-only presentation</span></header>
    {content.kind === 'ambient' && <section className="presentation-ambient">
      <Clock /><div className="presentation-orbit" aria-hidden="true"><div /></div>
      <h1>Your work, at a glance</h1><p className="presentation-muted">{content.label}</p>
      <dl className="presentation-counts">{Object.entries(content.counts).map(([key, value]) => <div key={key}><dd>{value}</dd><dt>{key}</dt></div>)}</dl>
    </section>}
    {content.kind === 'focus' && <section>
      <p className="presentation-kicker">{content.mode === 'board' ? 'Task board' : 'Current focus'}</p>
      <h1>{content.mode === 'board' ? 'The work ahead' : 'Active work'}</h1>
      <p className="presentation-muted">{content.activity?.available ? 'Live execution is marked separately from recorded board status.' : 'Live activity unavailable. A board label alone does not confirm execution.'}</p>
      <div className="presentation-tasks">{content.tasks.map(task => <article key={task.id}>
        <p className="presentation-kicker">{task.project}</p><h2>{task.title}</h2><span className="presentation-status">{task.status.replaceAll('_', ' ')}</span>{content.activity?.available && content.activity.taskIds.includes(task.id) && <p className="presentation-kicker">Live execution confirmed</p>}
      </article>)}</div>
      {!content.tasks.length && <p>No tasks in this view.</p>}
      {content.truncated && <p>Showing the first set of tasks. Open the controller for the full board.</p>}
    </section>}
    {content.kind === 'day-plan' && <section>
      <p className="presentation-kicker">Calendar / day plan</p><h1>{content.date}</h1>
      <p className="presentation-muted">Plan date follows the Nexus server’s calendar. Times below use this display’s timezone.</p>
      <ol className="presentation-agenda">{content.events.map(event => <li key={event.id}>
        <time dateTime={event.startsAt}>{new Date(event.startsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
        <div><h2>{event.title}</h2><p>{event.status.replaceAll('_', ' ')}{event.endsAt ? ` · until ${new Date(event.endsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}</p></div>
      </li>)}</ol>
      {!content.events.length && <p>No scheduled events for this day.</p>}
      {content.truncated && <p>More events are available on the controller.</p>}
    </section>}
    {content.kind === 'document' && <section className="presentation-document">
      <p className="presentation-kicker">Document review</p><h1>{content.title}</h1>
      <div className="presentation-identity"><span>Document {content.documentId}</span><span>Revision {content.revisionId}</span><span>SHA-256 {content.contentHash}</span></div>
      {content.newerRevisionAvailable && <p className="presentation-notice">A newer revision exists. This screen keeps the selected revision; choose a new presentation on the controller to change it.</p>}
      {content.mediaType === 'markdown' ? <DocumentMarkdown content={content.content || ''} interactive={false} presentationSafe /> : !assetSrc ? <p role="status">Loading the selected revision’s media…</p> :
        content.mediaType === 'pdf' ? <PdfViewer presentationSafe src={assetSrc} assetKey="primary" annotate={false} /> :
        content.mediaType === 'image' ? <ImageViewer src={assetSrc} alt={content.title} assetKey="primary" annotate={false} /> :
        <VideoViewer src={assetSrc} assetKey="primary" kind="video" mimeType={content.mimeType} annotate={false} />}
    </section>}
    <footer className="presentation-footer"><span>Updated {new Date(sampledAt).toLocaleTimeString()}</span><span>Ends {new Date(session.expiresAt).toLocaleTimeString()} · stop from your controller</span></footer>
  </main>;
}

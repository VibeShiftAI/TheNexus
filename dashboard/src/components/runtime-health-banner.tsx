"use client";

import Link from 'next/link';
import { AlertTriangle } from 'lucide-react';
import { runtimeHealthLabel, useRuntimeHealth } from '@/hooks/use-runtime-health';

/** First content in the root layout, so every cockpit page carries runtime truth. */
export function RuntimeHealthBanner() {
  const health = useRuntimeHealth();
  if (health.status === 'healthy') return null;
  return (
    <aside role="alert" data-runtime-banner={health.status} className="border-b border-amber-400/40 bg-slate-950 px-4 py-3 text-sm text-amber-200">
      <div className="flex items-center gap-2 font-semibold"><AlertTriangle size={18} />{runtimeHealthLabel(health)}</div>
      {health.causes.length > 0 && <ul className="mt-1 space-y-1">
        {health.causes.map(cause => <li key={cause.id}>
          {cause.detail}{' '}<Link className="underline underline-offset-2" href={cause.href.startsWith('/') && !cause.href.startsWith('//') ? cause.href : '/ops'}>View details</Link>
        </li>)}
      </ul>}
      {health.unavailable.length > 0 && <p className="mt-1">
        Status unknown for {health.unavailable.join(', ')}. <Link className="underline underline-offset-2" href="/ops">View runtime details</Link>
      </p>}
      {health.reportCapturedAt && <p className="mt-1 text-xs text-slate-400">Daily checks recorded {new Date(health.reportCapturedAt).toLocaleString()}</p>}
    </aside>
  );
}

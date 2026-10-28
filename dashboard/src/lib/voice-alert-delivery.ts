import { briefFromMetadata } from './human-brief';

export type VoiceAlertStage = 'preparation' | 'archive' | 'playback';
export interface VoiceAlertFailure {
  stage: VoiceAlertStage;
  subject: string;
  textSaved: boolean;
  code: 'unknown' | 'canceled' | 'http-error' | 'browser-blocked' | 'audio-error' | 'cue-failed' | 'interrupted' | 'limited' | 'speech-record-unavailable';
  httpStatus?: number;
  mediaError?: number;
}

/** Titles are human-facing context; event and request identities stay in receipt metadata. */
export function voiceAlertSubject(facts: Record<string, unknown>): string {
  const readable = (value: unknown) => typeof value === 'string' && value.trim().length <= 200
    && !/qa--|[a-f0-9]{8}-[a-f0-9-]{27,}|[_/\\\n]/i.test(value) ? value.trim() : undefined;
  const brief = briefFromMetadata({ brief: facts.brief });
  return readable(facts.title) || readable(brief?.situation) || readable(brief?.project)
    || ({ qa_passed: 'quality review', failed: 'task failure', blocked: 'blocked task', attention: 'input request' }[String(facts.status)] ?? 'Praxis');
}

/** Keep bounded diagnostic codes, never arbitrary exception strings or service response bodies. */
export function voiceAlertFailureReason(error: unknown): Pick<VoiceAlertFailure, 'code' | 'httpStatus' | 'mediaError'> {
  if (error instanceof Error && error.name === 'AbortError') return { code: 'canceled' };
  const message = typeof error === 'string' ? error : error instanceof Error ? error.message : '';
  const http = message.match(/HTTP ([45]\d{2})\b/);
  if (http) return { code: 'http-error', httpStatus: Number(http[1]) };
  const media = message.match(/media error ([1-4])\b/);
  if (media) return { code: 'audio-error', mediaError: Number(media[1]) };
  if (/browser.*block|NotAllowedError/i.test(message)) return { code: 'browser-blocked' };
  if (/limited to 24,000/.test(message)) return { code: 'limited' };
  return { code: 'unknown' };
}

export function voiceAlertFailureText(failure: VoiceAlertFailure): string {
  const operation = { preparation: 'be prepared', archive: 'be saved to Recent Activity', playback: 'finish playing' }[failure.stage];
  const httpReason = failure.httpStatus === 401 || failure.httpStatus === 403 ? ' Access was denied.'
    : failure.httpStatus === 429 ? ' The service was busy.'
      : failure.httpStatus === 408 || failure.httpStatus === 504 || failure.httpStatus === 524 ? ' The service timed out.'
        : failure.httpStatus === 503 ? ' The service was unavailable.'
          : failure.httpStatus && failure.httpStatus < 500 ? ' The service rejected the request.' : ' The service reported an error.';
  const reason = failure.code === 'canceled' ? ' It was canceled.'
    : failure.code === 'http-error' ? httpReason
      : failure.code === 'browser-blocked' ? ' The browser blocked audio.'
        : failure.code === 'audio-error' ? ' Audio stopped during playback.'
          : failure.code === 'cue-failed' ? ' The announcement sound could not play.'
            : failure.code === 'limited' ? ' The spoken text exceeded the playback limit.'
              : failure.code === 'speech-record-unavailable' ? ' The saved record has no spoken version.' : '';
  return `Voice update for “${failure.subject}” could not ${operation}.${reason}${failure.textSaved ? ' The text is saved in Recent Activity.' : ''}`;
}

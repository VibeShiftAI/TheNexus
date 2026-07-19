/**
 * isDayWellUnderway — guard for "zero dispatches today" degraded flags across
 * the bridge (Ops dispatch station, task board station, crew status chip).
 * A zero count is only meaningful once enough of the local day has passed —
 * without this, every station between midnight and dawn would falsely read
 * as a dead fleet instead of a quiet one.
 */
export function isDayWellUnderway(now: Date = new Date()): boolean {
  return now.getHours() >= 4;
}

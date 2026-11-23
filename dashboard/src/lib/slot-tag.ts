/**
 * The one way a scheduled task is named: `S<number>`, the number it received
 * when it joined the day's schedule (Praxis src/scheduler/slot-numbers.ts). The
 * timeline, the approval card and the slate strip all render it from here, so
 * the same task reads the same everywhere.
 */

const TAGGED = /^S\d+ · /;
const LEGACY_SLOT = /^\[Slot (\d+)\]\s*/i;
const LEGACY_AD_HOC = /^\[Ad-hoc\]\s*/i;

export function slotTag(slotNumber: number | null | undefined): string | null {
  return typeof slotNumber === "number" && Number.isInteger(slotNumber) ? `S${slotNumber}` : null;
}

/** A title carrying its tag, or the bare title when the task has no number. */
export function withSlotTag(title: string, slotNumber: number | null | undefined): string {
  const tag = slotTag(slotNumber);
  return tag && !TAGGED.test(title) ? `${tag} · ${title}` : title;
}

/**
 * A calendar event's title as the schedule shows it. Events written before
 * day numbering keep their stored `[Slot 3]` and `[Ad-hoc]` titles; this only
 * changes how they read, so past records stay as they are.
 */
export function displayEventTitle(title: string): string {
  const legacySlot = title.match(LEGACY_SLOT);
  if (legacySlot) return `S${legacySlot[1]} · ${title.slice(legacySlot[0].length)}`;
  return title.replace(LEGACY_AD_HOC, "");
}

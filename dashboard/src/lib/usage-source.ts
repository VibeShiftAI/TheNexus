/**
 * Where a token or cost figure came from, as the server marks it
 * (server/services/usage-source.js). Every attribution surface renders the
 * figure through these helpers so an estimate never looks like a measurement
 * and a missing figure never looks like a zero.
 */
export type UsageSource = "measured" | "estimated" | "unavailable" | "unknown";

const SOURCES: readonly string[] = ["measured", "estimated", "unavailable", "unknown"];

/**
 * The source to render for one figure. Prefers the server's marker; falls
 * back to the older estimate flag only when the payload predates the marker.
 * A non-numeric figure is always unavailable, whatever else the payload says.
 */
export function resolveUsageSource(
  value: number | null | undefined,
  source?: string | null,
  estimated?: boolean | number | null,
): UsageSource {
  if (typeof value !== "number" || !Number.isFinite(value)) return "unavailable";
  if (source && SOURCES.includes(source) && source !== "unavailable") return source as UsageSource;
  if (estimated === undefined || estimated === null) return "unknown";
  return estimated === true || estimated === 1 ? "estimated" : "measured";
}

/** Short visible tag shown beside a figure. Measured figures carry none on compact chips. */
export const USAGE_SOURCE_TAG: Record<UsageSource, string> = {
  measured: "measured",
  estimated: "est",
  unavailable: "unavailable",
  unknown: "source unknown",
};

/** Sentence fragment for tooltips. */
export const USAGE_SOURCE_DETAIL: Record<UsageSource, string> = {
  measured: "measured from the run's own usage record",
  estimated: "ESTIMATED from text volume, not a measured count",
  unavailable: "no usage record exists, so the figure is unavailable (not zero)",
  unknown: "the record does not say whether it was measured or estimated",
};

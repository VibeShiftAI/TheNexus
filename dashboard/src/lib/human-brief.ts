/**
 * The human brief Praxis puts on every message to a person (Praxis
 * `src/comms/human-brief.ts`, contract in Praxis `docs/human-brief.md`):
 * which project, what happened, the one thing that is wrong or undecided,
 * what the reader must do. Inbox cards carry it as `metadata.brief`;
 * registered documents carry it in their `metadata.brief`.
 *
 * The dashboard reads it loosely. A brief that is missing or malformed (an
 * older record, a hand-edited blob) yields `undefined`, and the surface falls
 * back to the rendering it had before the brief existed. Nothing here throws.
 */
export interface HumanBrief {
  kind?: "update";
  project: string;
  situation: string;
  problem: string;
  ask: string;
  options?: string[];
  recommendation?: string;
  ifIgnored?: string;
}

/** Field labels, shared with Praxis's text rendering so chat, email and the dashboard say the same thing. */
export const BRIEF_LABELS: Record<Exclude<keyof HumanBrief, "options" | "kind">, string> = {
  project: "Project",
  situation: "What happened",
  problem: "The problem",
  ask: "What I need from you",
  recommendation: "My recommendation",
  ifIgnored: "If you do nothing",
};

const MAX_FIELD_CHARS = 600;

function field(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() && value.length <= MAX_FIELD_CHARS ? value.trim() : undefined;
}

/** Read a brief off a metadata bag; `undefined` unless every required field is present and sane. */
export function briefFromMetadata(metadata: unknown): HumanBrief | undefined {
  if (!metadata || typeof metadata !== "object") return undefined;
  const raw = (metadata as Record<string, unknown>).brief;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const b = raw as Record<string, unknown>;
  if (b.kind !== undefined && b.kind !== "update") return undefined;
  const project = field(b.project);
  const situation = field(b.situation);
  const optionalUpdateField = (value: unknown) => value === undefined || (typeof value === "string" && !value.trim()) ? "" : field(value);
  const problem = b.kind === "update" ? optionalUpdateField(b.problem) : field(b.problem);
  const ask = b.kind === "update" ? optionalUpdateField(b.ask) : field(b.ask);
  if (!project || !situation || problem === undefined || ask === undefined) return undefined;
  const options = Array.isArray(b.options) ? b.options.filter((o): o is string => typeof o === "string" && !!o.trim()).slice(0, 4) : [];
  const recommendation = field(b.recommendation);
  const ifIgnored = field(b.ifIgnored);
  return {
    ...(b.kind === "update" ? { kind: "update" as const } : {}),
    project, situation, problem, ask,
    ...(options.length ? { options } : {}),
    ...(recommendation ? { recommendation } : {}),
    ...(ifIgnored ? { ifIgnored } : {}),
  };
}

/** Same labelled text as Praxis's renderer; empty update rows carry no obligation. */
export function renderHumanBrief(brief: HumanBrief): string {
  const values = { ...brief, ask: brief.ask && brief.options?.length ? `${brief.ask} Options: ${brief.options.join(" / ")}.` : brief.ask };
  return (Object.keys(BRIEF_LABELS) as (keyof typeof BRIEF_LABELS)[])
    .flatMap(key => values[key] ? [`${BRIEF_LABELS[key]}: ${values[key]}`] : []).join("\n");
}

/** The numbered questions an `ask_robert` card carries, when it does. */
export function briefQuestions(metadata: unknown): string[] {
  if (!metadata || typeof metadata !== "object") return [];
  const raw = (metadata as Record<string, unknown>).questions;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((q) => {
    if (!q || typeof q !== "object") return [];
    const prompt = (q as Record<string, unknown>).prompt;
    const options = (q as Record<string, unknown>).options;
    if (typeof prompt !== "string" || !prompt.trim()) return [];
    const labels = Array.isArray(options) ? options.filter((o): o is string => typeof o === "string") : [];
    return [labels.length ? `${prompt.trim()} (${labels.join(" / ")})` : prompt.trim()];
  });
}

/** The full prose the sender wrote, kept under the brief as detail. */
export function briefDetails(metadata: unknown): string | undefined {
  if (!metadata || typeof metadata !== "object") return undefined;
  const m = metadata as Record<string, unknown>;
  const details = typeof m.details === "string" ? m.details : typeof m.body === "string" ? m.body : undefined;
  return details && details.trim() ? details : undefined;
}

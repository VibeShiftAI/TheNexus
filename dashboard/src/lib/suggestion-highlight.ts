import type { ReviewComment } from "./document-review";
export interface SourceHighlight {
  start: number;
  end: number;
  original: string;
}
/** Never infer a replacement location from a similar passage. */
export function suggestionHighlight(
  comment: ReviewComment,
  content: string,
  revisionId: string | null,
  base?: { revisionId: string; content: string },
): { target: SourceHighlight | null; reason: string | null } {
  const suggestion = comment.suggestion;
  if (!suggestion) return { target: null, reason: null };
  if (
    !base &&
    comment.revision_id === revisionId &&
    content.slice(suggestion.start, suggestion.end) === suggestion.original
  )
    base = { revisionId: revisionId!, content };
  const normalize = (value: string) => value.replace(/\r\n?/g, "\n");
  if (!base || (comment.revision_id && comment.revision_id !== base.revisionId))
    return {
      target: null,
      reason:
        "The original snapshot is unavailable; this text cannot be highlighted safely.",
    };
  if (
    base.content.slice(suggestion.start, suggestion.end) !== suggestion.original
  )
    return {
      target: null,
      reason: "The suggestion does not match its original snapshot.",
    };
  const original = normalize(suggestion.original);
  if (revisionId === base.revisionId && content === normalize(base.content)) {
    const start = normalize(base.content.slice(0, suggestion.start)).length;
    return {
      target: { start, end: start + original.length, original },
      reason: null,
    };
  }
  // A retained passage can move in a newer snapshot, but only an exact,
  // unique quoted target inside its verified anchor is eligible.
  if (
    comment.anchor?.state !== "orphaned" &&
    comment.anchor?.current_start_line &&
    original
  ) {
    const line = comment.anchor.current_start_line;
    const lines = content.split("\n");
    const startOfLine = lines
      .slice(0, line - 1)
      .reduce((n, text) => n + text.length + 1, 0);
    const match = content.indexOf(original, startOfLine);
    const expectedLines = Math.max(
      1,
      (comment.end_line ?? comment.start_line ?? line) -
        (comment.start_line ?? line) +
        1,
    );
    const endOfBlock =
      startOfLine +
      lines.slice(line - 1, line - 1 + expectedLines).join("\n").length;
    if (
      match >= startOfLine &&
      match + original.length <= endOfBlock &&
      content.indexOf(original, match + 1) === -1 &&
      content.indexOf(original) === match
    )
      return {
        target: { start: match, end: match + original.length, original },
        reason: null,
      };
  }
  return {
    target: null,
    reason:
      "This suggestion targets an earlier or changed passage. Its exact text cannot be highlighted in this snapshot.",
  };
}

const fail = (message, code = "invalid_review", status = 400) => {
  throw Object.assign(new Error(message), { code, status });
};
const short = (value) =>
  typeof value === "string" && value.trim().length > 0 && value.length <= 120;
function validateRange(item, base) {
  if (
    !Number.isSafeInteger(item.start) ||
    !Number.isSafeInteger(item.end) ||
    item.start < 0 ||
    item.end < item.start ||
    item.end > base.length ||
    typeof item.original !== "string" ||
    base.slice(item.start, item.end) !== item.original
  )
    fail("Range must match exact assigned source text");
  for (const n of [item.start, item.end])
    if (
      n > 0 &&
      n < base.length &&
      /[\uD800-\uDBFF]/.test(base[n - 1]) &&
      /[\uDC00-\uDFFF]/.test(base[n])
    )
      fail("Range splits a UTF-16 surrogate pair");
}
function validateFindings(body, base, mediaType) {
  if (
    !short(body.client_submission_id) ||
    typeof body.summary !== "string" ||
    body.summary.length > 20000
  )
    fail("Submission ID and summary are required");
  if (
    !Array.isArray(body.comments) ||
    !Array.isArray(body.suggestions) ||
    body.comments.length + body.suggestions.length > 500
  )
    fail("comments and suggestions arrays required (maximum 500 findings)");
  if (body.suggestions.length && !["markdown", "text"].includes(mediaType))
    fail("This document type supports comments only", "not_editable", 409);
  if (!body.comments.length && !body.suggestions.length && !body.summary.trim())
    fail("An explicit no-changes assessment is required");
  const ids = new Set();
  const clean = (item, suggestion) => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      fail("Finding must be an object");
    if (!short(item.id) || ids.has(item.id)) fail("Finding IDs must be unique");
    ids.add(item.id);
    if (suggestion || item.start !== undefined || item.end !== undefined)
      validateRange(item, base);
    if (suggestion) {
      if (
        typeof item.proposed !== "string" ||
        item.proposed.length > 1000000 ||
        typeof item.explanation !== "string" ||
        !item.explanation.trim() ||
        item.explanation.length > 20000
      )
        fail("Suggestion requires proposed text and explanation");
      return {
        id: item.id,
        start: item.start,
        end: item.end,
        original: item.original,
        proposed: item.proposed,
        explanation: item.explanation,
      };
    }
    if (
      typeof item.body !== "string" ||
      !item.body.trim() ||
      item.body.length > 20000
    )
      fail("Comment body required");
    return {
      id: item.id,
      body: item.body,
      ...(item.start === undefined
        ? {}
        : { start: item.start, end: item.end, original: item.original }),
    };
  };
  return {
    client_submission_id: body.client_submission_id,
    summary: body.summary,
    comments: body.comments.map((x) => clean(x, false)),
    suggestions: body.suggestions.map((x) => clean(x, true)),
  };
}
function composeSuggestions(base, suggestions, choices) {
  const edits = choices
    .filter((c) => c.status === "accepted")
    .map((c) => {
      const s = suggestions.find((s) => s.id === c.suggestion_id);
      if (!s) fail("Unknown suggestion");
      validateRange(s, base);
      return {
        ...s,
        proposed: c.replacement === undefined ? s.proposed : c.replacement,
      };
    })
    .sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < edits.length; i++)
    if (
      edits[i].start < edits[i - 1].end ||
      edits[i].start === edits[i - 1].start
    )
      fail(
        "Accepted suggestions overlap; choose one alternative",
        "overlapping_suggestions",
        409,
      );
  let content = base;
  for (const e of edits.reverse())
    content = content.slice(0, e.start) + e.proposed + content.slice(e.end);
  return content;
}
module.exports = { validateFindings, composeSuggestions, fail, short };

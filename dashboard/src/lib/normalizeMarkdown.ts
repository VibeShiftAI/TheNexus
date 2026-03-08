/**
 * normalizeMarkdown — Ensures proper spacing in LLM-generated markdown.
 *
 * LLMs sometimes emit markdown with missing blank lines between sections,
 * causing headers, bold labels, and lists to render jammed together.
 * This utility inserts proper spacing so ReactMarkdown can render cleanly.
 *
 * Applied at the rendering boundary (frontend) so it acts as a universal
 * safety net regardless of content source (Cortex, LangGraph, manual edits).
 */

export function normalizeMarkdown(text: string | null | undefined): string {
    if (!text) return '';

    let result = text;

    // 1. Normalize line endings to \n
    result = result.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    // 2. Ensure blank line before markdown headers (# ## ### etc.)
    //    Only if not already preceded by a blank line or start of string
    result = result.replace(/([^\n])\n(#{1,6}\s)/g, '$1\n\n$2');

    // 3. Ensure blank line before bold labels that start a new conceptual section
    //    e.g. **Goal:** **Workflow:** — but NOT inside list items like "- **Label:**"
    //    Only triggers when the bold label starts at column 0 (not indented/in a list)
    result = result.replace(/([^\n])\n(\*\*[A-Z][^*]*:\*\*)/g, (match, before, label) => {
        // Don't add spacing if preceding line is a list item or if this is inside a list
        if (/[-*]\s/.test(before) || /\d+\.\s/.test(before)) return match;
        return `${before}\n\n${label}`;
    });

    // 4. Ensure blank line before numbered lists (1. 2. 3. etc.)
    //    Only when the preceding line is NOT also a list item
    result = result.replace(/([^\n])\n(\d+\.\s)/g, (match, before, listItem) => {
        // Don't add extra spacing between consecutive list items
        if (/\d+\.\s/.test(before) || /^[-*]\s/.test(before)) return match;
        return `${before}\n\n${listItem}`;
    });

    // 5. Ensure blank line before bullet lists (- or * at start of line)
    //    Only when the preceding line is NOT also a list item
    result = result.replace(/([^\n])\n([-*]\s)/g, (match, before, listItem) => {
        if (/^[-*]\s/.test(before) || /\d+\.\s/.test(before)) return match;
        return `${before}\n\n${listItem}`;
    });

    // 6. Collapse 3+ consecutive blank lines down to just 1 blank line
    result = result.replace(/\n{3,}/g, '\n\n');

    // 7. Trim leading/trailing whitespace
    result = result.trim();

    return result;
}

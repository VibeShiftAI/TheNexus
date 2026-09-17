// Pure helpers for the document reviewer: heading outline and exact source
// quotes by line range. Line numbers are 1-based and refer to the stored
// revision text exactly as the API returns it (no normalization), which is
// what the server verifies passage anchors against.

export interface OutlineEntry {
    level: number;
    text: string;
    line: number;
    id: string;
}

const FENCE = /^\s*(```|~~~)/;
const ATX = /^(#{1,6})\s+(.*?)\s*#*\s*$/;

function stripInline(text: string): string {
    return text
        .replace(/`([^`]*)`/g, '$1')
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/[*_~]+/g, '')
        .trim();
}

export function extractOutline(content: string): OutlineEntry[] {
    const entries: OutlineEntry[] = [];
    let inFence = false;
    const lines = (content ?? '').split('\n');
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (FENCE.test(line)) { inFence = !inFence; continue; }
        if (inFence) continue;
        const match = ATX.exec(line);
        if (!match) continue;
        const text = stripInline(match[2]);
        if (!text) continue;
        entries.push({ level: match[1].length, text, line: i + 1, id: `L${i + 1}` });
    }
    return entries;
}

export function quoteLines(content: string, start: number, end: number): string {
    const lines = (content ?? '').split('\n');
    const from = Math.max(1, Math.floor(start));
    const to = Math.min(lines.length, Math.floor(end));
    if (to < from) return '';
    return lines.slice(from - 1, to).join('\n');
}

export function blockElementId(line: number): string {
    return `L${line}`;
}

export function excerpt(text: string | null | undefined, max = 160): string {
    const flat = (text ?? '').replace(/\s+/g, ' ').trim();
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

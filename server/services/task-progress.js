/** Read-only, allow-listed public commentary. Never return raw transcripts. */
const fs = require('fs');
const path = require('path');
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_BOUNDARY_PREFIX_BYTES = 8 * 1024 * 1024;
function publicText(value) {
    if (typeof value !== 'string') return '';
    return value.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[redacted key]')
        .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, '$1[redacted]')
        .replace(/\b((?:[A-Z_]*(?:API_KEY|TOKEN|SECRET|PASSWORD)|api[_-]?key|password)\s*[=:]\s*)[^\s,;]+/gi, '$1[redacted]')
        .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,})\b/g, '[redacted]')
        .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, '$1[redacted]@')
        .slice(0, 6000).trim();
}
function parseProgressLog(text, run) {
    const start = Date.parse(run.started_at);
    const end = Math.min(Date.parse(run.completed_at) || Infinity, Date.parse(run.nextStartedAt) || Infinity);
    let matched = false; let inside = false; const messages = [];
    for (const line of text.split(/\r?\n/)) {
        const marker = /^=== (.+?) (?:detached )?run started (\S+) ===$/.exec(line);
        if (marker) {
            const time = Date.parse(marker[2]);
            const executor = marker[1].toLowerCase().replace(' ', '-');
            inside = executor === run.executor && Number.isFinite(start) && time >= start && time < end;
            matched ||= inside;
            continue;
        }
        if (/^=== .*run ended /.test(line)) { inside = false; continue; }
        if (!inside || !line.startsWith('{')) continue;
        let e; try { e = JSON.parse(line); } catch { continue; }
        const values = [];
        if (run.executor === 'codex' && e.type === 'item.completed' && e.item?.type === 'agent_message') values.push(e.item.text);
        if (run.executor === 'claude-code' && e.type === 'assistant' && Array.isArray(e.message?.content)) {
            for (const block of e.message.content) if (block?.type === 'text') values.push(block.text);
        }
        for (const value of values) {
            const text = publicText(value);
            const time = typeof e.timestamp === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(e.timestamp) ? Date.parse(e.timestamp) : NaN;
            const at = Number.isFinite(time) && time >= start && time < end ? new Date(time).toISOString() : null;
            if (text) messages.push({ text, at, sequence: messages.length + 1 });
        }
    }
    return { available: matched, reason: matched ? null : 'The bounded log has no matching attempt boundary; current commentary cannot be attributed safely.', messages: messages.slice(-40), truncated: messages.length > 40 };
}
function readProgressLog(run, roots) {
    const unavailable = (reason) => ({ available: false, reason, messages: [], truncated: false });
    if (!['codex', 'claude-code'].includes(run.executor)) return unavailable('This executor does not expose structured public commentary.');
    if (!run.log_path) return unavailable('No log was recorded for this attempt.');
    try {
        const file = fs.realpathSync(run.log_path);
        if (!roots.some(root => { try { const rel = path.relative(fs.realpathSync(root), file); return rel && !rel.startsWith('..') && !path.isAbsolute(rel); } catch { return false; } })) return unavailable('Recorded log is outside allowed roots.');
        const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try {
            const stat = fs.fstatSync(fd);
            if (!stat.isFile()) return unavailable('Recorded log is not a regular file.');
            const offset = Math.max(0, stat.size - MAX_BYTES); const buffer = Buffer.alloc(Math.min(stat.size, MAX_BYTES));
            const read = fs.readSync(fd, buffer, 0, buffer.length, offset);
            let text = buffer.subarray(0, read).toString('utf8');
            if (offset) {
                const newline = text.indexOf('\n');
                const skippedLine = newline < 0 ? text : text.slice(0, newline + 1);
                text = newline < 0 ? '' : text.slice(newline + 1);
                // A long attempt can push its start banner outside the tail.
                // Prove the last boundary before that tail; never infer run
                // identity from the filename or the board's active status.
                if (offset <= MAX_BOUNDARY_PREFIX_BYTES) {
                    const prefix = Buffer.alloc(offset);
                    const prefixRead = fs.readSync(fd, prefix, 0, offset, 0);
                    if (prefixRead === offset) {
                        const boundaries = (prefix.toString('utf8') + skippedLine).match(/^=== .*(?:run started|run ended) .*===$/gm);
                        if (boundaries?.length) text = boundaries.at(-1) + '\n' + text;
                    }
                }
            }
            const parsed = parseProgressLog(text, run);
            return { ...parsed, truncated: parsed.truncated || offset > 0, observedAt: stat.mtime.toISOString() };
        } finally { fs.closeSync(fd); }
    } catch { return unavailable('Recorded commentary is unavailable.'); }
}
// ag_events.created_at is SQLite datetime('now'): a UTC value without a suffix.
function activityTimestamp(value) {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)
        ? value.replace(' ', 'T') + 'Z' : value;
}
module.exports = { parseProgressLog, readProgressLog, publicText, activityTimestamp };

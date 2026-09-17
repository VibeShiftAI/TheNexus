/**
 * task-links — turns Nexus task ids mentioned in chat into links to the task.
 *
 * Praxis names tasks by raw id in the transcript ("**Task:** `fd648080-…`"),
 * which used to be a dead end: the only way to open the task was to select the
 * id, copy it, and paste it into the URL bar. Every mention now renders as a
 * link to /task/<id> — the same screen board cards, the inbox, and the ops
 * page already deep-link to.
 *
 * Ids are RFC-4122-shaped, and a few other things in the transcript share that
 * shape (relayed executor tool calls carry `project_id="<uuid>"`), so mentions
 * in an obviously-not-a-task context are left as plain text.
 */

const TASK_ID_SOURCE =
    "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";

/** Neighbouring word characters mean it is part of a longer token, not an id. */
const TASK_ID_GLOBAL = new RegExp(`(?<![0-9a-zA-Z-])${TASK_ID_SOURCE}(?![0-9a-zA-Z-])`, "g");
const TASK_ID_EXACT = new RegExp(`^${TASK_ID_SOURCE}$`);

/** `project_id="<uuid>"`, `conversationId: <uuid>` — an id, but not a task's. */
const NON_TASK_LABEL =
    /(project|conversation|interaction|run|dispatch|artifact|workspace|session|message|thread|user)[_-]?id["']?\s*[=:]\s*["'`]?$/i;

/** Route a task id to the task screen. Kept in one place so callers agree. */
export function taskHref(id: string): string {
    return `/task/${encodeURIComponent(id)}`;
}

/** True for hrefs produced by {@link taskHref} — used to keep them in-app. */
export function isTaskHref(href: string | undefined): href is string {
    return typeof href === "string" && href.startsWith("/task/");
}

/**
 * Hosts that serve this dashboard. The Mac bridge app (desktop/src-tauri,
 * macOS personality) loads http://localhost:3000; the phone shell and the
 * Windows travel shell load the Cloudflare tunnel host; the page's own host
 * covers everything else (a verify stack on another port, a future rename).
 * Any link that lands on one of these is the same app Robert is already
 * signed into, so it must navigate in place rather than open a new
 * window — a new window on the tunnel host means a fresh Cloudflare Access
 * login, which is exactly the "sign in separately" hop this removes
 * (2026-09-10, task 762637e6).
 */
const DASHBOARD_HOSTS = new Set(["nexus.vibeshiftai.com", "localhost:3000", "127.0.0.1:3000"]);

/**
 * First path segments of the dashboard's own App Router pages
 * (dashboard/src/app/*). Anything else on a dashboard host — /api/*,
 * /socket.io, the Cortex /graph and /runs ingress, /hub, /login — is not a
 * page this client renders and keeps the plain-anchor behaviour.
 */
const IN_APP_ROUTES = new Set([
    "academy", "activity", "agents", "calendar", "codex", "core-lab", "council",
    "dispatch-preview", "documents", "inbox", "intake-reports", "knowledge-ingestion",
    "llm-activity", "local-queue", "mail", "model-control", "module-preview", "ops",
    "project", "studio", "system-monitor", "task", "task-board", "workflow-builder",
]);

function isDashboardHost(host: string): boolean {
    if (DASHBOARD_HOSTS.has(host)) return true;
    if (typeof window !== "undefined" && window.location && window.location.host.toLowerCase() === host) return true;
    return false;
}

function isInAppPath(path: string): boolean {
    const pathname = path.split(/[?#]/, 1)[0];
    if (pathname === "/") return true;
    return IN_APP_ROUTES.has(pathname.split("/")[1] ?? "");
}

/**
 * The in-app path for a chat link, or null when the link must stay a plain
 * anchor. A same-origin path ("/task/<id>", "/inbox#<hitlId>",
 * "/documents/<id>") comes back as is; an absolute URL on a dashboard host
 * (see DASHBOARD_HOSTS) collapses to its path + query + hash so the Next
 * router opens it on the current origin, inside the current session. Every
 * other scheme, host or path returns null.
 */
export function internalHref(href: string | undefined): string | null {
    if (typeof href !== "string") return null;
    const trimmed = href.trim();
    if (!trimmed) return null;
    if (trimmed.startsWith("/")) {
        if (trimmed.startsWith("//") || trimmed.startsWith("/\\")) return null;
        return isInAppPath(trimmed) ? trimmed : null;
    }
    let url: URL;
    try { url = new URL(trimmed); } catch { return null; }
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password) return null;
    if (!isDashboardHost(url.host.toLowerCase())) return null;
    const path = `${url.pathname}${url.search}${url.hash}`;
    return isInAppPath(path) ? path : null;
}

/**
 * In-app routes that chat markdown may link to. Praxis notices link
 * "/inbox#<hitlId>" (and "/task/<id>") so a system message can hand Robert
 * straight to the card that decides the alert; these must navigate the app,
 * not open a new tab (2026-08-30 chat-isolation rework). Since 2026-09-10 the
 * same holds for every dashboard page, including document-review links that
 * Praxis mints as absolute tunnel URLs — see {@link internalHref}.
 */
export function isInternalHref(href: string | undefined): href is string {
    return internalHref(href) !== null;
}

export function isTaskId(value: string): boolean {
    return TASK_ID_EXACT.test(value.trim());
}

export type TaskIdSegment =
    | { type: "text"; value: string }
    | { type: "taskId"; id: string };

/**
 * Split prose into plain-text runs and the task ids mentioned inside it.
 * A string with no mention comes back as a single text segment.
 */
export function splitOnTaskIds(value: string): TaskIdSegment[] {
    const segments: TaskIdSegment[] = [];
    let cursor = 0;

    TASK_ID_GLOBAL.lastIndex = 0;
    for (let match = TASK_ID_GLOBAL.exec(value); match; match = TASK_ID_GLOBAL.exec(value)) {
        // Look back far enough to catch `project_id="` and friends.
        if (NON_TASK_LABEL.test(value.slice(Math.max(0, match.index - 32), match.index))) continue;
        if (match.index > cursor) segments.push({ type: "text", value: value.slice(cursor, match.index) });
        segments.push({ type: "taskId", id: match[0] });
        cursor = match.index + match[0].length;
    }

    if (cursor === 0) return [{ type: "text", value }];
    if (cursor < value.length) segments.push({ type: "text", value: value.slice(cursor) });
    return segments;
}

// ── remark plugin ──────────────────────────────────────────────────────────
// Markdown-rendered turns (assistant replies, Praxis event cards) go through
// remark, so the rewrite happens on the mdast: text runs get split, and an
// inline-code id becomes a link wrapping the same code span (Praxis writes
// them as `**Task:** \`<id>\``, and that monospace styling is worth keeping).

interface MdastNode {
    type: string;
    value?: string;
    url?: string;
    title?: string | null;
    children?: MdastNode[];
}

/** Nodes whose contents are never linkified: code stays code, links stay flat. */
const OPAQUE_NODES = new Set([
    "code",
    "html",
    "link",
    "linkReference",
    "definition",
    "image",
    "imageReference",
]);

function taskLinkNode(id: string, child: MdastNode): MdastNode {
    return { type: "link", url: taskHref(id), title: `Open task ${id}`, children: [child] };
}

function linkifyChildren(node: MdastNode): void {
    if (!Array.isArray(node.children)) return;

    const rewritten: MdastNode[] = [];
    let changed = false;

    for (const child of node.children) {
        if (child.type === "text" && typeof child.value === "string") {
            const segments = splitOnTaskIds(child.value);
            if (segments.length === 1 && segments[0].type === "text") {
                rewritten.push(child);
                continue;
            }
            changed = true;
            for (const segment of segments) {
                rewritten.push(
                    segment.type === "text"
                        ? { type: "text", value: segment.value }
                        : taskLinkNode(segment.id, { type: "text", value: segment.id }),
                );
            }
            continue;
        }

        if (child.type === "inlineCode" && typeof child.value === "string" && isTaskId(child.value)) {
            changed = true;
            rewritten.push(taskLinkNode(child.value.trim(), { type: "inlineCode", value: child.value }));
            continue;
        }

        if (!OPAQUE_NODES.has(child.type)) linkifyChildren(child);
        rewritten.push(child);
    }

    if (changed) node.children = rewritten;
}

/** remark plugin: rewrite every task-id mention into a link to the task. */
export function remarkTaskLinks() {
    return function transformer(tree: MdastNode): void {
        linkifyChildren(tree);
    };
}

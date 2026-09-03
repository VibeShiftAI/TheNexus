/**
 * skill-wiki — client data logic for the cockpit's skill-wiki browser.
 *
 * The vault writes skills as markdown with [[wiki-links]]; the wiki renders
 * them as navigation. A [[link]] whose target is a known skill routes to that
 * skill's page; anything else (memories, notes) degrades to plain styled text
 * — the vault's memory files have no cockpit page yet, so pretending they are
 * links would be a dead end, not navigation.
 */

export interface SkillIndexEntry {
    id: string;
    name: string;
    category: string;
    summary: string | null;
    tags: string[];
    provenance: string | null;
    evidenceProvenance: string | null;
    evidenceCount: number;
    hasKnowledge: boolean;
    confidence: number | null;
    source: string | null;
    created: string | null;
    updated: string | null;
    state: string | null;
    pinned: boolean;
    recallCount: number | null;
    successCount: number | null;
    failureCount: number | null;
    lastUsedAt: string | null;
    hasTelemetry: boolean;
}

export interface SkillIndexResponse {
    total: number;
    byCategory: Record<string, number>;
    skills: SkillIndexEntry[];
}

export interface SkillEvidence {
    raw: string;
    kind: "vault" | "url" | "nexus-task" | "session" | "other";
    target: string;
}

export interface SkillTelemetry {
    recallCount: number;
    promptInjectionCount: number;
    successCount: number;
    failureCount: number;
    state: string | null;
    pinned: boolean;
    lastRecalledAt: string | null;
    lastUsedAt: string | null;
    archivedReason: string | null;
}

export interface SkillDetail {
    name: string;
    category: string;
    relPath: string;
    frontmatter: Record<string, string | string[]>;
    manifest: string;
    evidence: SkillEvidence[];
    knowledge: string | null;
    telemetry: SkillTelemetry | null;
    related: { inbound: string[]; outbound: string[] };
    knownSkills: string[];
}

/** Route a skill name to its wiki page. Kept in one place so callers agree. */
export function skillHref(name: string): string {
    return `/academy/skill/${encodeURIComponent(name)}`;
}

export async function getSkillIndex(): Promise<SkillIndexResponse> {
    const res = await fetch("/api/skill-wiki/skills", { cache: "no-store" });
    if (!res.ok) throw new Error(`skill index unavailable (${res.status})`);
    return res.json();
}

export async function getSkillDetail(name: string): Promise<SkillDetail> {
    const res = await fetch(`/api/skill-wiki/skills/${encodeURIComponent(name)}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`skill unavailable (${res.status})`);
    return res.json();
}

// ── wiki-link rendering ────────────────────────────────────────────────────

export type WikiLinkSegment =
    | { type: "text"; value: string }
    | { type: "skill"; name: string }
    | { type: "vaultRef"; name: string };

const WIKI_LINK_GLOBAL = /\[\[([^\[\]]+)\]\]/g;

/**
 * Split prose into plain-text runs and [[wiki-link]] mentions. Links naming a
 * known skill become in-wiki navigation; the rest are vault references shown
 * as text. A string with no mention comes back as a single text segment.
 */
export function splitWikiLinks(value: string, knownSkills: Iterable<string>): WikiLinkSegment[] {
    const skills = knownSkills instanceof Set ? knownSkills : new Set(knownSkills);
    const segments: WikiLinkSegment[] = [];
    let cursor = 0;

    WIKI_LINK_GLOBAL.lastIndex = 0;
    for (let match = WIKI_LINK_GLOBAL.exec(value); match; match = WIKI_LINK_GLOBAL.exec(value)) {
        const target = match[1].trim();
        if (match.index > cursor) segments.push({ type: "text", value: value.slice(cursor, match.index) });
        segments.push(skills.has(target) ? { type: "skill", name: target } : { type: "vaultRef", name: target });
        cursor = match.index + match[0].length;
    }

    if (cursor === 0) return [{ type: "text", value }];
    if (cursor < value.length) segments.push({ type: "text", value: value.slice(cursor) });
    return segments;
}

// ── remark plugin ──────────────────────────────────────────────────────────
// Same shape as remarkTaskLinks (lib/task-links.ts): rewrite mdast text runs
// so [[skill]] mentions become links and other [[refs]] become inline code.

interface MdastNode {
    type: string;
    value?: string;
    url?: string;
    title?: string | null;
    children?: MdastNode[];
}

const OPAQUE_NODES = new Set([
    "code",
    "html",
    "link",
    "linkReference",
    "definition",
    "image",
    "imageReference",
]);

function segmentNode(segment: WikiLinkSegment): MdastNode {
    if (segment.type === "text") return { type: "text", value: segment.value };
    if (segment.type === "skill") {
        return {
            type: "link",
            url: skillHref(segment.name),
            title: `Open skill ${segment.name}`,
            children: [{ type: "text", value: segment.name }],
        };
    }
    return { type: "inlineCode", value: segment.name };
}

function linkifyChildren(node: MdastNode, skills: Set<string>): void {
    if (!Array.isArray(node.children)) return;

    const rewritten: MdastNode[] = [];
    let changed = false;

    for (const child of node.children) {
        if (child.type === "text" && typeof child.value === "string") {
            const segments = splitWikiLinks(child.value, skills);
            if (segments.length === 1 && segments[0].type === "text") {
                rewritten.push(child);
                continue;
            }
            changed = true;
            for (const segment of segments) rewritten.push(segmentNode(segment));
            continue;
        }
        if (!OPAQUE_NODES.has(child.type)) linkifyChildren(child, skills);
        rewritten.push(child);
    }

    if (changed) node.children = rewritten;
}

/** remark plugin: rewrite [[wiki-link]] mentions into wiki navigation. */
export function remarkWikiLinks(knownSkills: string[]) {
    const skills = new Set(knownSkills);
    return function transformer(tree: MdastNode): void {
        linkifyChildren(tree, skills);
    };
}

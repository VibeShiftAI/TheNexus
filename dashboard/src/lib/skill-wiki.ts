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
    /** Display name. Harvested skills have names with spaces ("Fold Context"). */
    name: string;
    /** File name of the manifest ("fold-context"): what the skill's page is linked by. */
    slug: string;
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

/**
 * Every name a link may use for a skill, mapped to the slug of its page.
 * Related-skill lists use display names; [[wiki-links]] in the vault use file
 * names. Both are keys here.
 */
export type SkillSlugs = Record<string, string>;

export interface SkillDetail {
    name: string;
    slug: string;
    category: string;
    relPath: string;
    frontmatter: Record<string, string | string[]>;
    manifest: string;
    evidence: SkillEvidence[];
    knowledge: string | null;
    telemetry: SkillTelemetry | null;
    /** Display names of the skills this one links to and is linked from. */
    related: { inbound: string[]; outbound: string[] };
    knownSkills: string[];
    skillSlugs: SkillSlugs;
}

/**
 * Route a skill to its wiki page. Kept in one place so callers agree. Pass
 * the slug: a display name only works when it has no spaces.
 */
export function skillHref(slug: string): string {
    return `/academy/skill/${encodeURIComponent(slug)}`;
}

// The dashboard hot-reloads and the API does not, so an API process started
// before pages had slugs can answer these two calls without them. Until it
// restarts, fall back to linking by name: the pages that opened then still do.

export async function getSkillIndex(): Promise<SkillIndexResponse> {
    const res = await fetch("/api/skill-wiki/skills", { cache: "no-store" });
    if (!res.ok) throw new Error(`skill index unavailable (${res.status})`);
    const index: SkillIndexResponse = await res.json();
    return { ...index, skills: index.skills.map((s) => ({ ...s, slug: s.slug ?? s.name })) };
}

/** `slug` is what skillHref was given; a display name without spaces opens the same page. */
export async function getSkillDetail(slug: string): Promise<SkillDetail> {
    const res = await fetch(`/api/skill-wiki/skills/${encodeURIComponent(slug)}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`skill unavailable (${res.status})`);
    const detail: SkillDetail = await res.json();
    return {
        ...detail,
        slug: detail.slug ?? detail.name,
        skillSlugs: detail.skillSlugs ?? Object.fromEntries(detail.knownSkills.map((name) => [name, name])),
    };
}

// ── wiki-link rendering ────────────────────────────────────────────────────

export type WikiLinkSegment =
    | { type: "text"; value: string }
    | { type: "skill"; name: string; slug: string }
    | { type: "vaultRef"; name: string };

const WIKI_LINK_GLOBAL = /\[\[([^\[\]]+)\]\]/g;

/**
 * Split prose into plain-text runs and [[wiki-link]] mentions. Links naming a
 * known skill (by display name or by file name) become in-wiki navigation to
 * that skill's slug; the rest are vault references shown as text. A string
 * with no mention comes back as a single text segment.
 */
export function splitWikiLinks(value: string, skillSlugs: ReadonlyMap<string, string>): WikiLinkSegment[] {
    const segments: WikiLinkSegment[] = [];
    let cursor = 0;

    WIKI_LINK_GLOBAL.lastIndex = 0;
    for (let match = WIKI_LINK_GLOBAL.exec(value); match; match = WIKI_LINK_GLOBAL.exec(value)) {
        const target = match[1].trim();
        if (match.index > cursor) segments.push({ type: "text", value: value.slice(cursor, match.index) });
        const slug = skillSlugs.get(target);
        segments.push(slug === undefined ? { type: "vaultRef", name: target } : { type: "skill", name: target, slug });
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
            url: skillHref(segment.slug),
            title: `Open skill ${segment.name}`,
            children: [{ type: "text", value: segment.name }],
        };
    }
    return { type: "inlineCode", value: segment.name };
}

function linkifyChildren(node: MdastNode, skills: ReadonlyMap<string, string>): void {
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
export function remarkWikiLinks(skillSlugs: SkillSlugs) {
    const skills = new Map(Object.entries(skillSlugs));
    return function transformer(tree: MdastNode): void {
        linkifyChildren(tree, skills);
    };
}

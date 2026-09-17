"use client";

/**
 * Full-format Markdown for the document reviewer.
 *
 * Renders the stored revision text exactly (GFM tables, lists, fences,
 * links) and stamps every top-level block with its source line range so a
 * comment can anchor to the block's real lines. Each block carries an
 * explicit comment control that is always visible on touch screens and
 * appears on hover/focus on desktop; selecting text inside a block quotes
 * the selection. Raw HTML is shown as text (never rendered) and
 * react-markdown's default URL transform drops javascript:/data: targets.
 */

import { createContext, useCallback, useContext, useEffect, useRef, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { MessageSquarePlus } from "lucide-react";
import { blockElementId } from "@/lib/document-outline";

export interface BlockRef {
    start: number;
    end: number;
}

interface BlockContextValue {
    selected: BlockRef | null;
    commentCounts: Record<number, number>;
    interactive: boolean;
    onBlockSelect?: (block: BlockRef, extra?: { selection?: string }) => void;
}

const BlockContext = createContext<BlockContextValue>({ selected: null, commentCounts: {}, interactive: false });

type HastNode = { type: string; position?: { start: { line: number }; end: { line: number } }; properties?: Record<string, unknown> };

/** Stamp root-level element nodes with their source line range. */
function rehypeBlockAnchors() {
    return (tree: { children: HastNode[] }) => {
        for (const node of tree.children) {
            if (node.type !== "element" || !node.position) continue;
            node.properties = node.properties || {};
            node.properties.dataBlockStart = String(node.position.start.line);
            node.properties.dataBlockEnd = String(node.position.end.line);
        }
    };
}

type BlockProps = Record<string, unknown> & { children?: ReactNode; node?: unknown; "data-block-start"?: string; "data-block-end"?: string };

function BlockShell({ start, end, children }: { start: number; end: number; children: ReactNode }) {
    const { selected, commentCounts, interactive, onBlockSelect } = useContext(BlockContext);
    const isSelected = selected?.start === start;
    const count = commentCounts[start] || 0;
    const select = (event: React.MouseEvent) => {
        event.stopPropagation();
        onBlockSelect?.({ start, end });
    };
    return (
        <div
            id={blockElementId(start)}
            data-review-block=""
            data-block-start={start}
            data-block-end={end}
            className={`review-block group relative -mx-2 rounded-md px-2 py-0.5 transition-colors ${
                isSelected ? "bg-cyan-500/10 ring-1 ring-cyan-400/60" : count > 0 ? "bg-amber-500/5" : ""
            }`}
        >
            {children}
            {interactive && (
                <button
                    type="button"
                    onClick={select}
                    aria-label={start === end ? `Comment on line ${start}` : `Comment on lines ${start} to ${end}`}
                    data-block-comment-button=""
                    className={`absolute -right-7 top-0 inline-flex h-8 min-w-8 items-center justify-center gap-1 rounded-full border px-2 text-[11px] font-medium shadow-sm transition-opacity md:-right-10 md:top-1 ${
                        count > 0
                            ? "border-amber-400/50 bg-amber-500/20 text-amber-200"
                            : "border-slate-600 bg-slate-900 text-slate-300"
                    } opacity-100 md:opacity-0 md:group-hover:opacity-100 md:focus:opacity-100 ${isSelected ? "md:opacity-100" : ""}`}
                >
                    <MessageSquarePlus size={14} />
                    {count > 0 ? <span>{count}</span> : null}
                </button>
            )}
        </div>
    );
}

function blockComponent(tag: string) {
    const Block = (props: BlockProps) => {
        const { node: _node, children, ...rest } = props;
        void _node;
        const start = Number(rest["data-block-start"]);
        const end = Number(rest["data-block-end"]);
        delete rest["data-block-start"];
        delete rest["data-block-end"];
        const Tag = tag as keyof React.JSX.IntrinsicElements;
        const element =
            tag === "table" ? (
                <div className="overflow-x-auto">
                    <Tag {...(rest as Record<string, unknown>)}>{children}</Tag>
                </div>
            ) : tag === "hr" ? (
                <Tag {...(rest as Record<string, unknown>)} />
            ) : (
                <Tag {...(rest as Record<string, unknown>)}>{children}</Tag>
            );
        if (!Number.isFinite(start) || !Number.isFinite(end)) return element;
        return <BlockShell start={start} end={end}>{element}</BlockShell>;
    };
    Block.displayName = `ReviewBlock(${tag})`;
    return Block;
}

function Anchor(props: BlockProps & { href?: string }) {
    const { node: _node, href, children, ...rest } = props;
    void _node;
    const external = typeof href === "string" && /^https?:\/\//i.test(href);
    return (
        <a
            {...(rest as Record<string, unknown>)}
            href={href || undefined}
            target={external ? "_blank" : undefined}
            rel={external ? "noopener noreferrer" : undefined}
            className="text-cyan-300 underline decoration-cyan-500/40 underline-offset-2 hover:text-cyan-200"
        >
            {children}
        </a>
    );
}

const COMPONENTS: Components = {
    p: blockComponent("p"),
    h1: blockComponent("h1"),
    h2: blockComponent("h2"),
    h3: blockComponent("h3"),
    h4: blockComponent("h4"),
    h5: blockComponent("h5"),
    h6: blockComponent("h6"),
    ul: blockComponent("ul"),
    ol: blockComponent("ol"),
    table: blockComponent("table"),
    pre: blockComponent("pre"),
    blockquote: blockComponent("blockquote"),
    hr: blockComponent("hr"),
    a: Anchor,
} as Components;

const PROSE =
    "prose prose-invert max-w-none prose-p:text-slate-200 prose-p:leading-relaxed prose-li:text-slate-200 prose-strong:text-white " +
    "prose-headings:text-slate-50 prose-headings:scroll-mt-28 prose-h1:text-2xl prose-h2:text-xl prose-h3:text-lg " +
    "prose-code:rounded prose-code:bg-slate-800 prose-code:px-1.5 prose-code:py-0.5 prose-code:text-[0.85em] prose-code:text-cyan-200 prose-code:before:content-none prose-code:after:content-none " +
    "prose-pre:border prose-pre:border-slate-800 prose-pre:bg-slate-950 prose-blockquote:border-l-cyan-500/50 prose-blockquote:text-slate-300 " +
    "prose-th:text-slate-100 prose-td:text-slate-200 prose-th:px-3 prose-td:px-3 prose-hr:border-slate-700 prose-table:text-sm";

export interface DocumentMarkdownProps {
    content: string;
    selected?: BlockRef | null;
    commentCounts?: Record<number, number>;
    interactive?: boolean;
    onBlockSelect?: (block: BlockRef, extra?: { selection?: string }) => void;
}

export function DocumentMarkdown({ content, selected = null, commentCounts = {}, interactive = true, onBlockSelect }: DocumentMarkdownProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const selectRef = useRef(onBlockSelect);
    selectRef.current = onBlockSelect;

    const captureSelection = useCallback(() => {
        if (!interactive || !containerRef.current || typeof window === "undefined") return;
        const selection = window.getSelection?.();
        if (!selection || selection.isCollapsed) return;
        const text = selection.toString().trim();
        if (text.length < 2) return;
        const anchorNode = selection.anchorNode;
        const element = anchorNode && (anchorNode.nodeType === 1 ? (anchorNode as Element) : anchorNode.parentElement);
        const block = element?.closest?.("[data-review-block]") as HTMLElement | null;
        if (!block || !containerRef.current.contains(block)) return;
        const start = Number(block.dataset.blockStart);
        const end = Number(block.dataset.blockEnd);
        if (!Number.isFinite(start) || !Number.isFinite(end)) return;
        selectRef.current?.({ start, end }, { selection: text.slice(0, 2000) });
    }, [interactive]);

    // Touch screens finish a selection after the touch ends; watch the
    // document selection settle instead of relying on mouseup.
    useEffect(() => {
        if (!interactive || typeof document === "undefined") return;
        let timer: number | null = null;
        const onChange = () => {
            if (timer) window.clearTimeout(timer);
            timer = window.setTimeout(captureSelection, 450);
        };
        document.addEventListener("selectionchange", onChange);
        return () => {
            document.removeEventListener("selectionchange", onChange);
            if (timer) window.clearTimeout(timer);
        };
    }, [captureSelection, interactive]);

    return (
        <BlockContext.Provider value={{ selected, commentCounts, interactive, onBlockSelect }}>
            <div ref={containerRef} className={`${PROSE} pr-9 md:pr-10`} onMouseUp={captureSelection} data-document-markdown="">
                <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeBlockAnchors]} components={COMPONENTS} skipHtml={false}>
                    {content}
                </ReactMarkdown>
            </div>
        </BlockContext.Provider>
    );
}

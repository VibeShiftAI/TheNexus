"use client"

/**
 * Chat message rendering: markdown at the shared prose scale, syntax
 * highlighting, and task-id decoration.
 *
 * Extracted verbatim from ai-terminal.tsx (P2-27, 2026-09-03) so the terminal
 * itself is composition + transport. The ReactMarkdown / Prism pipeline is the
 * expensive part of the transcript and it lives here, behind memo().
 */

import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import Link from "next/link";

import { normalizeMarkdown } from "@/lib/normalizeMarkdown";
import { isInternalHref, remarkTaskLinks, splitOnTaskIds, taskHref } from "@/lib/task-links";

// One shared prose scale for every conversational message — Praxis replies,
// [MORNING ROUTINE] / [PRAXIS EVENT] system cards, plans, etc. Keeping the
// sizing in a single constant is what makes the stream uniform: before this,
// assistant turns rendered as a raw `whitespace-pre-wrap` block (no markdown)
// while system cards rendered markdown, so headings/lists/paragraphs came out
// at different sizes. prose-sm pins the body to 0.875rem and the overrides tame
// heading/list/code sizing so nothing balloons to browser-default proportions.
export const MESSAGE_PROSE = [
    "prose prose-invert prose-sm max-w-none break-words",
    "prose-p:my-1.5 prose-p:leading-relaxed prose-p:text-slate-200",
    "prose-headings:text-cyan-300 prose-headings:font-semibold prose-headings:mb-1",
    "prose-h1:text-base prose-h1:mt-1 prose-h2:text-sm prose-h2:mt-2 prose-h3:text-sm prose-h3:mt-2 prose-h4:text-sm prose-h4:mt-2",
    "prose-strong:text-cyan-300 prose-strong:font-semibold",
    "prose-ul:my-1.5 prose-ol:my-1.5 prose-li:my-0.5 prose-li:text-slate-200 prose-li:leading-relaxed",
    "prose-code:text-cyan-200 prose-code:bg-slate-900/60 prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-[0.8em] prose-code:font-mono prose-code:before:content-none prose-code:after:content-none",
    "prose-pre:my-2 prose-pre:rounded-lg prose-pre:bg-slate-950",
    "prose-a:text-cyan-400 prose-a:underline prose-a:underline-offset-2 hover:prose-a:text-cyan-300",
    "prose-table:text-xs prose-th:text-cyan-300 prose-th:bg-slate-900/40 prose-th:px-2 prose-th:py-1 prose-td:text-slate-200 prose-td:px-2 prose-td:py-1 prose-td:border-slate-700/50",
    "prose-hr:border-slate-700/50 prose-hr:my-3",
    "prose-blockquote:border-l-cyan-500/60 prose-blockquote:text-slate-300 prose-blockquote:not-italic",
].join(" ");

/** Styling for a task-id mention, in markdown and in plain-text turns alike. */
export const TASK_LINK_CLASS =
    "font-mono text-cyan-400 underline decoration-dotted underline-offset-2 hover:text-cyan-300";

/** Renders plain (non-markdown) text with every task-id mention linked.
 *  User turns and one-line system events stay literal — this only swaps the
 *  ids themselves for links, so nothing else about the text changes.
 *  Memoized: unchanged text must not re-scan for task ids when the
 *  transcript re-renders around it (streaming, appends). */
export const TaskLinkedText = memo(function TaskLinkedText({ text }: { text: string }) {
    const segments = splitOnTaskIds(text);
    if (segments.length === 1) return <>{text}</>;
    return (
        <>
            {segments.map((segment, i) =>
                segment.type === "text" ? (
                    <span key={i}>{segment.value}</span>
                ) : (
                    <Link
                        key={i}
                        href={taskHref(segment.id)}
                        title={`Open task ${segment.id}`}
                        className={TASK_LINK_CLASS}
                    >
                        {segment.id}
                    </Link>
                ),
            )}
        </>
    );
});

// ReactMarkdown config is static, so it lives at module level: the memoized
// MarkdownMessage below only skips the parse when its props are identical,
// and an inline plugins array / components map would be a fresh object every
// render.
const REMARK_PLUGINS = [remarkGfm, remarkTaskLinks];

const MARKDOWN_COMPONENTS: Components = {
    // Task ids (rewritten to /task/<id> by remarkTaskLinks) and inbox
    // links from Praxis notices open in-app; everything else opens in a
    // new tab so an external link never navigates the bridge away.
    a: ({ node: _node, href, children, ...props }) =>
        isInternalHref(href) ? (
            <Link href={href} {...props} className={TASK_LINK_CLASS}>
                {children}
            </Link>
        ) : (
            <a href={href} {...props} target="_blank" rel="noopener noreferrer">
                {children}
            </a>
        ),
    // Keep wide tables (e.g. the Day Schedule) from blowing out
    // the narrow viewscreen — scroll them horizontally instead.
    table: ({ node: _node, ...props }) => (
        <div className="overflow-x-auto">
            <table {...props} />
        </div>
    ),
    code({ node: _node, className, children, ...props }: any) {
        const match = /language-(\w+)/.exec(className || "");
        const raw = String(children);
        // Fenced or multi-line → highlighted block; otherwise inline code.
        return match || raw.includes("\n") ? (
            <SyntaxHighlighter
                style={oneDark as any}
                language={match ? match[1] : "text"}
                PreTag="div"
                className="rounded-lg !bg-slate-950 !text-xs"
                customStyle={{ whiteSpace: "pre-wrap", overflowWrap: "break-word", overflowX: "hidden" }}
                codeTagProps={{ style: { whiteSpace: "pre-wrap", wordBreak: "break-word" } }}
                {...props}
            >
                {raw.replace(/\n$/, "")}
            </SyntaxHighlighter>
        ) : (
            <code className={className} {...props}>{children}</code>
        );
    },
};

/** Renders message content as normalized markdown at the shared prose scale.
 *  Used for every assistant reply and every multi-line system card so the whole
 *  transcript reads as one consistent, well-formatted surface.
 *  Memoized: the remark/Prism pipeline is the expensive part of the
 *  transcript, and a message whose content hasn't changed must never pay
 *  for it again just because the transcript re-rendered around it. */
export const MarkdownMessage = memo(function MarkdownMessage({ content }: { content: string }) {
    return (
        <div className={MESSAGE_PROSE}>
            <ReactMarkdown
                remarkPlugins={REMARK_PLUGINS}
                components={MARKDOWN_COMPONENTS}
            >
                {normalizeMarkdown(content)}
            </ReactMarkdown>
        </div>
    );
});

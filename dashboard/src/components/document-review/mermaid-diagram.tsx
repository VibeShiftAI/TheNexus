"use client";

/**
 * One Mermaid diagram inside the document reader.
 *
 * A ```mermaid fence in a reviewed document is drawn as an SVG figure instead
 * of being shown as source. The library is the pinned npm copy (same major
 * and minor as the review-surface's syntax check), loaded on demand so the
 * document page does not carry it until a diagram is actually on screen.
 *
 * Safety: Mermaid runs with securityLevel "strict", so labels are sanitised
 * (DOMPurify), click/callback directives are ignored and no script from the
 * document can run; the only markup injected is the SVG Mermaid produced.
 * Each render gets a fresh sequential id, so several diagrams on one page,
 * and a page that re-renders or navigates to another document, never share
 * or reuse an SVG id. A diagram that fails to parse keeps its source visible
 * under a plain notice, and the rest of the document is unaffected.
 */

import { useEffect, useState } from "react";

type MermaidApi = typeof import("mermaid")["default"];

const MERMAID_CONFIG: Parameters<MermaidApi["initialize"]>[0] = {
    startOnLoad: false,
    securityLevel: "strict",
    suppressErrorRendering: true,
    // Strict mode already strips scripts and event handlers from labels; also
    // refuse anything that would load a remote resource or take input.
    dompurifyConfig: {
        FORBID_TAGS: ["img", "picture", "source", "audio", "video", "track", "iframe", "object", "embed", "form", "input", "textarea", "button", "select", "link", "meta", "base", "style"],
    },
    theme: "dark",
    fontFamily: "inherit",
    themeVariables: {
        darkMode: true,
        background: "#020617",
        primaryColor: "#1e293b",
        primaryTextColor: "#e2e8f0",
        primaryBorderColor: "#64748b",
        secondaryColor: "#0f172a",
        secondaryTextColor: "#e2e8f0",
        secondaryBorderColor: "#475569",
        tertiaryColor: "#0f172a",
        tertiaryTextColor: "#e2e8f0",
        tertiaryBorderColor: "#334155",
        lineColor: "#94a3b8",
        textColor: "#e2e8f0",
        edgeLabelBackground: "#0f172a",
        clusterBkg: "#0b1220",
        clusterBorder: "#334155",
        noteBkgColor: "#1e293b",
        noteTextColor: "#e2e8f0",
        noteBorderColor: "#475569",
        fontSize: "14px",
    },
    // Natural size: labels keep their font size and the figure scrolls
    // sideways when a diagram is wider than the column (see globals.css).
    flowchart: { useMaxWidth: false, htmlLabels: true },
    state: { useMaxWidth: false },
    sequence: { useMaxWidth: false },
    class: { useMaxWidth: false },
    er: { useMaxWidth: false },
    journey: { useMaxWidth: false },
    gantt: { useMaxWidth: false },
    pie: { useMaxWidth: false },
    gitGraph: { useMaxWidth: false },
    timeline: { useMaxWidth: false },
    mindmap: { useMaxWidth: false },
};

let loader: Promise<MermaidApi> | null = null;
let sequence = 0;

/** Load and initialise Mermaid once per page; a failed load is retried on the next call. */
export function loadMermaid(): Promise<MermaidApi> {
    if (!loader) {
        loader = import("mermaid").then((mod) => {
            const api = mod.default;
            api.initialize(MERMAID_CONFIG);
            return api;
        });
        loader.catch(() => {
            loader = null;
        });
    }
    return loader;
}

export interface RenderedDiagram {
    svg: string;
    /** Natural width in CSS pixels, from the SVG's own width attribute (null when absent). */
    width: number | null;
}

/** Render one diagram to SVG markup under a fresh, page-unique id. */
export async function renderMermaid(source: string): Promise<RenderedDiagram> {
    const api = await loadMermaid();
    sequence += 1;
    const { svg } = await api.render(`nexus-mermaid-${sequence}`, source);
    return { svg, width: naturalWidth(svg) };
}

/** Width attribute of the outer <svg>, when Mermaid emitted one. */
export function naturalWidth(svg: string): number | null {
    const open = svg.match(/<svg\b[^>]*>/i)?.[0] || "";
    const value = open.match(/\swidth="([\d.]+)(?:px)?"/i)?.[1];
    const width = value ? Number(value) : NaN;
    return Number.isFinite(width) && width > 0 ? width : null;
}

/**
 * Smallest width a wide diagram may shrink to when fitting the column on a
 * desktop (70% of natural size keeps 14px labels near 10px); narrower
 * columns scroll the figure instead. See .nexus-mermaid in globals.css.
 */
export const MIN_SCALE = 0.7;

/** First line of a Mermaid error, which names the offending line for parse errors. */
export function describeMermaidError(err: unknown): string {
    const raw = err instanceof Error ? err.message : String(err ?? "");
    const first = (raw.split("\n").map((line) => line.trim()).find(Boolean) || "unknown error").replace(/:$/, "");
    return first.length > 240 ? `${first.slice(0, 237)}...` : first;
}

type DiagramState = { status: "pending" } | { status: "ok"; svg: string; width: number | null } | { status: "error"; message: string };

export function MermaidDiagram({ source }: { source: string }) {
    const [state, setState] = useState<DiagramState>({ status: "pending" });

    useEffect(() => {
        let cancelled = false;
        setState({ status: "pending" });
        renderMermaid(source).then(
            ({ svg, width }) => {
                if (!cancelled) setState({ status: "ok", svg, width });
            },
            (err: unknown) => {
                if (!cancelled) setState({ status: "error", message: describeMermaidError(err) });
            },
        );
        return () => {
            cancelled = true;
        };
    }, [source]);

    if (state.status === "ok") {
        const minWidth = state.width ? `${Math.round(state.width * MIN_SCALE)}px` : undefined;
        return (
            <figure
                className="nexus-mermaid not-prose my-4 rounded-lg border border-slate-800 bg-slate-950/60 p-3"
                style={minWidth ? ({ "--nexus-mermaid-min": minWidth } as React.CSSProperties) : undefined}
                data-mermaid-diagram="ok"
                data-mermaid-width={state.width ?? undefined}
            >
                {/* SVG generated by Mermaid (securityLevel strict) from the document's own fence, not user-typed HTML. */}
                <div dangerouslySetInnerHTML={{ __html: state.svg }} />
            </figure>
        );
    }

    const failed = state.status === "error";
    return (
        <figure
            className={`nexus-mermaid not-prose my-4 rounded-lg border p-3 ${failed ? "border-rose-500/50 bg-rose-500/5" : "border-slate-800 bg-slate-950/60"}`}
            data-mermaid-diagram={failed ? "error" : "pending"}
        >
            <div role={failed ? "status" : undefined} className={`mb-2 text-xs ${failed ? "text-rose-200" : "text-slate-500"}`} data-mermaid-notice="">
                {failed ? `This diagram did not render (${state.message}). Its source is shown instead.` : "Drawing diagram..."}
            </div>
            <pre className="overflow-x-auto rounded-md border border-slate-800 bg-slate-950 p-3 font-mono text-xs leading-relaxed text-slate-300">
                <code>{source}</code>
            </pre>
        </figure>
    );
}

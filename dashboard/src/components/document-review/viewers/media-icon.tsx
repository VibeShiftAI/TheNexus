"use client";

import { Braces, Code2, FileText, FileType2, Film, Globe, Image as ImageIcon, LayoutTemplate, Music, PenTool } from "lucide-react";
import type { MediaType } from "@/lib/document-review";

/** One icon per media type, so a row or header says what kind of thing it is before any text does. */
export function MediaIcon({ type, size = 14, className = "" }: { type: MediaType | undefined; size?: number; className?: string }) {
    const props = { size, className, "aria-hidden": true as const };
    switch (type) {
        case "design": return <LayoutTemplate {...props} />;
        case "image": return <ImageIcon {...props} />;
        case "svg": return <PenTool {...props} />;
        case "video": return <Film {...props} />;
        case "audio": return <Music {...props} />;
        case "pdf": return <FileType2 {...props} />;
        case "html": return <Globe {...props} />;
        case "code": return <Code2 {...props} />;
        case "json": return <Braces {...props} />;
        default: return <FileText {...props} />;
    }
}

/** Badge tone per media type (border/background/text classes). */
export function mediaTone(type: MediaType | undefined): string {
    switch (type) {
        case "design": return "border-fuchsia-400/40 bg-fuchsia-500/10 text-fuchsia-200";
        case "image":
        case "svg": return "border-violet-400/40 bg-violet-500/10 text-violet-200";
        case "video":
        case "audio": return "border-rose-400/40 bg-rose-500/10 text-rose-200";
        case "pdf": return "border-orange-400/40 bg-orange-500/10 text-orange-200";
        case "html": return "border-emerald-400/40 bg-emerald-500/10 text-emerald-200";
        case "code":
        case "json": return "border-sky-400/40 bg-sky-500/10 text-sky-200";
        default: return "border-slate-600 bg-slate-800/60 text-slate-300";
    }
}
